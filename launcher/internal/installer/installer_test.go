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
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestReleaseDescriptorAuthenticatesExactBytesAndOrigin(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := stableDescriptor("https://example.test/releases/jobctrl.zip")
	raw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	signature := signedDescriptorSignature(private, raw)
	signatureRaw, _ := json.Marshal(signature)
	source, _ := validateTransportURL("https://example.test/releases/darwin-arm64.json", false)
	if _, err := verifyDescriptor(raw, signatureRaw, map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, false, source, false); err != nil {
		t.Fatalf("signed descriptor rejected: %v", err)
	}
	if _, err := verifyDescriptor(append(raw, ' '), signatureRaw, map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, false, source, false); err == nil {
		t.Fatal("tampered descriptor accepted")
	}
	wrong, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := verifyDescriptor(raw, signatureRaw, map[string]ed25519.PublicKey{"jobctrl-release-v1": wrong}, false, source, false); err == nil {
		t.Fatal("wrong key accepted")
	}
	otherDomain := signedDescriptorSignatureWithDomain(private, raw, "jobctrl:manifest:v1\x00")
	otherDomainRaw, _ := json.Marshal(otherDomain)
	if _, err := verifyDescriptor(raw, otherDomainRaw, map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, false, source, false); err == nil {
		t.Fatal("manifest-domain signature accepted as descriptor")
	}
	descriptor.Artifact.URL = "https://other.example.test/jobctrl.zip"
	wrongOriginRaw, _ := json.Marshal(descriptor)
	wrongOriginSig, _ := json.Marshal(signedDescriptorSignature(private, wrongOriginRaw))
	if _, err := verifyDescriptor(wrongOriginRaw, wrongOriginSig, map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, false, source, false); err == nil {
		t.Fatal("cross-origin artifact accepted")
	}
}

func TestStablePayloadRequiresCodeSigningAndNotarizationAssessment(t *testing.T) {
	payload := t.TempDir()
	if err := os.MkdirAll(filepath.Join(payload, "launcher"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "launcher", "jobctrl"), []byte("binary"), 0o755); err != nil {
		t.Fatal(err)
	}
	var calls []string
	runner := func(path string, args ...string) (string, error) {
		calls = append(calls, path+" "+strings.Join(args, " "))
		if path == "/usr/sbin/spctl" {
			return "source=Notarized Developer ID\n", nil
		}
		return "", nil
	}
	if err := verifyMacOSPayloadTrust(payload, runner); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 2 || !strings.Contains(calls[0], "/usr/bin/codesign") || !strings.Contains(calls[0], "--check-notarization") || !strings.Contains(calls[1], "/usr/sbin/spctl") {
		t.Fatalf("missing trust checks: %#v", calls)
	}
	if err := verifyMacOSPayloadTrust(payload, func(_ string, _ ...string) (string, error) { return "", os.ErrPermission }); err == nil {
		t.Fatal("failed Gatekeeper check accepted")
	}
	if err := os.MkdirAll(filepath.Join(payload, "components", "Chromium.app"), 0o755); err != nil {
		t.Fatal(err)
	}
	calls = nil
	if err := verifyMacOSPayloadTrust(payload, runner); err != nil {
		t.Fatal(err)
	}
	if len(calls) != 4 || !strings.Contains(strings.Join(calls, "\n"), "Chromium.app") {
		t.Fatalf("Chromium app was not independently assessed: %#v", calls)
	}
	for _, path := range []string{"node/bin/node", "python/bin/python3", "temporal/temporal", "components/native/addon.node"} {
		full := filepath.Join(payload, path)
		if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(full, []byte{0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0}, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	calls = nil
	if err := verifyMacOSPayloadTrust(payload, runner); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"node", "python3", "temporal", "addon.node"} {
		found := false
		for _, call := range calls {
			if strings.Contains(call, name) {
				found = true
				break
			}
		}
		if !found {
			t.Fatalf("native executable %s was not independently code-trust assessed: %#v", name, calls)
		}
	}
}

func TestUnsignedLocalDescriptorCannotCrossNetworkBoundary(t *testing.T) {
	descriptor := stableDescriptor("https://example.test/jobctrl.zip")
	descriptor.Channel = "local"
	descriptor.Artifact.URL = "file:///jobctrl-local-release/fixture.zip"
	raw, _ := json.Marshal(descriptor)
	signatureRaw, _ := json.Marshal(descriptorSignature{SchemaVersion: 1, Status: "unsigned-local", Algorithm: "ed25519", KeyID: "local-development"})
	source, _ := validateTransportURL("https://example.test/release.json", false)
	if _, err := verifyDescriptor(raw, signatureRaw, nil, true, source, false); err == nil {
		t.Fatal("unsigned local descriptor accepted from network")
	}
	if _, err := verifyDescriptor(raw, signatureRaw, nil, false, nil, false); err == nil {
		t.Fatal("unsigned local descriptor accepted without explicit mode")
	}
	if _, err := verifyDescriptor(raw, signatureRaw, nil, true, nil, false); err != nil {
		t.Fatalf("explicit local fixture rejected: %v", err)
	}
}

func TestDescriptorValidationMatchesSafeIntegerAndCanonicalLocalFileRules(t *testing.T) {
	descriptor := stableDescriptor("file:///jobctrl-local-release/fixture.zip")
	descriptor.Channel = "local"
	descriptor.MinimumSafeSequence = 0
	raw, _ := json.Marshal(descriptor)
	signatureRaw, _ := json.Marshal(descriptorSignature{SchemaVersion: 1, Status: "unsigned-local", Algorithm: "ed25519", KeyID: "local-development"})
	if _, err := verifyDescriptor(raw, signatureRaw, nil, true, nil, false); err != nil {
		t.Fatalf("canonical local descriptor rejected: %v", err)
	}
	descriptor.Artifact.URL = "file://attacker.example/jobctrl.zip"
	raw, _ = json.Marshal(descriptor)
	if _, err := verifyDescriptor(raw, signatureRaw, nil, true, nil, false); err == nil {
		t.Fatal("local descriptor with file authority accepted")
	}
	descriptor.Artifact.URL = "file:///jobctrl-local-release/fixture.zip"
	descriptor.Sequence = maxJSONSafeInteger + 1
	raw, _ = json.Marshal(descriptor)
	if _, err := verifyDescriptor(raw, signatureRaw, nil, true, nil, false); err == nil {
		t.Fatal("unsafe JSON sequence accepted")
	}
}

func TestNetworkTransportRejectsRedirectDowngradeAndOversizedResponse(t *testing.T) {
	redirect := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		http.Redirect(response, request, "/other", http.StatusFound)
	}))
	defer redirect.Close()
	if _, err := fetchBounded(strictHTTPClient(), redirect.URL, 32); err == nil || !strings.Contains(err.Error(), "redirect") {
		t.Fatalf("redirect was not rejected: %v", err)
	}
	if _, err := validateTransportURL("http://example.test/release.json", false); err == nil {
		t.Fatal("plain HTTP accepted")
	}
	if _, err := validateTransportURL("http://127.0.0.1/release.json", true); err != nil {
		t.Fatalf("explicit loopback HTTP rejected: %v", err)
	}
	overflow := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { response.Write(bytes.Repeat([]byte("x"), 33)) }))
	defer overflow.Close()
	if _, err := fetchBounded(strictHTTPClient(), overflow.URL, 32); err == nil {
		t.Fatal("oversized response accepted")
	}
}

