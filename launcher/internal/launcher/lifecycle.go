package launcher

// This file contains the native distribution lifecycle commands. They are
// intentionally not Python fallbacks: the Python payload is application code,
// while promotion, rollback, database-pair recovery, and uninstall own the
// trusted launcher boundary.

import (
	"bufio"
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
	"reflect"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
	"github.com/ebarti/jobctrl/launcher/internal/retentionfs"
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

// refuseUncertainTransitionRollback preserves both live databases after a
// candidate may have run. Candidate-ready is included because migration
// activation can commit before the next journal write. A paired snapshot alone
// cannot prove that no independent writer committed after it was taken.
func refuseUncertainTransitionRollback(journal release.Journal, pair *databasePair) error {
	switch journal.State {
	case release.PairBackedUp, release.PolicyPending,
		release.MigrationCandidateReady, release.MigrationActivated,
		release.CandidateStarting, release.CandidateHealthy,
		release.PolicyFinalized, release.RollbackRestoring:
	default:
		return nil
	}
	if pair == nil {
		// An update may restart its predecessor before taking any pair. The
		// state machine persists BackupID before activation or candidate start,
		// and only explicit rollback records a target backup.
		if journal.Operation == "update" && journal.State == release.RollbackRestoring && journal.BackupID == "" && journal.TargetBackupID == "" && !journal.PreserveLiveOnFailure {
			return nil
		}
		return errors.New("transition may have activated a migration without a verified database pair; automatic recovery is unavailable; retain the live databases and journal")
	}
	return errors.New("transition may have activated or started a candidate; automatic recovery is unavailable; retain the live databases and journal")
}

// recoverRevokedTransitionBeforePrepare handles an interrupted security
// transition before normal selector preparation. A preservation fence always
// takes priority over automatically restoring the paired backup.
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
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return true, err
	}
	// Re-read while holding both locks so a concurrent acquisition cannot alter
	// the candidate/policy decision after our preflight.
	journal, err = store.ReadJournal()
	if err != nil || journal.Candidate == nil || journal.Old == nil || store.Permit(*journal.Old) == nil {
		return true, errors.New("security transition changed while recovery was acquiring locks")
	}
	if journal.PreserveLiveOnFailure {
		return true, errors.New("transition requires live database preservation; automatic recovery is unavailable; retain the live databases and journal")
	}
	ctx, err := transitionContextForReceipt(env, store, *journal.Candidate)
	if err != nil {
		return true, err
	}
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return true, err
	}
	if !protocolSupports(ctx.Distribution, launcherProtocol) {
		return true, fmt.Errorf("security recovery target does not support launcher protocol %d; retain the transition for a compatible recovery controller", launcherProtocol)
	}
	var pair databasePair
	if err := decodeStrictRegular(filepath.Join(ctx.Instance.StateDir, "backups", journal.BackupID, "pair.json"), &pair); err != nil || pair.ReleaseReceipt != *journal.Old {
		return true, errors.New("security transition recovery has no verified predecessor database pair")
	}
	if err := refuseUncertainTransitionRollback(journal, &pair); err != nil {
		return true, err
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
	return verifyInstalledReleaseEvidence(store, receipt, true)
}

