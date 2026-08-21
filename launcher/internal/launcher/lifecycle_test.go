package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func lifecycleReceipt(build, source string, sequence uint64) release.Receipt {
	_ = source
	return release.Receipt{SchemaVersion: 1, BuildID: build, Channel: "local", Sequence: sequence, ArtifactSHA256: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", ManifestSHA256: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", DescriptorSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc", DescriptorURL: "local-fixture", InstalledAt: time.Now().UTC().Format(time.RFC3339Nano)}
}

func lifecyclePolicyDigest(t *testing.T, policy release.ChannelMetadata) string {
	t.Helper()
	raw, err := json.Marshal(policy)
	if err != nil {
		t.Fatal(err)
	}
	raw = append(raw, '\n')
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:])
}

func writeLifecyclePolicy(t *testing.T, path string, policy release.ChannelMetadata) string {
	t.Helper()
	digest := lifecyclePolicyDigest(t, policy)
	if err := writeJSONAtomic(path, policy); err != nil {
		t.Fatal(err)
	}
	return digest
}

func TestHomebrewExecutableIsDiscoveredAndValidatedAtRuntime(t *testing.T) {
	oldLookup := homebrewExecutableLookup
	t.Cleanup(func() { homebrewExecutableLookup = oldLookup })
	brew := filepath.Join(t.TempDir(), "brew")
	if err := os.WriteFile(brew, []byte("#!/bin/sh\nprintf discovered\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	homebrewExecutableLookup = func(name string) (string, error) {
		if name != "brew" {
			t.Fatalf("unexpected executable lookup %q", name)
		}
		return brew, nil
	}
	if output, err := homebrewCommand("--version"); err != nil || strings.TrimSpace(output) != "discovered" {
		t.Fatalf("runtime-discovered Homebrew command = %q, %v", output, err)
	}
	if err := os.Chmod(brew, 0o777); err != nil {
		t.Fatal(err)
	}
	if _, err := homebrewCommand("--version"); err == nil || !strings.Contains(err.Error(), "non-writable") {
		t.Fatalf("writable Homebrew executable was not rejected: %v", err)
	}
}

func TestNativeUpdateHomebrewUsesPrivateAcquisitionAdapter(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	runtime := t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	r := installLifecycleRelease(t, runtime, "local-build-0000001", 1, python)
	if _, err := store.WriteSelectedActive(r, 0, r.BuildID, "homebrew"); err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(runtime, "releases", r.BuildID, "payload")
	distribution, err := loadAndVerifyDistributionManifest(payload)
	if err != nil {
		t.Fatal(err)
	}
	prefix := t.TempDir()
	installerPath := filepath.Join(payload, "launcher", "jobctrl-installer")
	candidate := lifecycleReceipt("local-build-0000002", "homebrew", 2)
	candidate.DescriptorSHA256 = strings.Repeat("d", 64)
	candidateDir := filepath.Join(runtime, "releases", candidate.BuildID)
	if err := os.MkdirAll(candidateDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(candidateDir, "receipt.json"), selectorReceipt{SchemaVersion: candidate.SchemaVersion, BuildID: candidate.BuildID, Channel: candidate.Channel, Sequence: int64(candidate.Sequence), ArtifactSHA256: candidate.ArtifactSHA256, ManifestSHA256: candidate.ManifestSHA256, DescriptorSHA256: candidate.DescriptorSHA256, DescriptorURL: candidate.DescriptorURL, InstalledAt: candidate.InstalledAt}); err != nil {
		t.Fatal(err)
	}
	oldBrew, oldBootstrap, oldAssets, oldPromotion := homebrewCommand, homebrewBootstrapCommand, homebrewAssetsReader, homebrewPromotion
	t.Cleanup(func() {
		homebrewCommand, homebrewBootstrapCommand, homebrewAssetsReader, homebrewPromotion = oldBrew, oldBootstrap, oldAssets, oldPromotion
	})
	var calls []string
	homebrewCommand = func(args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		if len(args) == 2 && args[0] == "--prefix" {
			return prefix + "\n", nil
		}
		return "Already up-to-date\n", nil
	}
	homebrewBootstrapCommand = func(path string, args []string, _ []string) (string, error) {
		if path != installerPath || !strings.Contains(strings.Join(args, " "), "--stage-only") {
			t.Fatalf("unexpected bootstrap invocation: %s %v", path, args)
		}
		return "staged", nil
	}
	formulaCandidate := candidate
	homebrewAssetsReader = func(_ string) (homebrewFormulaAssets, error) {
		return homebrewFormulaAssets{BuildID: formulaCandidate.BuildID, DescriptorURL: "https://example.test/release.json", DescriptorSHA256: formulaCandidate.DescriptorSHA256, DescriptorPath: "/tmp/descriptor", SignaturePath: "/tmp/signature", ArchivePath: "/tmp/archive"}, nil
	}
	promotions := 0
	homebrewPromotion = func(_ launchContext, _ *release.Store, got release.Active, build, operation string, _ io.Writer) error {
		promotions++
		if got.Receipt != r || build != candidate.BuildID || operation != "update" {
			t.Fatalf("unexpected common promotion: %#v %s %s", got, build, operation)
		}
		return nil
	}
	ctx := launchContext{PayloadRoot: payload, Distribution: distribution, Instance: instance{RuntimeHome: runtime}, Environment: []string{"HOME=" + t.TempDir()}}
	var out bytes.Buffer
	err = update(ctx, nil, &out)
	if err != nil || promotions != 1 || strings.Join(calls, ",") != "upgrade ebarti/tap/jobctrl,--prefix ebarti/tap/jobctrl" {
		t.Fatalf("update result = %v output=%q calls=%v", err, out.String(), calls)
	}
	formulaCandidate = r
	out.Reset()
	if err := update(ctx, nil, &out); err != nil || promotions != 1 || !strings.Contains(out.String(), "already active") {
		t.Fatalf("already-current Homebrew update = %v output=%q promotions=%d", err, out.String(), promotions)
	}
}

func TestNativeUpdateHomebrewReportsAcquisitionAndBootstrapFailures(t *testing.T) {
	oldBrew, oldBootstrap, oldAssets, oldPromotion := homebrewCommand, homebrewBootstrapCommand, homebrewAssetsReader, homebrewPromotion
	t.Cleanup(func() {
		homebrewCommand, homebrewBootstrapCommand, homebrewAssetsReader, homebrewPromotion = oldBrew, oldBootstrap, oldAssets, oldPromotion
	})
	ctx := launchContext{Environment: []string{"HOME=" + t.TempDir()}}
	homebrewCommand = func(_ ...string) (string, error) { return "brew failed", errors.New("exit 1") }
	if err := updateHomebrew(ctx, nil, release.Active{}, io.Discard); err == nil || !strings.Contains(err.Error(), "acquisition update failed") {
		t.Fatalf("brew failure = %v", err)
	}
	prefix := t.TempDir()
	homebrewCommand = func(args ...string) (string, error) {
		if args[0] == "--prefix" {
			return prefix, nil
		}
		return "", nil
	}
	homebrewAssetsReader = func(_ string) (homebrewFormulaAssets, error) {
		return homebrewFormulaAssets{}, errors.New("assets failed")
	}
	if err := updateHomebrew(ctx, nil, release.Active{}, io.Discard); err == nil || !strings.Contains(err.Error(), "assets failed") {
		t.Fatalf("asset failure = %v", err)
	}
}

func TestNativeUpdateCurlStagesExactReceiptPromotesAndNoops(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	runtime := t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	active := installLifecycleRelease(t, runtime, "local-curl-active-0101", 1, python)
	candidate := installLifecycleRelease(t, runtime, "local-curl-candidate-0102", 2, python)
	if _, err := store.WriteSelectedActive(active, 0, active.BuildID, "curl"); err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(runtime, "releases", active.BuildID, "payload")
	distribution, err := loadAndVerifyDistributionManifest(payload)
	if err != nil {
		t.Fatal(err)
	}
	oldCommand, oldPromotion := curlInstallerCommand, curlPromotion
	t.Cleanup(func() { curlInstallerCommand, curlPromotion = oldCommand, oldPromotion })
	var commandCalls int
	curlInstallerCommand = func(path string, args []string, env []string) (string, error) {
		commandCalls++
		if path != filepath.Join(payload, "launcher", "jobctrl-installer") || !curlHasArgument(args, "--source", "curl") || !curlHasArgument(args, "--stage-only", "") || !curlHasArgument(args, "--json", "") || curlArgument(args, "--home") != runtime {
			t.Fatalf("unexpected curl installer invocation: %s %v", path, args)
		}
		if environmentMap(env)["JOBCTRL_RUNTIME_HOME"] != runtime {
			t.Fatalf("curl installer lost runtime home: %v", env)
		}
		raw, marshalErr := json.Marshal(candidate)
		return string(raw), marshalErr
	}
	var promoted bool
	curlPromotion = func(got launchContext, _ *release.Store, gotActive release.Active, build, operation string, _ io.Writer) error {
		promoted = true
		if gotActive.Receipt != active || build != candidate.BuildID || operation != "update" || environmentMap(got.Environment)["JOBCTRL_ACQUISITION_SOURCE"] != "curl" {
			t.Fatalf("unexpected curl promotion: active=%#v build=%s operation=%s env=%v", gotActive, build, operation, got.Environment)
		}
		return nil
	}
	ctx := launchContext{PayloadRoot: payload, Distribution: distribution, Instance: instance{RuntimeHome: runtime}, Environment: []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime}}
	if err := updateCurl(ctx, store, release.Active{SchemaVersion: 1, Generation: 1, Receipt: active, SelectorBuildID: active.BuildID, Acquisition: "curl"}, io.Discard); err != nil {
		t.Fatalf("curl stage and promotion: %v", err)
	}
	if commandCalls != 1 || !promoted {
		t.Fatalf("curl stage/promote calls=%d promoted=%v", commandCalls, promoted)
	}

	// A same-build receipt is a successful idempotent acquisition. It must not
	// enter the health-gated promotion path or advance active selection.
	curlInstallerCommand = func(_ string, _ []string, _ []string) (string, error) {
		raw, marshalErr := json.Marshal(active)
		return string(raw), marshalErr
	}
	curlPromotion = func(_ launchContext, _ *release.Store, _ release.Active, _ string, _ string, _ io.Writer) error {
		t.Fatal("same-build curl receipt attempted promotion")
		return nil
	}
	var output bytes.Buffer
	if err := updateCurl(ctx, store, release.Active{SchemaVersion: 1, Generation: 1, Receipt: active, SelectorBuildID: active.BuildID, Acquisition: "curl"}, &output); err != nil {
		t.Fatalf("same-build curl no-op: %v", err)
	}
	if !strings.Contains(output.String(), "already active") {
		t.Fatalf("same-build curl output = %q", output.String())
	}
}

