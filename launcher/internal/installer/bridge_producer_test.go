package installer

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func producerFixture(t *testing.T) (BridgeArchiveInput, BridgeArchiveInput, map[string]ed25519.PublicKey, ed25519.PrivateKey) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	old := signedBridgePayloadFixture(t, private, "source-build-0001", 1, 1, 1)
	next := signedBridgePayloadFixture(t, private, "bridge-build-0002", 2, 2, 2)
	makeInput := func(p signedBridgePayload) BridgeArchiveInput {
		return BridgeArchiveInput{DescriptorURL: "https://releases.jobctrl.dev/v1/artifacts/" + p.build + "/release-descriptor.json", DescriptorRaw: p.descriptor, SignatureRaw: p.descriptorSig, ArchivePath: p.archive}
	}
	return makeInput(old), makeInput(next), map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, private
}

func TestProduceSignedBridgeAttestationUsesProductionVerifier(t *testing.T) {
	old, next, trust, private := producerFixture(t)
	claimRaw, signatureRaw, err := GenerateSignedBridgeAttestation(old, next, trust, "jobctrl-release-v1", private)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(signatureRaw), `"status"`) {
		t.Fatal("bridge signature has incompatible descriptor status field")
	}
	var claim bridgeAttestation
	if err := json.Unmarshal(claimRaw, &claim); err != nil {
		t.Fatal(err)
	}
	if claim.PredecessorDescriptorSHA256 != digestBytes(old.DescriptorRaw) || claim.CandidateDescriptorSHA256 != digestBytes(next.DescriptorRaw) || claim.Role != "schema14-bridge" {
		t.Fatalf("claim does not bind the exact signed descriptor bytes: %+v", claim)
	}
	oldRoot := filepath.Join(t.TempDir(), "old")
	nextRoot := filepath.Join(t.TempDir(), "next")
	if err := extractZIP(old.ArchivePath, oldRoot); err != nil {
		t.Fatal(err)
	}
	if err := extractZIP(next.ArchivePath, nextRoot); err != nil {
		t.Fatal(err)
	}
	var oldDesc, nextDesc Descriptor
	if err := json.Unmarshal(old.DescriptorRaw, &oldDesc); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(next.DescriptorRaw, &nextDesc); err != nil {
		t.Fatal(err)
	}
	receipt := func(in BridgeArchiveInput, d Descriptor) release.Receipt {
		return release.Receipt{SchemaVersion: 1, BuildID: d.BuildID, Channel: d.Channel, Sequence: d.Sequence, ArtifactSHA256: d.Artifact.SHA256, ManifestSHA256: d.Artifact.ManifestSHA256, DescriptorSHA256: digestBytes(in.DescriptorRaw), InstalledAt: "synthetic"}
	}
	if _, err := verifyBridgeAttestation(claimRaw, signatureRaw, trust, receipt(old, oldDesc), receipt(next, nextDesc), oldRoot, nextRoot); err != nil {
		t.Fatalf("production verifier rejected generated claim: %v", err)
	}
}

