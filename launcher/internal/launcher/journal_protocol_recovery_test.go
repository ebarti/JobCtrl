package launcher

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestRunRefusesIncompatibleLegacyJournalBeforeRecoveryMutation(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	for _, revoked := range []bool{false, true} {
		t.Run(map[bool]string{false: "ordinary", true: "revoked"}[revoked], func(t *testing.T) {
			home, state := t.TempDir(), t.TempDir()
			old := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "legacy-prior-0001", 1, 1, python, 1, 1)
			candidate := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "legacy-candidate-0002", 2, 1, python, 1, 1)
			for _, f := range []homebrewBootstrapFixture{old, candidate} {
				if err := stageHomebrewFixture(home, f, public); err != nil {
					t.Fatal(err)
				}
			}
			store, err := release.Open(home)
			if err != nil {
				t.Fatal(err)
			}
			active, err := store.WriteSelectedActive(old.receipt, 0, old.buildID, "homebrew")
			if err != nil {
				t.Fatal(err)
			}
			v, err := verifyInstalledReleaseForExecution(store, old.receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(home, v); err != nil {
				t.Fatal(err)
			}
			seedLifecycleSQLitePair(t, python, state, "before")
			startMarker := filepath.Join(t.TempDir(), "started")
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + state, "JOBCTRL_TEST_START_MARKER=" + startMarker}
			ctx, err := transitionContextForReceipt(env, store, old.receipt)
			if err != nil {
				t.Fatal(err)
			}
			pair, err := snapshotPair(ctx, old.receipt)
			if err != nil {
				t.Fatal(err)
			}
			setLifecycleSQLitePair(t, python, state, "later")
			journal, err := store.Begin("update", &old.receipt, &candidate.receipt, candidate.receipt.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			journal.BackupID = pair.ID
			journal.State = release.CandidateStarting
			journal.SchemaVersion = 1
			journalPath := filepath.Join(home, release.JournalFile)
			if err := writeJSONAtomic(journalPath, journal); err != nil {
				t.Fatal(err)
			}
			if revoked {
				if _, err := store.RecordMetadata("stable", 2, 1, candidate.buildID, candidate.receipt.DescriptorSHA256, []string{old.buildID}); err != nil {
					t.Fatal(err)
				}
			}
			beforeJournal, err := os.ReadFile(journalPath)
			if err != nil {
				t.Fatal(err)
			}
			beforeDB := lifecycleDatabaseDigests(t, state)
			selector := filepath.Join(home, "bin", "jobctrl")
			beforeSelector, err := sha256Path(selector)
			if err != nil {
				t.Fatal(err)
			}
			err = Run(selector, []string{"rollback"}, env, io.Discard, io.Discard)
			expected := "does not support launcher protocol"
			if !revoked {
				// Candidate startup can have committed writes; preservation takes
				// precedence over inspecting the incompatible predecessor.
				expected = "retain the live databases"
			}
			if err == nil || !strings.Contains(err.Error(), expected) {
				t.Errorf("incompatible recovery returned %v", err)
			}
			afterJournal, err := os.ReadFile(journalPath)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(beforeJournal, afterJournal) {
				t.Errorf("recovery mutated the legacy journal")
			}
			if !sameDatabaseDigests(beforeDB, lifecycleDatabaseDigests(t, state)) {
				t.Errorf("recovery mutated the live database pair")
			}
			after, err := store.ReadActive()
			if err != nil || after != active {
				t.Errorf("active selection changed: %#v %v", after, err)
			}
			afterSelector, err := sha256Path(selector)
			if err != nil || afterSelector != beforeSelector {
				t.Error("selector changed")
			}
			if _, err := os.Stat(startMarker); !os.IsNotExist(err) {
				t.Errorf("recovery executed a target start: %v", err)
			}
			if !revoked {
				// Exercise the distinct pre-backup state, where the earlier
				// preservation fence cannot mask the protocol compatibility check.
				journal.State = release.Quiescing
				journal.BackupID = ""
				if err := writeJSONAtomic(journalPath, journal); err != nil {
					t.Fatal(err)
				}
				beforeJournal, err = os.ReadFile(journalPath)
				if err != nil {
					t.Fatal(err)
				}
				err = Run(selector, []string{"rollback"}, env, io.Discard, io.Discard)
				if err == nil || !strings.Contains(err.Error(), "does not support launcher protocol") {
					t.Fatalf("pre-backup compatibility recovery returned %v", err)
				}
				afterJournal, err = os.ReadFile(journalPath)
				if err != nil || !bytes.Equal(beforeJournal, afterJournal) {
					t.Fatalf("pre-backup recovery changed journal: %v", err)
				}
				if !sameDatabaseDigests(beforeDB, lifecycleDatabaseDigests(t, state)) {
					t.Fatal("pre-backup recovery changed databases")
				}
				after, err = store.ReadActive()
				if err != nil || after != active {
					t.Fatalf("pre-backup recovery changed active selection: %#v %v", after, err)
				}
				afterSelector, err = sha256Path(selector)
				if err != nil || afterSelector != beforeSelector {
					t.Fatalf("pre-backup recovery changed selector: %v", err)
				}
				if _, err := os.Stat(startMarker); !os.IsNotExist(err) {
					t.Fatalf("pre-backup recovery executed a target start: %v", err)
				}
			}
		})
	}
}
