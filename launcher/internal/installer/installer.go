// Package installer acquires and activates immutable JobCtrl releases. It has
// no application-domain dependencies: its only authority is the signed release
// descriptor, the shared native payload verifier, and a user-owned store.
package installer

import (
	"archive/zip"
	"bytes"
	"context"
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
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
	"github.com/ebarti/jobctrl/launcher/internal/release"
)

const (
	canonicalReleaseOrigin = "https://releases.jobctrl.dev"
	canonicalReleaseHost   = "releases.jobctrl.dev"
	maxDescriptorBytes     = 1 << 20
	maxSignatureBytes      = 16 << 10
	maxArchiveBytes        = int64(4 << 30)
	maxExtractedBytes      = uint64(8 << 30)
	maxZipEntries          = 100000
	maxZipFileBytes        = uint64(2 << 30)
	maxCompressionRatio    = uint64(100)
	metadataTimeout        = 45 * time.Second
	archiveStallTimeout    = 60 * time.Second
	maxJSONSafeInteger     = uint64(1<<53 - 1)
	stagedArchiveName      = "archive.zip"
	partialArchiveName     = "archive.zip.part"
)

var (
	sha256Pattern       = regexp.MustCompile(`^[a-f0-9]{64}$`)
	buildIDPattern      = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$`)
	semverPattern       = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`)
	gitCommitPattern    = regexp.MustCompile(`^[a-f0-9]{40}$`)
	contentRangePattern = regexp.MustCompile(`^bytes ([0-9]+)-([0-9]+)/([0-9]+)$`)
)

type Descriptor struct {
	SchemaVersion int    `json:"schemaVersion"`
	Channel       string `json:"channel"`
	Sequence      uint64 `json:"sequence"`
	// MinimumSafeSequence and RevokedBuildIDs are signed channel tombstones.
	// They are optional for local fixtures, but non-local channels persist and
	// enforce them as a monotonic security boundary.
	MinimumSafeSequence uint64   `json:"minimumSafeSequence"`
	RevokedBuildIDs     []string `json:"revokedBuildIds"`
	BuildID             string   `json:"buildId"`
	AppVersion          string   `json:"appVersion"`
	// SourceCommit is signed network-release provenance. Local fixtures remain
	// intentionally portable and omit it.
	SourceCommit string `json:"sourceCommit,omitempty"`
	Platform     struct {
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

// channelPointer is the sole mutable release object. It is deliberately not
// signed: its authority is limited to selecting two immutable byte strings
// whose SHA-256 values it carries. The descriptor remains the actual release
// trust root because its detached Ed25519 signature is checked after both
// pointer hashes have been verified.
type channelPointer struct {
	SchemaVersion int    `json:"schemaVersion"`
	Channel       string `json:"channel"`
	Platform      struct {
		ID   string `json:"id"`
		OS   string `json:"os"`
		Arch string `json:"arch"`
	} `json:"platform"`
	SourceCommit string       `json:"sourceCommit"`
	BuildID      string       `json:"buildId"`
	Sequence     uint64       `json:"sequence"`
	Descriptor   pointerAsset `json:"descriptor"`
	Signature    pointerAsset `json:"signature"`
}

type pointerAsset struct {
	URL    string `json:"url"`
	SHA256 string `json:"sha256"`
}

type Receipt struct {
	SchemaVersion    int    `json:"schemaVersion"`
	BuildID          string `json:"buildId"`
	Channel          string `json:"channel"`
	Sequence         uint64 `json:"sequence"`
	ArtifactSHA256   string `json:"artifactSha256"`
	ManifestSHA256   string `json:"manifestSha256"`
	DescriptorSHA256 string `json:"descriptorSha256"`
	PolicySHA256     string `json:"policySha256"`
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
	// AcquisitionSource is a short adapter identifier (curl, homebrew, or
	// local-fixture), not a filesystem path. It is persisted in active.json,
	// never in immutable release receipt.json.
	AcquisitionSource string
	// StageOnly commits an authenticated immutable release but leaves active
	// selection untouched. The launcher uses it for Homebrew's first-invocation
	// bootstrap before running the shared health-gated promoter.
	StageOnly bool
	// RunCommand is a test seam for macOS code-signing/notarization checks.
	// Production leaves it nil and executes the system tools by absolute path.
	RunCommand func(string, ...string) (string, error)
}

// InstallFromNetwork resolves exactly one mutable channel pointer, then
// downloads its immutable descriptor/signature pair. Its caller must supply a
// release key (normally embedded at P6); unsigned-local is never accepted.
func InstallFromNetwork(options Options) (Receipt, error) {
	if !options.Policy.AllowNetwork {
		return Receipt{}, errors.New("network acquisition is unavailable in this compiled installer build")
	}
	if options.AllowUnsignedLocal {
		return Receipt{}, errors.New("unsigned-local mode is restricted to local descriptor and archive files")
	}
	client := options.HTTPClient
	if client == nil {
		client = strictHTTPClient()
	}
	descriptor, descriptorBytes, descriptorURL, err := resolveNetworkRelease(options, client)
	if err != nil {
		return Receipt{}, err
	}
	return downloadAndInstall(options, descriptor, descriptorBytes, descriptorURL, archiveHTTPClient(client))
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
	sourceURL, expectedBuildID, err := validateImmutableDescriptorURL(descriptorURL)
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
	if err := validateCanonicalArtifactURL(descriptor, sourceURL); err != nil {
		return Receipt{}, err
	}
	if descriptor.BuildID != expectedBuildID {
		return Receipt{}, errors.New("cached immutable descriptor URL does not match descriptor build identity")
	}
	if descriptor.Channel != options.Policy.ExpectedChannel {
		return Receipt{}, fmt.Errorf("release channel %q does not match compiled installer channel %q", descriptor.Channel, options.Policy.ExpectedChannel)
	}
	return installArchive(options, descriptor, descriptorBytes, sourceURL.String(), archivePath)
}

// DefaultReleaseURL returns the exact mutable channel-pointer URL compiled
// into a signed installer. It is intentionally channel-derived rather than a
// stable constant: a prerelease installer must never silently follow stable.
func DefaultReleaseURL(channel string) (string, error) {
	if channel != "stable" && channel != "prerelease" {
		return "", fmt.Errorf("invalid network release channel %q", channel)
	}
	return fmt.Sprintf("%s/v1/%s/darwin-arm64.json", canonicalReleaseOrigin, channel), nil
}

func resolveNetworkRelease(options Options, client *http.Client) (Descriptor, []byte, string, error) {
	pointerURLRaw := options.ReleaseURL
	if pointerURLRaw == "" {
		var err error
		pointerURLRaw, err = DefaultReleaseURL(options.Policy.ExpectedChannel)
		if err != nil {
			return Descriptor{}, nil, "", err
		}
	}
	pointerURL, err := validateChannelPointerTransportURL(pointerURLRaw, options.Policy.ExpectedChannel, options.AllowHTTPLoopback)
	if err != nil {
		return Descriptor{}, nil, "", fmt.Errorf("release channel pointer URL: %w", err)
	}
	pointerRaw, err := fetchBounded(client, pointerURL.String(), maxDescriptorBytes)
	if err != nil {
		return Descriptor{}, nil, "", fmt.Errorf("download release channel pointer: %w", err)
	}
	pointer, descriptorURL, signatureURL, err := validateReleaseChannelPointerAtOrigin(pointerRaw, options.Policy.ExpectedChannel, pointerURL)
	if err != nil {
		return Descriptor{}, nil, "", err
	}
	if stagedBuildID, staged := channelPointerStagingBuildID(pointerURL.Path); staged && stagedBuildID != pointer.BuildID {
		return Descriptor{}, nil, "", errors.New("immutable channel pointer URL does not match pointer build identity")
	}
	descriptorBytes, err := fetchBounded(client, descriptorURL.String(), maxDescriptorBytes)
	if err != nil {
		return Descriptor{}, nil, "", fmt.Errorf("download immutable release descriptor: %w", err)
	}
	signatureBytes, err := fetchBounded(client, signatureURL.String(), maxSignatureBytes)
	if err != nil {
		return Descriptor{}, nil, "", fmt.Errorf("download immutable release descriptor signature: %w", err)
	}
	// Compare both immutable byte identities before invoking Ed25519. This
	// keeps a pointer from mixing a descriptor from one release with the
	// signature from another, even if both happen to be individually signed.
	if digestBytes(descriptorBytes) != pointer.Descriptor.SHA256 {
		return Descriptor{}, nil, "", errors.New("immutable release descriptor SHA-256 does not match channel pointer")
	}
	if digestBytes(signatureBytes) != pointer.Signature.SHA256 {
		return Descriptor{}, nil, "", errors.New("immutable release descriptor signature SHA-256 does not match channel pointer")
	}
	descriptor, err := verifyDescriptor(descriptorBytes, signatureBytes, options.Trust, false, descriptorURL, options.AllowHTTPLoopback)
	if err != nil {
		return Descriptor{}, nil, "", err
	}
	if err := validateCanonicalArtifactURL(descriptor, pointerURL); err != nil {
		return Descriptor{}, nil, "", err
	}
	if err := verifyPointerDescriptorIdentity(pointer, descriptor); err != nil {
		return Descriptor{}, nil, "", err
	}
	return descriptor, descriptorBytes, descriptorURL.String(), nil
}

func strictHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.DialContext = (&net.Dialer{Timeout: 15 * time.Second, KeepAlive: 30 * time.Second}).DialContext
	transport.TLSHandshakeTimeout = 15 * time.Second
	transport.ResponseHeaderTimeout = 30 * time.Second
	return &http.Client{
		Transport: transport,
		Timeout:   metadataTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return errors.New("redirects are forbidden for release acquisition")
		},
	}
}

