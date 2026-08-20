package launcher

import (
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
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const validRuntimeManifest = `{
  "schemaVersion":1,"launcherProtocol":1,
  "ports":{"temporalGrpc":7233,"temporalUi":8233,"api":8766},
  "components":[
    {"name":"temporal","executable":"temporal/temporal","arguments":["server"]},
    {"name":"worker","executable":"python/bin/python3","arguments":["-I","-B","-m","jobctrl","worker"]},
    {"name":"api","executable":"node/bin/node","arguments":["${PAYLOAD_ROOT}/api/server.mjs"]}
  ],
  "health":{"temporal":{"component":"temporal","arguments":["operator"]},"api":{"path":"/v1/health","requireWorkerHealthy":true,"requireWorkerPid":true}}
}`

const loopbackOnlySandboxProfile = `(version 1)
(allow default)
(deny network-outbound (remote ip))
(allow network-outbound (remote ip "localhost:*"))`

func TestSandboxedNativeProcessIdentity(t *testing.T) {
	if os.Getenv("JOBCTRL_SANDBOX_IDENTITY_HELPER") == "1" {
		identity, err := processStartIdentity(os.Getpid())
		if err != nil || identity == "" {
			fmt.Fprintf(os.Stderr, "identity: %v", err)
			os.Exit(2)
		}
		executable, err := CurrentProcessExecutable()
		if err != nil || executable == "" {
			fmt.Fprintf(os.Stderr, "executable: %v", err)
			os.Exit(3)
		}
		os.Exit(0)
	}
	if _, err := os.Stat("/usr/bin/sandbox-exec"); err != nil {
		t.Skip("sandbox-exec is unavailable")
	}
	command := exec.Command("/usr/bin/sandbox-exec", "-p", loopbackOnlySandboxProfile, os.Args[0], "-test.run=^TestSandboxedNativeProcessIdentity$")
	command.Env = append(os.Environ(), "JOBCTRL_SANDBOX_IDENTITY_HELPER=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native process identity failed in exact loopback sandbox: %v\n%s", err, output)
	}
}

func writeTestFile(t *testing.T, name, contents string) string {
	t.Helper()
	path := filepath.Join(t.TempDir(), name)
	if err := os.WriteFile(path, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRuntimeManifestRejectsUnknownFieldsAndUnsafePaths(t *testing.T) {
	for name, manifest := range map[string]string{
		"unknown":           strings.Replace(validRuntimeManifest, `"schemaVersion":1`, `"schemaVersion":1,"surprise":true`, 1),
		"unsafe executable": strings.Replace(validRuntimeManifest, `"temporal/temporal"`, `"../temporal"`, 1),
		"dynamic port":      strings.Replace(validRuntimeManifest, `"api":8766`, `"api":9876`, 1),
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := loadRuntimeManifest(writeTestFile(t, "runtime.json", manifest)); err == nil {
				t.Fatal("expected manifest rejection")
			}
		})
	}
}

func TestLifecycleExitCodesAreStable(t *testing.T) {
	for _, item := range []struct {
		name string
		err  error
		want int
	}{
		{"success", nil, 0},
		{"general", errors.New("general failure"), 1},
		{"lock", ErrLockHeld, 75},
		{"wrapped lock", fmt.Errorf("context: %w", ErrLockHeld), 75},
		{"already running", ErrAlreadyRunning, 75},
		{"port conflict", ErrPortInUse, 69},
	} {
		t.Run(item.name, func(t *testing.T) {
			if got := ExitCode(item.err); got != item.want {
				t.Fatalf("ExitCode(%v) = %d, want %d", item.err, got, item.want)
			}
		})
	}
}

func TestUninstallRemainsAvailableDuringInterruptedTransition(t *testing.T) {
	for _, args := range [][]string{{"rollback"}, {"uninstall"}, {"uninstall", "--remove-data"}} {
		if !transitionRecoveryCommand(args) {
			t.Fatalf("recovery command was blocked by transition journal: %v", args)
		}
	}
	for _, args := range [][]string{nil, {"start"}, {"update"}, {"status"}} {
		if transitionRecoveryCommand(args) {
			t.Fatalf("ordinary command bypassed transition journal: %v", args)
		}
	}
}

func TestAcquisitionBuildPolicyFailsClosedOutsideItsCompiledChannel(t *testing.T) {
	previousChannel, previousKey := releaseChannel, releaseTrustKeyBase64
	t.Cleanup(func() { releaseChannel, releaseTrustKeyBase64 = previousChannel, previousKey })
	releaseTrustKeyBase64 = ""
	releaseChannel = "local"
	policy, err := AcquisitionBuildPolicy()
	if err != nil || !policy.AllowUnsignedLocal || policy.AllowNetwork || policy.ExpectedChannel != "local" {
		t.Fatalf("local policy = %#v, %v", policy, err)
	}
	releaseTrustKeyBase64 = base64.StdEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))
	releaseChannel = "stable"
	policy, err = AcquisitionBuildPolicy()
	if err != nil || policy.AllowUnsignedLocal || !policy.AllowNetwork || policy.ExpectedChannel != "stable" {
		t.Fatalf("stable policy = %#v, %v", policy, err)
	}
	releaseChannel = "prerelease"
	policy, err = AcquisitionBuildPolicy()
	if err != nil || policy.ExpectedChannel != "prerelease" || policy.AllowUnsignedLocal {
		t.Fatalf("prerelease policy = %#v, %v", policy, err)
	}
	releaseChannel = "local"
	if _, err := AcquisitionBuildPolicy(); err == nil {
		t.Fatal("local channel with embedded release key was accepted")
	}
}

