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
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// TestHomebrewBootstrapSignedFirstRunFastPathAndCompatibleUpgrade exercises
// the boundary exactly as a formula-installed bootstrap sees it. The formula
// cache is deliberately treated as untrusted until the injected installer
// boundary authenticates its descriptor and payload; everything after that
// point is the real first-install, selector, and common promotion code.
func TestHomebrewBootstrapSignedFirstRunFastPathAndCompatibleUpgrade(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 is required for the common promotion fixture")
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)

	initial := newSignedHomebrewBootstrapFixture(t, private, "stable-homebrew-build-0001", 1, 1, python)
	upgrade := newSignedHomebrewBootstrapFixture(t, private, "stable-homebrew-build-0002", 2, 2, python)
	formulaRoot := t.TempDir()
	formulaExecutable := writeHomebrewBootstrapFormula(t, formulaRoot, initial)
	runtimeHome, stateHome := t.TempDir(), t.TempDir()
	stateDir := filepath.Join(stateHome, "state")
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	seedHomebrewSQLitePair(t, python, stateDir)
	environment := []string{
		"HOME=" + t.TempDir(),
		"JOBCTRL_RUNTIME_HOME=" + runtimeHome,
		"JOBCTRL_DIR=" + stateDir,
		"JOBCTRL_TEST_START_MARKER=" + filepath.Join(stateHome, "candidate-started"),
	}

	previousInstaller, previousExec := homebrewInstallerCommand, execPublicSelector
	t.Cleanup(func() {
		homebrewInstallerCommand, execPublicSelector = previousInstaller, previousExec
	})
	installerCalls := 0
	homebrewInstallerCommand = authenticatedHomebrewFixtureInstaller(t, public, map[string]homebrewBootstrapFixture{
		initial.descriptorSHA256: initial,
		upgrade.descriptorSHA256: upgrade,
	}, &installerCalls)
	var selectorCalls []homebrewSelectorCall
	execPublicSelector = func(selector string, args, env []string) error {
		selectorCalls = append(selectorCalls, homebrewSelectorCall{selector: selector, args: append([]string(nil), args...)})
		if !sameStringSet(env, environment) {
			return errors.New("Homebrew selector execution changed the inherited environment")
		}
		return VerifyPublicSelectorForExecution(runtimeHome)
	}

	var stdout, stderr bytes.Buffer
	bootstrapped, err := maybeHomebrewBootstrap(formulaExecutable, []string{"status"}, environment, &stdout, &stderr)
	if !bootstrapped || err != nil {
		t.Fatalf("first signed Homebrew invocation = bootstrapped:%v err:%v stdout=%q stderr=%q", bootstrapped, err, stdout.String(), stderr.String())
	}
	if installerCalls != 1 {
		t.Fatalf("first invocation installer calls = %d, want 1", installerCalls)
	}
	assertHomebrewSelectorCalls(t, selectorCalls, runtimeHome, 1)
	store, err := release.Open(runtimeHome)
	if err != nil {
		t.Fatal(err)
	}
	active, err := store.ReadActive()
	if err != nil || active.Receipt != initial.receipt || active.Acquisition != "homebrew" || active.SelectorBuildID != initial.receipt.BuildID {
		t.Fatalf("first invocation active record = %#v, %v", active, err)
	}
	if channel, err := store.ReadChannelState("stable"); err != nil || channel.MaxSequence != initial.receipt.Sequence || channel.SequenceBuildIDs["1"] != initial.receipt.BuildID {
		t.Fatalf("first invocation did not finalize signed stable policy: %#v, %v", channel, err)
	}
	if err := VerifyPublicSelectorForExecution(runtimeHome); err != nil {
		t.Fatalf("first invocation selector is not executable: %v", err)
	}
	firstGeneration := active.Generation

	bootstrapped, err = maybeHomebrewBootstrap(formulaExecutable, []string{"status"}, environment, &stdout, &stderr)
	if !bootstrapped || err != nil {
		t.Fatalf("second exact Homebrew invocation = bootstrapped:%v err:%v", bootstrapped, err)
	}
	if installerCalls != 1 {
		t.Fatalf("idempotent fast path reinvoked the installer: %d calls", installerCalls)
	}
	assertHomebrewSelectorCalls(t, selectorCalls, runtimeHome, 2)
	second, err := store.ReadActive()
	if err != nil || second.Receipt != initial.receipt || second.SelectorBuildID != initial.receipt.BuildID || second.Acquisition != "homebrew" || second.Generation != firstGeneration {
		t.Fatalf("fast path changed selected release identity: %#v, %v", second, err)
	}

	writeHomebrewBootstrapFormula(t, formulaRoot, upgrade)
	bootstrapped, err = maybeHomebrewBootstrap(formulaExecutable, []string{"status"}, environment, &stdout, &stderr)
	if !bootstrapped || err != nil {
		t.Fatalf("compatible protocol-changing Homebrew upgrade = bootstrapped:%v err:%v stdout=%q stderr=%q", bootstrapped, err, stdout.String(), stderr.String())
	}
	if installerCalls != 2 {
		t.Fatalf("upgrade installer calls = %d, want 2", installerCalls)
	}
	assertHomebrewSelectorCalls(t, selectorCalls, runtimeHome, 3)
	active, err = store.ReadActive()
	if err != nil || active.Receipt != upgrade.receipt || active.Acquisition != "homebrew" || active.SelectorBuildID != upgrade.receipt.BuildID {
		t.Fatalf("common promotion did not select the upgraded release: %#v, %v", active, err)
	}
	journal, err := store.ReadJournal()
	if err != nil || journal.Operation != "update" || journal.State != release.Promoted || journal.Old == nil || journal.Candidate == nil || *journal.Old != initial.receipt || *journal.Candidate != upgrade.receipt {
		t.Fatalf("upgrade did not complete the common health-gated promotion journal: %#v, %v", journal, err)
	}
	started, err := os.ReadFile(filepath.Join(stateHome, "candidate-started"))
	if err != nil || string(started) != "start --no-open\n" {
		t.Fatalf("candidate launcher was not started by the common health gate: %q, %v", started, err)
	}
	selector, err := os.ReadFile(filepath.Join(runtimeHome, "bin", "jobctrl"))
	if err != nil {
		t.Fatal(err)
	}
	candidateSelector, err := os.ReadFile(filepath.Join(runtimeHome, "releases", upgrade.receipt.BuildID, "payload", "launcher", "jobctrl"))
	if err != nil || !bytes.Equal(selector, candidateSelector) {
		t.Fatalf("compatible upgrade did not hand off the candidate public selector: %v", err)
	}
	if err := VerifyPublicSelectorForExecution(runtimeHome); err != nil {
		t.Fatalf("upgraded public selector is not executable: %v", err)
	}
}

