package installer

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func plannedTarget(t *testing.T, f signedBridgeFixture, mutate func(*Descriptor)) CachedBridgeInput {
	t.Helper()
	payload := signedBridgePayloadFixture(t, f.private, "final-build-0003", 3, 2, 2)
	var descriptor Descriptor
	if err := json.Unmarshal(payload.descriptor, &descriptor); err != nil {
		t.Fatal(err)
	}
	if mutate != nil {
		mutate(&descriptor)
	}
	raw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := json.Marshal(signedDescriptorSignature(f.private, raw))
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	input := f.input
	input.TargetDescriptorURL = fmt.Sprintf("https://releases.jobctrl.dev/v1/artifacts/%s/release-descriptor.json", descriptor.BuildID)
	input.TargetDescriptorPath = writeBridgeInputFile(t, dir, "target.json", raw)
	input.TargetSignaturePath = writeBridgeInputFile(t, dir, "target.sig", sig)
	return input
}

func TestPlannedBridgeRejectsBridgePolicyRevokingFinalTarget(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	input := plannedTarget(t, f, nil)
	raw, err := os.ReadFile(input.DescriptorPath)
	if err != nil {
		t.Fatal(err)
	}
	var bridge Descriptor
	if err := json.Unmarshal(raw, &bridge); err != nil {
		t.Fatal(err)
	}
	bridge.RevokedBuildIDs = []string{"final-build-0003"}
	raw, err = json.Marshal(bridge)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := json.Marshal(signedDescriptorSignature(f.private, raw))
	if err != nil {
		t.Fatal(err)
	}
	claim := f.claim
	claim.CandidateDescriptorSHA256 = digestBytes(raw)
	claimRaw, err := json.Marshal(claim)
	if err != nil {
		t.Fatal(err)
	}
	claimSig, err := json.Marshal(bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, signingMessage("jobctrl:bridge-attestation:v1\x00", claimRaw)))})
	if err != nil {
		t.Fatal(err)
	}
	for path, value := range map[string][]byte{input.DescriptorPath: raw, input.DescriptorSignaturePath: sig, input.AttestationPath: claimRaw, input.AttestationSignaturePath: claimSig} {
		if err := os.WriteFile(path, value, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := InstallSignedCachedBridge(f.options, input); err == nil {
		t.Fatal("bridge revoking target was accepted")
	}
	active, err := f.store.ReadActive()
	if err != nil || active != f.source {
		t.Fatalf("active selection changed: %+v %v", active, err)
	}
}

func TestPlannedBridgeRechecksPolicyAfterPreparation(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	input := plannedTarget(t, f, nil)
	store, evidence, err := prepareSignedCachedBridge(f.options, input)
	if err != nil {
		t.Fatal(err)
	}
	transition, err := store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	selection, err := store.SelectionLock(true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.RecordMetadata("stable", 3, 1, "other-build-0003", fmt.Sprintf("%064x", 7), nil)
	_ = selection.Close()
	_ = transition.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := bridgeSelection(store, evidence, nil); err == nil {
		t.Fatal("stale bridge policy accepted")
	}
	active, err := store.ReadActive()
	if err != nil || active != f.source {
		t.Fatalf("active selection changed: %+v %v", active, err)
	}
	if _, err := os.Stat(filepath.Join(f.options.Home, bridgeIntentName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected intent: %v", err)
	}
}

func TestPlannedBridgeRechecksSourceAfterPreparation(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	input := plannedTarget(t, f, nil)
	store, evidence, err := prepareSignedCachedBridge(f.options, input)
	if err != nil {
		t.Fatal(err)
	}
	transition, err := store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	selection, err := store.SelectionLock(true)
	if err != nil {
		t.Fatal(err)
	}
	_, err = store.WriteSelectedActive(f.source.Receipt, f.source.Generation, f.source.SelectorBuildID, "homebrew")
	_ = selection.Close()
	_ = transition.Close()
	if err != nil {
		t.Fatal(err)
	}
	if err := bridgeSelection(store, evidence, nil); err == nil {
		t.Fatal("stale bridge source accepted")
	}
	active, err := store.ReadActive()
	if err != nil || active.Generation != f.source.Generation+1 || active.Acquisition != "homebrew" {
		t.Fatalf("successor selection not retained: %+v %v", active, err)
	}
	if _, err := os.Stat(filepath.Join(f.options.Home, bridgeIntentName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unexpected intent: %v", err)
	}
}

func TestPlannedBridgeRejectsUnsafeFinalTarget(t *testing.T) {
	for name, mutate := range map[string]func(*Descriptor){
		"sequence":              func(d *Descriptor) { d.Sequence = 2 },
		"revoked bridge":        func(d *Descriptor) { d.RevokedBuildIDs = []string{"bridge-build-0002"} },
		"floor excludes bridge": func(d *Descriptor) { d.MinimumSafeSequence = 3 },
	} {
		t.Run(name, func(t *testing.T) {
			f := newSignedBridgeFixture(t, 2, false)
			input := plannedTarget(t, f, mutate)
			if _, err := InstallSignedCachedBridge(f.options, input); err == nil {
				t.Fatal("unsafe bridge plan accepted")
			}
			active, err := f.store.ReadActive()
			if err != nil || active != f.source {
				t.Fatalf("active selection changed: %+v %v", active, err)
			}
		})
	}
}

func TestPlannedBridgeRecoveryUsesRetainedTargetEvidence(t *testing.T) {
	for _, interruptedStage := range []string{"intent", "active", "policy", "selector"} {
		t.Run(interruptedStage, func(t *testing.T) {
			f := newSignedBridgeFixture(t, 2, false)
			input := plannedTarget(t, f, nil)
			store, evidence, err := prepareSignedCachedBridge(f.options, input)
			if err != nil {
				t.Fatal(err)
			}
			errInterrupted := errors.New("synthetic interruption")
			if err := bridgeSelection(store, evidence, func(stage string) error {
				if stage == interruptedStage {
					return errInterrupted
				}
				return nil
			}); !errors.Is(err, errInterrupted) {
				t.Fatalf("expected interruption: %v", err)
			}
			changed := CachedBridgeInput{TargetDescriptorURL: "https://releases.jobctrl.dev/v1/artifacts/other-build-0004/release-descriptor.json"}
			if _, err := InstallSignedCachedBridge(f.options, changed); err == nil {
				t.Fatal("recovery accepted a different final target")
			}
			for _, path := range []string{input.DescriptorPath, input.DescriptorSignaturePath, input.AttestationPath, input.AttestationSignaturePath, input.TargetDescriptorPath, input.TargetSignaturePath} {
				if err := os.Remove(path); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := InstallSignedCachedBridge(f.options, CachedBridgeInput{}); err != nil {
				t.Fatalf("offline recovery: %v", err)
			}
			active, err := store.ReadActive()
			if err != nil || active.Receipt.BuildID != "bridge-build-0002" {
				t.Fatalf("wrong recovered selection: %+v %v", active, err)
			}
			if _, err := os.Stat(filepath.Join(f.options.Home, bridgeIntentName)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("intent remains: %v", err)
			}
			if _, err := InstallSignedCachedBridge(f.options, CachedBridgeInput{}); err != nil {
				t.Fatalf("repeated offline recovery: %v", err)
			}
		})
	}
}