// archiveHTTPClient preserves the authenticated transport and redirect policy
// used for release metadata, but removes its whole-request deadline. Archive
// bodies are bounded by the signed size and hash plus a progress watchdog;
// applying the metadata timeout to hundreds of MiB would reject healthy slow
// connections.
func archiveHTTPClient(metadata *http.Client) *http.Client {
	archive := *metadata
	archive.Timeout = 0
	return &archive
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

// validateChannelPointerURL permits only the one mutable selector path for
// the compiled channel. In particular it rejects a direct descriptor URL, so
// curl cannot opt out of the atomic descriptor/signature binding.
func validateChannelPointerURL(rawURL, channel string) (*url.URL, error) {
	if channel != "stable" && channel != "prerelease" {
		return nil, fmt.Errorf("invalid network release channel %q", channel)
	}
	parsed, err := parseCanonicalReleaseURL(rawURL)
	if err != nil {
		return nil, err
	}
	if _, err := validateChannelPointerPath(parsed.Path, channel); err != nil {
		return nil, err
	}
	return parsed, nil
}

func validateChannelPointerTransportURL(rawURL, channel string, allowHTTPLoopback bool) (*url.URL, error) {
	if parsed, err := validateChannelPointerURL(rawURL, channel); err == nil {
		return parsed, nil
	}
	if !allowHTTPLoopback {
		return validateChannelPointerURL(rawURL, channel)
	}
	if channel != "stable" && channel != "prerelease" {
		return nil, fmt.Errorf("invalid network release channel %q", channel)
	}
	parsed, err := parseLoopbackReleaseURL(rawURL)
	if err != nil {
		return nil, err
	}
	if _, err := validateChannelPointerPath(parsed.Path, channel); err != nil {
		return nil, err
	}
	return parsed, nil
}

func validateChannelPointerPath(path, channel string) (string, error) {
	if path == fmt.Sprintf("/v1/%s/darwin-arm64.json", channel) {
		return "", nil
	}
	prefix := "/v1/artifacts/"
	suffix := "/channel-pointer.json"
	if !strings.HasPrefix(path, prefix) || !strings.HasSuffix(path, suffix) {
		return "", errors.New("must use the compiled channel pointer or immutable staged channel-pointer path")
	}
	buildID := strings.TrimSuffix(strings.TrimPrefix(path, prefix), suffix)
	if buildID == "" || strings.Contains(buildID, "/") || !buildIDPattern.MatchString(buildID) || path != fmt.Sprintf("/v1/artifacts/%s/channel-pointer.json", buildID) {
		return "", errors.New("immutable channel pointer URL has an invalid build ID")
	}
	return buildID, nil
}

func channelPointerStagingBuildID(path string) (string, bool) {
	buildID, err := validateChannelPointerPath(path, "stable")
	if err != nil || buildID == "" {
		return "", false
	}
	return buildID, true
}

// validateImmutableDescriptorURL accepts the direct, immutable form used by
// Homebrew. It returns the build ID encoded by the path so cache metadata
// cannot claim a different descriptor after its bytes have been checked.
func validateImmutableDescriptorURL(rawURL string) (*url.URL, string, error) {
	parsed, err := parseCanonicalReleaseURL(rawURL)
	if err != nil {
		return nil, "", err
	}
	prefix := "/v1/artifacts/"
	suffix := "/release-descriptor.json"
	if !strings.HasPrefix(parsed.Path, prefix) || !strings.HasSuffix(parsed.Path, suffix) {
		return nil, "", errors.New("must select an immutable release descriptor URL")
	}
	buildID := strings.TrimSuffix(strings.TrimPrefix(parsed.Path, prefix), suffix)
	if buildID == "" || strings.Contains(buildID, "/") || !buildIDPattern.MatchString(buildID) {
		return nil, "", errors.New("immutable release descriptor URL has an invalid build ID")
	}
	if parsed.Path != fmt.Sprintf("/v1/artifacts/%s/release-descriptor.json", buildID) {
		return nil, "", errors.New("immutable release descriptor URL is not canonical")
	}
	return parsed, buildID, nil
}

func validateReleaseChannelPointer(raw []byte, expectedChannel string) (channelPointer, *url.URL, *url.URL, error) {
	origin, err := url.Parse(canonicalReleaseOrigin)
	if err != nil {
		return channelPointer{}, nil, nil, err
	}
	return validateReleaseChannelPointerAtOrigin(raw, expectedChannel, origin)
}

func validateReleaseChannelPointerAtOrigin(raw []byte, expectedChannel string, origin *url.URL) (channelPointer, *url.URL, *url.URL, error) {
	var pointer channelPointer
	if origin == nil {
		return pointer, nil, nil, errors.New("release channel pointer origin is required")
	}
	if err := decodeStrict(raw, "release channel pointer", &pointer); err != nil {
		return pointer, nil, nil, err
	}
	if pointer.SchemaVersion != 1 || (pointer.Channel != "stable" && pointer.Channel != "prerelease") || pointer.Channel != expectedChannel || pointer.Sequence == 0 || pointer.Sequence > maxJSONSafeInteger || !gitCommitPattern.MatchString(pointer.SourceCommit) || !buildIDPattern.MatchString(pointer.BuildID) || pointer.Platform.ID != "darwin-arm64" || pointer.Platform.OS != "darwin" || pointer.Platform.Arch != "arm64" {
		return pointer, nil, nil, errors.New("invalid release channel pointer identity")
	}
	descriptorURL, err := validateReleaseURLAtOrigin(pointer.Descriptor.URL, fmt.Sprintf("/v1/artifacts/%s/release-descriptor.json", pointer.BuildID), origin)
	if err != nil {
		return pointer, nil, nil, fmt.Errorf("release channel pointer descriptor URL: %w", err)
	}
	signatureURL, err := validateReleaseURLAtOrigin(pointer.Signature.URL, fmt.Sprintf("/v1/artifacts/%s/release-descriptor.json.sig", pointer.BuildID), origin)
	if err != nil {
		return pointer, nil, nil, fmt.Errorf("release channel pointer signature URL: %w", err)
	}
	if !sha256Pattern.MatchString(pointer.Descriptor.SHA256) || !sha256Pattern.MatchString(pointer.Signature.SHA256) {
		return pointer, nil, nil, errors.New("invalid release channel pointer SHA-256")
	}
	return pointer, descriptorURL, signatureURL, nil
}

func verifyPointerDescriptorIdentity(pointer channelPointer, descriptor Descriptor) error {
	if pointer.Channel != descriptor.Channel {
		return errors.New("release channel pointer channel does not match descriptor")
	}
	if pointer.Platform.ID != descriptor.Platform.ID {
		return errors.New("release channel pointer platform ID does not match descriptor")
	}
	if pointer.Platform.OS != descriptor.Platform.OS {
		return errors.New("release channel pointer platform OS does not match descriptor")
	}
	if pointer.Platform.Arch != descriptor.Platform.Arch {
		return errors.New("release channel pointer platform architecture does not match descriptor")
	}
	if pointer.SourceCommit != descriptor.SourceCommit {
		return errors.New("release channel pointer source commit does not match descriptor")
	}
	if pointer.BuildID != descriptor.BuildID {
		return errors.New("release channel pointer build ID does not match descriptor")
	}
	if pointer.Sequence != descriptor.Sequence {
		return errors.New("release channel pointer sequence does not match descriptor")
	}
	return nil
}

func validateCanonicalReleaseURL(rawURL, expectedPath string) (*url.URL, error) {
	parsed, err := parseCanonicalReleaseURL(rawURL)
	if err != nil {
		return nil, err
	}
	if parsed.Path != expectedPath {
		return nil, fmt.Errorf("must use canonical path %q", expectedPath)
	}
	return parsed, nil
}

func validateReleaseURLAtOrigin(rawURL, expectedPath string, origin *url.URL) (*url.URL, error) {
	if origin.Scheme == "https" && origin.Host == canonicalReleaseHost {
		return validateCanonicalReleaseURL(rawURL, expectedPath)
	}
	parsed, err := parseLoopbackReleaseURL(rawURL)
	if err != nil {
		return nil, err
	}
	if parsed.Scheme != origin.Scheme || parsed.Host != origin.Host {
		return nil, errors.New("must stay on the channel-pointer origin")
	}
	if parsed.Path != expectedPath {
		return nil, fmt.Errorf("must use exact immutable path %q", expectedPath)
	}
	return parsed, nil
}

func validateCanonicalArtifactURL(descriptor Descriptor, origin *url.URL) error {
	expectedPath := fmt.Sprintf("/v1/artifacts/%s/jobctrl-%s-darwin-arm64.zip", descriptor.BuildID, descriptor.AppVersion)
	if _, err := validateReleaseURLAtOrigin(descriptor.Artifact.URL, expectedPath, origin); err != nil {
		return fmt.Errorf("release artifact URL: %w", err)
	}
	return nil
}

func parseCanonicalReleaseURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed == nil {
		return nil, errors.New("must be a valid canonical HTTPS URL")
	}
	if parsed.Scheme != "https" || parsed.Host != canonicalReleaseHost || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.RawPath != "" || parsed.Opaque != "" || parsed.Path == "" {
		return nil, errors.New("must use canonical HTTPS without credentials, port, query, fragment, or encoded path")
	}
	// url.Parse normalizes some values when String is called. Requiring a byte
	// exact round-trip prevents alternate spellings such as an escaped path,
	// a capitalized host, or a trailing authority dot from becoming aliases.
	if parsed.String() != rawURL || parsed.EscapedPath() != parsed.Path {
		return nil, errors.New("must use an exact canonical release URL")
	}
	return parsed, nil
}

