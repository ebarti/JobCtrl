package installer

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// Fixtures exercise local selection mechanics only. The verifier callback here
// is synthetic; these tests do not establish release authenticity.
type bridgeSelectionFixture struct {
	store     *release.Store
	evidence  bridgeHandoffEvidence
	selector  string
	sentinels map[string][]byte
}

func newBridgeSelectionFixture(t *testing.T) bridgeSelectionFixture {
	t.Helper()
	home := t.TempDir()
	store, err := release.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	old := release.Receipt{SchemaVersion: 1, BuildID: "old-build-0001", Channel: "local", Sequence: 1, ArtifactSHA256: fmt.Sprintf("%064x", 1), ManifestSHA256: fmt.Sprintf("%064x", 2), DescriptorSHA256: fmt.Sprintf("%064x", 3), InstalledAt: "2026-01-01T00:00:00Z"}
	next := old
	next.BuildID = "bridge-build-0002"
	next.Sequence = 2
	next.ArtifactSHA256 = fmt.Sprintf("%064x", 4)
	next.ManifestSHA256 = fmt.Sprintf("%064x", 5)
	next.DescriptorSHA256 = fmt.Sprintf("%064x", 6)
	active, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	selector := filepath.Join(home, "bin", "jobctrl")
	if err := os.WriteFile(selector, []byte("old executable"), 0700); err != nil {
		t.Fatal(err)
	}
	data := map[string][]byte{
		filepath.Join(home, "jobctrl.db"):     []byte("job data"),
		filepath.Join(home, "jobctrl.db-wal"): []byte("wal data"),
		filepath.Join(home, "jobctrl.db-shm"): []byte("shm data"),
		filepath.Join(home, "temporal.db"):    []byte("temporal data"),
	}
	for path, value := range data {
		if err := os.WriteFile(path, value, 0600); err != nil {
			t.Fatal(err)
		}
	}
	controller := []byte("bridge executable")
	return bridgeSelectionFixture{store: store, selector: selector, sentinels: data, evidence: bridgeHandoffEvidence{
		Intent:     bridgeHandoffIntent{SchemaVersion: 1, Source: active, Target: next, SourceSelectorSHA256: digestBytes([]byte("old executable")), ControllerSHA256: digestBytes(controller), Metadata: release.ChannelMetadata{Channel: next.Channel, Sequence: next.Sequence, Minimum: 1, BuildID: next.BuildID, DescriptorDigest: next.DescriptorSHA256, Revoked: []string{}}},
		Controller: controller,
		Verify:     func() error { return nil },
	}}
}

func (f bridgeSelectionFixture) assertSentinels(t *testing.T) {
	t.Helper()
	for path, want := range f.sentinels {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("sentinel %q changed: %q %v", path, got, err)
		}
	}
}

func (f bridgeSelectionFixture) assertSource(t *testing.T) {
	t.Helper()
	active, err := f.store.ReadActive()
	if err != nil || active != f.evidence.Intent.Source {
		t.Fatalf("source selection changed: %+v %v", active, err)
	}
	data, err := os.ReadFile(f.selector)
	if err != nil || string(data) != "old executable" {
		t.Fatalf("source selector changed: %q %v", data, err)
	}
	f.assertSentinels(t)
}

