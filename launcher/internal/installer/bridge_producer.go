package installer

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// BridgeArchiveInput describes an already signed release archive. The producer
// authenticates the descriptor and the exact archive itself, rather than
// trusting an independently supplied extracted tree.
type BridgeArchiveInput struct {
	DescriptorURL string
	DescriptorRaw []byte
	SignatureRaw  []byte
	ArchivePath   string
}

// GenerateSignedBridgeAttestation authenticates and compares two signed
// release archives and signs the bridge verifier's exact Go inventory format.
// It neither builds/signs/notarizes the archives nor authorizes publication or
// migration. Callers must separately verify macOS signatures, notarization,
// channel policy, and the installed transition before publication.
func GenerateSignedBridgeAttestation(oldInput, nextInput BridgeArchiveInput, trust map[string]ed25519.PublicKey, keyID string, private ed25519.PrivateKey) ([]byte, []byte, error) {
	if keyID == "" || len(private) != ed25519.PrivateKeySize || len(trust[keyID]) != ed25519.PublicKeySize || !private.Public().(ed25519.PublicKey).Equal(trust[keyID]) {
		return nil, nil, errors.New("bridge signing key is not an authorized Ed25519 key")
	}
	scratch, err := os.MkdirTemp("", "jobctrl-bridge-attestation-")
	if err != nil {
		return nil, nil, err
	}
	defer os.RemoveAll(scratch)
	old, oldRoot, err := producerVerifyArchive(oldInput, trust, filepath.Join(scratch, "old"))
	if err != nil {
		return nil, nil, fmt.Errorf("verify predecessor: %w", err)
	}
	next, nextRoot, err := producerVerifyArchive(nextInput, trust, filepath.Join(scratch, "next"))
	if err != nil {
		return nil, nil, fmt.Errorf("verify bridge candidate: %w", err)
	}
	if old.Channel == "local" || next.Channel != old.Channel || next.Sequence <= old.Sequence {
		return nil, nil, errors.New("bridge requires same signed channel and a newer sequence")
	}
	oldPayload, err := launcher.VerifyDistributionPayload(oldRoot, launcher.DistributionTrust{PublicKeys: trust, ExpectedChannel: old.Channel})
	if err != nil {
		return nil, nil, fmt.Errorf("predecessor payload: %w", err)
	}
	nextPayload, err := launcher.VerifyDistributionPayload(nextRoot, launcher.DistributionTrust{PublicKeys: trust, ExpectedChannel: next.Channel})
	if err != nil {
		return nil, nil, fmt.Errorf("bridge payload: %w", err)
	}
	if oldPayload.BuildID != old.BuildID || oldPayload.AppVersion != old.AppVersion || oldPayload.LauncherCompatibility.Minimum > 1 || oldPayload.LauncherCompatibility.Maximum < 1 || nextPayload.BuildID != next.BuildID || nextPayload.AppVersion != next.AppVersion || nextPayload.LauncherCompatibility.Minimum != 2 || nextPayload.LauncherCompatibility.Maximum != 2 {
		return nil, nil, errors.New("signed bridge payload identity or launcher compatibility invalid")
	}
	oldInv, err := bridgeInventory(oldRoot)
	if err != nil {
		return nil, nil, err
	}
	nextInv, err := bridgeInventory(nextRoot)
	if err != nil {
		return nil, nil, err
	}
	if err := compareBridgeInventories(oldInv, nextInv); err != nil {
		return nil, nil, err
	}
	if err := compareBridgeRuntimeManifest(oldRoot, nextRoot); err != nil {
		return nil, nil, err
	}
	if oldInv["manifest.json"].Value != old.Artifact.ManifestSHA256 || nextInv["manifest.json"].Value != next.Artifact.ManifestSHA256 {
		return nil, nil, errors.New("signed descriptor does not bind extracted manifest")
	}
	oldRaw, err := json.Marshal(oldInv)
	if err != nil {
		return nil, nil, err
	}
	nextRaw, err := json.Marshal(nextInv)
	if err != nil {
		return nil, nil, err
	}
	claim := bridgeAttestation{SchemaVersion: 1, Role: "schema14-bridge", DatabaseSchema: 14, LauncherProtocol: 2, Channel: old.Channel, Platform: "darwin-arm64", PredecessorDescriptorSHA256: digestBytes(oldInput.DescriptorRaw), PredecessorManifestSHA256: old.Artifact.ManifestSHA256, CandidateDescriptorSHA256: digestBytes(nextInput.DescriptorRaw), CandidateManifestSHA256: next.Artifact.ManifestSHA256, PredecessorInventorySHA256: digestBytes(oldRaw), CandidateInventorySHA256: digestBytes(nextRaw), ControllerSHA256: nextInv["launcher/jobctrl"].Value}
	claimRaw, err := json.Marshal(claim)
	if err != nil {
		return nil, nil, err
	}
	signature := bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: keyID, Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, signingMessage("jobctrl:bridge-attestation:v1\x00", claimRaw)))}
	signatureRaw, err := json.Marshal(signature)
	if err != nil {
		return nil, nil, err
	}
	// Exercise the production consumer before returning any signable bytes.
	makeReceipt := func(d Descriptor, in BridgeArchiveInput) release.Receipt {
		return release.Receipt{SchemaVersion: 1, BuildID: d.BuildID, Channel: d.Channel, Sequence: d.Sequence, ArtifactSHA256: d.Artifact.SHA256, ManifestSHA256: d.Artifact.ManifestSHA256, DescriptorSHA256: digestBytes(in.DescriptorRaw), DescriptorURL: in.DescriptorURL, InstalledAt: "attestation-build"}
	}
	if _, err := verifyBridgeAttestation(claimRaw, signatureRaw, trust, makeReceipt(old, oldInput), makeReceipt(next, nextInput), oldRoot, nextRoot); err != nil {
		return nil, nil, fmt.Errorf("production bridge verifier: %w", err)
	}
	return claimRaw, signatureRaw, nil
}

