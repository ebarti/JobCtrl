//go:build darwin

package launcher

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestMissingExecutionReceiptBlocksStartAndPreservesLiveScope(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
	ctx.Instance.LockPath = filepath.Join(root, "instance.lock")
	ctx.PayloadRoot = root
	ctx.Distribution.BuildID = "owned-receipt-loss-fixture"
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte("owned manifest"), 0600); err != nil {
		t.Fatal(err)
	}
	digest, err := manifestDigest(root)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(ctx.Instance.StateDir, 0700); err != nil {
		t.Fatal(err)
	}
	control := filepath.Join(ctx.Instance.StateDir, "owned-settings.json")
	controlBytes := []byte(`{"owned":"preserve"}`)
	if err := os.WriteFile(control, controlBytes, 0600); err != nil {
		t.Fatal(err)
	}
	startOrphan := func(name string) (ownedProcess, executionScope) {
		t.Helper()
		pidfile := filepath.Join(root, name)
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
			t.Fatalf("actual scope missing: %v", err)
		}
		for deadline := time.Now().Add(3 * time.Second); ; {
			member, err := readProcessScope(pid)
			if err == nil && member.ParentPID == 1 && member.owner == "" {
				ids, err := processCoalitionIDs(pid)
				if err != nil || ids != scopes[0].CoalitionIDs {
					t.Fatalf("platform orphan left its actual scope: %v", err)
				}
				executable, err := processExecutable(pid)
				if err != nil || (executable != "/bin/sleep" && executable != "/usr/bin/sleep") {
					t.Fatalf("child did not exec platform binary: %v", err)
				}
				return member, scopes[0]
			}
			if time.Now().After(deadline) {
				t.Fatalf("platform orphan not ready: %v", err)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	member, scope := startOrphan("first.pid")
	receipt := filepath.Join(root, "executions", scope.ID+".json")
	receiptBytes, err := os.ReadFile(receipt)
	if err != nil {
		t.Fatal(err)
	}
	receiptMissing := false
	restoreReceipt := func() error {
		if !receiptMissing {
			return nil
		}
		file, err := os.OpenFile(receipt, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0600)
		if err != nil {
			return err
		}
		_, writeErr := file.Write(receiptBytes)
		syncErr, closeErr := file.Sync(), file.Close()
		if err := errors.Join(writeErr, syncErr, closeErr, syncDirectory(filepath.Dir(receipt))); err != nil {
			return err
		}
		receiptMissing = false
		return nil
	}
	t.Cleanup(func() {
		if err := restoreReceipt(); err != nil {
			t.Errorf("restore owned receipt for cleanup: %v", err)
			return
		}
		if err := stop(ctx); err != nil {
			t.Errorf("clean owned scope: %v", err)
		}
		cleanupExecutionTestArtifacts(scope)
	})
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: ctx.Instance.ID, CanonicalStateDir: ctx.Instance.StateDir, PayloadRoot: root, BuildID: ctx.Distribution.BuildID, ManifestSHA256: digest, Components: map[string]componentRecord{}, ExecutionScopeID: scope.ID}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	registryBytes, err := os.ReadFile(ctx.Instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(receipt); err != nil {
		t.Fatal(err)
	}
	receiptMissing = true
	assertRefusal := func(label string, err error) {
		t.Helper()
		if err == nil || !strings.Contains(err.Error(), "execution receipt is missing") {
			t.Fatalf("%s did not refuse missing ownership evidence: %v", label, err)
		}
	}
	assertRefusal("start validation", validateStartState(ctx, state))
	assertRefusal("detached start", startDetached(ctx))
	assertRefusal("stop", stop(ctx))
	var output bytes.Buffer
	assertRefusal("status", status(ctx, &output, true))
	if output.Len() != 0 {
		t.Fatal("missing-receipt status emitted a misleading state")
	}
	if raw, err := os.ReadFile(ctx.Instance.StatePath); err != nil || !bytes.Equal(raw, registryBytes) {
		t.Fatalf("refusal changed registry evidence: %v", err)
	}
	if raw, err := os.ReadFile(control); err != nil || !bytes.Equal(raw, controlBytes) {
		t.Fatalf("refusal changed protected bytes: %v", err)
	}
	identity, identityErr := processStartIdentity(member.PID)
	ids, idErr := processCoalitionIDs(member.PID)
	if identityErr != nil || idErr != nil || identity != member.Identity || ids != scope.CoalitionIDs {
		t.Fatal("refusal harmed the actual untracked platform child")
	}
	if err := restoreReceipt(); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(receipt); err != nil || !bytes.Equal(raw, receiptBytes) {
		t.Fatalf("receipt restoration changed its exact bytes: %v", err)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("restored ownership could not clean normally: %v", err)
	}
	if rows, err := readOwnedExecutionScopes(ctx); err != nil || len(rows) != 0 {
		t.Fatalf("restored scope did not retire: %v", err)
	}
	stopped, err := readState(ctx.Instance.StatePath)
	if err != nil || !stopped.OwnershipVerified || stopped.StoppedAt == nil {
		t.Fatalf("stopped proof missing: %v", err)
	}
	if err := validateStartState(ctx, stopped); err != nil {
		t.Fatalf("completed stopped proof could not admit restart: %v", err)
	}
	_, restartedScope := startOrphan("restart.pid")
	defer cleanupExecutionTestArtifacts(restartedScope)
	if err := stop(ctx); err != nil {
		t.Fatalf("normal restarted scope failed cleanup: %v", err)
	}
	if rows, err := readOwnedExecutionScopes(ctx); err != nil || len(rows) != 0 {
		t.Fatalf("restarted scope did not retire: %v", err)
	}
}
