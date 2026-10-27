package main

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/installer"
)

type cliFixture struct {
	root, output, encoded string
	args                  []string
	private               ed25519.PrivateKey
}

func fixture(t *testing.T) cliFixture {
	t.Helper()
	root := t.TempDir()
	pub, priv, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatal(err)
	}
	trustRaw, _ := json.Marshal(map[string]string{"fixture": base64.StdEncoding.EncodeToString(pub)})
	files := map[string][]byte{"trust": trustRaw, "old.json": []byte("old descriptor"), "old.sig": []byte("old signature"), "old.zip": []byte("old archive"), "new.json": []byte("new descriptor"), "new.sig": []byte("new signature"), "new.zip": []byte("new archive")}
	for name, data := range files {
		if err := os.WriteFile(filepath.Join(root, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	out := filepath.Join(root, "output")
	args := []string{"--predecessor-descriptor-url", "https://releases.jobctrl.dev/v1/artifacts/old/release-descriptor.json", "--predecessor-descriptor-file", filepath.Join(root, "old.json"), "--predecessor-signature-file", filepath.Join(root, "old.sig"), "--predecessor-archive-file", filepath.Join(root, "old.zip"), "--candidate-descriptor-url", "https://releases.jobctrl.dev/v1/artifacts/new/release-descriptor.json", "--candidate-descriptor-file", filepath.Join(root, "new.json"), "--candidate-signature-file", filepath.Join(root, "new.sig"), "--candidate-archive-file", filepath.Join(root, "new.zip"), "--trust-keys-file", filepath.Join(root, "trust"), "--key-id", "fixture", "--output-dir", out}
	return cliFixture{root: root, output: out, encoded: base64.StdEncoding.EncodeToString(der), args: args, private: priv}
}

func TestRunWritesVerifiedResultToExclusiveDirectory(t *testing.T) {
	f := fixture(t)
	called := false
	generate := func(old, next installer.BridgeArchiveInput, trust map[string]ed25519.PublicKey, keyID string, key ed25519.PrivateKey) ([]byte, []byte, error) {
		called = true
		if old.DescriptorURL == next.DescriptorURL || string(old.DescriptorRaw) != "old descriptor" || string(next.SignatureRaw) != "new signature" || keyID != "fixture" || !key.Public().(ed25519.PublicKey).Equal(trust[keyID]) {
			t.Fatal("generator inputs not bound correctly")
		}
		return []byte("claim"), []byte("signature"), nil
	}
	if err := run(f.args, f.encoded, generate); err != nil {
		t.Fatal(err)
	}
	if !called {
		t.Fatal("generator was not called")
	}
	for name, want := range map[string]string{"bridge-attestation.json": "claim", "bridge-attestation.json.sig": "signature"} {
		got, err := os.ReadFile(filepath.Join(f.output, name))
		if err != nil || string(got) != want {
			t.Fatalf("%s: %q %v", name, got, err)
		}
	}
	if err := run(f.args, f.encoded, generate); err == nil {
		t.Fatal("existing output overwritten")
	}
	got, err := os.ReadFile(filepath.Join(f.output, "bridge-attestation.json"))
	if err != nil || string(got) != "claim" {
		t.Fatal("existing output changed")
	}
}

func TestFailureDoesNotCreateOrModifyOutput(t *testing.T) {
	f := fixture(t)
	failure := func(installer.BridgeArchiveInput, installer.BridgeArchiveInput, map[string]ed25519.PublicKey, string, ed25519.PrivateKey) ([]byte, []byte, error) {
		return nil, nil, errors.New("fixture verification failure")
	}
	if err := run(f.args, f.encoded, failure); err == nil {
		t.Fatal("generator failure accepted")
	}
	if _, err := os.Lstat(f.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("output created on failed verification: %v", err)
	}
	if err := run(f.args, "sensitive-invalid-key", failure); err == nil || strings.Contains(err.Error(), "sensitive-invalid-key") {
		t.Fatal("invalid key accepted or exposed")
	}
	if _, err := os.Lstat(f.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("output created on bad key: %v", err)
	}
}

func TestRefusesSymlinksOversizedInputsAndAmbiguousTrust(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	if err := os.WriteFile(real, []byte("12345"), 0600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readRegular(link, 10); err == nil {
		t.Fatal("symlink accepted")
	}
	if _, err := readRegular(real, 4); err == nil {
		t.Fatal("oversized input accepted")
	}
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(pub)
	for _, data := range []string{`{"key":"` + encoded + `","key":"` + encoded + `"}`, `{"key":"` + encoded + `"} {}`, `{"key":"bad"}`, `{}`} {
		if _, err := parseTrust([]byte(data)); err == nil {
			t.Fatalf("invalid trust accepted: %s", data)
		}
	}
}

func TestRefusesMismatchedSigningKey(t *testing.T) {
	f := fixture(t)
	_, other, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(other)
	if err != nil {
		t.Fatal(err)
	}
	called := false
	generate := func(installer.BridgeArchiveInput, installer.BridgeArchiveInput, map[string]ed25519.PublicKey, string, ed25519.PrivateKey) ([]byte, []byte, error) {
		called = true
		return nil, nil, nil
	}
	if err := run(f.args, base64.StdEncoding.EncodeToString(der), generate); err == nil || called {
		t.Fatal("untrusted signing key reached generator")
	}
	if _, err := os.Lstat(f.output); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("output created")
	}
}
