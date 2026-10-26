package installer

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type signedBridgeFixture struct {
	options     Options
	input       CachedBridgeInput
	sourceInput CachedBridgeInput
	source      release.Active
	store       *release.Store
	claim       bridgeAttestation
	private     ed25519.PrivateKey
}

type signedBridgePayload struct {
	archive       string
	descriptor    []byte
	descriptorSig []byte
	manifest      []byte
	build         string
	sequence      uint64
}

func signedBridgePayloadFixture(t *testing.T, private ed25519.PrivateKey, build string, sequence uint64, protocol int, minimum int) signedBridgePayload {
	t.Helper()
	runtime := fmt.Sprintf(`{"schemaVersion":1,"launcherProtocol":%d,"ports":{"temporalGrpc":7233,"temporalUi":8233,"api":8766},"components":[{"name":"temporal","executable":"temporal/temporal","arguments":["server"]},{"name":"worker","executable":"python/bin/python3","arguments":["-I","-B","-m","jobctrl","worker"]},{"name":"api","executable":"node/bin/node","arguments":["${PAYLOAD_ROOT}/api/server.mjs"]}],"health":{"temporal":{"component":"temporal","arguments":["operator"]},"api":{"path":"/v1/health","requireWorkerHealthy":true,"requireWorkerPid":true}}}`, protocol)
	controller := string([]byte{0xcf, 0xfa, 0xed, 0xfe}) + fmt.Sprintf("synthetic-%d", protocol)
	files := []struct{ path, content, component, root, mode string }{
		{"components/jobctrl-api/payload", "api\n", "jobctrl-api", "components/jobctrl-api", "0644"},
		{"launcher/jobctrl", controller, "jobctrl-launcher", "launcher/jobctrl", "0755"},
		{"components/jobctrl-web/payload", "web\n", "jobctrl-web", "components/jobctrl-web", "0644"},
		{"components/jobctrl-worker/payload", "worker\n", "jobctrl-worker", "components/jobctrl-worker", "0644"},
		{"components/node-runtime/payload", "node\n", "node-runtime", "components/node-runtime", "0644"},
		{"components/python-runtime/payload", "python\n", "python-runtime", "components/python-runtime", "0644"},
		{"launcher/runtime-manifest.json", runtime, "runtime-metadata", "launcher/runtime-manifest.json", "0644"},
		{"components/temporal-runtime/payload", "temporal\n", "temporal-runtime", "components/temporal-runtime", "0644"},
	}
	manifestFiles := make([]map[string]any, 0, len(files))
	components := make([]map[string]any, 0, len(files))
	for _, f := range files {
		digest := digestBytes([]byte(f.content))
		manifestFiles = append(manifestFiles, map[string]any{"type": "file", "path": f.path, "sha256": digest, "sizeBytes": len(f.content), "mode": f.mode})
		canonical := fmt.Sprintf("%s\x00file\x00%s\x00%d\x00%s\n", f.path, digest, len(f.content), f.mode)
		components = append(components, map[string]any{"id": f.component, "classification": "core-runtime", "version": "2.0.0", "owner": "JobCtrl", "source": "https://example.test/source", "license": "AGPL-3.0-only", "redistribution": "bundle", "path": f.root, "sha256": digestBytes([]byte(canonical)), "sizeBytes": len(f.content), "required": true})
	}
	sort.Slice(manifestFiles, func(i, j int) bool { return manifestFiles[i]["path"].(string) < manifestFiles[j]["path"].(string) })
	sort.Slice(components, func(i, j int) bool { return components[i]["id"].(string) < components[j]["id"].(string) })
	manifest := map[string]any{"schemaVersion": 1, "appVersion": "2.0.0", "buildId": build, "releaseChannel": "stable", "sourceDateEpoch": 0, "platform": map[string]any{"id": "darwin-arm64", "os": "darwin", "arch": "arm64", "minimumOsVersion": "15.0"}, "launcherCompatibility": map[string]any{"minimum": minimum, "maximum": protocol}, "components": components, "capabilities": []map[string]any{{"id": "core", "defaultEnabled": true, "componentIds": []string{"jobctrl-api", "jobctrl-launcher", "jobctrl-web", "jobctrl-worker", "node-runtime", "python-runtime", "temporal-runtime"}}}, "files": manifestFiles, "signing": map[string]any{"manifestAlgorithm": "ed25519", "manifestKeyId": "jobctrl-release-v1", "codeSigning": "developer-id", "notarized": true}}
	manifestRaw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	sig := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signingMessage("jobctrl:manifest:v1\x00", manifestRaw)))
	manifestSig, _ := json.Marshal(map[string]any{"schemaVersion": 1, "status": "signed", "manifestAlgorithm": "ed25519", "manifestKeyId": "jobctrl-release-v1", "signature": sig, "promotable": true})
	entries := []zipEntry{{"manifest.json", manifestRaw, 0644}, {"manifest.sig", manifestSig, 0644}}
	for _, f := range files {
		mode := os.FileMode(0644)
		if f.mode == "0755" {
			mode = 0755
		}
		entries = append(entries, zipEntry{f.path, []byte(f.content), mode})
	}
	archive := writeZIP(t, entries)
	blob, err := os.ReadFile(archive)
	if err != nil {
		t.Fatal(err)
	}
	descriptor := stableDescriptor(fmt.Sprintf("https://releases.jobctrl.dev/v1/artifacts/%s/jobctrl-2.0.0-darwin-arm64.zip", build))
	descriptor.BuildID = build
	descriptor.Sequence = sequence
	descriptor.Artifact.SHA256 = digestBytes(blob)
	descriptor.Artifact.SizeBytes = int64(len(blob))
	descriptor.Artifact.ManifestSHA256 = digestBytes(manifestRaw)
	descriptorRaw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	descriptorSig, err := json.Marshal(signedDescriptorSignature(private, descriptorRaw))
	if err != nil {
		t.Fatal(err)
	}
	return signedBridgePayload{archive: archive, descriptor: descriptorRaw, descriptorSig: descriptorSig, manifest: manifestRaw, build: build, sequence: sequence}
}