func TestHomebrewBootstrapRejectsPreseededUnsignedLocalRelease(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	fixture := newSignedHomebrewBootstrapFixture(t, private, "stable-homebrew-build-0010", 10, 1, "/usr/bin/python3")
	formulaRoot := t.TempDir()
	formulaExecutable := writeHomebrewBootstrapFormula(t, formulaRoot, fixture)
	runtimeHome := t.TempDir()
	store, err := release.Open(runtimeHome)
	if err != nil {
		t.Fatal(err)
	}
	preseedUnsignedHomebrewRelease(t, runtimeHome, fixture)
	if err := bootstrapFirstInstall(store, fixture.receipt); err == nil || !strings.Contains(err.Error(), "distribution channel") {
		t.Fatalf("preseeded unsigned-local release was accepted by real first-install verification: %v", err)
	}
	if _, err := store.ReadActive(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("rejected preseed unexpectedly became active: %v", err)
	}

	previousInstaller := homebrewInstallerCommand
	t.Cleanup(func() { homebrewInstallerCommand = previousInstaller })
	homebrewInstallerCommand = func(_ string, _ []string, _ []string) (string, error) {
		if _, err := verifyInstalledReleaseForExecution(store, fixture.receipt); err == nil {
			t.Fatal("preseeded unsigned-local release unexpectedly passed signed execution verification")
		} else {
			return "", fmt.Errorf("authenticated installer rejected preseeded release: %w", err)
		}
		return "", nil
	}
	bootstrapped, err := maybeHomebrewBootstrap(formulaExecutable, []string{"status"}, []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtimeHome}, io.Discard, io.Discard)
	if !bootstrapped || err == nil || !strings.Contains(err.Error(), "authenticated installer rejected preseeded release") {
		t.Fatalf("Homebrew bootstrap did not reject the preseeded unsigned-local release: bootstrapped:%v err:%v", bootstrapped, err)
	}
}