func TestNativeUpdateCurlRejectsNonExactReceiptAndKeepsP6Gate(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	runtime := t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	active := installLifecycleRelease(t, runtime, "local-curl-gate-0101", 1, python)
	if _, err := store.WriteSelectedActive(active, 0, active.BuildID, "curl"); err != nil {
		t.Fatal(err)
	}
	payload := filepath.Join(runtime, "releases", active.BuildID, "payload")
	distribution, err := loadAndVerifyDistributionManifest(payload)
	if err != nil {
		t.Fatal(err)
	}
	oldCommand, oldPromotion := curlInstallerCommand, curlPromotion
	t.Cleanup(func() { curlInstallerCommand, curlPromotion = oldCommand, oldPromotion })
	called := false
	curlInstallerCommand = func(_ string, _ []string, _ []string) (string, error) {
		called = true
		return `{"schemaVersion":1}`, nil
	}
	ctx := launchContext{PayloadRoot: payload, Distribution: distribution, Instance: instance{RuntimeHome: runtime}, Environment: []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime}}
	if err := update(ctx, nil, io.Discard); err == nil || !strings.Contains(err.Error(), "not available until P6") {
		t.Fatalf("unsigned P5 curl update bypassed network policy gate: %v", err)
	}
	if called {
		t.Fatal("P6 policy gate executed curl installer")
	}
	if err := updateCurl(ctx, store, release.Active{SchemaVersion: 1, Generation: 1, Receipt: active, SelectorBuildID: active.BuildID, Acquisition: "curl"}, io.Discard); err == nil || !strings.Contains(err.Error(), "invalid staged receipt") {
		t.Fatalf("non-exact curl receipt accepted: %v", err)
	}
}