// Retired code is authenticated historical evidence only; it is never executed.
func verifyInstalledReleaseEvidence(store *release.Store, receipt release.Receipt, forExecution bool) (verifiedRelease, error) {
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
	if forExecution {
		if err := store.Permit(receipt); err != nil {
			return verifiedRelease{}, fmt.Errorf("release is not permitted by authenticated channel policy: %w", err)
		}
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
	if err := releaseQACheckpoint(store, state); err != nil {
		return err
	}
	if transitionFailure != nil {
		if err := transitionFailure(state); err != nil {
			// An abrupt interruption models SIGKILL/power loss after the journal
			// fsync. Do not relabel it failed: the next lifecycle invocation must
			// see the durable milestone and recover from it.
			if errors.Is(err, errTransitionInterrupted) || journal.PreserveLiveOnFailure {
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
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
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
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return err
	}
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
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return err
	}
	if err := refusePendingSourceMigration(ctx); err != nil {
		return err
	}
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return err
	}
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return err
	}
	if temporal != filepath.Join(ctx.Instance.StateDir, "temporal.db") {
		return errors.New("paired rollback is unavailable for a legacy source Temporal history; preserve the workspace and backup")
	}
	// A transition can be created while this rollback waits for the locks.
	// Never replace a live preservation fence with a new rollback journal.
	if existing, journalErr := store.ReadJournal(); journalErr == nil && existing.Resumable() {
		return fmt.Errorf("unfinished %s transition at %s must be recovered before another rollback", existing.Operation, existing.State)
	} else if journalErr != nil && !errors.Is(journalErr, os.ErrNotExist) {
		return fmt.Errorf("read existing release transition journal: %w", journalErr)
	}
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
	if !protocolSupports(activeVerified.distribution, launcherProtocol) || !protocolSupports(targetVerified.distribution, launcherProtocol) {
		return fmt.Errorf("current launcher protocol %d cannot supervise both active and rollback payloads; keep the current release; cross-schema rollback is unavailable", launcherProtocol)
	}
	targetPair, err := retainedPairForReceipt(ctx.Instance.StateDir, target)
	if err != nil {
		// Older forward controllers labeled their first schema-15 snapshot
		// with the candidate receipt. Only the completed transition's original
		// journal and both signed schema contracts can establish its source.
		journal, journalErr := store.ReadJournal()
		if journalErr != nil {
			return fmt.Errorf("rollback requires a verified paired backup for %s: %w", target.BuildID, err)
		}
		compatible, compatibilityErr := compatibleForwardRollbackPair(ctx, journal, active, activeVerified, targetVerified)
		if compatibilityErr != nil {
			return fmt.Errorf("rollback requires a verified paired backup for %s: %w", target.BuildID, err)
		}
		targetPair = compatible
	}
	journal, err := store.Begin("rollback", &active.Receipt, &target, target.DescriptorSHA256)
	if err != nil {
		return err
	}
	journal.TargetBackupID = targetPair.ID
	if err := advance(store, &journal, release.MetadataVerified); err != nil {
		return err
	}
	// Keep the compatible current selector: immutable older launchers may not
	// support journal-authorized startup or the current recovery protocol.
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
	// A failed target start must not restore this snapshot over later writes.
	// The user's requested target restore is still performed below.
	journal.PreserveLiveOnFailure = true
	if err := advance(store, &journal, release.PairBackedUp); err != nil {
		return err
	}
	fail := func(cause error) error {
		return fmt.Errorf("%w; rollback may have changed the live pair or received later commits; automatic recovery is unavailable; retain the live databases and transition journal", cause)
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
	if _, err := store.WriteSelectedActive(target, active.Generation, active.SelectorBuildID, active.Acquisition); err != nil {
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
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return false, err
	}
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
	// Never advance the journal, restore a pair, or restart an older release
	// while a fresh database publication remains unresolved.
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return false, err
	}
	if journal.PreserveLiveOnFailure {
		return false, errors.New("transition requires live database preservation; automatic recovery is unavailable; retain the live databases and journal")
	}
	if journal.Old == nil {
		return false, errors.New("unfinished transition has no prior release receipt")
	}
	// Recovery must not restore over an unresolved publication or restart a
	// predecessor that may not implement the initialization admission check.
	// The check itself does not open SQLite or alter any companions.
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return false, fmt.Errorf("inspect database before transition recovery: %w", err)
	}
	// Check the durable milestone before mutating the journal, even if policy
	// now revokes the predecessor. Activation can complete before its next
	// milestone is persisted, so candidate-ready is already ambiguous.
	var recoveryAdmissionPair *databasePair
	if journal.BackupID != "" {
		var pair databasePair
		if err := decodeStrictRegular(filepath.Join(ctx.Instance.StateDir, "backups", journal.BackupID, "pair.json"), &pair); err != nil || pair.ReleaseReceipt != *journal.Old {
			return false, errors.New("interrupted transition has no verified predecessor database pair")
		}
		recoveryAdmissionPair = &pair
	}
	if err := refuseUncertainTransitionRollback(journal, recoveryAdmissionPair); err != nil {
		return false, err
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
	// Before changing the journal or restoring either database, establish that
	// this controller can start the historical target after recovery. A target's
	// own launcher protocol is insufficient: this process writes v2 journals.
	target, err := verifyInstalledReleaseForExecution(store, *journal.Old)
	if err != nil {
		return false, fmt.Errorf("verify interrupted transition recovery target: %w", err)
	}
	if !protocolSupports(target.distribution, launcherProtocol) {
		return false, fmt.Errorf("interrupted transition recovery target does not support launcher protocol %d; retain the transition for a compatible recovery controller", launcherProtocol)
	}
	var recoveryPair *databasePair
	preserveUnactivatedSource := false
	if journal.BackupID != "" {
		var pair databasePair
		if err := decodeStrictRegular(filepath.Join(ctx.Instance.StateDir, "backups", journal.BackupID, "pair.json"), &pair); err != nil {
			return false, fmt.Errorf("read interrupted transition database pair: %w", err)
		}
		if pair.ReleaseReceipt != *journal.Old {
			return false, errors.New("interrupted transition backup does not bind the prior release")
		}
		recoveryPair = &pair
		intent, legacyIntent, err := readMigrationSourcePreservation(ctx.Instance.StateDir, journal.ID)
		if err != nil {
			return false, err
		}
		sourceVersion, sourceErr := pairedV15SourceSchemaVersion(pair)
		if intent != nil && (sourceErr != nil || intent.BackupID != pair.ID || intent.SourceVersion != sourceVersion) {
			return false, errors.New("v12 source preservation intent does not bind the paired backup")
		}
		// These are every durable phase after paired backup and before activation.
		preactivation := journal.State == release.PairBackedUp || journal.State == release.PolicyPending || journal.State == release.MigrationCandidateReady
		if sourceErr == nil && (preactivation || intent != nil) {
			python := filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
			liveVersion, liveErr := sqliteUserVersion(python, filepath.Join(ctx.Instance.StateDir, "jobctrl.db"))
			if errors.Is(liveErr, errUnresolvedDatabasePublication) {
				return false, liveErr
			}
			preserveUnactivatedSource = liveErr == nil && liveVersion == sourceVersion
			if intent != nil && !preserveUnactivatedSource {
				return false, errV15SourceChanged
			}
			if preserveUnactivatedSource && !legacyIntent {
				if err := writeV15SourcePreservation(ctx.Instance.StateDir, journal.ID, pair.ID, sourceVersion); err != nil {
					return false, err
				}
			}
		}
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
	cleanupV9Candidate(ctx.Instance.StateDir, journal.ID)
	cleanupV10Candidate(ctx.Instance.StateDir, journal.ID)
	cleanupV11Candidate(ctx.Instance.StateDir, journal.ID)
	cleanupV14Candidate(ctx.Instance.StateDir, journal.ID)
	cleanupV15Candidate(ctx.Instance.StateDir, journal.ID)
	if recoveryPair != nil && !preserveUnactivatedSource {
		if err := restorePair(ctx, *recoveryPair); err != nil {
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
	if selectorMatchesRelease(store, selector, active.SelectorBuildID) {
		selectorBuild = active.SelectorBuildID
	} else if selectorMatchesRelease(store, selector, journal.Old.BuildID) {
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
	if err := clearV14SourcePreservation(ctx.Instance.StateDir, journal.ID); err != nil {
		return true, err
	}
	if err := clearV15SourcePreservation(ctx.Instance.StateDir, journal.ID); err != nil {
		return true, err
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
	if err := refusePendingSourceMigration(ctx); err != nil {
		return err
	}
	if operation == "update" {
		if handled, err := promoteForwardUpdate(ctx, build, environmentMap(ctx.Environment)["JOBCTRL_ACQUISITION_SOURCE"], output); handled {
			return err
		}
	}
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
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return err
	}
	if err := refusePendingSourceMigration(ctx); err != nil {
		return err
	}
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return err
	}
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return err
	}
	if temporal != filepath.Join(ctx.Instance.StateDir, "temporal.db") {
		return errors.New("legacy source history requires an authenticated forward update; paired rollback is unavailable")
	}
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
			return fmt.Errorf("candidate launcher protocol %d cannot supervise both active and candidate payloads; use the new authenticated installer", candidateProtocol)
		}
	}
	unused, err := unusedDatabasePair(ctx.Instance.StateDir)
	if err != nil {
		return err
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
		if errors.Is(cause, errInitializationNotAdmitted) {
			return cause
		}
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
	if unused {
		if err := advance(store, &journal, release.RollbackRestoring); err != nil {
			return err
		}
		if err := startReleaseCommand(ctx, active.Receipt, journal.ID); err != nil {
			return fmt.Errorf("initialize unused predecessor before paired backup: %w; run `jobctrl rollback` to recover", err)
		}
		if err := stop(ctx); err != nil {
			return fmt.Errorf("quiesce initialized predecessor: %w", err)
		}
		if stillUnused, err := unusedDatabasePair(ctx.Instance.StateDir); err != nil || stillUnused {
			return errors.New("predecessor did not initialize a complete database pair; preserve the journal for recovery")
		}
		if err := advance(store, &journal, release.Quiescing); err != nil {
			return err
		}
	}
	databaseVersion, err := jobCtrlSchemaVersion(activeRuntime)
	if err != nil {
		if errors.Is(err, errUnresolvedDatabasePublication) {
			return err
		}
		return restartBeforeBackup(fmt.Errorf("read stopped JobCtrl schema before update: %w", err))
	}
	switch databaseVersion {
	case legacyJobCtrlSchemaVersion:
		if err := temporalQuiescenceProof(activeRuntime, candidateRuntime); err != nil {
			return restartBeforeBackup(fmt.Errorf("v6-to-v10 upgrade blocked before backup: %w", err))
		}
	case exactJobCtrlSchemaVersion:
		// Exact v7 upgrades retain the private v8 step before the additive v9 step.
	case previousJobCtrlSchemaVersion:
		// Exact v8 upgrades pass through private v9 before v10.
	case v9JobCtrlSchemaVersion:
		// Exact v9 upgrades transfer URL authority after the paired backup.
	case v10JobCtrlSchemaVersion:
		// Exact v10 upgrades move global LLM spend into the legacy lane.
	case v11JobCtrlSchemaVersion:
		// Exact v11 upgrades add generation bindings and independently revisioned notes.
	case v12JobCtrlSchemaVersion:
		// Exact v12 is migrated to cited semantic determinations.
	case v13JobCtrlSchemaVersion:
		// Exact v13 requires the saved-settings authority cutover.
	case v14JobCtrlSchemaVersion:
		// Exact v14 receives the lifecycle-generation migration after backup.
	case currentJobCtrlSchemaVersion:
		// Ordinary exact-v15 release promotion uses the paired lifecycle unchanged.
	default:
		return restartBeforeBackup(fmt.Errorf("unsupported stopped JobCtrl schema version %d", databaseVersion))
	}
	pair, err := snapshotPair(ctx, active.Receipt)
	if err != nil {
		if errors.Is(err, errUnresolvedDatabasePublication) {
			return err
		}
		if databaseVersion != currentJobCtrlSchemaVersion {
			return restartBeforeBackup(fmt.Errorf("create paired pre-upgrade backup: %w", err))
		}
		_ = store.Advance(&journal, release.Failed, err)
		return err
	}
	journal.BackupID = pair.ID
	// Once a snapshot exists, independent commits may make it stale. Persist
	// this fence before any later milestone can activate or start a candidate.
	journal.PreserveLiveOnFailure = true
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
		return fmt.Errorf("%w; a paired backup may no longer include later commits; automatic recovery is unavailable; retain the live databases and transition journal", cause)
	}
	if databaseVersion != currentJobCtrlSchemaVersion {
		candidatePath, err := sealedV7CandidateBuilder(candidateRuntime, pair, journal.ID)
		if err != nil {
			return rollbackFailure(fmt.Errorf("build exact-v15 migration candidate: %w", err))
		}
		if err := advance(store, &journal, release.MigrationCandidateReady); err != nil {
			return rollbackFailure(err)
		}
		if err := sealedV7CandidateInstaller(candidateRuntime, candidatePath); err != nil {
			return rollbackFailure(fmt.Errorf("activate exact-v15 database: %w", err))
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
	// the predecessor. Commit it only after real readiness succeeds. Earlier
	// failures retain the live pair and journal for explicit recovery.
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
	if err := retainReleases(store, ctx.Instance.StateDir); err != nil {
		return fmt.Errorf("JobCtrl %s is active, but release retention did not complete: %w", candidate.BuildID, err)
	}
	_, err = fmt.Fprintf(output, "JobCtrl %s is active.\n", candidate.BuildID)
	return err
}

func startRelease(ctx launchContext, receipt release.Receipt, journalID string) error {
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return fmt.Errorf("refuse release startup: %w", err)
	}
	store, err := releaseStore(ctx)
	if err != nil {
		return err
	}
	verified, err := verifyInstalledReleaseForExecution(store, receipt)
	if err != nil {
		return fmt.Errorf("verify release immediately before execution: %w", err)
	}
	path := filepath.Join(store.Home, "bin", "jobctrl")
	controller := selectorSupportsJournalStartup(store, path)
	if !controller {
		path = filepath.Join(verified.payloadRoot, "launcher", "jobctrl")
	}
	cmd := exec.Command(path, "start", "--no-open")
	cmd.Env = append(append([]string{}, ctx.Environment...), "JOBCTRL_TRANSITION_CANDIDATE=1")
	if journalID != "" {
		cmd.Env = append(cmd.Env, "JOBCTRL_TRANSITION_JOURNAL="+journalID)
		if controller {
			cmd.Env = append(cmd.Env, "JOBCTRL_TRANSITION_TARGET="+receipt.BuildID)
		}
	}
	if controller {
		if _, _, err := transitionSelectorPayload(path, cmd.Env); err != nil {
			return fmt.Errorf("verify transition controller immediately before execution: %w", err)
		}
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}

func backup(ctx launchContext, args []string, output io.Writer) error {
	if err := refusePendingSourceMigration(ctx); err != nil {
		return err
	}
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
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
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
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return err
	}
	if err := refusePendingSourceMigration(ctx); err != nil {
		return err
	}
	if err := refuseBackupOfRunningSource(ctx); err != nil {
		return err
	}
	if existing, journalErr := store.ReadJournal(); journalErr == nil && existing.Resumable() {
		return fmt.Errorf("unfinished %s transition at %s must be recovered before backup", existing.Operation, existing.State)
	} else if journalErr != nil && !errors.Is(journalErr, os.ErrNotExist) {
		return fmt.Errorf("read existing release transition journal: %w", journalErr)
	}
	if err := ensureSafeDirectory(directory); err != nil {
		return err
	}
	active, err := store.ReadActive()
	if err != nil {
		return err
	}
	ctx, err = rebindActiveContext(ctx, active.Receipt.BuildID)
	if err != nil {
		return err
	}
	if err := requireLegacySourceOwnership(ctx); err != nil {
		return err
	}
	defer func() { _ = ctx.selection.Close() }()
	wasRunning := false
	if state, stateErr := readState(ctx.Instance.StatePath); stateErr == nil {
		wasRunning = stateHasLiveProcesses(state)
	} else if !errors.Is(stateErr, os.ErrNotExist) {
		return stateErr
	}
	if err := stop(ctx); err != nil {
		return fmt.Errorf("quiesce runtime for coherent paired backup: %w", err)
	}
	pair, err := snapshotPairTo(ctx, active.Receipt, directory)
	if errors.Is(err, errUnresolvedDatabasePublication) {
		return err
	}
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
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return err
	}
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
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return databasePair{}, err
	}
	if err := requireLegacySourceOwnership(ctx); err != nil {
		return databasePair{}, err
	}
	if err := refuseOpenWorkspaceDatabases(filepath.Join(ctx.Instance.StateDir, "jobctrl.db"), temporal); err != nil {
		return databasePair{}, err
	}
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
		if name == "temporal.db" {
			source = temporal
		}
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
	if selected, err := temporalHistoryPath(ctx.Instance.StateDir); err != nil || selected != temporal {
		return databasePair{}, errors.New("Temporal history identity changed during backup; preserve the workspace")
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
	if err := checkDatabasePublication(source); err != nil {
		return 0, err
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
	if err := refusePendingSourceMigration(ctx); err != nil {
		return err
	}
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return fmt.Errorf("refuse paired restore: %w", err)
	}
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return err
	}
	if temporal != filepath.Join(ctx.Instance.StateDir, "temporal.db") {
		return errors.New("automatic paired restore is unavailable for a legacy source Temporal history; preserve the workspace and backup")
	}
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
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return err
	}
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
	return releaseFromSelectorReceipt(receipt)
}