func TestArchiveDownloadAllowsSlowProgressBeyondMetadataDeadline(t *testing.T) {
	archive := []byte("a signed archive that arrives in two slow chunks")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.Header().Set("Content-Length", fmt.Sprintf("%d", len(archive)))
		_, _ = response.Write(archive[:len(archive)/2])
		response.(http.Flusher).Flush()
		time.Sleep(75 * time.Millisecond)
		_, _ = response.Write(archive[len(archive)/2:])
	}))
	defer server.Close()
	metadata := server.Client()
	metadata.Timeout = 25 * time.Millisecond
	descriptor, descriptorRaw := signedLoopbackArchiveDescriptor(t, server.URL, archive)
	stage := descriptorStageForTest(t, descriptorRaw)
	path, err := downloadArchiveToStage(archiveHTTPClient(metadata), descriptor.Artifact.URL, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256, stage)
	if err != nil {
		t.Fatalf("slow but progressing archive was rejected: %v", err)
	}
	if downloaded, err := os.ReadFile(path); err != nil || !bytes.Equal(downloaded, archive) {
		t.Fatalf("downloaded archive = %q, %v", downloaded, err)
	}
}

func TestArchiveDownloadCancelsAStalledBody(t *testing.T) {
	archive := []byte("a signed archive that stalls")
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		response.Header().Set("Content-Length", fmt.Sprintf("%d", len(archive)))
		_, _ = response.Write(archive[:1])
		response.(http.Flusher).Flush()
		<-request.Context().Done()
	}))
	defer server.Close()
	descriptor, descriptorRaw := signedLoopbackArchiveDescriptor(t, server.URL, archive)
	stage := descriptorStageForTest(t, descriptorRaw)
	archiveStallTimeoutForTest := 25 * time.Millisecond
	_, err := downloadArchiveToStageWithStallTimeout(server.Client(), descriptor.Artifact.URL, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256, stage, archiveStallTimeoutForTest)
	if err == nil || !strings.Contains(err.Error(), "archive download stalled") {
		t.Fatalf("stalled archive result = %v", err)
	}
	partial, readErr := os.ReadFile(filepath.Join(stage, partialArchiveName))
	if readErr != nil || !bytes.Equal(partial, archive[:1]) {
		t.Fatalf("stalled archive did not preserve resumable bytes: %q, %v", partial, readErr)
	}
}