func curlArgument(args []string, name string) string {
	for index := 0; index+1 < len(args); index++ {
		if args[index] == name {
			return args[index+1]
		}
	}
	return ""
}

func curlHasArgument(args []string, name, value string) bool {
	for index, argument := range args {
		if argument != name {
			continue
		}
		return value == "" || (index+1 < len(args) && args[index+1] == value)
	}
	return false
}

func TestUninstallRequiresRemoveDataFlagAndExactTypedPhrase(t *testing.T) {
	runtime, state := t.TempDir(), t.TempDir()
	ctx := launchContext{Instance: instance{RuntimeHome: runtime, StateDir: state, StatePath: filepath.Join(runtime, "missing-state.json"), ControlPath: filepath.Join(runtime, "control.lock")}}
	old := uninstallInput
	t.Cleanup(func() { uninstallInput = old })
	var out bytes.Buffer
	if err := uninstall(ctx, []string{"--yes"}, &out); err == nil {
		t.Fatal("--yes bypass accepted")
	}
	uninstallInput = strings.NewReader("REMOVE JOBCTRL DATA\n")
	if err := uninstall(ctx, []string{"--confirm", "REMOVE JOBCTRL DATA"}, &out); err == nil {
		t.Fatal("--confirm bypass accepted")
	}
	uninstallInput = strings.NewReader("no\n")
	if err := uninstall(ctx, []string{"--remove-data"}, &out); err == nil {
		t.Fatal("wrong typed phrase accepted")
	}
	uninstallInput = strings.NewReader("REMOVE JOBCTRL DATA\n")
	if err := uninstall(ctx, []string{"--remove-data"}, &out); err != nil {
		t.Fatalf("typed removal: %v", err)
	}
	if _, err := os.Lstat(state); !os.IsNotExist(err) {
		t.Fatalf("state still exists: %v", err)
	}
}

func TestDefaultUninstallPreservesUserDataAndRejectsForeignLinks(t *testing.T) {
	runtime, state := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(state, "profile.json"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: instance{RuntimeHome: runtime, StateDir: state, StatePath: filepath.Join(runtime, "missing-state.json"), ControlPath: filepath.Join(runtime, "control.lock")}}
	var out bytes.Buffer
	if err := uninstall(ctx, nil, &out); err != nil {
		t.Fatal(err)
	}
	if raw, err := os.ReadFile(filepath.Join(state, "profile.json")); err != nil || string(raw) != "private" {
		t.Fatalf("default uninstall changed user data: %q, %v", raw, err)
	}
	unsafeRuntime := t.TempDir()
	if err := os.Symlink(state, filepath.Join(unsafeRuntime, "bin")); err != nil {
		t.Fatal(err)
	}
	unsafe := ctx
	unsafe.Instance.RuntimeHome = unsafeRuntime
	if err := uninstall(unsafe, nil, &out); err == nil {
		t.Fatal("uninstall accepted a symlinked managed path")
	}
}

