//go:build darwin

package launcher

import (
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type sourceMigrationJournal struct {
	SchemaVersion int    `json:"schemaVersion"`
	ID            string `json:"id"`
	BackupID      string `json:"backupId"`
	SourceVersion int64  `json:"sourceVersion"`
	Stage         string `json:"stage"`
}

type sourceBackup struct {
	SchemaVersion int            `json:"schemaVersion"`
	ID            string         `json:"id"`
	CreatedAt     time.Time      `json:"createdAt"`
	TemporalPath  string         `json:"temporalPath"`
	Files         []databaseFile `json:"files"`
}

// Tests inject failures at durable boundaries without granting ownership.
var sourceMigrationCheckpoint func(string) error

func sourceMigrationStage(stage string) error {
	if sourceMigrationCheckpoint != nil {
		return sourceMigrationCheckpoint(stage)
	}
	return nil
}

// A source-run marker is useful only with its actual authenticated execution
// receipt or a native completion that binds that exact receipt. A PID or a
// marker by itself never grants migration authority.
func sourceScopedExecutionProven(ctx launchContext) (bool, error) {
	if ctx.Instance.ID == "" || ctx.Instance.Dir == "" || ctx.Instance.StatePath == "" {
		return false, nil
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return false, err
	}
	active := make(map[string]executionScope, len(scopes))
	for _, scope := range scopes {
		active[scope.ID] = scope
	}
	dir := filepath.Join(ctx.Instance.Dir, "source-runs")
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 {
		return false, errors.New("source execution marker directory is unsafe")
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != os.Getuid() {
		return false, errors.New("source execution marker directory has a different owner")
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) > 10000 {
		return false, errors.New("cannot inspect source execution markers")
	}
	proven := false
	for _, entry := range entries {
		id := strings.TrimSuffix(entry.Name(), ".json")
		if entry.Name() != id+".json" || !executionIDValid(id) {
			return false, errors.New("unfamiliar source execution marker")
		}
		path := filepath.Join(dir, entry.Name())
		file, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return false, err
		}
		info, err := file.Stat()
		file.Close()
		if err != nil {
			return false, err
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 4096 || !ok || int(stat.Uid) != os.Getuid() || stat.Nlink != 1 {
			return false, errors.New("source execution marker is unsafe")
		}
		var marker sourceExecutionMarker
		if err := decodeStrictRegular(path, &marker); err != nil || marker.SchemaVersion != 1 || marker.InstanceID != ctx.Instance.ID || marker.ScopeID != id {
			return false, errors.New("source execution marker is invalid")
		}
		if scope, ok := active[id]; ok && scope.Purpose == "source" {
			proven = true
			continue
		}
		completion, err := readExecutionCompletion(ctx, id)
		if err == nil && completion.Scope.Purpose == "source" {
			proven = true
			continue
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return false, err
		}
	}
	return proven, nil
}

func sourceMigrationHasOwner(ctx launchContext) (bool, error) {
	source, err := sourceScopedExecutionProven(ctx)
	if err != nil || source {
		return source, err
	}
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return false, err
	}
	if temporal != filepath.Join(ctx.Instance.StateDir, "temporal.db") {
		return false, nil
	}
	state, err := readState(ctx.Instance.StatePath)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if err := validateStateIdentity(ctx, state); err != nil {
		return false, err
	}
	if state.BuildID == "source" {
		return false, nil
	}
	if state.OwnershipVerified && state.StoppedAt != nil {
		return true, nil
	}
	if state.ExecutionScopeID != "" {
		if err := requireExecutionReceipt(ctx, state); err != nil {
			return false, err
		}
		return true, nil
	}
	return false, nil
}

func requireLegacySourceOwnership(ctx launchContext) error {
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return err
	}
	if temporal == filepath.Join(ctx.Instance.StateDir, "temporal.db") {
		return nil
	}
	verified, err := sourceScopedExecutionProven(ctx)
	if err != nil {
		return err
	}
	if !verified {
		return errors.New("legacy source history has unverified runtime ownership; preserve the workspace before using the installed launcher")
	}
	return nil
}

