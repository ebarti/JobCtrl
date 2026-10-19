package launcher

import (
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestUpdateInitializesUnusedWorkspaceBeforePairedBackup(t *testing.T) {
	fixture := newV6ActivationFixture(t)
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		if err := os.Remove(filepath.Join(fixture.state, name)); err != nil {
			t.Fatal(err)
		}
	}
	previous := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previous })
	starts := []string{}
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, id string) error {
		journal, err := fixture.store.ReadJournal()
		if err != nil || journal.ID != id {
			t.Fatal("startup not journal-bound")
		}
		starts = append(starts, receipt.BuildID)
		if receipt == fixture.old {
			if journal.State != release.RollbackRestoring {
				t.Fatal("initialization is not authorized for the predecessor")
			}
			seedLifecycleSQLitePair(t, fixture.python, fixture.state, "initialized predecessor")
		}
		return nil
	}
	if err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard); err != nil {
		t.Fatalf("unused installation could not upgrade: %v", err)
	}
	if len(starts) != 2 || starts[0] != fixture.old.BuildID || starts[1] != fixture.candidate.BuildID {
		t.Fatalf("startup order = %v", starts)
	}
	journal, err := fixture.store.ReadJournal()
	if err != nil || journal.State != release.Promoted || journal.BackupID == "" {
		t.Fatal("initialized predecessor has no durable paired backup")
	}
	var pair databasePair
	if err := decodeStrictRegular(filepath.Join(fixture.state, "backups", journal.BackupID, "pair.json"), &pair); err != nil || pair.ReleaseReceipt != fixture.old || len(pair.Files) != 2 {
		t.Fatal("backup does not bind initialized predecessor")
	}
}

func TestUpdateRefusesPartialOrOrphanedPairBeforeChangingSelection(t *testing.T) {
	for _, scenario := range []string{"missing app", "missing history", "orphaned WAL"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := newV6ActivationFixture(t)
			missing := "jobctrl.db"
			if scenario == "missing history" {
				missing = "temporal.db"
			}
			if err := os.Remove(filepath.Join(fixture.state, missing)); err != nil {
				t.Fatal(err)
			}
			if scenario == "orphaned WAL" {
				if err := os.Remove(filepath.Join(fixture.state, "temporal.db")); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(fixture.state, "jobctrl.db-wal"), []byte("preserved orphaned bytes"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			previous := startReleaseCommand
			t.Cleanup(func() { startReleaseCommand = previous })
			starts := 0
			startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
			if err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard); err == nil {
				t.Fatal("unsafe pair was accepted")
			}
			after, err := fixture.store.ReadActive()
			if err != nil || after != fixture.active || starts != 0 {
				t.Fatal("refused pair changed selection or started a runtime")
			}
		})
	}
}