func writeBridgeInputFile(t *testing.T, dir, name string, raw []byte) string {
	t.Helper()
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	return path
}

func newSignedBridgeFixture(t *testing.T, candidateMinimum int, revoke bool, extraRevoked ...int) signedBridgeFixture {
	t.Helper()
	root := t.TempDir()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	sourcePayload := signedBridgePayloadFixture(t, private, "source-build-0001", 1, 1, 1)
	candidatePayload := signedBridgePayloadFixture(t, private, "bridge-build-0002", 2, 2, candidateMinimum)
	// If requested, re-sign the candidate descriptor with a revocation of the
	// source. The payload remains identical and only policy evidence changes.
	if revoke || len(extraRevoked) > 0 {
		var descriptor Descriptor
		if err := json.Unmarshal(candidatePayload.descriptor, &descriptor); err != nil {
			t.Fatal(err)
		}
		descriptor.RevokedBuildIDs = []string{}
		if revoke {
			descriptor.RevokedBuildIDs = append(descriptor.RevokedBuildIDs, sourcePayload.build)
		}
		if len(extraRevoked) > 0 {
			for n := 0; n < extraRevoked[0]; n++ {
				descriptor.RevokedBuildIDs = append(descriptor.RevokedBuildIDs, fmt.Sprintf("retired-build-%06d", n))
			}
		}
		sort.Strings(descriptor.RevokedBuildIDs)
		candidatePayload.descriptor, _ = json.Marshal(descriptor)
		candidatePayload.descriptorSig, _ = json.Marshal(signedDescriptorSignature(private, candidatePayload.descriptor))
	}
	options := Options{Home: filepath.Join(root, "home"), Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, AcquisitionSource: "curl", RunCommand: func(string, ...string) (string, error) { return "", nil }}
	sourceDescriptorPath := writeBridgeInputFile(t, root, "old.json", sourcePayload.descriptor)
	sourceSignaturePath := writeBridgeInputFile(t, root, "old.sig", sourcePayload.descriptorSig)
	sourceURL := fmt.Sprintf("https://releases.jobctrl.dev/v1/artifacts/%s/release-descriptor.json", sourcePayload.build)
	if _, err := InstallFromCachedFiles(options, sourceURL, sourceDescriptorPath, sourceSignaturePath, sourcePayload.archive); err != nil {
		t.Fatalf("install signed synthetic source: %v", err)
	}
	store, err := release.Open(options.Home)
	if err != nil {
		t.Fatal(err)
	}
	active, err := store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	candidateTmp := filepath.Join(root, "candidate-extracted")
	if err := extractZIP(candidatePayload.archive, candidateTmp); err != nil {
		t.Fatal(err)
	}
	oldRoot := filepath.Join(options.Home, "releases", sourcePayload.build, "payload")
	oldInv, err := bridgeInventory(oldRoot)
	if err != nil {
		t.Fatal(err)
	}
	nextInv, err := bridgeInventory(candidateTmp)
	if err != nil {
		t.Fatal(err)
	}
	oldInvRaw, _ := json.Marshal(oldInv)
	nextInvRaw, _ := json.Marshal(nextInv)
	claim := bridgeAttestation{SchemaVersion: 1, Role: "schema14-bridge", DatabaseSchema: 14, LauncherProtocol: 2, Channel: "stable", Platform: "darwin-arm64", PredecessorDescriptorSHA256: active.Receipt.DescriptorSHA256, PredecessorManifestSHA256: active.Receipt.ManifestSHA256, CandidateDescriptorSHA256: digestBytes(candidatePayload.descriptor), CandidateManifestSHA256: digestBytes(candidatePayload.manifest), PredecessorInventorySHA256: digestBytes(oldInvRaw), CandidateInventorySHA256: digestBytes(nextInvRaw), ControllerSHA256: nextInv["launcher/jobctrl"].Value}
	claimRaw, _ := json.Marshal(claim)
	claimSig, _ := json.Marshal(bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, signingMessage("jobctrl:bridge-attestation:v1\x00", claimRaw)))})
	input := CachedBridgeInput{DescriptorURL: fmt.Sprintf("https://releases.jobctrl.dev/v1/artifacts/%s/release-descriptor.json", candidatePayload.build), DescriptorPath: writeBridgeInputFile(t, root, "next.json", candidatePayload.descriptor), DescriptorSignaturePath: writeBridgeInputFile(t, root, "next.sig", candidatePayload.descriptorSig), ArchivePath: candidatePayload.archive, AttestationPath: writeBridgeInputFile(t, root, "claim.json", claimRaw), AttestationSignaturePath: writeBridgeInputFile(t, root, "claim.sig", claimSig)}
	return signedBridgeFixture{options: options, input: input, sourceInput: CachedBridgeInput{DescriptorURL: sourceURL, DescriptorPath: sourceDescriptorPath, DescriptorSignaturePath: sourceSignaturePath, ArchivePath: sourcePayload.archive}, source: active, store: store, claim: claim, private: private}
}