func releaseFromSelectorReceipt(receipt selectorReceipt) (release.Receipt, error) {
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
		if err == nil && r.BuildID == entry.Name() && r.Channel == active.Channel && r.BuildID != active.BuildID && r.Sequence <= active.Sequence && store.Permit(r) == nil {
			candidates = append(candidates, r)
		}
	}
	if len(candidates) == 0 {
		return "", errors.New("no safe previous release is retained for rollback")
	}
	sort.Slice(candidates, func(i, j int) bool { return candidates[i].Sequence > candidates[j].Sequence })
	return candidates[0].BuildID, nil
}

// retainReleases runs under the lifecycle transition and exclusive selection
// locks. Collect every reference before deleting any owned stable release.
func retainReleases(store *release.Store, stateDir string) error {
	homeIdentity, releasesIdentity := store.RetentionIdentities()
	root, err := retentionfs.Open(store.Home, homeIdentity, releasesIdentity)
	if err != nil {
		return fmt.Errorf("open release retention authority: %w", err)
	}
	defer root.Close()
	references := &retentionReferenceAuthority{}
	defer references.close()
	runtimeRoot, err := references.open(store.Home)
	if err != nil {
		return fmt.Errorf("open runtime authority for release retention: %w", err)
	}
	var observedActive release.Active
	if err := references.readRootJSON(runtimeRoot, release.ActiveFile, &observedActive); err != nil {
		return fmt.Errorf("read active authority for release retention: %w", err)
	}
	active, err := store.ReadActive()
	if err != nil {
		return err
	}
	if active != observedActive {
		return errors.New("active release authority changed during retention")
	}
	if !buildIDPattern.MatchString(active.Receipt.BuildID) || !buildIDPattern.MatchString(active.SelectorBuildID) {
		return errors.New("invalid active release or controller identity")
	}
	keep := map[string]bool{active.Receipt.BuildID: true}
	if active.SelectorBuildID != "" {
		keep[active.SelectorBuildID] = true
	}
	var observedJournal release.Journal
	journalErr := references.readRootJSON(runtimeRoot, release.JournalFile, &observedJournal)
	if journalErr != nil && !errors.Is(journalErr, os.ErrNotExist) {
		return fmt.Errorf("read transition journal for release retention: %w", journalErr)
	}
	if journal, err := store.ReadJournal(); err == nil {
		if journalErr != nil || !reflect.DeepEqual(journal, observedJournal) {
			return errors.New("transition journal authority changed during retention")
		}
		if journal.Old != nil {
			if !journal.Old.Valid() || !buildIDPattern.MatchString(journal.Old.BuildID) {
				return errors.New("invalid prior release in transition journal")
			}
			keep[journal.Old.BuildID] = true
		}
		if journal.Candidate != nil {
			if !journal.Candidate.Valid() || !buildIDPattern.MatchString(journal.Candidate.BuildID) {
				return errors.New("invalid candidate release in transition journal")
			}
			keep[journal.Candidate.BuildID] = true
		}
	} else if !errors.Is(err, os.ErrNotExist) || journalErr == nil {
		return fmt.Errorf("read transition journal for release retention: %w", err)
	}
	var observedPolicy release.ChannelState
	policyPath := filepath.Join(store.Home, "channel-"+active.Receipt.Channel+".json")
	policyErr := references.readRootJSON(runtimeRoot, "channel-"+active.Receipt.Channel+".json", &observedPolicy)
	if policyErr != nil && !errors.Is(policyErr, os.ErrNotExist) {
		return fmt.Errorf("read channel policy for release retention: %w", policyErr)
	}
	policy, err := store.ReadChannelState(active.Receipt.Channel)
	if err != nil {
		return fmt.Errorf("read channel policy for release retention: %w", err)
	}
	if policyErr == nil && !reflect.DeepEqual(policy, observedPolicy) {
		return errors.New("channel policy authority changed during retention")
	}
	if errors.Is(policyErr, os.ErrNotExist) {
		if _, err := os.Lstat(policyPath); !errors.Is(err, os.ErrNotExist) {
			return errors.New("channel policy authority changed during retention")
		}
	}
	if err := collectRetentionWorkspaceReferences(references, root, runtimeRoot, store.Home, stateDir, keep); err != nil {
		return err
	}
	if afterRetentionReferenceCollection != nil {
		afterRetentionReferenceCollection()
	}
	if err := references.validate(); err != nil {
		return err
	}
	entries, err := root.Entries()
	if err != nil {
		return err
	}
	type retentionCandidate struct {
		entry     retentionfs.Entry
		receipt   release.Receipt
		raw       []byte
		inventory retentionfs.Inventory
	}
	var candidates []retentionCandidate
	for _, entry := range entries {
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 || !buildIDPattern.MatchString(entry.Name()) {
			continue
		}
		raw, observed, err := root.ReadReceipt(entry.Name())
		if errors.Is(err, retentionfs.ErrChanged) {
			return err
		}
		if err != nil {
			continue
		}
		var encoded selectorReceipt
		if err := decodeRetentionJSON(raw, &encoded); err != nil {
			continue
		}
		receipt, err := releaseFromSelectorReceipt(encoded)
		if err != nil || receipt.BuildID != entry.Name() {
			continue
		}
		candidates = append(candidates, retentionCandidate{entry: observed, receipt: receipt, raw: raw})
	}
	if err := root.Validate(); err != nil {
		return err
	}
	// A parseable receipt alone must not displace an intact signed prior
	// release. Authenticate candidate trees before selecting that prior.
	var prior *release.Receipt
	for i := range candidates {
		candidate := &candidates[i]
		if candidate.receipt.Channel != "stable" || candidate.entry.Name == active.Receipt.BuildID {
			continue
		}
		// The manifest signs the build, but not the local receipt's sequence.
		// Only a sequence already bound by channel state can order candidates
		// or authorize pruning. Preserve releases without that history.
		key := fmt.Sprintf("%d", candidate.receipt.Sequence)
		if policy.Channel != candidate.receipt.Channel || policy.SequenceBuildIDs[key] != candidate.receipt.BuildID || policy.SequenceDescriptors[key] != candidate.receipt.DescriptorSHA256 {
			continue
		}
		inventory, err := retentionReleaseInventory(root, candidate.entry, candidate.receipt, candidate.raw)
		if err != nil {
			if errors.Is(err, retentionfs.ErrChanged) {
				return err
			}
			continue
		}
		if err := root.VerifyEntry(candidate.entry, inventory); err != nil {
			if errors.Is(err, retentionfs.ErrChanged) {
				return err
			}
			// Preserve unfamiliar or modified files, including empty directories.
			continue
		}
		candidate.inventory = inventory
		receipt := candidate.receipt
		if receipt.Channel == active.Receipt.Channel && receipt.Sequence <= active.Receipt.Sequence && policy.Permit(receipt) == nil && (prior == nil || receipt.Sequence > prior.Sequence || (receipt.Sequence == prior.Sequence && receipt.BuildID < prior.BuildID)) {
			candidateReceipt := receipt
			prior = &candidateReceipt
		}
	}
	if prior != nil {
		keep[prior.BuildID] = true
	}
	for _, candidate := range candidates {
		if keep[candidate.entry.Name] || candidate.inventory == nil {
			continue
		}
		if err := references.validate(); err != nil {
			return err
		}
		claim, err := root.Claim(candidate.entry)
		if err != nil {
			return err
		}
		if err := claim.Remove(candidate.inventory, references.validate); err != nil {
			return err
		}
	}
	return root.Validate()
}