func parseLoopbackReleaseURL(rawURL string) (*url.URL, error) {
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed == nil || parsed.Scheme != "http" || !isLoopbackHost(parsed.Hostname()) || parsed.Host == "" || parsed.User != nil || parsed.RawQuery != "" || parsed.ForceQuery || parsed.Fragment != "" || parsed.RawPath != "" || parsed.Opaque != "" || parsed.Path == "" {
		return nil, errors.New("must use exact HTTP loopback without credentials, query, fragment, or encoded path")
	}
	if parsed.String() != rawURL || parsed.EscapedPath() != parsed.Path {
		return nil, errors.New("must use an exact loopback release URL")
	}
	return parsed, nil
}

func validateDescriptorArtifactURL(rawURL, channel string, allowHTTPLoopback bool) (*url.URL, error) {
	if channel == "local" {
		parsed, err := url.Parse(rawURL)
		if err != nil || parsed == nil || parsed.Scheme != "file" || parsed.Host != "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || !strings.HasPrefix(parsed.Path, "/") {
			return nil, errors.New("local release artifact URL must be a canonical absolute file:// URL")
		}
		return parsed, nil
	}
	return validateTransportURL(rawURL, allowHTTPLoopback)
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
	var descriptorFields map[string]json.RawMessage
	if err := decodeStrict(raw, "release descriptor fields", &descriptorFields); err != nil {
		return descriptor, err
	}
	for _, required := range []string{"minimumSafeSequence", "revokedBuildIds"} {
		if _, exists := descriptorFields[required]; !exists {
			return descriptor, fmt.Errorf("release descriptor is missing %s", required)
		}
	}
	var canonicalRevocations []string
	if err := json.Unmarshal(descriptorFields["revokedBuildIds"], &canonicalRevocations); err != nil || canonicalRevocations == nil {
		return descriptor, errors.New("release descriptor revokedBuildIds must be an array")
	}
	var signature descriptorSignature
	if err := decodeStrict(signatureRaw, "release descriptor signature", &signature); err != nil {
		return descriptor, err
	}
	if descriptor.SchemaVersion != 1 || descriptor.Sequence == 0 || descriptor.Sequence > maxJSONSafeInteger || !buildIDPattern.MatchString(descriptor.BuildID) || !semverPattern.MatchString(descriptor.AppVersion) || descriptor.Platform.ID != "darwin-arm64" || descriptor.Platform.OS != "darwin" || descriptor.Platform.Arch != "arm64" {
		return descriptor, errors.New("invalid release descriptor identity")
	}
	if descriptor.Channel != "local" && descriptor.Channel != "stable" && descriptor.Channel != "prerelease" {
		return descriptor, errors.New("invalid release descriptor channel")
	}
	_, hasSourceCommit := descriptorFields["sourceCommit"]
	if descriptor.Channel == "local" && hasSourceCommit {
		return descriptor, errors.New("local release descriptor must not declare sourceCommit")
	}
	if descriptor.Channel != "local" && (!hasSourceCommit || !gitCommitPattern.MatchString(descriptor.SourceCommit)) {
		return descriptor, errors.New("network release descriptor requires a full sourceCommit SHA")
	}
	if descriptor.MinimumSafeSequence > maxJSONSafeInteger || descriptor.MinimumSafeSequence > descriptor.Sequence || (descriptor.Channel != "local" && descriptor.MinimumSafeSequence == 0) {
		return descriptor, errors.New("invalid release minimum-safe sequence")
	}
	for index, build := range descriptor.RevokedBuildIDs {
		if !buildIDPattern.MatchString(build) || (index > 0 && descriptor.RevokedBuildIDs[index-1] >= build) {
			return descriptor, errors.New("invalid release revocation tombstones")
		}
	}
	if descriptor.Artifact.ArchiveType != "zip" || !sha256Pattern.MatchString(descriptor.Artifact.SHA256) || !sha256Pattern.MatchString(descriptor.Artifact.ManifestSHA256) || descriptor.Artifact.SizeBytes <= 0 || descriptor.Artifact.SizeBytes > maxArchiveBytes {
		return descriptor, errors.New("invalid release artifact contract")
	}
	artifactURL, err := validateDescriptorArtifactURL(descriptor.Artifact.URL, descriptor.Channel, allowHTTPLoopback)
	if err != nil {
		return descriptor, fmt.Errorf("artifact URL: %w", err)
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
	home, err := RuntimeHome(options.Home)
	if err != nil {
		return Receipt{}, fmt.Errorf("download release archive: %w", err)
	}
	shared, err := release.Open(home)
	if err != nil {
		return Receipt{}, err
	}
	transition, err := shared.TransitionLock()
	if err != nil {
		return Receipt{}, err
	}
	defer transition.Close()
	store, err := openStore(home)
	if err != nil {
		return Receipt{}, err
	}
	defer store.Close()
	if err := store.cleanupStaging(); err != nil {
		return Receipt{}, err
	}
	stage, err := prepareDescriptorStage(shared, descriptorBytes)
	if err != nil {
		return Receipt{}, err
	}
	archivePath, err := downloadArchiveToStage(client, artifactURL.String(), descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256, stage)
	if err != nil {
		return Receipt{}, fmt.Errorf("download release archive: %w", err)
	}
	return installArchiveLocked(options, descriptor, descriptorBytes, descriptorURL, archivePath, shared, store)
}

