package launcher

// This file contains the native distribution lifecycle commands. They are
// intentionally not Python fallbacks: the Python payload is application code,
// while promotion, rollback, database-pair recovery, and uninstall own the
// trusted launcher boundary.

import (
	"bufio"
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

const removeDataPhrase = "REMOVE JOBCTRL DATA"

// transitionFailure is an intentionally narrow test seam. Production leaves
// it nil; tests inject each durable boundary and prove journal recovery rather
// than trying to simulate a process crash between arbitrary instructions.
var transitionFailure func(release.State) error
var uninstallInput io.Reader = os.Stdin
var errTransitionInterrupted = errors.New("injected abrupt transition interruption")
var homebrewExecutableLookup = exec.LookPath
var homebrewCommand = func(args ...string) (string, error) {
	path, err := homebrewExecutableLookup("brew")
	if err != nil {
		return "", fmt.Errorf("locate Homebrew executable: %w", err)
	}
	if !filepath.IsAbs(path) {
		return "", errors.New("Homebrew executable resolved to a relative path")
	}
	path, err = filepath.EvalSymlinks(path)
	if err != nil {
		return "", fmt.Errorf("resolve Homebrew executable: %w", err)
	}
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 || info.Mode().Perm()&0o022 != 0 {
		return "", errors.New("Homebrew executable is not a non-writable regular executable")
	}
	output, err := exec.Command(path, args...).CombinedOutput()
	return string(output), err
}
var homebrewBootstrapCommand = func(path string, args []string, env []string) (string, error) {
	command := exec.Command(path, args...)
	command.Env = env
	output, err := command.CombinedOutput()
	return string(output), err
}
var curlInstallerCommand = func(path string, args []string, env []string) (string, error) {
	command := exec.Command(path, args...)
	command.Env = env
	output, err := command.CombinedOutput()
	return string(output), err
}
var homebrewAssetsReader = readHomebrewFormulaAssets
var homebrewPromotion = promoteExisting
var curlPromotion = promoteExisting
var startReleaseCommand = startRelease
var removeSQLiteSidecar = os.Remove

type databaseFile struct {
	Name          string `json:"name"`
	SHA256        string `json:"sha256"`
	SizeBytes     int64  `json:"sizeBytes"`
	SQLiteUserVer int64  `json:"sqliteUserVersion"`
}
type databasePair struct {
	SchemaVersion  int             `json:"schemaVersion"`
	ID             string          `json:"id"`
	ReleaseReceipt release.Receipt `json:"releaseReceipt"`
	CreatedAt      time.Time       `json:"createdAt"`
	Files          []databaseFile  `json:"files"`
}

type curlAcquisitionRecord struct {
	SchemaVersion int    `json:"schemaVersion"`
	Source        string `json:"source"`
	PublicLink    string `json:"publicLink"`
	Selector      string `json:"selector"`
	Profile       string `json:"profile"`
	PathLine      string `json:"pathLine"`
}

func releaseSelection(ctx *launchContext) {
	if ctx.selection != nil {
		_ = ctx.selection.Close()
		ctx.selection = nil
	}
}

func releaseStore(ctx launchContext) (*release.Store, error) {
	return release.Open(ctx.Instance.RuntimeHome)
}

// recoverRevokedTransitionBeforePrepare is the one path deliberately placed
// before normal selector preparation. After policy finalization a revoked old
// active release correctly fails Permit(), which otherwise prevents even the
// `rollback` command from reaching recovery. This path never starts old code:
// it restores the durable pre-candidate pair and resumes only the authenticated
// candidate recorded in the journal.
func recoverRevokedTransitionBeforePrepare(env []string, output io.Writer) (bool, error) {
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return false, nil
	}
	store, err := release.Open(home)
	if err != nil {
		return false, nil
	}
	journal, err := store.ReadJournal()
	if errors.Is(err, os.ErrNotExist) || err != nil || !journal.Resumable() || journal.Old == nil || journal.Candidate == nil {
		return false, nil
	}
	if store.Permit(*journal.Old) == nil {
		return false, nil
	}
	if err := store.Permit(*journal.Candidate); err != nil {
		return true, fmt.Errorf("security transition recovery is fail-closed: prior release is revoked and staged candidate is not permitted: %w", err)
	}
	if journal.BackupID == "" {
		return true, errors.New("security transition recovery is fail-closed: revoked predecessor has no durable paired backup; preserve the journal and repair from the staged candidate")
	}
	transition, err := store.TransitionLock()
	if err != nil {
		return true, err
	}
	defer transition.Close()
	selection, err := store.SelectionLock(true)
	if err != nil {
		return true, err
	}
	defer selection.Close()
	// Re-read while holding both locks so a concurrent acquisition cannot alter
	// the candidate/policy decision after our preflight.
	journal, err = store.ReadJournal()
	if err != nil || journal.Candidate == nil || journal.Old == nil || store.Permit(*journal.Old) == nil {
		return true, errors.New("security transition changed while recovery was acquiring locks")
	}
	ctx, err := transitionContextForReceipt(env, store, *journal.Candidate)
	if err != nil {
		return true, err
	}
	var pair databasePair
	if err := decodeStrictRegular(filepath.Join(ctx.Instance.StateDir, "backups", journal.BackupID, "pair.json"), &pair); err != nil || pair.ReleaseReceipt != *journal.Old {
		return true, errors.New("security transition recovery has no verified predecessor database pair")
	}
	if err := store.Advance(&journal, release.RollbackRestoring, nil); err != nil {
		return true, err
	}
	if err := stop(ctx); err != nil {
		return true, fmt.Errorf("quiesce possibly-live candidate before security recovery restore: %w", err)
	}
	if err := restorePair(ctx, pair); err != nil {
		return true, err
	}
	if err := store.Advance(&journal, release.CandidateStarting, nil); err != nil {
		return true, err
	}
	if err := startReleaseCommand(ctx, *journal.Candidate, journal.ID); err != nil {
		_ = store.Advance(&journal, release.Failed, err)
		return true, fmt.Errorf("security transition candidate did not become healthy; revoked predecessor was not started: %w", err)
	}
	if err := store.Advance(&journal, release.CandidateHealthy, nil); err != nil {
		return true, err
	}
	active, _ := store.ReadActive()
	if _, err := store.WriteSelectedActive(*journal.Candidate, active.Generation, journal.Candidate.BuildID, active.Acquisition); err != nil {
		return true, err
	}
	if err := writeLegacyCurrent(store.Home, *journal.Candidate); err != nil {
		return true, err
	}
	if err := store.Advance(&journal, release.Promoted, nil); err != nil {
		return true, err
	}
	_, err = fmt.Fprintf(output, "Recovered the verified security-update candidate %s; revoked predecessor was not started.\n", journal.Candidate.BuildID)
	return true, err
}

// recoverInterruptedTransitionBeforeBootstrap prevents a formula-owned
// frontend from trying to stage or promote another candidate over a durable
// ordinary transition. Revoked-predecessor recovery runs first; this path is
// only for a still-permitted prior release.
func recoverInterruptedTransitionBeforeBootstrap(env []string, output io.Writer) (bool, error) {
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return false, nil
	}
	store, err := release.Open(home)
	if err != nil {
		return true, err
	}
	journal, err := store.ReadJournal()
	if errors.Is(err, os.ErrNotExist) || (err == nil && !journal.Resumable()) {
		return false, nil
	}
	if err != nil {
		return true, fmt.Errorf("read interrupted release transition before acquisition bootstrap: %w", err)
	}
	if journal.Old == nil {
		return true, errors.New("unfinished release transition has no prior release receipt")
	}
	if err := store.Permit(*journal.Old); err != nil {
		return true, fmt.Errorf("interrupted transition prior release is no longer permitted and safe candidate recovery was unavailable: %w", err)
	}
	ctx, err := transitionContextForReceipt(env, store, *journal.Old)
	if err != nil {
		return true, err
	}
	recovered, err := recoverInterruptedTransition(ctx, store)
	if err != nil {
		return true, err
	}
	if !recovered {
		return true, errors.New("interrupted release transition changed while recovery was acquiring locks; retry rollback")
	}
	_, err = io.WriteString(output, "Interrupted JobCtrl transition was restored to its previous release.\n")
	return true, err
}

// uninstallUnsafeActiveBeforePrepare keeps the public escape hatch available
// when authenticated policy has revoked the selected release (or its immutable
// execution evidence is damaged). Normal commands still fail closed, but an
// exact uninstall never needs to execute the untrusted payload it is removing.
func uninstallUnsafeActiveBeforePrepare(args, env []string, output io.Writer) (bool, error) {
	if len(args) == 0 || args[0] != "uninstall" {
		return false, nil
	}
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return false, nil
	}
	store, err := release.Open(home)
	if err != nil {
		return true, err
	}
	active, err := store.ReadActive()
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return true, fmt.Errorf("read active release before fail-closed uninstall: %w", err)
	}
	_, releaseErr := verifyInstalledReleaseForExecution(store, active.Receipt)
	selectorErr := VerifyPublicSelectorForExecution(store.Home)
	if releaseErr == nil && selectorErr == nil {
		return false, nil
	}
	instance, err := resolveInstance(env)
	if err != nil {
		return true, err
	}
	ctx := launchContext{Executable: filepath.Join(store.Home, "bin", "jobctrl"), Instance: instance, Environment: append([]string{}, env...)}
	return true, uninstall(ctx, args[1:], output)
}

