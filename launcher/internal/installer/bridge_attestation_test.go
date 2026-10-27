package installer

import (
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type bridgeAttestationFixture struct {
	oldRoot, newRoot string
	old, candidate   release.Receipt
	private          ed25519.PrivateKey
	trust            map[string]ed25519.PublicKey
}

func newBridgeAttestationFixture(t *testing.T) bridgeAttestationFixture {
	t.Helper()
	dir := t.TempDir()
	f := bridgeAttestationFixture{oldRoot: filepath.Join(dir, "old"), newRoot: filepath.Join(dir, "new")}
	for _, root := range []string{f.oldRoot, f.newRoot} {
		for _, sub := range []string{"launcher", "release", "python/bin"} {
			if err := os.MkdirAll(filepath.Join(root, sub), 0700); err != nil {
				t.Fatal(err)
			}
		}
		for name, data := range map[string]string{"release/capability-policy.json": "same policy", "python/bin/python3.12": "python", "manifest.sig": "signature"} {
			if err := os.WriteFile(filepath.Join(root, name), []byte(data), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.Symlink("python3.12", filepath.Join(root, "python/bin/python3")); err != nil {
			t.Fatal(err)
		}
	}
	for path, data := range map[string]string{
		filepath.Join(f.oldRoot, "launcher/jobctrl"): "old controller", filepath.Join(f.newRoot, "launcher/jobctrl"): "bridge controller",
		filepath.Join(f.oldRoot, "launcher/runtime-manifest.json"): `{"schemaVersion":1,"launcherProtocol":1,"port":123}`,
		filepath.Join(f.newRoot, "launcher/runtime-manifest.json"): `{"schemaVersion":1,"launcherProtocol":2,"port":123}`,
		filepath.Join(f.oldRoot, "manifest.json"):                  "old signed manifest", filepath.Join(f.newRoot, "manifest.json"): "new signed manifest",
	} {
		if err := os.WriteFile(path, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	f.old = release.Receipt{SchemaVersion: 1, BuildID: "oldbuild", Channel: "stable", Sequence: 1, ArtifactSHA256: fmt.Sprintf("%064x", 1), ManifestSHA256: digestBytes([]byte("old signed manifest")), DescriptorSHA256: fmt.Sprintf("%064x", 2), InstalledAt: "2026-01-01T00:00:00Z"}
	f.candidate = release.Receipt{SchemaVersion: 1, BuildID: "newbuild", Channel: "stable", Sequence: 2, ArtifactSHA256: fmt.Sprintf("%064x", 3), ManifestSHA256: digestBytes([]byte("new signed manifest")), DescriptorSHA256: fmt.Sprintf("%064x", 4), InstalledAt: "2026-01-01T00:00:00Z"}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	f.private = private
	f.trust = map[string]ed25519.PublicKey{"test-key": public}
	return f
}
func (f bridgeAttestationFixture) signed(t *testing.T, mutate func(*bridgeAttestation)) ([]byte, []byte) {
	t.Helper()
	old, err := bridgeInventory(f.oldRoot)
	if err != nil {
		t.Fatal(err)
	}
	next, err := bridgeInventory(f.newRoot)
	if err != nil {
		t.Fatal(err)
	}
	oldRaw, _ := json.Marshal(old)
	nextRaw, _ := json.Marshal(next)
	claim := bridgeAttestation{SchemaVersion: 1, Role: "schema14-bridge", DatabaseSchema: 14, LauncherProtocol: 2, Channel: "stable", Platform: "darwin-arm64", PredecessorDescriptorSHA256: f.old.DescriptorSHA256, PredecessorManifestSHA256: f.old.ManifestSHA256, CandidateDescriptorSHA256: f.candidate.DescriptorSHA256, CandidateManifestSHA256: f.candidate.ManifestSHA256, PredecessorInventorySHA256: digestBytes(oldRaw), CandidateInventorySHA256: digestBytes(nextRaw), ControllerSHA256: next["launcher/jobctrl"].Value}
	if mutate != nil {
		mutate(&claim)
	}
	raw, _ := json.Marshal(claim)
	sig := bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: "test-key", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, signingMessage("jobctrl:bridge-attestation:v1\x00", raw)))}
	sigRaw, _ := json.Marshal(sig)
	return raw, sigRaw
}
func (f bridgeAttestationFixture) verify(raw, sig []byte) error {
	_, err := verifyBridgeAttestation(raw, sig, f.trust, f.old, f.candidate, f.oldRoot, f.newRoot)
	return err
}
func TestBridgeAttestationBindsInventoryAndIdentity(t *testing.T) {
	f := newBridgeAttestationFixture(t)
	raw, sig := f.signed(t, nil)
	claim, err := verifyBridgeAttestation(raw, sig, f.trust, f.old, f.candidate, f.oldRoot, f.newRoot)
	if err != nil {
		t.Fatal(err)
	}
	if claim.ControllerSHA256 != digestBytes([]byte("bridge controller")) {
		t.Fatal("controller not bound")
	}
	bad := append([]byte(nil), raw...)
	bad[len(bad)-2] ^= 1
	if f.verify(bad, sig) == nil {
		t.Fatal("tampered claim accepted")
	}
	untrusted := map[string]ed25519.PublicKey{}
	if _, err := verifyBridgeAttestation(raw, sig, untrusted, f.old, f.candidate, f.oldRoot, f.newRoot); err == nil {
		t.Fatal("unknown signing key accepted")
	}
	if _, err := verifyBridgeAttestation(raw, nil, f.trust, f.old, f.candidate, f.oldRoot, f.newRoot); err == nil {
		t.Fatal("unsigned attestation accepted")
	}
	wrong := f.old
	wrong.DescriptorSHA256 = fmt.Sprintf("%064x", 9)
	if _, err := verifyBridgeAttestation(raw, sig, f.trust, wrong, f.candidate, f.oldRoot, f.newRoot); err == nil {
		t.Fatal("wrong predecessor accepted")
	}
	for name, mutate := range map[string]func(*bridgeAttestation){"role": func(c *bridgeAttestation) { c.Role = "other" }, "schema": func(c *bridgeAttestation) { c.DatabaseSchema = 15 }, "protocol": func(c *bridgeAttestation) { c.LauncherProtocol = 1 }, "channel": func(c *bridgeAttestation) { c.Channel = "prerelease" }, "platform": func(c *bridgeAttestation) { c.Platform = "other" }, "controller": func(c *bridgeAttestation) { c.ControllerSHA256 = fmt.Sprintf("%064x", 5) }} {
		t.Run(name, func(t *testing.T) {
			r, s := f.signed(t, mutate)
			if f.verify(r, s) == nil {
				t.Fatal("invalid claim accepted")
			}
		})
	}
}
func TestBridgeAttestationRejectsPayloadChangeAfterSigning(t *testing.T) {
	f := newBridgeAttestationFixture(t)
	raw, sig := f.signed(t, nil)
	if err := os.WriteFile(filepath.Join(f.newRoot, "launcher/jobctrl"), []byte("substituted"), 0600); err != nil {
		t.Fatal(err)
	}
	if f.verify(raw, sig) == nil {
		t.Fatal("substituted controller accepted")
	}
}
func TestBridgeAttestationRejectsRuntimeChangesEvenIfSigned(t *testing.T) {
	tests := map[string]func(*testing.T, bridgeAttestationFixture){
		"policy": func(t *testing.T, f bridgeAttestationFixture) {
			os.WriteFile(filepath.Join(f.newRoot, "release/capability-policy.json"), []byte("changed"), 0600)
		},
		"extra": func(t *testing.T, f bridgeAttestationFixture) {
			os.WriteFile(filepath.Join(f.newRoot, "extra"), []byte("changed"), 0600)
		},
		"runtime": func(t *testing.T, f bridgeAttestationFixture) {
			os.WriteFile(filepath.Join(f.newRoot, "launcher/runtime-manifest.json"), []byte(`{"schemaVersion":1,"launcherProtocol":2,"port":124}`), 0600)
		},
		"symlink": func(t *testing.T, f bridgeAttestationFixture) {
			p := filepath.Join(f.newRoot, "python/bin/python3")
			os.Remove(p)
			os.Symlink("different", p)
		},
	}
	for name, change := range tests {
		t.Run(name, func(t *testing.T) {
			f := newBridgeAttestationFixture(t)
			change(t, f)
			raw, sig := f.signed(t, nil)
			if f.verify(raw, sig) == nil {
				t.Fatal("signed but inequivalent runtime accepted")
			}
		})
	}
}
func TestBridgeInventoryRejectsEscapeAndSpecialFiles(t *testing.T) {
	for _, kind := range []string{"absolute", "escape", "fifo"} {
		t.Run(kind, func(t *testing.T) {
			f := newBridgeAttestationFixture(t)
			p := filepath.Join(f.newRoot, "bad")
			switch kind {
			case "absolute":
				os.Symlink("/tmp", p)
			case "escape":
				os.Symlink("../outside", p)
			case "fifo":
				if err := syscall.Mkfifo(p, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := bridgeInventory(f.newRoot); err == nil {
				t.Fatal("unsafe entry accepted")
			}
		})
	}
}