func TestSignedBridgePreflightSyntheticSignedRelease(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	sentinels := map[string][]byte{
		filepath.Join(f.options.Home, "jobctrl.db"):     []byte("owned database"),
		filepath.Join(f.options.Home, "jobctrl.db-wal"): []byte("owned wal"),
		filepath.Join(f.options.Home, "jobctrl.db-shm"): []byte("owned shm"),
		filepath.Join(f.options.Home, "temporal.db"):    []byte("owned temporal"),
	}
	for path, value := range sentinels {
		if err := os.WriteFile(path, value, 0600); err != nil {
			t.Fatal(err)
		}
	}
	store, evidence, err := prepareSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatalf("signed preflight: %v", err)
	}
	if evidence.Intent.Source != f.source || evidence.Intent.Target.BuildID != "bridge-build-0002" {
		t.Fatal("incorrect release identity")
	}
	if err := evidence.Verify(); err != nil {
		t.Fatalf("evidence revalidation: %v", err)
	}
	receipt, err := InstallSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatalf("signed bridge entry: %v", err)
	}
	if receipt.BuildID != evidence.Intent.Target.BuildID || receipt.DescriptorSHA256 != evidence.Intent.Target.DescriptorSHA256 {
		t.Fatalf("wrong receipt %+v", receipt)
	}
	after, err := store.ReadActive()
	if err != nil || after.Receipt != evidence.Intent.Target || after.SelectorBuildID != evidence.Intent.Target.BuildID {
		t.Fatalf("wrong active selection %+v %v", after, err)
	}
	if err := verifyBridgeSelector(f.options.Home, evidence.Intent.ControllerSHA256); err != nil {
		t.Fatal(err)
	}
	for path, want := range sentinels {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("sentinel changed at %s: %q %v", path, got, err)
		}
	}
}

func TestSignedBridgePreflightRejectsUnsafeEvidence(t *testing.T) {
	t.Run("old-controller-compatibility", func(t *testing.T) {
		f := newSignedBridgeFixture(t, 1, false)
		if _, err := InstallSignedCachedBridge(f.options, f.input); err == nil || !strings.Contains(err.Error(), "compatibility") {
			t.Fatalf("old controller accepted: %v", err)
		}
	})
	t.Run("role", func(t *testing.T) {
		f := newSignedBridgeFixture(t, 2, false)
		f.claim.Role = "ordinary-release"
		raw, _ := json.Marshal(f.claim)
		sig, _ := json.Marshal(bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, signingMessage("jobctrl:bridge-attestation:v1\x00", raw)))})
		if err := os.WriteFile(f.input.AttestationPath, raw, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(f.input.AttestationSignaturePath, sig, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallSignedCachedBridge(f.options, f.input); err == nil {
			t.Fatal("non-bridge role accepted")
		}
	})
	t.Run("selector identity", func(t *testing.T) {
		f := newSignedBridgeFixture(t, 2, false)
		if _, err := f.store.WriteSelectedActive(f.source.Receipt, f.source.Generation, "other-build-0003", "curl"); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallSignedCachedBridge(f.options, f.input); err == nil {
			t.Fatal("different source selector accepted")
		}
	})
	t.Run("selector bytes", func(t *testing.T) {
		f := newSignedBridgeFixture(t, 2, false)
		store, _, err := prepareSignedCachedBridge(f.options, f.input)
		if err != nil {
			t.Fatal(err)
		}
		selector := filepath.Join(f.options.Home, "bin", "jobctrl")
		if err := os.WriteFile(selector, []byte("unrelated selector"), 0755); err != nil {
			t.Fatal(err)
		}
		if _, err := InstallSignedCachedBridge(f.options, f.input); err == nil {
			t.Fatal("changed selector accepted")
		}
		active, err := store.ReadActive()
		if err != nil || active != f.source {
			t.Fatalf("changed source on refusal: %+v %v", active, err)
		}
		got, err := os.ReadFile(selector)
		if err != nil || string(got) != "unrelated selector" {
			t.Fatalf("changed selector on refusal: %q %v", got, err)
		}
	})
	t.Run("controller mutation", func(t *testing.T) {
		f := newSignedBridgeFixture(t, 2, false)
		_, evidence, err := prepareSignedCachedBridge(f.options, f.input)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(f.options.Home, "releases", evidence.Intent.Target.BuildID, "payload", "launcher", "jobctrl")
		if err := os.WriteFile(target, []byte("tampered"), 0755); err != nil {
			t.Fatal(err)
		}
		if err := evidence.Verify(); err == nil {
			t.Fatal("tampered controller accepted")
		}
		if _, err := InstallSignedCachedBridge(f.options, f.input); err == nil {
			t.Fatal("public entry accepted tampered controller")
		}
		if active, err := f.store.ReadActive(); err != nil || active != f.source {
			t.Fatalf("controller refusal changed selection: %+v %v", active, err)
		}
	})
	t.Run("manifest mutation", func(t *testing.T) {
		f := newSignedBridgeFixture(t, 2, false)
		_, evidence, err := prepareSignedCachedBridge(f.options, f.input)
		if err != nil {
			t.Fatal(err)
		}
		target := filepath.Join(f.options.Home, "releases", evidence.Intent.Target.BuildID, "payload", "manifest.json")
		if err := os.WriteFile(target, []byte("tampered"), 0644); err != nil {
			t.Fatal(err)
		}
		if err := evidence.Verify(); err == nil {
			t.Fatal("tampered manifest accepted")
		}
		if _, err := InstallSignedCachedBridge(f.options, f.input); err == nil {
			t.Fatal("public entry accepted tampered manifest")
		}
		if active, err := f.store.ReadActive(); err != nil || active != f.source {
			t.Fatalf("manifest refusal changed selection: %+v %v", active, err)
		}
	})
}

func TestSignedBridgeEvidenceAllowsForwardRepairAfterSourceRevoked(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, true)
	store, evidence, err := prepareSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := errors.New("interrupted after policy")
	if err := bridgeSelection(store, evidence, func(stage string) error {
		if stage == "policy" {
			return interrupted
		}
		return nil
	}); !errors.Is(err, interrupted) {
		t.Fatalf("interrupt: %v", err)
	}
	if err := store.Permit(f.source.Receipt); err == nil {
		t.Fatal("source should be revoked")
	}
	// The exact source receipt remains inert signed evidence; the selected target
	// remains permitted and recovery may move only forward.
	recovered, err := InstallSignedCachedBridge(f.options, CachedBridgeInput{})
	if err != nil {
		t.Fatalf("forward recovery entry: %v", err)
	}
	active, err := store.ReadActive()
	if err != nil || active.Receipt.BuildID != recovered.BuildID || active.Receipt.DescriptorSHA256 != recovered.DescriptorSHA256 {
		t.Fatalf("wrong final target: %+v %v", active, err)
	}
}

