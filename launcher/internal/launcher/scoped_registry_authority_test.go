//go:build darwin

package launcher

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestScopedStopRejectsForeignRegistrySignalAuthority(t *testing.T) {
	contexts := []launchContext{executionTestContext(t), executionTestContext(t)}
	var members []ownedProcess
	var receipts []executionScope
	defer func() {
		for i, member := range members {
			_ = signalExecutionRoot(receipts[i].CoalitionIDs, member.PID, member.Identity, syscall.SIGKILL)
			_ = waitForOwnedRecordExit(componentRecord{PID: member.PID, StartIdentity: member.Identity}, shutdownTimeout)
			cleanupExecutionTestArtifacts(receipts[i])
		}
	}()
	startPlatformOrphan := func(ctx launchContext, filename string) (ownedProcess, executionScope) {
		t.Helper()
		pidfile := filepath.Join(filepath.Dir(ctx.Instance.StatePath), filename)
		if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "detach", pidfile}, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(pidfile)
		if err != nil {
			t.Fatal(err)
		}
		pid, err := strconv.Atoi(string(raw))
		if err != nil {
			t.Fatal(err)
		}
		scopes, err := readOwnedExecutionScopes(ctx)
		if err != nil || len(scopes) != 1 {
			t.Fatalf("missing private durable scope: %v", err)
		}
		deadline := time.Now().Add(3 * time.Second)
		for {
			member, err := readProcessScope(pid)
			if err == nil && member.ParentPID == 1 && member.owner == "" {
				executable, err := processExecutable(pid)
				if err != nil {
					t.Fatal(err)
				}
				if executable != "/bin/sleep" && executable != "/usr/bin/sleep" {
					t.Fatalf("fixture did not exec platform binary: %q", executable)
				}
				ids, err := processCoalitionIDs(pid)
				if err != nil || ids != scopes[0].CoalitionIDs {
					t.Fatal("platform orphan left recorded coalition")
				}
				members = append(members, member)
				receipts = append(receipts, scopes[0])
				return member, scopes[0]
			}
			if time.Now().After(deadline) {
				t.Fatalf("fixture did not become an environment-empty platform orphan: %v", err)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	for i := range contexts {
		root := filepath.Dir(contexts[i].Instance.StatePath)
		contexts[i].Instance.ControlPath = filepath.Join(root, "control.lock")
		contexts[i].Instance.LockPath = filepath.Join(root, "instance.lock")
		contexts[i].PayloadRoot = root
	}
	own, scopeA := startPlatformOrphan(contexts[0], "own.pid")
	foreign, scopeB := startPlatformOrphan(contexts[1], "foreign.pid")
	foreignExe, err := processExecutable(foreign.PID)
	if err != nil {
		t.Fatal(err)
	}
	foreignGroup, err := syscall.Getpgid(foreign.PID)
	if err != nil {
		t.Fatal(err)
	}
	forged := componentRecord{PID: foreign.PID, PGID: foreignGroup, StartIdentity: foreign.Identity, Executable: foreignExe, StartedAt: time.Now().UTC()}
	if !recordMatchesLiveProcess(forged) {
		t.Fatal("adversarial foreign record was not otherwise valid")
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: contexts[0].Instance.ID, CanonicalStateDir: contexts[0].Instance.StateDir, PayloadRoot: contexts[0].PayloadRoot, BuildID: "authority-fixture", ManifestSHA256: strings.Repeat("a", 64), StartedAt: time.Now().UTC(), ExecutionScopeID: scopeA.ID, Supervisor: forged, Components: map[string]componentRecord{"worker": forged}}
	if err = writeState(contexts[0].Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	census, err := inspectOwnedProcesses(contexts[0], state)
	if err != nil {
		t.Fatal(err)
	}
	foundOwn := false
	for _, member := range census {
		if member.PID == foreign.PID {
			t.Fatal("registry fields transferred independent kernel census authority")
		}
		if member.PID == own.PID {
			foundOwn = true
		}
	}
	if !foundOwn {
		t.Fatal("instance A platform orphan absent from authoritative census")
	}
	receiptB := filepath.Join(filepath.Dir(contexts[1].Instance.StatePath), "executions", scopeB.ID+".json")
	beforeB, err := os.ReadFile(receiptB)
	if err != nil {
		t.Fatal(err)
	}
	assertForeignPreserved := func() {
		t.Helper()
		live, err := readProcessScope(foreign.PID)
		if err != nil || live.Identity != foreign.Identity {
			t.Fatalf("foreign process was signaled through forged registry record: %v", err)
		}
		ids, err := processCoalitionIDs(foreign.PID)
		if err != nil || ids != scopeB.CoalitionIDs {
			t.Fatal("foreign process coalition changed")
		}
		afterB, err := os.ReadFile(receiptB)
		if err != nil || !bytes.Equal(beforeB, afterB) {
			t.Fatal("instance A stop altered instance B durable receipt")
		}
	}
	if err = stop(contexts[0]); err != nil {
		t.Fatalf("actual scoped stop failed: %v", err)
	}
	if owned, err := inspectOwnedProcesses(contexts[0], instanceState{}); err != nil || len(owned) != 0 {
		t.Fatalf("instance A did not reach verified zero: %v count=%d", err, len(owned))
	}
	assertForeignPreserved()
	stopped, err := readState(contexts[0].Instance.StatePath)
	if err != nil || stopped.StoppedAt == nil || !stopped.OwnershipVerified {
		t.Fatalf("verified stopped proof missing: %v", err)
	}
	if err = validateStartState(contexts[0], stopped); err != nil {
		t.Fatalf("forged foreign record blocked normal restart after verified stop: %v", err)
	}
	// With receipts retired, repeated public control must not fall back to
	// the foreign historical registry records and acquire new kill authority.
	if owned, err := inspectOwnedProcesses(contexts[0], stopped); err != nil || len(owned) != 0 {
		t.Fatalf("retired modern registry adopted historical PIDs: %v count=%d", err, len(owned))
	}
	var statusOutput bytes.Buffer
	if err = status(contexts[0], &statusOutput, true); err != nil || !strings.Contains(statusOutput.String(), `"status":"stopped"`) {
		t.Fatalf("repeat modern status did not preserve stopped proof: %v %s", err, statusOutput.String())
	}
	if err = stop(contexts[0]); err != nil {
		t.Fatalf("repeat stop after retirement failed: %v", err)
	}
	assertForeignPreserved()
	// Admit a new real platform command without any manual registry repair.
	startPlatformOrphan(contexts[0], "restart.pid")
	if err = stop(contexts[0]); err != nil {
		t.Fatalf("normal restarted execution could not stop: %v", err)
	}
	assertForeignPreserved()
	if err = stop(contexts[1]); err != nil {
		t.Fatalf("owned preservation-control cleanup failed: %v", err)
	}
	if owned, err := inspectOwnedProcesses(contexts[1], instanceState{}); err != nil || len(owned) != 0 {
		t.Fatalf("instance B cleanup incomplete: %v count=%d", err, len(owned))
	}
}
