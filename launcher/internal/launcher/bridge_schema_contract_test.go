package launcher

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

const validBridgeSchemaContract = `{"schemaVersion":1,"sourceUserVersion":14,"targetUserVersion":15}`

// signedBridgeSchemaFixture authenticates exactly the inventory consumed by
// the reader using a test-owned key; no product workspace is opened.
func signedBridgeSchemaFixture(t *testing.T, contents string) (verifiedRelease, ed25519.PublicKey) {
	t.Helper()
	root, manifest := verifiedPayloadFixture(t)
	if contents != "" {
		if err := os.WriteFile(filepath.Join(root, bridgeSchemaContractPath), []byte(contents), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	manifest.ReleaseChannel = "stable"
	manifest.Signing.ManifestKeyID = "fixture-key"
	manifest.Signing.CodeSigning = "developer-id"
	manifest.Signing.Notarized = true
	refreshFixtureManifest(t, root, &manifest)
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:manifest:v1\x00", raw)))
	signature, err := json.Marshal(manifestSignature{SchemaVersion: 1, Status: "signed", ManifestAlgorithm: "ed25519", ManifestKeyID: "fixture-key", Signature: &sig, Promotable: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.sig"), signature, 0o644); err != nil {
		t.Fatal(err)
	}
	checked, err := VerifyDistributionPayload(root, DistributionTrust{PublicKeys: map[string]ed25519.PublicKey{"fixture-key": public}, ExpectedChannel: "stable"})
	if err != nil {
		t.Fatalf("verify signed synthetic candidate: %v", err)
	}
	return verifiedRelease{payloadRoot: root, distribution: checked}, public
}

func TestBridgeSchemaContractThroughInstalledSignedRelease(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	fixture := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "schema-target-0001", 1, 2, "/usr/bin/python3", 2, 2)
	file := filepath.Join(fixture.payloadRoot, bridgeSchemaContractPath)
	if err := os.WriteFile(file, []byte(validBridgeSchemaContract), 0o644); err != nil {
		t.Fatal(err)
	}
	var manifest distributionManifest
	if err := decodeStrict(filepath.Join(fixture.payloadRoot, "manifest.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, fixture.payloadRoot, &manifest)
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:manifest:v1\x00", raw)))
	signature, err := json.Marshal(manifestSignature{SchemaVersion: 1, Status: "signed", ManifestAlgorithm: "ed25519", ManifestKeyID: "jobctrl-release-v1", Signature: &sig, Promotable: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.payloadRoot, "manifest.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.payloadRoot, "manifest.sig"), signature, 0o644); err != nil {
		t.Fatal(err)
	}
	manifestHash := sha256.Sum256(raw)
	fixture.receipt.ManifestSHA256 = hex.EncodeToString(manifestHash[:])
	var descriptor map[string]any
	if err := json.Unmarshal(fixture.descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	descriptor["artifact"].(map[string]any)["manifestSha256"] = fixture.receipt.ManifestSHA256
	fixture.descriptorRaw, err = json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	descriptorHash := sha256.Sum256(fixture.descriptorRaw)
	fixture.descriptorSHA256 = hex.EncodeToString(descriptorHash[:])
	fixture.receipt.DescriptorSHA256 = fixture.descriptorSHA256
	fixture.policy.DescriptorDigest = fixture.descriptorSHA256
	fixture.receipt.PolicySHA256 = lifecyclePolicyDigest(t, fixture.policy)
	descriptorSig := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:release-descriptor:v1\x00", fixture.descriptorRaw)))
	fixture.signatureRaw, err = json.Marshal(homebrewFixtureSignature{SchemaVersion: 1, Status: "signed", Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: descriptorSig})
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	if err := stageHomebrewFixture(home, fixture, public); err != nil {
		t.Fatal(err)
	}
	store, err := release.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	verified, contract, err := loadVerifiedBridgeSchemaContract(store, fixture.receipt, 14)
	if err != nil || verified.receipt != fixture.receipt || contract.TargetUserVersion != 15 {
		t.Fatalf("installed candidate contract = %#v, %v", contract, err)
	}
	if err := os.WriteFile(filepath.Join(verified.payloadRoot, bridgeSchemaContractPath), []byte(strings.Replace(validBridgeSchemaContract, "15", "16", 1)), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, _, err := loadVerifiedBridgeSchemaContract(store, fixture.receipt, 14); err == nil {
		t.Fatal("accepted an installed release with modified contract")
	}
}

func TestBridgeSchemaContractAuthenticatesExactTransition(t *testing.T) {
	verified, _ := signedBridgeSchemaFixture(t, validBridgeSchemaContract)
	got, err := readBridgeSchemaContract(verified, 14)
	if err != nil || got.SourceUserVersion != 14 || got.TargetUserVersion != 15 {
		t.Fatalf("contract = %#v, %v", got, err)
	}
	if _, err := readBridgeSchemaContract(verified, 13); err == nil {
		t.Fatal("accepted an unexpected live source schema")
	}
}

func TestBridgeSchemaContractRejectsMissingAndInvalidSignedContents(t *testing.T) {
	for name, contents := range map[string]string{
		"missing":       "",
		"target":        `{"schemaVersion":1,"sourceUserVersion":14,"targetUserVersion":16}`,
		"source":        `{"schemaVersion":1,"sourceUserVersion":13,"targetUserVersion":15}`,
		"duplicate":     `{"schemaVersion":1,"sourceUserVersion":14,"targetUserVersion":15,"targetUserVersion":15}`,
		"case variant":  `{"schemaVersion":1,"sourceUserVersion":14,"TargetUserVersion":15}`,
		"unknown":       `{"schemaVersion":1,"sourceUserVersion":14,"targetUserVersion":15,"ignored":true}`,
		"missing field": `{"schemaVersion":1,"targetUserVersion":15}`,
		"trailing":      validBridgeSchemaContract + ` {}`,
		"large":         strings.Repeat(" ", bridgeSchemaContractMaxBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			verified, _ := signedBridgeSchemaFixture(t, contents)
			if _, err := readBridgeSchemaContract(verified, 14); err == nil {
				t.Fatal("accepted invalid transition contract")
			}
		})
	}
}

func TestBridgeSchemaContractRejectsPostVerificationReplacement(t *testing.T) {
	for _, method := range []string{"changed bytes", "final symlink", "directory symlink"} {
		t.Run(method, func(t *testing.T) {
			verified, _ := signedBridgeSchemaFixture(t, validBridgeSchemaContract)
			file := filepath.Join(verified.payloadRoot, bridgeSchemaContractPath)
			switch method {
			case "changed bytes":
				if err := os.WriteFile(file, []byte(strings.Replace(validBridgeSchemaContract, `15`, `16`, 1)), 0o644); err != nil {
					t.Fatal(err)
				}
			case "final symlink":
				if err := os.Remove(file); err != nil {
					t.Fatal(err)
				}
				other := filepath.Join(t.TempDir(), "other")
				if err := os.WriteFile(other, []byte(validBridgeSchemaContract), 0o644); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(other, file); err != nil {
					t.Fatal(err)
				}
			case "directory symlink":
				dir := filepath.Join(verified.payloadRoot, "launcher")
				if err := os.Rename(dir, dir+"-moved"); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(dir+"-moved", dir); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := readBridgeSchemaContract(verified, 14); err == nil {
				t.Fatal("accepted post-verification replacement")
			}
		})
	}
}