type progressReader struct {
	reader   io.Reader
	progress chan<- struct{}
}

func (reader progressReader) Read(buffer []byte) (int, error) {
	count, err := reader.reader.Read(buffer)
	if count > 0 {
		select {
		case reader.progress <- struct{}{}:
		default:
		}
	}
	return count, err
}

type copyResult struct {
	written int64
	err     error
}

func copyWithProgressTimeout(destination io.Writer, source io.Reader, stallTimeout time.Duration, cancel context.CancelFunc) (int64, error) {
	if stallTimeout <= 0 {
		return 0, errors.New("archive stall timeout must be positive")
	}
	progress := make(chan struct{}, 1)
	finished := make(chan copyResult, 1)
	go func() {
		written, err := io.Copy(destination, progressReader{reader: source, progress: progress})
		finished <- copyResult{written: written, err: err}
	}()
	timer := time.NewTimer(stallTimeout)
	defer timer.Stop()
	for {
		select {
		case result := <-finished:
			return result.written, result.err
		case <-progress:
			if !timer.Stop() {
				select {
				case <-timer.C:
				default:
				}
			}
			timer.Reset(stallTimeout)
		case <-timer.C:
			cancel()
			result := <-finished
			return result.written, fmt.Errorf("archive download stalled for %s", stallTimeout)
		}
	}
}