func TestDescriptorBoundArchiveCacheResumesInterruptedLoopbackDownload(t *testing.T) {
	archive := []byte("a resumable signed archive payload")
	var calls []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		calls = append(calls, request.Header.Get("Range"))
		response.Header().Set("Content-Length", fmt.Sprintf("%d", len(archive)))
		if len(calls) == 1 {
			_, _ = response.Write(archive[:7])
			return
		}
		if got := request.Header.Get("Range"); got != "bytes=7-" {
			t.Fatalf("resume Range = %q", got)
		}
		response.Header().Set("Content-Range", fmt.Sprintf("bytes 7-%d/%d", len(archive)-1, len(archive)))
		response.Header().Set("Content-Length", fmt.Sprintf("%d", len(archive)-7))
		response.WriteHeader(http.StatusPartialContent)
		_, _ = response.Write(archive[7:])
	}))
	defer server.Close()
	descriptor, descriptorRaw := signedLoopbackArchiveDescriptor(t, server.URL, archive)
	stage := descriptorStageForTest(t, descriptorRaw)
	if _, err := downloadArchiveToStage(server.Client(), descriptor.Artifact.URL, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256, stage); err == nil {
		t.Fatal("interrupted archive download accepted")
	}
	partial, err := os.ReadFile(filepath.Join(stage, partialArchiveName))
	if err != nil || !bytes.Equal(partial, archive[:7]) {
		t.Fatalf("resumable partial = %q, %v", partial, err)
	}
	path, err := downloadArchiveToStage(server.Client(), descriptor.Artifact.URL, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256, stage)
	if err != nil {
		t.Fatalf("resume signed archive: %v", err)
	}
	completed, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(completed, archive) || len(calls) != 2 {
		t.Fatalf("completed archive = %q, calls=%v, err=%v", completed, calls, err)
	}
}

func TestDescriptorBoundArchiveCacheRestartsWhenRangeIsIgnored(t *testing.T) {
	archive := []byte("full archive returned after the server ignores Range")
	var sawRange string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		sawRange = request.Header.Get("Range")
		response.Header().Set("Content-Length", fmt.Sprintf("%d", len(archive)))
		_, _ = response.Write(archive)
	}))
	defer server.Close()
	descriptor, descriptorRaw := signedLoopbackArchiveDescriptor(t, server.URL, archive)
	stage := descriptorStageForTest(t, descriptorRaw)
	if err := os.WriteFile(filepath.Join(stage, partialArchiveName), archive[:9], 0o600); err != nil {
		t.Fatal(err)
	}
	path, err := downloadArchiveToStage(server.Client(), descriptor.Artifact.URL, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256, stage)
	if err != nil {
		t.Fatalf("restart after ignored Range: %v", err)
	}
	completed, err := os.ReadFile(path)
	if sawRange != "bytes=9-" || err != nil || !bytes.Equal(completed, archive) {
		t.Fatalf("ignored Range restart=%q archive=%q err=%v", sawRange, completed, err)
	}
}

func TestDescriptorBoundArchiveCacheRejectsTamperAndOversize(t *testing.T) {
	archive := []byte("exactly signed archive bytes")
	for _, testCase := range []struct {
		name    string
		respond func(http.ResponseWriter)
	}{
		{
			name: "tamper",
			respond: func(response http.ResponseWriter) {
				response.Header().Set("Content-Length", fmt.Sprintf("%d", len(archive)))
				_, _ = response.Write(bytes.Repeat([]byte("x"), len(archive)))
			},
		},
		{
			name: "oversize",
			respond: func(response http.ResponseWriter) {
				response.Header().Set("Content-Length", fmt.Sprintf("%d", len(archive)+1))
				_, _ = response.Write(append(append([]byte{}, archive...), '!'))
			},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) { testCase.respond(response) }))
			defer server.Close()
			descriptor, descriptorRaw := signedLoopbackArchiveDescriptor(t, server.URL, archive)
			stage := descriptorStageForTest(t, descriptorRaw)
			if _, err := downloadArchiveToStage(server.Client(), descriptor.Artifact.URL, descriptor.Artifact.SizeBytes, descriptor.Artifact.SHA256, stage); err == nil {
				t.Fatalf("%s archive was accepted", testCase.name)
			}
		})
	}
}