func transitionContextForReceipt(env []string, store *release.Store, receipt release.Receipt) (launchContext, error) {
	verified, err := verifyInstalledReleaseForExecution(store, receipt)
	if err != nil {
		return launchContext{}, err
	}
	instance, err := resolveInstance(env)
	if err != nil {
		return launchContext{}, err
	}
	return launchContext{Executable: filepath.Join(verified.payloadRoot, "launcher", "jobctrl"), PayloadRoot: verified.payloadRoot, Manifest: verified.runtime, Distribution: verified.distribution, Instance: instance, Environment: childEnvironment(env, verified.payloadRoot, instance.StateDir, verified.runtime)}, nil
}

// rebindActiveContext closes the selector/update race after a lifecycle
// command drops its initial shared selection lock. All quiesce, SQLite, and
// restart actions then use the release observed under exclusive selection.
func rebindActiveContext(ctx launchContext, build string) (launchContext, error) {
	path := filepath.Join(ctx.Instance.RuntimeHome, "releases", build, "payload", "launcher", "jobctrl")
	payloadRoot := filepath.Dir(filepath.Dir(path))
	distribution, err := loadAndVerifyDistributionManifest(payloadRoot)
	if err != nil {
		return launchContext{}, err
	}
	manifest, err := loadRuntimeManifest(filepath.Join(payloadRoot, "launcher", "runtime-manifest.json"))
	if err != nil {
		return launchContext{}, err
	}
	if distribution.LauncherCompatibility.Minimum > launcherProtocol || distribution.LauncherCompatibility.Maximum < launcherProtocol {
		return launchContext{}, fmt.Errorf("payload supports launcher protocol %d-%d, this launcher is protocol %d", distribution.LauncherCompatibility.Minimum, distribution.LauncherCompatibility.Maximum, launcherProtocol)
	}
	env := append([]string{}, ctx.Environment...)
	env = append(env, "JOBCTRL_RUNTIME_HOME="+ctx.Instance.RuntimeHome, "JOBCTRL_DIR="+ctx.Instance.StateDir)
	return launchContext{Executable: path, PayloadRoot: payloadRoot, Manifest: manifest, Distribution: distribution, Instance: ctx.Instance, Environment: childEnvironment(env, payloadRoot, ctx.Instance.StateDir, manifest)}, nil
}

type verifiedRelease struct {
	receipt      release.Receipt
	payloadRoot  string
	distribution distributionManifest
	runtime      runtimeManifest
}

// verifyInstalledReleaseForExecution is intentionally repeated immediately
// before every lifecycle exec. A release being immutable on disk is not a
// substitute for re-checking it when another process may have modified it
// since staging or since the initial candidate validation.
func verifyInstalledReleaseForExecution(store *release.Store, receipt release.Receipt) (verifiedRelease, error) {
	installed, err := readInstalledReceipt(store.Home, receipt.BuildID)
	if err != nil {
		return verifiedRelease{}, err
	}
	if installed != receipt {
		return verifiedRelease{}, errors.New("installed receipt identity changed since transition began")
	}
	if receipt.SchemaVersion == 2 {
		if _, err := readInstalledPolicy(store.Home, receipt); err != nil {
			return verifiedRelease{}, fmt.Errorf("verify immutable release policy: %w", err)
		}
	}
	if err := store.Permit(receipt); err != nil {
		return verifiedRelease{}, fmt.Errorf("release is not permitted by authenticated channel policy: %w", err)
	}
	payloadRoot := filepath.Join(store.Home, "releases", receipt.BuildID, "payload")
	distribution, err := loadAndVerifyDistributionManifest(payloadRoot)
	if err != nil {
		return verifiedRelease{}, fmt.Errorf("verify release payload: %w", err)
	}
	manifestDigest, err := sha256Path(filepath.Join(payloadRoot, "manifest.json"))
	if err != nil {
		return verifiedRelease{}, err
	}
	if manifestDigest != receipt.ManifestSHA256 {
		return verifiedRelease{}, errors.New("verified manifest digest differs from immutable receipt")
	}
	if distribution.BuildID != receipt.BuildID || distribution.ReleaseChannel != receipt.Channel {
		return verifiedRelease{}, errors.New("verified payload does not match immutable receipt")
	}
	var probe runtimeManifest
	if err := decodeStrict(filepath.Join(payloadRoot, "launcher", "runtime-manifest.json"), &probe); err != nil {
		return verifiedRelease{}, err
	}
	runtime, err := loadRuntimeManifestForProtocol(filepath.Join(payloadRoot, "launcher", "runtime-manifest.json"), probe.LauncherProtocol)
	if err != nil {
		return verifiedRelease{}, err
	}
	if distribution.LauncherCompatibility.Minimum > runtime.LauncherProtocol || distribution.LauncherCompatibility.Maximum < runtime.LauncherProtocol {
		return verifiedRelease{}, errors.New("release launcher is not compatible with its payload")
	}
	launcherPath := filepath.Join(payloadRoot, "launcher", "jobctrl")
	if info, err := os.Lstat(launcherPath); err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 {
		return verifiedRelease{}, errors.New("release launcher is not a regular executable")
	}
	return verifiedRelease{receipt: receipt, payloadRoot: payloadRoot, distribution: distribution, runtime: runtime}, nil
}

func protocolSupports(manifest distributionManifest, protocol int) bool {
	return manifest.LauncherCompatibility.Minimum <= protocol && protocol <= manifest.LauncherCompatibility.Maximum
}

func manifestRegularFile(manifest distributionManifest, path string) (string, error) {
	for _, file := range manifest.Files {
		if file.Path == path && file.Type == "file" && file.Mode == "0755" {
			return file.SHA256, nil
		}
	}
	return "", fmt.Errorf("manifest does not declare executable %q", path)
}

// handoffPublicSelector is called only with transition then exclusive
// selection locking held. The caller has already proven candidate protocol
// compatibility with both active and candidate payloads. The rename plus
// directory fsync makes either the old or candidate selector durable; both are
// able to supervise the active payload at their corresponding journal state.
func handoffPublicSelector(home string, candidate verifiedRelease) error {
	expectedDigest, err := manifestRegularFile(candidate.distribution, "launcher/jobctrl")
	if err != nil {
		return err
	}
	sourcePath := filepath.Join(candidate.payloadRoot, "launcher", "jobctrl")
	sourceInfo, err := os.Lstat(sourcePath)
	if err != nil || !sourceInfo.Mode().IsRegular() || sourceInfo.Mode()&os.ModeSymlink != 0 || sourceInfo.Mode()&0o111 == 0 {
		return errors.New("candidate selector source is not a regular executable")
	}
	bin := filepath.Join(home, "bin")
	if err := ensureSafeDirectory(bin); err != nil {
		return err
	}
	target := filepath.Join(bin, "jobctrl")
	if info, err := os.Lstat(target); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return errors.New("public selector is not a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	random, err := releaseRandomID()
	if err != nil {
		return err
	}
	temporary := filepath.Join(bin, ".jobctrl-handoff-"+random)
	source, err := os.OpenFile(sourcePath, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer source.Close()
	destination, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, sourceInfo.Mode().Perm())
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(destination, hash), source)
	if copyErr == nil {
		copyErr = destination.Sync()
	}
	if closeErr := destination.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		_ = os.Remove(temporary)
		return copyErr
	}
	if hex.EncodeToString(hash.Sum(nil)) != expectedDigest {
		_ = os.Remove(temporary)
		return errors.New("candidate selector digest changed before handoff")
	}
	if err := os.Rename(temporary, target); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return syncDirectory(bin)
}

func releaseRandomID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func advance(store *release.Store, journal *release.Journal, state release.State) error {
	if err := store.Advance(journal, state, nil); err != nil {
		return err
	}
	if transitionFailure != nil {
		if err := transitionFailure(state); err != nil {
			// An abrupt interruption models SIGKILL/power loss after the journal
			// fsync. Do not relabel it failed: the next lifecycle invocation must
			// see the durable milestone and recover from it.
			if errors.Is(err, errTransitionInterrupted) {
				return err
			}
			_ = store.Advance(journal, release.Failed, err)
			return err
		}
	}
	return nil
}

func update(ctx launchContext, args []string, output io.Writer) error {
	releaseSelection(&ctx)
	if len(args) == 1 && args[0] == "--help" {
		_, err := io.WriteString(output, "usage: jobctrl update [--to BUILD_ID]\n")
		return err
	}
	build, err := parseBuildTarget(args, "update")
	if err != nil {
		return err
	}
	store, err := releaseStore(ctx)
	if err != nil {
		return err
	}
	active, err := store.ReadActive()
	if err != nil {
		return fmt.Errorf("read active release: %w", err)
	}
	if active.Acquisition == "homebrew" {
		if build != "" && environmentMap(ctx.Environment)["JOBCTRL_ACQUISITION_INTERNAL"] != "1" {
			return errors.New("Homebrew updates select the formula's authenticated build; `jobctrl update --to` is unavailable")
		}
		if build != "" {
			return promoteExisting(ctx, store, active, build, "update", output)
		}
		return updateHomebrew(ctx, store, active, output)
	}
	if build == "" {
		policy, policyErr := AcquisitionBuildPolicy()
		if policyErr != nil || !policy.AllowNetwork {
			return errors.New("signed public update metadata is not available until P6 signing/notarization; use a verified local fixture only in development")
		}
		if active.Acquisition == "curl" {
			return updateCurl(ctx, store, active, output)
		}
		return errors.New("the signed public update transport is enabled only by the P6 release integration")
	}
	return promoteExisting(ctx, store, active, build, "update", output)
}

