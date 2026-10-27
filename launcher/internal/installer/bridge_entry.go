package installer

// Bridge acquisition is authenticated and serialized with cooperating
// release mutators. Independent same-user filesystem substitution is outside
// the documented local-disk threat boundary and is not prevented here.
import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type CachedBridgeInput struct {
	DescriptorURL, DescriptorPath, DescriptorSignaturePath, ArchivePath string
	AttestationPath, AttestationSignaturePath                           string
}

func bridgeEvidencePath(home, digest string) string {
	return filepath.Join(home, "bridge-evidence-"+digest+".json")
}

// Completion records retain the authenticated predecessor identity after
// intent removal. Empty digest searches for the sole record matching the
// current active tuple; a supplied digest checks only that exact record.
func findCompletedBridge(home, digest string) (bridgeHandoffIntent, error) {
	var none bridgeHandoffIntent
	activeRaw, err := readBridgeRegular(filepath.Join(home, release.ActiveFile), maxBridgeIntentBytes)
	if err != nil {
		return none, err
	}
	var active release.Active
	if err := decodeStrict(activeRaw, "active release", &active); err != nil {
		return none, err
	}
	if digest != "" && !sha256Pattern.MatchString(digest) {
		return none, errors.New("invalid bridge completion digest")
	}
	entries, err := os.ReadDir(home)
	if err != nil {
		return none, err
	}
	var names []string
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), "bridge-complete-") && strings.HasSuffix(entry.Name(), ".json") {
			names = append(names, entry.Name())
		}
		if len(names) > 4096 {
			return none, errors.New("too many bridge completion records")
		}
	}
	found := false
	for _, name := range names {
		parts := strings.Split(strings.TrimSuffix(strings.TrimPrefix(name, "bridge-complete-"), ".json"), "-")
		if len(parts) != 2 || !sha256Pattern.MatchString(parts[0]) || !sha256Pattern.MatchString(parts[1]) {
			return none, errors.New("invalid bridge completion filename")
		}
		if digest != "" && parts[0] != digest {
			continue
		}
		raw, err := readBridgeRegular(filepath.Join(home, name), maxBridgeIntentBytes)
		if err != nil {
			return none, err
		}
		var record bridgeHandoffIntent
		if err := decodeStrict(raw, "bridge completion", &record); err != nil || record.SchemaVersion != 1 || record.EvidenceSHA256 != parts[0] || digestBytes(raw) != parts[1] || record.Source.Generation == 0 || record.Source.Generation == ^uint64(0) || !record.Target.Valid() {
			return none, errors.New("invalid bridge completion record")
		}
		expected := release.Active{SchemaVersion: 1, Generation: record.Source.Generation + 1, Receipt: record.Target, SelectorBuildID: record.Target.BuildID, Acquisition: record.Source.Acquisition}
		if active != expected {
			continue
		}
		if found {
			return none, errors.New("ambiguous bridge completion records")
		}
		none, found = record, true
	}
	if !found {
		return none, os.ErrNotExist
	}
	return none, nil
}

const maxBridgeEvidenceBytes = 4 * maxDescriptorBytes

type bridgeEvidenceBundle struct {
	SchemaVersion        int    `json:"schemaVersion"`
	DescriptorURL        string `json:"descriptorUrl"`
	Descriptor           []byte `json:"descriptor"`
	DescriptorSignature  []byte `json:"descriptorSignature"`
	Attestation          []byte `json:"attestation"`
	AttestationSignature []byte `json:"attestationSignature"`
}