type signedBridgeChildRequest struct {
	Home      string            `json:"home"`
	Input     CachedBridgeInput `json:"input"`
	PublicKey []byte            `json:"publicKey"`
	Boundary  string            `json:"boundary"`
}

// This subprocess uses only temporary signed fixtures, and kills itself after
// a completed checkpoint. It is not a physical power-loss or release test.
func TestSignedBridgeRecoveryChild(t *testing.T) {
	requestPath := os.Getenv("JOBCTRL_SIGNED_BRIDGE_CHILD_REQUEST")
	if requestPath == "" {
		t.Skip("child-process helper")
	}
	raw, err := os.ReadFile(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	var request signedBridgeChildRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	options := Options{Home: request.Home, Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": ed25519.PublicKey(request.PublicKey)}, Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, AcquisitionSource: "curl", RunCommand: func(string, ...string) (string, error) { return "", nil }}
	store, evidence, err := prepareSignedCachedBridge(options, request.Input)
	if err != nil {
		t.Fatal(err)
	}
	err = bridgeSelection(store, evidence, func(stage string) error {
		if stage == request.Boundary {
			_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		}
		return nil
	})
	t.Fatalf("checkpoint not reached: %v", err)
}

func TestSignedBridgeRecoversAfterInputLossAndProcessTermination(t *testing.T) {
	for _, boundary := range []string{"active", "policy"} {
		for _, bundleState := range []string{"valid", "missing", "tampered"} {
			t.Run(boundary+"/"+bundleState, func(t *testing.T) {
				f := newSignedBridgeFixture(t, 2, true)
				sentinels := map[string][]byte{
					filepath.Join(f.options.Home, "jobctrl.db"):     []byte("owned database"),
					filepath.Join(f.options.Home, "jobctrl.db-wal"): []byte("owned wal"),
					filepath.Join(f.options.Home, "jobctrl.db-shm"): []byte("owned shm"),
					filepath.Join(f.options.Home, "temporal.db"):    []byte("owned temporal"),
				}
				for path, data := range sentinels {
					if err := os.WriteFile(path, data, 0600); err != nil {
						t.Fatal(err)
					}
				}
				// Prepare once to determine the authenticated evidence digest and target.
				_, prepared, err := prepareSignedCachedBridge(f.options, f.input)
				if err != nil {
					t.Fatal(err)
				}
				request := signedBridgeChildRequest{Home: f.options.Home, Input: f.input, PublicKey: f.options.Trust["jobctrl-release-v1"], Boundary: boundary}
				requestRaw, err := json.Marshal(request)
				if err != nil {
					t.Fatal(err)
				}
				requestPath := writeBridgeInputFile(t, t.TempDir(), "request.json", requestRaw)
				child := exec.Command(os.Args[0], "-test.run=^TestSignedBridgeRecoveryChild$")
				child.Env = []string{"JOBCTRL_SIGNED_BRIDGE_CHILD_REQUEST=" + requestPath}
				output, err := child.CombinedOutput()
				var exit *exec.ExitError
				if !errors.As(err, &exit) {
					t.Fatalf("child did not terminate: %v %s", err, output)
				}
				status, ok := exit.Sys().(syscall.WaitStatus)
				if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
					t.Fatalf("unexpected child status %v %s", err, output)
				}
				active, err := f.store.ReadActive()
				if err != nil || active.Receipt != prepared.Intent.Target {
					t.Fatalf("target missing after termination: %+v %v", active, err)
				}
				for _, path := range []string{f.input.DescriptorPath, f.input.DescriptorSignaturePath, f.input.AttestationPath, f.input.AttestationSignaturePath, f.input.ArchivePath} {
					if err := os.Remove(path); err != nil {
						t.Fatal(err)
					}
				}
				bundlePath := bridgeEvidencePath(f.options.Home, prepared.Intent.EvidenceSHA256)
				switch bundleState {
				case "missing":
					if err := os.Remove(bundlePath); err != nil {
						t.Fatal(err)
					}
				case "tampered":
					if err := os.WriteFile(bundlePath, []byte("tampered"), 0600); err != nil {
						t.Fatal(err)
					}
				}
				beforeActive, err := os.ReadFile(filepath.Join(f.options.Home, release.ActiveFile))
				if err != nil {
					t.Fatal(err)
				}
				selectorPath := filepath.Join(f.options.Home, "bin", "jobctrl")
				beforeSelector, err := os.ReadFile(selectorPath)
				if err != nil {
					t.Fatal(err)
				}
				recovered, err := InstallSignedCachedBridge(f.options, CachedBridgeInput{})
				if bundleState == "valid" {
					if err != nil {
						t.Fatalf("recover using retained signed bundle: %v", err)
					}
					if recovered.BuildID != prepared.Intent.Target.BuildID || recovered.DescriptorSHA256 != prepared.Intent.Target.DescriptorSHA256 {
						t.Fatalf("wrong recovered receipt: %+v", recovered)
					}
					if err := verifyBridgeSelector(f.options.Home, prepared.Intent.ControllerSHA256); err != nil {
						t.Fatal(err)
					}
					final, err := f.store.ReadActive()
					if err != nil || final.Receipt != prepared.Intent.Target {
						t.Fatalf("target changed: %+v %v", final, err)
					}
				} else {
					if err == nil {
						t.Fatal("missing or tampered evidence accepted")
					}
					afterActive, readErr := os.ReadFile(filepath.Join(f.options.Home, release.ActiveFile))
					if readErr != nil || !bytes.Equal(beforeActive, afterActive) {
						t.Fatal("refusal altered active receipt")
					}
					afterSelector, readErr := os.ReadFile(selectorPath)
					if readErr != nil || !bytes.Equal(beforeSelector, afterSelector) {
						t.Fatal("refusal altered selector")
					}
				}
				for path, want := range sentinels {
					got, err := os.ReadFile(path)
					if err != nil || !bytes.Equal(got, want) {
						t.Fatalf("sentinel changed at %s: %q %v", path, got, err)
					}
				}
			})
		}
	}
}

func TestSignedBridgeLargePolicyInterruptedRecovery(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, true, 1200)
	store, evidence, err := prepareSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatal(err)
	}
	policy, _ := json.Marshal(evidence.Intent.Metadata)
	if len(policy) <= 16<<10 {
		t.Fatalf("fixture policy too small: %d", len(policy))
	}
	interrupted := errors.New("interrupted")
	if err := bridgeSelection(store, evidence, func(stage string) error {
		if stage == "policy" {
			return interrupted
		}
		return nil
	}); !errors.Is(err, interrupted) {
		t.Fatalf("checkpoint: %v", err)
	}
	if _, err := InstallSignedCachedBridge(f.options, CachedBridgeInput{}); err != nil {
		t.Fatalf("recover signed large policy: %v", err)
	}
	if err := verifyBridgeSelector(f.options.Home, evidence.Intent.ControllerSHA256); err != nil {
		t.Fatal(err)
	}
}

