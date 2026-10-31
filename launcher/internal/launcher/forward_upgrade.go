package launcher

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// A protocol-2 installer can migrate an authenticated protocol-1 workspace
// after verified cleanup without ever executing or delegating recovery to old code.
// The old controller cannot admit the protocol-2 target before its own backup.
// The same forward-only path handles later signed protocol-2 updates.
func promoteForwardUpdate(ctx launchContext, build, source string, output io.Writer) (bool, error) {
	store, err := releaseStore(ctx)
	if err != nil {
		return false, err
	}
	candidate, err := readInstalledReceipt(store.Home, build)
	if err != nil || candidate.Channel == "local" {
		return false, nil
	}
	verifiedCandidate, err := verifyInstalledReleaseForExecution(store, candidate)
	if err != nil {
		return true, fmt.Errorf("authenticate forward update target: %w", err)
	}
	if verifiedCandidate.runtime.LauncherProtocol != 2 || !protocolSupports(verifiedCandidate.distribution, launcherProtocol) {
		return false, nil
	}
	if _, err := readBridgeSchemaContract(verifiedCandidate, 14); err != nil {
		return true, fmt.Errorf("authenticate target schema declaration: %w", err)
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
	if err := refusePendingSourceMigration(ctx); err != nil {
		return true, err
	}
	// Repeat authentication under both locks. Staging is not authority for a
	// later execution or a changed immutable receipt.
	verifiedCandidate, err = verifyInstalledReleaseForExecution(store, candidate)
	if err != nil {
		return true, err
	}
	if _, err := readBridgeSchemaContract(verifiedCandidate, 14); err != nil {
		return true, err
	}
	active, err := store.ReadActive()
	if err != nil {
		return true, err
	}
	journal, journalErr := store.ReadJournal()
	resuming := journalErr == nil && journal.Resumable()
	if journalErr != nil && !errors.Is(journalErr, os.ErrNotExist) {
		return true, journalErr
	}
	if resuming {
		if !journal.ForwardOnlyUpgrade || !journal.PreserveLiveOnFailure || journal.SchemaVersion != 2 || journal.Operation != "update" || journal.Old == nil || journal.Candidate == nil || *journal.Candidate != candidate || journal.DescriptorSHA256 != candidate.DescriptorSHA256 || journal.SourceGeneration == 0 || (journal.SourceSchemaVersion != 14 && journal.SourceSchemaVersion != 15) {
			return true, errors.New("unfinished transition is not an authenticated forward update; preserve the live databases and journal")
		}
		if active.Receipt == candidate && active.Generation == journal.SourceGeneration+1 && active.SelectorBuildID == candidate.BuildID && journal.State == release.PolicyFinalized {
			if !selectorMatchesRelease(store, filepath.Join(store.Home, "bin", "jobctrl"), candidate.BuildID) {
				return true, errors.New("completed update selector changed; preserve the journal")
			}
			if err := writeLegacyCurrent(store.Home, candidate); err != nil {
				return true, err
			}
			return true, advance(store, &journal, release.Promoted)
		}
		if active.Receipt != *journal.Old || active.Generation != journal.SourceGeneration {
			return true, errors.New("forward update source selection changed; preserve the journal")
		}
	} else if active.Receipt == candidate {
		ctx = verifiedReleaseContext(ctx, verifiedCandidate)
		if _, err := os.Lstat(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); errors.Is(err, os.ErrNotExist) {
			return true, nil
		} else if err != nil {
			return true, err
		}
		version, err := jobCtrlSchemaVersion(ctx)
		if err != nil || version != 15 {
			return true, errors.New("selected protocol-2 payload does not match the workspace schema; preserve the workspace and original installation metadata for recovery")
		}
		return true, nil
	}
	old, err := verifyInstalledReleaseEvidence(store, active.Receipt, false)
	if err != nil || active.Receipt.Channel != candidate.Channel || candidate.Sequence <= active.Receipt.Sequence || active.Generation == ^uint64(0) {
		return true, errors.New("forward update requires an authenticated predecessor and a newer permitted target in the same channel")
	}
	if old.runtime.LauncherProtocol != 1 && old.runtime.LauncherProtocol != 2 {
		return true, errors.New("unsupported predecessor controller; preserve the installation and workspace")
	}
	if !resuming {
		if active.SelectorBuildID != active.Receipt.BuildID || !selectorMatchesEvidence(store.Home, old) {
			return true, errors.New("source selector differs from its authenticated immutable release")
		}
	} else if !selectorMatchesEvidence(store.Home, old) && !selectorMatchesEvidence(store.Home, verifiedCandidate) {
		return true, errors.New("interrupted update selector differs from both authenticated releases")
	}
	// All SQLite helpers come from the authenticated new payload. Do not invoke
	// the immutable old launcher, its Python command dispatcher or old recovery.
	ctx = verifiedReleaseContext(ctx, verifiedCandidate)
	ctx.Instance.RuntimeHome = store.Home
	if err := requireLegacySourceOwnership(ctx); err != nil {
		return true, err
	}
	if err := stop(verifiedReleaseContext(ctx, old)); err != nil {
		return true, fmt.Errorf("quiesce workspace before update: %w", err)
	}
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return true, err
	}
	unused, err := unusedDatabasePair(ctx.Instance.StateDir)
	if err != nil {
		return true, err
	}
	if unused {
		return true, errors.New("the predecessor has not initialized its database pair; initialize that installed version once, stop it, then retry the authenticated installer")
	}
	version, err := jobCtrlSchemaVersion(ctx)
	if err != nil || (version != 14 && version != 15) {
		return true, errors.New("forward update requires exact schema 14 or 15; preserve the workspace and use its supported predecessor upgrade first")
	}
	if resuming && version == 14 {
		postActivation := journal.State == release.MigrationActivated || journal.State == release.CandidateStarting || journal.State == release.CandidateHealthy || journal.State == release.PolicyFinalized
		if journal.SourceSchemaVersion == 15 || postActivation {
			return true, errors.New("live schema regressed after the recorded update boundary; preserve the live databases and journal for inspection")
		}
	}
	policy, err := readInstalledPolicy(store.Home, candidate)
	if err != nil {
		return true, err
	}
	channel, err := store.ValidateMetadata(policy)
	if err != nil {
		return true, err
	}
	if !resuming {
		journal, err = store.Begin("update", &active.Receipt, &candidate, candidate.DescriptorSHA256)
		if err != nil {
			return true, err
		}
		journal.ForwardOnlyUpgrade, journal.PreserveLiveOnFailure = true, true
		journal.SourceGeneration = active.Generation
		journal.SourceSchemaVersion = version
		if err := advance(store, &journal, release.MetadataVerified); err != nil {
			return true, err
		}
	}
	// Refresh the backup from the live, stopped pair on every forward attempt.
	// An earlier backup can omit acknowledged profile or Temporal WAL writes.
	pairReceipt := active.Receipt
	if version == 15 {
		pairReceipt = candidate
		// The first backup of an already-v15 workspace belongs to its active
		// predecessor only if that signed release declares the v15 contract
		// and can be supervised by this controller. A later backup may contain
		// writes made by the candidate and must never authorize an old rollback.
		if journal.BackupID == "" && journal.SourceSchemaVersion == 15 && journal.State == release.MetadataVerified &&
			old.runtime.LauncherProtocol == 2 && protocolSupports(old.distribution, launcherProtocol) {
			if _, err := readBridgeSchemaContract(old, 14); err == nil {
				pairReceipt = active.Receipt
			}
		}
	}
	pair, err := snapshotPair(ctx, pairReceipt)
	if err != nil {
		return true, fmt.Errorf("back up the live pair for forward recovery: %w", err)
	}
	if journal.BackupID == "" {
		journal.BackupID = pair.ID
	} else {
		journal.RecoveryBackupID = pair.ID
	}
	journal.PendingPolicy = &policy
	if err := advance(store, &journal, release.PairBackedUp); err != nil {
		return true, err
	}
	if err := advance(store, &journal, release.SelectorHandoffPending); err != nil {
		return true, err
	}
	if err := handoffPublicSelector(store.Home, verifiedCandidate); err != nil {
		return true, err
	}
	if err := advance(store, &journal, release.SelectorReplaced); err != nil {
		return true, err
	}
	if version == 14 {
		cleanupV15Candidate(ctx.Instance.StateDir, journal.ID)
		path, err := buildSealedV15Candidate(ctx, pair, journal.ID)
		if err != nil {
			return true, err
		}
		defer cleanupV15Candidate(ctx.Instance.StateDir, journal.ID)
		if err := advance(store, &journal, release.MigrationCandidateReady); err != nil {
			return true, err
		}
		if err := installSealedV15Candidate(ctx, path); err != nil {
			return true, fmt.Errorf("activate schema in place; retain the live pair and rerun update after cleanup: %w", err)
		}
		if err := advance(store, &journal, release.MigrationActivated); err != nil {
			return true, err
		}
	}
	if err := advance(store, &journal, release.CandidateStarting); err != nil {
		return true, err
	}
	if err := startReleaseCommand(ctx, candidate, journal.ID); err != nil {
		return true, fmt.Errorf("candidate did not become ready; live data was preserved. Run jobctrl stop, then jobctrl update to continue forward: %w", err)
	}
	if err := advance(store, &journal, release.CandidateHealthy); err != nil {
		return true, err
	}
	if err := store.CommitMetadata(channel); err != nil {
		return true, err
	}
	if err := advance(store, &journal, release.PolicyFinalized); err != nil {
		return true, err
	}
	if source == "" {
		source = active.Acquisition
	}
	if _, err := store.WriteSelectedActive(candidate, active.Generation, candidate.BuildID, source); err != nil {
		return true, err
	}
	if err := writeLegacyCurrent(store.Home, candidate); err != nil {
		return true, err
	}
	if err := releaseQACheckpoint(store, release.State("selection_committed")); err != nil {
		return true, err
	}
	if err := advance(store, &journal, release.Promoted); err != nil {
		return true, err
	}
	cleanupV15Candidate(ctx.Instance.StateDir, journal.ID)
	_, err = fmt.Fprintf(output, "JobCtrl %s is active. Live workspace data was preserved.\n", candidate.BuildID)
	return true, err
}