// downloadArchiveToStage keeps both its partial and completed cache under the
// signed descriptor digest. Callers hold the shared transition lock for the
// whole acquisition, so uninstall, promotion, and a second installer cannot
// mutate the same release store while an archive is being resumed.
func downloadArchiveToStage(client *http.Client, rawURL string, expectedSize int64, expectedSHA256, stage string) (string, error) {
	return downloadArchiveToStageWithStallTimeout(client, rawURL, expectedSize, expectedSHA256, stage, archiveStallTimeout)
}

func downloadArchiveToStageWithStallTimeout(client *http.Client, rawURL string, expectedSize int64, expectedSHA256, stage string, stallTimeout time.Duration) (string, error) {
	if expectedSize <= 0 || !sha256Pattern.MatchString(expectedSHA256) {
		return "", errors.New("invalid signed archive identity")
	}
	final := filepath.Join(stage, stagedArchiveName)
	partial := filepath.Join(stage, partialArchiveName)
	if info, err := os.Lstat(final); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("descriptor-bound archive cache is not a regular file")
		}
		if err := verifyArchiveFile(final, expectedSize, expectedSHA256); err != nil {
			return "", fmt.Errorf("cached archive does not match signed release descriptor: %w", err)
		}
		return final, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	offset := int64(0)
	if info, err := os.Lstat(partial); err == nil {
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("descriptor-bound partial archive is not a regular file")
		}
		offset = info.Size()
		if offset > expectedSize {
			return "", fmt.Errorf("partial archive size %d exceeds signed size %d", offset, expectedSize)
		}
		if offset == expectedSize {
			if err := verifyArchiveFile(partial, expectedSize, expectedSHA256); err != nil {
				return "", fmt.Errorf("partial archive does not match signed release descriptor: %w", err)
			}
			if err := finalizeArchiveCache(partial, final, stage); err != nil {
				return "", err
			}
			return final, nil
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return "", err
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, rawURL, nil)
	if err != nil {
		return "", err
	}
	if offset > 0 {
		request.Header.Set("Range", fmt.Sprintf("bytes=%d-", offset))
	}
	response, err := client.Do(request)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	appendToPartial := offset > 0 && response.StatusCode == http.StatusPartialContent
	if offset == 0 {
		if response.StatusCode != http.StatusOK {
			return "", fmt.Errorf("unexpected HTTP status %s", response.Status)
		}
		if err := requireFullArchiveResponse(response, expectedSize); err != nil {
			return "", err
		}
	} else if appendToPartial {
		if err := requirePartialArchiveResponse(response, offset, expectedSize); err != nil {
			return "", err
		}
	} else if response.StatusCode == http.StatusOK {
		// A server is allowed to ignore Range. Its full response is safe only if
		// it is descriptor-sized and replaces (rather than appends to) the cache.
		if err := requireFullArchiveResponse(response, expectedSize); err != nil {
			return "", err
		}
		offset, appendToPartial = 0, false
	} else {
		return "", fmt.Errorf("unexpected HTTP status %s while resuming archive", response.Status)
	}
	if err := writeArchiveResponse(partial, response.Body, offset, expectedSize, appendToPartial, stallTimeout, cancel); err != nil {
		return "", err
	}
	if err := verifyArchiveFile(partial, expectedSize, expectedSHA256); err != nil {
		return "", fmt.Errorf("archive size or SHA-256 does not match signed release descriptor: %w", err)
	}
	if err := finalizeArchiveCache(partial, final, stage); err != nil {
		return "", err
	}
	return final, nil
}

func requireFullArchiveResponse(response *http.Response, expectedSize int64) error {
	if response.ContentLength != expectedSize {
		return fmt.Errorf("archive content length mismatch: expected %d, received %d", expectedSize, response.ContentLength)
	}
	return nil
}

func requirePartialArchiveResponse(response *http.Response, offset, expectedSize int64) error {
	remaining := expectedSize - offset
	if response.ContentLength != remaining {
		return fmt.Errorf("partial archive content length mismatch: expected %d, received %d", remaining, response.ContentLength)
	}
	parts := contentRangePattern.FindStringSubmatch(response.Header.Get("Content-Range"))
	if len(parts) != 4 {
		return errors.New("partial archive Content-Range does not bind the signed descriptor size")
	}
	start, startErr := strconv.ParseInt(parts[1], 10, 64)
	end, endErr := strconv.ParseInt(parts[2], 10, 64)
	total, totalErr := strconv.ParseInt(parts[3], 10, 64)
	if startErr != nil || endErr != nil || totalErr != nil || start != offset || end != expectedSize-1 || total != expectedSize {
		return errors.New("partial archive Content-Range does not bind the signed descriptor size")
	}
	return nil
}

func writeArchiveResponse(path string, body io.Reader, offset, expectedSize int64, appendToPartial bool, stallTimeout time.Duration, cancel context.CancelFunc) error {
	flags := os.O_WRONLY | os.O_CREATE | syscall.O_NOFOLLOW
	if appendToPartial {
		flags |= os.O_APPEND
	} else {
		flags |= os.O_TRUNC
	}
	file, err := os.OpenFile(path, flags, 0o600)
	if err != nil {
		return err
	}
	if info, statErr := file.Stat(); statErr != nil || !info.Mode().IsRegular() || (appendToPartial && info.Size() != offset) {
		_ = file.Close()
		if statErr != nil {
			return statErr
		}
		return errors.New("partial archive changed while resuming")
	}
	remaining := expectedSize - offset
	written, copyErr := copyWithProgressTimeout(file, io.LimitReader(body, remaining+1), stallTimeout, cancel)
	syncErr := file.Sync()
	closeErr := file.Close()
	if copyErr != nil {
		return copyErr
	}
	if syncErr != nil {
		return syncErr
	}
	if closeErr != nil {
		return closeErr
	}
	if written != remaining {
		return fmt.Errorf("archive body length mismatch: expected %d, received %d", remaining, written)
	}
	return nil
}

func verifyArchiveFile(path string, expectedSize int64, expectedSHA256 string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("archive cache is not a regular file")
	}
	if info.Size() != expectedSize {
		return fmt.Errorf("archive size mismatch: expected %d, received %d", expectedSize, info.Size())
	}
	digest, err := digestFile(path)
	if err != nil {
		return err
	}
	if digest != expectedSHA256 {
		return errors.New("archive SHA-256 mismatch")
	}
	return nil
}

