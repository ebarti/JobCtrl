//go:build darwin

package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
)

// The source controller owns the real fleet scope. Its child runs only a
// synthetic Python Apply probe; boot and coalition reads remain real.
func TestSourceFleetScopeComposesWithApplyLifetime(t *testing.T) {
	runSourceFleetScopeProbe(t, "source_apply_scope_probe.py", []string{"source_context", "active_owner_protected", "peer_preserved", "owned_children_cleaned", "same_boot_retry"})
}

func TestSourceFleetScopeComposesWithEmailRefusal(t *testing.T) {
	runSourceFleetScopeProbe(t, "source_email_scope_probe.py", []string{"source_context", "email_refusal_recovery"})
}

func runSourceFleetScopeProbe(t *testing.T, probeName string, required []string) {
	t.Helper()
	python := migrationIntegrationPython(t)
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	automation := filepath.Join(filepath.Dir(moduleRoot), "workers", "automation")
	probe := filepath.Join(automation, "tests", probeName)
	root, err := os.MkdirTemp("", "jobctrl-source-apply-owned-")
	if err != nil {
		t.Fatal(err)
	}
	finished := false
	remove := false
	defer func() {
		if remove {
			_ = os.RemoveAll(root)
		} else {
			t.Logf("retained synthetic custody for inspection: %s", root)
		}
	}()
	binary := filepath.Join(root, "jobctrl-source")
	build := exec.Command("go", "build", "-o", binary, "./cmd/jobctrl-source")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		remove = true // no controller has started
		t.Fatalf("build source controller: %v\n%s", err, output)
	}
	sourceRoot := filepath.Join(root, "source")
	if err := os.MkdirAll(filepath.Join(sourceRoot, "scripts"), 0700); err != nil {
		remove = true
		t.Fatal(err)
	}
	script := "#!/bin/bash\nexec \"$TEST_APPLY_PYTHON\" -B \"$TEST_APPLY_PROBE\" \"$TEST_AUTOMATION_ROOT\" \"$TEST_APPLY_EVIDENCE\"\n"
	if err := os.WriteFile(filepath.Join(sourceRoot, "scripts", "dev"), []byte(script), 0700); err != nil {
		remove = true
		t.Fatal(err)
	}
	home, state, runtimeHome := filepath.Join(root, "home"), filepath.Join(root, "workspace"), filepath.Join(root, "runtime")
	if err := os.Mkdir(home, 0700); err != nil {
		remove = true
		t.Fatal(err)
	}
	evidence := filepath.Join(root, "evidence.json")
	env := []string{"HOME=" + home, "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "JOBCTRL_DIR=" + state,
		"JOBCTRL_RUNTIME_HOME=" + runtimeHome, "JOBCTRL_RUNTIME_MODE=source", "PYTHONDONTWRITEBYTECODE=1",
		executionQASandboxVariable + "=" + executionQASandboxSelector, "LANGFUSE_DISABLE=1", "OTEL_SDK_DISABLED=true",
		"TEST_APPLY_PYTHON=" + python, "TEST_APPLY_PROBE=" + probe,
		"TEST_AUTOMATION_ROOT=" + automation, "TEST_APPLY_EVIDENCE=" + evidence}
	inst, err := resolveInstance(env)
	if err != nil {
		remove = true
		t.Fatal(err)
	}
	ctx := launchContext{Executable: binary, Instance: inst, Environment: env}
	command := exec.Command(binary, "run", sourceRoot)
	command.Env = env
	outputPath := filepath.Join(root, "controller.log")
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		remove = true
		t.Fatal(err)
	}
	defer output.Close()
	command.Stdout, command.Stderr = output, output
	if err := command.Start(); err != nil {
		remove = true
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	defer func() {
		// Only the product's exact, authenticated stop may signal the scope.
		stopErr := stop(ctx)
		if !finished {
			select {
			case <-done:
				finished = true
			case <-time.After(10 * time.Second):
			}
		}
		if stopErr == nil && finished && !t.Failed() {
			remove = true
		} else if stopErr != nil || !finished {
			t.Errorf("synthetic source cleanup remained unverified: %v", stopErr)
		}
	}()
	select {
	case err := <-done:
		finished = true
		if err != nil {
			t.Fatalf("source Apply probe: %v; log retained at %s", err, outputPath)
		}
	case <-time.After(45 * time.Second):
		t.Fatalf("source Apply probe timed out; log retained at %s", outputPath)
	}
	raw, err := os.ReadFile(evidence)
	if err != nil {
		t.Fatalf("missing source Apply evidence: %v; log retained at %s", err, outputPath)
	}
	var result map[string]bool
	if err := json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	for _, key := range required {
		if !result[key] {
			t.Fatal(fmt.Errorf("source Apply did not prove %s", key))
		}
	}
}