func TestSignedBridgeCompletedRetry(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	first, err := InstallSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatal(err)
	}
	before, err := f.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	selectorPath := filepath.Join(f.options.Home, "bin", "jobctrl")
	selector, err := os.ReadFile(selectorPath)
	if err != nil {
		t.Fatal(err)
	}
	again, err := InstallSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatalf("retry with original inputs: %v", err)
	}
	if first != again {
		t.Fatalf("receipt drift %+v %+v", first, again)
	}
	withoutFiles, err := InstallSignedCachedBridge(f.options, CachedBridgeInput{})
	if err != nil {
		t.Fatalf("retry without original inputs: %v", err)
	}
	if first != withoutFiles {
		t.Fatalf("receipt drift %+v %+v", first, withoutFiles)
	}
	after, err := f.store.ReadActive()
	if err != nil || after != before {
		t.Fatalf("retry changed active: %+v %v", after, err)
	}
	selectorAfter, err := os.ReadFile(selectorPath)
	if err != nil || !bytes.Equal(selector, selectorAfter) {
		t.Fatal("retry changed selector")
	}
}

func TestSignedBridgeConcurrentRequestsRemainConsistent(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	lock, err := f.store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	sentinels := map[string][]byte{filepath.Join(f.options.Home, "jobctrl.db"): []byte("owned job db"), filepath.Join(f.options.Home, "temporal.db"): []byte("owned temporal db")}
	for path, want := range sentinels {
		if err := os.WriteFile(path, want, 0600); err != nil {
			t.Fatal(err)
		}
	}
	start := make(chan struct{})
	ready := make(chan struct{}, 2)
	results := make(chan error, 2)
	for i := 0; i < 2; i++ {
		go func() {
			<-start
			ready <- struct{}{}
			_, err := InstallSignedCachedBridge(f.options, f.input)
			results <- err
		}()
	}
	close(start)
	<-ready
	<-ready
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	first, second := <-results, <-results
	if first != nil && second != nil {
		t.Fatalf("both concurrent requests failed: %v; %v", first, second)
	}
	// A concurrent loser may observe selection drift and refuse. The selected
	// receipt and controller must nevertheless describe one complete release.
	active, err := f.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	if active.Receipt.BuildID != "bridge-build-0002" || active.SelectorBuildID != active.Receipt.BuildID {
		t.Fatalf("mixed selection %+v", active)
	}
	if err := verifyBridgeSelector(f.options.Home, f.claim.ControllerSHA256); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(bridgeEvidencePath(f.options.Home, findBridgeEvidenceDigest(t, f.options.Home))); err != nil {
		t.Fatalf("signed evidence missing: %v", err)
	}
	for path, want := range sentinels {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("sentinel changed: %s %v", path, err)
		}
	}
}

func findBridgeEvidenceDigest(t *testing.T, home string) string {
	t.Helper()
	entries, err := os.ReadDir(home)
	if err != nil {
		t.Fatal(err)
	}
	const prefix = "bridge-evidence-"
	const suffix = ".json"
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), prefix) && strings.HasSuffix(entry.Name(), suffix) {
			return strings.TrimSuffix(strings.TrimPrefix(entry.Name(), prefix), suffix)
		}
	}
	t.Fatal("signed bridge evidence missing")
	return ""
}