func finalizeArchiveCache(partial, final, stage string) error {
	if _, err := os.Lstat(final); err == nil {
		return errors.New("descriptor-bound final archive appeared during download")
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	// Link first so a same-user process cannot race this cache finalization by
	// planting a final path between Lstat and a replacement-style rename.
	// Both names are in one descriptor directory, so the link is atomic and
	// cannot cross filesystems.
	if err := os.Link(partial, final); err != nil {
		return err
	}
	if err := os.Remove(partial); err != nil {
		return err
	}
	return syncDirectory(stage)
}

// prepareDescriptorStage creates or verifies the sole staging location that
// may be associated with descriptorBytes. Its metadata is deliberately small
// and exact: the path is not enough evidence if a user-owned directory was
// prepositioned or reused for a different descriptor.
func prepareDescriptorStage(shared *release.Store, descriptorBytes []byte) (string, error) {
	descriptorDigest := digestBytes(descriptorBytes)
	stage, err := shared.StageDir(descriptorDigest)
	if err != nil {
		return "", err
	}
	if info, statErr := os.Lstat(stage); statErr == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return "", errors.New("descriptor-bound staging path is not a regular directory")
		}
		var staged struct {
			DescriptorSHA256 string `json:"descriptorSha256"`
		}
		metaRaw, metaErr := readBoundedFile(filepath.Join(stage, "stage.json"), maxSignatureBytes)
		if metaErr != nil || decodeStrict(metaRaw, "staging metadata", &staged) != nil || staged.DescriptorSHA256 != descriptorDigest {
			return "", errors.New("staging metadata does not bind the authenticated descriptor")
		}
		return stage, nil
	} else if !errors.Is(statErr, os.ErrNotExist) {
		return "", statErr
	}
	if err := os.Mkdir(stage, 0o700); err != nil {
		return "", err
	}
	if err := writeBytesAtomic(filepath.Join(stage, "stage.json"), []byte(`{"descriptorSha256":"`+descriptorDigest+`"}`+"\n"), 0o600); err != nil {
		return "", err
	}
	if err := syncDirectory(filepath.Dir(stage)); err != nil {
		return "", err
	}
	return stage, nil
}

func installArchive(options Options, descriptor Descriptor, descriptorBytes []byte, descriptorURL, archivePath string) (Receipt, error) {
	home, err := RuntimeHome(options.Home)
	if err != nil {
		return Receipt{}, err
	}
	// Acquisition participates in the same transition -> selection hierarchy as
	// promotion, rollback, backup, retention, and uninstall. There is no
	// independent installer flock that can deadlock or race an active record.
	shared, err := release.Open(home)
	if err != nil {
		return Receipt{}, err
	}
	transition, err := shared.TransitionLock()
	if err != nil {
		return Receipt{}, err
	}
	defer transition.Close()
	store, err := openStore(home)
	if err != nil {
		return Receipt{}, err
	}
	defer store.Close()
	return installArchiveLocked(options, descriptor, descriptorBytes, descriptorURL, archivePath, shared, store)
}

