package launcher

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestBridgeRollbackRecoversOnlyAuthenticatedEarlyStates(t *testing.T) {
	cases := []struct {
		name    string
		state   release.State
		mutate  string
		success bool
	}{
		{"metadata-verified", release.MetadataVerified, "", true},
		{"release-committed", release.ReleaseCommitted, "", true},
		{"selector-pending", release.SelectorHandoffPending, "", true},
		{"selector-replaced", release.SelectorReplaced, "", true},
		{"quiescing", release.Quiescing, "", false},
		{"candidate-starting", release.CandidateStarting, "", false},
		{"source-generation-drift", release.MetadataVerified, "generation", false},
		{"selector-tamper", release.MetadataVerified, "selector", false},
		{"candidate-contract-tamper", release.MetadataVerified, "candidate", false},
		{"unexpected-backup", release.MetadataVerified, "backup", false},
		{"wrong-descriptor", release.MetadataVerified, "descriptor", false},
		{"missing-generation", release.MetadataVerified, "missing-generation", false},
		{"revoked-source", release.MetadataVerified, "revoked-source", false},
		{"revoked-candidate", release.SelectorHandoffPending, "revoked-candidate", false},
		{"pending-handoff", release.MetadataVerified, "pending-handoff", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			public, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			setSignedHomebrewTrust(t, public)
			home, data := t.TempDir(), t.TempDir()
			old := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "recover-old-0001", 1, 2, "/bin/sh", 2, 2)
			candidate := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "recover-target-0002", 2, 2, "/bin/sh", 2, 2)
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
			oldVerified, err := verifyInstalledReleaseForExecution(store, old.receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(home, oldVerified); err != nil {
				t.Fatal(err)
			}
			j, err := store.Begin("update", &old.receipt, &candidate.receipt, candidate.receipt.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			j.PreserveLiveOnFailure = true
			j.BridgeSourceGeneration = active.Generation
			switch tc.mutate {
			case "generation":
				if _, err := store.WriteSelectedActive(old.receipt, active.Generation, old.buildID, "homebrew"); err != nil {
					t.Fatal(err)
				}
			case "selector":
				if err := os.WriteFile(filepath.Join(home, "bin", "jobctrl"), []byte("tampered"), 0755); err != nil {
					t.Fatal(err)
				}
			case "candidate":
				if err := os.WriteFile(filepath.Join(home, "releases", candidate.buildID, "payload", "launcher", "schema-transition.json"), []byte("tampered"), 0644); err != nil {
					t.Fatal(err)
				}
			case "backup":
				j.BackupID = "unexpected"
			case "descriptor":
				j.DescriptorSHA256 = strings.Repeat("f", 64)
			case "missing-generation":
				j.BridgeSourceGeneration = 0
			case "pending-handoff":
				if err := os.WriteFile(filepath.Join(home, "bridge-handoff.json"), []byte("unresolved"), 0600); err != nil {
					t.Fatal(err)
				}
			case "revoked-source", "revoked-candidate":
				revoked := old.buildID
				metadataBuild, metadataDigest := candidate.buildID, candidate.receipt.DescriptorSHA256
				sequence := uint64(2)
				if tc.mutate == "revoked-candidate" {
					revoked = candidate.buildID
					metadataBuild, metadataDigest, sequence = "newer-policy-0003", strings.Repeat("a", 64), 3
				}
				if _, err := store.RecordMetadata("stable", sequence, 1, metadataBuild, metadataDigest, []string{revoked}); err != nil {
					t.Fatal(err)
				}
			}
			if err := store.Advance(&j, tc.state, nil); err != nil {
				t.Fatal(err)
			}
			names := []string{"jobctrl.db", "jobctrl.db-wal", "jobctrl.db-shm", "temporal.db", "temporal.db-wal", "temporal.db-shm"}
			for _, n := range names {
				if err := os.WriteFile(filepath.Join(data, n), []byte("unfamiliar-"+n), 0600); err != nil {
					t.Fatal(err)
				}
			}
			selector := filepath.Join(home, "bin", "jobctrl")
			beforeSelector, err := os.ReadFile(selector)
			if err != nil {
				t.Fatal(err)
			}
			beforeActive, err := os.ReadFile(filepath.Join(home, release.ActiveFile))
			if err != nil {
				t.Fatal(err)
			}
			beforeJournal, err := os.ReadFile(filepath.Join(home, release.JournalFile))
			if err != nil {
				t.Fatal(err)
			}
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + data}
			var output bytes.Buffer
			if tc.success {
				statusErr := Run(selector, []string{"status"}, env, io.Discard, io.Discard)
				if statusErr == nil || !strings.Contains(statusErr.Error(), "run `jobctrl rollback`") || strings.Contains(statusErr.Error(), "automatic recovery is unavailable") {
					t.Fatalf("early transition guidance: %v", statusErr)
				}
			}
			if tc.mutate == "pending-handoff" {
				handled, gotErr := recoverBridgeBeforeBootstrap(env, []string{"rollback"}, &output)
				if !handled || !errors.Is(gotErr, errPendingBridgeHandoff) {
					t.Fatalf("locked pending handoff: %t %v", handled, gotErr)
				}
			}
			err = Run(selector, []string{"rollback"}, env, &output, io.Discard)
			if tc.success && err != nil {
				t.Fatalf("rollback: %v", err)
			}
			if !tc.success && err == nil {
				t.Fatal("unsafe recovery accepted")
			}
			after, err := store.ReadJournal()
			if err != nil {
				t.Fatal(err)
			}
			if tc.success {
				if after.State != release.RolledBack || after.Resumable() || !after.PreserveLiveOnFailure {
					t.Fatalf("journal = %#v", after)
				}
				if !strings.Contains(output.String(), "Live data was preserved") {
					t.Fatalf("output = %q", output.String())
				}
			} else {
				raw, err := os.ReadFile(filepath.Join(home, release.JournalFile))
				if err != nil || !bytes.Equal(raw, beforeJournal) {
					t.Fatal("journal changed on refusal")
				}
			}
			actualSelector, err := os.ReadFile(selector)
			if err != nil || !bytes.Equal(actualSelector, beforeSelector) {
				t.Fatal("selector changed")
			}
			actualActive, err := os.ReadFile(filepath.Join(home, release.ActiveFile))
			if err != nil || !bytes.Equal(actualActive, beforeActive) {
				t.Fatal("active changed")
			}
			for _, n := range names {
				got, err := os.ReadFile(filepath.Join(data, n))
				if err != nil || string(got) != "unfamiliar-"+n {
					t.Fatalf("%s changed", n)
				}
			}
		})
	}
}