// The real signed cached installer obtains transition then selection lock for
// an existing release. Holding selection forces its acquisition change to queue
// a prepared bridge behind it at the transition lock.
func TestSignedBridgeRejectsConcurrentSourceAcquisitionChange(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	_, evidence, err := prepareSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatal(err)
	}
	claimBefore, err := os.ReadFile(f.input.AttestationPath)
	if err != nil {
		t.Fatal(err)
	}
	selection, err := f.store.SelectionLock(true)
	if err != nil {
		t.Fatal(err)
	}
	held := true
	defer func() {
		if held {
			_ = selection.Close()
		}
	}()
	sourceOptions := f.options
	sourceOptions.AcquisitionSource = "homebrew"
	sourceDone := make(chan error, 1)
	go func() {
		_, err := InstallFromCachedFiles(sourceOptions, f.sourceInput.DescriptorURL, f.sourceInput.DescriptorPath, f.sourceInput.DescriptorSignaturePath, f.sourceInput.ArchivePath)
		sourceDone <- err
	}()
	// Detect the actual installer holding the transition lock while blocked on
	// selection, with a bounded wait. Every attempted probe is explicitly closed.
	deadline := time.Now().Add(10 * time.Second)
	for {
		probe, err := os.OpenFile(filepath.Join(f.options.Home, "transition.lock"), os.O_RDWR|syscall.O_NOFOLLOW, 0)
		if err != nil {
			t.Fatal(err)
		}
		err = syscall.Flock(int(probe.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
		if err == nil {
			_ = syscall.Flock(int(probe.Fd()), syscall.LOCK_UN)
			_ = probe.Close()
		} else {
			_ = probe.Close()
			if errors.Is(err, syscall.EWOULDBLOCK) || errors.Is(err, syscall.EAGAIN) {
				break
			}
			t.Fatal(err)
		}
		select {
		case err := <-sourceDone:
			t.Fatalf("source did not wait for selection: %v", err)
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("source did not acquire transition lock")
		}
		time.Sleep(10 * time.Millisecond)
	}
	bridgeDone := make(chan error, 1)
	go func() { bridgeDone <- bridgeSelection(f.store, evidence, nil) }()
	if err := selection.Close(); err != nil {
		t.Fatal(err)
	}
	held = false
	if err := <-sourceDone; err != nil {
		t.Fatalf("source acquisition: %v", err)
	}
	if err := <-bridgeDone; err == nil {
		t.Fatal("stale selection unexpectedly accepted")
	}
	active, err := f.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	if active.Receipt != f.source.Receipt || active.Generation != f.source.Generation+1 || active.Acquisition != "homebrew" {
		t.Fatalf("successor selection lost: %+v", active)
	}
	if err := verifyBridgeSelector(f.options.Home, evidence.Intent.SourceSelectorSHA256); err != nil {
		t.Fatal(err)
	}
	claimAfter, err := os.ReadFile(f.input.AttestationPath)
	if err != nil || !bytes.Equal(claimBefore, claimAfter) {
		t.Fatal("signed evidence changed")
	}
}

// This test creates a synthetic reselected predecessor, not a supported
// uninstall/reinstall. The signed channel rules normally refuse reinstalling a
// predecessor after a newer bridge sequence has been finalized.
func TestSignedBridgeCompletionDistinguishesSyntheticReselection(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	if _, err := InstallSignedCachedBridge(f.options, f.input); err != nil {
		t.Fatal(err)
	}
	first, err := f.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	completions := func() map[string][]byte {
		t.Helper()
		entries, err := os.ReadDir(f.options.Home)
		if err != nil {
			t.Fatal(err)
		}
		found := map[string][]byte{}
		for _, entry := range entries {
			if strings.HasPrefix(entry.Name(), "bridge-complete-") && strings.HasSuffix(entry.Name(), ".json") {
				raw, err := os.ReadFile(filepath.Join(f.options.Home, entry.Name()))
				if err != nil {
					t.Fatal(err)
				}
				found[entry.Name()] = raw
			}
		}
		return found
	}
	old := completions()
	if len(old) != 1 {
		t.Fatalf("expected one completion, got %d", len(old))
	}
	source := f.source.Receipt
	source.InstalledAt = "2099-01-01T00:00:00Z"
	sourceReceiptPath := filepath.Join(f.options.Home, "releases", source.BuildID, "receipt.json")
	sourceReceiptRaw, err := encodeJSON(source)
	if err != nil {
		t.Fatal(err)
	}
	if err := writeBytesAtomic(sourceReceiptPath, sourceReceiptRaw, 0600); err != nil {
		t.Fatal(err)
	}
	sourceExecutable, err := os.ReadFile(filepath.Join(f.options.Home, "releases", source.BuildID, "payload", "launcher", "jobctrl"))
	if err != nil {
		t.Fatal(err)
	}
	transition, err := f.store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	selection, err := f.store.SelectionLock(true)
	if err != nil {
		_ = transition.Close()
		t.Fatal(err)
	}
	_, writeErr := f.store.WriteSelectedActive(source, first.Generation, source.BuildID, first.Acquisition)
	if writeErr == nil {
		writeErr = writeBytesAtomic(filepath.Join(f.options.Home, "bin", "jobctrl"), sourceExecutable, 0755)
	}
	_ = selection.Close()
	_ = transition.Close()
	if writeErr != nil {
		t.Fatal(writeErr)
	}
	reselected, err := f.store.ReadActive()
	if err != nil || reselected.Generation != first.Generation+1 || reselected.Receipt.InstalledAt != source.InstalledAt {
		t.Fatalf("synthetic reselect: %+v %v", reselected, err)
	}
	second, err := InstallSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatalf("second bridge: %v", err)
	}
	final, err := f.store.ReadActive()
	if err != nil || final.Generation != reselected.Generation+1 || final.Receipt.BuildID != second.BuildID || final.SelectorBuildID != second.BuildID {
		t.Fatalf("second bridge selection: %+v %v", final, err)
	}
	if err := verifyBridgeSelector(f.options.Home, f.claim.ControllerSHA256); err != nil {
		t.Fatal(err)
	}
	updated := completions()
	if len(updated) != 2 {
		t.Fatalf("expected two distinct completions, got %d", len(updated))
	}
	for name, bytesBefore := range old {
		if !bytes.Equal(bytesBefore, updated[name]) {
			t.Fatal("original completion changed")
		}
	}
}