func TestProduceBridgeAttestationRejectsUntrustedOrChangedInputs(t *testing.T) {
	old, next, trust, private := producerFixture(t)
	run := func(oldInput, nextInput BridgeArchiveInput, keys map[string]ed25519.PublicKey, key string, signing ed25519.PrivateKey) {
		t.Helper()
		claim, sig, err := GenerateSignedBridgeAttestation(oldInput, nextInput, keys, key, signing)
		if err == nil || claim != nil || sig != nil {
			t.Fatalf("untrusted or changed input accepted: %v", err)
		}
	}
	t.Run("descriptor signature", func(t *testing.T) {
		bad := next
		bad.SignatureRaw = append([]byte(nil), next.SignatureRaw...)
		bad.SignatureRaw[len(bad.SignatureRaw)-2] ^= 1
		run(old, bad, trust, "jobctrl-release-v1", private)
	})
	t.Run("missing key", func(t *testing.T) { run(old, next, map[string]ed25519.PublicKey{}, "jobctrl-release-v1", private) })
	t.Run("untrusted signing key", func(t *testing.T) {
		_, other, _ := ed25519.GenerateKey(rand.Reader)
		run(old, next, trust, "jobctrl-release-v1", other)
	})
	t.Run("wrong immutable URL", func(t *testing.T) {
		bad := next
		bad.DescriptorURL = strings.Replace(next.DescriptorURL, "bridge-build-0002", "different-build", 1)
		run(old, bad, trust, "jobctrl-release-v1", private)
	})
	t.Run("modified archive", func(t *testing.T) {
		bad := next
		copyPath := filepath.Join(t.TempDir(), "modified.zip")
		data, err := os.ReadFile(next.ArchivePath)
		if err != nil {
			t.Fatal(err)
		}
		data[len(data)/2] ^= 1
		if err := os.WriteFile(copyPath, data, 0600); err != nil {
			t.Fatal(err)
		}
		bad.ArchivePath = copyPath
		run(old, bad, trust, "jobctrl-release-v1", private)
	})
	t.Run("archive symlink", func(t *testing.T) {
		bad := next
		link := filepath.Join(t.TempDir(), "link.zip")
		if err := os.Symlink(next.ArchivePath, link); err != nil {
			t.Fatal(err)
		}
		bad.ArchivePath = link
		run(old, bad, trust, "jobctrl-release-v1", private)
	})
	t.Run("candidate sequence must increase", func(t *testing.T) {
		var descriptor Descriptor
		if err := json.Unmarshal(next.DescriptorRaw, &descriptor); err != nil {
			t.Fatal(err)
		}
		descriptor.Sequence = 1
		raw, err := json.Marshal(descriptor)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := json.Marshal(signedDescriptorSignature(private, raw))
		if err != nil {
			t.Fatal(err)
		}
		bad := next
		bad.DescriptorRaw = raw
		bad.SignatureRaw = sig
		run(old, bad, trust, "jobctrl-release-v1", private)
	})
	t.Run("candidate must share channel", func(t *testing.T) {
		var descriptor Descriptor
		if err := json.Unmarshal(next.DescriptorRaw, &descriptor); err != nil {
			t.Fatal(err)
		}
		descriptor.Channel = "prerelease"
		raw, err := json.Marshal(descriptor)
		if err != nil {
			t.Fatal(err)
		}
		sig, err := json.Marshal(signedDescriptorSignature(private, raw))
		if err != nil {
			t.Fatal(err)
		}
		bad := next
		bad.DescriptorRaw = raw
		bad.SignatureRaw = sig
		run(old, bad, trust, "jobctrl-release-v1", private)
	})
	t.Run("candidate must be protocol two only", func(t *testing.T) {
		payload := signedBridgePayloadFixture(t, private, "bridge-build-0003", 3, 2, 1)
		bad := BridgeArchiveInput{DescriptorURL: "https://releases.jobctrl.dev/v1/artifacts/" + payload.build + "/release-descriptor.json", DescriptorRaw: payload.descriptor, SignatureRaw: payload.descriptorSig, ArchivePath: payload.archive}
		run(old, bad, trust, "jobctrl-release-v1", private)
	})
}

// Exercise the actual CLI and native producer together with ephemeral keys and
// synthetic signed payloads; no protected release keys or user workspace are used.
func TestBridgeAttestCLIWithSignedSyntheticArchives(t *testing.T) {
	old, next, trust, private := producerFixture(t)
	dir := t.TempDir()
	trustJSON, err := json.Marshal(map[string]string{"jobctrl-release-v1": base64.StdEncoding.EncodeToString(trust["jobctrl-release-v1"])})
	if err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{"old.json": old.DescriptorRaw, "old.sig": old.SignatureRaw, "next.json": next.DescriptorRaw, "next.sig": next.SignatureRaw, "trust.json": trustJSON}
	for name, raw := range files {
		if err := os.WriteFile(filepath.Join(dir, name), raw, 0600); err != nil {
			t.Fatal(err)
		}
	}
	keyDER, err := x509.MarshalPKCS8PrivateKey(private)
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "jobctrl-bridge-attest")
	goExe, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	goCache := os.Getenv("GOCACHE")
	if goCache == "" {
		goCache = filepath.Join(dir, "gocache")
	}
	baseEnv := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "TMPDIR=" + dir, "GOCACHE=" + goCache, "GOTOOLCHAIN=local", "GOPROXY=off"}
	build := exec.Command(goExe, "build", "-o", binary, "./cmd/jobctrl-bridge-attest")
	build.Dir = filepath.Join("..", "..")
	build.Env = baseEnv
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build owned CLI: %v: %s", err, out)
	}
	output := filepath.Join(dir, "role")
	args := []string{"-predecessor-descriptor-url", old.DescriptorURL, "-predecessor-descriptor-file", filepath.Join(dir, "old.json"), "-predecessor-signature-file", filepath.Join(dir, "old.sig"), "-predecessor-archive-file", old.ArchivePath, "-candidate-descriptor-url", next.DescriptorURL, "-candidate-descriptor-file", filepath.Join(dir, "next.json"), "-candidate-signature-file", filepath.Join(dir, "next.sig"), "-candidate-archive-file", next.ArchivePath, "-trust-keys-file", filepath.Join(dir, "trust.json"), "-key-id", "jobctrl-release-v1", "-output-dir", output}
	run := func() ([]byte, error) {
		cmd := exec.Command(binary, args...)
		cmd.Env = append(baseEnv, "JOBCTRL_BRIDGE_SIGNING_KEY_BASE64="+base64.StdEncoding.EncodeToString(keyDER))
		return cmd.CombinedOutput()
	}
	if out, err := run(); err != nil {
		t.Fatalf("generate owned bridge declaration: %v: %s", err, out)
	}
	claimRaw, err := os.ReadFile(filepath.Join(output, "bridge-attestation.json"))
	if err != nil {
		t.Fatal(err)
	}
	sigRaw, err := os.ReadFile(filepath.Join(output, "bridge-attestation.json.sig"))
	if err != nil {
		t.Fatal(err)
	}
	claim, err := decodeVerifiedBridgeAttestation(claimRaw, sigRaw, trust)
	if err != nil || claim.PredecessorDescriptorSHA256 != digestBytes(old.DescriptorRaw) || claim.CandidateDescriptorSHA256 != digestBytes(next.DescriptorRaw) {
		t.Fatalf("invalid CLI role binding: %v", err)
	}
	if out, err := run(); err == nil {
		t.Fatalf("CLI overwrote existing result: %s", out)
	}
}