func TestBridgeRecoveryCompletesSelectorHandoffAndReplaysInterruption(t *testing.T) {
	for _, state := range []release.State{release.SelectorHandoffPending, release.SelectorReplaced} {
		t.Run(string(state), func(t *testing.T) {
			public, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			setSignedHomebrewTrust(t, public)
			home, data := t.TempDir(), t.TempDir()
			old := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "handoff-old-0001", 1, 2, "/bin/sh", 2, 2)
			candidate := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "handoff-target-0002", 2, 2, "/bin/sh", 2, 2)
			if err := os.WriteFile(filepath.Join(candidate.payloadRoot, "launcher", "jobctrl"), []byte("#!/bin/sh\n# distinct candidate\nexit 0\n"), 0755); err != nil {
				t.Fatal(err)
			}
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
			oldVerified, err := verifyInstalledReleaseForExecution(store, old.receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(home, oldVerified); err != nil {
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
			candidateVerified, err := verifyInstalledReleaseForExecution(store, candidate.receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(home, candidateVerified); err != nil {
				t.Fatal(err)
			}
			names := []string{"jobctrl.db", "jobctrl.db-wal", "jobctrl.db-shm", "temporal.db", "temporal.db-wal", "temporal.db-shm"}
			for _, n := range names {
				if err := os.WriteFile(filepath.Join(data, n), []byte("keep-"+n), 0600); err != nil {
					t.Fatal(err)
				}
			}
			selector := filepath.Join(home, "bin", "jobctrl")
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + data}
			beforeJournal, err := os.ReadFile(filepath.Join(home, release.JournalFile))
			if err != nil {
				t.Fatal(err)
			}
			bridgeRecoveryAfterSelection = func() error { return errors.New("injected interruption after active selection") }
			t.Cleanup(func() { bridgeRecoveryAfterSelection = nil })
			if err := Run(selector, []string{"rollback"}, env, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "injected interruption") {
				t.Fatalf("interrupted recovery: %v", err)
			}
			selected, err := store.ReadActive()
			if err != nil || selected.Receipt != active.Receipt || selected.Generation != active.Generation+1 || selected.SelectorBuildID != candidate.buildID {
				t.Fatalf("selected: %#v %v", selected, err)
			}
			interruptedJournal, err := os.ReadFile(filepath.Join(home, release.JournalFile))
			if err != nil || !bytes.Equal(interruptedJournal, beforeJournal) {
				t.Fatal("journal changed before terminalization")
			}
			bridgeRecoveryAfterSelection = nil
			if err := Run(selector, []string{"rollback"}, env, io.Discard, io.Discard); err != nil {
				t.Fatalf("replay: %v", err)
			}
			terminal, err := store.ReadJournal()
			if err != nil || terminal.State != release.RolledBack {
				t.Fatalf("terminal journal: %#v %v", terminal, err)
			}
			finalSelection, err := store.ReadActive()
			if err != nil || finalSelection != selected {
				t.Fatalf("selection changed on replay: %#v %v", finalSelection, err)
			}
			finalJournal, err := os.ReadFile(filepath.Join(home, release.JournalFile))
			if err != nil {
				t.Fatal(err)
			}
			if err := Run(selector, []string{"rollback"}, env, io.Discard, io.Discard); err != nil {
				t.Fatalf("repeat after completion: %v", err)
			}
			repeatedJournal, err := os.ReadFile(filepath.Join(home, release.JournalFile))
			if err != nil || !bytes.Equal(repeatedJournal, finalJournal) {
				t.Fatal("repeat changed terminal journal")
			}
			repeatedSelection, err := store.ReadActive()
			if err != nil || repeatedSelection != selected {
				t.Fatal("repeat changed active selection")
			}
			var explicitOutput bytes.Buffer
			if err := Run(selector, []string{"rollback", "--help"}, env, &explicitOutput, io.Discard); err == nil || !strings.Contains(err.Error(), "usage: jobctrl rollback") {
				t.Fatalf("explicit help bypassed normal handling: %v", err)
			}
			explicitOutput.Reset()
			if err := Run(selector, []string{"rollback", "--to", "not-installed-0003"}, env, &explicitOutput, io.Discard); err == nil || strings.Contains(explicitOutput.String(), "cancelled the interrupted update") {
				t.Fatalf("explicit target was treated as replay: %v %q", err, explicitOutput.String())
			}
			for _, n := range names {
				got, err := os.ReadFile(filepath.Join(data, n))
				if err != nil || string(got) != "keep-"+n {
					t.Fatalf("%s changed", n)
				}
			}
		})
	}
}

func TestBridgeRecoveryRejectsMalformedJournalBeforeBootstrap(t *testing.T) {
	home, data := t.TempDir(), t.TempDir()
	if _, err := release.Open(home); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(home, release.JournalFile)
	raw := []byte(`{"preserveLiveOnFailure":true,"unknown":"data"}`)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + data}
	handled, err := recoverBridgeBeforeBootstrap(env, []string{"rollback"}, io.Discard)
	if !handled || err == nil || !strings.Contains(err.Error(), "read release journal") {
		t.Fatalf("malformed journal: %t %v", handled, err)
	}
	if err := Run(filepath.Join(home, "bin", "jobctrl"), []string{"rollback"}, env, io.Discard, io.Discard); err == nil || !strings.Contains(err.Error(), "read release journal") {
		t.Fatalf("Run malformed journal: %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(after, raw) {
		t.Fatal("malformed journal changed")
	}
	if _, err := os.Lstat(filepath.Join(home, "active.json")); !os.IsNotExist(err) {
		t.Fatal("active selection was written")
	}
	if _, err := os.Lstat(filepath.Join(home, "bin", "jobctrl")); !os.IsNotExist(err) {
		t.Fatal("selector was written")
	}
}
