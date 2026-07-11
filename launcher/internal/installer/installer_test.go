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
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sort"
	"strconv"
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

func TestMacOSPayloadTrustUsesGatekeeperOnlyForOutermostApps(t *testing.T) {
	payload, launcherPath, nodePath, headlessShellPath, outerApp, nestedApp := macOSPayloadTrustFixture(t)
	type command struct {
		path string
		args []string
	}
	var calls []command
	runner := func(path string, args ...string) (string, error) {
		calls = append(calls, command{path: path, args: append([]string(nil), args...)})
		if path == "/usr/sbin/spctl" {
			return "source=Notarized Developer ID\n", nil
		}
		return "", nil
	}
	if err := verifyMacOSPayloadTrust(payload, runner); err != nil {
		t.Fatal(err)
	}

	var gatekeeperTargets []string
	standaloneNotarizationTargets := map[string]bool{}
	codeSignatureTargets := map[string]bool{}
	nestedBundleVerified := false
	for _, call := range calls {
		target := call.args[len(call.args)-1]
		if call.path == "/usr/sbin/spctl" {
			gatekeeperTargets = append(gatekeeperTargets, target)
		}
		if call.path != "/usr/bin/codesign" {
			continue
		}
		if containsString(call.args, "--check-notarization") && !containsString(call.args, "-R=notarized") {
			t.Fatalf("notarization check lacks an explicit notarized requirement: %#v", call)
		}
		if containsString(call.args, "--check-notarization") && !containsString(call.args, "--deep") {
			standaloneNotarizationTargets[target] = true
		}
		if containsString(call.args, "--strict") && !containsString(call.args, "--deep") {
			codeSignatureTargets[target] = true
		}
		if target == nestedApp && containsString(call.args, "--strict") && !containsString(call.args, "--check-notarization") {
			nestedBundleVerified = true
		}
	}
	if got, want := strings.Join(gatekeeperTargets, ","), outerApp; got != want {
		t.Fatalf("Gatekeeper targets = %q, want only outer app %q (calls: %#v)", got, want, calls)
	}
	for _, target := range []string{launcherPath, nodePath, headlessShellPath} {
		if !codeSignatureTargets[target] {
			t.Fatalf("raw executable missed strict codesign verification: %q (calls: %#v)", target, calls)
		}
		if !standaloneNotarizationTargets[target] {
			t.Fatalf("raw executable missed codesign notarization verification: %q (calls: %#v)", target, calls)
		}
	}
	if standaloneNotarizationTargets[outerApp] || standaloneNotarizationTargets[nestedApp] {
		t.Fatalf("app bundle used raw-executable notarization path: %#v", calls)
	}
	if !nestedBundleVerified {
		t.Fatalf("nested app bundle was not independently signature verified: %#v", calls)
	}
}

func TestMacOSPayloadTrustRejectsInvalidCodeSignatureOrNotarization(t *testing.T) {
	payload, _, nodePath, headlessShellPath, _, _ := macOSPayloadTrustFixture(t)
	for _, testCase := range []struct {
		name      string
		failsCall func(path string, args []string) bool
		contains  string
	}{
		{
			name: "invalid code signature",
			failsCall: func(path string, args []string) bool {
				return path == "/usr/bin/codesign" && args[len(args)-1] == headlessShellPath && !containsString(args, "--check-notarization")
			},
			contains: "code signature verification failed",
		},
		{
			name: "invalid standalone notarization",
			failsCall: func(path string, args []string) bool {
				return path == "/usr/bin/codesign" && args[len(args)-1] == nodePath && containsString(args, "--check-notarization")
			},
			contains: "Developer ID/notarization verification failed",
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			err := verifyMacOSPayloadTrust(payload, func(path string, args ...string) (string, error) {
				if testCase.failsCall(path, args) {
					return "", errors.New("fixture verification failure")
				}
				if path == "/usr/sbin/spctl" {
					return "source=Notarized Developer ID\n", nil
				}
				return "", nil
			})
			if err == nil || !strings.Contains(err.Error(), testCase.contains) {
				t.Fatalf("invalid trust check accepted: %v", err)
			}
		})
	}
}

