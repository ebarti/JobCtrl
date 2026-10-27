package installer

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestSignedBridgeRejectsForgedRoleBeforeCandidateStaging(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	if err := os.WriteFile(f.input.AttestationSignaturePath, []byte(`{"schemaVersion":1,"algorithm":"ed25519","keyId":"jobctrl-release-v1","signature":"invalid"}`), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := InstallSignedCachedBridge(f.options, f.input)
	if err == nil {
		t.Fatal("forged role was accepted")
	}
	if _, err := os.Lstat(filepath.Join(f.options.Home, "releases", "bridge-build-0002")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("untrusted role staged a candidate: %v", err)
	}
	active, err := f.store.ReadActive()
	if err != nil || active != f.source {
		t.Fatalf("source selection changed: %+v %v", active, err)
	}
}

func TestSignedBridgeRejectsMismatchedRoleBeforeCandidateStaging(t *testing.T) {
	for name, mutate := range map[string]func(*bridgeAttestation){
		"role":       func(c *bridgeAttestation) { c.Role = "other" },
		"descriptor": func(c *bridgeAttestation) { c.CandidateDescriptorSHA256 = c.PredecessorDescriptorSHA256 },
		"manifest":   func(c *bridgeAttestation) { c.CandidateManifestSHA256 = c.PredecessorManifestSHA256 },
	} {
		t.Run(name, func(t *testing.T) {
			f := newSignedBridgeFixture(t, 2, false)
			claim := f.claim
			mutate(&claim)
			raw, err := json.Marshal(claim)
			if err != nil {
				t.Fatal(err)
			}
			sig, err := json.Marshal(bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, signingMessage("jobctrl:bridge-attestation:v1\x00", raw)))})
			if err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(f.input.AttestationPath, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(f.input.AttestationSignaturePath, sig, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := InstallSignedCachedBridge(f.options, f.input); err == nil {
				t.Fatal("mismatched role was accepted")
			}
			if _, err := os.Lstat(filepath.Join(f.options.Home, "releases", "bridge-build-0002")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("mismatched role staged a candidate: %v", err)
			}
			active, err := f.store.ReadActive()
			if err != nil || active != f.source {
				t.Fatalf("source selection changed: %+v %v", active, err)
			}
		})
	}
}