func selectorMatchesEvidence(home string, verified verifiedRelease) bool {
	expected, err := manifestRegularFile(verified.distribution, "launcher/jobctrl")
	if err != nil {
		return false
	}
	path := filepath.Join(home, "bin", "jobctrl")
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0111 == 0 {
		return false
	}
	digest, err := sha256Path(path)
	return err == nil && digest == expected
}

func resumeForwardUpdate(env []string, output io.Writer) (bool, error) {
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return false, nil
	}
	store, err := release.Open(home)
	if err != nil {
		return true, err
	}
	journal, err := store.ReadJournal()
	if errors.Is(err, os.ErrNotExist) || (err == nil && (!journal.Resumable() || !journal.ForwardOnlyUpgrade)) {
		return false, nil
	}
	if err != nil || journal.Candidate == nil {
		return true, errors.New("cannot read the interrupted forward update; preserve the live databases and journal")
	}
	ctx, err := transitionContextForReceipt(env, store, *journal.Candidate)
	if err != nil {
		return true, err
	}
	return promoteForwardUpdate(ctx, journal.Candidate.BuildID, "", output)
}

// Cleanup is a public recovery operation. It authenticates the new controller
// independently of the retired active payload and never advances the journal.
func stopForwardUpdate(env []string, output io.Writer) (bool, error) {
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return false, nil
	}
	store, err := release.Open(home)
	if err != nil {
		return true, err
	}
	journal, err := store.ReadJournal()
	if errors.Is(err, os.ErrNotExist) || (err == nil && (!journal.Resumable() || !journal.ForwardOnlyUpgrade)) {
		return false, nil
	}
	if err != nil {
		return true, err
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
	if err := refusePendingBridgeHandoff(home); err != nil {
		return true, err
	}
	journal, err = store.ReadJournal()
	if err != nil || !journal.Resumable() || !journal.ForwardOnlyUpgrade || !journal.PreserveLiveOnFailure || journal.SchemaVersion != 2 || journal.Operation != "update" || journal.Old == nil || journal.Candidate == nil || journal.SourceGeneration == 0 || (journal.SourceSchemaVersion != 14 && journal.SourceSchemaVersion != 15) || journal.DescriptorSHA256 != journal.Candidate.DescriptorSHA256 {
		return true, errors.New("cannot authenticate the interrupted forward update for cleanup; preserve the journal and live workspace")
	}
	// Cleanup uses authenticated metadata only. Current revocation policy
	// still fences update/start, but cannot prevent stopping owned writers.
	candidate, err := verifyInstalledReleaseEvidence(store, *journal.Candidate, false)
	if err != nil {
		return true, err
	}
	if candidate.runtime.LauncherProtocol != 2 || !protocolSupports(candidate.distribution, launcherProtocol) {
		return true, errors.New("forward cleanup requires an authenticated protocol-2 controller")
	}
	if _, err := readBridgeSchemaContract(candidate, 14); err != nil {
		return true, err
	}
	active, err := store.ReadActive()
	if err != nil {
		return true, err
	}
	old, err := verifyInstalledReleaseEvidence(store, *journal.Old, false)
	if err != nil {
		return true, err
	}
	sourceSelected := active.Receipt == *journal.Old && active.Generation == journal.SourceGeneration
	targetSelected := journal.State == release.PolicyFinalized && active.Receipt == *journal.Candidate && active.Generation == journal.SourceGeneration+1 && active.SelectorBuildID == journal.Candidate.BuildID
	if (!sourceSelected && !targetSelected) || (!selectorMatchesEvidence(home, old) && !selectorMatchesEvidence(home, candidate)) {
		return true, errors.New("forward cleanup selection changed; preserve the journal and live workspace")
	}
	cleanupEnv := append(append([]string{}, env...), "JOBCTRL_RUNTIME_HOME="+store.Home)
	instance, err := resolveInstance(cleanupEnv)
	if err != nil {
		return true, err
	}
	ctx := verifiedReleaseContext(launchContext{Instance: instance, Environment: cleanupEnv}, candidate)
	if err := stop(ctx); err != nil {
		return true, err
	}
	_, err = fmt.Fprintln(output, "JobCtrl stopped. The interrupted forward update and live workspace were preserved; run jobctrl update to continue.")
	return true, err
}

func refuseUnfinishedForwardUpdate(home string, args, env []string) error {
	var journal release.Journal
	if err := decodeStrictRegular(filepath.Join(home, release.JournalFile), &journal); err != nil || !journal.ForwardOnlyUpgrade || !journal.Resumable() {
		return nil
	}
	startup := (len(args) == 2 && args[0] == "start" && args[1] == "--no-open") || (len(args) == 1 && args[0] == "__supervise")
	if startup && journal.ID != "" && environmentMap(env)["JOBCTRL_TRANSITION_JOURNAL"] == journal.ID {
		// prepare and authenticatedTransitionStartup still prove the exact
		// selector, receipt, target, phase and signed inventory before execution.
		return nil
	}
	return errors.New("unfinished forward update; keep the live databases and journal. Run jobctrl stop, then jobctrl update to continue forward; rollback cannot restore older data over this transition")
}