func macOSPayloadTrustFixture(t *testing.T) (payload, launcherPath, nodePath, headlessShellPath, outerApp, nestedApp string) {
	t.Helper()
	payload = t.TempDir()
	launcherPath = filepath.Join(payload, "launcher", "jobctrl")
	nodePath = filepath.Join(payload, "node", "bin", "node")
	headlessShellPath = filepath.Join(payload, "chromium", "chrome-headless-shell-mac-arm64", "chrome-headless-shell")
	outerApp = filepath.Join(payload, "components", "Browser.app")
	nestedApp = filepath.Join(outerApp, "Contents", "Frameworks", "Browser Framework.framework", "Helpers", "Browser Helper.app")
	for _, executable := range []string{
		launcherPath,
		nodePath,
		headlessShellPath,
		filepath.Join(outerApp, "Contents", "MacOS", "Browser"),
		filepath.Join(nestedApp, "Contents", "MacOS", "Browser Helper"),
	} {
		if err := os.MkdirAll(filepath.Dir(executable), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(executable, []byte{0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0}, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return payload, launcherPath, nodePath, headlessShellPath, outerApp, nestedApp
}

func containsString(values []string, want string) bool {
	for _, value := range values {
		if value == want {
			return true
		}
	}
	return false
}

func TestUnsignedLocalDescriptorCannotCrossNetworkBoundary(t *testing.T) {
	descriptor := stableDescriptor("https://example.test/jobctrl.zip")
	descriptor.Channel = "local"
	descriptor.SourceCommit = ""
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
	descriptor.SourceCommit = ""
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

func TestNetworkChannelPointerResolvesOnlyItsImmutablePair(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	descriptor, descriptorRaw, signatureRaw, pointer, pointerRaw := signedChannelPointerFixture(t, private, "stable")
	client, requests := channelPointerClient(map[string][]byte{
		mustDefaultReleaseURL(t, "stable"): pointerRaw,
		pointer.Descriptor.URL:             descriptorRaw,
		pointer.Signature.URL:              signatureRaw,
	})
	resolved, resolvedRaw, resolvedURL, err := resolveNetworkRelease(Options{
		Policy:     launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true},
		Trust:      map[string]ed25519.PublicKey{"jobctrl-release-v1": public},
		HTTPClient: client,
	}, client)
	if err != nil {
		t.Fatalf("resolve channel pointer: %v", err)
	}
	if resolved.BuildID != descriptor.BuildID || resolved.Channel != descriptor.Channel || resolved.Sequence != descriptor.Sequence || !bytes.Equal(resolvedRaw, descriptorRaw) || resolvedURL != pointer.Descriptor.URL {
		t.Fatalf("resolved immutable release = %#v, %q, %q", resolved, resolvedRaw, resolvedURL)
	}
	for url, want := range map[string]int{mustDefaultReleaseURL(t, "stable"): 1, pointer.Descriptor.URL: 1, pointer.Signature.URL: 1, mustDefaultReleaseURL(t, "stable") + ".sig": 0} {
		if got := requests[url]; got != want {
			t.Fatalf("requests for %s = %d, want %d (all: %#v)", url, got, want, requests)
		}
	}
}

func TestNetworkChannelPointerHashesBothImmutableFilesBeforeSignatureVerification(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, descriptorRaw, signatureRaw, pointer, _ := signedChannelPointerFixture(t, private, "stable")
	for _, testCase := range []struct {
		name   string
		mutate func(*channelPointer)
		body   map[string][]byte
	}{
		{
			name:   "descriptor",
			mutate: func(pointer *channelPointer) { pointer.Descriptor.SHA256 = strings.Repeat("0", 64) },
			body:   map[string][]byte{},
		},
		{
			name:   "signature",
			mutate: func(pointer *channelPointer) { pointer.Signature.SHA256 = strings.Repeat("0", 64) },
			body:   map[string][]byte{},
		},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			mutated := pointer
			testCase.mutate(&mutated)
			mutatedRaw, err := json.Marshal(mutated)
			if err != nil {
				t.Fatal(err)
			}
			body := map[string][]byte{
				mustDefaultReleaseURL(t, "stable"): mutatedRaw,
				pointer.Descriptor.URL:             descriptorRaw,
				pointer.Signature.URL:              signatureRaw,
			}
			for url, value := range testCase.body {
				body[url] = value
			}
			client, _ := channelPointerClient(body)
			_, _, _, err = resolveNetworkRelease(Options{Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, HTTPClient: client}, client)
			if err == nil || !strings.Contains(err.Error(), "SHA-256") {
				t.Fatalf("mismatched %s digest reached signature verification: %v", testCase.name, err)
			}
		})
	}
}

func TestChannelPointerIdentityMustEqualDescriptor(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	descriptor, _, _, pointer, _ := signedChannelPointerFixture(t, private, "stable")
	for _, testCase := range []struct {
		name   string
		mutate func(*channelPointer)
	}{
		{"channel", func(pointer *channelPointer) { pointer.Channel = "prerelease" }},
		{"platform-id", func(pointer *channelPointer) { pointer.Platform.ID = "darwin-x64" }},
		{"platform-os", func(pointer *channelPointer) { pointer.Platform.OS = "linux" }},
		{"platform-arch", func(pointer *channelPointer) { pointer.Platform.Arch = "amd64" }},
		{"source-commit", func(pointer *channelPointer) { pointer.SourceCommit = strings.Repeat("b", 40) }},
		{"build-id", func(pointer *channelPointer) { pointer.BuildID = "fixture-build-0002" }},
		{"sequence", func(pointer *channelPointer) { pointer.Sequence++ }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			mutated := pointer
			testCase.mutate(&mutated)
			if err := verifyPointerDescriptorIdentity(mutated, descriptor); err == nil {
				t.Fatal("pointer identity mismatch accepted")
			}
		})
	}
}