func installArchiveLocked(options Options, descriptor Descriptor, descriptorBytes []byte, descriptorURL, archivePath string, shared *release.Store, store *store) (Receipt, error) {
	if err := verifyArchiveFile(archivePath, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256); err != nil {
		return Receipt{}, fmt.Errorf("release archive does not match signed descriptor: %w", err)
	}
	// P4's random stage-* directories have no authenticated identity and cannot
	// be resumed. Descriptor-digest directories are intentionally retained.
	if err := store.cleanupStaging(); err != nil {
		return Receipt{}, err
	}
	descriptorDigest := digestBytes(descriptorBytes)
	stage, err := prepareDescriptorStage(shared, descriptorBytes)
	if err != nil {
		return Receipt{}, err
	}
	payload := filepath.Join(stage, "payload")
	// A complete payload can be reused after interruption only after re-running
	// the full verifier. A partial payload remains descriptor-bound, but is
	// discarded before a fresh extraction rather than being trusted by shape.
	reuse := false
	if _, err := os.Lstat(payload); err == nil {
		trust := launcher.DistributionTrust{PublicKeys: options.Trust, AllowUnsignedLocal: options.AllowUnsignedLocal, ExpectedChannel: descriptor.Channel}
		if _, verifyErr := launcher.VerifyDistributionPayload(payload, trust); verifyErr == nil {
			reuse = true
		} else if removeErr := os.RemoveAll(payload); removeErr != nil {
			return Receipt{}, removeErr
		}
	}
	if !reuse {
		if err := extractZIP(archivePath, payload); err != nil {
			return Receipt{}, err
		}
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
	// The archive cache is useful only until the authenticated payload is fully
	// verified. Never move it into releases/<build>: immutable releases contain
	// the payload, receipts, and policy evidence—not a duplicate mutable cache.
	if archivePath == filepath.Join(stage, stagedArchiveName) {
		if err := os.Remove(archivePath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return Receipt{}, err
		}
		if err := syncDirectory(stage); err != nil {
			return Receipt{}, err
		}
	}
	metadata := release.ChannelMetadata{Channel: descriptor.Channel, Sequence: descriptor.Sequence, Minimum: descriptor.MinimumSafeSequence, BuildID: descriptor.BuildID, DescriptorDigest: descriptorDigest, Revoked: descriptor.RevokedBuildIDs}
	policyBytes, err := encodeJSON(metadata)
	if err != nil {
		return Receipt{}, err
	}
	receipt := Receipt{SchemaVersion: 2, BuildID: descriptor.BuildID, Channel: descriptor.Channel, Sequence: descriptor.Sequence, ArtifactSHA256: descriptor.Artifact.SHA256, ManifestSHA256: manifestDigest, DescriptorSHA256: descriptorDigest, PolicySHA256: digestBytes(policyBytes), DescriptorURL: descriptorURL, InstalledAt: time.Now().UTC().Format(time.RFC3339Nano)}
	receiptBytes, err := encodeJSON(receipt)
	if err != nil {
		return Receipt{}, err
	}
	releasePath := filepath.Join(store.home, "releases", descriptor.BuildID)
	releaseExists := false
	if _, err := os.Lstat(releasePath); err == nil {
		if info, statErr := os.Lstat(releasePath); statErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return Receipt{}, errors.New("existing release path is not a regular directory")
		}
		immutableReceipt, immutableBytes, err := verifyInstalledRelease(releasePath, descriptor, trust, receipt)
		if err != nil {
			return Receipt{}, fmt.Errorf("existing release %q is not idempotent-safe: %w", descriptor.BuildID, err)
		}
		receipt, receiptBytes = immutableReceipt, immutableBytes
		releaseExists = true
	} else if !errors.Is(err, os.ErrNotExist) {
		return Receipt{}, err
	}
	// Validate authenticated policy before writing, but do not make it durable
	// yet. Durable policy finalization is journaled by the shared promoter only
	// after this candidate is immutable and a coherent predecessor pair exists.
	// This is the critical crash boundary for security revocations.
	if _, err := shared.ValidateMetadata(metadata); err != nil {
		return Receipt{}, err
	}
	if !releaseExists {
		if err := syncDirectory(payload); err != nil {
			return Receipt{}, err
		}
		if err := syncDirectory(stage); err != nil {
			return Receipt{}, err
		}
		if err := writeBytesAtomic(filepath.Join(stage, "receipt.json"), receiptBytes, 0o600); err != nil {
			return Receipt{}, err
		}
		if err := writeBytesAtomic(filepath.Join(stage, "policy.json"), policyBytes, 0o600); err != nil {
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
	if options.StageOnly {
		// Staging never writes bin/jobctrl. In particular, an upgraded Homebrew
		// formula must not replace a selector that may be supervising an older
		// protocol payload; the shared promoter performs the compatible handoff.
		return receipt, nil
	}
	source := options.AcquisitionSource
	if source == "" {
		source = "curl"
	}
	if descriptor.Channel == "local" {
		source = "local-fixture"
	}
	// First installation has no predecessor to protect. It still takes the
	// common transition -> selection lock order and journals policy before
	// finalization. Existing installations must remain staged for the shared
	// health-gated launcher promoter; acquisition is never an activation path.
	selection, err := shared.SelectionLock(true)
	if err != nil {
		return Receipt{}, err
	}
	defer selection.Close()
	prior := uint64(0)
	if active, activeErr := shared.ReadActive(); activeErr == nil {
		if active.Receipt.BuildID == receipt.BuildID {
			if active.Receipt != (release.Receipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: receipt.Sequence, ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}) {
				return Receipt{}, errors.New("active build identity conflicts with authenticated immutable receipt")
			}
			if active.Acquisition != source {
				if _, err := shared.WriteSelectedActive(active.Receipt, active.Generation, active.SelectorBuildID, source); err != nil {
					return Receipt{}, err
				}
			}
		}
		return receipt, nil
	} else if !errors.Is(activeErr, os.ErrNotExist) {
		return Receipt{}, activeErr
	}
	journal, err := shared.Begin("install", nil, &release.Receipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: receipt.Sequence, ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}, receipt.DescriptorSHA256)
	if err != nil {
		return Receipt{}, err
	}
	journal.PendingPolicy = &metadata
	if err := shared.Advance(&journal, release.PolicyPending, nil); err != nil {
		return Receipt{}, err
	}
	state, err := shared.ValidateMetadata(metadata)
	if err != nil {
		return Receipt{}, err
	}
	if err := shared.CommitMetadata(state); err != nil {
		return Receipt{}, err
	}
	if err := shared.Advance(&journal, release.PolicyFinalized, nil); err != nil {
		return Receipt{}, err
	}
	if err := installPublicSelector(store.home, releasePath, descriptor.Channel); err != nil {
		return Receipt{}, err
	}
	if _, err := shared.WriteSelectedActive(release.Receipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: receipt.Sequence, ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}, prior, receipt.BuildID, source); err != nil {
		return Receipt{}, err
	}
	// current.json is a read-only P4 compatibility artifact. P5 resolution
	// exclusively reads active.json, so this second write cannot form a pointer
	// pair with the public selector.
	if err := writeBytesAtomic(filepath.Join(store.home, "current.json"), receiptBytes, 0o600); err != nil {
		return Receipt{}, err
	}
	if err := shared.Advance(&journal, release.Promoted, nil); err != nil {
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

// RuntimeHome resolves the user-owned store for the command front-end after a
// successful acquisition. It intentionally exposes only the path, never a
// mutable package-manager location.
func RuntimeHome(explicit string) (string, error) {
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
	return &store{home: home}, nil
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
func (s *store) Close() error { return nil }
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
	if receipt.SchemaVersion != expected.SchemaVersion || receipt.BuildID != expected.BuildID || receipt.Channel != expected.Channel || receipt.Sequence != expected.Sequence || receipt.ArtifactSHA256 != expected.ArtifactSHA256 || receipt.ManifestSHA256 != expected.ManifestSHA256 || receipt.DescriptorSHA256 != expected.DescriptorSHA256 || receipt.PolicySHA256 != expected.PolicySHA256 || receipt.DescriptorURL != expected.DescriptorURL || receipt.InstalledAt == "" {
		return receipt, nil, errors.New("release receipt does not match descriptor identity")
	}
	policyPath := filepath.Join(releasePath, "policy.json")
	policyInfo, err := os.Lstat(policyPath)
	if err != nil || !policyInfo.Mode().IsRegular() || policyInfo.Mode()&os.ModeSymlink != 0 {
		return receipt, nil, errors.New("release policy is not a regular file")
	}
	policyRaw, err := os.ReadFile(policyPath)
	if err != nil {
		return receipt, nil, err
	}
	var policy release.ChannelMetadata
	if err := decodeStrict(policyRaw, "release policy", &policy); err != nil {
		return receipt, nil, err
	}
	if digestBytes(policyRaw) != receipt.PolicySHA256 {
		return receipt, nil, errors.New("release policy digest does not match immutable receipt")
	}
	if policy.Channel != descriptor.Channel || policy.Sequence != descriptor.Sequence || policy.Minimum != descriptor.MinimumSafeSequence || policy.BuildID != descriptor.BuildID || policy.DescriptorDigest != expected.DescriptorSHA256 || !sameStrings(policy.Revoked, descriptor.RevokedBuildIDs) {
		return receipt, nil, errors.New("release policy does not match descriptor identity")
	}
	return receipt, raw, nil
}

func sameStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
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
	if runner == nil {
		runner = func(path string, args ...string) (string, error) {
			output, err := exec.Command(path, args...).CombinedOutput()
			return string(output), err
		}
	}
	targets, err := discoverMacOSPayloadTrustTargets(payloadRoot)
	if err != nil {
		return err
	}
	for _, target := range targets.machO {
		if _, err := runner("/usr/bin/codesign", "--verify", "--strict", "--verbose=4", target); err != nil {
			return fmt.Errorf("code signature verification failed for %s: %w", filepath.Base(target), err)
		}
	}
	for _, bundle := range targets.codeBundles {
		if _, err := runner("/usr/bin/codesign", "--verify", "--strict", "--verbose=4", bundle); err != nil {
			return fmt.Errorf("nested code-bundle signature verification failed for %s: %w", filepath.Base(bundle), err)
		}
	}
	// Gatekeeper assesses application bundles, not arbitrary signed command-line
	// Mach-O executables. Node and Chrome's headless shell are valid notarized
	// executables but spctl --type execute rejects their non-app shape. Keep the
	// notarization check on those binaries while reserving Gatekeeper for the
	// outer app bundle that owns any nested helpers and frameworks.
	for _, target := range targets.standaloneExecutables {
		// `--check-notarization` by itself accepts an ad-hoc raw executable on
		// current macOS. Require the notarized designated requirement for this
		// non-app shape; Gatekeeper remains reserved for outer app bundles.
		if _, err := runner("/usr/bin/codesign", "--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=4", target); err != nil {
			return fmt.Errorf("Developer ID/notarization verification failed for %s: %w", filepath.Base(target), err)
		}
	}
	for _, bundle := range targets.outermostAppBundles {
		// --deep is verification-only. Every nested bundle and Mach-O was
		// independently verified above, so a nested helper cannot hide behind
		// the outer bundle's assessment.
		if _, err := runner("/usr/bin/codesign", "--verify", "--deep", "--strict", "--check-notarization", "-R=notarized", "--verbose=4", bundle); err != nil {
			return fmt.Errorf("Developer ID/notarization verification failed for %s: %w", filepath.Base(bundle), err)
		}
		output, err := runner("/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4", bundle)
		if err != nil {
			return fmt.Errorf("Gatekeeper assessment failed for %s: %w", filepath.Base(bundle), err)
		}
		if !strings.Contains(output, "source=Notarized Developer ID") {
			return fmt.Errorf("Gatekeeper did not report Notarized Developer ID source for %s", filepath.Base(bundle))
		}
	}
	return nil
}