// This mimics the exact runtime-store paths removed by normal uninstall in an
// owned fixture; it retains channel safety records and bridge evidence. It does
// not call the public uninstall command or delete real data.
func TestSignedBridgePreservedChannelRejectsOlderReinstall(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	if _, err := InstallSignedCachedBridge(f.options, f.input); err != nil {
		t.Fatal(err)
	}
	evidenceBefore := findBridgeEvidenceDigest(t, f.options.Home)
	for _, name := range []string{"bin", "releases", "staging", "instances", release.ActiveFile, "current.json", "acquisition.json", release.JournalFile, "install.lock"} {
		if err := os.RemoveAll(filepath.Join(f.options.Home, name)); err != nil {
			t.Fatal(err)
		}
	}
	_, err := InstallFromCachedFiles(f.options, f.sourceInput.DescriptorURL, f.sourceInput.DescriptorPath, f.sourceInput.DescriptorSignaturePath, f.sourceInput.ArchivePath)
	if err == nil || !strings.Contains(err.Error(), "below recorded maximum") {
		t.Fatalf("older predecessor reinstall not refused: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(f.options.Home, release.ActiveFile)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("refused reinstall selected active: %v", err)
	}
	if _, err := os.Stat(bridgeEvidencePath(f.options.Home, evidenceBefore)); err != nil {
		t.Fatalf("retained evidence changed: %v", err)
	}
}

// Compile the actual command with a synthetic public key; this injects no
// production credential or signing authority. The only payloads are fixtures.
func compileSignedBridgeCLI(t *testing.T, public ed25519.PublicKey) string {
	t.Helper()
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("compiled product CLI supports darwin-arm64")
	}
	path := filepath.Join(t.TempDir(), "jobctrl-installer")
	base := "github.com/ebarti/jobctrl/launcher/internal/launcher."
	flags := "-X " + base + "releaseTrustKeyBase64=" + base64.StdEncoding.EncodeToString(public) + " -X " + base + "releaseChannel=stable"
	cmd := exec.Command("go", "build", "-ldflags", flags, "-o", path, "../../cmd/jobctrl-installer")
	cmd.Env = append(os.Environ(), "GOCACHE=/private/tmp/jobctrl-1280-go-cache", "GOPROXY=off", "GOTOOLCHAIN=local")
	out, err := cmd.CombinedOutput()
	if err != nil {
		t.Fatalf("build installer: %v %s", err, out)
	}
	return path
}

func TestCompiledSignedBridgeCLIRecovery(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, true)
	cliSource := filepath.Join("..", "..", "cmd", "jobctrl-installer", "main.go")
	before, err := os.ReadFile(cliSource)
	if err != nil {
		t.Fatal(err)
	}
	cli := compileSignedBridgeCLI(t, f.options.Trust["jobctrl-release-v1"])
	_, prepared, err := prepareSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatal(err)
	}
	data := map[string][]byte{filepath.Join(f.options.Home, "jobctrl.db"): []byte("owned database"), filepath.Join(f.options.Home, "jobctrl.db-wal"): []byte("owned wal"), filepath.Join(f.options.Home, "jobctrl.db-shm"): []byte("owned shm"), filepath.Join(f.options.Home, "temporal.db"): []byte("owned temporal")}
	for path, want := range data {
		if err := os.WriteFile(path, want, 0600); err != nil {
			t.Fatal(err)
		}
	}
	request := signedBridgeChildRequest{Home: f.options.Home, Input: f.input, PublicKey: f.options.Trust["jobctrl-release-v1"], Boundary: "policy"}
	raw, _ := json.Marshal(request)
	requestPath := writeBridgeInputFile(t, t.TempDir(), "request.json", raw)
	child := exec.Command(os.Args[0], "-test.run=^TestSignedBridgeRecoveryChild$")
	child.Env = []string{"JOBCTRL_SIGNED_BRIDGE_CHILD_REQUEST=" + requestPath}
	output, err := child.CombinedOutput()
	var exit *exec.ExitError
	if !errors.As(err, &exit) {
		t.Fatalf("interruption missing: %v %s", err, output)
	}
	status, ok := exit.Sys().(syscall.WaitStatus)
	if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
		t.Fatalf("wrong child status: %v %s", err, output)
	}
	for _, path := range []string{f.input.DescriptorPath, f.input.DescriptorSignaturePath, f.input.AttestationPath, f.input.AttestationSignaturePath, f.input.ArchivePath} {
		if err := os.Remove(path); err != nil {
			t.Fatal(err)
		}
	}
	run := exec.Command(cli, "--home", f.options.Home, "--bridge-recover", "--json")
	run.Env = []string{"PATH=/usr/bin:/bin"}
	output, err = run.CombinedOutput()
	if err != nil {
		t.Fatalf("compiled recovery: %v %s", err, output)
	}
	var result Receipt
	if err := json.Unmarshal(output, &result); err != nil {
		t.Fatalf("receipt JSON: %v %s", err, output)
	}
	if result.BuildID != prepared.Intent.Target.BuildID || result.DescriptorSHA256 != prepared.Intent.Target.DescriptorSHA256 {
		t.Fatalf("wrong recovered receipt %+v", result)
	}
	active, err := f.store.ReadActive()
	if err != nil || active.Receipt != prepared.Intent.Target || active.SelectorBuildID != active.Receipt.BuildID {
		t.Fatalf("wrong recovered selection %+v %v", active, err)
	}
	if err := verifyBridgeSelector(f.options.Home, prepared.Intent.ControllerSHA256); err != nil {
		t.Fatal(err)
	}
	for path, want := range data {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, want) {
			t.Fatalf("data changed %s: %v", path, err)
		}
	}
	after, err := os.ReadFile(cliSource)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("CLI source changed during build/test")
	}
}