func TestChannelPointerRejectsExtraFieldsAndURLAliases(t *testing.T) {
	_, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, _, _, pointer, pointerRaw := signedChannelPointerFixture(t, private, "stable")
	var document map[string]any
	if err := json.Unmarshal(pointerRaw, &document); err != nil {
		t.Fatal(err)
	}
	document["unexpected"] = true
	extraRaw, _ := json.Marshal(document)
	if _, _, _, err := validateReleaseChannelPointer(extraRaw, "stable"); err == nil {
		t.Fatal("channel pointer accepted an extra root field")
	}
	document = map[string]any{}
	if err := json.Unmarshal(pointerRaw, &document); err != nil {
		t.Fatal(err)
	}
	descriptorDocument := document["descriptor"].(map[string]any)
	descriptorDocument["unexpected"] = true
	extraRaw, _ = json.Marshal(document)
	if _, _, _, err := validateReleaseChannelPointer(extraRaw, "stable"); err == nil {
		t.Fatal("channel pointer accepted an extra nested field")
	}
	for _, attack := range []string{
		"https://attacker@releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json",
		"https://releases.jobctrl.dev:443/v1/artifacts/fixture-build-0001/release-descriptor.json",
		"https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json?next=attacker",
		"https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json#fragment",
		"https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/%72elease-descriptor.json",
	} {
		mutated := pointer
		mutated.Descriptor.URL = attack
		raw, _ := json.Marshal(mutated)
		if _, _, _, err := validateReleaseChannelPointer(raw, "stable"); err == nil {
			t.Fatalf("channel pointer accepted URL attack %q", attack)
		}
	}
	for _, attack := range []string{
		"https://releases.jobctrl.dev:443/v1/stable/darwin-arm64.json",
		"https://releases.jobctrl.dev/v1/stable/darwin-arm64.json?next=attacker",
		"https://releases.jobctrl.dev/v1/stable/%64arwin-arm64.json",
	} {
		if _, err := validateChannelPointerURL(attack, "stable"); err == nil {
			t.Fatalf("channel pointer URL accepted alias %q", attack)
		}
	}
}