func readSourceMigrationJournal(ctx launchContext) (sourceMigrationJournal, error) {
	var journal sourceMigrationJournal
	path := filepath.Join(ctx.Instance.StateDir, ".jobctrl-source-migration.json")
	if err := decodeStrictRegular(path, &journal); err != nil {
		return journal, err
	}
	if journal.SchemaVersion != 1 || !executionIDValid(journal.ID) || journal.SourceVersion != v14JobCtrlSchemaVersion ||
		(journal.Stage != "starting" && journal.Stage != "backed_up" && journal.Stage != "candidate_ready" && journal.Stage != "activating") {
		return journal, errors.New("source migration journal is invalid; preserve the workspace")
	}
	if (journal.BackupID != "" && journal.BackupID != "source-pair-"+journal.ID) || (journal.Stage != "starting" && journal.BackupID == "") {
		return journal, errors.New("source migration backup identity is invalid")
	}
	return journal, nil
}

func refusePendingSourceMigration(ctx launchContext) error {
	_, err := readSourceMigrationJournal(ctx)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect unfinished source migration: %w", err)
	}
	return errors.New("a source workspace migration is unfinished; restart the same Git checkout to resume it")
}

func writeSourceMigrationJournal(ctx launchContext, journal sourceMigrationJournal) error {
	return writeJSONAtomic(filepath.Join(ctx.Instance.StateDir, ".jobctrl-source-migration.json"), journal)
}

func removeSourceMigrationJournal(ctx launchContext) error {
	if err := os.Remove(filepath.Join(ctx.Instance.StateDir, ".jobctrl-source-migration.json")); err != nil {
		return err
	}
	return syncDirectory(ctx.Instance.StateDir)
}

func sourceSnapshotPair(ctx launchContext, journal sourceMigrationJournal, temporal string) (string, error) {
	parent := filepath.Join(ctx.Instance.StateDir, "backups")
	if err := ensureSafeDirectory(parent); err != nil {
		return "", err
	}
	id := "source-pair-" + journal.ID
	dir := filepath.Join(parent, id)
	if err := os.Mkdir(dir, 0700); err != nil {
		return "", err
	}
	relative, err := filepath.Rel(ctx.Instance.StateDir, temporal)
	if err != nil || (relative != "temporal.db" && relative != filepath.Join("temporal", "temporal.db")) {
		return "", errors.New("Temporal history is outside the shared workspace")
	}
	pair := sourceBackup{SchemaVersion: 1, ID: id, CreatedAt: time.Now().UTC(), TemporalPath: filepath.ToSlash(relative)}
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		source := filepath.Join(ctx.Instance.StateDir, name)
		if name == "temporal.db" {
			source = temporal
		}
		dest := filepath.Join(dir, name)
		version, err := sqliteOnlineBackup(ctx.SourcePython, source, dest)
		if err != nil {
			return "", fmt.Errorf("back up %s: %w", name, err)
		}
		file, err := describeDatabase(dest, name, version)
		if err != nil {
			return "", err
		}
		pair.Files = append(pair.Files, file)
	}
	selected, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil || selected != temporal {
		return "", errors.New("Temporal history identity changed during source backup")
	}
	if pair.Files[0].SQLiteUserVer != journal.SourceVersion {
		return "", errors.New("source schema changed during backup")
	}
	if err := writeJSONAtomic(filepath.Join(dir, "source-pair.json"), pair); err != nil {
		return "", err
	}
	if err := syncDirectory(parent); err != nil {
		return "", err
	}
	return filepath.Join(dir, "jobctrl.db"), nil
}

