package launcher

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestStagedPromotionPreservesInterruptedBridgeRecovery(t *testing.T) {
	for _, state := range []release.State{release.SelectorHandoffPending, release.SelectorReplaced} {
		t.Run(string(state), func(t *testing.T) {
			public, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			setSignedHomebrewTrust(t, public)
			home, data := t.TempDir(), t.TempDir()
			old := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "staged-prior-0001", 1, 2, "/bin/sh", 2, 2)
			candidate := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "staged-target-0002", 2, 2, "/bin/sh", 2, 2)
			candidate = signBridgeTransitionFixture(t, candidate, private, "#!/bin/sh\nexit 0\n")
			for _, fixture := range []homebrewBootstrapFixture{old, candidate} {
				if err := stageHomebrewFixture(home, fixture, public); err != nil {
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
			j, err := store.Begin("update", &old.receipt, &candidate.receipt, candidate.receipt.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			j.PreserveLiveOnFailure = true
			j.BridgeSourceGeneration = active.Generation
			if err := store.Advance(&j, state, nil); err != nil {
				t.Fatal(err)
			}
			verified, err := verifyInstalledReleaseForExecution(store, candidate.receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(home, verified); err != nil {
				t.Fatal(err)
			}
			selected, err := store.WriteSelectedActive(old.receipt, active.Generation, candidate.buildID, "homebrew")
			if err != nil {
				t.Fatal(err)
			}
			for _, name := range []string{"jobctrl.db", "jobctrl.db-wal", "jobctrl.db-shm", "temporal.db", "temporal.db-wal", "temporal.db-shm"} {
				if err := os.WriteFile(filepath.Join(data, name), []byte("keep-"+name), 0600); err != nil {
					t.Fatal(err)
				}
			}
			journalBefore, err := os.ReadFile(filepath.Join(home, release.JournalFile))
			if err != nil {
				t.Fatal(err)
			}
			selector := filepath.Join(home, "bin", "jobctrl")
			selectorBefore, err := os.ReadFile(selector)
			if err != nil {
				t.Fatal(err)
			}
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + data}
			err = PromoteStagedRelease(home, candidate.buildID, "homebrew", env, io.Discard)
			if err == nil {
				t.Fatalf("staged promotion should refuse and direct recovery: %v", err)
			}
			got, err := store.ReadActive()
			if err != nil || got != selected {
				t.Fatalf("active selection changed: %#v, %v", got, err)
			}
			journalAfter, err := os.ReadFile(filepath.Join(home, release.JournalFile))
			if err != nil || !bytes.Equal(journalBefore, journalAfter) {
				t.Fatal("journal changed")
			}
			selectorAfter, err := os.ReadFile(selector)
			if err != nil || !bytes.Equal(selectorBefore, selectorAfter) {
				t.Fatal("selector changed")
			}
			for _, name := range []string{"jobctrl.db", "jobctrl.db-wal", "jobctrl.db-shm", "temporal.db", "temporal.db-wal", "temporal.db-shm"} {
				got, err := os.ReadFile(filepath.Join(data, name))
				if err != nil || string(got) != "keep-"+name {
					t.Fatalf("%s changed", name)
				}
			}
			if err := Run(selector, []string{"rollback"}, env, io.Discard, io.Discard); err != nil {
				t.Fatalf("explicit recovery failed: %v", err)
			}
			recovered, err := store.ReadActive()
			if err != nil || recovered != selected {
				t.Fatalf("recovery changed selection: %#v %v", recovered, err)
			}
			terminal, err := store.ReadJournal()
			if err != nil || terminal.State != release.RolledBack {
				t.Fatalf("recovery journal: %#v %v", terminal, err)
			}
		})
	}
}