func TestCurlUninstallRemovesOnlyRecordedLinkAndPathLine(t *testing.T) {
	runtime := t.TempDir()
	bin := filepath.Join(runtime, "bin")
	if err := os.MkdirAll(bin, 0o700); err != nil {
		t.Fatal(err)
	}
	selector := filepath.Join(bin, "jobctrl")
	if err := os.WriteFile(selector, []byte("selector"), 0o700); err != nil {
		t.Fatal(err)
	}
	publicBin := filepath.Join(t.TempDir(), "custom-bin")
	if err := os.MkdirAll(publicBin, 0o700); err != nil {
		t.Fatal(err)
	}
	publicLink := filepath.Join(publicBin, "jobctrl")
	if err := os.Symlink(selector, publicLink); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(publicBin, "foreign")
	if err := os.Symlink("/bin/echo", foreign); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(t.TempDir(), ".zprofile")
	line := `export PATH="` + publicBin + `:$PATH" # JobCtrl managed path`
	contents := "export KEEP=1\n" + line + "\nexport OTHER=2\n"
	if err := os.WriteFile(profile, []byte(contents), 0o600); err != nil {
		t.Fatal(err)
	}
	record := curlAcquisitionRecord{SchemaVersion: 1, Source: "curl", PublicLink: publicLink, Selector: selector, Profile: profile, PathLine: line}
	if err := writeJSONAtomic(filepath.Join(runtime, "acquisition.json"), record); err != nil {
		t.Fatal(err)
	}
	if err := removeExactCurlExposure(runtime); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(publicLink); !os.IsNotExist(err) {
		t.Fatalf("recorded public link remains: %v", err)
	}
	if _, err := os.Lstat(foreign); err != nil {
		t.Fatalf("foreign link changed: %v", err)
	}
	if raw, err := os.ReadFile(profile); err != nil || string(raw) != "export KEEP=1\nexport OTHER=2\n" {
		t.Fatalf("profile cleanup changed foreign content: %q, %v", raw, err)
	}
}