// updateCurl is the public curl acquisition adapter. It deliberately executes
// only the installer shipped in the current authenticated payload, asks it to
// stage (not promote) a candidate, and accepts only an exact JSON receipt for
// the immutable candidate that appeared in the user-owned release store.
func updateCurl(ctx launchContext, store *release.Store, active release.Active, output io.Writer) error {
	current, err := store.ReadActive()
	if err != nil {
		return fmt.Errorf("re-read active release before curl staging: %w", err)
	}
	if current.Receipt != active.Receipt || current.Acquisition != "curl" {
		return errors.New("active JobCtrl acquisition changed during curl update; retry the command")
	}
	verified, err := verifyInstalledReleaseForExecution(store, current.Receipt)
	if err != nil {
		return fmt.Errorf("re-verify active release before curl staging: %w", err)
	}
	active = current
	installerPath := filepath.Join(verified.payloadRoot, "launcher", "jobctrl-installer")
	expectedDigest, err := manifestExecutableDigest(verified.distribution, "launcher/jobctrl-installer")
	if err != nil {
		return fmt.Errorf("current active payload does not provide a manifest-declared acquisition installer: %w", err)
	}
	info, err := os.Lstat(installerPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 {
		return errors.New("current active acquisition installer is not a regular executable")
	}
	digest, err := sha256Path(installerPath)
	if err != nil || digest != expectedDigest {
		return errors.New("current active acquisition installer differs from its authenticated manifest")
	}
	installerArgs := []string{"--source", "curl", "--stage-only", "--json", "--home", store.Home}
	stagedOutput, err := curlInstallerCommand(installerPath, installerArgs, ctx.Environment)
	if err != nil {
		return fmt.Errorf("stage upgraded curl JobCtrl release through current authenticated installer: %w: %s", err, strings.TrimSpace(stagedOutput))
	}
	candidate, err := decodeInstallerReceipt(stagedOutput)
	if err != nil {
		return fmt.Errorf("current authenticated installer returned an invalid staged receipt: %w", err)
	}
	installed, err := readInstalledReceipt(store.Home, candidate.BuildID)
	if err != nil || installed != candidate {
		return errors.New("current authenticated installer did not stage the exact receipt it returned")
	}
	if candidate.Channel != active.Receipt.Channel {
		return errors.New("curl installer staged a candidate for a different channel")
	}
	if candidate.BuildID == active.Receipt.BuildID {
		if candidate != active.Receipt {
			return errors.New("curl installer returned a conflicting receipt for the active build")
		}
		_, err := fmt.Fprintf(output, "JobCtrl %s is already active.\n", candidate.BuildID)
		return err
	}
	ctx.Environment = append(ctx.Environment, "JOBCTRL_ACQUISITION_SOURCE=curl")
	return curlPromotion(ctx, store, active, candidate.BuildID, "update", output)
}

func decodeInstallerReceipt(raw string) (release.Receipt, error) {
	var receipt release.Receipt
	decoder := json.NewDecoder(strings.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return receipt, err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		if err == nil {
			return receipt, errors.New("multiple JSON values")
		}
		return receipt, err
	}
	if !receipt.Valid() {
		return receipt, errors.New("invalid immutable receipt")
	}
	return receipt, nil
}

// updateHomebrew keeps `jobctrl update` as the one public update command. The
// acquisition adapter lets Homebrew replace only its formula-owned cache, then
// feeds those assets to the already-authenticated active installer. The new
// Cellar bootstrap is never executed by this path.
func updateHomebrew(ctx launchContext, store *release.Store, active release.Active, output io.Writer) error {
	upgradeOutput, err := homebrewCommand("upgrade", "ebarti/tap/jobctrl")
	if err != nil {
		return fmt.Errorf("Homebrew acquisition update failed: %w: %s", err, strings.TrimSpace(upgradeOutput))
	}
	prefixOutput, err := homebrewCommand("--prefix", "ebarti/tap/jobctrl")
	if err != nil {
		return fmt.Errorf("resolve upgraded Homebrew JobCtrl prefix: %w: %s", err, strings.TrimSpace(prefixOutput))
	}
	prefix := strings.TrimSpace(prefixOutput)
	if !filepath.IsAbs(prefix) {
		return errors.New("Homebrew returned an invalid JobCtrl prefix")
	}
	assets, err := homebrewAssetsReader(prefix)
	if err != nil {
		return err
	}
	current, err := store.ReadActive()
	if err != nil {
		return fmt.Errorf("re-read active release before Homebrew staging: %w", err)
	}
	if current.Receipt != active.Receipt || current.Acquisition != "homebrew" {
		return errors.New("active JobCtrl acquisition changed during Homebrew update; retry the command")
	}
	verified, err := verifyInstalledReleaseForExecution(store, current.Receipt)
	if err != nil {
		return fmt.Errorf("re-verify active release before Homebrew staging: %w", err)
	}
	active = current
	installerPath := filepath.Join(verified.payloadRoot, "launcher", "jobctrl-installer")
	expectedDigest, err := manifestExecutableDigest(verified.distribution, "launcher/jobctrl-installer")
	if err != nil {
		return fmt.Errorf("current active payload does not provide a manifest-declared acquisition installer: %w", err)
	}
	info, err := os.Lstat(installerPath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 {
		return errors.New("current active acquisition installer is not a regular executable")
	}
	digest, err := sha256Path(installerPath)
	if err != nil || digest != expectedDigest {
		return errors.New("current active acquisition installer differs from its authenticated manifest")
	}
	installerArgs := []string{"--source", "homebrew", "--stage-only", "--home", store.Home, "--descriptor-url", assets.DescriptorURL, "--descriptor-file", assets.DescriptorPath, "--signature-file", assets.SignaturePath, "--archive-file", assets.ArchivePath}
	bootstrapOutput, err := homebrewBootstrapCommand(installerPath, installerArgs, ctx.Environment)
	if err != nil {
		return fmt.Errorf("stage upgraded Homebrew JobCtrl release through current authenticated installer: %w: %s", err, strings.TrimSpace(bootstrapOutput))
	}
	candidate, err := readInstalledReceipt(store.Home, assets.BuildID)
	if err != nil || candidate.DescriptorSHA256 != assets.DescriptorSHA256 {
		return errors.New("current authenticated installer did not stage the formula's exact descriptor-bound candidate")
	}
	if candidate.BuildID == active.Receipt.BuildID {
		if candidate != active.Receipt {
			return errors.New("Homebrew installer returned a conflicting receipt for the active build")
		}
		_, err := fmt.Fprintf(output, "JobCtrl %s is already active.\n", candidate.BuildID)
		return err
	}
	ctx.Environment = append(ctx.Environment, "JOBCTRL_ACQUISITION_SOURCE=homebrew")
	return homebrewPromotion(ctx, store, active, candidate.BuildID, "update", output)
}

type homebrewFormulaAssets struct {
	BuildID          string
	DescriptorURL    string
	DescriptorSHA256 string
	DescriptorPath   string
	SignaturePath    string
	ArchivePath      string
}

// readHomebrewFormulaAssets treats the upgraded Cellar only as an acquisition
// cache. No formula executable runs here: the currently authenticated active
// payload installer validates these exact bytes before staging.
func readHomebrewFormulaAssets(prefix string) (homebrewFormulaAssets, error) {
	root := filepath.Join(prefix, "libexec", "bootstrap")
	configPath := filepath.Join(root, "homebrew-bootstrap.json")
	var config homebrewBootstrapConfig
	if err := decodeBootstrapConfig(configPath, &config); err != nil {
		return homebrewFormulaAssets{}, err
	}
	if config.SchemaVersion != 1 || config.DescriptorURL == "" || !buildIDPattern.MatchString(config.BuildID) || !sha256Pattern.MatchString(config.DescriptorSHA256) || !safeRelativePath(config.Descriptor) || !safeRelativePath(config.Signature) || !safeRelativePath(config.Archive) {
		return homebrewFormulaAssets{}, errors.New("invalid upgraded Homebrew acquisition configuration")
	}
	descriptorPath := filepath.Join(root, config.Descriptor)
	signaturePath := filepath.Join(root, config.Signature)
	archivePath := filepath.Join(root, config.Archive)
	for _, path := range []string{descriptorPath, signaturePath, archivePath} {
		info, err := os.Lstat(path)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return homebrewFormulaAssets{}, errors.New("upgraded Homebrew acquisition resource is not a regular file")
		}
	}
	descriptorRaw, err := os.ReadFile(descriptorPath)
	if err != nil {
		return homebrewFormulaAssets{}, err
	}
	digest := sha256.Sum256(descriptorRaw)
	if hex.EncodeToString(digest[:]) != config.DescriptorSHA256 {
		return homebrewFormulaAssets{}, errors.New("upgraded Homebrew descriptor digest mismatch")
	}
	return homebrewFormulaAssets{BuildID: config.BuildID, DescriptorURL: config.DescriptorURL, DescriptorSHA256: config.DescriptorSHA256, DescriptorPath: descriptorPath, SignaturePath: signaturePath, ArchivePath: archivePath}, nil
}

func rollback(ctx launchContext, args []string, output io.Writer) error {
	releaseSelection(&ctx)
	build, err := parseBuildTarget(args, "rollback")
	if err != nil {
		return err
	}
	store, err := releaseStore(ctx)
	if err != nil {
		return err
	}
	if recovered, err := recoverInterruptedTransition(ctx, store); err != nil {
		return err
	} else if recovered {
		_, err := io.WriteString(output, "Interrupted JobCtrl transition was restored to its previous release.\n")
		return err
	}
	active, err := store.ReadActive()
	if err != nil {
		return fmt.Errorf("read active release: %w", err)
	}
	if build == "" {
		build, err = previousRelease(store, active.Receipt)
		if err != nil {
			return err
		}
	}
	return rollbackExisting(ctx, store, active, build, output)
}

// rollbackExisting restores the precise retained pair for the target release
// before it ever starts that target. Reusing update promotion here would run
// old code against the new schema, which is explicitly unsafe.
func rollbackExisting(ctx launchContext, store *release.Store, active release.Active, build string, output io.Writer) (result error) {
	transition, err := store.TransitionLock()
	if err != nil {
		return err
	}
	defer transition.Close()
	selection, err := store.SelectionLock(true)
	if err != nil {
		return err
	}
	defer selection.Close()
	active, err = store.ReadActive()
	if err != nil {
		return err
	}
	target, err := readInstalledReceipt(store.Home, build)
	if err != nil {
		return err
	}
	if target.Channel != active.Receipt.Channel {
		return errors.New("rollback target channel differs from active channel")
	}
	if err := store.Permit(target); err != nil {
		return fmt.Errorf("rollback target is not safe: %w", err)
	}
	targetPair, err := retainedPairForReceipt(ctx.Instance.StateDir, target)
	if err != nil {
		return fmt.Errorf("rollback requires a verified paired backup for %s: %w", target.BuildID, err)
	}
	ctx, err = rebindActiveContext(ctx, active.Receipt.BuildID)
	if err != nil {
		return err
	}
	defer func() { _ = ctx.selection.Close() }()
	activeVerified, err := verifyInstalledReleaseForExecution(store, active.Receipt)
	if err != nil {
		return err
	}
	targetVerified, err := verifyInstalledReleaseForExecution(store, target)
	if err != nil {
		return err
	}
	if active.SelectorBuildID != target.BuildID {
		targetProtocol := targetVerified.runtime.LauncherProtocol
		if !protocolSupports(activeVerified.distribution, targetProtocol) || !protocolSupports(targetVerified.distribution, targetProtocol) {
			return fmt.Errorf("rollback launcher protocol %d cannot supervise both active and target payloads; choose a retained compatible bridge release", targetProtocol)
		}
	}
	journal, err := store.Begin("rollback", &active.Receipt, &target, target.DescriptorSHA256)
	if err != nil {
		return err
	}
	journal.TargetBackupID = targetPair.ID
	if err := advance(store, &journal, release.MetadataVerified); err != nil {
		return err
	}
	if active.SelectorBuildID != target.BuildID {
		if err := advance(store, &journal, release.SelectorHandoffPending); err != nil {
			return err
		}
		if err := handoffPublicSelector(store.Home, targetVerified); err != nil {
			return err
		}
		if err := advance(store, &journal, release.SelectorReplaced); err != nil {
			return err
		}
		active, err = store.WriteSelectedActive(active.Receipt, active.Generation, target.BuildID, active.Acquisition)
		if err != nil {
			return err
		}
	}
	if err := advance(store, &journal, release.Quiescing); err != nil {
		return err
	}
	if err := stop(ctx); err != nil {
		_ = store.Advance(&journal, release.Failed, err)
		return err
	}
	currentPair, err := snapshotPair(ctx, active.Receipt)
	if err != nil {
		_ = store.Advance(&journal, release.Failed, err)
		return err
	}
	journal.BackupID = currentPair.ID
	if err := advance(store, &journal, release.PairBackedUp); err != nil {
		return err
	}
	fail := func(cause error) error {
		_ = store.Advance(&journal, release.RollbackRestoring, cause)
		if stopErr := stop(ctx); stopErr != nil {
			return fmt.Errorf("%v; refusing to restore the current database pair while the rollback target could not be quiesced: %w", cause, stopErr)
		}
		if restoreErr := restorePair(ctx, currentPair); restoreErr != nil {
			return fmt.Errorf("%v; restore current pair: %w", cause, restoreErr)
		}
		if _, pointerErr := store.WriteSelectedActive(active.Receipt, active.Generation, active.SelectorBuildID, active.Acquisition); pointerErr != nil {
			return fmt.Errorf("%v; restore current active record: %w", cause, pointerErr)
		}
		if err := writeLegacyCurrent(store.Home, active.Receipt); err != nil {
			return err
		}
		if permitErr := store.Permit(active.Receipt); permitErr != nil {
			_ = store.Advance(&journal, release.Failed, permitErr)
			return fmt.Errorf("%v; restored database pair but refused to restart revoked active release: %w", cause, permitErr)
		}
		if err := startReleaseCommand(ctx, active.Receipt, journal.ID); err != nil {
			return fmt.Errorf("%v; restart current release: %w", cause, err)
		}
		_ = store.Advance(&journal, release.RolledBack, cause)
		return cause
	}
	if err := store.Advance(&journal, release.RollbackRestoring, nil); err != nil {
		return fail(err)
	}
	if err := restorePair(ctx, targetPair); err != nil {
		return fail(fmt.Errorf("restore rollback target pair: %w", err))
	}
	if err := advance(store, &journal, release.CandidateStarting); err != nil {
		return fail(err)
	}
	if err := startReleaseCommand(ctx, target, journal.ID); err != nil {
		return fail(fmt.Errorf("rollback target startup failed: %w", err))
	}
	if err := advance(store, &journal, release.CandidateHealthy); err != nil {
		return fail(err)
	}
	if _, err := store.WriteSelectedActive(target, active.Generation, target.BuildID, active.Acquisition); err != nil {
		return fail(err)
	}
	if err := writeLegacyCurrent(store.Home, target); err != nil {
		return fail(err)
	}
	if err := advance(store, &journal, release.Promoted); err != nil {
		return fail(err)
	}
	_, err = fmt.Fprintf(output, "JobCtrl rolled back to %s.\n", target.BuildID)
	return err
}

func retainedPairForReceipt(stateDir string, target release.Receipt) (databasePair, error) {
	entries, err := os.ReadDir(filepath.Join(stateDir, "backups"))
	if err != nil {
		return databasePair{}, err
	}
	var matches []databasePair
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		var pair databasePair
		if err := decodeStrictRegular(filepath.Join(stateDir, "backups", entry.Name(), "pair.json"), &pair); err == nil && pair.SchemaVersion == 1 && pair.ReleaseReceipt == target && len(pair.Files) == 2 {
			matches = append(matches, pair)
		}
	}
	if len(matches) == 0 {
		return databasePair{}, errors.New("no retained complete pair")
	}
	sort.Slice(matches, func(i, j int) bool { return matches[i].CreatedAt.After(matches[j].CreatedAt) })
	return matches[0], nil
}