func TestInvalidChannelPointerNeverDownloadsArchiveOrCreatesState(t *testing.T) {
	invalidPointer := []byte(`{"schemaVersion":1,"channel":"stable","platform":{"id":"darwin-arm64","os":"darwin","arch":"arm64"},"sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","buildId":"short","sequence":1,"descriptor":{"url":"https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json","sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},"signature":{"url":"https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json.sig","sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"}}`)
	client, requests := channelPointerClient(map[string][]byte{mustDefaultReleaseURL(t, "stable"): invalidPointer})
	home := filepath.Join(t.TempDir(), "runtime")
	_, err := InstallFromNetwork(Options{Home: home, Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, HTTPClient: client})
	if err == nil || !strings.Contains(err.Error(), "pointer") {
		t.Fatalf("invalid pointer accepted: %v", err)
	}
	if len(requests) != 1 || requests[mustDefaultReleaseURL(t, "stable")] != 1 {
		t.Fatalf("invalid pointer fetched immutable bytes or archive: %#v", requests)
	}
	if _, statErr := os.Stat(home); !os.IsNotExist(statErr) {
		t.Fatalf("invalid pointer changed installer state: %v", statErr)
	}
}

func TestCachedFilesRejectChannelPointerURL(t *testing.T) {
	_, err := InstallFromCachedFiles(Options{Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}}, mustDefaultReleaseURL(t, "stable"), "never-read.json", "never-read.sig", "never-read.zip")
	if err == nil || !strings.Contains(err.Error(), "immutable") {
		t.Fatalf("cached acquisition accepted a mutable channel pointer URL: %v", err)
	}
}

func TestNetworkDefaultPointerUsesCompiledPrereleaseChannel(t *testing.T) {
	if got, want := mustDefaultReleaseURL(t, "prerelease"), "https://releases.jobctrl.dev/v1/prerelease/darwin-arm64.json"; got != want {
		t.Fatalf("prerelease default pointer = %q, want %q", got, want)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, descriptorRaw, signatureRaw, pointer, pointerRaw := signedChannelPointerFixture(t, private, "prerelease")
	client, requests := channelPointerClient(map[string][]byte{
		mustDefaultReleaseURL(t, "prerelease"): pointerRaw,
		pointer.Descriptor.URL:                 descriptorRaw,
		pointer.Signature.URL:                  signatureRaw,
	})
	if _, _, _, err := resolveNetworkRelease(Options{Policy: launcher.AcquisitionPolicy{ExpectedChannel: "prerelease", AllowNetwork: true}, Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, HTTPClient: client}, client); err != nil {
		t.Fatalf("resolve prerelease default pointer: %v", err)
	}
	if requests[mustDefaultReleaseURL(t, "prerelease")] != 1 || requests[mustDefaultReleaseURL(t, "stable")] != 0 {
		t.Fatalf("compiled prerelease installer followed the wrong pointer: %#v", requests)
	}
}

func TestNetworkChannelPointerAllowsOnlyOneExplicitLoopbackOrigin(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	var pointerRaw, descriptorRaw, signatureRaw []byte
	var requests []string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		requests = append(requests, request.URL.Path)
		var body []byte
		switch request.URL.Path {
		case "/v1/stable/darwin-arm64.json":
			body = pointerRaw
		case "/v1/artifacts/fixture-build-0001/release-descriptor.json":
			body = descriptorRaw
		case "/v1/artifacts/fixture-build-0001/release-descriptor.json.sig":
			body = signatureRaw
		default:
			http.NotFound(response, request)
			return
		}
		response.Header().Set("Content-Length", strconv.Itoa(len(body)))
		_, _ = response.Write(body)
	}))
	defer server.Close()
	_, descriptorRaw, signatureRaw, pointer, pointerRaw := signedChannelPointerFixtureAtOrigin(t, private, "stable", server.URL)
	resolved, _, descriptorURL, err := resolveNetworkRelease(Options{
		ReleaseURL:        server.URL + "/v1/stable/darwin-arm64.json",
		Policy:            launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true},
		Trust:             map[string]ed25519.PublicKey{"jobctrl-release-v1": public},
		HTTPClient:        server.Client(),
		AllowHTTPLoopback: true,
	}, server.Client())
	if err != nil || resolved.BuildID != pointer.BuildID || descriptorURL != pointer.Descriptor.URL {
		t.Fatalf("loopback pointer resolution = %#v, %q, %v", resolved, descriptorURL, err)
	}
	if got, want := strings.Join(requests, ","), "/v1/stable/darwin-arm64.json,/v1/artifacts/fixture-build-0001/release-descriptor.json,/v1/artifacts/fixture-build-0001/release-descriptor.json.sig"; got != want {
		t.Fatalf("loopback requests = %q, want %q", got, want)
	}

	other := httptest.NewServer(http.NotFoundHandler())
	defer other.Close()
	pointer.Descriptor.URL = other.URL + "/v1/artifacts/fixture-build-0001/release-descriptor.json"
	pointerRaw, err = json.Marshal(pointer)
	if err != nil {
		t.Fatal(err)
	}
	requests = nil
	_, _, _, err = resolveNetworkRelease(Options{
		ReleaseURL:        server.URL + "/v1/stable/darwin-arm64.json",
		Policy:            launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true},
		Trust:             map[string]ed25519.PublicKey{"jobctrl-release-v1": public},
		HTTPClient:        server.Client(),
		AllowHTTPLoopback: true,
	}, server.Client())
	if err == nil || !strings.Contains(err.Error(), "origin") {
		t.Fatalf("cross-origin loopback pointer accepted: %v", err)
	}
	if got, want := strings.Join(requests, ","), "/v1/stable/darwin-arm64.json"; got != want {
		t.Fatalf("cross-origin pointer fetched immutable content: %q", got)
	}
}

