//go:build darwin

package launcher

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestPrivateApplyInspectionFailureStatusCannotAliasUnknownFailures(t *testing.T) {
	known := executionCensusError{syscall.EPERM}
	if got := executionCleanupCategory(errors.Join(errors.New("cleanup incomplete"), known)); got != "inspection_denied" {
		t.Fatalf("known census denial lost its category: %q", got)
	}
	if got := executionCleanupCategory(syscall.EPERM); got != "" {
		t.Fatalf("unrelated permission failure was misclassified: %q", got)
	}
	knownFailure := ownedExecutionCleanupError{"denied", "inspection_denied"}
	if got := ExitCodeForCommand(knownFailure, []string{applyExecutionArgument}); got != 211 {
		t.Fatalf("private controller did not carry the bounded category: %d", got)
	}
	for _, failure := range []error{ownedExecutionExitError{211}, errors.New("unknown"), ownedExecutionCleanupError{"unknown", "other"}} {
		if got := ExitCodeForCommand(failure, []string{applyExecutionArgument}); got != 1 {
			t.Fatalf("unknown or child failure impersonated the category: %d", got)
		}
	}
	if got := ExitCodeForCommand(ownedExecutionExitError{211}, []string{"status"}); got != 211 {
		t.Fatalf("public command exit status changed: %d", got)
	}
}

func TestNativePartialCensusCleansOnlyVerifiedOwnedChild(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
	ctx.Instance.LockPath = filepath.Join(root, "instance.lock")
	pidFile := filepath.Join(root, "owned-child.pid")
	defer func() {
		if err := stop(ctx); err != nil {
			t.Errorf("final owned cleanup: %v", err)
		}
	}()
	if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "detach", pidFile}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("owned native scope unavailable: %v", err)
	}
	bytes, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	ownedPID, err := strconv.Atoi(strings.TrimSpace(string(bytes)))
	if err != nil || ownedPID <= 0 {
		t.Fatalf("invalid synthetic child identity: %v", err)
	}
	ownedIdentity, err := processStartIdentity(ownedPID)
	if err != nil {
		t.Fatal(err)
	}
	ownedCoalition, err := processCoalitionIDs(ownedPID)
	if err != nil || ownedCoalition != scopes[0].CoalitionIDs {
		t.Fatalf("synthetic child escaped its native scope: %v", err)
	}
	foreign := exec.Command("/bin/sleep", "60")
	if err := foreign.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = foreign.Process.Kill(); _ = foreign.Wait() }()
	foreignCoalition, err := processCoalitionIDs(foreign.Process.Pid)
	if err != nil || foreignCoalition == ownedCoalition {
		t.Fatalf("synthetic peer did not receive an independent coalition: %v", err)
	}
	oldPIDs, oldBSD := executionProcessIDs, executionProcessBSDInfo
	defer func() {
		executionProcessIDs, executionProcessBSDInfo = oldPIDs, oldBSD
	}()
	executionProcessIDs = func() ([]int, error) { return []int{ownedPID, foreign.Process.Pid}, nil }
	executionProcessBSDInfo = func(pid int) ([]byte, error) {
		if pid == ownedPID {
			return nil, syscall.EPERM
		}
		return oldBSD(pid)
	}
	if _, err := executionMembers(ownedCoalition); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("uninspectable owned child was not retained: %v", err)
	}
	if current, err := processStartIdentity(ownedPID); err != nil || current != ownedIdentity {
		t.Fatalf("owned child did not remain alive after inspection failure: %v", err)
	}
	executionProcessBSDInfo = func(pid int) ([]byte, error) {
		if pid == foreign.Process.Pid {
			return nil, syscall.EPERM
		}
		return oldBSD(pid)
	}
	if err := signalExecutionMembers(ownedCoalition, syscall.SIGTERM); err != nil {
		t.Fatalf("foreign inspection failure prevented verified cleanup: %v", err)
	}
	if !waitForOwnedRecordExit(componentRecord{PID: ownedPID, StartIdentity: ownedIdentity}, 5*time.Second) {
		t.Fatal("verified owned child survived cleanup")
	}
	if err := foreign.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("independent synthetic peer was signalled: %v", err)
	}
	if zero, err := waitExecutionMembers(ownedCoalition, 5*time.Second); (err == nil && !zero) || (err != nil && !errors.Is(err, syscall.EPERM)) {
		t.Fatalf("unexpected retired-scope outcome: zero=%t err=%v", zero, err)
	}
}