func TestHomebrewBootstrapUninstallWithoutActiveReleaseDoesNotInstallFirst(t *testing.T) {
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	fixture := newSignedHomebrewBootstrapFixture(t, private, "stable-homebrew-build-0099", 99, 1, "/usr/bin/python3")
	formulaExecutable := writeHomebrewBootstrapFormula(t, t.TempDir(), fixture)
	runtimeHome, stateDir := t.TempDir(), t.TempDir()
	preserved := filepath.Join(stateDir, "profile.json")
	if err := os.WriteFile(preserved, []byte("preserve me"), 0o600); err != nil {
		t.Fatal(err)
	}

	oldInstaller, oldBrew := homebrewInstallerCommand, homebrewCommand
	t.Cleanup(func() { homebrewInstallerCommand, homebrewCommand = oldInstaller, oldBrew })
	homebrewInstallerCommand = func(_ string, _ []string, _ []string) (string, error) {
		t.Fatal("uninstall without an active release invoked the acquisition installer")
		return "", nil
	}
	brewCalls := 0
	homebrewCommand = func(args ...string) (string, error) {
		brewCalls++
		if strings.Join(args, " ") != "uninstall ebarti/tap/jobctrl" {
			t.Fatalf("unexpected Homebrew command: %v", args)
		}
		return "uninstalled\n", nil
	}
	environment := []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtimeHome, "JOBCTRL_DIR=" + stateDir}
	var output bytes.Buffer
	bootstrapped, err := maybeHomebrewBootstrap(formulaExecutable, []string{"uninstall"}, environment, &output, io.Discard)
	if !bootstrapped || err != nil || brewCalls != 1 {
		t.Fatalf("no-active Homebrew uninstall = bootstrapped:%v err:%v brewCalls:%d output:%q", bootstrapped, err, brewCalls, output.String())
	}
	if raw, err := os.ReadFile(preserved); err != nil || string(raw) != "preserve me" {
		t.Fatalf("default no-active uninstall changed user data: %q, %v", raw, err)
	}
	store, err := release.Open(runtimeHome)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.ReadActive(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uninstall unexpectedly activated formula release: %v", err)
	}
}

type homebrewBootstrapFixture struct {
	buildID          string
	descriptorURL    string
	descriptorRaw    []byte
	signatureRaw     []byte
	archive          []byte
	descriptorSHA256 string
	payloadRoot      string
	receipt          release.Receipt
	policy           release.ChannelMetadata
}

type homebrewSelectorCall struct {
	selector string
	args     []string
}

type homebrewFixtureDescriptor struct {
	SchemaVersion int    `json:"schemaVersion"`
	Channel       string `json:"channel"`
	Sequence      uint64 `json:"sequence"`
	BuildID       string `json:"buildId"`
	AppVersion    string `json:"appVersion"`
	SourceCommit  string `json:"sourceCommit"`
	Artifact      struct {
		URL            string `json:"url"`
		SHA256         string `json:"sha256"`
		SizeBytes      int64  `json:"sizeBytes"`
		ArchiveType    string `json:"archiveType"`
		ManifestSHA256 string `json:"manifestSha256"`
	} `json:"artifact"`
}

type homebrewFixtureSignature struct {
	SchemaVersion int    `json:"schemaVersion"`
	Status        string `json:"status"`
	Algorithm     string `json:"algorithm"`
	KeyID         string `json:"keyId"`
	Signature     string `json:"signature"`
}

func setSignedHomebrewTrust(t *testing.T, public ed25519.PublicKey) {
	t.Helper()
	previousChannel, previousKey := releaseChannel, releaseTrustKeyBase64
	t.Cleanup(func() { releaseChannel, releaseTrustKeyBase64 = previousChannel, previousKey })
	releaseChannel = "stable"
	releaseTrustKeyBase64 = base64.StdEncoding.EncodeToString(public)
	if policy, err := AcquisitionBuildPolicy(); err != nil || policy.ExpectedChannel != "stable" || policy.AllowUnsignedLocal || !policy.AllowNetwork {
		t.Fatalf("injected signed Homebrew trust policy = %#v, %v", policy, err)
	}
}

