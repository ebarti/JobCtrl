package installer

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
)

func TestSignedBridgePreflightRejectsUntrustedInputsBeforeStaging(t *testing.T) {
	root := t.TempDir()
	sentinel := filepath.Join(root, "sentinel")
	if err := os.WriteFile(sentinel, []byte("untouched"), 0600); err != nil {
		t.Fatal(err)
	}
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, raw, sig, _, _ := signedChannelPointerFixture(t, private, "stable")
	descriptor := filepath.Join(root, "descriptor.json")
	signature := filepath.Join(root, "descriptor.sig")
	if err := os.WriteFile(descriptor, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signature, sig, 0600); err != nil {
		t.Fatal(err)
	}
	pub, _, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	options := Options{Home: filepath.Join(root, "home"), Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": pub}}
	input := CachedBridgeInput{DescriptorURL: "https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json", DescriptorPath: descriptor, DescriptorSignaturePath: signature, AttestationPath: sentinel, AttestationSignaturePath: sentinel}
	if _, _, err := prepareSignedCachedBridge(options, input); err == nil {
		t.Fatal("untrusted signed descriptor accepted")
	}
	if _, err := os.Lstat(options.Home); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging occurred before authentication: %v", err)
	}
	options.Trust = nil
	if _, _, err := prepareSignedCachedBridge(options, input); err == nil {
		t.Fatal("missing trust accepted")
	}
	options.AllowUnsignedLocal = true
	if _, _, err := prepareSignedCachedBridge(options, input); err == nil {
		t.Fatal("unsigned local bridge accepted")
	}
	got, err := os.ReadFile(sentinel)
	if err != nil || string(got) != "untouched" {
		t.Fatalf("data changed: %s %v", got, err)
	}
}

func TestBridgeReadRegularRejectsSymlinkAndOversize(t *testing.T) {
	root := t.TempDir()
	real := filepath.Join(root, "real")
	link := filepath.Join(root, "link")
	if err := os.WriteFile(real, []byte("12345"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(real, link); err != nil {
		t.Fatal(err)
	}
	if _, err := readBridgeRegular(link, 9); err == nil {
		t.Fatal("symlink accepted")
	}
	if _, err := readBridgeRegular(real, 4); err == nil {
		t.Fatal("oversized input accepted")
	}
	got, err := readBridgeRegular(real, 5)
	if err != nil || string(got) != "12345" {
		t.Fatalf("valid input rejected: %q %v", got, err)
	}
}

func TestBridgeRecoveryWithoutIntentRefusesWithoutStaging(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "not-created")
	_, err := InstallSignedCachedBridge(Options{Home: home}, CachedBridgeInput{})
	if err == nil {
		t.Fatal("untrusted recovery accepted")
	}
	if _, err := os.Lstat(home); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("refusal changed home: %v", err)
	}
}