func TestImmutableReleaseDoesNotRetainDescriptorArchiveCache(t *testing.T) {
	root := t.TempDir()
	archivePath, descriptorPath, _ := localFixture(t, root)
	descriptorRaw, err := os.ReadFile(descriptorPath)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor Descriptor
	if err := json.Unmarshal(descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "runtime")
	shared, err := release.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	stage, err := prepareDescriptorStage(shared, descriptorRaw)
	if err != nil {
		t.Fatal(err)
	}
	archive, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	stagedArchive := filepath.Join(stage, stagedArchiveName)
	if err := os.WriteFile(stagedArchive, archive, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := installArchive(Options{Home: home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true}, descriptor, descriptorRaw, "local-fixture", stagedArchive); err != nil {
		t.Fatalf("install staged local archive: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(home, "releases", descriptor.BuildID, stagedArchiveName)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("immutable release retained archive cache: %v", err)
	}
}

func signedLoopbackArchiveDescriptor(t *testing.T, origin string, archive []byte) (Descriptor, []byte) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := stableDescriptor(origin + "/archive.zip")
	digest := sha256.Sum256(archive)
	descriptor.Artifact.SHA256 = hex.EncodeToString(digest[:])
	descriptor.Artifact.SizeBytes = int64(len(archive))
	raw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	signatureRaw, err := json.Marshal(signedDescriptorSignature(private, raw))
	if err != nil {
		t.Fatal(err)
	}
	source, err := validateTransportURL(origin+"/descriptor.json", true)
	if err != nil {
		t.Fatal(err)
	}
	verified, err := verifyDescriptor(raw, signatureRaw, map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, false, source, true)
	if err != nil {
		t.Fatalf("generated Ed25519 loopback descriptor rejected: %v", err)
	}
	return verified, raw
}

func descriptorStageForTest(t *testing.T, descriptorRaw []byte) string {
	t.Helper()
	store, err := release.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	stage, err := prepareDescriptorStage(store, descriptorRaw)
	if err != nil {
		t.Fatal(err)
	}
	return stage
}

func TestZIPExtractionRejectsTraversalLinksSpecialEntriesAndCollisions(t *testing.T) {
	cases := []struct {
		name  string
		entry string
		mode  os.FileMode
		want  string
	}{
		{"traversal", "../escape", 0o644, "unsafe ZIP entry"},
		{"backslash", `dir\\escape`, 0o644, "unsafe ZIP entry"},
		{"unicode", "\u00e9", 0o644, "unsafe ZIP entry"},
		{"special", "device", os.ModeDevice | 0o644, "unsupported link"},
	}
	escapingLink := writeZIP(t, []zipEntry{{"link", []byte("../outside"), os.ModeSymlink | 0o777}})
	if err := extractZIP(escapingLink, t.TempDir()); err == nil || !strings.Contains(err.Error(), "escapes payload root") {
		t.Fatalf("escaping symlink accepted: %v", err)
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			archive := writeZIP(t, []zipEntry{{testCase.entry, []byte("x"), testCase.mode}})
			err := extractZIP(archive, t.TempDir())
			if err == nil || !strings.Contains(err.Error(), testCase.want) {
				t.Fatalf("got %v, want %q", err, testCase.want)
			}
		})
	}
	duplicate := writeZIP(t, []zipEntry{{"same", []byte("one"), 0o644}, {"same", []byte("two"), 0o644}})
	if err := extractZIP(duplicate, t.TempDir()); err == nil || !strings.Contains(err.Error(), "collides") {
		t.Fatalf("duplicate entry accepted: %v", err)
	}
	caseCollision := writeZIP(t, []zipEntry{{"Readme", []byte("one"), 0o644}, {"README", []byte("two"), 0o644}})
	if err := extractZIP(caseCollision, t.TempDir()); err == nil || !strings.Contains(err.Error(), "case-insensitive") {
		t.Fatalf("case collision accepted: %v", err)
	}
}

