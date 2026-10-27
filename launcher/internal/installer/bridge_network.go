package installer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// InstallSignedNetworkBridge is an explicit acquisition path for a specific
// signed bridge; it does not discover a bridge or promote a final release.
// The supplied immutable URLs identify bytes, not authority. The signed role
// and descriptors establish authority and the cached handoff rechecks them
// under the release locks before changing selection.
func InstallSignedNetworkBridge(options Options, descriptorURL, roleURL string) (Receipt, error) {
	return installSignedNetworkBridge(options, descriptorURL, roleURL, "")
}

// InstallSignedNetworkBridgeForTarget binds an explicit network handoff to a
// signed final target. Recovery uses retained evidence and needs no network.
// The target payload is not downloaded or promoted by this operation.
func InstallSignedNetworkBridgeForTarget(options Options, descriptorURL, roleURL, targetURL string) (Receipt, error) {
	if targetURL == "" {
		return Receipt{}, errors.New("planned network bridge requires a final target descriptor URL")
	}
	return installSignedNetworkBridge(options, descriptorURL, roleURL, targetURL)
}

func installSignedNetworkBridge(options Options, descriptorURL, roleURL, targetURL string) (Receipt, error) {
	if !options.Policy.AllowNetwork || options.AllowUnsignedLocal || len(options.Trust) == 0 || options.StageOnly || options.ReleaseURL != "" {
		return Receipt{}, errors.New("network bridge requires signed acquisition without stage-only or a channel pointer")
	}
	parsed, build, err := validateImmutableDescriptorURL(descriptorURL)
	if err != nil {
		return Receipt{}, fmt.Errorf("bridge descriptor URL: %w", err)
	}
	if targetURL != "" {
		if _, _, err := validateImmutableDescriptorURL(targetURL); err != nil {
			return Receipt{}, fmt.Errorf("final target descriptor URL: %w", err)
		}
	}
	role, err := parseCanonicalReleaseURL(roleURL)
	if err != nil {
		return Receipt{}, fmt.Errorf("bridge role URL: %w", err)
	}
	parent := "/v1/artifacts/" + build + "/"
	name := strings.TrimPrefix(role.Path, parent)
	if !strings.HasPrefix(role.Path, parent) || name == "" || name == "." || name == ".." || strings.Contains(name, "/") || name == "release-descriptor.json" || strings.HasSuffix(name, ".sig") {
		return Receipt{}, errors.New("bridge role URL must identify a separate immutable file in the descriptor build")
	}
	// Legacy uninstall already owns this lock and removes staging. Keep it
	// across source revalidation, download, staging, handoff and cache cleanup.
	store, transition, err := lockExistingBridgeStore(options.Home)
	if err != nil {
		return Receipt{}, err
	}
	defer transition.Close()
	home := store.Home
	// An existing intent is authoritative. Recovery must use retained signed
	// evidence, not require the publisher or the original temporary inputs.
	if _, err := os.Lstat(filepath.Join(home, bridgeIntentName)); err == nil {
		result, err := installSignedCachedBridgeWithTransition(options, CachedBridgeInput{RecoveryDescriptorURL: descriptorURL, TargetDescriptorURL: targetURL}, store)
		return finishRecoveredNetworkBridge(home, result, err)
	} else if !errors.Is(err, os.ErrNotExist) {
		return Receipt{}, err
	}
	// A completed handoff is also retryable using retained signed evidence.
	// The completion binds the requested immutable descriptor, while the role
	// URL is only a transport location and is not itself signing authority.
	completed, err := findCompletedBridge(home, "")
	if err == nil && completed.Target.DescriptorURL == descriptorURL {
		result, err := installSignedCachedBridgeWithTransition(options, CachedBridgeInput{RecoveryDescriptorURL: descriptorURL, TargetDescriptorURL: targetURL}, store)
		return finishRecoveredNetworkBridge(home, result, err)
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return Receipt{}, err
	}
	client := options.HTTPClient
	if client == nil {
		client = strictHTTPClient()
	}
	descriptorRaw, err := fetchBounded(client, descriptorURL, maxDescriptorBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("download bridge descriptor: %w", err)
	}
	descriptorSig, err := fetchBounded(client, descriptorURL+".sig", maxSignatureBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("download bridge descriptor signature: %w", err)
	}
	descriptor, err := verifyDescriptor(descriptorRaw, descriptorSig, options.Trust, false, parsed, false)
	if err != nil {
		return Receipt{}, err
	}
	if descriptor.BuildID != build || descriptor.Channel != options.Policy.ExpectedChannel {
		return Receipt{}, errors.New("bridge descriptor identity or channel mismatch")
	}
	if err := validateCanonicalArtifactURL(descriptor, parsed); err != nil {
		return Receipt{}, err
	}
	roleRaw, err := fetchBounded(client, roleURL, maxDescriptorBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("download bridge role: %w", err)
	}
	roleSig, err := fetchBounded(client, roleURL+".sig", maxSignatureBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("download bridge role signature: %w", err)
	}
	claim, err := decodeVerifiedBridgeAttestation(roleRaw, roleSig, options.Trust)
	if err != nil {
		return Receipt{}, err
	}
	active, err := store.ReadActive()
	if err != nil {
		return Receipt{}, fmt.Errorf("read bridge predecessor: %w", err)
	}
	if !active.Receipt.Valid() || active.SelectorBuildID != active.Receipt.BuildID || active.Receipt.Channel != descriptor.Channel || claim.SchemaVersion != 1 || claim.Role != "schema14-bridge" || claim.DatabaseSchema != 14 || claim.LauncherProtocol != 2 || claim.Platform != "darwin-arm64" || claim.Channel != descriptor.Channel || claim.PredecessorDescriptorSHA256 != active.Receipt.DescriptorSHA256 || claim.PredecessorManifestSHA256 != active.Receipt.ManifestSHA256 || claim.CandidateDescriptorSHA256 != digestBytes(descriptorRaw) || claim.CandidateManifestSHA256 != descriptor.Artifact.ManifestSHA256 || !sha256Pattern.MatchString(claim.PredecessorInventorySHA256) || !sha256Pattern.MatchString(claim.CandidateInventorySHA256) || !sha256Pattern.MatchString(claim.ControllerSHA256) || descriptor.Sequence <= active.Receipt.Sequence {
		return Receipt{}, errors.New("bridge role does not bind the active predecessor and signed target")
	}
	if err := store.Permit(active.Receipt); err != nil {
		return Receipt{}, err
	}
	metadata := release.ChannelMetadata{Channel: descriptor.Channel, Sequence: descriptor.Sequence, Minimum: descriptor.MinimumSafeSequence, BuildID: descriptor.BuildID, DescriptorDigest: digestBytes(descriptorRaw), Revoked: descriptor.RevokedBuildIDs}
	if _, err := store.ValidateMetadata(metadata); err != nil {
		return Receipt{}, err
	}
	var targetRaw, targetSig []byte
	if targetURL != "" {
		parsedTarget, targetBuild, err := validateImmutableDescriptorURL(targetURL)
		if err != nil {
			return Receipt{}, err
		}
		targetRaw, err = fetchBounded(client, targetURL, maxDescriptorBytes)
		if err != nil {
			return Receipt{}, fmt.Errorf("download final target descriptor: %w", err)
		}
		targetSig, err = fetchBounded(client, targetURL+".sig", maxSignatureBytes)
		if err != nil {
			return Receipt{}, fmt.Errorf("download final target signature: %w", err)
		}
		target, err := verifyDescriptor(targetRaw, targetSig, options.Trust, false, parsedTarget, false)
		if err != nil {
			return Receipt{}, err
		}
		if target.BuildID != targetBuild || target.Channel != descriptor.Channel {
			return Receipt{}, errors.New("bridge final target identity or channel mismatch")
		}
		if err := validateCanonicalArtifactURL(target, parsedTarget); err != nil {
			return Receipt{}, err
		}
		if err := validatePlannedBridgePolicy(store, active.Receipt, metadata, target, digestBytes(targetRaw)); err != nil {
			return Receipt{}, err
		}
	}

	temp, unlock, err := bridgeDownloadCache(home, digestBytes(descriptorRaw))
	if err != nil {
		return Receipt{}, err
	}
	defer unlock()
	write := func(name string, raw []byte) (string, error) {
		path := filepath.Join(temp, name)
		return path, writeBytesAtomic(path, raw, 0o600)
	}
	descriptorPath, err := write("descriptor.json", descriptorRaw)
	if err != nil {
		return Receipt{}, err
	}
	signaturePath, err := write("descriptor.sig", descriptorSig)
	if err != nil {
		return Receipt{}, err
	}
	rolePath, err := write("role.json", roleRaw)
	if err != nil {
		return Receipt{}, err
	}
	roleSignaturePath, err := write("role.sig", roleSig)
	if err != nil {
		return Receipt{}, err
	}
	var targetPath, targetSigPath string
	if targetURL != "" {
		targetPath, err = write("target.json", targetRaw)
		if err != nil {
			return Receipt{}, err
		}
		targetSigPath, err = write("target.sig", targetSig)
		if err != nil {
			return Receipt{}, err
		}
	}
	archive, err := downloadArchiveToStage(archiveHTTPClient(client), descriptor.Artifact.URL, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256, temp)
	if err != nil {
		return Receipt{}, fmt.Errorf("download bridge archive: %w", err)
	}
	result, err := installSignedCachedBridgeWithTransition(options, CachedBridgeInput{DescriptorURL: descriptorURL, DescriptorPath: descriptorPath, DescriptorSignaturePath: signaturePath, ArchivePath: archive, AttestationPath: rolePath, AttestationSignaturePath: roleSignaturePath, TargetDescriptorURL: targetURL, TargetDescriptorPath: targetPath, TargetSignaturePath: targetSigPath}, store)
	if err == nil {
		if cleanupErr := cleanBridgeDownloadCache(temp); cleanupErr != nil {
			return result, fmt.Errorf("bridge handoff completed but download cache cleanup failed: %w", cleanupErr)
		}
	}
	return result, err
}