func TestCompiledSignedBridgeCLIFreshRejectsSyntheticNotarization(t *testing.T) {
	f := newSignedBridgeFixture(t, 2, false)
	cliSource := filepath.Join("..", "..", "cmd", "jobctrl-installer", "main.go")
	before, err := os.ReadFile(cliSource)
	if err != nil {
		t.Fatal(err)
	}
	cli := compileSignedBridgeCLI(t, f.options.Trust["jobctrl-release-v1"])
	selectorPath := filepath.Join(f.options.Home, "bin", "jobctrl")
	selector, err := os.ReadFile(selectorPath)
	if err != nil {
		t.Fatal(err)
	}
	args := []string{"--home", f.options.Home, "--source", "curl", "--descriptor-url", f.input.DescriptorURL, "--descriptor-file", f.input.DescriptorPath, "--signature-file", f.input.DescriptorSignaturePath, "--archive-file", f.input.ArchivePath, "--bridge-role-file", f.input.AttestationPath, "--bridge-role-signature-file", f.input.AttestationSignaturePath, "--json"}
	run := exec.Command(cli, args...)
	run.Env = []string{"PATH=/usr/bin:/bin"}
	output, err := run.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "code signature verification failed") {
		t.Fatalf("synthetic code signature was not refused: %v %s", err, output)
	}
	active, err := f.store.ReadActive()
	if err != nil || active != f.source {
		t.Fatalf("failure changed active: %+v %v", active, err)
	}
	got, err := os.ReadFile(selectorPath)
	if err != nil || !bytes.Equal(got, selector) {
		t.Fatal("failure changed selector")
	}
	after, err := os.ReadFile(cliSource)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("CLI source changed during build/test")
	}
}

func TestSignedBridgeRecoveryRejectsForgedDescriptorOwnedReceiptFields(t *testing.T) {
	changes := map[string]func(*release.Receipt){
		"artifact": func(r *release.Receipt) { r.ArtifactSHA256 = strings.Repeat("0", 64) },
		"manifest": func(r *release.Receipt) { r.ManifestSHA256 = strings.Repeat("1", 64) },
		"sequence": func(r *release.Receipt) { r.Sequence++ },
		"channel":  func(r *release.Receipt) { r.Channel = "prerelease" },
	}
	for name, change := range changes {
		t.Run(name, func(t *testing.T) {
			f := newSignedBridgeFixture(t, 2, false)
			data := map[string][]byte{filepath.Join(f.options.Home, "jobctrl.db"): []byte("owned database"), filepath.Join(f.options.Home, "jobctrl.db-wal"): []byte("owned wal"), filepath.Join(f.options.Home, "jobctrl.db-shm"): []byte("owned shm"), filepath.Join(f.options.Home, "temporal.db"): []byte("owned temporal")}
			for path, value := range data {
				if err := os.WriteFile(path, value, 0600); err != nil {
					t.Fatal(err)
				}
			}
			request := signedBridgeChildRequest{Home: f.options.Home, Input: f.input, PublicKey: f.options.Trust["jobctrl-release-v1"], Boundary: "active"}
			raw, err := json.Marshal(request)
			if err != nil {
				t.Fatal(err)
			}
			requestPath := writeBridgeInputFile(t, t.TempDir(), "request.json", raw)
			child := exec.Command(os.Args[0], "-test.run=^TestSignedBridgeRecoveryChild$")
			child.Env = []string{"JOBCTRL_SIGNED_BRIDGE_CHILD_REQUEST=" + requestPath}
			output, err := child.CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) {
				t.Fatalf("child did not terminate: %v %s", err, output)
			}
			status, ok := exit.Sys().(syscall.WaitStatus)
			if !ok || !status.Signaled() || status.Signal() != syscall.SIGKILL {
				t.Fatalf("unexpected child status: %v %s", err, output)
			}
			intentPath := filepath.Join(f.options.Home, bridgeIntentName)
			intentRaw, err := os.ReadFile(intentPath)
			if err != nil {
				t.Fatal(err)
			}
			var intent bridgeHandoffIntent
			if err := json.Unmarshal(intentRaw, &intent); err != nil {
				t.Fatal(err)
			}
			current, err := f.store.ReadActive()
			if err != nil || current.Receipt != intent.Target {
				t.Fatalf("unexpected initial target: %+v %v", current, err)
			}
			change(&intent.Target)
			current.Receipt = intent.Target
			forgedIntent, err := encodeJSON(intent)
			if err != nil {
				t.Fatal(err)
			}
			forgedActive, err := encodeJSON(current)
			if err != nil {
				t.Fatal(err)
			}
			forgedReceipt, err := encodeJSON(intent.Target)
			if err != nil {
				t.Fatal(err)
			}
			receiptPath := filepath.Join(f.options.Home, "releases", intent.Target.BuildID, "receipt.json")
			if err := writeBytesAtomic(intentPath, forgedIntent, 0600); err != nil {
				t.Fatal(err)
			}
			if err := writeBytesAtomic(receiptPath, forgedReceipt, 0600); err != nil {
				t.Fatal(err)
			}
			if err := writeBytesAtomic(filepath.Join(f.options.Home, release.ActiveFile), forgedActive, 0600); err != nil {
				t.Fatal(err)
			}
			selectorPath := filepath.Join(f.options.Home, "bin", "jobctrl")
			selectorBefore, err := os.ReadFile(selectorPath)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := InstallSignedCachedBridge(f.options, CachedBridgeInput{}); err == nil || !strings.Contains(err.Error(), "signed descriptor") {
				t.Fatalf("forged %s not rejected by signed descriptor: %v", name, err)
			}
			for path, want := range map[string][]byte{intentPath: forgedIntent, receiptPath: forgedReceipt, filepath.Join(f.options.Home, release.ActiveFile): forgedActive, selectorPath: selectorBefore} {
				got, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(got, want) {
					t.Fatalf("refusal changed %s: %v", path, err)
				}
			}
			for path, want := range data {
				got, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(got, want) {
					t.Fatalf("database sentinel changed %s: %v", path, err)
				}
			}
		})
	}
}