func TestLocalInstallIsAtomicIdempotentConcurrentAndRecoversPointer(t *testing.T) {
	root := t.TempDir()
	archive, descriptor, signature := localFixture(t, root)
	home := filepath.Join(root, "Library", "Application Support", "JobCtrl")
	options := Options{Home: home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true}
	if err := os.MkdirAll(filepath.Join(home, "staging", "stage-interrupted"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(home, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "current.json"), []byte("not-json\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	first, err := InstallFromLocalFiles(options, descriptor, signature, archive)
	if err != nil {
		t.Fatalf("first install: %v", err)
	}
	if first.BuildID != "fixture-build-0001" {
		t.Fatalf("wrong receipt: %#v", first)
	}
	if _, err := os.Stat(filepath.Join(home, "releases", first.BuildID, "payload", "manifest.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(home, "staging", "stage-interrupted")); !os.IsNotExist(err) {
		t.Fatalf("interrupted stage survived: %v", err)
	}
	activeBefore, err := os.ReadFile(filepath.Join(home, release.ActiveFile))
	if err != nil {
		t.Fatal(err)
	}
	var group sync.WaitGroup
	errs := make(chan error, 2)
	for range 2 {
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := InstallFromLocalFiles(options, descriptor, signature, archive)
			errs <- err
		}()
	}
	group.Wait()
	close(errs)
	for err := range errs {
		if err != nil {
			t.Fatalf("concurrent/idempotent install: %v", err)
		}
	}
	activeAfter, err := os.ReadFile(filepath.Join(home, release.ActiveFile))
	if err != nil || !bytes.Equal(activeBefore, activeAfter) {
		t.Fatalf("idempotent concurrent install changed active selection: %v", err)
	}
	var current Receipt
	raw, err := os.ReadFile(filepath.Join(home, "current.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(raw, &current); err != nil || current.BuildID != first.BuildID {
		t.Fatalf("current pointer not recovered: %v %#v", err, current)
	}
	immutableRaw, err := os.ReadFile(filepath.Join(home, "releases", first.BuildID, "receipt.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(raw, immutableRaw) {
		t.Fatalf("rerun current receipt differs from immutable receipt\ncurrent: %s\nrelease: %s", raw, immutableRaw)
	}
	if current.InstalledAt != first.InstalledAt || current.DescriptorSHA256 != first.DescriptorSHA256 || current.DescriptorURL != first.DescriptorURL {
		t.Fatalf("rerun regenerated immutable receipt identity: first=%#v current=%#v", first, current)
	}
	selector := filepath.Join(home, "bin", "jobctrl")
	var selectorOutput bytes.Buffer
	environment := []string{"HOME=" + root, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + filepath.Join(root, "selector-state")}
	if err := launcher.Run(selector, []string{"help"}, environment, &selectorOutput, &selectorOutput); err != nil {
		t.Fatalf("selector rejected idempotently reactivated receipt: %v", err)
	}
	if !strings.Contains(selectorOutput.String(), "JobCtrl bundled launcher") {
		t.Fatalf("selector help missing: %q", selectorOutput.String())
	}
	if _, err := os.Stat(filepath.Join(root, ".jobctrl")); !os.IsNotExist(err) {
		t.Fatalf("installer mutated user state: %v", err)
	}
}

func TestArchiveManifestAndBuildParityRejectMismatch(t *testing.T) {
	root := t.TempDir()
	archive, descriptorPath, signaturePath := localFixture(t, root)
	raw, _ := os.ReadFile(descriptorPath)
	var descriptor Descriptor
	if err := json.Unmarshal(raw, &descriptor); err != nil {
		t.Fatal(err)
	}
	descriptor.BuildID = "fixture-build-wrong"
	changed, _ := json.Marshal(descriptor)
	if err := os.WriteFile(descriptorPath, changed, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFromLocalFiles(Options{Home: filepath.Join(root, "runtime"), Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true}, descriptorPath, signaturePath, archive); err == nil || !strings.Contains(err.Error(), "identities do not agree") {
		t.Fatalf("build mismatch accepted: %v", err)
	}
}

func TestExistingReleaseRejectsChangedDescriptorIdentityWithoutReactivation(t *testing.T) {
	root := t.TempDir()
	archive, descriptorPath, signaturePath := localFixture(t, root)
	home := filepath.Join(root, "runtime")
	options := Options{Home: home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true}
	first, err := InstallFromLocalFiles(options, descriptorPath, signaturePath, archive)
	if err != nil {
		t.Fatal(err)
	}
	currentBefore, err := os.ReadFile(filepath.Join(home, "current.json"))
	if err != nil {
		t.Fatal(err)
	}
	immutableBefore, err := os.ReadFile(filepath.Join(home, "releases", first.BuildID, "receipt.json"))
	if err != nil {
		t.Fatal(err)
	}
	descriptorRaw, err := os.ReadFile(descriptorPath)
	if err != nil {
		t.Fatal(err)
	}
	var descriptor Descriptor
	if err := json.Unmarshal(descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	descriptor.Sequence++
	descriptorRaw, _ = json.Marshal(descriptor)
	if err := os.WriteFile(descriptorPath, descriptorRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFromLocalFiles(options, descriptorPath, signaturePath, archive); err == nil || !strings.Contains(err.Error(), "release receipt does not match descriptor identity") {
		t.Fatalf("changed descriptor identity was accepted: %v", err)
	}
	currentAfter, _ := os.ReadFile(filepath.Join(home, "current.json"))
	immutableAfter, _ := os.ReadFile(filepath.Join(home, "releases", first.BuildID, "receipt.json"))
	if !bytes.Equal(currentBefore, currentAfter) || !bytes.Equal(immutableBefore, immutableAfter) {
		t.Fatal("descriptor mismatch mutated current or immutable receipt")
	}
}

func TestStageOnlyNeverReplacesAnExistingSelector(t *testing.T) {
	root := t.TempDir()
	archive, descriptor, signature := localFixture(t, root)
	home := filepath.Join(root, "runtime")
	options := Options{Home: home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true}
	if _, err := InstallFromLocalFiles(options, descriptor, signature, archive); err != nil {
		t.Fatal(err)
	}
	selector := filepath.Join(home, "bin", "jobctrl")
	before, err := os.ReadFile(selector)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFromLocalFiles(Options{Home: home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true, StageOnly: true}, descriptor, signature, archive); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(selector)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("stage-only acquisition replaced the existing stable selector")
	}
}

func TestRejectedChannelMetadataLeavesReleaseAndSelectorUntouched(t *testing.T) {
	root := t.TempDir()
	archive, descriptorPath, signaturePath := localFixture(t, root)
	home := filepath.Join(root, "runtime")
	store, err := release.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecordMetadata("local", 2, 0, "fixture-build-0002", strings.Repeat("d", 64), nil); err != nil {
		t.Fatal(err)
	}
	if _, err := InstallFromLocalFiles(Options{Home: home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true}, descriptorPath, signaturePath, archive); err == nil || !strings.Contains(err.Error(), "below recorded maximum") {
		t.Fatalf("downgrade result = %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "releases", "fixture-build-0001")); !os.IsNotExist(err) {
		t.Fatalf("rejected metadata committed release: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "bin", "jobctrl")); !os.IsNotExist(err) {
		t.Fatalf("rejected metadata changed selector: %v", err)
	}
	if _, err := os.Stat(filepath.Join(home, "active.json")); !os.IsNotExist(err) {
		t.Fatalf("rejected metadata changed active pointer: %v", err)
	}
}

func localAcquisitionPolicy() launcher.AcquisitionPolicy {
	return launcher.AcquisitionPolicy{ExpectedChannel: "local", AllowUnsignedLocal: true}
}

func TestSignedCachedFilesNeverAcceptUnsignedLocalFixtures(t *testing.T) {
	root := t.TempDir()
	archive, descriptor, signature := localFixture(t, root)
	_, err := InstallFromCachedFiles(Options{Home: filepath.Join(root, "runtime")}, "https://releases.example.test/v1/stable/darwin-arm64.json", descriptor, signature, archive)
	if err == nil || (!strings.Contains(err.Error(), "unsigned-local descriptor") && !strings.Contains(err.Error(), "unavailable")) {
		t.Fatalf("unsigned local cache crossed signed boundary: %v", err)
	}
}

func TestSignedBuildPolicyCannotUseUnsignedLocalOrMutateStore(t *testing.T) {
	root := t.TempDir()
	archive, descriptor, signature := localFixture(t, root)
	home := filepath.Join(root, "runtime")
	if err := os.MkdirAll(filepath.Join(home, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "current.json"), []byte("unchanged\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "bin", "jobctrl"), []byte("selector\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	options := Options{Home: home, Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, AllowUnsignedLocal: true}
	if _, err := InstallFromLocalFiles(options, descriptor, signature, archive); err == nil || !strings.Contains(err.Error(), "local fixture mode") {
		t.Fatalf("signed policy accepted unsigned local files: %v", err)
	}
	if current, err := os.ReadFile(filepath.Join(home, "current.json")); err != nil || string(current) != "unchanged\n" {
		t.Fatalf("current receipt mutated: %q, %v", current, err)
	}
	if selector, err := os.ReadFile(filepath.Join(home, "bin", "jobctrl")); err != nil || string(selector) != "selector\n" {
		t.Fatalf("selector mutated: %q, %v", selector, err)
	}
}

func TestCompiledNetworkChannelRejectsValidOtherChannelBeforeArchiveUse(t *testing.T) {
	root := t.TempDir()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := stableDescriptor("https://releases.example.test/jobctrl.zip")
	descriptor.Channel = "prerelease"
	raw, _ := json.Marshal(descriptor)
	signatureRaw, _ := json.Marshal(signedDescriptorSignature(private, raw))
	descriptorPath, signaturePath := filepath.Join(root, "descriptor.json"), filepath.Join(root, "descriptor.json.sig")
	if err := os.WriteFile(descriptorPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, signatureRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	options := Options{Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}}
	if _, err := InstallFromCachedFiles(options, "https://releases.example.test/v1/stable/darwin-arm64.json", descriptorPath, signaturePath, filepath.Join(root, "never-read.zip")); err == nil || !strings.Contains(err.Error(), "does not match compiled installer channel") {
		t.Fatalf("stable installer accepted prerelease descriptor: %v", err)
	}
	if _, err := InstallFromNetwork(Options{Policy: localAcquisitionPolicy()}); err == nil || !strings.Contains(err.Error(), "network acquisition is unavailable") {
		t.Fatalf("local installer exposed a network path: %v", err)
	}
}

func TestStoreRejectsManagedPathSymlinksAndDoesNotCleanTheirTargets(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "outside")
	if err := os.MkdirAll(target, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	home := filepath.Join(root, "runtime")
	if err := os.MkdirAll(filepath.Join(home, "staging"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(home, "staging", "stage-evil")); err != nil {
		t.Fatal(err)
	}
	store := &store{home: home}
	if err := store.cleanupStaging(); err == nil || !strings.Contains(err.Error(), "symlinked staging") {
		t.Fatalf("staging symlink accepted: %v", err)
	}
	if contents, err := os.ReadFile(filepath.Join(target, "keep")); err != nil || string(contents) != "keep" {
		t.Fatalf("staging target was touched: %q, %v", contents, err)
	}
	if err := os.Remove(filepath.Join(home, "staging", "stage-evil")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(home, "staging")); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(target, filepath.Join(home, "staging")); err != nil {
		t.Fatal(err)
	}
	if _, err := openStore(home); err == nil {
		t.Fatal("symlinked staging directory accepted")
	}
	if contents, err := os.ReadFile(filepath.Join(target, "keep")); err != nil || string(contents) != "keep" {
		t.Fatalf("managed-path target was touched: %q, %v", contents, err)
	}
}

func TestSelectorAndReleaseSymlinksFailClosed(t *testing.T) {
	root := t.TempDir()
	home := filepath.Join(root, "runtime")
	release := filepath.Join(home, "releases", "fixture-build-0001")
	if err := os.MkdirAll(filepath.Join(release, "payload", "launcher"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(release, "payload", "launcher", "jobctrl"), []byte("launcher"), 0o700); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(root, "outside-bin")
	if err := os.MkdirAll(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(outside, "keep"), []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, filepath.Join(home, "bin")); err != nil {
		t.Fatal(err)
	}
	if err := installPublicSelector(home, release, "stable"); err == nil {
		t.Fatal("symlinked selector bin accepted")
	}
	if _, err := os.Stat(filepath.Join(outside, "jobctrl")); !os.IsNotExist(err) {
		t.Fatalf("selector bin target was mutated: %v", err)
	}
	if err := os.Remove(filepath.Join(home, "bin")); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(home, "releases"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(release); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, release); err != nil {
		t.Fatal(err)
	}
	if _, _, err := verifyInstalledRelease(release, Descriptor{BuildID: "fixture-build-0001"}, launcher.DistributionTrust{}, Receipt{}); err == nil || !strings.Contains(err.Error(), "release path is not a regular directory") {
		t.Fatalf("symlinked release result = %v", err)
	}
	if contents, err := os.ReadFile(filepath.Join(outside, "keep")); err != nil || string(contents) != "keep" {
		t.Fatalf("release symlink target was touched: %q, %v", contents, err)
	}
}

type zipEntry struct {
	name     string
	contents []byte
	mode     os.FileMode
}

func writeZIP(t *testing.T, entries []zipEntry) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), "release.zip")
	file, err := os.Create(path)
	if err != nil {
		t.Fatal(err)
	}
	writer := zip.NewWriter(file)
	for _, entry := range entries {
		header := &zip.FileHeader{Name: entry.name, Method: zip.Store}
		header.SetMode(entry.mode)
		output, err := writer.CreateHeader(header)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := output.Write(entry.contents); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
	return path
}

func stableDescriptor(archiveURL string) Descriptor {
	var descriptor Descriptor
	descriptor.SchemaVersion, descriptor.Channel, descriptor.Sequence, descriptor.BuildID, descriptor.AppVersion = 1, "stable", 1, "fixture-build-0001", "2.0.0"
	descriptor.MinimumSafeSequence, descriptor.RevokedBuildIDs = 1, []string{}
	descriptor.Platform.ID, descriptor.Platform.OS, descriptor.Platform.Arch = "darwin-arm64", "darwin", "arm64"
	descriptor.Artifact.URL, descriptor.Artifact.SHA256, descriptor.Artifact.SizeBytes, descriptor.Artifact.ArchiveType, descriptor.Artifact.ManifestSHA256 = archiveURL, strings.Repeat("a", 64), 1, "zip", strings.Repeat("b", 64)
	return descriptor
}
func signedDescriptorSignature(private ed25519.PrivateKey, raw []byte) descriptorSignature {
	return signedDescriptorSignatureWithDomain(private, raw, "jobctrl:release-descriptor:v1\x00")
}
func signedDescriptorSignatureWithDomain(private ed25519.PrivateKey, raw []byte, domain string) descriptorSignature {
	encoded := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signingMessage(domain, raw)))
	return descriptorSignature{SchemaVersion: 1, Status: "signed", Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: &encoded}
}

func localFixture(t *testing.T, root string) (archivePath, descriptorPath, signaturePath string) {
	t.Helper()
	const runtimeManifest = `{"schemaVersion":1,"launcherProtocol":1,"ports":{"temporalGrpc":7233,"temporalUi":8233,"api":8766},"components":[{"name":"temporal","executable":"temporal/temporal","arguments":["server"]},{"name":"worker","executable":"python/bin/python3","arguments":["-I","-B","-m","jobctrl","worker"]},{"name":"api","executable":"node/bin/node","arguments":["${PAYLOAD_ROOT}/api/server.mjs"]}],"health":{"temporal":{"component":"temporal","arguments":["operator"]},"api":{"path":"/v1/health","requireWorkerHealthy":true,"requireWorkerPid":true}}}`
	files := []struct {
		path, text, component, componentPath, mode string
	}{
		{"components/jobctrl-api/payload", "api\n", "jobctrl-api", "components/jobctrl-api", "0644"},
		{"launcher/jobctrl", "#!/bin/sh\nexit 0\n", "jobctrl-launcher", "launcher/jobctrl", "0755"},
		{"components/jobctrl-web/payload", "web\n", "jobctrl-web", "components/jobctrl-web", "0644"},
		{"components/jobctrl-worker/payload", "worker\n", "jobctrl-worker", "components/jobctrl-worker", "0644"},
		{"components/node-runtime/payload", "node\n", "node-runtime", "components/node-runtime", "0644"},
		{"components/python-runtime/payload", "python\n", "python-runtime", "components/python-runtime", "0644"},
		{"launcher/runtime-manifest.json", runtimeManifest, "runtime-metadata", "launcher/runtime-manifest.json", "0644"},
		{"components/temporal-runtime/payload", "temporal\n", "temporal-runtime", "components/temporal-runtime", "0644"},
	}
	manifestFiles := make([]map[string]any, 0, len(files))
	for _, file := range files {
		digest := sha256.Sum256([]byte(file.text))
		manifestFiles = append(manifestFiles, map[string]any{"type": "file", "path": file.path, "sha256": hex.EncodeToString(digest[:]), "sizeBytes": len(file.text), "mode": file.mode})
	}
	sort.Slice(manifestFiles, func(left, right int) bool {
		return manifestFiles[left]["path"].(string) < manifestFiles[right]["path"].(string)
	})
	components := make([]map[string]any, 0, len(files))
	for _, file := range files {
		digestFile := sha256.Sum256([]byte(file.text))
		fileDigest := hex.EncodeToString(digestFile[:])
		canonical := fmt.Sprintf("%s\x00file\x00%s\x00%d\x00%s\n", file.path, fileDigest, len(file.text), file.mode)
		digest := sha256.Sum256([]byte(canonical))
		components = append(components, map[string]any{"id": file.component, "classification": "core-runtime", "version": "2.0.0", "owner": "JobCtrl", "source": "https://example.test/source", "license": "AGPL-3.0-only", "redistribution": "bundle", "path": file.componentPath, "sha256": hex.EncodeToString(digest[:]), "sizeBytes": len(file.text), "required": true})
	}
	sort.Slice(components, func(left, right int) bool { return components[left]["id"].(string) < components[right]["id"].(string) })
	manifest := map[string]any{"schemaVersion": 1, "appVersion": "2.0.0", "buildId": "fixture-build-0001", "releaseChannel": "local", "sourceDateEpoch": 0, "platform": map[string]any{"id": "darwin-arm64", "os": "darwin", "arch": "arm64", "minimumOsVersion": "15.0"}, "launcherCompatibility": map[string]any{"minimum": 1, "maximum": 1}, "components": components, "capabilities": []map[string]any{{"id": "core", "defaultEnabled": true, "componentIds": []string{"jobctrl-api", "jobctrl-launcher", "jobctrl-web", "jobctrl-worker", "node-runtime", "python-runtime", "temporal-runtime"}}}, "files": manifestFiles, "signing": map[string]any{"manifestAlgorithm": "ed25519", "manifestKeyId": "local-development", "codeSigning": "unsigned-local", "notarized": false}}
	manifestRaw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestSigRaw, _ := json.Marshal(map[string]any{"schemaVersion": 1, "status": "unsigned-local", "manifestAlgorithm": "ed25519", "manifestKeyId": "local-development", "signature": nil, "promotable": false})
	entries := []zipEntry{{"manifest.json", manifestRaw, 0o644}, {"manifest.sig", manifestSigRaw, 0o644}}
	for _, file := range files {
		mode := os.FileMode(0o644)
		if file.mode == "0755" {
			mode = 0o755
		}
		entries = append(entries, zipEntry{file.path, []byte(file.text), mode})
	}
	archivePath = writeZIP(t, entries)
	archiveBytes, err := os.ReadFile(archivePath)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := stableDescriptor("")
	descriptor.Channel = "local"
	descriptor.Artifact.URL = "file:///jobctrl-local-release/fixture.zip"
	descriptor.MinimumSafeSequence, descriptor.RevokedBuildIDs = 0, []string{}
	descriptor.Artifact.SHA256 = digestBytes(archiveBytes)
	descriptor.Artifact.SizeBytes = int64(len(archiveBytes))
	descriptor.Artifact.ManifestSHA256 = digestBytes(manifestRaw)
	descriptorRaw, _ := json.Marshal(descriptor)
	signatureRaw, _ := json.Marshal(descriptorSignature{SchemaVersion: 1, Status: "unsigned-local", Algorithm: "ed25519", KeyID: "local-development"})
	descriptorPath, signaturePath = filepath.Join(root, "descriptor.json"), filepath.Join(root, "descriptor.json.sig")
	if err := os.WriteFile(descriptorPath, descriptorRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, signatureRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	return archivePath, descriptorPath, signaturePath
}
