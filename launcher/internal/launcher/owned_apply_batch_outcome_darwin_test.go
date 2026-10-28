//go:build darwin

package launcher

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"testing"
	"time"
)

// Exercise the fixed module's structured failure through a separately owned
// native execution and a real Temporal workflow, without altering the seven
// existing native ownership scenarios.
func TestActualNativeApplyBatchCrashReportsCounts(t *testing.T) {
	python := migrationIntegrationPython(t)
	source, err := filepath.Abs(filepath.Join("..", "..", "..", "workers", "automation", "src"))
	if err != nil {
		t.Fatal(err)
	}
	helperDir := filepath.Join(filepath.Dir(source), "tests", "helpers")
	payload, manifest := verifiedPayloadFixture(t)
	moduleRoot := filepath.Clean(filepath.Join("..", ".."))
	executable := filepath.Join(payload, "launcher", "jobctrl")
	build := exec.Command("go", "build", "-o", executable, "./cmd/jobctrl")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build native fixture: %v %s", err, output)
	}

	bootstrap := fmt.Sprintf("import sys,runpy;sys.path[:0]=[%q,%q];from tests.helpers.apply_execution_ports import install;install();runpy.run_module('jobctrl.apply.execution',run_name='__main__')", source, filepath.Dir(source))
	adapterSource := filepath.Join(t.TempDir(), "python-adapter.go")
	adapter := fmt.Sprintf("package main\nimport (\"os\";\"syscall\")\nfunc main(){const python=%q;args:=os.Args[1:];if len(args)!=4||args[0]!=\"-I\"||args[1]!=\"-B\"||args[2]!=\"-m\"||args[3]!=\"jobctrl.apply.execution\"{os.Exit(112)};if syscall.Exec(python,[]string{python,\"-I\",\"-B\",\"-c\",%q},os.Environ())!=nil{os.Exit(111)}}\n", python, bootstrap)
	if err := os.WriteFile(adapterSource, []byte(adapter), 0600); err != nil {
		t.Fatal(err)
	}
	adapterTarget := filepath.Join(payload, "python", "bin", "python3")
	if err := os.MkdirAll(filepath.Dir(adapterTarget), 0755); err != nil {
		t.Fatal(err)
	}
	build = exec.Command("go", "build", "-o", adapterTarget, adapterSource)
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build inventoried CPython adapter: %v %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(payload, "launcher", "runtime-manifest.json"), []byte(validRuntimeManifest), 0644); err != nil {
		t.Fatal(err)
	}
	policy, err := os.ReadFile(filepath.Join("..", "..", "..", "packaging", "distribution", "capability-policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(payload, "release"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "release", "capability-policy.json"), policy, 0644); err != nil {
		t.Fatal(err)
	}
	component := manifest.Components[0]
	component.ID, component.Path = "owned-release-policy", "release"
	manifest.Components = append(manifest.Components, component)
	mcp := filepath.Join(payload, "playwright-mcp", "bin", "playwright-mcp")
	if err := os.MkdirAll(filepath.Dir(mcp), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(mcp, []byte("#!/bin/sh\nexit 111\n"), 0755); err != nil {
		t.Fatal(err)
	}
	component.ID, component.Path = "playwright-mcp", "playwright-mcp"
	manifest.Components = append(manifest.Components, component)
	sort.Slice(manifest.Components, func(i, j int) bool { return manifest.Components[i].ID < manifest.Components[j].ID })
	refreshFixtureManifest(t, payload, &manifest)
	writeLocalEnvelope(t, payload, manifest)

	home, evidence := t.TempDir(), t.TempDir()
	temporal := os.Getenv("JOBCTRL_TEMPORAL_CLI_PATH")
	if !filepath.IsAbs(temporal) {
		t.Fatal("absolute synthetic Temporal CLI path is required")
	}
	environment := []string{"HOME=" + home, "PATH=/usr/bin:/bin", "JOBCTRL_DIR=" + filepath.Join(home, "data"),
		"JOBCTRL_RUNTIME_HOME=" + filepath.Join(home, "runtime"), executionQASandboxVariable + "=" + executionQASandboxSelector,
		"LANGFUSE_DISABLE=1", "OTEL_SDK_DISABLED=true", "JOBCTRL_TEMPORAL_CLI_PATH=" + temporal}
	instance, err := resolveInstance(environment)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(instance.RuntimeHome, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(executable, filepath.Join(instance.RuntimeHome, "bin", "jobctrl")); err != nil {
		t.Fatal(err)
	}
	current, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Executable: current, Instance: instance, Environment: environment}
	defer func() {
		if err := stop(ctx); err != nil {
			t.Errorf("owned batch fixture cleanup: %v", err)
		}
	}()
	defer func() {
		if t.Failed() {
			preserveApplyFailureEvidence(t, evidence, instance)
		}
	}()

	seed := exec.Command(python, "-I", "-B", filepath.Join(helperDir, "apply_execution_native.py"), "seed", source, instance.StateDir, evidence)
	seed.Env = environment
	if output, err := seed.CombinedOutput(); err != nil {
		t.Fatalf("seed synthetic Apply workspace: %v %s", err, output)
	}
	for _, workers := range []string{"1", "1-progress", "2", "1-refuse"} {
		t.Run(workers+"-worker", func(t *testing.T) {
			batch := exec.Command(python, "-I", "-B", filepath.Join(helperDir, "apply_batch_outcome_native.py"), source, instance.StateDir, evidence, workers)
			batch.Env = append(append([]string{}, environment...), "JOBCTRL_RUNTIME_MODE=bundled", "JOBCTRL_PAYLOAD_DIR="+payload)
			if output, err := batch.CombinedOutput(); err != nil {
				t.Fatalf("actual native Apply crash batch: %v %s", err, output)
			}
			var result struct {
				RequestID string `json:"request_id"`
				ScopeID   string `json:"scope_id"`
			}
			raw, err := os.ReadFile(filepath.Join(evidence, "native-batch-outcome.json"))
			if err != nil || json.Unmarshal(raw, &result) != nil || result.RequestID == "" || result.ScopeID == "" {
				t.Fatal("native batch result missing")
			}
			if _, err := readExecutionCompletion(ctx, result.ScopeID); err != nil {
				t.Fatalf("native batch completion unverified: %v", err)
			}
			_, err = os.Stat(filepath.Join(instance.StateDir, "apply-runs", result.RequestID, "custody.json"))
			if workers == "1-refuse" {
				if err != nil {
					t.Fatalf("native refusal did not retain custody: %v", err)
				}
			} else if !os.IsNotExist(err) {
				t.Fatal("native batch retained completed custody")
			}
			tick := filepath.Join(evidence, "ticks-"+result.ScopeID)
			before, err := os.ReadFile(tick)
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(50 * time.Millisecond)
			after, err := os.ReadFile(tick)
			if err != nil || string(after) != string(before) {
				t.Fatal("native batch completion left its escaped writer active")
			}
		})
	}
}
