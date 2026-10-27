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
// after a reboot without ever executing or delegating recovery to old code.
// The old controller cannot admit the protocol-2 target before its own backup.
// The same forward-only path handles later signed protocol-2 updates.
func promoteRebootUpdate(ctx launchContext, build, source string, output io.Writer) (bool, error) {
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
		return true, fmt.Errorf("authenticate reboot update target: %w", err)
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
		if !journal.RebootUpgrade || !journal.PreserveLiveOnFailure || journal.SchemaVersion != 2 || journal.Operation != "update" || journal.Old == nil || journal.Candidate == nil || *journal.Candidate != candidate || journal.DescriptorSHA256 != candidate.DescriptorSHA256 || journal.SourceGeneration == 0 || (journal.SourceSchemaVersion != 14 && journal.SourceSchemaVersion != 15) {
			return true, errors.New("unfinished transition is not an authenticated reboot update; preserve the live databases and journal")
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
			return true, errors.New("reboot update source selection changed; preserve the journal")
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
		return true, errors.New("reboot update requires an authenticated predecessor and a newer permitted target in the same channel")
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
	if _, err := readExecutionFence(ctx); errors.Is(err, os.ErrNotExist) {
		if err := recordExecutionBoot(ctx); err != nil {
			return true, err
		}
		return true, fmt.Errorf("recorded the upgrade recovery boundary; %w; rerun the authenticated installer after reboot", errRebootRequired)
	} else if err != nil {
		return true, err
	}
	if err := stop(ctx); err != nil {
		return true, fmt.Errorf("quiesce workspace before reboot update: %w", err)
	}
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return true, err
	}
	unused, err := unusedDatabasePair(ctx.Instance.StateDir)
	if err != nil {
		return true, err
	}
	if unused {
		return true, errors.New("the predecessor has not initialized its database pair; initialize that installed version once, stop it, reboot, then retry the authenticated installer")
	}
	version, err := jobCtrlSchemaVersion(ctx)
	if err != nil || (version != 14 && version != 15) {
		return true, errors.New("reboot update requires exact schema 14 or 15; preserve the workspace and use its supported predecessor upgrade first")
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
		journal.RebootUpgrade, journal.PreserveLiveOnFailure = true, true
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
			return true, fmt.Errorf("activate schema in place; retain the live pair and rerun update after reboot: %w", err)
		}
		if err := advance(store, &journal, release.MigrationActivated); err != nil {
			return true, err
		}
	}
	if err := advance(store, &journal, release.CandidateStarting); err != nil {
		return true, err
	}
	if err := startReleaseCommand(ctx, candidate, journal.ID); err != nil {
		return true, fmt.Errorf("candidate did not become ready; live data was preserved. Reboot, then run jobctrl update to continue forward: %w", err)
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

func resumeRebootUpdate(env []string, output io.Writer) (bool, error) {
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return false, nil
	}
	store, err := release.Open(home)
	if err != nil {
		return true, err
	}
	journal, err := store.ReadJournal()
	if errors.Is(err, os.ErrNotExist) || (err == nil && (!journal.Resumable() || !journal.RebootUpgrade)) {
		return false, nil
	}
	if err != nil || journal.Candidate == nil {
		return true, errors.New("cannot read the interrupted reboot update; preserve the live databases and journal")
	}
	ctx, err := transitionContextForReceipt(env, store, *journal.Candidate)
	if err != nil {
		return true, err
	}
	return promoteRebootUpdate(ctx, journal.Candidate.BuildID, "", output)
}

func refuseUnfinishedRebootUpdate(home string, args, env []string) error {
	var journal release.Journal
	if err := decodeStrictRegular(filepath.Join(home, release.JournalFile), &journal); err != nil || !journal.RebootUpgrade || !journal.Resumable() {
		return nil
	}
	startup := (len(args) == 2 && args[0] == "start" && args[1] == "--no-open") || (len(args) == 1 && args[0] == "__supervise")
	if startup && journal.ID != "" && environmentMap(env)["JOBCTRL_TRANSITION_JOURNAL"] == journal.ID {
		// prepare and authenticatedTransitionStartup still prove the exact
		// selector, receipt, target, phase and signed inventory before execution.
		return nil
	}
	return errors.New("unfinished reboot update; keep the live databases and journal. Reboot, then run jobctrl update to continue forward; rollback cannot restore older data over this transition")
}