func TestImmutableStagingChannelPointerMustNameItsBuild(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	_, descriptorRaw, signatureRaw, pointer, pointerRaw := signedChannelPointerFixture(t, private, "stable")
	stagingURL := "https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/channel-pointer.json"
	client, _ := channelPointerClient(map[string][]byte{
		stagingURL:             pointerRaw,
		pointer.Descriptor.URL: descriptorRaw,
		pointer.Signature.URL:  signatureRaw,
	})
	if _, _, resolvedURL, err := resolveNetworkRelease(Options{ReleaseURL: stagingURL, Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, HTTPClient: client}, client); err != nil || resolvedURL != pointer.Descriptor.URL {
		t.Fatalf("staging pointer resolution = %q, %v", resolvedURL, err)
	}
	mismatchURL := "https://releases.jobctrl.dev/v1/artifacts/fixture-build-0002/channel-pointer.json"
	client, requests := channelPointerClient(map[string][]byte{mismatchURL: pointerRaw})
	if _, _, _, err := resolveNetworkRelease(Options{ReleaseURL: mismatchURL, Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, HTTPClient: client}, client); err == nil || !strings.Contains(err.Error(), "build identity") {
		t.Fatalf("mismatched staging pointer URL accepted: %v", err)
	}
	if len(requests) != 1 || requests[mismatchURL] != 1 {
		t.Fatalf("mismatched staging pointer fetched immutable content: %#v", requests)
	}
}

