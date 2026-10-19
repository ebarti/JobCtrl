package launcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// The signed payload declares support separately from the runtime protocol.
// Older selectors take a shared selection lock before reading any arguments;
// re-executing them while their updater owns the exclusive lock would deadlock.
func selectorSupportsJournalStartup(store *release.Store, selector string) bool {
	builds := []string{}
	if active, err := store.ReadActive(); err == nil {
		builds = append(builds, active.SelectorBuildID)
	}
	if journal, err := store.ReadJournal(); err == nil {
		for _, receipt := range []*release.Receipt{journal.Old, journal.Candidate} {
			if receipt != nil {
				builds = append(builds, receipt.BuildID)
			}
		}
	}
	for _, build := range builds {
		if !selectorMatchesRelease(store, selector, build) {
			continue
		}
		var protocol struct {
			SchemaVersion  int  `json:"schemaVersion"`
			JournalStartup bool `json:"journalStartup"`
		}
		if err := decodeStrictRegular(filepath.Join(store.Home, "releases", build, "payload", "launcher", "update-protocol.json"), &protocol); err == nil && protocol.SchemaVersion == 1 && protocol.JournalStartup {
			return true
		}
	}
	return false
}

// transitionSelectorPayload authenticates both actors separately: the current
// compatible selector is the controller, and the journal names the only payload
// it may start. This keeps rollback independent of an older launcher's bugs.
// It intentionally does not take the selection lock held by the parent updater.
func transitionSelectorPayload(executable string, env []string) (string, *selectorReceipt, error) {
	values := environmentMap(env)
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return "", nil, err
	}
	store, err := release.Open(home)
	if err != nil {
		return "", nil, err
	}
	home, err = filepath.EvalSymlinks(store.Home)
	if err != nil {
		return "", nil, err
	}
	store.Home = home
	path, err := filepath.EvalSymlinks(executable)
	if err != nil || path != filepath.Join(home, "bin", "jobctrl") {
		return "", nil, errors.New("transition controller is not the public selector")
	}
	journal, err := store.ReadJournal()
	if err != nil || values["JOBCTRL_TRANSITION_JOURNAL"] == "" || journal.ID != values["JOBCTRL_TRANSITION_JOURNAL"] {
		return "", nil, errors.New("transition controller does not match a durable journal")
	}
	var target *release.Receipt
	switch journal.State {
	case release.CandidateStarting:
		target = journal.Candidate
	case release.RollbackRestoring:
		target = journal.Old
	default:
		return "", nil, errors.New("transition controller is not in an executable state")
	}
	if target == nil || values["JOBCTRL_TRANSITION_TARGET"] != target.BuildID {
		return "", nil, errors.New("transition payload does not match the journal target")
	}
	controllerOK := false
	if active, err := store.ReadActive(); err == nil {
		controllerOK = selectorMatchesRelease(store, path, active.SelectorBuildID)
	}
	for _, controller := range []*release.Receipt{journal.Candidate, journal.Old} {
		if controllerOK {
			break
		}
		if controller != nil && selectorMatchesRelease(store, path, controller.BuildID) {
			controllerOK = true
			break
		}
	}
	if !controllerOK {
		return "", nil, errors.New("transition controller differs from authenticated journal releases")
	}
	verified, err := verifyInstalledReleaseForExecution(store, *target)
	if err != nil {
		return "", nil, fmt.Errorf("verify transition target: %w", err)
	}
	if !protocolSupports(verified.distribution, launcherProtocol) {
		return "", nil, errors.New("transition controller cannot supervise the target protocol")
	}
	var receipt selectorReceipt
	if err := decodeStrictRegular(filepath.Join(home, "releases", target.BuildID, "receipt.json"), &receipt); err != nil {
		return "", nil, err
	}
	return verified.payloadRoot, &receipt, nil
}

// A historical updater may consider its own schema current and skip migration.
// The new candidate can finish the target-owned sealed migration using exactly
// the pair already recorded by that updater, before starting any services.
func migrateHistoricalTransition(ctx launchContext) error {
	if ctx.Distribution.ReleaseChannel == "local" || environmentMap(ctx.Environment)["JOBCTRL_TRANSITION_JOURNAL"] == "" {
		return nil
	}
	store, err := releaseStore(ctx)
	if err != nil {
		return err
	}
	journal, err := store.ReadJournal()
	if err != nil {
		return err
	}
	if journal.State != release.CandidateStarting || journal.Operation != "update" || journal.Candidate == nil || journal.Candidate.BuildID != ctx.Distribution.BuildID {
		return nil
	}
	if !authenticatedTransitionStartup(ctx, []string{"start", "--no-open"}) {
		return errors.New("historical update startup is not journal-authorized")
	}
	version, err := jobCtrlSchemaVersion(ctx)
	if err != nil {
		return err
	}
	if version == currentJobCtrlSchemaVersion {
		return nil
	}
	if journal.Old == nil || journal.BackupID == "" || filepath.Base(journal.BackupID) != journal.BackupID || journal.BackupID == "." || journal.BackupID == ".." {
		return errors.New("historical update requires its authenticated predecessor pair")
	}
	if _, err := verifyInstalledReleaseForExecution(store, *journal.Old); err != nil {
		return err
	}
	pairDir := filepath.Join(ctx.Instance.StateDir, "backups", journal.BackupID)
	if info, err := os.Lstat(pairDir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("historical update pair directory is unsafe")
	}
	var pair databasePair
	if err := decodeStrictRegular(filepath.Join(ctx.Instance.StateDir, "backups", journal.BackupID, "pair.json"), &pair); err != nil || pair.ID != journal.BackupID || pair.ReleaseReceipt != *journal.Old {
		return errors.New("historical update pair does not bind the predecessor")
	}
	sourceVersion, err := pairedV14SourceSchemaVersion(pair)
	if err != nil || sourceVersion != version {
		return errors.New("historical update live schema differs from its paired backup")
	}
	seen := map[string]bool{}
	for _, file := range pair.Files {
		if file.Name != "jobctrl.db" && file.Name != "temporal.db" {
			return errors.New("historical update pair has an unknown database")
		}
		if seen[file.Name] {
			return errors.New("historical update pair repeats a database")
		}
		seen[file.Name] = true
		if _, err := pairedDatabasePath(ctx.Instance.StateDir, pair, file.Name, file.SQLiteUserVer); err != nil {
			return err
		}
	}
	if state, err := readState(ctx.Instance.StatePath); err == nil {
		if err := validateStateIdentity(ctx, state); err != nil {
			return err
		}
		if stateHasLiveProcesses(state) {
			return errors.New("historical update still has live recorded processes")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	path, err := buildSealedV14Candidate(ctx, pair, journal.ID)
	if err != nil {
		return err
	}
	defer cleanupV14Candidate(ctx.Instance.StateDir, journal.ID)
	return installSealedV14Candidate(ctx, path)
}
