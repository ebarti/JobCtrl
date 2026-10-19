package launcher

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestHomebrewCommandsPreserveRollbackUntilExplicitUpdate(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	for _, recovery := range []bool{false, true} {
		t.Run(map[bool]string{false: "explicit rollback", true: "failed update recovery"}[recovery], func(t *testing.T) {
			old := newSignedHomebrewBootstrapFixture(t, private, "rollback-old-0001", 1, 1, "/usr/bin/python3")
			latest := newSignedHomebrewBootstrapFixture(t, private, "rollback-latest-0002", 2, 1, "/usr/bin/python3")
			home := t.TempDir()
			for _, fixture := range []homebrewBootstrapFixture{old, latest} {
				if err := stageHomebrewFixture(home, fixture, public); err != nil {
					t.Fatal(err)
				}
			}
			store, err := release.Open(home)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.WriteSelectedActive(old.receipt, 0, latest.buildID, "homebrew"); err != nil {
				t.Fatal(err)
			}
			verified, err := verifyInstalledReleaseForExecution(store, latest.receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(home, verified); err != nil {
				t.Fatal(err)
			}
			operation, prior, candidate, terminal := "rollback", &latest.receipt, &old.receipt, release.Promoted
			if recovery {
				operation, prior, candidate, terminal = "update", &old.receipt, &latest.receipt, release.RolledBack
			}
			journal, err := store.Begin(operation, prior, candidate, candidate.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Advance(&journal, terminal, nil); err != nil {
				t.Fatal(err)
			}
			formula := writeHomebrewBootstrapFormula(t, t.TempDir(), latest)
			previousExec, previousInstaller := execPublicSelector, homebrewInstallerCommand
			t.Cleanup(func() { execPublicSelector, homebrewInstallerCommand = previousExec, previousInstaller })
			calls := 0
			execPublicSelector = func(selector string, args, env []string) error {
				calls++
				if selector != filepath.Join(home, "bin", "jobctrl") {
					t.Fatal("unexpected selector")
				}
				active, err := store.ReadActive()
				if err != nil || active.Receipt != old.receipt {
					t.Fatal("rollback selection changed")
				}
				return nil
			}
			staging := errors.New("explicit update stages the formula candidate")
			homebrewInstallerCommand = func(_ string, _ []string, _ []string) (string, error) { return "", staging }
			env := []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + home}
			for _, args := range [][]string{{"version"}, {"status"}, {"start", "--no-open"}} {
				if handled, err := maybeHomebrewBootstrap(formula, args, env, io.Discard, io.Discard); !handled || err != nil {
					t.Fatalf("preserve rollback: %v", err)
				}
			}
			if calls != 3 {
				t.Fatalf("selector calls = %d", calls)
			}
			if _, err := maybeHomebrewBootstrap(formula, []string{"update"}, env, io.Discard, io.Discard); !errors.Is(err, staging) {
				t.Fatalf("explicit update did not resume staging: %v", err)
			}
		})
	}
}

func TestRecoveryControllerCanRepairAnOlderInterruptedPair(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	for _, revoked := range []bool{false, true} {
		t.Run(map[bool]string{false: "compatible controller", true: "revoked controller"}[revoked], func(t *testing.T) {
			home := t.TempDir()
			old := newSignedHomebrewBootstrapFixture(t, private, "recovery-prior-0001", 1, 1, "/usr/bin/python3")
			broken := newSignedHomebrewBootstrapFixture(t, private, "recovery-broken-0002", 2, 1, "/usr/bin/python3")
			fixed := newSignedHomebrewBootstrapFixture(t, private, "recovery-fixed-0003", 3, 1, "/usr/bin/python3")
			for _, fixture := range []homebrewBootstrapFixture{old, broken, fixed} {
				if err := stageHomebrewFixture(home, fixture, public); err != nil {
					t.Fatal(err)
				}
			}
			store, err := release.Open(home)
			if err != nil {
				t.Fatal(err)
			}
			active, err := store.WriteSelectedActive(old.receipt, 0, broken.buildID, "homebrew")
			if err != nil {
				t.Fatal(err)
			}
			verified, err := verifyInstalledReleaseForExecution(store, broken.receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(home, verified); err != nil {
				t.Fatal(err)
			}
			journal, err := store.Begin("update", &old.receipt, &broken.receipt, broken.receipt.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			if err := store.Advance(&journal, release.RollbackRestoring, nil); err != nil {
				t.Fatal(err)
			}
			if revoked {
				if _, err := store.RecordMetadata("stable", 4, 1, "recovery-policy-0004", strings.Repeat("a", 64), []string{fixed.buildID}); err != nil {
					t.Fatal(err)
				}
			}
			err = handoffRecoveryController(store, fixed.receipt)
			if revoked {
				if err == nil {
					t.Fatal("revoked recovery controller was installed")
				}
				after, _ := store.ReadActive()
				if after != active {
					t.Fatal("refused recovery changed the active record")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			after, err := store.ReadActive()
			if err != nil || after.Receipt != old.receipt || after.SelectorBuildID != fixed.buildID {
				t.Fatalf("recovery selection: %#v %v", after, err)
			}
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_TRANSITION_JOURNAL=" + journal.ID, "JOBCTRL_TRANSITION_TARGET=" + old.buildID}
			_, receipt, err := transitionSelectorPayload(filepath.Join(home, "bin", "jobctrl"), env)
			if err != nil || receipt.BuildID != old.buildID {
				t.Fatalf("new controller cannot recover historical target: %v", err)
			}
			persisted, err := store.ReadJournal()
			if err != nil || persisted.State != journal.State || *persisted.Candidate != broken.receipt {
				t.Fatal("controller staging rewrote the interrupted transition")
			}
		})
	}
}