func retentionReleaseInventory(root *retentionfs.Root, entry retentionfs.Entry, receipt release.Receipt, receiptRaw []byte) (retentionfs.Inventory, error) {
	manifestRaw, err := root.ReadFile(entry, "payload/manifest.json", 64<<20)
	if err != nil {
		return nil, err
	}
	signatureRaw, err := root.ReadFile(entry, "payload/manifest.sig", 1<<20)
	if err != nil {
		return nil, err
	}
	digest := func(raw []byte) string {
		sum := sha256.Sum256(raw)
		return hex.EncodeToString(sum[:])
	}
	if digest(manifestRaw) != receipt.ManifestSHA256 {
		return nil, errors.New("release manifest differs from its receipt")
	}
	// Decode the same anchored bytes whose signature is checked below.
	var distribution distributionManifest
	if err := decodeRetentionJSON(manifestRaw, &distribution); err != nil {
		return nil, err
	}
	if err := validateDistributionManifestShape(manifestRaw, distribution); err != nil {
		return nil, err
	}
	if distribution.BuildID != receipt.BuildID || distribution.ReleaseChannel != receipt.Channel {
		return nil, errors.New("release manifest does not match its receipt")
	}
	var signature manifestSignature
	if err := decodeRetentionJSON(signatureRaw, &signature); err != nil {
		return nil, err
	}
	if err := validateManifestSignatureShape(signatureRaw, signature, distribution); err != nil {
		return nil, err
	}
	key, ok := embeddedReleaseTrust()[signature.ManifestKeyID]
	if !ok || signature.Signature == nil {
		return nil, errors.New("release signature has no trusted key")
	}
	signed, err := base64.StdEncoding.DecodeString(*signature.Signature)
	if err != nil || !ed25519.Verify(key, signedMessage("jobctrl:manifest:v1\x00", manifestRaw), signed) {
		return nil, errors.New("release signature does not authenticate the retained manifest")
	}
	inventory := retentionfs.Inventory{
		"receipt.json":          {Type: "file", SHA256: digest(receiptRaw), SizeBytes: int64(len(receiptRaw))},
		"payload/manifest.json": {Type: "file", SHA256: receipt.ManifestSHA256, SizeBytes: int64(len(manifestRaw))},
		"payload/manifest.sig":  {Type: "file", SHA256: digest(signatureRaw), SizeBytes: int64(len(signatureRaw))},
	}
	if receipt.SchemaVersion == 2 {
		policyRaw, err := root.ReadFile(entry, "policy.json", 1<<20)
		if err != nil {
			return nil, err
		}
		var policy release.ChannelMetadata
		if digest(policyRaw) != receipt.PolicySHA256 || decodeRetentionJSON(policyRaw, &policy) != nil || policy.Channel != receipt.Channel || policy.Sequence != receipt.Sequence || policy.BuildID != receipt.BuildID || policy.DescriptorDigest != receipt.DescriptorSHA256 || policy.Minimum > policy.Sequence {
			return nil, errors.New("release policy does not match its receipt")
		}
		inventory["policy.json"] = retentionfs.Item{Type: "file", SHA256: receipt.PolicySHA256, SizeBytes: int64(len(policyRaw))}
	}
	for _, file := range distribution.Files {
		name := "payload/" + file.Path
		if _, exists := inventory[name]; exists {
			return nil, errors.New("release manifest overlaps its evidence envelope")
		}
		item := retentionfs.Item{Type: file.Type, SHA256: file.SHA256, SizeBytes: file.SizeBytes, Target: file.Target}
		if file.Type == "file" {
			item.CheckMode = true
			if file.Mode == "0755" {
				item.Mode = 0o755
			} else {
				item.Mode = 0o644
			}
		}
		inventory[name] = item
	}
	return inventory, nil
}