func TestUninstallRejectsOverlappingStateBeforeMutatingRuntime(t *testing.T) {
	runtime := t.TempDir()
	state := filepath.Join(runtime, "nested-state")
	if err := os.MkdirAll(state, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(runtime, "releases", "keep")
	if err := os.MkdirAll(filepath.Dir(marker), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: instance{RuntimeHome: runtime, StateDir: state, StatePath: filepath.Join(runtime, "missing-state.json"), ControlPath: filepath.Join(runtime, "control.lock")}}
	if err := uninstall(ctx, nil, io.Discard); err == nil || !strings.Contains(err.Error(), "overlaps") {
		t.Fatalf("overlapping uninstall = %v", err)
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "keep" {
		t.Fatalf("overlap preflight mutated runtime: %q, %v", raw, err)
	}
}

func TestUninstallPreflightResolvesParentSymlinkAliasesAndManagedTypes(t *testing.T) {
	root := t.TempDir()
	runtime := filepath.Join(root, "runtime")
	if _, err := release.Open(runtime); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "runtime-alias")
	if err := os.Symlink(runtime, alias); err != nil {
		t.Fatal(err)
	}
	if !pathsOverlap(filepath.Join(alias, "future-state"), runtime) {
		t.Fatal("parent-symlink alias bypassed runtime/data overlap detection")
	}
	staging := filepath.Join(runtime, "staging")
	if err := os.Remove(staging); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(staging, []byte("not a managed directory"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := validateManagedUninstallPaths(runtime); err == nil || !strings.Contains(err.Error(), "regular directory") {
		t.Fatalf("wrong managed path type passed uninstall preflight: %v", err)
	}
}

func TestPairedSQLiteBackupUsesOnlineBackupAndHashesBothFiles(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	state := t.TempDir()
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		code := "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.execute('insert into t values (1)'); c.commit(); c.execute('insert into t values (2)'); c.commit()"
		if output, err := exec.Command(python, "-c", code, filepath.Join(state, name)).CombinedOutput(); err != nil {
			t.Fatalf("seed %s: %v %s", name, err, output)
		}
	}
	ctx := launchContext{PayloadRoot: filepath.Dir(filepath.Dir(filepath.Dir(python))), Instance: instance{StateDir: state}}
	// snapshotPairTo calls the payload Python path. Use a tiny regular mirror
	// directory so the test exercises the launcher boundary rather than copying
	// live SQLite bytes directly.
	payload := t.TempDir()
	if err := os.MkdirAll(filepath.Join(payload, "python", "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(python, filepath.Join(payload, "python", "bin", "python3")); err != nil {
		t.Fatal(err)
	}
	ctx.PayloadRoot = payload
	pair, err := snapshotPairTo(ctx, lifecycleReceipt("local-build-0000001", "curl", 1), filepath.Join(state, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	if len(pair.Files) != 2 || pair.Files[0].SHA256 == "" || pair.Files[1].SHA256 == "" || !pair.ReleaseReceipt.Valid() {
		t.Fatalf("pair = %#v", pair)
	}
	if err := restorePair(ctx, pair); err != nil {
		t.Fatal(err)
	}
}

func TestRestorePairDoesNotFollowPrepositionedLegacyRestoreSymlink(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	state := t.TempDir()
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		code := "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.execute('insert into t values (1)'); c.commit()"
		if output, err := exec.Command(python, "-c", code, filepath.Join(state, name)).CombinedOutput(); err != nil {
			t.Fatalf("seed %s: %v %s", name, err, output)
		}
	}
	payload := t.TempDir()
	if err := os.MkdirAll(filepath.Join(payload, "python", "bin"), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(python, filepath.Join(payload, "python", "bin", "python3")); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{PayloadRoot: payload, Instance: instance{StateDir: state}}
	pair, err := snapshotPairTo(ctx, lifecycleReceipt("local-build-0000001", "curl", 1), filepath.Join(state, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "external-target")
	if err := os.WriteFile(outside, []byte("must-not-change"), 0o600); err != nil {
		t.Fatal(err)
	}
	legacyStage := filepath.Join(state, ".jobctrl.db.restore")
	if err := os.Symlink(outside, legacyStage); err != nil {
		t.Fatal(err)
	}
	if err := restorePair(ctx, pair); err != nil {
		t.Fatalf("restore rejected safe random staging because of legacy symlink: %v", err)
	}
	if raw, err := os.ReadFile(outside); err != nil || string(raw) != "must-not-change" {
		t.Fatalf("restore followed prepositioned symlink: %q, %v", raw, err)
	}
	info, err := os.Lstat(filepath.Join(state, "jobctrl.db"))
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		t.Fatalf("restored database is not a regular file: %v, %v", info, err)
	}
}

func TestRollbackPairRequiresExactImmutableReceiptNotJustBuild(t *testing.T) {
	state := t.TempDir()
	target := lifecycleReceipt("local-build-0000001", "curl", 1)
	pair := databasePair{SchemaVersion: 1, ID: "pair-fixture", ReleaseReceipt: target, CreatedAt: time.Now(), Files: []databaseFile{{Name: "jobctrl.db"}, {Name: "temporal.db"}}}
	dir := filepath.Join(state, "backups", pair.ID)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(dir, "pair.json"), pair); err != nil {
		t.Fatal(err)
	}
	if _, err := retainedPairForReceipt(state, target); err != nil {
		t.Fatal(err)
	}
	other := target
	other.DescriptorSHA256 = strings.Repeat("d", 64)
	if _, err := retainedPairForReceipt(state, other); err == nil {
		t.Fatal("same build with different descriptor accepted a rollback pair")
	}
}

func TestTransitionFailureIsJournaledAtEveryBoundary(t *testing.T) {
	store, err := release.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	j, err := store.Begin("update", nil, nil, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	old := transitionFailure
	t.Cleanup(func() { transitionFailure = old })
	for _, state := range []release.State{release.MetadataVerified, release.Staging, release.PayloadVerified, release.ReleaseCommitted, release.SelectorHandoffPending, release.SelectorReplaced, release.Quiescing, release.PairBackedUp, release.MigrationCandidateReady, release.MigrationActivated, release.PolicyPending, release.PolicyFinalized, release.CandidateStarting, release.CandidateHealthy, release.Promoted, release.RollbackRestoring, release.RolledBack} {
		transitionFailure = func(got release.State) error {
			if got == state {
				return errTransitionInterrupted
			}
			return nil
		}
		if err := advance(store, &j, state); err == nil {
			t.Fatalf("boundary %s did not inject failure", state)
		}
		loaded, err := store.ReadJournal()
		if err != nil || loaded.State != state || (state != release.Promoted && state != release.RolledBack && !loaded.Resumable()) {
			t.Fatalf("boundary %s journal = %#v, %v", state, loaded, err)
		}
	}
}

func TestNewPromotionCannotOverwriteAnUnfinishedTransitionJournal(t *testing.T) {
	store, err := release.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := lifecycleReceipt("local-old-build-0001", "local-fixture", 1)
	candidate := lifecycleReceipt("local-new-build-0002", "local-fixture", 2)
	journal, err := store.Begin("update", &old, &candidate, candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Advance(&journal, release.PairBackedUp, nil); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: instance{RuntimeHome: store.Home}}
	if err := promoteExisting(ctx, store, release.Active{}, candidate.BuildID, "update", io.Discard); err == nil || !strings.Contains(err.Error(), "must be recovered") {
		t.Fatalf("new promotion overwrote or ignored unfinished journal: %v", err)
	}
	loaded, err := store.ReadJournal()
	if err != nil || loaded.ID != journal.ID || loaded.State != release.PairBackedUp {
		t.Fatalf("unfinished journal identity changed: %#v, %v", loaded, err)
	}
}

func TestCandidateExecutionRevalidatesTamperedImmutableLauncher(t *testing.T) {
	home := t.TempDir()
	store, err := release.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	payload, manifest := verifiedPayloadFixture(t)
	if err := os.WriteFile(filepath.Join(payload, "launcher", "jobctrl"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "launcher", "runtime-manifest.json"), []byte(validRuntimeManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, payload, &manifest)
	writeLocalEnvelope(t, payload, manifest)
	releaseDir := filepath.Join(home, "releases", manifest.BuildID)
	if err := os.MkdirAll(releaseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(payload, filepath.Join(releaseDir, "payload")); err != nil {
		t.Fatal(err)
	}
	digest, err := sha256Path(filepath.Join(releaseDir, "payload", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	receipt := release.Receipt{SchemaVersion: 1, BuildID: manifest.BuildID, Channel: "local", Sequence: 1, ArtifactSHA256: strings.Repeat("a", 64), ManifestSHA256: digest, DescriptorSHA256: strings.Repeat("b", 64), DescriptorURL: "local-fixture", InstalledAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := writeJSONAtomic(filepath.Join(releaseDir, "receipt.json"), selectorReceipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: int64(receipt.Sequence), ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(releaseDir, "policy.json"), release.ChannelMetadata{Channel: receipt.Channel, Sequence: receipt.Sequence, Minimum: 0, BuildID: receipt.BuildID, DescriptorDigest: receipt.DescriptorSHA256, Revoked: []string{}}); err != nil {
		t.Fatal(err)
	}
	verified, err := verifyInstalledReleaseForExecution(store, receipt)
	if err != nil {
		t.Fatalf("untampered candidate rejected: %v", err)
	}
	if err := handoffPublicSelector(store.Home, verified); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteSelectedActive(receipt, 0, receipt.BuildID, "curl"); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPublicSelectorForExecution(store.Home); err != nil {
		t.Fatalf("authenticated selector rejected: %v", err)
	}
	if err := os.WriteFile(filepath.Join(store.Home, "bin", "jobctrl"), []byte("tampered selector"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := VerifyPublicSelectorForExecution(store.Home); err == nil {
		t.Fatal("tampered public selector passed immediate execution verification")
	}
	if err := os.WriteFile(filepath.Join(releaseDir, "payload", "launcher", "jobctrl"), []byte("tampered"), 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyInstalledReleaseForExecution(store, receipt); err == nil {
		t.Fatal("tampered candidate launcher passed immediate execution verification")
	}
}

func TestInterruptedTransitionWithRevokedPredecessorFailsClosed(t *testing.T) {
	store, err := release.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := lifecycleReceipt("local-build-0000001", "curl", 1)
	candidate := lifecycleReceipt("local-build-0000002", "curl", 2)
	if _, err := store.RecordMetadata("local", old.Sequence, 0, old.BuildID, old.DescriptorSHA256, nil); err != nil {
		t.Fatal(err)
	}
	journal, err := store.Begin("update", &old, &candidate, candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	journal.BackupID = "pair-before-revocation"
	if err := store.Advance(&journal, release.PolicyPending, nil); err != nil {
		t.Fatal(err)
	}
	state, err := store.ValidateMetadata(release.ChannelMetadata{Channel: "local", Sequence: candidate.Sequence, Minimum: 2, BuildID: candidate.BuildID, DescriptorDigest: candidate.DescriptorSHA256, Revoked: []string{old.BuildID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.CommitMetadata(state); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: instance{RuntimeHome: store.Home, StateDir: t.TempDir(), StatePath: filepath.Join(t.TempDir(), "state.json")}}
	if recovered, err := recoverInterruptedTransition(ctx, store); recovered || err == nil || !strings.Contains(err.Error(), "revoked") {
		t.Fatalf("revoked predecessor recovery = recovered:%v err:%v", recovered, err)
	}
	loaded, err := store.ReadJournal()
	if err != nil || loaded.State != release.Failed {
		t.Fatalf("revoked recovery did not preserve fail-closed audit state: %#v, %v", loaded, err)
	}
}

func TestRetentionPreservesReferencedAndNonStableEvidence(t *testing.T) {
	runtime := t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	makeReceipt := func(build, channel string, sequence uint64) release.Receipt {
		r := lifecycleReceipt(build, "curl", sequence)
		r.Channel = channel
		return r
	}
	active := makeReceipt("stable-build-0000003", "stable", 3)
	prior := makeReceipt("stable-build-0000002", "stable", 2)
	referenced := makeReceipt("stable-build-0000001", "stable", 1)
	prunable := makeReceipt("stable-build-0000000", "stable", 0)
	prunable.Sequence = 1
	prunable.BuildID = "stable-build-0000000"
	local := makeReceipt("local-build-0000001", "local", 1)
	pre := makeReceipt("pre-build-00000001", "prerelease", 1)
	for _, receipt := range []release.Receipt{active, prior, referenced, prunable, local, pre} {
		directory := filepath.Join(runtime, "releases", receipt.BuildID)
		if err := os.MkdirAll(directory, 0o700); err != nil {
			t.Fatal(err)
		}
		if err := writeJSONAtomic(filepath.Join(directory, "receipt.json"), selectorReceipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: int64(receipt.Sequence), ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.WriteSelectedActive(active, 0, active.BuildID, "curl"); err != nil {
		t.Fatal(err)
	}
	backupDirectory := filepath.Join(runtime, "instances", "fixture", "backups", "pair-reference")
	if err := os.MkdirAll(backupDirectory, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(backupDirectory, "pair.json"), databasePair{SchemaVersion: 1, ID: "pair-reference", ReleaseReceipt: referenced, CreatedAt: time.Now(), Files: []databaseFile{{Name: "jobctrl.db"}, {Name: "temporal.db"}}}); err != nil {
		t.Fatal(err)
	}
	if err := retainReleases(store, runtime); err != nil {
		t.Fatal(err)
	}
	for _, build := range []string{active.BuildID, prior.BuildID, referenced.BuildID, local.BuildID, pre.BuildID} {
		if _, err := os.Lstat(filepath.Join(runtime, "releases", build)); err != nil {
			t.Fatalf("retention removed protected %s: %v", build, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(runtime, "releases", prunable.BuildID)); !os.IsNotExist(err) {
		t.Fatalf("retention kept unreferenced stable release: %v", err)
	}
}

// TestRealTwoReleasePromotionRollbackRestoresPairedSQLiteState runs the real
// lifecycle transaction, receipt/payload verification, selector handoff,
// SQLite online backup, restoration, and active-pointer writes. Only launcher
// process execution is injected: component supervision itself is covered by
// the hermetic launcher lifecycle test, while this test deliberately forces
// candidate health failure at the exact promotion boundary.
func TestRealTwoReleasePromotionRollbackRestoresPairedSQLiteState(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	runtime, state := t.TempDir(), t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	old := installLifecycleRelease(t, runtime, "local-old-build-0001", 1, python)
	candidate := installLifecycleRelease(t, runtime, "local-new-build-0002", 2, python)
	if _, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture"); err != nil {
		t.Fatal(err)
	}
	oldVerified, err := verifyInstalledReleaseForExecution(store, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(runtime, oldVerified); err != nil {
		t.Fatal(err)
	}
	seedLifecycleSQLitePair(t, python, state, "old")
	before := lifecycleDatabaseValues(t, python, state)
	ctx := launchContext{Instance: instance{RuntimeHome: runtime, StateDir: state, StatePath: filepath.Join(state, "missing-state.json"), ControlPath: filepath.Join(state, "control.lock")}, Environment: []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime, "JOBCTRL_DIR=" + state}}
	oldStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = oldStart })
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt.BuildID == candidate.BuildID {
			setLifecycleSQLitePair(t, python, state, "candidate")
			return errors.New("forced candidate health failure")
		}
		return nil
	}
	var output bytes.Buffer
	if err := promoteExisting(ctx, store, release.Active{SchemaVersion: 1, Generation: 1, Receipt: old, SelectorBuildID: old.BuildID, Acquisition: "local-fixture"}, candidate.BuildID, "update", &output); err == nil || !strings.Contains(err.Error(), "forced candidate health failure") {
		t.Fatalf("forced promotion failure = %v", err)
	}
	active, err := store.ReadActive()
	if err != nil || active.Receipt != old {
		t.Fatalf("failed promotion did not restore old active receipt: %#v, %v", active, err)
	}
	if after := lifecycleDatabaseValues(t, python, state); !sameDatabaseDigests(after, before) {
		t.Fatalf("failed promotion did not restore exact SQLite pair: before=%v after=%v", before, after)
	}
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt.BuildID == candidate.BuildID {
			setLifecycleSQLitePair(t, python, state, "candidate")
		}
		return nil
	}
	if err := promoteExisting(ctx, store, active, candidate.BuildID, "update", &output); err != nil {
		t.Fatalf("successful promotion: %v", err)
	}
	active, err = store.ReadActive()
	if err != nil || active.Receipt != candidate {
		t.Fatalf("promotion did not select candidate: %#v, %v", active, err)
	}
	if values := lifecycleDatabaseValues(t, python, state); values["jobctrl.db"] != "candidatejobctrl.db" || values["temporal.db"] != "candidatetemporal.db" {
		t.Fatalf("successful promotion did not run candidate against both databases: %v", values)
	}
	if err := rollbackExisting(ctx, store, active, old.BuildID, &output); err != nil {
		t.Fatalf("explicit rollback: %v", err)
	}
	active, err = store.ReadActive()
	if err != nil || active.Receipt != old {
		t.Fatalf("rollback did not restore old pointer: %#v, %v", active, err)
	}
	if after := lifecycleDatabaseValues(t, python, state); !sameDatabaseDigests(after, before) {
		t.Fatalf("rollback did not restore exact target SQLite pair: before=%v after=%v", before, after)
	}
}

func TestRealInterruptedPreBackupAndSelectorHandoffRecovery(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	runtime, state := t.TempDir(), t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	old := installLifecycleRelease(t, runtime, "local-old-build-0001", 1, python)
	candidate := installLifecycleRelease(t, runtime, "local-new-build-0002", 2, python)
	if _, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture"); err != nil {
		t.Fatal(err)
	}
	oldVerified, err := verifyInstalledReleaseForExecution(store, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(runtime, oldVerified); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: instance{RuntimeHome: runtime, StateDir: state, StatePath: filepath.Join(state, "missing-state.json"), ControlPath: filepath.Join(state, "control.lock")}, Environment: []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime, "JOBCTRL_DIR=" + state}}
	oldStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = oldStart })
	startReleaseCommand = func(_ launchContext, got release.Receipt, journalID string) error {
		if got != old || journalID == "" {
			t.Fatalf("recovery executed an unexpected release: %#v journal=%q", got, journalID)
		}
		return nil
	}
	journal, err := store.Begin("update", &old, &candidate, candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Advance(&journal, release.ReleaseCommitted, nil); err != nil {
		t.Fatal(err)
	}
	if recovered, err := recoverInterruptedTransition(ctx, store); !recovered || err != nil {
		t.Fatalf("pre-backup recovery = %v, %v", recovered, err)
	}
	journal, err = store.Begin("update", &old, &candidate, candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Advance(&journal, release.SelectorHandoffPending, nil); err != nil {
		t.Fatal(err)
	}
	candidateVerified, err := verifyInstalledReleaseForExecution(store, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(runtime, candidateVerified); err != nil {
		t.Fatal(err)
	}
	if recovered, err := recoverInterruptedTransition(ctx, store); !recovered || err != nil {
		t.Fatalf("selector-handoff recovery = %v, %v", recovered, err)
	}
	active, err := store.ReadActive()
	if err != nil || active.Receipt != old || active.SelectorBuildID != candidate.BuildID {
		t.Fatalf("handoff recovery lost actual selector identity: %#v, %v", active, err)
	}
	if journal, err := store.ReadJournal(); err != nil || journal.State != release.RolledBack || journal.Resumable() {
		t.Fatalf("handoff recovery did not close its transition journal: %#v, %v", journal, err)
	}
	if err := VerifyPublicSelectorForExecution(runtime); err != nil {
		t.Fatalf("terminal handoff recovery left an unusable selector: %v", err)
	}
}

func installLifecycleRelease(t *testing.T, runtime, build string, sequence uint64, python string) release.Receipt {
	t.Helper()
	payload, manifest := verifiedPayloadFixture(t)
	manifest.BuildID = build
	launcherPath := filepath.Join(payload, "launcher", "jobctrl")
	if err := os.WriteFile(launcherPath, []byte("#!/bin/sh\n# "+build+"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "launcher", "jobctrl-installer"), []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "launcher", "runtime-manifest.json"), []byte(validRuntimeManifest), 0o644); err != nil {
		t.Fatal(err)
	}
	pythonPath := filepath.Join(payload, "python", "bin", "python3")
	if err := os.MkdirAll(filepath.Dir(pythonPath), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(pythonPath, []byte("#!/bin/sh\nexec \""+python+"\" \"$@\"\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, payload, &manifest)
	writeLocalEnvelope(t, payload, manifest)
	releaseDir := filepath.Join(runtime, "releases", build)
	if err := os.MkdirAll(releaseDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(payload, filepath.Join(releaseDir, "payload")); err != nil {
		t.Fatal(err)
	}
	digest, err := sha256Path(filepath.Join(releaseDir, "payload", "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	policy := release.ChannelMetadata{Channel: "local", Sequence: sequence, Minimum: 0, BuildID: build, DescriptorDigest: strings.Repeat("d", 64), Revoked: []string{}}
	policyDigest := writeLifecyclePolicy(t, filepath.Join(releaseDir, "policy.json"), policy)
	receipt := release.Receipt{SchemaVersion: 2, BuildID: build, Channel: "local", Sequence: sequence, ArtifactSHA256: strings.Repeat("a", 64), ManifestSHA256: digest, DescriptorSHA256: strings.Repeat("d", 64), PolicySHA256: policyDigest, DescriptorURL: "local-fixture", InstalledAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if err := writeJSONAtomic(filepath.Join(releaseDir, "receipt.json"), selectorReceipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: int64(receipt.Sequence), ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}); err != nil {
		t.Fatal(err)
	}
	return receipt
}

func seedLifecycleSQLitePair(t *testing.T, python, state, marker string) {
	t.Helper()
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		code := "import pathlib,sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.execute('insert into t values (?)',(sys.argv[2],)); c.execute('PRAGMA user_version=9') if pathlib.Path(sys.argv[1]).name == 'jobctrl.db' else None; c.commit()"
		if output, err := exec.Command(python, "-c", code, filepath.Join(state, name), marker+name).CombinedOutput(); err != nil {
			t.Fatalf("seed %s: %v %s", name, err, output)
		}
	}
}

func setLifecycleSQLitePair(t *testing.T, python, state, marker string) {
	t.Helper()
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		code := "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('update t set v=?',(sys.argv[2],)); c.commit()"
		if output, err := exec.Command(python, "-c", code, filepath.Join(state, name), marker+name).CombinedOutput(); err != nil {
			t.Fatalf("update %s: %v %s", name, err, output)
		}
	}
}

func lifecycleDatabaseDigests(t *testing.T, state string) map[string]string {
	t.Helper()
	result := map[string]string{}
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		digest, err := sha256Path(filepath.Join(state, name))
		if err != nil {
			t.Fatal(err)
		}
		result[name] = digest
	}
	return result
}

func lifecycleDatabaseValues(t *testing.T, python, state string) map[string]string {
	t.Helper()
	result := map[string]string{}
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		code := "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); print(c.execute('select v from t').fetchone()[0])"
		output, err := exec.Command(python, "-c", code, filepath.Join(state, name)).CombinedOutput()
		if err != nil {
			t.Fatalf("read %s content: %v %s", name, err, output)
		}
		result[name] = strings.TrimSpace(string(output))
	}
	return result
}

func sameDatabaseDigests(left, right map[string]string) bool {
	if len(left) != len(right) {
		return false
	}
	for name, digest := range left {
		if right[name] != digest {
			return false
		}
	}
	return true
}