func TestDevCompatibilityAliasUsesTheStartEntrypointAndArgumentContract(t *testing.T) {
	previous := startCommand
	defer func() { startCommand = previous }()
	sentinel := errors.New("start was selected")
	var calls [][]string
	startCommand = func(_ launchContext, args []string, _ io.Writer) error {
		calls = append(calls, append([]string(nil), args...))
		return sentinel
	}
	var stdout, stderr bytes.Buffer
	if err := dispatchCommand(launchContext{}, []string{"dev", "--no-open", "--foreground"}, &stdout, &stderr); !errors.Is(err, sentinel) {
		t.Fatalf("dev alias result = %v, want start result", err)
	}
	if got, want := calls, [][]string{{"--no-open", "--foreground"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("dev alias start args = %#v, want %#v", got, want)
	}
	if !strings.Contains(stderr.String(), "deprecated") || !strings.Contains(stderr.String(), "jobctrl start") {
		t.Fatalf("missing dev deprecation warning: %q", stderr.String())
	}
	if err := dispatchCommand(launchContext{}, []string{"start", "--no-open"}, &stdout, &stderr); !errors.Is(err, sentinel) {
		t.Fatalf("start result = %v, want same start entrypoint", err)
	}
	if got, want := calls, [][]string{{"--no-open", "--foreground"}, {"--no-open"}}; !reflect.DeepEqual(got, want) {
		t.Fatalf("start entrypoint calls = %#v, want %#v", got, want)
	}

	startCommand = executeStart
	for _, command := range []string{"start", "dev"} {
		err := dispatchCommand(launchContext{}, []string{command, "--unsupported"}, io.Discard, io.Discard)
		if err == nil || err.Error() != `unknown start option "--unsupported"` {
			t.Fatalf("%s unsupported-argument error = %v", command, err)
		}
	}
	var help bytes.Buffer
	printHelp(&help)
	if !strings.Contains(help.String(), "jobctrl dev [--no-open] [--foreground]  (deprecated alias for start)") {
		t.Fatalf("help omits dev compatibility alias: %q", help.String())
	}
}

func TestPayloadVerificationRejectsTamperingUnknownFilesAndEscapingSymlinks(t *testing.T) {
	for _, mutate := range []struct {
		name  string
		apply func(t *testing.T, root string)
	}{
		{"tampered file", func(t *testing.T, root string) {
			t.Helper()
			if err := os.WriteFile(filepath.Join(root, "safe.txt"), []byte("changed"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"unrecorded file", func(t *testing.T, root string) {
			t.Helper()
			if err := os.WriteFile(filepath.Join(root, "extra.txt"), []byte("extra"), 0o644); err != nil {
				t.Fatal(err)
			}
		}},
		{"escaping symlink", func(t *testing.T, root string) {
			t.Helper()
			if err := os.Remove(filepath.Join(root, "launcher", "links", "to-safe")); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink("../../outside", filepath.Join(root, "launcher", "links", "to-safe")); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(mutate.name, func(t *testing.T) {
			root, manifest := verifiedPayloadFixture(t)
			writeLocalEnvelope(t, root, manifest)
			mutate.apply(t, root)
			if _, err := loadAndVerifyDistributionManifest(root); err == nil {
				t.Fatal("expected manifest loader payload verification failure")
			}
		})
	}
}

func TestPayloadVerificationPermitsSafeRelativeParentSymlink(t *testing.T) {
	root, manifest := verifiedPayloadFixture(t)
	if err := verifyPayloadTree(root, manifest); err != nil {
		t.Fatalf("safe relative symlink rejected: %v", err)
	}
}

func TestDistributionLoaderPermitsConfinedParentRelativeSymlink(t *testing.T) {
	root, manifest := verifiedPayloadFixture(t)
	writeLocalEnvelope(t, root, manifest)
	if _, err := loadAndVerifyDistributionManifest(root); err != nil {
		t.Fatalf("safe parent-relative symlink rejected by envelope loader: %v", err)
	}
}

func TestSignedManifestUsesDedicatedEd25519Domain(t *testing.T) {
	root, manifest := verifiedPayloadFixture(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	manifest.ReleaseChannel = "stable"
	manifest.Signing.ManifestKeyID = "jobctrl-release-v1"
	manifest.Signing.CodeSigning = "developer-id"
	manifest.Signing.Notarized = true
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	encoded := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:manifest:v1\x00", raw)))
	signatureRaw, err := json.Marshal(manifestSignature{SchemaVersion: 1, Status: "signed", ManifestAlgorithm: "ed25519", ManifestKeyID: "jobctrl-release-v1", Signature: &encoded, Promotable: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.sig"), signatureRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	trust := DistributionTrust{PublicKeys: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, ExpectedChannel: "stable"}
	if _, err := VerifyDistributionPayload(root, trust); err != nil {
		t.Fatalf("valid signed manifest rejected: %v", err)
	}
	wrong, _, _ := ed25519.GenerateKey(rand.Reader)
	if _, err := VerifyDistributionPayload(root, DistributionTrust{PublicKeys: map[string]ed25519.PublicKey{"jobctrl-release-v1": wrong}, ExpectedChannel: "stable"}); err == nil {
		t.Fatal("wrong manifest key accepted")
	}
	encoded = base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:release-descriptor:v1\x00", raw)))
	signatureRaw, _ = json.Marshal(manifestSignature{SchemaVersion: 1, Status: "signed", ManifestAlgorithm: "ed25519", ManifestKeyID: "jobctrl-release-v1", Signature: &encoded, Promotable: true})
	if err := os.WriteFile(filepath.Join(root, "manifest.sig"), signatureRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := VerifyDistributionPayload(root, trust); err == nil {
		t.Fatal("cross-domain descriptor signature accepted as manifest")
	}
}

func TestPublicRuntimeSelectorResolvesTheCurrentImmutablePayload(t *testing.T) {
	home := t.TempDir()
	if err := os.MkdirAll(filepath.Join(home, "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	selector := filepath.Join(home, "bin", "jobctrl")
	if err := os.WriteFile(selector, []byte("selector"), 0o755); err != nil {
		t.Fatal(err)
	}
	receipt := `{"schemaVersion":1,"buildId":"local-test-build","channel":"local","sequence":1,"artifactSha256":"` + strings.Repeat("a", 64) + `","manifestSha256":"` + strings.Repeat("b", 64) + `","descriptorSha256":"` + strings.Repeat("c", 64) + `","descriptorUrl":"local-fixture","installedAt":"2026-01-01T00:00:00Z"}`
	if err := os.WriteFile(filepath.Join(home, "current.json"), []byte(receipt), 0o600); err != nil {
		t.Fatal(err)
	}
	root, _, err := locatePayloadRoot(selector, []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + home})
	if err != nil {
		t.Fatal(err)
	}
	canonicalHome, err := filepath.EvalSymlinks(home)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(canonicalHome, "releases", "local-test-build", "payload")
	if root != want {
		t.Fatalf("selector payload = %q, want %q", root, want)
	}
}

func TestSelectorReceiptBindsCurrentPointerToVerifiedPayloadAndImmutableReceipt(t *testing.T) {
	home := t.TempDir()
	payload := filepath.Join(home, "releases", "local-test-build", "payload")
	if err := os.MkdirAll(payload, 0o700); err != nil {
		t.Fatal(err)
	}
	manifestRaw := []byte(`{"signed":"manifest"}`)
	if err := os.WriteFile(filepath.Join(payload, "manifest.json"), manifestRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(manifestRaw)
	receipt := selectorReceipt{SchemaVersion: 1, BuildID: "local-test-build", Channel: "local", Sequence: 1, ArtifactSHA256: strings.Repeat("a", 64), ManifestSHA256: hex.EncodeToString(digest[:]), DescriptorSHA256: strings.Repeat("b", 64), DescriptorURL: "local-fixture", InstalledAt: "2026-01-01T00:00:00Z"}
	raw, err := json.Marshal(receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(home, "releases", "local-test-build", "receipt.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	manifest := distributionManifest{BuildID: "local-test-build", ReleaseChannel: "local"}
	if err := verifySelectorReceipt(payload, manifest, receipt); err != nil {
		t.Fatalf("matching selector receipt rejected: %v", err)
	}
	tampered := receipt
	tampered.ManifestSHA256 = strings.Repeat("c", 64)
	if err := verifySelectorReceipt(payload, manifest, tampered); err == nil {
		t.Fatal("manifest-digest mismatch accepted")
	}
	tampered = receipt
	tampered.Channel = "stable"
	if err := verifySelectorReceipt(payload, manifest, tampered); err == nil {
		t.Fatal("release-channel mismatch accepted")
	}
	immutable := receipt
	immutable.Sequence = 2
	raw, _ = json.Marshal(immutable)
	if err := os.WriteFile(filepath.Join(home, "releases", "local-test-build", "receipt.json"), raw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := verifySelectorReceipt(payload, manifest, receipt); err == nil {
		t.Fatal("current receipt differing from immutable release receipt accepted")
	}
}

func mutateJSONFile(t *testing.T, path string, mutate func(map[string]any)) {
	t.Helper()
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(contents, &value); err != nil {
		t.Fatal(err)
	}
	mutate(value)
	contents, err = json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, contents, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestDistributionLoaderRejectsIncompleteAndMalformedV1Envelopes(t *testing.T) {
	for name, mutate := range map[string]func(t *testing.T, root string){
		"missing platform": func(t *testing.T, root string) {
			mutateJSONFile(t, filepath.Join(root, "manifest.json"), func(value map[string]any) { delete(value, "platform") })
		},
		"missing runtime component": func(t *testing.T, root string) {
			mutateJSONFile(t, filepath.Join(root, "manifest.json"), func(value map[string]any) {
				components := value["components"].([]any)
				value["components"] = components[1:]
			})
		},
		"capability references unknown component": func(t *testing.T, root string) {
			mutateJSONFile(t, filepath.Join(root, "manifest.json"), func(value map[string]any) {
				capabilities := value["capabilities"].([]any)
				capabilities[0].(map[string]any)["componentIds"] = []string{"not-a-component"}
			})
		},
		"unsafe regular mode": func(t *testing.T, root string) {
			mutateJSONFile(t, filepath.Join(root, "manifest.json"), func(value map[string]any) {
				value["files"].([]any)[0].(map[string]any)["mode"] = "0777"
			})
		},
		"nonprintable file path": func(t *testing.T, root string) {
			mutateJSONFile(t, filepath.Join(root, "manifest.json"), func(value map[string]any) {
				value["files"].([]any)[0].(map[string]any)["path"] = "api/\x01payload"
			})
		},
		"file without exactly one owner": func(t *testing.T, root string) {
			mutateJSONFile(t, filepath.Join(root, "manifest.json"), func(value map[string]any) {
				value["files"].([]any)[0].(map[string]any)["path"] = "orphan/payload"
			})
		},
		"signature key binding mismatch": func(t *testing.T, root string) {
			mutateJSONFile(t, filepath.Join(root, "manifest.sig"), func(value map[string]any) { value["manifestKeyId"] = "wrong-key" })
		},
		"signature schema missing promotable": func(t *testing.T, root string) {
			mutateJSONFile(t, filepath.Join(root, "manifest.sig"), func(value map[string]any) { delete(value, "promotable") })
		},
	} {
		t.Run(name, func(t *testing.T) {
			root, manifest := verifiedPayloadFixture(t)
			writeLocalEnvelope(t, root, manifest)
			mutate(t, root)
			if _, err := loadAndVerifyDistributionManifest(root); err == nil {
				t.Fatal("malformed v1 distribution envelope was accepted")
			}
		})
	}
}

func verifiedPayloadFixture(t *testing.T) (string, distributionManifest) {
	t.Helper()
	root := t.TempDir()
	type fixtureFile struct {
		path     string
		contents string
		mode     os.FileMode
		target   string
	}
	files := []fixtureFile{
		{path: "api/payload", contents: "api", mode: 0o644},
		{path: "launcher/links/to-safe", target: "../safe.txt"},
		{path: "launcher/safe.txt", contents: "safe payload", mode: 0o644},
		{path: "node/payload", contents: "node", mode: 0o644},
		{path: "python/payload", contents: "python", mode: 0o644},
		{path: "temporal/payload", contents: "temporal", mode: 0o644},
		{path: "web/payload", contents: "web", mode: 0o644},
		{path: "worker/payload", contents: "worker", mode: 0o644},
	}
	for _, file := range files {
		path := filepath.Join(root, file.path)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if file.target != "" {
			if err := os.Symlink(file.target, path); err != nil {
				t.Fatal(err)
			}
		} else if err := os.WriteFile(path, []byte(file.contents), file.mode); err != nil {
			t.Fatal(err)
		}
	}
	type fileRecord struct {
		typeName string
		path     string
		sha256   string
		target   string
		size     int64
		mode     string
	}
	records := make([]fileRecord, 0, len(files))
	for _, file := range files {
		if file.target != "" {
			records = append(records, fileRecord{typeName: "symlink", path: file.path, target: file.target, size: int64(len(file.target))})
			continue
		}
		digest := sha256.Sum256([]byte(file.contents))
		records = append(records, fileRecord{typeName: "file", path: file.path, sha256: hex.EncodeToString(digest[:]), size: int64(len(file.contents)), mode: "0644"})
	}
	sort.Slice(records, func(left, right int) bool { return records[left].path < records[right].path })
	componentPaths := []struct{ id, path string }{
		{"jobctrl-api", "api"},
		{"jobctrl-launcher", "launcher"},
		{"jobctrl-web", "web"},
		{"jobctrl-worker", "worker"},
		{"node-runtime", "node"},
		{"python-runtime", "python"},
		{"temporal-runtime", "temporal"},
	}
	components := make([]map[string]any, 0, len(componentPaths))
	for _, component := range componentPaths {
		var canonical strings.Builder
		var size int64
		for _, file := range records {
			if file.path != component.path && !strings.HasPrefix(file.path, component.path+"/") {
				continue
			}
			if file.typeName == "symlink" {
				fmt.Fprintf(&canonical, "%s\x00symlink\x00%s\x00%d\n", file.path, file.target, file.size)
			} else {
				fmt.Fprintf(&canonical, "%s\x00file\x00%s\x00%d\x00%s\n", file.path, file.sha256, file.size, file.mode)
			}
			size += file.size
		}
		digest := sha256.Sum256([]byte(canonical.String()))
		components = append(components, map[string]any{
			"id": component.id, "classification": "core-runtime", "version": "2.0.0", "owner": "Test Owner", "source": "https://example.invalid/source", "license": "AGPL-3.0-only", "redistribution": "bundle", "path": component.path, "sha256": hex.EncodeToString(digest[:]), "sizeBytes": size, "required": true,
		})
	}
	filesJSON := make([]map[string]any, 0, len(records))
	for _, file := range records {
		if file.typeName == "symlink" {
			filesJSON = append(filesJSON, map[string]any{"type": "symlink", "path": file.path, "target": file.target, "sizeBytes": file.size})
		} else {
			filesJSON = append(filesJSON, map[string]any{"type": "file", "path": file.path, "sha256": file.sha256, "sizeBytes": file.size, "mode": file.mode})
		}
	}
	value := map[string]any{
		"schemaVersion": 1, "appVersion": "2.0.0", "buildId": "local-test-build", "releaseChannel": "local", "sourceDateEpoch": 0,
		"platform":              map[string]any{"id": "darwin-arm64", "os": "darwin", "arch": "arm64", "minimumOsVersion": "15.0"},
		"launcherCompatibility": map[string]any{"minimum": 1, "maximum": 1},
		"components":            components,
		"capabilities":          []map[string]any{{"id": "core-browser", "defaultEnabled": true, "componentIds": []string{"jobctrl-web"}}},
		"files":                 filesJSON,
		"signing":               map[string]any{"manifestAlgorithm": "ed25519", "manifestKeyId": "local-development", "codeSigning": "unsigned-local", "notarized": false},
	}
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var manifest distributionManifest
	if err := json.Unmarshal(encoded, &manifest); err != nil {
		t.Fatal(err)
	}
	return root, manifest
}

func writeLocalEnvelope(t *testing.T, root string, manifest distributionManifest) {
	t.Helper()
	encoded, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	signature := manifestSignature{SchemaVersion: 1, Status: "unsigned-local", ManifestAlgorithm: "ed25519", ManifestKeyID: "local-development", Promotable: false}
	encoded, err = json.Marshal(signature)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "manifest.sig"), encoded, 0o644); err != nil {
		t.Fatal(err)
	}
}

func refreshFixtureManifest(t *testing.T, root string, manifest *distributionManifest) {
	t.Helper()
	files := make([]struct {
		Type      string `json:"type"`
		Path      string `json:"path"`
		SHA256    string `json:"sha256,omitempty"`
		Target    string `json:"target,omitempty"`
		SizeBytes int64  `json:"sizeBytes"`
		Mode      string `json:"mode,omitempty"`
	}, 0)
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == root || entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if relative == "manifest.json" || relative == "manifest.sig" {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			files = append(files, struct {
				Type      string `json:"type"`
				Path      string `json:"path"`
				SHA256    string `json:"sha256,omitempty"`
				Target    string `json:"target,omitempty"`
				SizeBytes int64  `json:"sizeBytes"`
				Mode      string `json:"mode,omitempty"`
			}{Type: "symlink", Path: relative, Target: target, SizeBytes: int64(len(target))})
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		digest, err := sha256Path(path)
		if err != nil {
			return err
		}
		mode := "0644"
		if info.Mode()&0o111 != 0 {
			mode = "0755"
		}
		files = append(files, struct {
			Type      string `json:"type"`
			Path      string `json:"path"`
			SHA256    string `json:"sha256,omitempty"`
			Target    string `json:"target,omitempty"`
			SizeBytes int64  `json:"sizeBytes"`
			Mode      string `json:"mode,omitempty"`
		}{Type: "file", Path: relative, SHA256: digest, SizeBytes: info.Size(), Mode: mode})
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	sort.Slice(files, func(left, right int) bool { return files[left].Path < files[right].Path })
	manifest.Files = files
	for componentIndex := range manifest.Components {
		component := &manifest.Components[componentIndex]
		var canonical strings.Builder
		var size int64
		for _, file := range files {
			if file.Path != component.Path && !strings.HasPrefix(file.Path, component.Path+"/") {
				continue
			}
			if file.Type == "symlink" {
				fmt.Fprintf(&canonical, "%s\x00symlink\x00%s\x00%d\n", file.Path, file.Target, file.SizeBytes)
			} else {
				fmt.Fprintf(&canonical, "%s\x00file\x00%s\x00%d\x00%s\n", file.Path, file.SHA256, file.SizeBytes, file.Mode)
			}
			size += file.SizeBytes
		}
		digest := sha256.Sum256([]byte(canonical.String()))
		component.SHA256, component.SizeBytes = hex.EncodeToString(digest[:]), size
	}
}

func runLauncherCommand(t *testing.T, commandPath, directory string, environment []string, args ...string) (string, error) {
	t.Helper()
	command := exec.Command(commandPath, args...)
	command.Dir, command.Env = directory, environment
	output, err := command.CombinedOutput()
	return string(output), err
}

func runLauncherThroughShellPATH(t *testing.T, directory string, environment []string, args ...string) (string, error) {
	t.Helper()
	commandArgs := []string{"-fc", `exec jobctrl "$@"`, "jobctrl"}
	commandArgs = append(commandArgs, args...)
	command := exec.Command("/bin/zsh", commandArgs...)
	command.Dir, command.Env = directory, environment
	output, err := command.CombinedOutput()
	return string(output), err
}

func TestHermeticLauncherLifecycleViaPathAndHomebrewStyleShim(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:8766")
	if err != nil {
		t.Skipf("fixed API port unavailable for integration test: %v", err)
	}
	_ = listener.Close()
	payload, manifest := verifiedPayloadFixture(t)
	prefix := t.TempDir()
	payloadRoot := filepath.Join(prefix, "libexec")
	if err := os.Rename(payload, payloadRoot); err != nil {
		t.Fatal(err)
	}
	launcherPath := filepath.Join(payloadRoot, "launcher", "jobctrl")
	moduleRoot := filepath.Clean(filepath.Join("..", ".."))
	build := exec.Command("go", "build", "-o", launcherPath, "./cmd/jobctrl")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build hermetic launcher fixture: %v\n%s", err, output)
	}
	componentSource := filepath.Join(t.TempDir(), "fixture-component.go")
	componentProgram := `package main
import (
  "encoding/json"
  "net/http"
  "os"
  "path/filepath"
  "strconv"
  "time"
)
func main() {
  switch filepath.Base(os.Args[0]) {
  case "temporal":
    if len(os.Args) > 1 && os.Args[1] == "operator" { return }
  case "python3":
    _ = os.WriteFile(filepath.Join(os.Getenv("JOBCTRL_DIR"), "worker.pid"), []byte(strconv.Itoa(os.Getpid())), 0600)
  case "node":
    http.HandleFunc("/v1/health", func(w http.ResponseWriter, r *http.Request) {
      workerPID := 0
      for i := 0; i < 100; i++ {
        if value, err := os.ReadFile(filepath.Join(os.Getenv("JOBCTRL_DIR"), "worker.pid")); err == nil {
          workerPID, _ = strconv.Atoi(string(value)); break
        }
        time.Sleep(10 * time.Millisecond)
      }
      _ = json.NewEncoder(w).Encode(map[string]any{"worker": map[string]any{"status": "healthy", "heartbeat": map[string]int{"pid": workerPID}}})
    })
    _ = http.ListenAndServe("127.0.0.1:8766", nil)
    return
  }
	for { time.Sleep(time.Hour) }
}`
	if err := os.WriteFile(componentSource, []byte(componentProgram), 0o600); err != nil {
		t.Fatal(err)
	}
	componentBinary := filepath.Join(t.TempDir(), "fixture-component")
	build = exec.Command("go", "build", "-o", componentBinary, componentSource)
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build fixture components: %v\n%s", err, output)
	}
	componentBytes, err := os.ReadFile(componentBinary)
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		filepath.Join(payloadRoot, "temporal", "temporal"),
		filepath.Join(payloadRoot, "python", "bin", "python3"),
		filepath.Join(payloadRoot, "node", "bin", "node"),
	} {
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(target, componentBytes, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(payloadRoot, "launcher", "runtime-manifest.json"), []byte(validRuntimeManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, payloadRoot, &manifest)
	writeLocalEnvelope(t, payloadRoot, manifest)
	binDirectory := filepath.Join(prefix, "bin")
	if err := os.MkdirAll(binDirectory, 0o755); err != nil {
		t.Fatal(err)
	}
	shim := filepath.Join(binDirectory, "jobctrl")
	if err := os.Symlink(filepath.Join("..", "libexec", "launcher", "jobctrl"), shim); err != nil {
		t.Fatal(err)
	}
	home, otherCWD := t.TempDir(), t.TempDir()
	environment := []string{"HOME=" + home, "JOBCTRL_DIR=" + filepath.Join(home, ".jobctrl"), "JOBCTRL_RUNTIME_HOME=" + filepath.Join(home, "runtime"), "PATH=" + binDirectory + ":/usr/bin:/bin:/usr/sbin:/sbin"}
	t.Setenv("PATH", binDirectory+":/usr/bin:/bin:/usr/sbin:/sbin")
	if resolved, err := exec.LookPath("jobctrl"); err != nil || resolved != shim {
		t.Fatalf("PATH did not resolve Homebrew-style shim: %q, %v", resolved, err)
	}
	if output, err := runLauncherThroughShellPATH(t, otherCWD, environment, "version", "--json"); err != nil || !strings.Contains(output, `"buildId":"local-test-build"`) {
		t.Fatalf("PATH + shim version invocation failed from another cwd: %v\n%s", err, output)
	}
	defer func() { _, _ = runLauncherCommand(t, "jobctrl", otherCWD, environment, "stop") }()
	if output, err := runLauncherCommand(t, "jobctrl", otherCWD, environment, "start", "--no-open"); err != nil {
		logs, _ := filepath.Glob(filepath.Join(home, "runtime", "instances", "*", "logs", "*.log"))
		logOutput := make([]string, 0, len(logs))
		for _, logPath := range logs {
			contents, _ := os.ReadFile(logPath)
			logOutput = append(logOutput, logPath+": "+string(contents))
		}
		t.Fatalf("start hermetic launcher fixture: %v\n%s\n%s", err, output, strings.Join(logOutput, "\n"))
	}
	statusOutput, err := runLauncherCommand(t, "jobctrl", otherCWD, environment, "status", "--json")
	if err != nil {
		t.Fatal(err)
	}
	var status struct {
		Status        string `json:"status"`
		SupervisorPID int    `json:"supervisorPid"`
	}
	if err := json.Unmarshal([]byte(statusOutput), &status); err != nil || status.Status != "running" || status.SupervisorPID <= 0 {
		t.Fatalf("fixture launcher did not become running: %#v, %v, %s", status, err, statusOutput)
	}
	if err := syscall.Kill(status.SupervisorPID, syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	instanceRoot := filepath.Join(home, "runtime")
	stateFiles, err := filepath.Glob(filepath.Join(instanceRoot, "instances", "*", "state.json"))
	if err != nil || len(stateFiles) != 1 {
		t.Fatalf("find orphan registry: %v, %v", err, stateFiles)
	}
	before, err := os.ReadFile(stateFiles[0])
	if err != nil {
		t.Fatal(err)
	}
	if output, err := runLauncherCommand(t, "jobctrl", otherCWD, environment, "start", "--no-open"); err == nil || !strings.Contains(output, "recorded") {
		t.Fatalf("immediate restart after SIGKILL supervisor was accepted: %v\n%s", err, output)
	}
	after, err := os.ReadFile(stateFiles[0])
	if err != nil || string(after) != string(before) {
		t.Fatalf("immediate restart overwrote orphan registry: %v", err)
	}
	if output, err := runLauncherCommand(t, "jobctrl", otherCWD, environment, "stop"); err != nil {
		t.Fatalf("stop orphaned fixture: %v\n%s", err, output)
	}
	if output, err := runLauncherCommand(t, "jobctrl", otherCWD, environment, "start", "--no-open"); err != nil {
		t.Fatalf("restart after orphan cleanup: %v\n%s", err, output)
	}
	if output, err := runLauncherCommand(t, "jobctrl", otherCWD, environment, "stop"); err != nil {
		t.Fatalf("final fixture stop: %v\n%s", err, output)
	}
}

func TestDefaultRuntimeRegistryUsesCanonicalStateHash(t *testing.T) {
	home := t.TempDir()
	state := filepath.Join(home, "state")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(home, "alias")
	if err := os.Symlink(state, alias); err != nil {
		t.Fatal(err)
	}
	first, err := resolveInstance([]string{"HOME=" + home, "JOBCTRL_DIR=" + state})
	if err != nil {
		t.Fatal(err)
	}
	second, err := resolveInstance([]string{"HOME=" + home, "JOBCTRL_DIR=" + alias})
	if err != nil {
		t.Fatal(err)
	}
	if first.ID != second.ID || first.Dir != second.Dir {
		t.Fatalf("same canonical state must share instance: %#v %#v", first, second)
	}
	wantHome := filepath.Join(home, "Library", "Application Support", "JobCtrl")
	if first.RuntimeHome != wantHome {
		t.Fatalf("runtime home = %q, want %q", first.RuntimeHome, wantHome)
	}
	if !strings.Contains(first.Dir, filepath.Join("instances", first.ID)) {
		t.Fatalf("instance directory is not hash scoped: %q", first.Dir)
	}
}

func TestChildEnvironmentStripsAmbientRuntimeOverrides(t *testing.T) {
	var manifest runtimeManifest
	if err := json.Unmarshal([]byte(validRuntimeManifest), &manifest); err != nil {
		t.Fatal(err)
	}
	env := childEnvironment([]string{
		"HOME=/home/test", "BASH_ENV=/evil", "PYTHONPATH=/evil", "PYTHONHOME=/evil", "VIRTUAL_ENV=/evil",
		"NODE_OPTIONS=--require=/evil", "NODE_PATH=/evil", "PORT=1234",
		"JOBCTRL_API_ALLOW_REMOTE_BIND=1", "JOBCTRL_API_HOST=0.0.0.0", "JOBCTRL_API_PORT=9999",
		"TEMPORAL_ADDRESS=evil:7233", "PATH=/evil", "OPENAI_API_KEY=kept",
	}, "/payload", "/state", manifest)
	values := environmentMap(env)
	for _, key := range []string{"BASH_ENV", "PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV", "NODE_OPTIONS", "NODE_PATH", "PORT", "JOBCTRL_API_ALLOW_REMOTE_BIND"} {
		if _, exists := values[key]; exists {
			t.Fatalf("child inherited forbidden %s", key)
		}
	}
	if values["JOBCTRL_API_HOST"] != "127.0.0.1" || values["JOBCTRL_API_PORT"] != "8766" || values["TEMPORAL_ADDRESS"] != "127.0.0.1:7233" {
		t.Fatalf("fixed loopback environment missing: %#v", values)
	}
	if values["JOBCTRL_PYTHON_EXECUTABLE"] != "/payload/python/bin/python3" {
		t.Fatalf("bundled API Python executable missing: %#v", values)
	}
	if values["PATH"] != "/usr/bin:/bin:/usr/sbin:/sbin" || values["OPENAI_API_KEY"] != "kept" {
		t.Fatalf("environment isolation lost needed values: %#v", values)
	}
}

func TestInstanceLockExcludesSecondLauncher(t *testing.T) {
	path := filepath.Join(t.TempDir(), "instance.lock")
	first, err := acquireLock(path, true)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseLock(first)
	if second, err := acquireLock(path, true); !errors.Is(err, ErrLockHeld) || second != nil {
		t.Fatalf("second lock = %v, %v", second, err)
	}
}

func TestStopDoesNotSignalPIDReuseOrForeignProcessGroup(t *testing.T) {
	previousIdentity, previousExecutable, previousSignaler := readProcessIdentity, readProcessExecutable, signalProcessGroup
	t.Cleanup(func() {
		readProcessIdentity, readProcessExecutable, signalProcessGroup = previousIdentity, previousExecutable, previousSignaler
	})
	called := 0
	signalProcessGroup = func(int, syscall.Signal) error { called++; return nil }
	readProcessIdentity = func(int) (string, error) { return "different-start", nil }
	readProcessExecutable = func(int) (string, error) { return "/expected", nil }
	if err := terminateRecord(componentRecord{PID: 42, PGID: 42, StartIdentity: "original-start", Executable: "/expected"}); err == nil {
		t.Fatal("reused PID must not be treated as owned")
	}
	if called != 0 {
		t.Fatalf("PID reuse must not signal a foreign process, got %d signals", called)
	}
}

func TestProcessRecordBindsStartIdentityProcessGroupAndExecutable(t *testing.T) {
	executable, err := processExecutable(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(os.Getpid(), "", executable)
	if err != nil {
		t.Fatal(err)
	}
	if !recordMatchesLiveProcess(record) {
		t.Fatalf("live process record did not match: %#v", record)
	}
	previousExecutable := readProcessExecutable
	t.Cleanup(func() { readProcessExecutable = previousExecutable })
	readProcessExecutable = func(int) (string, error) { return "/different-program", nil }
	if recordMatchesLiveProcess(record) {
		t.Fatal("matching lstart and PGID is insufficient when executable changed")
	}
}

func TestProcessRecordMatchesOwnedChildAfterSeparateExec(t *testing.T) {
	child := exec.Command("/bin/sleep", "30")
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = syscall.Kill(-child.Process.Pid, syscall.SIGTERM)
		_, _ = child.Process.Wait()
	})
	executable, err := processExecutable(child.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	if executable != "/bin/sleep" {
		t.Fatalf("child executable = %q, want NUL-terminated PROC_PIDPATHINFO path", executable)
	}
	record, err := recordForProcess(child.Process.Pid, "", executable)
	if err != nil {
		t.Fatal(err)
	}
	if !recordMatchesLiveProcess(record) {
		identity, identityErr := processStartIdentity(child.Process.Pid)
		liveExecutable, executableErr := processExecutable(child.Process.Pid)
		pgid, pgidErr := syscall.Getpgid(child.Process.Pid)
		t.Fatalf("owned child record did not match: record=%#v liveIdentity=%q identityErr=%v liveExecutable=%q executableErr=%v pgid=%d pgidErr=%v", record, identity, identityErr, liveExecutable, executableErr, pgid, pgidErr)
	}
}

func startOwnedSleep(t *testing.T) (*exec.Cmd, componentRecord, <-chan error) {
	t.Helper()
	child := exec.Command("/bin/sleep", "30")
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	executable, err := processExecutable(child.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(child.Process.Pid, "", executable)
	if err != nil {
		t.Fatal(err)
	}
	reaped := make(chan error, 1)
	go func() { reaped <- child.Wait() }()
	t.Cleanup(func() {
		if processPIDAlive(child.Process.Pid) {
			_ = syscall.Kill(-record.PGID, syscall.SIGKILL)
		}
		select {
		case <-reaped:
		case <-time.After(time.Second):
		}
	})
	return child, record, reaped
}

func TestTerminateRecordFallsBackToVerifiedPIDWhenSandboxRejectsProcessGroup(t *testing.T) {
	child, record, reaped := startOwnedSleep(t)
	previousSignaler := signalProcessGroup
	signalProcessGroup = func(int, syscall.Signal) error { return syscall.EPERM }
	t.Cleanup(func() { signalProcessGroup = previousSignaler })
	if err := terminateRecord(record); err != nil {
		t.Fatalf("verified direct-PID fallback failed: %v", err)
	}
	if err := <-reaped; err == nil {
		t.Fatal("sleep unexpectedly exited cleanly after TERM")
	}
	if processPIDAlive(child.Process.Pid) || processGroupAlive(record.PGID) {
		t.Fatal("direct PID fallback left an owned process or group live")
	}
}

func TestTerminateRecordProvesOwnedProcessGroupIsEmpty(t *testing.T) {
	child := exec.Command("/bin/sh", "-c", "sleep 30 & wait")
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	executable, err := processExecutable(child.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(child.Process.Pid, "", executable)
	if err != nil {
		t.Fatal(err)
	}
	reaped := make(chan error, 1)
	go func() { reaped <- child.Wait() }()
	t.Cleanup(func() {
		if processGroupAlive(record.PGID) {
			_ = syscall.Kill(-record.PGID, syscall.SIGKILL)
		}
		select {
		case <-reaped:
		case <-time.After(time.Second):
		}
	})
	if err := terminateRecord(record); err != nil {
		t.Fatalf("owned group termination failed: %v", err)
	}
	if err := <-reaped; err == nil {
		t.Fatal("shell unexpectedly exited cleanly after group termination")
	}
	if processPIDAlive(record.PID) || processGroupAlive(record.PGID) {
		t.Fatal("leader or descendant remained in the owned process group")
	}
}

func TestStartupFailureCleanupTerminatesOwnedSiblingGroups(t *testing.T) {
	_, temporal, temporalReaped := startOwnedSleep(t)
	_, worker, workerReaped := startOwnedSleep(t)
	state := instanceState{Components: map[string]componentRecord{"temporal": temporal, "worker": worker}}
	shutdownComponents(&state, nil, filepath.Join(t.TempDir(), "state.json"))
	for name, reaped := range map[string]<-chan error{"temporal": temporalReaped, "worker": workerReaped} {
		if err := <-reaped; err == nil {
			t.Fatalf("%s unexpectedly exited cleanly after shutdown", name)
		}
		record := state.Components[name]
		if record.ExitedAt == nil || processPIDAlive(record.PID) || processGroupAlive(record.PGID) {
			t.Fatalf("startup cleanup did not prove %s process-tree termination: %#v", name, record)
		}
	}
}

func TestStopTerminatesLiveRecordEvenWhenAnOldStateMarkedItExited(t *testing.T) {
	_, record, reaped := startOwnedSleep(t)
	payload, stateRoot := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(payload, "manifest.json"), []byte("manifest"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := manifestDigest(payload)
	if err != nil {
		t.Fatal(err)
	}
	manifest := runtimeManifest{}
	manifest.Ports.TemporalGRPC, manifest.Ports.TemporalUI, manifest.Ports.API = 7233, 8233, 8766
	ctx := launchContext{PayloadRoot: payload, Manifest: manifest, Distribution: distributionManifest{BuildID: "build"}, Instance: instance{ID: "instance", StateDir: stateRoot, StatePath: filepath.Join(stateRoot, "state.json"), ControlPath: filepath.Join(stateRoot, "control.lock")}}
	oldExit := time.Now().UTC().Add(-time.Minute)
	record.ExitedAt = &oldExit
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: "instance", CanonicalStateDir: stateRoot, PayloadRoot: payload, BuildID: "build", ManifestSHA256: digest, Ports: runtimePorts{TemporalGRPC: 7233, TemporalUI: 8233, API: 8766}, Components: map[string]componentRecord{"worker": record}}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("stop must repair stale live process record: %v", err)
	}
	if err := <-reaped; err == nil {
		t.Fatal("sleep unexpectedly exited cleanly after stop")
	}
	if processPIDAlive(record.PID) || processGroupAlive(record.PGID) {
		t.Fatal("stop left the falsely marked-live owned process group running")
	}
	updated, err := readState(ctx.Instance.StatePath)
	if err != nil || updated.StoppedAt == nil {
		t.Fatalf("stop did not persist a proven stopped state: %#v, %v", updated, err)
	}
}

func TestCleanupDoesNotMarkAnUnverifiedLiveRecordExited(t *testing.T) {
	executable, err := processExecutable(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(os.Getpid(), "", executable)
	if err != nil {
		t.Fatal(err)
	}
	previousIdentity := readProcessIdentity
	readProcessIdentity = func(int) (string, error) { return "different-start", nil }
	t.Cleanup(func() { readProcessIdentity = previousIdentity })
	state := instanceState{Components: map[string]componentRecord{"worker": record}}
	shutdownComponents(&state, nil, filepath.Join(t.TempDir(), "state.json"))
	updated := state.Components["worker"]
	if updated.ExitedAt != nil || !strings.Contains(updated.ExitError, "could not confirm") {
		t.Fatalf("unverified live record was falsely marked exited: %#v", updated)
	}
}

func TestStartupComponentExitIsRecordedBeforeSiblingCleanup(t *testing.T) {
	executable, err := processExecutable(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(os.Getpid(), "", executable)
	if err != nil {
		t.Fatal(err)
	}
	state := instanceState{Components: map[string]componentRecord{"api": record}}
	markStartupComponentExit(&state, startupComponentExitError{componentExit{Name: "api", Err: errors.New("fixture API exit")}})
	updated := state.Components["api"]
	if updated.ExitedAt == nil || updated.ExitError != "fixture API exit" {
		t.Fatalf("startup exit was not persisted: %#v", updated)
	}
}

func TestForeignListenerIsRefusedAndNeverSignaled(t *testing.T) {
	for _, port := range []int{7233, 8233, 8766} {
		t.Run(strconv.Itoa(port), func(t *testing.T) {
			listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
			if err != nil {
				t.Skipf("fixed port unavailable for test: %v", err)
			}
			defer listener.Close()
			previousSignaler := signalProcessGroup
			t.Cleanup(func() { signalProcessGroup = previousSignaler })
			called := 0
			signalProcessGroup = func(int, syscall.Signal) error { called++; return nil }
			var manifest runtimeManifest
			if err := json.Unmarshal([]byte(validRuntimeManifest), &manifest); err != nil {
				t.Fatal(err)
			}
			if err := ensureFixedPortsAvailable(manifest); !errors.Is(err, ErrPortInUse) {
				t.Fatalf("expected foreign listener refusal, got %v", err)
			}
			if called != 0 {
				t.Fatalf("port refusal must never signal foreign listener, got %d signals", called)
			}
		})
	}
}

func TestLogsAreBoundedAndNonFollowing(t *testing.T) {
	path := filepath.Join(t.TempDir(), "api.log")
	var source strings.Builder
	for i := 0; i < logLineLimit+10; i++ {
		source.WriteString("line-" + strconv.Itoa(i) + "\n")
	}
	if err := os.WriteFile(path, []byte(source.String()), 0o600); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := tailFile(path, logLineLimit, &output); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(output.String(), "line-0\n") || !strings.Contains(output.String(), "line-209\n") {
		t.Fatalf("bounded tail output is wrong: %q", output.String())
	}
}

func TestStartupObservesEarlyChildExitWithoutWaitingForTimeout(t *testing.T) {
	exits := make(chan componentExit, 1)
	exits <- componentExit{Name: "temporal", Err: errors.New("fixture exit")}
	started := time.Now()
	err := waitForTemporal(launchContext{}, nil, exits, make(chan os.Signal))
	if err == nil || !strings.Contains(err.Error(), "fixture exit") {
		t.Fatalf("early child exit = %v", err)
	}
	if elapsed := time.Since(started); elapsed > time.Second {
		t.Fatalf("early child exit waited too long: %s", elapsed)
	}
}

func TestTemporalReadinessProbesAHealthyLiveChild(t *testing.T) {
	previous := temporalHealthProbe
	t.Cleanup(func() { temporalHealthProbe = previous })
	called := 0
	temporalHealthProbe = func(launchContext) error { called++; return nil }
	process, err := os.FindProcess(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	started := time.Now()
	if err := waitForTemporal(launchContext{}, &exec.Cmd{Process: process}, make(chan componentExit), make(chan os.Signal)); err != nil {
		t.Fatal(err)
	}
	if called != 1 || time.Since(started) > time.Second {
		t.Fatalf("healthy temporal readiness did not probe immediately: calls=%d elapsed=%s", called, time.Since(started))
	}
}

func TestStartupSignalIsCleanCancellation(t *testing.T) {
	signals := make(chan os.Signal, 1)
	signals <- os.Interrupt
	if err := waitForTemporal(launchContext{}, nil, make(chan componentExit), signals); !errors.Is(err, errStartupInterrupted) {
		t.Fatalf("startup signal = %v, want clean interruption", err)
	}
}

func TestDetachedReadinessBudgetCoversBothSequentialStartupPhases(t *testing.T) {
	minimum := 2 * startupTimeout
	if detachedStartupTimeout <= minimum {
		t.Fatalf("detached readiness budget = %s, must exceed both sequential startup phases (%s)", detachedStartupTimeout, minimum)
	}
}

func TestStatusActivelyProbesAPIWorkerReadiness(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:8766")
	if err != nil {
		t.Skipf("fixed API port unavailable for test: %v", err)
	}
	defer listener.Close()
	payload, stateRoot := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(payload, "manifest.json"), []byte("manifest"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := manifestDigest(payload)
	if err != nil {
		t.Fatal(err)
	}
	executable, err := processExecutable(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(os.Getpid(), "", executable)
	if err != nil {
		t.Fatal(err)
	}
	var probes atomic.Int32
	server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		probes.Add(1)
		writer.Header().Set("content-type", "application/json")
		_, _ = writer.Write([]byte(`{"worker":{"status":"healthy","heartbeat":{"pid":` + strconv.Itoa(os.Getpid()) + `}}}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	manifest := runtimeManifest{}
	manifest.Ports.TemporalGRPC, manifest.Ports.TemporalUI, manifest.Ports.API = 7233, 8233, 8766
	ctx := launchContext{PayloadRoot: payload, Manifest: manifest, Distribution: distributionManifest{BuildID: "build"}, Instance: instance{ID: "instance", StateDir: stateRoot, StatePath: filepath.Join(stateRoot, "state.json")}}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: "instance", CanonicalStateDir: stateRoot, PayloadRoot: payload, BuildID: "build", ManifestSHA256: digest, Ports: runtimePorts{TemporalGRPC: 7233, TemporalUI: 8233, API: 8766}, Components: map[string]componentRecord{"worker": record, "api": record}}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := status(ctx, &output, false); err != nil {
		t.Fatal(err)
	}
	if probes.Load() == 0 || !strings.Contains(output.String(), "worker    running") || !strings.Contains(output.String(), "api       running") {
		t.Fatalf("status did not use healthy API readiness probe: probes=%d output=%q", probes.Load(), output.String())
	}
}

func TestOpenRequiresHealthyOwnedAPIAndWorkerBeforeInvokingBrowser(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:8766")
	if err != nil {
		t.Skipf("fixed API port unavailable for test: %v", err)
	}
	defer listener.Close()
	payload, stateRoot := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(payload, "manifest.json"), []byte("manifest"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := manifestDigest(payload)
	if err != nil {
		t.Fatal(err)
	}
	executable, err := processExecutable(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(os.Getpid(), "", executable)
	if err != nil {
		t.Fatal(err)
	}
	var healthy atomic.Bool
	healthy.Store(true)
	server := &http.Server{Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("content-type", "application/json")
		if healthy.Load() {
			_, _ = writer.Write([]byte(`{"worker":{"status":"healthy","heartbeat":{"pid":` + strconv.Itoa(os.Getpid()) + `}}}`))
			return
		}
		_, _ = writer.Write([]byte(`{"worker":{"status":"degraded"}}`))
	})}
	go func() { _ = server.Serve(listener) }()
	t.Cleanup(func() { _ = server.Close() })
	manifest := runtimeManifest{}
	manifest.Ports.TemporalGRPC, manifest.Ports.TemporalUI, manifest.Ports.API = 7233, 8233, 8766
	manifest.Health.API.Path = "/v1/health"
	ctx := launchContext{PayloadRoot: payload, Manifest: manifest, Distribution: distributionManifest{BuildID: "build"}, Instance: instance{ID: "instance", StateDir: stateRoot, StatePath: filepath.Join(stateRoot, "state.json")}}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: "instance", CanonicalStateDir: stateRoot, PayloadRoot: payload, BuildID: "build", ManifestSHA256: digest, Ports: runtimePorts{TemporalGRPC: 7233, TemporalUI: 8233, API: 8766}, Components: map[string]componentRecord{"worker": record, "api": record}}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	previousOpenBrowser := openBrowser
	var opened []string
	openBrowser = func(url string) error {
		opened = append(opened, url)
		return nil
	}
	t.Cleanup(func() { openBrowser = previousOpenBrowser })
	if err := openURL(ctx); err != nil {
		t.Fatalf("open with healthy owned API and worker: %v", err)
	}
	if len(opened) != 1 || opened[0] != "http://127.0.0.1:8766" {
		t.Fatalf("open invoked browser with %#v", opened)
	}
	healthy.Store(false)
	if err := openURL(ctx); err == nil {
		t.Fatal("open accepted an unhealthy API")
	}
	if len(opened) != 1 {
		t.Fatalf("unhealthy API must not invoke browser, got %#v", opened)
	}
}

func TestStateIdentitySeparatesStaleAndLiveDifferentReleaseRecords(t *testing.T) {
	payload := t.TempDir()
	if err := os.WriteFile(filepath.Join(payload, "manifest.json"), []byte("new manifest"), 0o644); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{PayloadRoot: payload, Distribution: distributionManifest{BuildID: "new"}, Manifest: runtimeManifest{}, Instance: instance{ID: "instance", StateDir: "/state"}}
	stale := instanceState{InstanceID: "instance", CanonicalStateDir: "/state", PayloadRoot: "/old", BuildID: "old", ManifestSHA256: "old", Components: map[string]componentRecord{}}
	if err := validateStateIdentity(ctx, stale); err != nil {
		t.Fatal(err)
	}
	if stateHasLiveProcesses(stale) {
		t.Fatal("empty old registry must be safe to replace")
	}
	if err := validateStartState(ctx, stale); err != nil {
		t.Fatalf("dead prior release must be replaceable: %v", err)
	}
	executable, err := processExecutable(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	live, err := recordForProcess(os.Getpid(), "", executable)
	if err != nil {
		t.Fatal(err)
	}
	stale.Supervisor = live
	if err := validateStartState(ctx, stale); err == nil || !strings.Contains(err.Error(), "different JobCtrl release") {
		t.Fatalf("live prior release must block replacement, got %v", err)
	}
	wrong := stale
	wrong.CanonicalStateDir = "/other"
	if err := validateStateIdentity(ctx, wrong); err == nil {
		t.Fatal("registry from another state directory must not be adopted")
	}
}

func TestStartRefusesLiveComponentWhenSupervisorIsGoneAndSupervisePreservesRegistry(t *testing.T) {
	payload, stateRoot := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(payload, "manifest.json"), []byte("new manifest"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := manifestDigest(payload)
	if err != nil {
		t.Fatal(err)
	}
	executable, err := processExecutable(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	liveWorker, err := recordForProcess(os.Getpid(), "", executable)
	if err != nil {
		t.Fatal(err)
	}
	manifest := runtimeManifest{}
	manifest.Ports.TemporalGRPC, manifest.Ports.TemporalUI, manifest.Ports.API = 7233, 8233, 8766
	ctx := launchContext{
		Executable: executable, PayloadRoot: payload, Manifest: manifest, Distribution: distributionManifest{BuildID: "new"},
		Instance: instance{ID: "instance", StateDir: stateRoot, StatePath: filepath.Join(stateRoot, "state.json"), LockPath: filepath.Join(stateRoot, "instance.lock")},
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: "instance", CanonicalStateDir: stateRoot, PayloadRoot: payload, BuildID: "new", ManifestSHA256: digest, Ports: runtimePorts{TemporalGRPC: 7233, TemporalUI: 8233, API: 8766}, Components: map[string]componentRecord{"worker": liveWorker}}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	if err := validateStartState(ctx, state); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("orphaned live component must block start, got %v", err)
	}
	before, err := os.ReadFile(ctx.Instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := supervise(ctx, nil); !errors.Is(err, ErrAlreadyRunning) {
		t.Fatalf("supervise must revalidate after lock, got %v", err)
	}
	after, err := os.ReadFile(ctx.Instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("supervise overwrote an orphaned live component registry")
	}
}
