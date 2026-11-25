package launcher

// Native activation glue for local schema transitions. The Python payload owns
// candidate population and exact-schema verification; this launcher boundary
// owns process quiescence, paired backup binding, atomic installation, and
// recovery.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

const (
	legacyJobCtrlSchemaVersion   = int64(6)
	exactJobCtrlSchemaVersion    = int64(7)
	previousJobCtrlSchemaVersion = int64(8)
	v9JobCtrlSchemaVersion       = int64(9)
	v10JobCtrlSchemaVersion      = int64(10)
	v11JobCtrlSchemaVersion      = int64(11)
	v12JobCtrlSchemaVersion      = int64(12)
	v13JobCtrlSchemaVersion      = int64(13)
	v14JobCtrlSchemaVersion      = int64(14)
	currentJobCtrlSchemaVersion  = int64(15)
)

var (
	errInitializationNotAdmitted     = errors.New("database initialization cannot be safely admitted")
	errUnresolvedDatabasePublication = errInitializationNotAdmitted

	// These seam names are retained for the existing lifecycle fault-injection
	// matrix. Production builds and installs the current exact-v15 candidate.
	sealedV7CandidateBuilder   = buildSealedV15Candidate
	sealedV7CandidateInstaller = installSealedV15Candidate
)

func verifiedReleaseContext(base launchContext, verified verifiedRelease) launchContext {
	return launchContext{
		Executable:   filepath.Join(verified.payloadRoot, "launcher", "jobctrl"),
		PayloadRoot:  verified.payloadRoot,
		Manifest:     verified.runtime,
		Distribution: verified.distribution,
		Instance:     base.Instance,
		Environment: childEnvironment(
			base.Environment,
			verified.payloadRoot,
			base.Instance.StateDir,
			verified.runtime,
		),
	}
}

func jobCtrlSchemaVersion(ctx launchContext) (int64, error) {
	python := filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
	return sqliteUserVersion(python, filepath.Join(ctx.Instance.StateDir, "jobctrl.db"), ctx.Environment)
}

// A retained staging hard link marks an unresolved initial publication. Do not
// let any SQLite subprocess open or recover its unfamiliar companions.
func refuseUnresolvedInitialization(database string, info os.FileInfo) error {
	entries, err := os.ReadDir(filepath.Dir(database))
	if err != nil {
		return fmt.Errorf("%w: inspect database initialization state: %v", errInitializationNotAdmitted, err)
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), ".jobctrl-init-") {
			continue
		}
		candidate, err := os.Lstat(filepath.Join(filepath.Dir(database), entry.Name(), "candidate.db"))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return fmt.Errorf("%w: inspect database initialization candidate: %v", errInitializationNotAdmitted, err)
		}
		if candidate.Mode().IsRegular() && os.SameFile(info, candidate) {
			return fmt.Errorf("%w: database initialization has an unresolved publication; preserve the database and companions and inspect the retained staging directory", errInitializationNotAdmitted)
		}
	}
	return nil
}

func checkDatabasePublication(database string) error {
	info, err := os.Lstat(database)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect database initialization state: %w", err)
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("database is not a regular file")
	}
	return refuseUnresolvedInitialization(database, info)
}

func sqliteUserVersion(python, database string, environment ...[]string) (int64, error) {
	info, err := os.Lstat(database)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("database is not a regular file")
	}
	if err := refuseUnresolvedInitialization(database, info); err != nil {
		return 0, err
	}
	code := `import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro"
c=sqlite3.connect(p,uri=True)
try: print(c.execute("PRAGMA user_version").fetchone()[0])
finally: c.close()`
	var env []string
	if len(environment) > 0 && environmentMap(environment[0])[executionQASandboxVariable] != "" {
		env = environment[0]
	}
	command := payloadCommand(env, python, "-I", "-B", "-c", code, database)
	output, err := command.Output()
	if err != nil || len(output) > 32 {
		return 0, errors.New("read SQLite schema version failed")
	}
	version, err := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	if err != nil {
		return 0, errors.New("SQLite schema version is invalid")
	}
	return version, nil
}

func pairedDatabasePath(stateDir string, pair databasePair, name string, version int64) (string, error) {
	if pair.SchemaVersion != 1 || pair.ID == "" || len(pair.Files) != 2 {
		return "", errors.New("migration requires a complete paired backup")
	}
	found := false
	for _, file := range pair.Files {
		if file.Name == name && file.SQLiteUserVer == version {
			found = true
		}
	}
	if !found {
		return "", errors.New("paired backup does not contain the required database version")
	}
	path := filepath.Join(stateDir, "backups", pair.ID, name)
	actual, err := describeDatabase(path, name, version)
	if err != nil {
		return "", err
	}
	for _, expected := range pair.Files {
		if expected.Name == name && (actual.SHA256 != expected.SHA256 || actual.SizeBytes != expected.SizeBytes) {
			return "", errors.New("paired backup database verification failed")
		}
	}
	return path, nil
}

func installSealedV7Candidate(candidate launchContext, candidatePath string) error {
	info, err := os.Lstat(candidatePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("v7 activation candidate is not an owner-private regular file")
	}
	live := filepath.Join(candidate.Instance.StateDir, "jobctrl.db")
	if err := checkDatabasePublication(live); err != nil {
		return err
	}
	liveInfo, err := os.Lstat(live)
	if err != nil || !liveInfo.Mode().IsRegular() || liveInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("live v6 database is not a regular file")
	}
	if err := os.Rename(candidatePath, live); err != nil {
		return fmt.Errorf("atomically install exact-v7 database: %w", err)
	}
	if err := cleanupSQLiteSidecars(candidate.Instance.StateDir, "jobctrl.db"); err != nil {
		return err
	}
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	if version, err := sqliteUserVersion(python, live, candidate.Environment); err != nil || version != exactJobCtrlSchemaVersion {
		return errors.New("installed v7 database did not reopen at the exact schema version")
	}
	return nil
}

func v7CandidatePath(stateDir, journalID string) string {
	digest := sha256.Sum256([]byte(journalID))
	return filepath.Join(stateDir, ".jobctrl-v7-candidate-"+hex.EncodeToString(digest[:])[:24]+".db")
}

func cleanupV7Candidate(stateDir, journalID string) {
	for _, path := range []string{
		v7CandidatePath(stateDir, journalID),
		v8CandidatePath(stateDir, journalID),
		v9CandidatePath(stateDir, journalID),
	} {
		_ = os.Remove(path)
		for _, suffix := range []string{"-journal", "-shm", "-wal"} {
			_ = os.Remove(path + suffix)
		}
	}
}

func decodeSingleJSON(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON value")
	}
	return nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}