// The current workspace is resolved at command entry. Other managed instance
// directories can be mapped back only through their own valid runtime state.
// If that authority is unavailable, no release is safe to prune.
func collectRetentionWorkspaceReferences(authority *retentionReferenceAuthority, root *retentionfs.Root, runtimeRoot *os.Root, runtimeHome, stateDir string, keep map[string]bool) error {
	if !filepath.IsAbs(stateDir) {
		return errors.New("workspace path for release retention is not absolute")
	}
	current, err := filepath.EvalSymlinks(stateDir)
	if err != nil {
		return fmt.Errorf("resolve workspace for release retention: %w", err)
	}
	if err := collectBackupReleaseReferences(authority, current, keep); err != nil {
		return err
	}
	currentHash := sha256.Sum256([]byte(current))
	currentID := hex.EncodeToString(currentHash[:])
	instanceRoot, err := authority.openDirectory(runtimeRoot, "instances")
	if err != nil {
		return fmt.Errorf("read instance authorities for release retention: %w", err)
	}
	authority.hold(instanceRoot)
	instances, err := authority.entries(instanceRoot, "instances")
	if err != nil {
		return fmt.Errorf("list instance authorities for release retention: %w", err)
	}
	foundCurrent := false
	for _, entry := range instances {
		// Other names are foreign to resolveInstance's SHA-256 namespace.
		if !sha256Pattern.MatchString(entry.Name()) {
			continue
		}
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("instance %s is not a regular directory", entry.Name())
		}
		if entry.Name() == currentID {
			foundCurrent = true
		}
		var state instanceState
		if err := authority.readJSON(instanceRoot, entry.Name(), "state.json", &state); err != nil {
			if errors.Is(err, os.ErrNotExist) && entry.Name() == currentID {
				// An independent Apply can have an execution receipt before the
				// workspace has ever published a supervisor registry.
				if err := verifyRetentionInstalledApplyAuthority(authority, instanceRoot, entry.Name(), runtimeHome, current); err != nil {
					return fmt.Errorf("instance %s Apply authority cannot be verified: %w", entry.Name(), err)
				}
				continue // The resolved current workspace is already authoritative.
			}
			return fmt.Errorf("read instance authority %s for release retention: %w", entry.Name(), err)
		}
		if err := validateRuntimeState(state); err != nil {
			return fmt.Errorf("validate instance authority %s: %w", entry.Name(), err)
		}
		if !filepath.IsAbs(state.CanonicalStateDir) || filepath.Clean(state.CanonicalStateDir) != state.CanonicalStateDir || (state.BuildID != "source" && !buildIDPattern.MatchString(state.BuildID)) {
			return fmt.Errorf("invalid workspace or release identity for instance %s", entry.Name())
		}
		id := sha256.Sum256([]byte(state.CanonicalStateDir))
		canonical, err := filepath.EvalSymlinks(state.CanonicalStateDir)
		if err != nil || canonical != state.CanonicalStateDir || state.InstanceID != entry.Name() || hex.EncodeToString(id[:]) != entry.Name() {
			return fmt.Errorf("workspace authority for instance %s cannot be verified", entry.Name())
		}
		if state.BuildID == "source" {
			if err := verifyRetentionSourceAuthority(authority, instanceRoot, entry.Name(), runtimeHome, state); err != nil {
				return fmt.Errorf("source instance %s authority cannot be verified: %w", entry.Name(), err)
			}
		} else {
			if err := verifyRetentionInstalledApplyAuthority(authority, instanceRoot, entry.Name(), runtimeHome, state.CanonicalStateDir); err != nil {
				return fmt.Errorf("instance %s Apply authority cannot be verified: %w", entry.Name(), err)
			}
			if stateHasLiveProcesses(state) {
				if err := validateRetentionLiveRelease(root, runtimeHome, state); err != nil {
					return fmt.Errorf("live instance %s release authority cannot be verified: %w", entry.Name(), err)
				}
				keep[state.BuildID] = true
			}
		}
		if state.CanonicalStateDir != current {
			if err := collectBackupReleaseReferences(authority, state.CanonicalStateDir, keep); err != nil {
				return err
			}
		}
	}
	if !foundCurrent {
		return errors.New("resolved workspace instance authority is missing")
	}
	return nil
}

