//go:build darwin

package launcher

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"testing"
	"time"
)

func init() {
	if len(os.Args) != 4 || os.Args[1] != "__apply-test-kill-before-retirement" {
		return
	}
	var ctx launchContext
	if json.Unmarshal([]byte(os.Args[2]), &ctx) != nil {
		os.Exit(91)
	}
	root := os.Args[3]
	ctx.Environment = append(ctx.Environment, "JOBCTRL_APPLY_TEST_ROOT="+root, "JOBCTRL_APPLY_TEST_CONTEXT="+os.Args[2])
	executionProcessIDs = func() ([]int, error) {
		// Controller-only seam. This first inventory occurs after the controller
		// decoded the genuine result and joined the already-exited native helper.
		_ = os.WriteFile(filepath.Join(root, "controller-proof-entry"), []byte("helper joined; before proof"), 0600)
		_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		return nil, errors.New("controller unexpectedly survived SIGKILL")
	}
	if err := runInOwnedExecution(ctx, []string{applyWorkerArgument}, os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(92)
	}
	os.Exit(93)
}

func TestApplyCompletionSurvivesControllerDeathBeforeRetirement(t *testing.T) {
	root := t.TempDir()
	env := []string{"HOME=" + root, "PATH=/usr/bin:/bin", "JOBCTRL_DIR=" + filepath.Join(root, "data"), "JOBCTRL_RUNTIME_HOME=" + filepath.Join(root, "runtime")}
	inst, err := resolveInstance(env)
	if err != nil {
		t.Fatal(err)
	}
	exe, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Executable: exe, Instance: inst, Environment: env}
	encoded, err := json.Marshal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := stop(ctx); err != nil {
			t.Errorf("owned final cleanup: %v", err)
		}
	}()
	fixture := t.TempDir()
	if err := os.WriteFile(filepath.Join(fixture, "mode"), []byte("success"), 0600); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(exe, "__apply-test-kill-before-retirement", string(encoded), fixture)
	child.Stdout, child.Stderr = os.Stdout, os.Stderr
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	if err := child.Wait(); err == nil {
		t.Fatal("controller was not killed")
	}
	if _, err := os.Stat(filepath.Join(fixture, "controller-proof-entry")); err != nil {
		t.Fatalf("wrong failure seam: %v", err)
	}
	raw, err := os.ReadFile(filepath.Join(fixture, "scope.json"))
	if err != nil {
		t.Fatal(err)
	}
	var scope executionScope
	if json.Unmarshal(raw, &scope) != nil {
		t.Fatal("missing real Apply scope")
	}
	if exited, err := waitExecutionRoot(scope.RootPID, scope.RootIdentity, time.Second); err != nil || !exited {
		t.Fatalf("helper is not gone: %v", err)
	}
	if zero, err := waitExecutionMembers(scope.CoalitionIDs, time.Second); err != nil || !zero {
		t.Fatalf("writers not zero: %v", err)
	}
	completion, err := readExecutionCompletion(ctx, scope.ID)
	if err != nil || completion.Scope != scope {
		t.Fatalf("late controller death lost the exact helper completion: %v", err)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		t.Fatal(err)
	}
	retained := false
	for _, active := range scopes {
		retained = retained || active == scope
	}
	if !retained {
		t.Fatal("exact receipt was not retained")
	}

}