type macOSPayloadTrustTargets struct {
	machO                 []string
	codeBundles           []string
	standaloneExecutables []string
	outermostAppBundles   []string
}

func discoverMacOSPayloadTrustTargets(payloadRoot string) (macOSPayloadTrustTargets, error) {
	launcherPath := filepath.Join(payloadRoot, "launcher", "jobctrl")
	if info, err := os.Lstat(launcherPath); err != nil || !info.Mode().IsRegular() {
		return macOSPayloadTrustTargets{}, errors.New("signed payload does not contain a regular launcher/jobctrl executable")
	}
	launcherIsMachO, err := isMachO(launcherPath)
	if err != nil {
		return macOSPayloadTrustTargets{}, fmt.Errorf("inspect launcher/jobctrl executable: %w", err)
	}
	if !launcherIsMachO {
		return macOSPayloadTrustTargets{}, errors.New("signed payload launcher/jobctrl is not a Mach-O executable")
	}

	var targets macOSPayloadTrustTargets
	err = filepath.WalkDir(payloadRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == payloadRoot {
			return nil
		}
		if entry.IsDir() {
			if isMacOSCodeBundle(entry.Name()) {
				targets.codeBundles = append(targets.codeBundles, path)
			}
			if strings.HasSuffix(entry.Name(), ".app") {
				targets.outermostAppBundles = append(targets.outermostAppBundles, path)
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			machO, err := isMachO(path)
			if err != nil {
				return err
			}
			if machO {
				targets.machO = append(targets.machO, path)
				if info.Mode()&0o111 != 0 {
					targets.standaloneExecutables = append(targets.standaloneExecutables, path)
				}
			}
		}
		return nil
	})
	if err != nil {
		return macOSPayloadTrustTargets{}, err
	}
	targets.machO = sortedUniquePaths(targets.machO)
	targets.codeBundles = sortedUniquePaths(targets.codeBundles)
	targets.standaloneExecutables = sortedUniquePaths(targets.standaloneExecutables)
	allApps := sortedUniquePaths(targets.outermostAppBundles)
	targets.outermostAppBundles = targets.outermostAppBundles[:0]
	for _, app := range allApps {
		if !containedInAnotherApp(app, allApps) {
			targets.outermostAppBundles = append(targets.outermostAppBundles, app)
		}
	}
	standaloneExecutables := make([]string, 0, len(targets.standaloneExecutables))
	for _, executable := range targets.standaloneExecutables {
		if containedInAnyApp(executable, allApps) {
			continue
		}
		standaloneExecutables = append(standaloneExecutables, executable)
	}
	targets.standaloneExecutables = standaloneExecutables
	return targets, nil
}

func isMacOSCodeBundle(name string) bool {
	return strings.HasSuffix(name, ".app") || strings.HasSuffix(name, ".framework") || strings.HasSuffix(name, ".xpc") || strings.HasSuffix(name, ".appex")
}

func sortedUniquePaths(paths []string) []string {
	set := make(map[string]struct{}, len(paths))
	for _, path := range paths {
		set[path] = struct{}{}
	}
	ordered := make([]string, 0, len(set))
	for path := range set {
		ordered = append(ordered, path)
	}
	sort.Strings(ordered)
	return ordered
}

func containedInAnotherApp(candidate string, apps []string) bool {
	for _, app := range apps {
		if app != candidate && containsPayloadPath(app, candidate) {
			return true
		}
	}
	return false
}

func containedInAnyApp(candidate string, apps []string) bool {
	for _, app := range apps {
		if containsPayloadPath(app, candidate) {
			return true
		}
	}
	return false
}

func containsPayloadPath(root, candidate string) bool {
	relative, err := filepath.Rel(root, candidate)
	return err == nil && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}

func isMachO(path string) (bool, error) {
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return false, err
	}
	defer file.Close()
	var header [4]byte
	read, err := io.ReadFull(file, header[:])
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return false, err
	}
	if read < len(header) {
		return false, nil
	}
	switch header {
	case [4]byte{0xfe, 0xed, 0xfa, 0xce}, [4]byte{0xce, 0xfa, 0xed, 0xfe}, [4]byte{0xfe, 0xed, 0xfa, 0xcf}, [4]byte{0xcf, 0xfa, 0xed, 0xfe}, [4]byte{0xca, 0xfe, 0xba, 0xbe}, [4]byte{0xbe, 0xba, 0xfe, 0xca}, [4]byte{0xca, 0xfe, 0xba, 0xbf}, [4]byte{0xbf, 0xba, 0xfe, 0xca}:
		return true, nil
	default:
		return false, nil
	}
}