func sourceExactV15(ctx launchContext, database string) error {
	code := `import pathlib,sqlite3,sys
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V15_MANIFEST,assert_exact_manifest
c=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+'?mode=ro',uri=True)
try:
 assert_exact_manifest(c,EXACT_V15_MANIFEST)
 if c.execute('pragma integrity_check').fetchone()!=('ok',) or c.execute('pragma foreign_key_check').fetchall(): raise RuntimeError('integrity')
finally: c.close()`
	cmd := exec.Command(ctx.SourcePython, "-I", "-B", "-c", code, database)
	cmd.Env = ctx.Environment
	if err := cmd.Run(); err != nil {
		return errors.New("migrated source database failed exact-schema or integrity validation")
	}
	return nil
}

// This is an additional refusal check, not proof of process ownership. The
// scoped cleanup above provides the ownership proof; a foreign open database
// handle is a reason not to migrate even after that cleanup succeeds.
func refuseOpenWorkspaceDatabases(database, temporal string) error {
	paths := []string{}
	for _, base := range []string{database, temporal} {
		for _, suffix := range []string{"", "-wal", "-shm", "-journal"} {
			path := base + suffix
			if _, err := os.Lstat(path); err == nil {
				paths = append(paths, path)
			} else if !errors.Is(err, os.ErrNotExist) {
				return errors.New("could not inspect workspace database companions")
			}
		}
	}
	args := append([]string{"-nP", "-Fp"}, paths...)
	command := exec.Command("/usr/sbin/lsof", args...)
	output, err := command.CombinedOutput()
	var exited *exec.ExitError
	if len(output) != 0 || !errors.As(err, &exited) || exited.ExitCode() != 1 {
		return errors.New("workspace databases may be open in another process; preserve them and stop that process before migrating")
	}
	return nil
}

