package launcher

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// signBridgeTransitionFixture signs a synthetic release whose inventory binds
// both the exact schema transition and the controlled test activation wrapper.
func signBridgeTransitionFixture(t *testing.T, fixture homebrewBootstrapFixture, private ed25519.PrivateKey, wrapper string) homebrewBootstrapFixture {
	t.Helper()
	if err := os.WriteFile(filepath.Join(fixture.payloadRoot, bridgeSchemaContractPath), []byte(validBridgeSchemaContract), 0644); err != nil {
		t.Fatal(err)
	}
	if wrapper != "" {
		if err := os.WriteFile(filepath.Join(fixture.payloadRoot, "python", "bin", "python3"), []byte(wrapper), 0755); err != nil {
			t.Fatal(err)
		}
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
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:manifest:v1\x00", raw)))
	signed, err := json.Marshal(manifestSignature{SchemaVersion: 1, Status: "signed", ManifestAlgorithm: "ed25519", ManifestKeyID: "jobctrl-release-v1", Signature: &signature, Promotable: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.payloadRoot, "manifest.json"), raw, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.payloadRoot, "manifest.sig"), signed, 0644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	fixture.receipt.ManifestSHA256 = hex.EncodeToString(sum[:])
	var descriptor map[string]any
	if err := json.Unmarshal(fixture.descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	descriptor["artifact"].(map[string]any)["manifestSha256"] = fixture.receipt.ManifestSHA256
	fixture.descriptorRaw, err = json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	sum = sha256.Sum256(fixture.descriptorRaw)
	fixture.descriptorSHA256 = hex.EncodeToString(sum[:])
	fixture.receipt.DescriptorSHA256 = fixture.descriptorSHA256
	fixture.policy.DescriptorDigest = fixture.descriptorSHA256
	fixture.receipt.PolicySHA256 = lifecyclePolicyDigest(t, fixture.policy)
	descriptorSignature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:release-descriptor:v1\x00", fixture.descriptorRaw)))
	fixture.signatureRaw, err = json.Marshal(homebrewFixtureSignature{SchemaVersion: 1, Status: "signed", Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: descriptorSignature})
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}