func prepareSignedCachedBridge(options Options, input CachedBridgeInput) (*release.Store, bridgeHandoffEvidence, error) {
	var empty bridgeHandoffEvidence
	if !options.Policy.AllowNetwork || options.AllowUnsignedLocal || len(options.Trust) == 0 || (options.Policy.ExpectedChannel != "stable" && options.Policy.ExpectedChannel != "prerelease") {
		return nil, empty, errors.New("bridge requires signed channel and trusted keys")
	}
	home, err := RuntimeHome(options.Home)
	if err != nil {
		return nil, empty, err
	}
	// A committed intent requires the durable signed bundle; never fall back to
	// caller-supplied files during recovery or re-stage an archive.
	var prior bridgeHandoffIntent
	intentRaw, intentErr := readBridgeRegular(filepath.Join(home, bridgeIntentName), maxBridgeIntentBytes)
	recovering := intentErr == nil
	if intentErr != nil && !errors.Is(intentErr, os.ErrNotExist) {
		return nil, empty, intentErr
	}
	if !recovering && input.DescriptorURL == "" {
		prior, err = findCompletedBridge(home, "")
		if err != nil {
			return nil, empty, err
		}
		recovering = true
	}
	var bundle bridgeEvidenceBundle
	if recovering {
		if intentErr == nil {
			if err := decodeStrict(intentRaw, "bridge handoff intent", &prior); err != nil {
				return nil, empty, err
			}
		}
		if !sha256Pattern.MatchString(prior.EvidenceSHA256) {
			return nil, empty, errors.New("invalid bridge recovery evidence digest")
		}
		bundleRaw, err := readBridgeRegular(bridgeEvidencePath(home, prior.EvidenceSHA256), maxBridgeEvidenceBytes)
		if err != nil {
			return nil, empty, err
		}
		if !sha256Pattern.MatchString(prior.EvidenceSHA256) || digestBytes(bundleRaw) != prior.EvidenceSHA256 {
			return nil, empty, errors.New("bridge recovery evidence digest mismatch")
		}
		if err := decodeStrict(bundleRaw, "bridge signed evidence", &bundle); err != nil {
			return nil, empty, err
		}
	} else {
		bundle.SchemaVersion = 1
		bundle.DescriptorURL = input.DescriptorURL
		bundle.Descriptor, err = readBridgeRegular(input.DescriptorPath, maxDescriptorBytes)
		if err != nil {
			return nil, empty, err
		}
		bundle.DescriptorSignature, err = readBridgeRegular(input.DescriptorSignaturePath, maxSignatureBytes)
		if err != nil {
			return nil, empty, err
		}
		bundle.Attestation, err = readBridgeRegular(input.AttestationPath, maxDescriptorBytes)
		if err != nil {
			return nil, empty, err
		}
		bundle.AttestationSignature, err = readBridgeRegular(input.AttestationSignaturePath, maxSignatureBytes)
		if err != nil {
			return nil, empty, err
		}
	}
	if bundle.SchemaVersion != 1 || len(bundle.Descriptor) > maxDescriptorBytes || len(bundle.DescriptorSignature) > maxSignatureBytes || len(bundle.Attestation) > maxDescriptorBytes || len(bundle.AttestationSignature) > maxSignatureBytes {
		return nil, empty, errors.New("invalid bridge signed evidence")
	}
	if recovering && input.DescriptorURL != "" && input.DescriptorURL != bundle.DescriptorURL {
		return nil, empty, errors.New("requested bridge differs from retained recovery evidence")
	}
	bundleRaw, err := encodeJSON(bundle)
	if err != nil || len(bundleRaw) > maxBridgeEvidenceBytes {
		return nil, empty, errors.New("bridge signed evidence exceeds bound")
	}
	if recovering && digestBytes(bundleRaw) != prior.EvidenceSHA256 {
		return nil, empty, errors.New("bridge recovery evidence is not canonical")
	}
	if !recovering {
		if completed, e := findCompletedBridge(home, digestBytes(bundleRaw)); e == nil {
			prior, recovering = completed, true
		} else if !errors.Is(e, os.ErrNotExist) {
			return nil, empty, e
		}
	}
	sourceURL, build, err := validateImmutableDescriptorURL(bundle.DescriptorURL)
	if err != nil {
		return nil, empty, err
	}
	descriptorRaw, signature := bundle.Descriptor, bundle.DescriptorSignature
	claimRaw, claimSig := bundle.Attestation, bundle.AttestationSignature
	descriptor, err := verifyDescriptor(descriptorRaw, signature, options.Trust, false, sourceURL, false)
	if err != nil {
		return nil, empty, err
	}
	if descriptor.BuildID != build || descriptor.Channel != options.Policy.ExpectedChannel {
		return nil, empty, errors.New("bridge descriptor identity or channel mismatch")
	}
	if err := validateCanonicalArtifactURL(descriptor, sourceURL); err != nil {
		return nil, empty, err
	}
	// Authenticate the role and bind it to this descriptor before staging its
	// potentially large archive. The full predecessor, inventory and selector
	// checks still run under the transition locks before the handoff.
	claim, err := decodeVerifiedBridgeAttestation(claimRaw, claimSig, options.Trust)
	if err != nil {
		return nil, empty, err
	}
	if claim.SchemaVersion != 1 || claim.Role != "schema14-bridge" || claim.DatabaseSchema != 14 || claim.LauncherProtocol != 2 || claim.Platform != "darwin-arm64" || claim.Channel != descriptor.Channel || claim.CandidateDescriptorSHA256 != digestBytes(descriptorRaw) || claim.CandidateManifestSHA256 != descriptor.Artifact.ManifestSHA256 || !sha256Pattern.MatchString(claim.PredecessorDescriptorSHA256) || !sha256Pattern.MatchString(claim.PredecessorManifestSHA256) || !sha256Pattern.MatchString(claim.PredecessorInventorySHA256) || !sha256Pattern.MatchString(claim.CandidateInventorySHA256) || !sha256Pattern.MatchString(claim.ControllerSHA256) || claim.PredecessorDescriptorSHA256 == claim.CandidateDescriptorSHA256 {
		return nil, empty, errors.New("bridge attestation identity invalid")
	}
	var staged Receipt
	var target release.Receipt
	if recovering {
		target = prior.Target
		if target.BuildID != descriptor.BuildID || target.DescriptorSHA256 != digestBytes(descriptorRaw) || target.DescriptorURL != bundle.DescriptorURL {
			return nil, empty, errors.New("bridge target differs from signed recovery evidence")
		}
		receiptRaw, e := readBridgeRegular(filepath.Join(home, "releases", target.BuildID, "receipt.json"), maxDescriptorBytes)
		if e != nil {
			return nil, empty, e
		}
		if e := decodeStrict(receiptRaw, "candidate receipt", &staged); e != nil {
			return nil, empty, e
		}
		installed := release.Receipt{SchemaVersion: staged.SchemaVersion, BuildID: staged.BuildID, Channel: staged.Channel, Sequence: staged.Sequence, ArtifactSHA256: staged.ArtifactSHA256, ManifestSHA256: staged.ManifestSHA256, DescriptorSHA256: staged.DescriptorSHA256, PolicySHA256: staged.PolicySHA256, DescriptorURL: staged.DescriptorURL, InstalledAt: staged.InstalledAt}
		if installed != target {
			return nil, empty, errors.New("bridge retained target differs from installed receipt")
		}
	} else {
		stagedOptions := options
		stagedOptions.StageOnly = true
		staged, err = InstallFromCachedFiles(stagedOptions, input.DescriptorURL, input.DescriptorPath, input.DescriptorSignaturePath, input.ArchivePath)
		if err != nil {
			return nil, empty, err
		}
		if staged.DescriptorSHA256 != digestBytes(descriptorRaw) {
			return nil, empty, errors.New("bridge descriptor changed while staging")
		}
		target = release.Receipt{SchemaVersion: staged.SchemaVersion, BuildID: staged.BuildID, Channel: staged.Channel, Sequence: staged.Sequence, ArtifactSHA256: staged.ArtifactSHA256, ManifestSHA256: staged.ManifestSHA256, DescriptorSHA256: staged.DescriptorSHA256, PolicySHA256: staged.PolicySHA256, DescriptorURL: staged.DescriptorURL, InstalledAt: staged.InstalledAt}
	}
	// An installed receipt is durable local state, not signing authority. Bind
	// every descriptor-owned field again during both fresh and recovery paths.
	if target.SchemaVersion != 2 || target.BuildID != descriptor.BuildID || target.Channel != descriptor.Channel || target.Sequence != descriptor.Sequence || target.ArtifactSHA256 != descriptor.Artifact.SHA256 || target.ManifestSHA256 != descriptor.Artifact.ManifestSHA256 || target.DescriptorSHA256 != digestBytes(descriptorRaw) || target.DescriptorURL != bundle.DescriptorURL {
		return nil, empty, errors.New("bridge target receipt differs from signed descriptor")
	}
	store, err := release.Open(home)
	if err != nil {
		return nil, empty, err
	}
	active, err := store.ReadActive()
	if err != nil {
		return nil, empty, err
	}
	if recovering {
		active = prior.Source
	}
	if active.SelectorBuildID != active.Receipt.BuildID || active.Receipt.Channel != descriptor.Channel || !buildIDPattern.MatchString(active.Receipt.BuildID) {
		return nil, empty, errors.New("bridge requires predecessor's own selector")
	}
	oldRoot := filepath.Join(store.Home, "releases", active.Receipt.BuildID, "payload")
	nextRoot := filepath.Join(store.Home, "releases", target.BuildID, "payload")
	metadata := release.ChannelMetadata{Channel: descriptor.Channel, Sequence: descriptor.Sequence, Minimum: descriptor.MinimumSafeSequence, BuildID: descriptor.BuildID, DescriptorDigest: digestBytes(descriptorRaw), Revoked: descriptor.RevokedBuildIDs}
	verifier := func() (bridgeAttestation, string, []byte, error) {
		var zero bridgeAttestation
		current, err := store.ReadActive()
		if err != nil {
			return zero, "", nil, err
		}
		if current == active {
			if err := store.Permit(active.Receipt); err != nil {
				return zero, "", nil, err
			}
		} else if current.Receipt == target {
			if err := store.Permit(target); err != nil {
				return zero, "", nil, err
			}
		} else {
			return zero, "", nil, errors.New("bridge active receipt changed")
		}
		trust := launcher.DistributionTrust{PublicKeys: options.Trust, ExpectedChannel: descriptor.Channel}
		oldManifest, err := launcher.VerifyDistributionPayload(oldRoot, trust)
		if err != nil {
			return zero, "", nil, err
		}
		nextManifest, err := launcher.VerifyDistributionPayload(nextRoot, trust)
		if err != nil {
			return zero, "", nil, err
		}
		if oldManifest.BuildID != active.Receipt.BuildID || oldManifest.ReleaseChannel != active.Receipt.Channel || oldManifest.LauncherCompatibility.Minimum > 1 || oldManifest.LauncherCompatibility.Maximum < 1 || nextManifest.BuildID != target.BuildID || nextManifest.LauncherCompatibility.Minimum != 2 || nextManifest.LauncherCompatibility.Maximum != 2 {
			return zero, "", nil, errors.New("bridge distribution compatibility or identity mismatch")
		}
		if _, _, err := verifyInstalledRelease(filepath.Join(store.Home, "releases", target.BuildID), descriptor, trust, staged); err != nil {
			return zero, "", nil, err
		}
		oldRaw, err := readBridgeRegular(filepath.Join(store.Home, "releases", active.Receipt.BuildID, "receipt.json"), maxDescriptorBytes)
		if err != nil {
			return zero, "", nil, err
		}
		var oldReceipt release.Receipt
		if err := decodeStrict(oldRaw, "predecessor receipt", &oldReceipt); err != nil || oldReceipt != active.Receipt {
			return zero, "", nil, errors.New("bridge predecessor receipt mismatch")
		}
		if oldReceipt.SchemaVersion == 2 {
			policyRaw, err := readBridgeRegular(filepath.Join(store.Home, "releases", oldReceipt.BuildID, "policy.json"), maxDescriptorBytes)
			if err != nil || digestBytes(policyRaw) != oldReceipt.PolicySHA256 {
				return zero, "", nil, errors.New("bridge predecessor policy digest mismatch")
			}
			var policy release.ChannelMetadata
			if err := decodeStrict(policyRaw, "predecessor policy", &policy); err != nil || policy.Channel != oldReceipt.Channel || policy.Sequence != oldReceipt.Sequence || policy.BuildID != oldReceipt.BuildID || policy.DescriptorDigest != oldReceipt.DescriptorSHA256 || policy.Minimum > policy.Sequence {
				return zero, "", nil, errors.New("bridge predecessor policy mismatch")
			}
		}
		claim, err := verifyBridgeAttestation(claimRaw, claimSig, options.Trust, active.Receipt, target, oldRoot, nextRoot)
		if err != nil {
			return zero, "", nil, err
		}
		var oldController string
		for _, file := range oldManifest.Files {
			if file.Path == "launcher/jobctrl" && file.Type == "file" && file.Mode == "0755" {
				oldController = file.SHA256
			}
		}
		if !sha256Pattern.MatchString(oldController) {
			return zero, "", nil, errors.New("predecessor executable absent from signed manifest")
		}
		controller, err := readBridgeRegular(filepath.Join(nextRoot, "launcher", "jobctrl"), 128<<20)
		if err != nil {
			return zero, "", nil, err
		}
		if digestBytes(controller) != claim.ControllerSHA256 {
			return zero, "", nil, errors.New("bridge controller bytes changed")
		}
		return claim, oldController, controller, nil
	}
	claim, oldController, controller, err := verifier()
	if err != nil {
		return nil, empty, fmt.Errorf("bridge evidence: %w", err)
	}
	evidence := bridgeHandoffEvidence{Intent: bridgeHandoffIntent{SchemaVersion: 1, Source: active, Target: target, SourceSelectorSHA256: oldController, ControllerSHA256: claim.ControllerSHA256, EvidenceSHA256: digestBytes(bundleRaw), Metadata: metadata}, Controller: controller}
	evidence.Persist = func() error {
		path := bridgeEvidencePath(store.Home, digestBytes(bundleRaw))
		existing, err := readBridgeRegular(path, maxBridgeEvidenceBytes)
		if err == nil {
			if !bytes.Equal(existing, bundleRaw) {
				return errors.New("different bridge signed evidence already exists")
			}
			return nil
		}
		if !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return writeBytesAtomic(path, bundleRaw, 0600)
	}
	evidence.Verify = func() error {
		persisted, err := readBridgeRegular(bridgeEvidencePath(store.Home, digestBytes(bundleRaw)), maxBridgeEvidenceBytes)
		if recovering {
			if err != nil || !bytes.Equal(persisted, bundleRaw) {
				return errors.New("bridge recovery evidence changed")
			}
		} else if err == nil && !bytes.Equal(persisted, bundleRaw) {
			return errors.New("different bridge signed evidence already exists")
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		next, sourceSHA, controllerNow, err := verifier()
		if err != nil {
			return err
		}
		if next != claim || sourceSHA != oldController || !bytes.Equal(controllerNow, controller) {
			return errors.New("bridge authenticated evidence changed")
		}
		return nil
	}
	return store, evidence, nil
}

// InstallSignedCachedBridge authenticates an exact schema-14 bridge, then
// performs an active-first controller handoff. Recovery may pass empty input:
// its signed evidence is durably bound by the retained intent. This operation
// does not stop, start, migrate, back up, or restore application databases.
func InstallSignedCachedBridge(options Options, input CachedBridgeInput) (Receipt, error) {
	store, evidence, err := prepareSignedCachedBridge(options, input)
	if err != nil {
		return Receipt{}, err
	}
	if err := bridgeSelection(store, evidence, nil); err != nil {
		return Receipt{}, err
	}
	lock, err := store.SelectionLock(false)
	if err != nil {
		return Receipt{}, err
	}
	defer lock.Close()
	active, err := store.ReadActive()
	expected := release.Active{SchemaVersion: 1, Generation: evidence.Intent.Source.Generation + 1, Receipt: evidence.Intent.Target, SelectorBuildID: evidence.Intent.Target.BuildID, Acquisition: evidence.Intent.Source.Acquisition}
	if err != nil || active != expected {
		return Receipt{}, errors.New("bridge selection changed before readback")
	}
	if err := verifyBridgeSelector(store.Home, evidence.Intent.ControllerSHA256); err != nil {
		return Receipt{}, err
	}
	target := evidence.Intent.Target
	return Receipt{SchemaVersion: target.SchemaVersion, BuildID: target.BuildID, Channel: target.Channel, Sequence: target.Sequence, ArtifactSHA256: target.ArtifactSHA256, ManifestSHA256: target.ManifestSHA256, DescriptorSHA256: target.DescriptorSHA256, PolicySHA256: target.PolicySHA256, DescriptorURL: target.DescriptorURL, InstalledAt: target.InstalledAt}, nil
}

func readBridgeRegular(path string, limit int64) ([]byte, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("bridge input is not a bounded regular file")
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("bridge input exceeds size limit")
	}
	return raw, nil
}