func finishRecoveredNetworkBridge(home string, result Receipt, err error) (Receipt, error) {
	if err != nil {
		return result, err
	}
	if !sha256Pattern.MatchString(result.DescriptorSHA256) {
		return result, errors.New("recovered bridge has invalid cache identity")
	}
	path := filepath.Join(home, "staging", "bridge-downloads", result.DescriptorSHA256)
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) {
		return result, nil
	} else if err != nil {
		return result, err
	}
	cache, unlock, err := bridgeDownloadCache(home, result.DescriptorSHA256)
	if err != nil {
		return result, fmt.Errorf("bridge handoff completed but download cache cleanup failed: %w", err)
	}
	defer unlock()
	if err := cleanBridgeDownloadCache(cache); err != nil {
		return result, fmt.Errorf("bridge handoff completed but download cache cleanup failed: %w", err)
	}
	return result, nil
}

// Remove only names owned by this cache. Any unfamiliar contents and the
// ownership marker survive for inspection and future safe cleanup.
func cleanBridgeDownloadCache(cache string) error {
	for _, name := range []string{"descriptor.json", "descriptor.sig", "role.json", "role.sig", "target.json", "target.sig", stagedArchiveName, partialArchiveName} {
		if err := os.Remove(filepath.Join(cache, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	entries, err := os.ReadDir(cache)
	if err != nil {
		return err
	}
	markerName := "cache-owner-" + filepath.Base(cache)
	if len(entries) != 1 || entries[0].Name() != markerName {
		return nil
	}
	if err := os.Remove(filepath.Join(cache, markerName)); err != nil {
		return err
	}
	return os.Remove(cache)
}

// A stable, descriptor-bound cache permits the existing range downloader to
// resume after a process exit. The caller must hold the lifecycle transition
// lock, ensuring legacy uninstall cannot remove staging during acquisition.
func bridgeDownloadCache(home, digest string) (string, func(), error) {
	if !sha256Pattern.MatchString(digest) {
		return "", nil, errors.New("invalid bridge cache identity")
	}
	staging := filepath.Join(home, "staging")
	if err := os.Mkdir(staging, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", nil, err
	}
	stagingInfo, err := os.Lstat(staging)
	if err != nil || !stagingInfo.IsDir() || stagingInfo.Mode()&os.ModeSymlink != 0 || stagingInfo.Mode().Perm() != 0o700 {
		return "", nil, errors.New("bridge staging root is not a private directory")
	}
	root := filepath.Join(staging, "bridge-downloads")
	if err := os.Mkdir(root, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return "", nil, err
	}
	rootInfo, err := os.Lstat(root)
	if err != nil || !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 || rootInfo.Mode().Perm() != 0o700 {
		return "", nil, errors.New("bridge download root is not a private directory")
	}
	lockPath := filepath.Join(root, digest+".lock")
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return "", nil, err
	}
	info, err := lock.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		lock.Close()
		return "", nil, errors.New("bridge download lock is not a private regular file")
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		lock.Close()
		return "", nil, err
	}
	unlock := func() { _ = syscall.Flock(int(lock.Fd()), syscall.LOCK_UN); _ = lock.Close() }
	cache := filepath.Join(root, digest)
	if err := os.Mkdir(cache, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		unlock()
		return "", nil, err
	}
	info, err = os.Lstat(cache)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0o700 {
		unlock()
		return "", nil, errors.New("bridge cache is not a private directory")
	}
	// The digest is encoded in an empty marker's name. Creating that file is a
	// single atomic operation: a killed writer cannot leave a partial marker.
	marker := filepath.Join(cache, "cache-owner-"+digest)
	raw, err := readBridgeRegular(marker, 1)
	if errors.Is(err, os.ErrNotExist) {
		entries, readErr := os.ReadDir(cache)
		if readErr != nil || len(entries) != 0 {
			unlock()
			return "", nil, errors.New("unfamiliar bridge cache without ownership marker")
		}
		markerFile, createErr := os.OpenFile(marker, os.O_CREATE|os.O_EXCL|os.O_WRONLY|syscall.O_NOFOLLOW, 0o600)
		if createErr != nil {
			unlock()
			return "", nil, createErr
		}
		if err := markerFile.Close(); err != nil {
			unlock()
			return "", nil, err
		}
		if err := syncDirectory(cache); err != nil {
			unlock()
			return "", nil, err
		}
	} else if err != nil || len(raw) != 0 {
		unlock()
		return "", nil, errors.New("bridge cache ownership marker mismatch")
	}
	return cache, unlock, nil
}