func TestBridgeSelectionForwardRecovery(t *testing.T) {
	for _, boundary := range []string{"intent", "active", "policy", "selector"} {
		t.Run(boundary, func(t *testing.T) {
			f := newBridgeSelectionFixture(t)
			interrupted := errors.New("synthetic interruption")
			err := bridgeSelection(f.store, f.evidence, func(stage string) error {
				if stage == boundary {
					return interrupted
				}
				return nil
			})
			if !errors.Is(err, interrupted) {
				t.Fatalf("interruption was not observed: %v", err)
			}
			active, err := f.store.ReadActive()
			if err != nil {
				t.Fatal(err)
			}
			if boundary == "intent" && active != f.evidence.Intent.Source {
				t.Fatalf("early handoff: %+v", active)
			}
			if boundary != "intent" && active.Receipt != f.evidence.Intent.Target {
				t.Fatalf("target not selected: %+v", active)
			}
			f.assertSentinels(t)
			if err := bridgeSelection(f.store, f.evidence, nil); err != nil {
				t.Fatalf("forward recovery failed: %v", err)
			}
			active, err = f.store.ReadActive()
			if err != nil {
				t.Fatal(err)
			}
			if active.Receipt != f.evidence.Intent.Target || active.Generation != f.evidence.Intent.Source.Generation+1 || active.SelectorBuildID != f.evidence.Intent.Target.BuildID {
				t.Fatalf("wrong target: %+v", active)
			}
			selected, err := os.ReadFile(f.selector)
			if err != nil || !bytes.Equal(selected, f.evidence.Controller) {
				t.Fatalf("wrong selector: %q %v", selected, err)
			}
			state, err := f.store.ReadChannelState("local")
			if err != nil || state.MaxSequence != f.evidence.Intent.Target.Sequence || state.SequenceDescriptors["2"] != f.evidence.Intent.Target.DescriptorSHA256 {
				t.Fatalf("policy not finalized: %+v %v", state, err)
			}
			if _, err := os.Stat(filepath.Join(f.store.Home, bridgeIntentName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("completed intent retained: %v", err)
			}
			if err := bridgeSelection(f.store, f.evidence, nil); err != nil {
				t.Fatalf("repeat failed: %v", err)
			}
			f.assertSentinels(t)
		})
	}
}

func TestBridgeSelectionRefusesUntrustedOrStaleInputs(t *testing.T) {
	for _, scenario := range []string{"missing-verifier", "failed-verifier", "controller", "selector", "source-active", "policy-mismatch", "revoked", "downgrade", "resumable", "unknown-journal", "invalid-journal", "corrupt-intent"} {
		t.Run(scenario, func(t *testing.T) {
			f := newBridgeSelectionFixture(t)
			switch scenario {
			case "missing-verifier":
				f.evidence.Verify = nil
			case "failed-verifier":
				f.evidence.Verify = func() error { return errors.New("unauthenticated") }
			case "controller":
				f.evidence.Controller = []byte("substituted")
			case "selector":
				if err := os.WriteFile(f.selector, []byte("substituted"), 0700); err != nil {
					t.Fatal(err)
				}
			case "source-active":
				f.evidence.Intent.Source.Generation++
			case "policy-mismatch":
				f.evidence.Intent.Metadata.DescriptorDigest = strings.Repeat("a", 64)
			case "revoked":
				if _, err := f.store.RecordMetadata("local", 1, 0, f.evidence.Intent.Source.Receipt.BuildID, f.evidence.Intent.Source.Receipt.DescriptorSHA256, []string{f.evidence.Intent.Target.BuildID}); err != nil {
					t.Fatal(err)
				}
			case "downgrade":
				if _, err := f.store.RecordMetadata("local", 3, 0, "later-build-0003", strings.Repeat("a", 64), nil); err != nil {
					t.Fatal(err)
				}
			case "resumable":
				journal, err := f.store.Begin("update", &f.evidence.Intent.Source.Receipt, &f.evidence.Intent.Target, f.evidence.Intent.Target.DescriptorSHA256)
				if err != nil {
					t.Fatal(err)
				}
				if err := f.store.Advance(&journal, release.PairBackedUp, nil); err != nil {
					t.Fatal(err)
				}
			case "unknown-journal":
				raw := `{"schemaVersion":1,"id":"test","operation":"update","state":"unknown-future-state","updatedAt":"2026-01-01T00:00:00Z"}`
				if err := os.WriteFile(filepath.Join(f.store.Home, release.JournalFile), []byte(raw), 0600); err != nil {
					t.Fatal(err)
				}
			case "invalid-journal":
				if err := os.WriteFile(filepath.Join(f.store.Home, release.JournalFile), []byte("broken"), 0600); err != nil {
					t.Fatal(err)
				}
			case "corrupt-intent":
				if err := os.WriteFile(filepath.Join(f.store.Home, bridgeIntentName), []byte("broken"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			activeBefore, err := os.ReadFile(filepath.Join(f.store.Home, release.ActiveFile))
			if err != nil {
				t.Fatal(err)
			}
			selectorBefore, err := os.ReadFile(f.selector)
			if err != nil {
				t.Fatal(err)
			}
			if err := bridgeSelection(f.store, f.evidence, nil); err == nil {
				t.Fatal("unsafe handoff accepted")
			}
			activeAfter, err := os.ReadFile(filepath.Join(f.store.Home, release.ActiveFile))
			if err != nil || !bytes.Equal(activeBefore, activeAfter) {
				t.Fatalf("active bytes changed: %v", err)
			}
			selectorAfter, err := os.ReadFile(f.selector)
			if err != nil || !bytes.Equal(selectorBefore, selectorAfter) {
				t.Fatalf("selector bytes changed: %v", err)
			}
			f.assertSentinels(t)
		})
	}
}

func TestBridgeSelectionRecoveryRefusesDriftAndInvalidEvidence(t *testing.T) {
	for _, scenario := range []string{"changed-request", "active-drift", "failed-verifier", "pending-selector-drift", "completed-selector-drift"} {
		t.Run(scenario, func(t *testing.T) {
			f := newBridgeSelectionFixture(t)
			stop := errors.New("interrupt")
			boundary := "active"
			if scenario == "completed-selector-drift" {
				boundary = "selector"
			}
			if err := bridgeSelection(f.store, f.evidence, func(stage string) error {
				if stage == boundary {
					return stop
				}
				return nil
			}); !errors.Is(err, stop) {
				t.Fatalf("interrupt: %v", err)
			}
			switch scenario {
			case "changed-request":
				f.evidence.Intent.SourceSelectorSHA256 = strings.Repeat("f", 64)
			case "active-drift":
				other := f.evidence.Intent.Target
				other.BuildID = "other-build-0003"
				other.Sequence++
				if _, err := f.store.WriteSelectedActive(other, f.evidence.Intent.Source.Generation+1, other.BuildID, "local-fixture"); err != nil {
					t.Fatal(err)
				}
			case "failed-verifier":
				f.evidence.Verify = func() error { return errors.New("revoked") }
			case "pending-selector-drift":
				if err := os.WriteFile(f.selector, []byte("substituted"), 0700); err != nil {
					t.Fatal(err)
				}
			case "completed-selector-drift":
				if err := os.Remove(filepath.Join(f.store.Home, bridgeIntentName)); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(f.selector, []byte("substituted"), 0700); err != nil {
					t.Fatal(err)
				}
			}
			activeBefore, err := os.ReadFile(filepath.Join(f.store.Home, release.ActiveFile))
			if err != nil {
				t.Fatal(err)
			}
			selectorBefore, err := os.ReadFile(f.selector)
			if err != nil {
				t.Fatal(err)
			}
			if err := bridgeSelection(f.store, f.evidence, nil); err == nil {
				t.Fatal("unsafe recovery accepted")
			}
			activeAfter, _ := os.ReadFile(filepath.Join(f.store.Home, release.ActiveFile))
			selectorAfter, _ := os.ReadFile(f.selector)
			if !bytes.Equal(activeBefore, activeAfter) || !bytes.Equal(selectorBefore, selectorAfter) {
				t.Fatal("refusal changed selection")
			}
			f.assertSentinels(t)
		})
	}
}

// The subprocess kills only itself in an owned workspace. It models abrupt
// process termination after a completed durable checkpoint, not power loss.
func TestBridgeSelectionProcessTermination(t *testing.T) {
	for _, boundary := range []string{"intent", "active", "policy", "selector"} {
		t.Run(boundary, func(t *testing.T) {
			f := newBridgeSelectionFixture(t)
			raw, err := json.Marshal(f.evidence.Intent)
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(f.store.Home, "test-evidence.json"), raw, 0600); err != nil {
				t.Fatal(err)
			}
			child := exec.Command(os.Args[0], "-test.run=^TestBridgeSelectionProcessHelper$")
			child.Env = append(os.Environ(), "JOBCTRL_BRIDGE_TEST_HOME="+f.store.Home, "JOBCTRL_BRIDGE_TEST_BOUNDARY="+boundary)
			output, err := child.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) {
				t.Fatalf("child did not terminate at checkpoint: %v %s", err, output)
			}
			status, ok := exit.Sys().(syscall.WaitStatus)
			if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
				t.Fatalf("unexpected child status %v: %s", err, output)
			}
			active, err := f.store.ReadActive()
			if err != nil {
				t.Fatal(err)
			}
			if boundary == "intent" && active != f.evidence.Intent.Source {
				t.Fatal("source selection changed too early")
			}
			if boundary != "intent" && active.Receipt != f.evidence.Intent.Target {
				t.Fatal("target selection missing")
			}
			f.assertSentinels(t)
			if err := bridgeSelection(f.store, f.evidence, nil); err != nil {
				t.Fatalf("recovery after process kill: %v", err)
			}
			if err := verifyBridgeSelector(f.store.Home, f.evidence.Intent.ControllerSHA256); err != nil {
				t.Fatal(err)
			}
			f.assertSentinels(t)
		})
	}
}

func TestBridgeSelectionProcessHelper(t *testing.T) {
	home, boundary := os.Getenv("JOBCTRL_BRIDGE_TEST_HOME"), os.Getenv("JOBCTRL_BRIDGE_TEST_BOUNDARY")
	if home == "" || boundary == "" {
		t.Skip("child-process helper")
	}
	raw, err := os.ReadFile(filepath.Join(home, "test-evidence.json"))
	if err != nil {
		t.Fatal(err)
	}
	var intent bridgeHandoffIntent
	if err := json.Unmarshal(raw, &intent); err != nil {
		t.Fatal(err)
	}
	store, err := release.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	evidence := bridgeHandoffEvidence{Intent: intent, Controller: []byte("bridge executable"), Verify: func() error { return nil }}
	err = bridgeSelection(store, evidence, func(stage string) error {
		if stage == boundary {
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		}
		return nil
	})
	t.Fatalf("checkpoint not reached: %v", err)
}

// The verifier runs under the lock and can retain caller-owned slices. An
// admitted handoff must publish the bytes and policy captured before it ran.
func TestBridgeSelectionCapturesCallerOwnedBytes(t *testing.T) {
	f := newBridgeSelectionFixture(t)
	originalController := append([]byte(nil), f.evidence.Controller...)
	f.evidence.Intent.Metadata.Revoked = []string{"retired-build-0000"}
	f.evidence.Verify = func() error {
		f.evidence.Controller[0] ^= 0xff
		f.evidence.Intent.Metadata.Revoked[0] = f.evidence.Intent.Target.BuildID
		return nil
	}
	if err := bridgeSelection(f.store, f.evidence, nil); err != nil {
		t.Fatal(err)
	}
	selected, err := os.ReadFile(f.selector)
	if err != nil || !bytes.Equal(selected, originalController) {
		t.Fatalf("caller mutation changed installed controller: %q %v", selected, err)
	}
	state, err := f.store.ReadChannelState("local")
	if err != nil {
		t.Fatal(err)
	}
	if !state.RevokedBuildIDs["retired-build-0000"] || state.RevokedBuildIDs[f.evidence.Intent.Target.BuildID] {
		t.Fatalf("caller mutation changed committed revocations: %+v", state.RevokedBuildIDs)
	}
	f.assertSentinels(t)
}

// A completed-looking selection may have lost its intent before policy
// finalization. Verify evidence again and persist the complete signed policy.
func TestBridgeSelectionCompletedTargetFinalizesMissingPolicy(t *testing.T) {
	f := newBridgeSelectionFixture(t)
	f.evidence.Intent.Metadata.Minimum = f.evidence.Intent.Target.Sequence
	f.evidence.Intent.Metadata.Revoked = []string{f.evidence.Intent.Source.Receipt.BuildID}
	if _, err := f.store.WriteSelectedActive(f.evidence.Intent.Target, f.evidence.Intent.Source.Generation, f.evidence.Intent.Target.BuildID, f.evidence.Intent.Source.Acquisition); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.selector, f.evidence.Controller, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(f.store.Home, bridgeIntentName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected intent: %v", err)
	}
	verified := 0
	f.evidence.Verify = func() error { verified++; return nil }
	if err := bridgeSelection(f.store, f.evidence, nil); err != nil {
		t.Fatal(err)
	}
	if verified != 1 {
		t.Fatalf("evidence verified %d times", verified)
	}
	state, err := f.store.ReadChannelState("local")
	if err != nil {
		t.Fatal(err)
	}
	if state.MaxSequence != f.evidence.Intent.Target.Sequence || state.MinimumSafeSequence != f.evidence.Intent.Target.Sequence || !state.RevokedBuildIDs[f.evidence.Intent.Source.Receipt.BuildID] || state.SequenceDescriptors["2"] != f.evidence.Intent.Target.DescriptorSHA256 {
		t.Fatalf("policy not finalized: %+v", state)
	}
	if err := bridgeSelection(f.store, f.evidence, nil); err != nil {
		t.Fatalf("idempotent policy finalization: %v", err)
	}
	f.assertSentinels(t)
}
