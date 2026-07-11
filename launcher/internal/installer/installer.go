// Package installer acquires and activates immutable JobCtrl releases. It has
// no application-domain dependencies: its only authority is the signed release
// descriptor, the shared native payload verifier, and a user-owned store.
package installer

import (
	"archive/zip"
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
)

const (
	DefaultReleaseURL   = "https://releases.jobctrl.dev/v1/stable/darwin-arm64.json"
	maxDescriptorBytes  = 1 << 20
	maxSignatureBytes   = 16 << 10
	maxArchiveBytes     = int64(4 << 30)
	maxExtractedBytes   = uint64(8 << 30)
	maxZipEntries       = 100000
	maxZipFileBytes     = uint64(2 << 30)
	maxCompressionRatio = uint64(100)
)

var (
	sha256Pattern  = regexp.MustCompile(`^[a-f0-9]{64}$`)
	buildIDPattern = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$`)
	semverPattern  = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`)
)

type Descriptor struct {
	SchemaVersion int    `json:"schemaVersion"`
	Channel       string `json:"channel"`
	Sequence      uint64 `json:"sequence"`
	BuildID       string `json:"buildId"`
	AppVersion    string `json:"appVersion"`
	Platform      struct {
		ID   string `json:"id"`
		OS   string `json:"os"`
		Arch string `json:"arch"`
	} `json:"platform"`
	Artifact struct {
		URL            string `json:"url"`
		SHA256         string `json:"sha256"`
		SizeBytes      int64  `json:"sizeBytes"`
		ArchiveType    string `json:"archiveType"`
		ManifestSHA256 string `json:"manifestSha256"`
	} `json:"artifact"`
}

type descriptorSignature struct {
	SchemaVersion int     `json:"schemaVersion"`
	Status        string  `json:"status"`
	Algorithm     string  `json:"algorithm"`
	KeyID         string  `json:"keyId"`
	Signature     *string `json:"signature"`
}