// Exercise the real producer CLI and its generated declaration through the
// production planned-network entry, retaining synthetic app/Temporal bytes.
func TestBridgeAttestCLIToPlannedNetworkHandoff(t *testing.T) {
	f, roleURL, responses := bridgeNetworkFixture(t)
	input := plannedTarget(t, f, nil)
	dir := t.TempDir()
	trustJSON, err := json.Marshal(map[string]string{"jobctrl-release-v1": base64.StdEncoding.EncodeToString(f.options.Trust["jobctrl-release-v1"])})
	if err != nil {
		t.Fatal(err)
	}
	trustFile := writeBridgeInputFile(t, dir, "trust.json", trustJSON)
	keyDER, err := x509.MarshalPKCS8PrivateKey(f.private)
	if err != nil {
		t.Fatal(err)
	}
	goExe, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "jobctrl-bridge-attest")
	cache := os.Getenv("GOCACHE")
	if cache == "" {
		cache = filepath.Join(dir, "gocache")
	}
	baseEnv := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "TMPDIR=" + dir, "GOCACHE=" + cache, "GOTOOLCHAIN=local", "GOPROXY=off"}
	build := exec.Command(goExe, "build", "-o", binary, "./cmd/jobctrl-bridge-attest")
	build.Dir = filepath.Join("..", "..")
	build.Env = baseEnv
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build producer: %v: %s", err, out)
	}
	output := filepath.Join(dir, "role")
	args := []string{"-predecessor-descriptor-url", f.sourceInput.DescriptorURL, "-predecessor-descriptor-file", f.sourceInput.DescriptorPath, "-predecessor-signature-file", f.sourceInput.DescriptorSignaturePath, "-predecessor-archive-file", f.sourceInput.ArchivePath, "-candidate-descriptor-url", f.input.DescriptorURL, "-candidate-descriptor-file", f.input.DescriptorPath, "-candidate-signature-file", f.input.DescriptorSignaturePath, "-candidate-archive-file", f.input.ArchivePath, "-trust-keys-file", trustFile, "-key-id", "jobctrl-release-v1", "-output-dir", output}
	cmd := exec.Command(binary, args...)
	cmd.Env = append(baseEnv, "JOBCTRL_BRIDGE_SIGNING_KEY_BASE64="+base64.StdEncoding.EncodeToString(keyDER))
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("producer CLI: %v: %s", err, out)
	}
	responses[roleURL] = mustReadNetworkTest(t, filepath.Join(output, "bridge-attestation.json"))
	responses[roleURL+".sig"] = mustReadNetworkTest(t, filepath.Join(output, "bridge-attestation.json.sig"))
	responses[input.TargetDescriptorURL] = mustReadNetworkTest(t, input.TargetDescriptorPath)
	responses[input.TargetDescriptorURL+".sig"] = mustReadNetworkTest(t, input.TargetSignaturePath)
	for _, name := range []string{"jobctrl.db", "jobctrl.db-wal", "jobctrl.db-shm", "temporal.db", "temporal.db-wal"} {
		if err := os.WriteFile(filepath.Join(f.options.Home, name), []byte("synthetic "+name), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	f.options.HTTPClient, _ = channelPointerClient(responses)
	receipt, err := InstallSignedNetworkBridgeForTarget(f.options, f.input.DescriptorURL, roleURL, input.TargetDescriptorURL)
	if err != nil {
		t.Fatalf("planned handoff: %v", err)
	}
	if receipt.BuildID != "bridge-build-0002" {
		t.Fatalf("unexpected bridge %s", receipt.BuildID)
	}
	for _, name := range []string{"jobctrl.db", "jobctrl.db-wal", "jobctrl.db-shm", "temporal.db", "temporal.db-wal"} {
		raw, err := os.ReadFile(filepath.Join(f.options.Home, name))
		if err != nil || string(raw) != "synthetic "+name {
			t.Fatalf("changed %s: %q %v", name, raw, err)
		}
	}
	var requests map[string]int
	f.options.HTTPClient, requests = channelPointerClient(nil)
	if _, err := InstallSignedNetworkBridgeForTarget(f.options, f.input.DescriptorURL, roleURL, input.TargetDescriptorURL); err != nil {
		t.Fatalf("offline retry: %v", err)
	}
	if len(requests) != 0 {
		t.Fatalf("offline retry accessed network: %v", requests)
	}
}