// recoverInterruptedTransition is intentionally conservative: the only
// automatic resume action is to restore the complete old tuple. It never
// guesses that a partially started candidate should be promoted.
func recoverInterruptedTransition(ctx launchContext, store *release.Store) (bool, error) {
	transition, err := store.TransitionLock()
	if err != nil {
		return false, err
	}
	defer transition.Close()
	selection, err := store.SelectionLock(true)
	if err != nil {
		return false, err
	}
	defer selection.Close()
	journal, err := store.ReadJournal()
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if !journal.Resumable() {
		return false, nil
	}
	if journal.Old == nil {
		return false, errors.New("unfinished transition has no prior release receipt")
	}
	if err := store.Permit(*journal.Old); err != nil {
		// A revocation/floor raise may have been finalized after the paired
		// backup but before promotion. Restoring or starting old code here would
		// turn the recovery mechanism into a security rollback. Preserve the
		// journal and both database copies; the caller gets an actionable,
		// fail-closed status instead of a revoked runtime.
		_ = store.Advance(&journal, release.Failed, err)
		return false, fmt.Errorf("interrupted transition cannot restore revoked prior release: %w; verified candidate %q remains staged for explicit recovery", err, receiptBuild(journal.Candidate))
	}
	// Make the old release executable through the direct transition gate before
	// any stop/restart action, including crashes before PairBackedUp.
	if err := store.Advance(&journal, release.RollbackRestoring, nil); err != nil {
		return false, err
	}
	if err := stop(ctx); err != nil {
		return false, fmt.Errorf("quiesce interrupted transition: %w", err)
	}
	cleanupV7Candidate(ctx.Instance.StateDir, journal.ID)
	if journal.BackupID != "" {
		var pair databasePair
		if err := decodeStrictRegular(filepath.Join(ctx.Instance.StateDir, "backups", journal.BackupID, "pair.json"), &pair); err != nil {
			return false, fmt.Errorf("read interrupted transition database pair: %w", err)
		}
		if pair.ReleaseReceipt != *journal.Old {
			return false, errors.New("interrupted transition backup does not bind the prior release")
		}
		if err := restorePair(ctx, pair); err != nil {
			return false, err
		}
	}
	active, activeErr := store.ReadActive()
	generation := uint64(0)
	if activeErr == nil {
		generation = active.Generation
	} else if !errors.Is(activeErr, os.ErrNotExist) {
		return false, activeErr
	}
	selector := filepath.Join(store.Home, "bin", "jobctrl")
	selectorBuild := ""
	// Selector replacement is durable separately from the following journal or
	// active-record write. Identify the bytes actually installed rather than
	// trusting the pre-crash record, then preserve that compatible identity in
	// the recovered active record so terminal journals cannot hide a mismatch.
	if selectorMatchesRelease(store, selector, journal.Old.BuildID) {
		selectorBuild = journal.Old.BuildID
	} else if journal.Candidate != nil && selectorMatchesRelease(store, selector, journal.Candidate.BuildID) {
		selectorBuild = journal.Candidate.BuildID
	}
	if selectorBuild == "" {
		return false, errors.New("interrupted transition selector does not match an authenticated old or candidate release")
	}
	if _, err := store.WriteSelectedActive(*journal.Old, generation, selectorBuild, active.Acquisition); err != nil {
		return false, err
	}
	if err := writeLegacyCurrent(store.Home, *journal.Old); err != nil {
		return false, err
	}
	if err := startReleaseCommand(ctx, *journal.Old, journal.ID); err != nil {
		return false, err
	}
	if err := store.Advance(&journal, release.RolledBack, nil); err != nil {
		return false, err
	}
	return true, nil
}

