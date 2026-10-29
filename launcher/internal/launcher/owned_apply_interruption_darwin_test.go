//go:build darwin

package launcher

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
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
	stopCompletionCheckpoint = func(stage string) error {
		if stage != "execution-completions-durable" {
			return nil
		}
		// The controller has joined the helper and checked its real durable
		// proof, but has not yet retired the exact active receipt.
		_ = os.WriteFile(filepath.Join(root, "controller-proof-entry"), []byte("helper joined; before retirement"), 0600)
		_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		return errors.New("controller unexpectedly survived SIGKILL")
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
	completionPath := filepath.Join(filepath.Dir(ctx.Instance.StatePath), "completed-executions", scope.ID+".json")
	proofBytes, err := os.ReadFile(completionPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = os.WriteFile(completionPath, proofBytes, 0600) }()
	wrongReceipt, wrongBoot := completion, completion
	wrongReceipt.ReceiptSHA256 = strings.Repeat("0", 64)
	wrongBoot.VerificationBootSession = "00000000-0000-0000-0000-000000000000"
	if wrongBoot.VerificationBootSession == completion.VerificationBootSession {
		wrongBoot.VerificationBootSession = "11111111-1111-1111-1111-111111111111"
	}
	for _, tampered := range []executionCompletion{wrongReceipt, wrongBoot} {
		if err := writeJSONAtomic(completionPath, tampered); err != nil {
			t.Fatal(err)
		}
		if err := completeApplyExecution(ctx, scope); err == nil {
			t.Fatal("a mismatched completion certified the retained receipt")
		}
		if _, err := os.Stat(filepath.Join(filepath.Dir(ctx.Instance.StatePath), "executions", scope.ID+".json")); err != nil {
			t.Fatalf("mismatched completion removed the active receipt: %v", err)
		}
	}
	if err := os.WriteFile(completionPath, proofBytes, 0600); err != nil {
		t.Fatal(err)
	}
	foreign := exec.Command("/bin/sleep", "60")
	if err := foreign.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = foreign.Process.Kill(); _ = foreign.Wait() }()
	foreignIDs, err := processCoalitionIDs(foreign.Process.Pid)
	if err != nil || foreignIDs == scope.CoalitionIDs {
		t.Fatalf("synthetic peer is not in an independent scope: %v", err)
	}
	previousCount, previousPIDs, previousBSD := readCoalitionActiveTaskCount, executionProcessIDs, executionProcessBSDInfo
	defer func() {
		readCoalitionActiveTaskCount, executionProcessIDs, executionProcessBSDInfo = previousCount, previousPIDs, previousBSD
	}()
	readCoalitionActiveTaskCount = func(uint64) (uint64, error) { return 0, syscall.ESRCH }
	executionProcessIDs = func() ([]int, error) { return []int{foreign.Process.Pid}, nil }
	executionProcessBSDInfo = func(pid int) ([]byte, error) {
		if pid == foreign.Process.Pid {
			return nil, syscall.EPERM
		}
		return previousBSD(pid)
	}
	if err := completeApplyExecution(ctx, scope); err != nil {
		t.Fatalf("exact helper completion did not survive unrelated inspection error: %v", err)
	}
	if err := foreign.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("independent synthetic peer was signalled: %v", err)
	}
}
