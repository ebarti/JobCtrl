package launcher

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// bridgeRecoveryAfterSelection is a fault-injection seam for an interruption
// after selection publication and before the recovery journal is finalized.
var bridgeRecoveryAfterSelection func() error

// recoverBridgeBeforeBootstrap handles flagged transitions before acquisition
// bootstrap can change the selector. Only pre-stop milestones are admissible.
// No database is opened and no process is started or stopped.
func recoverBridgeBeforeBootstrap(env, args []string, output io.Writer) (bool, error) {
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return false, nil
	}
	store, err := release.Open(home)
	if err != nil {
		return true, fmt.Errorf("open release store before recovery: %w", err)
	}
	journal, err := store.ReadJournal()
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return true, fmt.Errorf("read release journal before recovery: %w", err)
	}
	if !journal.PreserveLiveOnFailure || (!journal.Resumable() && journal.State != release.RolledBack) {
		return false, nil
	}
	// Repeating an ordinary rollback after cancellation is idempotent. An
	// explicit target or help request must reach the normal command handler.
	if journal.State == release.RolledBack && (len(args) != 1 || args[0] != "rollback") {
		return false, nil
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
	journal, err = store.ReadJournal()
	if err != nil || !journal.PreserveLiveOnFailure || (!journal.Resumable() && journal.State != release.RolledBack) {
		return true, errors.New("schema transition changed while recovery acquired its locks; retry")
	}
	early := journal.State == release.MetadataVerified || journal.State == release.ReleaseCommitted
	completed := journal.State == release.RolledBack
	handoff := journal.State == release.SelectorHandoffPending || journal.State == release.SelectorReplaced || completed
	if !early && !handoff {
		return true, fmt.Errorf("schema transition at %s requires explicit recovery; live databases and journal remain preserved", journal.State)
	}
	if journal.SchemaVersion != 2 || journal.Operation != "update" || journal.Old == nil || journal.Candidate == nil ||
		!journal.Old.Valid() || !journal.Candidate.Valid() || journal.DescriptorSHA256 != journal.Candidate.DescriptorSHA256 ||
		journal.BackupID != "" || journal.TargetBackupID != "" || journal.PendingPolicy != nil || journal.BridgeSourceGeneration == 0 {
		return true, errors.New("schema transition recovery journal has invalid or incomplete bindings")
	}
	active, err := store.ReadActive()
	if err != nil || active.Receipt != *journal.Old {
		return true, errors.New("schema transition source selection changed; preserve the journal for inspection")
	}
	if active.Generation != journal.BridgeSourceGeneration &&
		(!handoff || journal.BridgeSourceGeneration == ^uint64(0) ||
			active.Generation != journal.BridgeSourceGeneration+1 || active.SelectorBuildID != journal.Candidate.BuildID) {
		return true, errors.New("schema transition source generation changed; preserve the journal for inspection")
	}
	if active.Receipt.Channel == "local" || active.Receipt.Channel != journal.Candidate.Channel || journal.Candidate.Sequence <= active.Receipt.Sequence {
		return true, errors.New("schema transition recovery requires the original signed source and candidate")
	}
	old, err := verifyInstalledReleaseForExecution(store, active.Receipt)
	if err != nil || !protocolSupports(old.distribution, launcherProtocol) {
		return true, errors.New("schema transition source is no longer an authenticated compatible release")
	}
	candidate, _, err := loadVerifiedBridgeSchemaContract(store, *journal.Candidate, 14)
	if err != nil {
		return true, fmt.Errorf("authenticate schema transition candidate: %w", err)
	}
	if !protocolSupports(old.distribution, candidate.runtime.LauncherProtocol) || !protocolSupports(candidate.distribution, candidate.runtime.LauncherProtocol) {
		return true, errors.New("schema transition selector is not compatible with both signed payloads")
	}
	// Do not use verifyPublicSelector's journal-candidate fallback here: these
	// milestones admit only the exact source selector or the candidate selector
	// that promotion may already have installed.
	selector := filepath.Join(store.Home, "bin", "jobctrl")
	if !selectorMatchesRelease(store, selector, active.SelectorBuildID) {
		if !handoff || completed || active.Generation != journal.BridgeSourceGeneration || !selectorMatchesRelease(store, selector, journal.Candidate.BuildID) {
			return true, errors.New("schema transition selector changed; preserve the journal for inspection")
		}
		// Never replace the selector with an older one. Complete the forward
		// selection record instead; replay accepts exactly this one increment.
		active, err = store.WriteSelectedActive(active.Receipt, active.Generation, journal.Candidate.BuildID, active.Acquisition)
		if err != nil {
			return true, fmt.Errorf("publish authenticated recovery selector: %w", err)
		}
		if bridgeRecoveryAfterSelection != nil {
			if err := bridgeRecoveryAfterSelection(); err != nil {
				return true, err
			}
		}
	}
	if !completed {
		if err := store.Advance(&journal, release.RolledBack, nil); err != nil {
			return true, fmt.Errorf("persist schema transition cancellation: %w", err)
		}
	}
	_, err = io.WriteString(output, "JobCtrl cancelled the interrupted update before data migration. Live data was preserved; retry the update when ready.\n")
	return true, err
}