func receiptBuild(receipt *release.Receipt) string {
	if receipt == nil {
		return "<none>"
	}
	return receipt.BuildID
}

func parseBuildTarget(args []string, command string) (string, error) {
	if len(args) == 0 {
		return "", nil
	}
	if len(args) == 2 && args[0] == "--to" && buildIDPattern.MatchString(args[1]) {
		return args[1], nil
	}
	return "", fmt.Errorf("usage: jobctrl %s [--to BUILD_ID]", command)
}

// promoteExisting uses the same promotion path for a staged update and a
// rollback. Candidate code starts while active.json still names old, then the
// only selection pointer changes after the real launcher readiness probe.
func promoteExisting(ctx launchContext, store *release.Store, active release.Active, build, operation string, output io.Writer) (result error) {
	transition, err := store.TransitionLock()
	if err != nil {
		return fmt.Errorf("acquire lifecycle transition lock: %w", err)
	}
	defer transition.Close()
	selection, err := store.SelectionLock(true)
	if err != nil {
		return fmt.Errorf("acquire exclusive release selection lock: %w", err)
	}
	defer selection.Close()
	if existing, journalErr := store.ReadJournal(); journalErr == nil && existing.Resumable() {
		return fmt.Errorf("unfinished %s transition at %s must be recovered before another promotion", existing.Operation, existing.State)
	} else if journalErr != nil && !errors.Is(journalErr, os.ErrNotExist) {
		return fmt.Errorf("read existing release transition journal: %w", journalErr)
	}
	// Another updater may have completed while this command was waiting.
	active, err = store.ReadActive()
	if err != nil {
		return err
	}
	ctx, err = rebindActiveContext(ctx, active.Receipt.BuildID)
	if err != nil {
		return err
	}
	defer func() { _ = ctx.selection.Close() }()
	candidate, err := readInstalledReceipt(store.Home, build)
	if err != nil {
		return err
	}
	if candidate.Channel != active.Receipt.Channel {
		return errors.New("candidate channel differs from the active channel")
	}
	if candidate.BuildID == active.Receipt.BuildID {
		if candidate != active.Receipt {
			return errors.New("candidate build identity conflicts with the active immutable receipt")
		}
		_, err := fmt.Fprintf(output, "JobCtrl %s is already active.\n", candidate.BuildID)
		return err
	}
	activeVerified, err := verifyInstalledReleaseForExecution(store, active.Receipt)
	if err != nil {
		return fmt.Errorf("active release is not safe to transition: %w", err)
	}
	candidateVerified, err := verifyInstalledReleaseForExecution(store, candidate)
	if err != nil {
		return fmt.Errorf("candidate is not safe to promote: %w", err)
	}
	if candidate.Sequence <= active.Receipt.Sequence {
		return errors.New("update refuses a lower or equal-sequence different release; use explicit rollback for an eligible predecessor")
	}
	activeRuntime := verifiedReleaseContext(ctx, activeVerified)
	candidateRuntime := verifiedReleaseContext(ctx, candidateVerified)
	policy, err := readInstalledPolicy(store.Home, candidate)
	if err != nil {
		return err
	}
	if active.SelectorBuildID != candidate.BuildID {
		candidateProtocol := candidateVerified.runtime.LauncherProtocol
		if !protocolSupports(activeVerified.distribution, candidateProtocol) || !protocolSupports(candidateVerified.distribution, candidateProtocol) {
			return fmt.Errorf("candidate launcher protocol %d cannot supervise both active and candidate payloads; stage an explicit compatible bridge release", candidateProtocol)
		}
	}
	journal, err := store.Begin(operation, &active.Receipt, &candidate, candidate.DescriptorSHA256)
	if err != nil {
		return err
	}
	if err := advance(store, &journal, release.MetadataVerified); err != nil {
		return err
	}
	if err := advance(store, &journal, release.ReleaseCommitted); err != nil {
		return err
	}
	if active.SelectorBuildID != candidate.BuildID {
		if err := advance(store, &journal, release.SelectorHandoffPending); err != nil {
			return err
		}
		if err := handoffPublicSelector(store.Home, candidateVerified); err != nil {
			return err
		}
		if err := advance(store, &journal, release.SelectorReplaced); err != nil {
			return err
		}
		updated, err := store.WriteSelectedActive(active.Receipt, active.Generation, candidate.BuildID, active.Acquisition)
		if err != nil {
			return err
		}
		active = updated
	}
	if err := advance(store, &journal, release.Quiescing); err != nil {
		return err
	}
	if err := stop(ctx); err != nil {
		_ = store.Advance(&journal, release.Failed, err)
		return fmt.Errorf("quiesce active release: %w", err)
	}
	restartBeforeBackup := func(cause error) error {
		_ = store.Advance(&journal, release.RollbackRestoring, cause)
		if stopErr := stop(ctx); stopErr != nil {
			return fmt.Errorf("%v; old runtime could not be made safe to restart: %w", cause, stopErr)
		}
		if legacyErr := writeLegacyCurrent(store.Home, active.Receipt); legacyErr != nil {
			return fmt.Errorf("%v; restore legacy receipt: %w", cause, legacyErr)
		}
		if restartErr := startReleaseCommand(ctx, active.Receipt, journal.ID); restartErr != nil {
			return fmt.Errorf("%v; old release restart failed: %w", cause, restartErr)
		}
		_ = store.Advance(&journal, release.RolledBack, cause)
		return cause
	}
	databaseVersion, err := jobCtrlSchemaVersion(activeRuntime)
	if err != nil {
		return restartBeforeBackup(fmt.Errorf("read stopped JobCtrl schema before update: %w", err))
	}
	switch databaseVersion {
	case legacyJobCtrlSchemaVersion:
		if err := temporalQuiescenceProof(activeRuntime, candidateRuntime); err != nil {
			return restartBeforeBackup(fmt.Errorf("v6-to-v8 upgrade blocked before backup: %w", err))
		}
	case exactJobCtrlSchemaVersion:
		// Exact v7 upgrades add v8 only after the stopped-runtime paired backup.
	case currentJobCtrlSchemaVersion:
		// Ordinary exact-v8 release promotion uses the paired lifecycle unchanged.
	default:
		return restartBeforeBackup(fmt.Errorf("unsupported stopped JobCtrl schema version %d", databaseVersion))
	}
	pair, err := snapshotPair(ctx, active.Receipt)
	if err != nil {
		if databaseVersion != currentJobCtrlSchemaVersion {
			return restartBeforeBackup(fmt.Errorf("create paired pre-upgrade backup: %w", err))
		}
		_ = store.Advance(&journal, release.Failed, err)
		return err
	}
	journal.BackupID = pair.ID
	if err := advance(store, &journal, release.PairBackedUp); err != nil {
		return err
	}
	journal.PendingPolicy = &policy
	if err := advance(store, &journal, release.PolicyPending); err != nil {
		return err
	}
	channelState, err := store.ValidateMetadata(policy)
	if err != nil {
		return err
	}

	rollbackFailure := func(cause error) error {
		_ = store.Advance(&journal, release.RollbackRestoring, cause)
		cleanupV7Candidate(ctx.Instance.StateDir, journal.ID)
		if stopErr := stop(ctx); stopErr != nil { // Candidate records share the canonical state identity.
			return fmt.Errorf("%v; refusing paired rollback restore while the candidate could not be quiesced: %w", cause, stopErr)
		}
		if restoreErr := restorePair(ctx, pair); restoreErr != nil {
			return fmt.Errorf("%v; paired rollback restore failed: %w", cause, restoreErr)
		}
		if _, activateErr := store.WriteSelectedActive(active.Receipt, active.Generation, active.SelectorBuildID, active.Acquisition); activateErr != nil {
			return fmt.Errorf("%v; restore active release pointer: %w", cause, activateErr)
		}
		if legacyErr := writeLegacyCurrent(store.Home, active.Receipt); legacyErr != nil {
			return fmt.Errorf("%v; restore legacy receipt: %w", cause, legacyErr)
		}
		if restartErr := startReleaseCommand(ctx, active.Receipt, journal.ID); restartErr != nil {
			return fmt.Errorf("%v; old release restart failed: %w", cause, restartErr)
		}
		_ = store.Advance(&journal, release.RolledBack, cause)
		return cause
	}
	if databaseVersion != currentJobCtrlSchemaVersion {
		candidatePath, err := sealedV7CandidateBuilder(candidateRuntime, pair, journal.ID)
		if err != nil {
			return rollbackFailure(fmt.Errorf("build exact-v8 migration candidate: %w", err))
		}
		if err := advance(store, &journal, release.MigrationCandidateReady); err != nil {
			return rollbackFailure(err)
		}
		if err := sealedV7CandidateInstaller(candidateRuntime, candidatePath); err != nil {
			return rollbackFailure(fmt.Errorf("activate exact-v8 database: %w", err))
		}
		if err := advance(store, &journal, release.MigrationActivated); err != nil {
			return rollbackFailure(err)
		}
	}
	if err := advance(store, &journal, release.CandidateStarting); err != nil {
		return rollbackFailure(err)
	}
	if err := startReleaseCommand(ctx, candidate, journal.ID); err != nil {
		return rollbackFailure(fmt.Errorf("candidate start/readiness failed: %w", err))
	}
	if err := advance(store, &journal, release.CandidateHealthy); err != nil {
		return rollbackFailure(err)
	}
	// The authenticated candidate policy may raise the safety floor or revoke
	// the predecessor. Commit it only after real readiness succeeds so every
	// earlier interruption can still restore and execute the prior release.
	if err := store.CommitMetadata(channelState); err != nil {
		if permitErr := store.Permit(active.Receipt); permitErr != nil {
			return fmt.Errorf("finalize authenticated policy after candidate readiness: %w; predecessor is no longer permitted, preserve the journal for explicit safe recovery: %v", err, permitErr)
		}
		return rollbackFailure(fmt.Errorf("finalize authenticated policy after candidate readiness: %w", err))
	}
	if err := advance(store, &journal, release.PolicyFinalized); err != nil {
		return err
	}
	source := environmentMap(ctx.Environment)["JOBCTRL_ACQUISITION_SOURCE"]
	if source == "" {
		source = active.Acquisition
	}
	if _, err := store.WriteSelectedActive(candidate, active.Generation, candidate.BuildID, source); err != nil {
		return err
	}
	if err := writeLegacyCurrent(store.Home, candidate); err != nil {
		return err
	}
	if err := advance(store, &journal, release.Promoted); err != nil {
		return err
	}
	if err := retainReleases(store, ctx.Instance.RuntimeHome); err != nil {
		return err
	}
	_, err = fmt.Fprintf(output, "JobCtrl %s is active.\n", candidate.BuildID)
	return err
}