func TestNativeStopRetiresWitnessedReapedScopeDespiteForeignInspectionFailure(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath, ctx.Instance.LockPath = filepath.Join(root, "control.lock"), filepath.Join(root, "instance.lock")
	pidFile := filepath.Join(root, "owned-child.pid")
	if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "detach", pidFile}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	ownedPID, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	registerVerifiedScopeChildCleanup(t, ctx, ownedPID)
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("owned scope receipt unavailable: %v", err)
	}
	identity, err := processStartIdentity(ownedPID)
	if err != nil {
		t.Fatal(err)
	}
	foreign := exec.Command("/bin/sleep", "60")
	if err := foreign.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = foreign.Process.Kill(); _ = foreign.Wait() }()
	foreignIDs, err := processCoalitionIDs(foreign.Process.Pid)
	if err != nil || foreignIDs == scopes[0].CoalitionIDs {
		t.Fatalf("synthetic peer is not independent: %v", err)
	}
	oldPIDs, oldBSD, oldCount := scopedProcessIDs, executionProcessBSDInfo, readCoalitionActiveTaskCount
	defer func() {
		scopedProcessIDs, executionProcessBSDInfo, readCoalitionActiveTaskCount = oldPIDs, oldBSD, oldCount
	}()
	reaped := 0
	readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
		count, err := oldCount(id)
		if id == scopes[0].CoalitionIDs[0] && errors.Is(err, syscall.ESRCH) {
			reaped++
		}
		return count, err
	}
	scopedProcessIDs = func() ([]int, error) { return []int{ownedPID, foreign.Process.Pid}, nil }
	executionProcessBSDInfo = func(pid int) ([]byte, error) {
		if pid == foreign.Process.Pid {
			return nil, syscall.EPERM
		}
		return oldBSD(pid)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("verified owned cleanup was blocked by a foreign inspection error: %v", err)
	}
	t.Logf("actual owned scope reaped observations: %d", reaped)
	if !waitForOwnedRecordExit(componentRecord{PID: ownedPID, StartIdentity: identity}, time.Second) {
		t.Fatal("owned child survived stop")
	}
	if err := foreign.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("independent peer was signalled: %v", err)
	}
	completion, err := readExecutionCompletion(ctx, scopes[0].ID)
	if err != nil || completion.Scope != scopes[0] {
		t.Fatalf("stop did not preserve its exact completion: %v", err)
	}
}

func TestReapedScopeRequiresObservedWitnessOrExactCompletion(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
	pidFile := filepath.Join(root, "owned-child.pid")
	if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "detach", pidFile}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(pidFile)
	if err != nil {
		t.Fatal(err)
	}
	ownedPID, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	registerVerifiedScopeChildCleanup(t, ctx, ownedPID)
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("owned scope receipt unavailable: %v", err)
	}
	identity, err := processStartIdentity(ownedPID)
	if err != nil {
		t.Fatal(err)
	}
	foreign := exec.Command("/bin/sleep", "60")
	if err := foreign.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = foreign.Process.Kill(); _ = foreign.Wait() }()
	foreignIDs, err := processCoalitionIDs(foreign.Process.Pid)
	if err != nil || foreignIDs == scopes[0].CoalitionIDs {
		t.Fatalf("synthetic peer is not independent: %v", err)
	}
	oldPIDs, oldBSD := scopedProcessIDs, executionProcessBSDInfo
	defer func() { scopedProcessIDs, executionProcessBSDInfo = oldPIDs, oldBSD }()
	scopedProcessIDs = func() ([]int, error) { return []int{ownedPID, foreign.Process.Pid}, nil }
	executionProcessBSDInfo = func(pid int) ([]byte, error) {
		if pid == foreign.Process.Pid {
			return nil, syscall.EPERM
		}
		return oldBSD(pid)
	}
	witnesses := make(executionWitnesses)
	members, err := inspectOwnedProcesses(ctx, instanceState{}, witnesses)
	if err != nil || len(members) != 1 || members[0].PID != ownedPID {
		t.Fatalf("real owned scope was not observed: %v", err)
	}
	if err := signalExecutionRoot(scopes[0].CoalitionIDs, ownedPID, identity, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if !waitForOwnedRecordExit(componentRecord{PID: ownedPID, StartIdentity: identity}, 5*time.Second) {
		t.Fatal("owned child did not exit")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		_, err = readCoalitionActiveTaskCount(scopes[0].CoalitionIDs[0])
		if errors.Is(err, syscall.ESRCH) {
			break
		}
		if time.Now().After(deadline) {
			t.Skip("kernel did not reap this empty synthetic coalition during the test")
		}
		time.Sleep(25 * time.Millisecond)
	}
	if _, err := inspectOwnedProcesses(ctx, instanceState{}); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("unobserved absent scope was treated as completion: %v", err)
	}
	if remaining, err := inspectOwnedProcesses(ctx, instanceState{}, witnesses); err != nil || len(remaining) != 0 {
		t.Fatalf("observed same-boot reaped scope was not resolved: %v", err)
	}
	if err := foreign.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("independent peer was signalled: %v", err)
	}
}