func newSignedHomebrewBootstrapFixture(t *testing.T, private ed25519.PrivateKey, buildID string, sequence uint64, launcherRuntimeProtocol int, python string) homebrewBootstrapFixture {
	t.Helper()
	payloadRoot, manifest := verifiedPayloadFixture(t)
	launcher := "#!/bin/sh\nif [ \"$1\" = start ] && [ -n \"${JOBCTRL_TEST_START_MARKER:-}\" ]; then\n  printf '%s %s\\n' \"$1\" \"${2:-}\" > \"$JOBCTRL_TEST_START_MARKER\"\nfi\nexit 0\n"
	if err := os.WriteFile(filepath.Join(payloadRoot, "launcher", "jobctrl"), []byte(launcher), 0o755); err != nil {
		t.Fatal(err)
	}
	runtime := strings.Replace(validRuntimeManifest, `"launcherProtocol":1`, fmt.Sprintf(`"launcherProtocol":%d`, launcherRuntimeProtocol), 1)
	if err := os.WriteFile(filepath.Join(payloadRoot, "launcher", "runtime-manifest.json"), []byte(runtime), 0o644); err != nil {
		t.Fatal(err)
	}
	pythonWrapper := "#!/bin/sh\nexec " + strconv.Quote(python) + " \"$@\"\n"
	pythonPath := filepath.Join(payloadRoot, "python", "bin", "python3")
	if err := os.MkdirAll(filepath.Dir(pythonPath), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pythonPath, []byte(pythonWrapper), 0o755); err != nil {
		t.Fatal(err)
	}
	manifest.BuildID = buildID
	manifest.ReleaseChannel = "stable"
	manifest.LauncherCompatibility.Minimum, manifest.LauncherCompatibility.Maximum = 1, 2
	manifest.Signing.ManifestKeyID = "jobctrl-release-v1"
	manifest.Signing.CodeSigning = "developer-id"
	manifest.Signing.Notarized = true
	refreshFixtureManifest(t, payloadRoot, &manifest)
	manifestRaw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	manifestSignatureEncoded := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:manifest:v1\x00", manifestRaw)))
	manifestSignatureRaw, err := json.Marshal(manifestSignature{SchemaVersion: 1, Status: "signed", ManifestAlgorithm: "ed25519", ManifestKeyID: "jobctrl-release-v1", Signature: &manifestSignatureEncoded, Promotable: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payloadRoot, "manifest.json"), manifestRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payloadRoot, "manifest.sig"), manifestSignatureRaw, 0o644); err != nil {
		t.Fatal(err)
	}
	manifestDigest := sha256.Sum256(manifestRaw)
	archive := []byte("signed Homebrew cache fixture for " + buildID + "\n")
	archiveDigest := sha256.Sum256(archive)
	descriptorURL := "https://releases.jobctrl.dev/v1/artifacts/" + buildID + "/release-descriptor.json"
	descriptor := homebrewFixtureDescriptor{SchemaVersion: 1, Channel: "stable", Sequence: sequence, BuildID: buildID, AppVersion: "2.0.0", SourceCommit: strings.Repeat("a", 40)}
	descriptor.Artifact.URL = "https://releases.jobctrl.dev/v1/artifacts/" + buildID + "/jobctrl-2.0.0-darwin-arm64.zip"
	descriptor.Artifact.SHA256 = hex.EncodeToString(archiveDigest[:])
	descriptor.Artifact.SizeBytes = int64(len(archive))
	descriptor.Artifact.ArchiveType = "zip"
	descriptor.Artifact.ManifestSHA256 = hex.EncodeToString(manifestDigest[:])
	// Keep the descriptor in the same exact public shape the cached installer
	// receives, including its minimum-safe and revocation policy fields.
	descriptorEnvelope := map[string]any{
		"schemaVersion": 1, "channel": "stable", "sequence": sequence, "minimumSafeSequence": sequence, "revokedBuildIds": []string{}, "buildId": buildID, "appVersion": "2.0.0", "sourceCommit": descriptor.SourceCommit,
		"platform": map[string]any{"id": "darwin-arm64", "os": "darwin", "arch": "arm64"},
		"artifact": map[string]any{"url": descriptor.Artifact.URL, "sha256": descriptor.Artifact.SHA256, "sizeBytes": descriptor.Artifact.SizeBytes, "archiveType": descriptor.Artifact.ArchiveType, "manifestSha256": descriptor.Artifact.ManifestSHA256},
	}
	descriptorRaw, err := json.Marshal(descriptorEnvelope)
	if err != nil {
		t.Fatal(err)
	}
	descriptorSignature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:release-descriptor:v1\x00", descriptorRaw)))
	signatureRaw, err := json.Marshal(homebrewFixtureSignature{SchemaVersion: 1, Status: "signed", Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: descriptorSignature})
	if err != nil {
		t.Fatal(err)
	}
	descriptorDigest := sha256.Sum256(descriptorRaw)
	policy := release.ChannelMetadata{Channel: "stable", Sequence: sequence, Minimum: sequence, BuildID: buildID, DescriptorDigest: hex.EncodeToString(descriptorDigest[:]), Revoked: []string{}}
	fixture := homebrewBootstrapFixture{
		buildID: buildID, descriptorURL: descriptorURL, descriptorRaw: descriptorRaw, signatureRaw: signatureRaw, archive: archive,
		descriptorSHA256: hex.EncodeToString(descriptorDigest[:]), payloadRoot: payloadRoot,
		receipt: release.Receipt{SchemaVersion: 2, BuildID: buildID, Channel: "stable", Sequence: sequence, ArtifactSHA256: descriptor.Artifact.SHA256, ManifestSHA256: hex.EncodeToString(manifestDigest[:]), DescriptorSHA256: hex.EncodeToString(descriptorDigest[:]), PolicySHA256: lifecyclePolicyDigest(t, policy), DescriptorURL: descriptorURL, InstalledAt: time.Now().UTC().Format(time.RFC3339Nano)},
		policy:  policy,
	}
	return fixture
}