func startRelease(ctx launchContext, receipt release.Receipt, journalID string) error {
	store, err := releaseStore(ctx)
	if err != nil {
		return err
	}
	verified, err := verifyInstalledReleaseForExecution(store, receipt)
	if err != nil {
		return fmt.Errorf("verify release immediately before execution: %w", err)
	}
	path := filepath.Join(verified.payloadRoot, "launcher", "jobctrl")
	cmd := exec.Command(path, "start", "--no-open")
	cmd.Env = append(append([]string{}, ctx.Environment...), "JOBCTRL_TRANSITION_CANDIDATE=1")
	if journalID != "" {
		cmd.Env = append(cmd.Env, "JOBCTRL_TRANSITION_JOURNAL="+journalID)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func backup(ctx launchContext, args []string, output io.Writer) error {
	releaseSelection(&ctx)
	directory := ""
	if len(args) == 2 && args[0] == "--output" {
		directory = args[1]
	} else if len(args) != 0 {
		return errors.New("usage: jobctrl backup [--output DIRECTORY]")
	}
	if directory == "" {
		directory = filepath.Join(ctx.Instance.StateDir, "backups")
	}
	if !filepath.IsAbs(directory) {
		return errors.New("backup output must be an absolute directory")
	}
	if err := ensureSafeDirectory(directory); err != nil {
		return err
	}
	store, err := releaseStore(ctx)
	if err != nil {
		return err
	}
	transition, err := store.TransitionLock()
	if err != nil {
		return err
	}
	defer transition.Close()
	selection, err := store.SelectionLock(true)
	if err != nil {
		return err
	}
	defer selection.Close()
	active, err := store.ReadActive()
	if err != nil {
		return err
	}
	ctx, err = rebindActiveContext(ctx, active.Receipt.BuildID)
	if err != nil {
		return err
	}
	defer func() { _ = ctx.selection.Close() }()
	wasRunning := false
	if state, stateErr := readState(ctx.Instance.StatePath); stateErr == nil {
		wasRunning = stateHasLiveProcesses(state)
	} else if !errors.Is(stateErr, os.ErrNotExist) {
		return stateErr
	}
	if wasRunning {
		if err := stop(ctx); err != nil {
			return fmt.Errorf("quiesce runtime for coherent paired backup: %w", err)
		}
	}
	pair, err := snapshotPairTo(ctx, active.Receipt, directory)
	if wasRunning {
		// A stable selector takes a shared selection lock through readiness, so
		// restart only after releasing our exclusive selection lock. We retain
		// the transition lock to serialize lifecycle work, and route through the
		// authenticated public selector rather than direct payload execution.
		if closeErr := selection.Close(); closeErr != nil {
			return closeErr
		}
		if restartErr := startSelectedRelease(ctx); restartErr != nil {
			if err != nil {
				return fmt.Errorf("%v; restart after backup failed: %w", err, restartErr)
			}
			return restartErr
		}
	}
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(output, "JobCtrl database pair backup written: %s\n", filepath.Join(directory, pair.ID))
	return err
}

func startSelectedRelease(ctx launchContext) error {
	selector := filepath.Join(ctx.Instance.RuntimeHome, "bin", "jobctrl")
	if err := VerifyPublicSelectorForExecution(ctx.Instance.RuntimeHome); err != nil {
		return fmt.Errorf("verify public selector before restart: %w", err)
	}
	command := exec.Command(selector, "start", "--no-open")
	command.Env = append([]string{}, ctx.Environment...)
	output, err := command.CombinedOutput()
	if err != nil {
		return fmt.Errorf("restart through public selector: %w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func snapshotPair(ctx launchContext, receipt release.Receipt) (databasePair, error) {
	return snapshotPairTo(ctx, receipt, filepath.Join(ctx.Instance.StateDir, "backups"))
}
func snapshotPairTo(ctx launchContext, receipt release.Receipt, parent string) (databasePair, error) {
	if err := ensureSafeDirectory(parent); err != nil {
		return databasePair{}, err
	}
	random, err := releaseRandomID()
	if err != nil {
		return databasePair{}, err
	}
	id := "pair-" + random
	dir := filepath.Join(parent, id)
	if err := os.Mkdir(dir, 0o700); err != nil {
		return databasePair{}, err
	}
	pair := databasePair{SchemaVersion: 1, ID: id, ReleaseReceipt: receipt, CreatedAt: time.Now().UTC()}
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		source := filepath.Join(ctx.Instance.StateDir, name)
		destination := filepath.Join(dir, name)
		version, err := sqliteOnlineBackup(filepath.Join(ctx.PayloadRoot, "python", "bin", "python3"), source, destination)
		if err != nil {
			return databasePair{}, fmt.Errorf("snapshot %s: %w", name, err)
		}
		file, err := describeDatabase(destination, name, version)
		if err != nil {
			return databasePair{}, err
		}
		pair.Files = append(pair.Files, file)
	}
	if err := writeJSONAtomic(filepath.Join(dir, "pair.json"), pair); err != nil {
		return databasePair{}, err
	}
	if err := syncDirectory(dir); err != nil {
		return databasePair{}, err
	}
	if err := syncDirectory(parent); err != nil {
		return databasePair{}, err
	}
	return pair, nil
}

func sqliteOnlineBackup(python, source, destination string) (int64, error) {
	info, err := os.Lstat(source)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("source database is not a regular file")
	}
	if _, err := os.Lstat(destination); !errors.Is(err, os.ErrNotExist) {
		return 0, errors.New("backup destination already exists")
	}
	code := `import os,sqlite3,sys
src,dst=sys.argv[1:3]
c=sqlite3.connect(src, timeout=30)
try:
 r=c.execute("PRAGMA integrity_check").fetchone()
 if not r or r[0] != "ok": raise RuntimeError("source integrity_check failed")
 c.execute("VACUUM INTO ?", (dst,))
finally: c.close()
d=sqlite3.connect(dst)
try:
 r=d.execute("PRAGMA integrity_check").fetchone()
 if not r or r[0] != "ok": raise RuntimeError("backup integrity_check failed")
 print(d.execute("PRAGMA user_version").fetchone()[0])
finally: d.close()`
	out, err := exec.Command(python, "-I", "-B", "-c", code, source, destination).CombinedOutput()
	if err != nil {
		return 0, fmt.Errorf("SQLite online backup: %w: %s", err, strings.TrimSpace(string(out)))
	}
	var version int64
	if _, err := fmt.Sscan(strings.TrimSpace(string(out)), &version); err != nil {
		return 0, errors.New("SQLite backup returned invalid schema version")
	}
	file, err := os.OpenFile(destination, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return 0, err
	}
	syncErr := file.Sync()
	closeErr := file.Close()
	if syncErr != nil {
		return 0, syncErr
	}
	if closeErr != nil {
		return 0, closeErr
	}
	return version, nil
}

func describeDatabase(path, name string, version int64) (databaseFile, error) {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return databaseFile{}, errors.New("backup database is not a regular file")
	}
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return databaseFile{}, err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return databaseFile{}, err
	}
	return databaseFile{Name: name, SHA256: hex.EncodeToString(hash.Sum(nil)), SizeBytes: info.Size(), SQLiteUserVer: version}, nil
}