type Receipt struct {
	SchemaVersion    int    `json:"schemaVersion"`
	BuildID          string `json:"buildId"`
	Channel          string `json:"channel"`
	Sequence         uint64 `json:"sequence"`
	ArtifactSHA256   string `json:"artifactSha256"`
	ManifestSHA256   string `json:"manifestSha256"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	DescriptorURL    string `json:"descriptorUrl"`
	InstalledAt      string `json:"installedAt"`
}

type Options struct {
	Home               string
	ReleaseURL         string
	Trust              map[string]ed25519.PublicKey
	Policy             launcher.AcquisitionPolicy
	HTTPClient         *http.Client
	AllowHTTPLoopback  bool
	AllowUnsignedLocal bool
	// RunCommand is a test seam for macOS code-signing/notarization checks.
	// Production leaves it nil and executes the system tools by absolute path.
	RunCommand func(string, ...string) (string, error)
}

// InstallFromNetwork performs the stable network path. Its caller must supply
// a release key (normally embedded at P6); unsigned-local is never accepted.
func InstallFromNetwork(options Options) (Receipt, error) {
	if !options.Policy.AllowNetwork {
		return Receipt{}, errors.New("network acquisition is unavailable in this compiled installer build")
	}
	if options.AllowUnsignedLocal {
		return Receipt{}, errors.New("unsigned-local mode is restricted to local descriptor and archive files")
	}
	if options.ReleaseURL == "" {
		options.ReleaseURL = DefaultReleaseURL
	}
	releaseURL, err := validateTransportURL(options.ReleaseURL, options.AllowHTTPLoopback)
	if err != nil {
		return Receipt{}, fmt.Errorf("release descriptor URL: %w", err)
	}
	client := options.HTTPClient
	if client == nil {
		client = strictHTTPClient()
	}
	descriptorBytes, err := fetchBounded(client, releaseURL.String(), maxDescriptorBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("download release descriptor: %w", err)
	}
	signatureBytes, err := fetchBounded(client, releaseURL.String()+".sig", maxSignatureBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("download release descriptor signature: %w", err)
	}
	descriptor, err := verifyDescriptor(descriptorBytes, signatureBytes, options.Trust, false, releaseURL, options.AllowHTTPLoopback)
	if err != nil {
		return Receipt{}, err
	}
	if descriptor.Channel != options.Policy.ExpectedChannel {
		return Receipt{}, fmt.Errorf("release channel %q does not match compiled installer channel %q", descriptor.Channel, options.Policy.ExpectedChannel)
	}
	return downloadAndInstall(options, descriptor, descriptorBytes, releaseURL.String(), client)
}

// InstallFromLocalFiles is the only unsigned-local route. It is intentionally
// file-only: no HTTP request or stable descriptor can cross this boundary.
func InstallFromLocalFiles(options Options, descriptorPath, signaturePath, archivePath string) (Receipt, error) {
	if !options.Policy.AllowUnsignedLocal || options.Policy.ExpectedChannel != "local" || !options.AllowUnsignedLocal {
		return Receipt{}, errors.New("local fixture mode requires --allow-unsigned-local")
	}
	if descriptorPath == "" || signaturePath == "" || archivePath == "" {
		return Receipt{}, errors.New("local fixture mode requires descriptor, signature, and archive files")
	}
	descriptorBytes, err := readBoundedFile(descriptorPath, maxDescriptorBytes)
	if err != nil {
		return Receipt{}, err
	}
	signatureBytes, err := readBoundedFile(signaturePath, maxSignatureBytes)
	if err != nil {
		return Receipt{}, err
	}
	descriptor, err := verifyDescriptor(descriptorBytes, signatureBytes, options.Trust, true, nil, false)
	if err != nil {
		return Receipt{}, err
	}
	return installArchive(options, descriptor, descriptorBytes, "local-fixture", archivePath)
}

// InstallFromCachedFiles is the signed counterpart used by package managers.
// Homebrew may already possess the immutable ZIP, but it cannot turn that
// cache into an unsigned installation: the supplied descriptor URL remains a
// canonical HTTPS origin and its exact file bytes are authenticated before the
// cache is examined.
func InstallFromCachedFiles(options Options, descriptorURL, descriptorPath, signaturePath, archivePath string) (Receipt, error) {
	if !options.Policy.AllowNetwork {
		return Receipt{}, errors.New("signed cached acquisition is unavailable in this compiled installer build")
	}
	if options.AllowUnsignedLocal {
		return Receipt{}, errors.New("signed cached installation cannot enable unsigned-local mode")
	}
	sourceURL, err := validateTransportURL(descriptorURL, false)
	if err != nil {
		return Receipt{}, fmt.Errorf("cached release descriptor URL: %w", err)
	}
	descriptorBytes, err := readBoundedFile(descriptorPath, maxDescriptorBytes)
	if err != nil {
		return Receipt{}, err
	}
	signatureBytes, err := readBoundedFile(signaturePath, maxSignatureBytes)
	if err != nil {
		return Receipt{}, err
	}
	descriptor, err := verifyDescriptor(descriptorBytes, signatureBytes, options.Trust, false, sourceURL, false)
	if err != nil {
		return Receipt{}, err
	}
	if descriptor.Channel != options.Policy.ExpectedChannel {
		return Receipt{}, fmt.Errorf("release channel %q does not match compiled installer channel %q", descriptor.Channel, options.Policy.ExpectedChannel)
	}
	return installArchive(options, descriptor, descriptorBytes, sourceURL.String(), archivePath)
}

func strictHTTPClient() *http.Client {
	return &http.Client{
		Timeout: 45 * time.Second,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("redirects are forbidden for release acquisition")
		},
	}
}

func fetchBounded(client *http.Client, rawURL string, maximum int64) ([]byte, error) {
	response, err := client.Get(rawURL)
	if err != nil {
		return nil, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("unexpected HTTP status %s", response.Status)
	}
	if response.ContentLength < 0 || response.ContentLength > maximum {
		return nil, fmt.Errorf("response size %d exceeds safe limit %d", response.ContentLength, maximum)
	}
	limited := io.LimitReader(response.Body, maximum+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maximum {
		return nil, fmt.Errorf("response body exceeds safe limit %d", maximum)
	}
	return body, nil
}

func validateTransportURL(rawURL string, allowHTTPLoopback bool) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed == nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" {
		return nil, errors.New("must be an absolute URL without credentials or fragments")
	}
	if parsed.Scheme == "https" {
		return parsed, nil
	}
	if parsed.Scheme == "http" && allowHTTPLoopback && isLoopbackHost(parsed.Hostname()) {
		return parsed, nil
	}
	return nil, errors.New("must use HTTPS (HTTP is permitted only for explicit loopback tests)")
}

func isLoopbackHost(host string) bool {
	if strings.EqualFold(host, "localhost") {
		return true
	}
	parsed := net.ParseIP(host)
	return parsed != nil && parsed.IsLoopback()
}

func decodeStrict(raw []byte, label string, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode %s: %w", label, err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("decode %s: trailing JSON value", label)
	}
	return nil
}

func verifyDescriptor(raw, signatureRaw []byte, trust map[string]ed25519.PublicKey, allowUnsignedLocal bool, sourceURL *url.URL, allowHTTPLoopback bool) (Descriptor, error) {
	var descriptor Descriptor
	if err := decodeStrict(raw, "release descriptor", &descriptor); err != nil {
		return descriptor, err
	}
	var signature descriptorSignature
	if err := decodeStrict(signatureRaw, "release descriptor signature", &signature); err != nil {
		return descriptor, err
	}
	if descriptor.SchemaVersion != 1 || descriptor.Sequence == 0 || !buildIDPattern.MatchString(descriptor.BuildID) || !semverPattern.MatchString(descriptor.AppVersion) || descriptor.Platform.ID != "darwin-arm64" || descriptor.Platform.OS != "darwin" || descriptor.Platform.Arch != "arm64" {
		return descriptor, errors.New("invalid release descriptor identity")
	}
	if descriptor.Channel != "local" && descriptor.Channel != "stable" && descriptor.Channel != "prerelease" {
		return descriptor, errors.New("invalid release descriptor channel")
	}
	if descriptor.Artifact.ArchiveType != "zip" || !sha256Pattern.MatchString(descriptor.Artifact.SHA256) || !sha256Pattern.MatchString(descriptor.Artifact.ManifestSHA256) || descriptor.Artifact.SizeBytes <= 0 || descriptor.Artifact.SizeBytes > maxArchiveBytes {
		return descriptor, errors.New("invalid release artifact contract")
	}
	if signature.SchemaVersion != 1 || signature.Algorithm != "ed25519" || signature.KeyID == "" {
		return descriptor, errors.New("invalid release descriptor signature envelope")
	}
	if descriptor.Channel == "local" {
		if !allowUnsignedLocal || sourceURL != nil || signature.Status != "unsigned-local" || signature.KeyID != "local-development" || signature.Signature != nil {
			return descriptor, errors.New("unsigned-local descriptor is restricted to explicit local fixture mode")
		}
		return descriptor, nil
	}
	if sourceURL == nil || signature.Status != "signed" || signature.Signature == nil {
		return descriptor, errors.New("network release descriptor must have a detached Ed25519 signature")
	}
	artifactURL, err := validateTransportURL(descriptor.Artifact.URL, allowHTTPLoopback)
	if err != nil {
		return descriptor, fmt.Errorf("artifact URL: %w", err)
	}
	if !strings.EqualFold(artifactURL.Host, sourceURL.Host) || artifactURL.Scheme != sourceURL.Scheme {
		return descriptor, errors.New("artifact URL must stay on the authenticated release origin")
	}
	key, exists := trust[signature.KeyID]
	if !exists || len(key) != ed25519.PublicKeySize {
		return descriptor, fmt.Errorf("no trusted Ed25519 release key for key id %q", signature.KeyID)
	}
	encoded, err := base64.StdEncoding.DecodeString(*signature.Signature)
	if err != nil || len(encoded) != ed25519.SignatureSize || !ed25519.Verify(key, signingMessage("jobctrl:release-descriptor:v1\x00", raw), encoded) {
		return descriptor, errors.New("release descriptor Ed25519 signature verification failed")
	}
	return descriptor, nil
}

func downloadAndInstall(options Options, descriptor Descriptor, descriptorBytes []byte, descriptorURL string, client *http.Client) (Receipt, error) {
	artifactURL, _ := url.Parse(descriptor.Artifact.URL)
	archivePath, err := downloadArchive(client, artifactURL.String(), descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256)
	if err != nil {
		return Receipt{}, fmt.Errorf("download release archive: %w", err)
	}
	defer os.Remove(archivePath)
	return installArchive(options, descriptor, descriptorBytes, descriptorURL, archivePath)
}

// downloadArchive streams an archive to disk while hashing it. A release may
// be hundreds of MiB; keeping it in memory would turn a valid signed download
// into an avoidable denial-of-service vector.
func downloadArchive(client *http.Client, rawURL string, expectedSize int64, expectedSHA256 string) (string, error) {
	response, err := client.Get(rawURL)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return "", fmt.Errorf("unexpected HTTP status %s", response.Status)
	}
	if response.ContentLength != expectedSize {
		return "", fmt.Errorf("archive content length mismatch: expected %d, received %d", expectedSize, response.ContentLength)
	}
	cache, err := os.CreateTemp("", "jobctrl-release-*.zip")
	if err != nil {
		return "", err
	}
	path := cache.Name()
	hash := sha256.New()
	written, copyErr := io.Copy(io.MultiWriter(cache, hash), io.LimitReader(response.Body, expectedSize+1))
	if copyErr != nil || written != expectedSize || hex.EncodeToString(hash.Sum(nil)) != expectedSHA256 {
		cache.Close()
		os.Remove(path)
		if copyErr != nil {
			return "", copyErr
		}
		return "", errors.New("archive size or SHA-256 does not match signed release descriptor")
	}
	if err := cache.Sync(); err != nil {
		cache.Close()
		os.Remove(path)
		return "", err
	}
	if err := cache.Close(); err != nil {
		os.Remove(path)
		return "", err
	}
	return path, nil
}

func installArchive(options Options, descriptor Descriptor, descriptorBytes []byte, descriptorURL, archivePath string) (Receipt, error) {
	if info, err := os.Lstat(archivePath); err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return Receipt{}, errors.New("release archive must be a regular non-symlink file")
	} else if info.Size() != descriptor.Artifact.SizeBytes {
		return Receipt{}, fmt.Errorf("archive size mismatch: expected %d, received %d", descriptor.Artifact.SizeBytes, info.Size())
	}
	if digest, err := digestFile(archivePath); err != nil || digest != descriptor.Artifact.SHA256 {
		if err != nil {
			return Receipt{}, err
		}
		return Receipt{}, errors.New("archive SHA-256 does not match release descriptor")
	}
	home, err := runtimeHome(options.Home)
	if err != nil {
		return Receipt{}, err
	}
	store, err := openStore(home)
	if err != nil {
		return Receipt{}, err
	}
	defer store.Close()
	if err := store.cleanupStaging(); err != nil {
		return Receipt{}, err
	}
	stage, err := os.MkdirTemp(filepath.Join(store.home, "staging"), "stage-")
	if err != nil {
		return Receipt{}, err
	}
	defer os.RemoveAll(stage)
	payload := filepath.Join(stage, "payload")
	if err := extractZIP(archivePath, payload); err != nil {
		return Receipt{}, err
	}
	trust := launcher.DistributionTrust{PublicKeys: options.Trust, AllowUnsignedLocal: options.AllowUnsignedLocal, ExpectedChannel: descriptor.Channel}
	manifest, err := launcher.VerifyDistributionPayload(payload, trust)
	if err != nil {
		return Receipt{}, fmt.Errorf("verify extracted payload: %w", err)
	}
	manifestRaw, err := os.ReadFile(filepath.Join(payload, "manifest.json"))
	if err != nil {
		return Receipt{}, err
	}
	manifestDigest := digestBytes(manifestRaw)
	if manifest.BuildID != descriptor.BuildID || manifest.AppVersion != descriptor.AppVersion || manifest.Platform.ID != descriptor.Platform.ID || manifestDigest != descriptor.Artifact.ManifestSHA256 {
		return Receipt{}, errors.New("archive, manifest, and release descriptor identities do not agree")
	}
	if descriptor.Channel != "local" {
		if err := verifyMacOSPayloadTrust(payload, options.RunCommand); err != nil {
			return Receipt{}, err
		}
	}
	receipt := Receipt{1, descriptor.BuildID, descriptor.Channel, descriptor.Sequence, descriptor.Artifact.SHA256, manifestDigest, digestBytes(descriptorBytes), descriptorURL, time.Now().UTC().Format(time.RFC3339Nano)}
	receiptBytes, err := encodeJSON(receipt)
	if err != nil {
		return Receipt{}, err
	}
	if err := syncDirectory(payload); err != nil {
		return Receipt{}, err
	}
	if err := syncDirectory(stage); err != nil {
		return Receipt{}, err
	}
	releasePath := filepath.Join(store.home, "releases", descriptor.BuildID)
	if _, err := os.Lstat(releasePath); err == nil {
		if info, statErr := os.Lstat(releasePath); statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return Receipt{}, errors.New("existing release path is not a regular directory")
		}
		immutableReceipt, immutableBytes, err := verifyInstalledRelease(releasePath, descriptor, trust, receipt)
		if err != nil {
			return Receipt{}, fmt.Errorf("existing release %q is not idempotent-safe: %w", descriptor.BuildID, err)
		}
		receipt, receiptBytes = immutableReceipt, immutableBytes
	} else if !errors.Is(err, os.ErrNotExist) {
		return Receipt{}, err
	} else {
		if err := writeBytesAtomic(filepath.Join(stage, "receipt.json"), receiptBytes, 0o600); err != nil {
			return Receipt{}, err
		}
		if err := syncDirectory(stage); err != nil {
			return Receipt{}, err
		}
		if err := os.Rename(stage, releasePath); err != nil {
			return Receipt{}, fmt.Errorf("activate immutable release: %w", err)
		}
		if err := syncDirectory(filepath.Join(store.home, "releases")); err != nil {
			return Receipt{}, err
		}
	}
	if err := installPublicSelector(store.home, releasePath, descriptor.Channel); err != nil {
		return Receipt{}, err
	}
	if err := writeBytesAtomic(filepath.Join(store.home, "current.json"), receiptBytes, 0o600); err != nil {
		return Receipt{}, err
	}
	return receipt, nil
}

// installPublicSelector copies the already-authenticated native launcher into
// the release store's stable bin location. That binary then reads current.json
// and re-enters the immutable payload; curl and Homebrew therefore execute the
// exact same verified release rather than a Cellar-owned runtime.
func installPublicSelector(home, releasePath, channel string) error {
	source := filepath.Join(releasePath, "payload", "launcher", "jobctrl")
	info, err := os.Lstat(source)
	if err != nil {
		if channel == "local" && errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return errors.New("release payload does not contain launcher/jobctrl for the public selector")
	}
	if !info.Mode().IsRegular() || info.Mode()&0o111 == 0 {
		return errors.New("release launcher/jobctrl is not an executable regular file")
	}
	bin := filepath.Join(home, "bin")
	if err := ensureManagedDirectory(bin); err != nil {
		return err
	}
	temporary, err := os.CreateTemp(bin, ".jobctrl-")
	if err != nil {
		return err
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	input, err := os.Open(source)
	if err != nil {
		temporary.Close()
		return err
	}
	if _, err := io.Copy(temporary, input); err != nil {
		input.Close()
		temporary.Close()
		return err
	}
	if err := input.Close(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Chmod(info.Mode().Perm()); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Sync(); err != nil {
		temporary.Close()
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Rename(temporaryPath, filepath.Join(bin, "jobctrl")); err != nil {
		return err
	}
	return syncDirectory(bin)
}

func runtimeHome(explicit string) (string, error) {
	if explicit != "" {
		return filepath.Abs(explicit)
	}
	if home := os.Getenv("JOBCTRL_RUNTIME_HOME"); home != "" {
		return filepath.Abs(home)
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, "Library", "Application Support", "JobCtrl"), nil
}

type store struct {
	home string
	lock *os.File
}

func openStore(home string) (*store, error) {
	if err := ensureManagedDirectory(home); err != nil {
		return nil, err
	}
	for _, name := range []string{"staging", "releases"} {
		if err := ensureManagedDirectory(filepath.Join(home, name)); err != nil {
			return nil, err
		}
	}
	lockPath := filepath.Join(home, "install.lock")
	if info, err := os.Lstat(lockPath); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return nil, errors.New("release store lock is not a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return nil, err
	}
	lock, err := os.OpenFile(lockPath, os.O_CREATE|os.O_RDWR|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return nil, err
	}
	if err := syscall.Flock(int(lock.Fd()), syscall.LOCK_EX); err != nil {
		lock.Close()
		return nil, fmt.Errorf("lock release store: %w", err)
	}
	return &store{home, lock}, nil
}

func ensureManagedDirectory(path string) error {
	if info, err := os.Lstat(path); err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("managed path %q is not a regular directory", path)
		}
		return os.Chmod(path, 0o700)
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	if err := os.Mkdir(path, 0o700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("managed path %q is not a regular directory", path)
	}
	return os.Chmod(path, 0o700)
}
func (s *store) Close() error {
	defer s.lock.Close()
	return syscall.Flock(int(s.lock.Fd()), syscall.LOCK_UN)
}
func (s *store) cleanupStaging() error {
	entries, err := os.ReadDir(filepath.Join(s.home, "staging"))
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if !strings.HasPrefix(entry.Name(), "stage-") {
			continue
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlinked staging entry %q", entry.Name())
		}
		if !entry.IsDir() {
			return fmt.Errorf("invalid staging entry %q", entry.Name())
		}
		if err := os.RemoveAll(filepath.Join(s.home, "staging", entry.Name())); err != nil {
			return err
		}
	}
	return syncDirectory(filepath.Join(s.home, "staging"))
}

func verifyInstalledRelease(releasePath string, descriptor Descriptor, trust launcher.DistributionTrust, expected Receipt) (Receipt, []byte, error) {
	var receipt Receipt
	info, err := os.Lstat(releasePath)
	if err != nil {
		return receipt, nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return receipt, nil, errors.New("release path is not a regular directory")
	}
	manifest, err := launcher.VerifyDistributionPayload(filepath.Join(releasePath, "payload"), trust)
	if err != nil {
		return receipt, nil, err
	}
	if manifest.BuildID != descriptor.BuildID || manifest.AppVersion != descriptor.AppVersion {
		return receipt, nil, errors.New("payload identity differs from descriptor")
	}
	receiptPath := filepath.Join(releasePath, "receipt.json")
	if info, err := os.Lstat(receiptPath); err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return receipt, nil, errors.New("release receipt is not a regular file")
	}
	raw, err := os.ReadFile(receiptPath)
	if err != nil {
		return receipt, nil, err
	}
	if err := decodeStrict(raw, "release receipt", &receipt); err != nil {
		return receipt, nil, err
	}
	if receipt.SchemaVersion != expected.SchemaVersion || receipt.BuildID != expected.BuildID || receipt.Channel != expected.Channel || receipt.Sequence != expected.Sequence || receipt.ArtifactSHA256 != expected.ArtifactSHA256 || receipt.ManifestSHA256 != expected.ManifestSHA256 || receipt.DescriptorSHA256 != expected.DescriptorSHA256 || receipt.DescriptorURL != expected.DescriptorURL || receipt.InstalledAt == "" {
		return receipt, nil, errors.New("release receipt does not match descriptor identity")
	}
	return receipt, raw, nil
}

func extractZIP(archivePath, destination string) error {
	reader, err := zip.OpenReader(archivePath)
	if err != nil {
		return fmt.Errorf("open ZIP: %w", err)
	}
	defer reader.Close()
	if len(reader.File) == 0 || len(reader.File) > maxZipEntries {
		return errors.New("ZIP entry count exceeds safe limit")
	}
	type entry struct {
		file      *zip.File
		relative  string
		directory bool
		symlink   bool
		target    string
	}
	entries := make([]entry, 0, len(reader.File))
	seen := map[string]string{}
	var total uint64
	for _, file := range reader.File {
		relative, directory, err := safeZIPPath(file.Name)
		if err != nil {
			return err
		}
		if prior, exists := seen[strings.ToLower(relative)]; exists {
			return fmt.Errorf("ZIP entry %q collides with %q on a case-insensitive filesystem", file.Name, prior)
		}
		seen[strings.ToLower(relative)] = file.Name
		mode := file.Mode()
		symlink := mode&os.ModeSymlink != 0
		if (!symlink && !mode.IsRegular() && !directory) || mode&(os.ModeDevice|os.ModeNamedPipe|os.ModeSocket|os.ModeIrregular|os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
			return fmt.Errorf("ZIP entry %q has an unsupported link, special file, or mode", file.Name)
		}
		if directory {
			entries = append(entries, entry{file: file, relative: relative, directory: true})
			continue
		}
		if file.UncompressedSize64 > maxZipFileBytes || file.UncompressedSize64 > maxExtractedBytes-total {
			return fmt.Errorf("ZIP entry %q exceeds extraction size limit", file.Name)
		}
		if file.UncompressedSize64 > 0 && (file.CompressedSize64 == 0 || file.UncompressedSize64/file.CompressedSize64 > maxCompressionRatio) {
			return fmt.Errorf("ZIP entry %q exceeds compression ratio limit", file.Name)
		}
		total += file.UncompressedSize64
		item := entry{file: file, relative: relative, symlink: symlink}
		if symlink {
			input, err := file.Open()
			if err != nil {
				return err
			}
			targetBytes, readErr := io.ReadAll(io.LimitReader(input, 4097))
			closeErr := input.Close()
			if readErr != nil || closeErr != nil || len(targetBytes) > 4096 {
				return fmt.Errorf("ZIP symlink %q has an unsafe target", file.Name)
			}
			item.target = string(targetBytes)
			if err := safeZIPSymlinkTarget(relative, item.target); err != nil {
				return err
			}
		}
		entries = append(entries, item)
	}
	if err := os.MkdirAll(destination, 0o700); err != nil {
		return err
	}
	for _, item := range entries {
		target := filepath.Join(destination, filepath.FromSlash(item.relative))
		if item.directory {
			if err := os.MkdirAll(target, 0o700); err != nil {
				return err
			}
			continue
		}
		if item.symlink {
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		input, err := item.file.Open()
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, item.file.Mode().Perm())
		if err != nil {
			input.Close()
			return err
		}
		written, copyErr := io.Copy(output, io.LimitReader(input, int64(item.file.UncompressedSize64)+1))
		closeInErr := input.Close()
		if copyErr != nil || closeInErr != nil || written != int64(item.file.UncompressedSize64) {
			output.Close()
			return fmt.Errorf("extract ZIP entry %q: size or stream mismatch", item.file.Name)
		}
		if err := output.Sync(); err != nil {
			output.Close()
			return err
		}
		if err := output.Close(); err != nil {
			return err
		}
	}
	for _, item := range entries {
		if !item.symlink {
			continue
		}
		target := filepath.Join(destination, filepath.FromSlash(item.relative))
		if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
			return err
		}
		if err := os.Symlink(item.target, target); err != nil {
			return fmt.Errorf("extract ZIP symlink %q: %w", item.file.Name, err)
		}
	}
	return syncDirectory(destination)
}

func safeZIPPath(name string) (string, bool, error) {
	if name == "" || strings.Contains(name, "\\") || strings.HasPrefix(name, "/") || !printableASCII(name) {
		return "", false, fmt.Errorf("unsafe ZIP entry path %q", name)
	}
	directory := strings.HasSuffix(name, "/")
	trimmed := strings.TrimSuffix(name, "/")
	if trimmed == "" || pathpkg.Clean(trimmed) != trimmed || trimmed == "." || trimmed == ".." || strings.HasPrefix(trimmed, "../") {
		return "", false, fmt.Errorf("unsafe ZIP entry path %q", name)
	}
	return trimmed, directory, nil
}
func safeZIPSymlinkTarget(relative, target string) error {
	if target == "" || strings.Contains(target, "\\") || strings.HasPrefix(target, "/") || !printableASCII(target) {
		return fmt.Errorf("ZIP symlink %q has an unsafe target", relative)
	}
	resolved := pathpkg.Clean(pathpkg.Join(pathpkg.Dir(relative), target))
	if resolved == "." || resolved == ".." || strings.HasPrefix(resolved, "../") {
		return fmt.Errorf("ZIP symlink %q escapes payload root", relative)
	}
	return nil
}
func printableASCII(value string) bool {
	for index := 0; index < len(value); index++ {
		if value[index] < 0x20 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func readBoundedFile(filePath string, maximum int64) ([]byte, error) {
	info, err := os.Lstat(filePath)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > maximum {
		return nil, errors.New("fixture file is not a safely bounded regular file")
	}
	return os.ReadFile(filePath)
}
func digestBytes(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
func digestFile(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}
func encodeJSON(value any) ([]byte, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	encoded = append(encoded, '\n')
	return encoded, nil
}
func writeBytesAtomic(path string, encoded []byte, mode os.FileMode) error {
	random := make([]byte, 8)
	if _, err := rand.Read(random); err != nil {
		return err
	}
	temp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+hex.EncodeToString(random))
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(encoded); err != nil {
		file.Close()
		os.Remove(temp)
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		os.Remove(temp)
		return err
	}
	if err := file.Close(); err != nil {
		os.Remove(temp)
		return err
	}
	if err := os.Rename(temp, path); err != nil {
		os.Remove(temp)
		return err
	}
	return syncDirectory(filepath.Dir(path))
}
func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func signingMessage(domain string, raw []byte) []byte {
	message := make([]byte, len(domain)+len(raw))
	copy(message, domain)
	copy(message[len(domain):], raw)
	return message
}

func verifyMacOSPayloadTrust(payloadRoot string, runner func(string, ...string) (string, error)) error {
	launcherPath := filepath.Join(payloadRoot, "launcher", "jobctrl")
	if info, err := os.Lstat(launcherPath); err != nil || !info.Mode().IsRegular() {
		return errors.New("signed payload does not contain a regular launcher/jobctrl executable")
	}
	if runner == nil {
		runner = func(path string, args ...string) (string, error) {
			output, err := exec.Command(path, args...).CombinedOutput()
			return string(output), err
		}
	}
	targets := []string{launcherPath}
	err := filepath.WalkDir(payloadRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == payloadRoot || !entry.IsDir() {
			return nil
		}
		if strings.Contains(strings.ToLower(entry.Name()), "chrom") && strings.HasSuffix(entry.Name(), ".app") {
			targets = append(targets, path)
			return filepath.SkipDir
		}
		return nil
	})
	if err != nil {
		return err
	}
	for _, target := range targets {
		if _, err := runner("/usr/bin/codesign", "--verify", "--deep", "--strict", "--check-notarization", "-R=notarized", target); err != nil {
			return fmt.Errorf("Developer ID/notarization verification failed for %s: %w", filepath.Base(target), err)
		}
		output, err := runner("/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", target)
		if err != nil {
			return fmt.Errorf("Gatekeeper assessment failed for %s: %w", filepath.Base(target), err)
		}
		if !strings.Contains(output, "source=Notarized Developer ID") {
			return fmt.Errorf("Gatekeeper did not report Notarized Developer ID source for %s", filepath.Base(target))
		}
	}
	return nil
}