func producerVerifyArchive(input BridgeArchiveInput, trust map[string]ed25519.PublicKey, root string) (Descriptor, string, error) {
	var empty Descriptor
	if len(input.DescriptorRaw) == 0 || len(input.DescriptorRaw) > maxDescriptorBytes || len(input.SignatureRaw) == 0 || len(input.SignatureRaw) > maxSignatureBytes {
		return empty, "", errors.New("descriptor or signature missing or oversized")
	}
	url, build, err := validateImmutableDescriptorURL(input.DescriptorURL)
	if err != nil {
		return empty, "", err
	}
	descriptor, err := verifyDescriptor(input.DescriptorRaw, input.SignatureRaw, trust, false, url, false)
	if err != nil {
		return empty, "", err
	}
	if descriptor.BuildID != build {
		return empty, "", errors.New("descriptor URL and build differ")
	}
	if err := validateCanonicalArtifactURL(descriptor, url); err != nil {
		return empty, "", err
	}
	if err := os.Mkdir(root, 0700); err != nil {
		return empty, "", err
	}
	copyPath := filepath.Join(root, "archive.zip")
	if err := producerCopyArchive(input.ArchivePath, copyPath, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256); err != nil {
		return empty, "", err
	}
	payloadRoot := filepath.Join(root, "payload")
	if err := extractZIP(copyPath, payloadRoot); err != nil {
		return empty, "", err
	}
	return descriptor, payloadRoot, nil
}

// Hash the exact bytes that will be extracted while copying through a no-follow
// descriptor into our private scratch directory. Later pathname replacement of
// the input cannot substitute different archive bytes after verification.
func producerCopyArchive(source, destination string, expectedSize int64, expectedDigest string) error {
	fd, err := syscall.Open(source, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	input := os.NewFile(uintptr(fd), source)
	defer input.Close()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() != expectedSize {
		return errors.New("bridge archive is not a regular file of the signed size")
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(output, hash), io.LimitReader(input, expectedSize+1))
	closeErr := output.Close()
	if copyErr != nil {
		return copyErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written != expectedSize || hex.EncodeToString(hash.Sum(nil)) != expectedDigest {
		return errors.New("bridge archive size or SHA-256 differs from signed descriptor")
	}
	return nil
}