func restorePair(ctx launchContext, pair databasePair) error {
	if pair.SchemaVersion != 1 || !pair.ReleaseReceipt.Valid() || len(pair.Files) != 2 {
		return errors.New("backup is not a complete database pair")
	}
	dir := filepath.Join(ctx.Instance.StateDir, "backups", pair.ID)
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("backup pair directory is not a regular directory")
	}
	for _, expected := range pair.Files {
		if expected.Name != "jobctrl.db" && expected.Name != "temporal.db" {
			return errors.New("backup pair has an unknown database")
		}
		actual, err := describeDatabase(filepath.Join(dir, expected.Name), expected.Name, expected.SQLiteUserVer)
		if err != nil || actual.SHA256 != expected.SHA256 || actual.SizeBytes != expected.SizeBytes {
			return errors.New("backup database pair digest/size verification failed")
		}
	}
	random, err := releaseRandomID()
	if err != nil {
		return err
	}
	staging := filepath.Join(ctx.Instance.StateDir, ".restore-"+random)
	if err := os.Mkdir(staging, 0o700); err != nil {
		return err
	}
	defer os.RemoveAll(staging)
	for _, expected := range pair.Files {
		staged := filepath.Join(staging, expected.Name)
		if err := copyRegular(filepath.Join(dir, expected.Name), staged); err != nil {
			return err
		}
	}
	// No runtime is live (quiescing happened first). The journal makes a crash
	// between the two renames recoverable; never restore a single DB by itself.
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		if err := os.Rename(filepath.Join(staging, name), filepath.Join(ctx.Instance.StateDir, name)); err != nil {
			return err
		}
	}
	return cleanupSQLiteSidecars(ctx.Instance.StateDir, "jobctrl.db", "temporal.db")
}

func cleanupSQLiteSidecars(stateDir string, databaseNames ...string) error {
	for _, name := range databaseNames {
		if name != "jobctrl.db" && name != "temporal.db" {
			return errors.New("unknown SQLite database sidecar owner")
		}
		for _, suffix := range []string{"-journal", "-shm", "-wal"} {
			path := filepath.Join(stateDir, name+suffix)
			if err := removeSQLiteSidecar(path); err != nil && !errors.Is(err, os.ErrNotExist) {
				return fmt.Errorf("remove stale %s sidecar: %w", filepath.Base(path), err)
			}
		}
	}
	return syncDirectory(stateDir)
}

func copyRegular(source, destination string) error {
	input, err := os.OpenFile(source, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return err
	}
	defer input.Close()
	info, err := input.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return errors.New("copy source is not a regular file")
	}
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	_, copyErr := io.Copy(output, input)
	if copyErr == nil {
		copyErr = output.Sync()
	}
	if closeErr := output.Close(); copyErr == nil {
		copyErr = closeErr
	}
	if copyErr != nil {
		_ = os.Remove(destination)
	}
	return copyErr
}
func ensureSafeDirectory(path string) error {
	info, err := os.Lstat(path)
	if err == nil {
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("managed path is not a regular directory")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return os.MkdirAll(path, 0o700)
}
func writeJSONAtomic(path string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	raw = append(raw, '\n')
	random, err := releaseRandomID()
	if err != nil {
		return err
	}
	tmp := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+random)
	file, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return err
	}
	if _, err := file.Write(raw); err != nil {
		file.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		_ = os.Remove(tmp)
		return err
	}
	if err := file.Close(); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		_ = os.Remove(tmp)
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

func writeLegacyCurrent(home string, receipt release.Receipt) error {
	// current.json is only a one-time P4 migration input. New P5 records keep
	// acquisition ownership in active.json and never copy it into immutable
	// release evidence.
	return writeJSONAtomic(filepath.Join(home, "current.json"), selectorReceipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: int64(receipt.Sequence), ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt})
}
func readInstalledReceipt(home, build string) (release.Receipt, error) {
	var receipt selectorReceipt
	if !buildIDPattern.MatchString(build) {
		return release.Receipt{}, errors.New("invalid release build id")
	}
	if err := decodeStrictRegular(filepath.Join(home, "releases", build, "receipt.json"), &receipt); err != nil {
		return release.Receipt{}, fmt.Errorf("read candidate release receipt: %w", err)
	}
	r := release.Receipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: uint64(receipt.Sequence), ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}
	if !r.Valid() {
		return release.Receipt{}, errors.New("candidate release receipt is invalid")
	}
	return r, nil
}

func readInstalledPolicy(home string, receipt release.Receipt) (release.ChannelMetadata, error) {
	if receipt.SchemaVersion != 2 || !sha256Pattern.MatchString(receipt.PolicySHA256) {
		return release.ChannelMetadata{}, errors.New("candidate release receipt does not bind authenticated policy")
	}
	path := filepath.Join(home, "releases", receipt.BuildID, "policy.json")
	file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return release.ChannelMetadata{}, fmt.Errorf("read candidate release policy: %w", err)
	}
	raw, readErr := io.ReadAll(file)
	info, statErr := file.Stat()
	closeErr := file.Close()
	if readErr != nil {
		return release.ChannelMetadata{}, fmt.Errorf("read candidate release policy: %w", readErr)
	}
	if statErr != nil {
		return release.ChannelMetadata{}, fmt.Errorf("stat candidate release policy: %w", statErr)
	}
	if closeErr != nil {
		return release.ChannelMetadata{}, fmt.Errorf("close candidate release policy: %w", closeErr)
	}
	if !info.Mode().IsRegular() {
		return release.ChannelMetadata{}, errors.New("candidate release policy is not a regular file")
	}
	digest := sha256.Sum256(raw)
	if hex.EncodeToString(digest[:]) != receipt.PolicySHA256 {
		return release.ChannelMetadata{}, errors.New("candidate release policy digest differs from immutable receipt")
	}
	var policy release.ChannelMetadata
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&policy); err != nil {
		return policy, fmt.Errorf("read candidate release policy: %w", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return policy, errors.New("read candidate release policy: trailing JSON value")
	}
	if policy.Channel != receipt.Channel || policy.Sequence != receipt.Sequence || policy.BuildID != receipt.BuildID || policy.DescriptorDigest != receipt.DescriptorSHA256 || policy.Minimum > policy.Sequence {
		return policy, errors.New("candidate release policy does not bind immutable receipt")
	}
	return policy, nil
}
func previousRelease(store *release.Store, active release.Receipt) (string, error) {
	entries, err := os.ReadDir(filepath.Join(store.Home, "releases"))
	if err != nil {
		return "", err
	}
	var candidates []release.Receipt
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		r, err := readInstalledReceipt(store.Home, entry.Name())
		if err == nil && r.Channel == active.Channel && r.BuildID != active.BuildID && r.Sequence <= active.Sequence && store.Permit(r) == nil {
			candidates = append(candidates, r)
		}
	}
	if len(candidates) == 0 {
		return "", errors.New("no safe previous release is retained for rollback")
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Sequence > candidates[j].Sequence })
	return candidates[0].BuildID, nil
}

func retainReleases(store *release.Store, runtimeHome string) error {
	active, err := store.ReadActive()
	if err != nil {
		return err
	}
	keep := map[string]bool{active.Receipt.BuildID: true}
	if active.SelectorBuildID != "" {
		keep[active.SelectorBuildID] = true
	}
	if journal, err := store.ReadJournal(); err == nil {
		if journal.Old != nil {
			keep[journal.Old.BuildID] = true
		}
		if journal.Candidate != nil {
			keep[journal.Candidate.BuildID] = true
		}
	}
	if prior, err := previousRelease(store, active.Receipt); err == nil {
		keep[prior] = true
	}
	instances, _ := os.ReadDir(filepath.Join(runtimeHome, "instances"))
	for _, instance := range instances {
		backups, _ := os.ReadDir(filepath.Join(runtimeHome, "instances", instance.Name(), "backups"))
		for _, backup := range backups {
			var pair databasePair
			if decodeStrictRegular(filepath.Join(runtimeHome, "instances", instance.Name(), "backups", backup.Name(), "pair.json"), &pair) == nil && pair.ReleaseReceipt.BuildID != "" {
				keep[pair.ReleaseReceipt.BuildID] = true
			}
		}
		var state instanceState
		if decodeStrictRegular(filepath.Join(runtimeHome, "instances", instance.Name(), "state.json"), &state) == nil && stateHasLiveProcesses(state) {
			keep[state.BuildID] = true
		}
	}
	entries, err := os.ReadDir(filepath.Join(store.Home, "releases"))
	if err != nil {
		return err
	}
	deleted := false
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || keep[entry.Name()] {
			continue
		}
		receipt, err := readInstalledReceipt(store.Home, entry.Name())
		if err != nil || receipt.Channel != "stable" {
			continue
		}
		if err := os.RemoveAll(filepath.Join(store.Home, "releases", entry.Name())); err != nil {
			return err
		}
		deleted = true
	}
	if deleted {
		return syncDirectory(filepath.Join(store.Home, "releases"))
	}
	return nil
}

