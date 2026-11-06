package launcher

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// Updates are target-to-target only. An installer or interrupted journal cannot
// authorize executing a legacy payload, migrating its databases, or resetting
// data. After possible candidate writes, recovery continues with the live pair.
func promoteForwardUpdate(ctx launchContext, build, source string, output io.Writer) (bool, error) {
	store, err := releaseStore(ctx)
	if err != nil {
		return true, err
	}
	candidate, err := readInstalledReceipt(store.Home, build)
	if err != nil {
		return true, err
	}
	verifiedCandidate, err := verifyInstalledReleaseForExecution(store, candidate)
	if err != nil {
		return true, fmt.Errorf("authenticate update target: %w", err)
	}
	if err := admitPythonApplicationLifecycle(ctx, verifiedCandidate); err != nil {
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
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return true, err
	}
	if err := refusePendingSourceMigration(ctx); err != nil {
		return true, err
	}
	// Repeat authentication and read-only admission under both lifecycle locks.
	verifiedCandidate, err = verifyInstalledReleaseForExecution(store, candidate)
	if err != nil {
		return true, err
	}
	if err := admitPythonApplicationLifecycle(ctx, verifiedCandidate); err != nil {
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
		if !targetForwardJournal(journal) || *journal.Candidate != candidate || journal.DescriptorSHA256 != candidate.DescriptorSHA256 {
			return true, errors.New("unfinished transition is not a target Python application update; preserve the source databases and journal")
		}
		if active.Receipt == candidate && active.Generation == journal.SourceGeneration+1 && active.SelectorBuildID == candidate.BuildID && journal.State == release.PolicyFinalized {
			if !selectorMatchesEvidence(store.Home, verifiedCandidate) {
				return true, errors.New("completed update selector changed; preserve the journal")
			}
			if err := writeLegacyCurrent(store.Home, candidate); err != nil {
				return true, err
			}
			if err := advance(store, &journal, release.Promoted); err != nil {
				return true, err
			}
			return true, retainReleases(store, ctx.Instance.StateDir)
		}
		if active.Receipt != *journal.Old || active.Generation != journal.SourceGeneration {
			return true, errors.New("update source selection changed; preserve the journal")
		}
	} else if active.Receipt == candidate {
		_, err := fmt.Fprintf(output, "JobCtrl %s is already active.\n", candidate.BuildID)
		return true, err
	}
	old, err := verifyInstalledReleaseEvidence(store, active.Receipt, false)
	if err != nil || active.Receipt.Channel != candidate.Channel || candidate.Sequence <= active.Receipt.Sequence || active.Generation == ^uint64(0) {
		return true, errors.New("update requires an authenticated predecessor and a newer permitted target in the same channel")
	}
	if err := readPythonApplicationSchemaContract(old); err != nil {
		return true, fmt.Errorf("update cannot replace a legacy application in place: %w", err)
	}
	sourceSelectorMatches := forwardSourceSelectorMatches(store, active, old, verifiedCandidate)
	if !sourceSelectorMatches && (!resuming || !selectorMatchesEvidence(store.Home, verifiedCandidate)) {
		return true, errors.New("update selector differs from its authenticated source and target releases")
	}
	ctx = verifiedReleaseContext(ctx, verifiedCandidate)
	ctx.Instance.RuntimeHome = store.Home
	unused, err := unusedDatabasePair(ctx.Instance.StateDir)
	if err != nil {
		return true, err
	}
	if unused {
		return true, errors.New("the selected Python application has not initialized its database pair; start that version once, stop it, then retry update")
	}
	policy, err := readInstalledPolicy(store.Home, candidate)
	if err != nil {
		return true, err
	}
	channel, err := store.ValidateMetadata(policy)
	if err != nil {
		return true, err
	}
	// Compatibility checks precede stop, backup, journal and selector mutations.
	if err := stop(ctx); err != nil {
		return true, fmt.Errorf("quiesce workspace before update: %w", err)
	}
	if err := admitPythonApplicationLifecycle(ctx, verifiedCandidate); err != nil {
		return true, err
	}
	if !resuming {
		journal, err = store.Begin("update", &active.Receipt, &candidate, candidate.DescriptorSHA256)
		if err != nil {
			return true, err
		}
		journal.ForwardOnlyUpgrade, journal.PreserveLiveOnFailure = true, true
		journal.SourceGeneration, journal.SourceSchemaVersion = active.Generation, pythonApplicationUserVersion
		if err := advance(store, &journal, release.MetadataVerified); err != nil {
			return true, err
		}
	}
	// A retry snapshots stopped live data again. Candidate commits must never be
	// mislabeled as a predecessor rollback snapshot; retain the original as well.
	pairReceipt := candidate
	if journal.BackupID == "" && journal.State == release.MetadataVerified {
		pairReceipt = active.Receipt
	}
	pair, err := snapshotPair(ctx, pairReceipt)
	if err != nil {
		return true, fmt.Errorf("back up the live pair for update recovery: %w", err)
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
	if err := advance(store, &journal, release.CandidateStarting); err != nil {
		return true, err
	}
	if err := startReleaseCommand(ctx, candidate, journal.ID); err != nil {
		return true, fmt.Errorf("candidate startup failed; live data and journal are preserved; run jobctrl stop, then jobctrl update to continue: %w", err)
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
	if err := retainReleases(store, ctx.Instance.StateDir); err != nil {
		return true, fmt.Errorf("JobCtrl %s is active, but release retention did not complete: %w", candidate.BuildID, err)
	}
	_, err = fmt.Fprintf(output, "JobCtrl %s is active. Live workspace data was preserved.\n", candidate.BuildID)
	return true, err
}

func targetForwardJournal(journal release.Journal) bool {
	if !journal.Resumable() || !journal.ForwardOnlyUpgrade || !journal.PreserveLiveOnFailure || journal.SchemaVersion != 2 || journal.Operation != "update" ||
		journal.Old == nil || journal.Candidate == nil || journal.SourceGeneration == 0 || journal.SourceGeneration == ^uint64(0) || journal.SourceSchemaVersion != pythonApplicationUserVersion ||
		journal.DescriptorSHA256 != journal.Candidate.DescriptorSHA256 || journal.TargetBackupID != "" {
		return false
	}
	switch journal.State {
	case release.MetadataVerified:
		return journal.BackupID == "" && journal.RecoveryBackupID == ""
	case release.PairBackedUp, release.SelectorHandoffPending, release.SelectorReplaced, release.CandidateStarting, release.CandidateHealthy, release.PolicyFinalized:
		return journal.BackupID != ""
	default:
		return false
	}
}

// A rollback can retain a newer compatible controller. Authenticate its actual
// bytes independently before updating the selected older target again.
func forwardSourceSelectorMatches(store *release.Store, active release.Active, old, candidate verifiedRelease) bool {
	if active.SelectorBuildID == active.Receipt.BuildID {
		return selectorMatchesEvidence(store.Home, old)
	}
	selector, err := readInstalledReceipt(store.Home, active.SelectorBuildID)
	if err != nil || selector.BuildID != active.SelectorBuildID || selector.Channel != active.Receipt.Channel || selector.Sequence < active.Receipt.Sequence || selector.Sequence > candidate.receipt.Sequence {
		return false
	}
	verified, err := verifyInstalledReleaseForExecution(store, selector)
	return err == nil && readPythonApplicationSchemaContract(verified) == nil && selectorMatchesEvidence(store.Home, verified)
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
	if err != nil || !targetForwardJournal(journal) {
		return true, errors.New("cannot resume a legacy or invalid update; preserve the source databases and journal")
	}
	ctx, err := transitionContextForReceipt(env, store, *journal.Candidate)
	if err != nil {
		return true, err
	}
	return promoteForwardUpdate(ctx, journal.Candidate.BuildID, "", output)
}

// Cleanup authenticates metadata independently of current execution permission;
// channel revocation cannot prevent stopping writers the native scope owns.
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
	if err != nil || !targetForwardJournal(journal) {
		return true, errors.New("cannot authenticate a legacy or invalid update for cleanup; preserve its journal and live workspace")
	}
	candidate, err := verifyInstalledReleaseEvidence(store, *journal.Candidate, false)
	if err != nil {
		return true, err
	}
	if err := readPythonApplicationSchemaContract(candidate); err != nil {
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
	if err := readPythonApplicationSchemaContract(old); err != nil {
		return true, err
	}
	sourceSelected := active.Receipt == *journal.Old && active.Generation == journal.SourceGeneration
	targetSelected := journal.State == release.PolicyFinalized && active.Receipt == *journal.Candidate && active.Generation == journal.SourceGeneration+1 && active.SelectorBuildID == journal.Candidate.BuildID
	if (!sourceSelected && !targetSelected) || (!forwardSourceSelectorMatches(store, active, old, candidate) && !selectorMatchesEvidence(home, candidate)) {
		return true, errors.New("update cleanup selection changed; preserve the journal and live workspace")
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
	_, err = fmt.Fprintln(output, "JobCtrl stopped. The interrupted update and live workspace were preserved; run jobctrl update to continue.")
	return true, err
}

func refuseUnfinishedForwardUpdate(home string, args, env []string) error {
	var journal release.Journal
	if err := decodeStrictRegular(filepath.Join(home, release.JournalFile), &journal); err != nil || !journal.ForwardOnlyUpgrade || !journal.Resumable() {
		return nil
	}
	startup := (len(args) == 2 && args[0] == "start" && args[1] == "--no-open") || (len(args) == 1 && args[0] == "__supervise")
	if targetForwardJournal(journal) && startup && journal.ID != "" && environmentMap(env)["JOBCTRL_TRANSITION_JOURNAL"] == journal.ID {
		return nil
	}
	return errors.New("unfinished update; keep the live databases and journal. Run jobctrl stop, then jobctrl update to continue; rollback cannot replace this transition with an older snapshot")
}