func validateRetentionLiveRelease(root *retentionfs.Root, runtimeHome string, state instanceState) error {
	expected := filepath.Join(runtimeHome, "releases", state.BuildID, "payload")
	if !filepath.IsAbs(state.PayloadRoot) || filepath.Clean(state.PayloadRoot) != expected {
		return errors.New("recorded payload path does not match its build")
	}
	raw, _, err := root.ReadReceipt(state.BuildID)
	if err != nil {
		return err
	}
	var encoded selectorReceipt
	if err := decodeRetentionJSON(raw, &encoded); err != nil {
		return err
	}
	receipt, err := releaseFromSelectorReceipt(encoded)
	if err != nil || receipt.BuildID != state.BuildID || receipt.ManifestSHA256 != state.ManifestSHA256 {
		return errors.New("recorded live release does not match its installed receipt")
	}
	return nil
}

func collectBackupReleaseReferences(authority *retentionReferenceAuthority, stateDir string, keep map[string]bool) error {
	stateRoot, err := authority.open(stateDir)
	if err != nil {
		return fmt.Errorf("open workspace for release retention: %w", err)
	}
	backupRoot, err := authority.openDirectory(stateRoot, "backups")
	if errors.Is(err, os.ErrNotExist) {
		authority.watchAbsent(stateRoot, "backups")
		return nil
	}
	if err != nil {
		return fmt.Errorf("read workspace backup references for release retention: %w", err)
	}
	authority.hold(backupRoot)
	entries, err := authority.entries(backupRoot, "backups")
	if err != nil {
		return fmt.Errorf("list workspace backup references for release retention: %w", err)
	}
	for _, entry := range entries {
		nativeName := strings.HasPrefix(entry.Name(), "pair-")
		if !entry.IsDir() || entry.Type()&os.ModeSymlink != 0 {
			if nativeName {
				return fmt.Errorf("backup pair %s is not a regular directory", entry.Name())
			}
			continue
		}
		var pair databasePair
		if err := authority.readJSON(backupRoot, entry.Name(), "pair.json", &pair); err != nil {
			if errors.Is(err, os.ErrNotExist) && !nativeName {
				// A foreign directory is not a reference unless pair.json exists.
				// readJSON watches both the directory and the absent metadata.
				continue
			}
			return fmt.Errorf("read backup reference %s: %w", entry.Name(), err)
		}
		if pair.SchemaVersion != 1 || !filepath.IsLocal(pair.ID) || pair.CreatedAt.IsZero() || !pair.ReleaseReceipt.Valid() || !buildIDPattern.MatchString(pair.ReleaseReceipt.BuildID) || len(pair.Files) != 2 {
			return fmt.Errorf("invalid backup reference %s", entry.Name())
		}
		files := map[string]bool{}
		for _, file := range pair.Files {
			if (file.Name != "jobctrl.db" && file.Name != "temporal.db") || files[file.Name] || !sha256Pattern.MatchString(file.SHA256) || file.SizeBytes <= 0 || file.SQLiteUserVer < 0 {
				return fmt.Errorf("invalid backup reference %s", entry.Name())
			}
			files[file.Name] = true
		}
		// Rollback reads metadata from any backup directory but restores from
		// pair.ID, which can identify a different directory. Keep that target
		// under the same no-symlink, change-detection authority before pruning.
		if pair.ID != entry.Name() {
			if err := authority.watchDirectoryPath(backupRoot, pair.ID); err != nil {
				return fmt.Errorf("backup reference %s target is unverifiable: %w", entry.Name(), err)
			}
		}
		keep[pair.ReleaseReceipt.BuildID] = true
	}
	return nil
}

