package launcher

import (
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// compatibleForwardRollbackPair recognizes the original snapshot made by an
// older forward controller that recorded the candidate receipt on every v15
// backup. The completed, uninterrupted journal binds that snapshot to the
// predecessor. Any uncertain evidence leaves rollback unavailable.
func compatibleForwardRollbackPair(ctx launchContext, journal release.Journal, active release.Active, current, predecessor verifiedRelease) (databasePair, error) {
	refuse := func() (databasePair, error) {
		return databasePair{}, errors.New("forward-update backup provenance is unavailable")
	}
	if journal.SchemaVersion != 2 || journal.ID == "" || journal.Operation != "update" || journal.State != release.Promoted ||
		!journal.ForwardOnlyUpgrade || !journal.PreserveLiveOnFailure || journal.SourceSchemaVersion != 15 ||
		journal.SourceGeneration == 0 || journal.SourceGeneration == ^uint64(0) || journal.SourceGeneration+1 != active.Generation ||
		journal.Old == nil || journal.Candidate == nil || *journal.Old != predecessor.receipt || *journal.Candidate != active.Receipt ||
		journal.DescriptorSHA256 != active.Receipt.DescriptorSHA256 || current.receipt != active.Receipt ||
		active.SelectorBuildID != active.Receipt.BuildID || journal.RecoveryBackupID != "" || journal.TargetBackupID != "" {
		return refuse()
	}
	if current.runtime.LauncherProtocol != 2 || predecessor.runtime.LauncherProtocol != 2 ||
		!protocolSupports(current.distribution, launcherProtocol) || !protocolSupports(predecessor.distribution, launcherProtocol) {
		return refuse()
	}
	for _, verified := range []verifiedRelease{current, predecessor} {
		if _, err := readBridgeSchemaContract(verified, 14); err != nil {
			return refuse()
		}
	}
	id := journal.BackupID
	if len(id) != len("pair-")+32 || !strings.HasPrefix(id, "pair-") || id != strings.ToLower(id) {
		return refuse()
	}
	if _, err := hex.DecodeString(strings.TrimPrefix(id, "pair-")); err != nil {
		return refuse()
	}
	dir := filepath.Join(ctx.Instance.StateDir, "backups", id)
	if info, err := os.Lstat(dir); err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return refuse()
	}
	var pair databasePair
	if err := decodeStrictRegular(filepath.Join(dir, "pair.json"), &pair); err != nil || pair.SchemaVersion != 1 ||
		pair.ID != id || pair.CreatedAt.IsZero() || pair.ReleaseReceipt != active.Receipt || len(pair.Files) != 2 {
		return refuse()
	}
	seen := map[string]bool{}
	for _, file := range pair.Files {
		if (file.Name != "jobctrl.db" && file.Name != "temporal.db") || seen[file.Name] || file.SizeBytes <= 0 ||
			!validSHA256(file.SHA256) || file.SQLiteUserVer < 0 || (file.Name == "jobctrl.db" && file.SQLiteUserVer != 15) {
			return refuse()
		}
		seen[file.Name] = true
		if _, err := pairedDatabasePath(ctx.Instance.StateDir, pair, file.Name, file.SQLiteUserVer); err != nil {
			return refuse()
		}
		// The snapshot is a self-contained pair. Do not read an unverified
		// SQLite sidecar when checking its schema or restoring it.
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, err := os.Lstat(filepath.Join(dir, file.Name+suffix)); !errors.Is(err, os.ErrNotExist) {
				return refuse()
			}
		}
	}
	if !seen["jobctrl.db"] || !seen["temporal.db"] {
		return refuse()
	}
	python := filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
	if version, err := sqliteUserVersion(python, filepath.Join(dir, "jobctrl.db")); err != nil || version != 15 {
		return refuse()
	}
	return pair, nil
}