func uninstall(ctx launchContext, args []string, output io.Writer) error {
	releaseSelection(&ctx)
	deleteData := false
	if len(args) == 0 {
	} else if len(args) == 1 && args[0] == "--remove-data" {
		if uninstallInput == os.Stdin {
			info, err := os.Stdin.Stat()
			if err != nil || info.Mode()&os.ModeCharDevice == 0 {
				return errors.New("--remove-data requires the exact phrase from an interactive terminal; non-interactive input is refused")
			}
		}
		if _, err := fmt.Fprintf(output, "Type %s to permanently remove local JobCtrl data: ", removeDataPhrase); err != nil {
			return err
		}
		line, err := bufio.NewReader(uninstallInput).ReadString('\n')
		if err != nil && !errors.Is(err, io.EOF) {
			return fmt.Errorf("read data removal confirmation: %w", err)
		}
		if strings.TrimSuffix(strings.TrimSuffix(line, "\n"), "\r") != removeDataPhrase {
			return errors.New("local data was not removed: exact typed confirmation is required")
		}
		deleteData = true
	} else {
		return errors.New("usage: jobctrl uninstall [--remove-data]; --yes and --confirm are never accepted")
	}
	store, err := releaseStore(ctx)
	if err != nil {
		return err
	}
	transition, err := store.TransitionLock()
	if err != nil {
		return err
	}
	defer transition.Close()
	selection, err := store.SelectionLock(true)
	if err != nil {
		return err
	}
	defer selection.Close()
	if pathsOverlap(ctx.Instance.StateDir, store.Home) {
		return errors.New("refusing uninstall because JobCtrl data path overlaps the runtime store")
	}
	if err := validateManagedUninstallPaths(store.Home); err != nil {
		return err
	}
	if deleteData {
		info, stateErr := os.Lstat(ctx.Instance.StateDir)
		if stateErr != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("refusing unsafe JobCtrl data path")
		}
	}
	if err := validateCurlAcquisitionPreflight(store.Home); err != nil {
		return err
	}
	active, activeErr := store.ReadActive()
	if activeErr != nil && !errors.Is(activeErr, os.ErrNotExist) {
		return activeErr
	}
	wasRunning := false
	if state, stateErr := readState(ctx.Instance.StatePath); stateErr == nil {
		wasRunning = stateHasLiveProcesses(state)
	} else if !errors.Is(stateErr, os.ErrNotExist) {
		return stateErr
	}
	if err := stop(ctx); err != nil {
		return err
	}
	fromHomebrewFrontend := environmentMap(ctx.Environment)["JOBCTRL_HOMEBREW_FRONTEND"] == "1"
	if (activeErr == nil && active.Acquisition == "homebrew") || fromHomebrewFrontend {
		brewOutput, brewErr := homebrewCommand("uninstall", "ebarti/tap/jobctrl")
		if brewErr != nil {
			if wasRunning {
				if closeErr := selection.Close(); closeErr == nil {
					_ = startSelectedRelease(ctx)
				}
			}
			return fmt.Errorf("Homebrew acquisition uninstall failed; local data and runtime were preserved: %w: %s", brewErr, strings.TrimSpace(brewOutput))
		}
	}
	if err := removeExactCurlExposure(store.Home); err != nil {
		return err
	}
	// Keep transition/selection lock inodes and authenticated channel state in
	// place. Unlinking a held flock creates a second inode that another process
	// can lock around an in-progress uninstall; deleting revocation tombstones
	// would also make a later reinstall accept a signed downgrade.
	for _, name := range []string{"bin", "releases", "staging", "instances", release.ActiveFile, "current.json", "acquisition.json", release.JournalFile, "install.lock"} {
		path := filepath.Join(store.Home, name)
		if info, err := os.Lstat(path); err == nil && info.Mode()&os.ModeSymlink != 0 {
			return fmt.Errorf("refusing symlinked managed uninstall path %q", name)
		}
		if err := os.RemoveAll(path); err != nil {
			return err
		}
	}
	if deleteData {
		info, err := os.Lstat(ctx.Instance.StateDir)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("refusing unsafe JobCtrl data path")
		}
		if err := os.RemoveAll(ctx.Instance.StateDir); err != nil {
			return err
		}
		_, err = io.WriteString(output, "JobCtrl runtime and confirmed local data removed.\n")
		return err
	}
	_, err = io.WriteString(output, "JobCtrl runtime removed; local data and capability profiles were preserved.\n")
	return err
}

func validateManagedUninstallPaths(home string) error {
	for _, name := range []string{"bin", "releases", "staging", "instances"} {
		path := filepath.Join(home, name)
		if info, err := os.Lstat(path); err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
			return fmt.Errorf("managed uninstall path %q is not a regular directory", name)
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	for _, name := range []string{release.ActiveFile, "current.json", "acquisition.json", release.JournalFile, "install.lock"} {
		path := filepath.Join(home, name)
		if info, err := os.Lstat(path); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
			return fmt.Errorf("managed uninstall path %q is not a regular file", name)
		} else if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}

func validateCurlAcquisitionPreflight(runtimeHome string) error {
	path := filepath.Join(runtimeHome, "acquisition.json")
	var record curlAcquisitionRecord
	if err := decodeStrictRegular(path, &record); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("read curl acquisition record: %w", err)
	}
	selector := filepath.Join(runtimeHome, "bin", "jobctrl")
	if record.SchemaVersion != 1 || record.Source != "curl" || record.Selector != selector || !filepath.IsAbs(record.PublicLink) || filepath.Base(record.PublicLink) != "jobctrl" || (record.Profile == "") != (record.PathLine == "") {
		return errors.New("invalid curl acquisition record")
	}
	if record.Profile == "" {
		return nil
	}
	if !filepath.IsAbs(record.Profile) || record.PathLine != `export PATH="`+filepath.Dir(record.PublicLink)+`:$PATH" # JobCtrl managed path` {
		return errors.New("invalid curl profile ownership record")
	}
	if info, err := os.Lstat(record.Profile); err == nil && (!info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0) {
		return errors.New("curl profile is not a regular file")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func pathsOverlap(left, right string) bool {
	left, leftErr := canonicalPathForOverlap(left)
	right, rightErr := canonicalPathForOverlap(right)
	if leftErr != nil || rightErr != nil {
		return true
	}
	return pathContains(left, right) || pathContains(right, left)
}

// canonicalPathForOverlap resolves symlinks in the longest existing ancestor,
// then appends any not-yet-created suffix. This catches parent-symlink aliases
// without making an absent default JOBCTRL_DIR impossible to uninstall.
func canonicalPathForOverlap(path string) (string, error) {
	absolute, err := filepath.Abs(filepath.Clean(path))
	if err != nil {
		return "", err
	}
	probe := absolute
	suffix := make([]string, 0)
	for {
		resolved, resolveErr := filepath.EvalSymlinks(probe)
		if resolveErr == nil {
			parts := append([]string{resolved}, suffix...)
			return filepath.Clean(filepath.Join(parts...)), nil
		}
		if !errors.Is(resolveErr, os.ErrNotExist) {
			return "", resolveErr
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return "", resolveErr
		}
		suffix = append([]string{filepath.Base(probe)}, suffix...)
		probe = parent
	}
}

func pathContains(parent, child string) bool {
	relative, err := filepath.Rel(parent, child)
	if err != nil {
		return true
	}
	return relative == "." || (relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator)))
}

// removeExactCurlExposure removes only the link and profile line the curl
// script recorded. It never follows a link, never guesses a default bin dir,
// and leaves unrelated shell/profile content untouched. Homebrew has no such
// record and its Cellar/prefix remains exclusively Homebrew-owned.
func removeExactCurlExposure(runtimeHome string) error {
	path := filepath.Join(runtimeHome, "acquisition.json")
	var record curlAcquisitionRecord
	if err := decodeStrictRegular(path, &record); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return fmt.Errorf("read curl acquisition record: %w", err)
	}
	selector := filepath.Join(runtimeHome, "bin", "jobctrl")
	if record.SchemaVersion != 1 || record.Source != "curl" || record.Selector != selector || !filepath.IsAbs(record.PublicLink) || filepath.Base(record.PublicLink) != "jobctrl" || (record.Profile == "") != (record.PathLine == "") {
		return errors.New("invalid curl acquisition record")
	}
	if info, err := os.Lstat(record.PublicLink); err == nil {
		if info.Mode()&os.ModeSymlink != 0 {
			target, readErr := os.Readlink(record.PublicLink)
			if readErr != nil {
				return readErr
			}
			if target == selector {
				if err := os.Remove(record.PublicLink); err != nil {
					return err
				}
			}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if record.Profile == "" {
		return nil
	}
	if !filepath.IsAbs(record.Profile) || record.PathLine != `export PATH="`+filepath.Dir(record.PublicLink)+`:$PATH" # JobCtrl managed path` {
		return errors.New("invalid curl profile ownership record")
	}
	info, err := os.Lstat(record.Profile)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("curl profile is not a regular file")
	}
	raw, err := os.ReadFile(record.Profile)
	if err != nil {
		return err
	}
	updated := strings.ReplaceAll(string(raw), record.PathLine+"\n", "")
	if updated == string(raw) {
		updated = strings.ReplaceAll(updated, record.PathLine, "")
	}
	if updated == string(raw) {
		return nil
	}
	return writeBytesPrivateAtomic(record.Profile, []byte(updated), info.Mode().Perm())
}

func writeBytesPrivateAtomic(path string, raw []byte, mode os.FileMode) error {
	random, err := releaseRandomID()
	if err != nil {
		return err
	}
	temporary := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+random)
	file, err := os.OpenFile(temporary, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, mode)
	if err != nil {
		return err
	}
	if _, err := file.Write(raw); err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		_ = os.Remove(temporary)
		return err
	}
	if err := os.Rename(temporary, path); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return syncDirectory(filepath.Dir(path))
}

// Keep bytes imported on all supported Go versions where json decoding of
// backup fixtures is optimized through a bytes.Reader in tests.
var _ = bytes.NewReader