func decodeRetentionJSON(raw []byte, destination any) error {
	keys := json.NewDecoder(bytes.NewReader(raw))
	if err := rejectDuplicateRetentionKeys(keys); err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("trailing JSON value")
	}
	return nil
}

func rejectDuplicateRetentionKeys(decoder *json.Decoder) error {
	token, err := decoder.Token()
	if err != nil {
		return err
	}
	delimiter, ok := token.(json.Delim)
	if !ok {
		return nil
	}
	switch delimiter {
	case '{':
		seen := map[string]bool{}
		for decoder.More() {
			key, err := decoder.Token()
			if err != nil {
				return err
			}
			name, ok := key.(string)
			// encoding/json matches struct keys case-insensitively, so differently
			// cased spellings must not provide competing authorities either.
			name = strings.ToLower(name)
			if !ok || seen[name] {
				return errors.New("duplicate or invalid reference metadata key")
			}
			seen[name] = true
			if err := rejectDuplicateRetentionKeys(decoder); err != nil {
				return err
			}
		}
	case '[':
		for decoder.More() {
			if err := rejectDuplicateRetentionKeys(decoder); err != nil {
				return err
			}
		}
	default:
		return errors.New("invalid reference metadata JSON")
	}
	_, err = decoder.Token()
	return err
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
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return err
	}
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