func TestCachedImmutableDescriptorRejectsSameOriginWrongArtifactPath(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := stableDescriptor("https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/not-jobctrl.zip")
	descriptorRaw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	signatureRaw, err := json.Marshal(signedDescriptorSignature(private, descriptorRaw))
	if err != nil {
		t.Fatal(err)
	}
	root := t.TempDir()
	descriptorPath, signaturePath := filepath.Join(root, "descriptor.json"), filepath.Join(root, "descriptor.json.sig")
	if err := os.WriteFile(descriptorPath, descriptorRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(signaturePath, signatureRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	_, err = InstallFromCachedFiles(Options{Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}}, "https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json", descriptorPath, signaturePath, filepath.Join(root, "never-read.zip"))
	if err == nil || !strings.Contains(err.Error(), "artifact URL") {
		t.Fatalf("cached descriptor accepted same-origin wrong artifact path: %v", err)
	}
}

func TestSignedCachedFilesNeverAcceptUnsignedLocalFixtures(t *testing.T) {
	root := t.TempDir()
	archive, descriptor, signature := localFixture(t, root)
	_, err := InstallFromCachedFiles(Options{Home: filepath.Join(root, "runtime")}, "https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json", descriptor, signature, archive)
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
	descriptor := stableDescriptor("https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/jobctrl-2.0.0-darwin-arm64.zip")
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
	if _, err := InstallFromCachedFiles(options, "https://releases.jobctrl.dev/v1/artifacts/fixture-build-0001/release-descriptor.json", descriptorPath, signaturePath, filepath.Join(root, "never-read.zip")); err == nil || !strings.Contains(err.Error(), "does not match compiled installer channel") {
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
	descriptor.SchemaVersion, descriptor.Channel, descriptor.Sequence, descriptor.BuildID, descriptor.AppVersion, descriptor.SourceCommit = 1, "stable", 1, "fixture-build-0001", "2.0.0", strings.Repeat("a", 40)
	descriptor.MinimumSafeSequence, descriptor.RevokedBuildIDs = 1, []string{}
	descriptor.Platform.ID, descriptor.Platform.OS, descriptor.Platform.Arch = "darwin-arm64", "darwin", "arm64"
	descriptor.Artifact.URL, descriptor.Artifact.SHA256, descriptor.Artifact.SizeBytes, descriptor.Artifact.ArchiveType, descriptor.Artifact.ManifestSHA256 = archiveURL, strings.Repeat("a", 64), 1, "zip", strings.Repeat("b", 64)
	return descriptor
}

func signedChannelPointerFixture(t *testing.T, private ed25519.PrivateKey, channel string) (Descriptor, []byte, []byte, channelPointer, []byte) {
	return signedChannelPointerFixtureAtOrigin(t, private, channel, "https://releases.jobctrl.dev")
}

func signedChannelPointerFixtureAtOrigin(t *testing.T, private ed25519.PrivateKey, channel, origin string) (Descriptor, []byte, []byte, channelPointer, []byte) {
	t.Helper()
	descriptor := stableDescriptor(origin + "/v1/artifacts/fixture-build-0001/jobctrl-2.0.0-darwin-arm64.zip")
	descriptor.Channel = channel
	descriptorRaw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	signatureRaw, err := json.Marshal(signedDescriptorSignature(private, descriptorRaw))
	if err != nil {
		t.Fatal(err)
	}
	pointer := channelPointer{
		SchemaVersion: 1,
		Channel:       descriptor.Channel,
		SourceCommit:  descriptor.SourceCommit,
		BuildID:       descriptor.BuildID,
		Sequence:      descriptor.Sequence,
		Descriptor: pointerAsset{
			URL:    origin + "/v1/artifacts/fixture-build-0001/release-descriptor.json",
			SHA256: digestBytes(descriptorRaw),
		},
		Signature: pointerAsset{
			URL:    origin + "/v1/artifacts/fixture-build-0001/release-descriptor.json.sig",
			SHA256: digestBytes(signatureRaw),
		},
	}
	pointer.Platform.ID, pointer.Platform.OS, pointer.Platform.Arch = descriptor.Platform.ID, descriptor.Platform.OS, descriptor.Platform.Arch
	pointerRaw, err := json.Marshal(pointer)
	if err != nil {
		t.Fatal(err)
	}
	return descriptor, descriptorRaw, signatureRaw, pointer, pointerRaw
}

func mustDefaultReleaseURL(t *testing.T, channel string) string {
	t.Helper()
	url, err := DefaultReleaseURL(channel)
	if err != nil {
		t.Fatal(err)
	}
	return url
}

type channelPointerRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip channelPointerRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func channelPointerClient(responses map[string][]byte) (*http.Client, map[string]int) {
	requests := map[string]int{}
	return &http.Client{Transport: channelPointerRoundTripper(func(request *http.Request) (*http.Response, error) {
		key := request.URL.String()
		requests[key]++
		body, exists := responses[key]
		if !exists {
			return nil, fmt.Errorf("unexpected request for %s", key)
		}
		return &http.Response{
			StatusCode:    http.StatusOK,
			Status:        "200 OK",
			Header:        http.Header{"Content-Length": []string{strconv.Itoa(len(body))}},
			Body:          io.NopCloser(bytes.NewReader(body)),
			ContentLength: int64(len(body)),
			Request:       request,
		}, nil
	})}, requests
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
	descriptor.SourceCommit = ""
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
