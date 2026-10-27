//go:build darwin

package launcher

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// Exercise actual lifecycle transactions and SQLite pairs after native scoped
// cleanup. Only target process startup is a port; this is not app qualification.
func TestScopedCleanupAllowsRealUpdateAndRollback(t *testing.T) {
	for _, operation := range []string{"update", "rollback"} {
		t.Run(operation, func(t *testing.T) {
			fixture := newV6ActivationFixtureWithPython(t, migrationIntegrationPython(t))
			fixture.ctx.Instance.ID = "scoped-lifecycle-" + operation
			var err error
			fixture.ctx.Executable, err = CurrentProcessExecutable()
			if err != nil {
				t.Fatal(err)
			}
			setJobCtrlUserVersion(t, fixture.python, fixture.state, 14)
			target := fixture.candidate
			expected := lifecycleDatabaseValues(t, fixture.python, fixture.state)
			if operation == "rollback" {
				if _, err = snapshotPair(fixture.ctx, fixture.old); err != nil {
					t.Fatal(err)
				}
				setLifecycleSQLitePair(t, fixture.python, fixture.state, "current-")
				verified, err := verifyInstalledReleaseForExecution(fixture.store, fixture.candidate)
				if err != nil {
					t.Fatal(err)
				}
				if err = handoffPublicSelector(fixture.runtime, verified); err != nil {
					t.Fatal(err)
				}
				fixture.active, err = fixture.store.WriteSelectedActive(fixture.candidate, fixture.active.Generation, fixture.candidate.BuildID, "local-fixture")
				if err != nil {
					t.Fatal(err)
				}
				target = fixture.old
			}
			currentValues := lifecycleDatabaseValues(t, fixture.python, fixture.state)
			encoded, err := json.Marshal(fixture.ctx)
			if err != nil {
				t.Fatal(err)
			}
			pidfile := filepath.Join(t.TempDir(), "platform-orphan.pid")
			if err = runInOwnedExecution(fixture.ctx, []string{"__scope-platform-orphan-test", string(encoded), pidfile}, io.Discard, io.Discard); err != nil {
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
			scopes, err := readOwnedExecutionScopes(fixture.ctx)
			if err != nil || len(scopes) != 1 {
				t.Fatalf("durable execution scope missing: %v", err)
			}
			identity, err := processStartIdentity(pid)
			if err != nil {
				t.Fatal(err)
			}
			defer func() {
				if current, err := processStartIdentity(pid); err == nil && current == identity {
					ids, err := processCoalitionIDs(pid)
					if err == nil && ids == scopes[0].CoalitionIDs {
						_ = syscall.Kill(pid, syscall.SIGKILL)
						_ = waitForPIDExit(pid, shutdownTimeout)
					}
				}
				cleanupExecutionTestArtifacts(scopes[0])
			}()
			deadline := time.Now().Add(3 * time.Second)
			for {
				member, err := readProcessScope(pid)
				if err == nil && member.ParentPID == 1 && member.owner == "" {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("platform orphan not ready: %v", err)
				}
				time.Sleep(10 * time.Millisecond)
			}
			assertZero := func() {
				t.Helper()
				if members, err := inspectOwnedProcesses(fixture.ctx, instanceState{}); err != nil || len(members) != 0 {
					t.Fatalf("lifecycle crossed cleanup boundary with live owned processes: %v count=%d", err, len(members))
				}
			}
			priorStart, priorFailure := startReleaseCommand, transitionFailure
			defer func() { startReleaseCommand, transitionFailure = priorStart, priorFailure }()
			backedUp, starts := 0, 0
			transitionFailure = func(state release.State) error {
				if state == release.PairBackedUp {
					backedUp++
					assertZero()
					journal, err := fixture.store.ReadJournal()
					if err != nil {
						t.Fatal(err)
					}
					saved := lifecycleDatabaseValues(t, fixture.python, filepath.Join(fixture.state, "backups", journal.BackupID))
					if !sameDatabaseDigests(saved, currentValues) {
						t.Fatal("current logical pair was not preserved in fresh lifecycle backup")
					}
				}
				return nil
			}
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, journal string) error {
				starts++
				assertZero()
				if receipt != target || journal == "" {
					t.Fatal("target startup lost authenticated target/journal identity")
				}
				if actual := lifecycleDatabaseValues(t, fixture.python, fixture.state); !sameDatabaseDigests(actual, expected) {
					t.Fatal("target did not reopen expected protected logical pair")
				}
				return nil
			}
			if operation == "update" {
				err = promoteExisting(fixture.ctx, fixture.store, fixture.active, target.BuildID, "update", io.Discard)
			} else {
				err = rollbackExisting(fixture.ctx, fixture.store, fixture.active, target.BuildID, io.Discard)
			}
			if err != nil {
				t.Fatalf("actual %s after scoped cleanup: %v", operation, err)
			}
			assertZero()
			if backedUp != 1 || starts != 1 {
				t.Fatalf("wrong lifecycle execution counts: backups=%d starts=%d", backedUp, starts)
			}
			selected, err := fixture.store.ReadActive()
			if err != nil || selected.Receipt != target {
				t.Fatalf("target selection readback failed: %v", err)
			}
			journal, err := fixture.store.ReadJournal()
			if err != nil || journal.State != release.Promoted || journal.Operation != operation {
				t.Fatalf("completed lifecycle journal missing: %v", err)
			}
			if actual := lifecycleDatabaseValues(t, fixture.python, fixture.state); !sameDatabaseDigests(actual, expected) {
				t.Fatal("lifecycle changed expected protected live pair")
			}
			saved := lifecycleDatabaseValues(t, fixture.python, filepath.Join(fixture.state, "backups", journal.BackupID))
			if !sameDatabaseDigests(saved, currentValues) {
				t.Fatal("current protected pair missing after completed lifecycle")
			}
		})
	}
}