// Automatic source upgrades use the same native exclusion and stopped-scope
// proof as installed updates. Untracked legacy runtimes remain diagnostic-only.
func automaticSourceMigration(ctx launchContext, output io.Writer) error {
	database := filepath.Join(ctx.Instance.StateDir, "jobctrl.db")
	if _, err := os.Lstat(database); errors.Is(err, os.ErrNotExist) {
		return nil
	} else if err != nil {
		return err
	}
	version, err := sqliteUserVersion(ctx.SourcePython, database)
	if err != nil {
		return fmt.Errorf("inspect source workspace schema: %w", err)
	}
	journal, journalErr := readSourceMigrationJournal(ctx)
	if journalErr != nil && !errors.Is(journalErr, os.ErrNotExist) {
		return journalErr
	}
	if version == currentJobCtrlSchemaVersion && errors.Is(journalErr, os.ErrNotExist) {
		return nil
	}
	// Earlier historical schemas have additional Temporal quiescence
	// requirements. The source controller currently owns the 14-to-15 path;
	// leave all other versions for the diagnostic API and supported recovery.
	if version > currentJobCtrlSchemaVersion || version < v14JobCtrlSchemaVersion {
		if journalErr == nil {
			return errors.New("source migration journal does not match the live schema; preserve both")
		}
		return nil // The API reports an incompatible or unknown schema.
	}
	values := environmentMap(ctx.Environment)
	if configured := values["JOBCTRL_DB_PATH"]; configured != "" {
		resolved, err := filepath.EvalSymlinks(configured)
		if err != nil || resolved != database {
			return errors.New("automatic source migration requires the shared workspace database path")
		}
	}
	store, err := release.Open(ctx.Instance.RuntimeHome)
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
	if installedJournal, err := store.ReadJournal(); err == nil && installedJournal.Resumable() {
		return errors.New("finish the installed update before migrating the source workspace")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	owned, err := sourceMigrationHasOwner(ctx)
	if err != nil {
		return err
	}
	if !owned {
		if journalErr == nil {
			return errors.New("unfinished source migration has unverified process ownership; preserve the workspace and journal")
		}
		_, _ = fmt.Fprintln(output, "dev: the workspace needs migration but its earlier runtime ownership is unverified; opening diagnostics without modifying data.")
		return nil
	}
	if err := stop(ctx); err != nil {
		return fmt.Errorf("stop the shared workspace before source migration: %w", err)
	}
	lock, err := acquireLock(ctx.Instance.LockPath, true)
	if err != nil {
		return err
	}
	defer releaseLock(lock)
	version, err = sqliteUserVersion(ctx.SourcePython, database)
	if err != nil {
		return err
	}
	journal, journalErr = readSourceMigrationJournal(ctx)
	if journalErr != nil && !errors.Is(journalErr, os.ErrNotExist) {
		return journalErr
	}
	if version == currentJobCtrlSchemaVersion {
		if journalErr == nil {
			if err := sourceExactV15(ctx, database); err != nil {
				return err
			}
			cleanupV15Candidate(ctx.Instance.StateDir, journal.ID)
			return removeSourceMigrationJournal(ctx)
		}
		return nil
	}
	if version != v14JobCtrlSchemaVersion || (journalErr == nil && journal.SourceVersion != version) {
		return errors.New("source migration schema changed; preserve the workspace and journal")
	}
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return err
	}
	if override := values["JOBCTRL_TEMPORAL_DB"]; override != "" {
		resolved, err := filepath.EvalSymlinks(override)
		if err != nil || resolved != temporal {
			return errors.New("automatic source migration requires the shared Temporal history")
		}
	}
	unused, err := unusedDatabasePair(ctx.Instance.StateDir)
	if err != nil || unused {
		return errors.Join(errors.New("source migration requires a complete application and Temporal pair"), err)
	}
	if err := refuseOpenWorkspaceDatabases(database, temporal); err != nil {
		return err
	}
	if journalErr == nil {
		cleanupV15Candidate(ctx.Instance.StateDir, journal.ID)
	}
	id, err := releaseRandomID()
	if err != nil {
		return err
	}
	journal = sourceMigrationJournal{SchemaVersion: 1, ID: id, SourceVersion: version, Stage: "starting"}
	if err := writeSourceMigrationJournal(ctx, journal); err != nil {
		return err
	}
	if err := sourceMigrationStage("starting"); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(output, "dev: backing up the shared workspace and upgrading its database.")
	source, err := sourceSnapshotPair(ctx, journal, temporal)
	if err != nil {
		return err
	}
	journal.BackupID, journal.Stage = "source-pair-"+id, "backed_up"
	if err := writeSourceMigrationJournal(ctx, journal); err != nil {
		return err
	}
	if err := sourceMigrationStage("backed_up"); err != nil {
		return err
	}
	if err := refuseOpenWorkspaceDatabases(database, temporal); err != nil {
		return err
	}
	candidate, err := buildV15CandidateFromSource(ctx, source, version, id)
	if err != nil {
		return err
	}
	journal.Stage = "candidate_ready"
	if err := writeSourceMigrationJournal(ctx, journal); err != nil {
		return err
	}
	if err := sourceMigrationStage("candidate_ready"); err != nil {
		return err
	}
	journal.Stage = "activating"
	if err := writeSourceMigrationJournal(ctx, journal); err != nil {
		return err
	}
	if err := sourceMigrationStage("activating"); err != nil {
		return err
	}
	if err := refuseOpenWorkspaceDatabases(database, temporal); err != nil {
		return err
	}
	if err := installSealedV15Candidate(ctx, candidate); err != nil {
		return fmt.Errorf("activate source schema; preserve the workspace and retry: %w", err)
	}
	if err := sourceMigrationStage("activated"); err != nil {
		return err
	}
	if err := sourceExactV15(ctx, database); err != nil {
		return err
	}
	cleanupV15Candidate(ctx.Instance.StateDir, journal.ID)
	if err := removeSourceMigrationJournal(ctx); err != nil {
		return err
	}
	_, _ = fmt.Fprintln(output, "dev: workspace upgrade complete; the paired backup was retained.")
	return nil
}