func writeHomebrewBootstrapFormula(t *testing.T, root string, fixture homebrewBootstrapFixture) string {
	t.Helper()
	if err := os.MkdirAll(root, 0o755); err != nil {
		t.Fatal(err)
	}
	executable := filepath.Join(root, "jobctrl")
	if err := os.WriteFile(executable, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	installer := filepath.Join(root, "jobctrl-installer")
	if err := os.WriteFile(installer, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	for name, contents := range map[string][]byte{"descriptor.json": fixture.descriptorRaw, "descriptor.json.sig": fixture.signatureRaw, "archive.zip": fixture.archive} {
		if err := os.WriteFile(filepath.Join(root, name), contents, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	config, err := json.Marshal(homebrewBootstrapConfig{SchemaVersion: 1, DescriptorURL: fixture.descriptorURL, Descriptor: "descriptor.json", Signature: "descriptor.json.sig", Archive: "archive.zip", BuildID: fixture.buildID, DescriptorSHA256: fixture.descriptorSHA256})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "homebrew-bootstrap.json"), config, 0o644); err != nil {
		t.Fatal(err)
	}
	return executable
}

func authenticatedHomebrewFixtureInstaller(t *testing.T, public ed25519.PublicKey, fixtures map[string]homebrewBootstrapFixture, calls *int) func(string, []string, []string) (string, error) {
	t.Helper()
	return func(path string, args []string, env []string) (string, error) {
		*calls++
		if filepath.Base(path) != "jobctrl-installer" || homebrewArgument(args, "--source") != "homebrew" || !homebrewHasArgument(args, "--stage-only") {
			return "", fmt.Errorf("unexpected Homebrew installer boundary invocation: %s %v", path, args)
		}
		if environmentMap(env)["JOBCTRL_RUNTIME_HOME"] == "" {
			return "", errors.New("Homebrew installer lost its runtime-home environment")
		}
		descriptorPath, signaturePath, archivePath, home := homebrewArgument(args, "--descriptor-file"), homebrewArgument(args, "--signature-file"), homebrewArgument(args, "--archive-file"), homebrewArgument(args, "--home")
		descriptorRaw, err := os.ReadFile(descriptorPath)
		if err != nil {
			return "", err
		}
		digest := sha256.Sum256(descriptorRaw)
		fixture, exists := fixtures[hex.EncodeToString(digest[:])]
		if !exists || homebrewArgument(args, "--descriptor-url") != fixture.descriptorURL {
			return "", errors.New("Homebrew installer received an unknown descriptor-bound candidate")
		}
		signatureRaw, err := os.ReadFile(signaturePath)
		if err != nil || !bytes.Equal(descriptorRaw, fixture.descriptorRaw) || !bytes.Equal(signatureRaw, fixture.signatureRaw) {
			return "", errors.New("Homebrew installer cache files do not match the signed fixture")
		}
		archive, err := os.ReadFile(archivePath)
		if err != nil || !bytes.Equal(archive, fixture.archive) {
			return "", errors.New("Homebrew installer archive cache does not match the signed fixture")
		}
		if err := verifyHomebrewFixtureDescriptor(public, fixture); err != nil {
			return "", err
		}
		if _, err := VerifyDistributionPayload(fixture.payloadRoot, DistributionTrust{PublicKeys: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, ExpectedChannel: "stable"}); err != nil {
			return "", fmt.Errorf("authenticate signed Homebrew payload: %w", err)
		}
		if err := stageHomebrewFixture(home, fixture, public); err != nil {
			return "", err
		}
		return "staged " + fixture.buildID, nil
	}
}

func verifyHomebrewFixtureDescriptor(public ed25519.PublicKey, fixture homebrewBootstrapFixture) error {
	var descriptor homebrewFixtureDescriptor
	if err := json.Unmarshal(fixture.descriptorRaw, &descriptor); err != nil {
		return err
	}
	var signature homebrewFixtureSignature
	if err := json.Unmarshal(fixture.signatureRaw, &signature); err != nil {
		return err
	}
	encoded, err := base64.StdEncoding.DecodeString(signature.Signature)
	if err != nil || signature.SchemaVersion != 1 || signature.Status != "signed" || signature.Algorithm != "ed25519" || signature.KeyID != "jobctrl-release-v1" || !ed25519.Verify(public, signedMessage("jobctrl:release-descriptor:v1\x00", fixture.descriptorRaw), encoded) {
		return errors.New("Homebrew fixture descriptor is not signed by injected release trust")
	}
	archiveDigest := sha256.Sum256(fixture.archive)
	if descriptor.SchemaVersion != 1 || descriptor.Channel != "stable" || descriptor.Sequence != fixture.receipt.Sequence || descriptor.BuildID != fixture.receipt.BuildID || descriptor.AppVersion != "2.0.0" || !regexp.MustCompile(`^[a-f0-9]{40}$`).MatchString(descriptor.SourceCommit) || descriptor.Artifact.URL == "" || descriptor.Artifact.ArchiveType != "zip" || descriptor.Artifact.SizeBytes != int64(len(fixture.archive)) || descriptor.Artifact.SHA256 != hex.EncodeToString(archiveDigest[:]) || descriptor.Artifact.ManifestSHA256 != fixture.receipt.ManifestSHA256 {
		return errors.New("Homebrew fixture descriptor does not bind the stable receipt and archive")
	}
	return nil
}

func stageHomebrewFixture(home string, fixture homebrewBootstrapFixture, public ed25519.PublicKey) error {
	store, err := release.Open(home)
	if err != nil {
		return err
	}
	destination := filepath.Join(store.Home, "releases", fixture.receipt.BuildID)
	if err := os.Mkdir(destination, 0o700); err != nil {
		return fmt.Errorf("create staged release: %w", err)
	}
	if err := copyHomebrewFixtureTree(fixture.payloadRoot, filepath.Join(destination, "payload")); err != nil {
		return err
	}
	if _, err := VerifyDistributionPayload(filepath.Join(destination, "payload"), DistributionTrust{PublicKeys: map[string]ed25519.PublicKey{"jobctrl-release-v1": public}, ExpectedChannel: "stable"}); err != nil {
		return fmt.Errorf("verify staged signed Homebrew payload: %w", err)
	}
	if err := writeJSONAtomic(filepath.Join(destination, "receipt.json"), selectorReceipt{SchemaVersion: fixture.receipt.SchemaVersion, BuildID: fixture.receipt.BuildID, Channel: fixture.receipt.Channel, Sequence: int64(fixture.receipt.Sequence), ArtifactSHA256: fixture.receipt.ArtifactSHA256, ManifestSHA256: fixture.receipt.ManifestSHA256, DescriptorSHA256: fixture.receipt.DescriptorSHA256, PolicySHA256: fixture.receipt.PolicySHA256, DescriptorURL: fixture.receipt.DescriptorURL, InstalledAt: fixture.receipt.InstalledAt}); err != nil {
		return err
	}
	return writeJSONAtomic(filepath.Join(destination, "policy.json"), fixture.policy)
}

func copyHomebrewFixtureTree(source, destination string) error {
	return filepath.WalkDir(source, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		relative, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		target := destination
		if relative != "." {
			target = filepath.Join(destination, relative)
		}
		if entry.IsDir() {
			return os.MkdirAll(target, 0o700)
		}
		if entry.Type()&os.ModeSymlink != 0 {
			link, err := os.Readlink(path)
			if err != nil {
				return err
			}
			return os.Symlink(link, target)
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		input, err := os.Open(path)
		if err != nil {
			return err
		}
		output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, info.Mode().Perm())
		if err == nil {
			_, err = io.Copy(output, input)
		}
		closeOutput, closeInput := output.Close(), input.Close()
		if err != nil {
			return err
		}
		if closeOutput != nil {
			return closeOutput
		}
		return closeInput
	})
}

func preseedUnsignedHomebrewRelease(t *testing.T, home string, fixture homebrewBootstrapFixture) {
	t.Helper()
	payload, manifest := verifiedPayloadFixture(t)
	manifest.BuildID = fixture.buildID
	if err := os.WriteFile(filepath.Join(payload, "launcher", "jobctrl"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "launcher", "runtime-manifest.json"), []byte(validRuntimeManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, payload, &manifest)
	writeLocalEnvelope(t, payload, manifest)
	destination := filepath.Join(home, "releases", fixture.buildID)
	if err := os.Mkdir(destination, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := copyHomebrewFixtureTree(payload, filepath.Join(destination, "payload")); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(destination, "receipt.json"), selectorReceipt{SchemaVersion: fixture.receipt.SchemaVersion, BuildID: fixture.receipt.BuildID, Channel: fixture.receipt.Channel, Sequence: int64(fixture.receipt.Sequence), ArtifactSHA256: fixture.receipt.ArtifactSHA256, ManifestSHA256: fixture.receipt.ManifestSHA256, DescriptorSHA256: fixture.receipt.DescriptorSHA256, PolicySHA256: fixture.receipt.PolicySHA256, DescriptorURL: fixture.receipt.DescriptorURL, InstalledAt: fixture.receipt.InstalledAt}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(destination, "policy.json"), fixture.policy); err != nil {
		t.Fatal(err)
	}
}

func seedHomebrewSQLitePair(t *testing.T, python, state string) {
	t.Helper()
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		code := "import pathlib,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.execute('insert into t values (1)'); c.execute('PRAGMA user_version=8') if pathlib.Path(sys.argv[1]).name == 'jobctrl.db' else None; c.commit()"
		if output, err := exec.Command(python, "-c", code, filepath.Join(state, name)).CombinedOutput(); err != nil {
			t.Fatalf("seed %s: %v %s", name, err, output)
		}
	}
}

func assertHomebrewSelectorCalls(t *testing.T, calls []homebrewSelectorCall, home string, want int) {
	t.Helper()
	if len(calls) != want {
		t.Fatalf("selector calls = %d, want %d", len(calls), want)
	}
	call := calls[len(calls)-1]
	if call.selector != filepath.Join(home, "bin", "jobctrl") || !sameStringSet(call.args, []string{"status"}) {
		t.Fatalf("selector call = %#v", call)
	}
}

func homebrewArgument(args []string, name string) string {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == name {
			return args[index+1]
		}
	}
	return ""
}

func homebrewHasArgument(args []string, name string) bool {
	for _, argument := range args {
		if argument == name {
			return true
		}
	}
	return false
}

func sameStringSet(left, right []string) bool {
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
