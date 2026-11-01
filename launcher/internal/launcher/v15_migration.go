package launcher

// Native binding for exact-v15 candidates. The Python payload owns the frozen
// schema migration; this layer binds it to the stopped-runtime paired backup.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var errV15SourceChanged = errors.New("v15 live source changed or has an unmanaged writer")

var v15SourceBinder = bindV15Source

type sealedV15CandidateReceipt struct {
	CandidateDataDigest string `json:"candidate_data_digest"`
	CandidateSHA256     string `json:"candidate_sha256"`
	JobCount            int    `json:"job_count"`
	SchemaVersion       int    `json:"schema_version"`
	SourceDataDigest    string `json:"source_data_digest"`
	Status              string `json:"status"`
	TableCount          int    `json:"table_count"`
	UserVersion         int64  `json:"user_version"`
}

func buildSealedV15Candidate(candidate launchContext, pair databasePair, journalID string) (string, error) {
	sourceVersion, err := pairedV15SourceSchemaVersion(pair)
	if err != nil {
		return "", err
	}
	source, err := pairedDatabasePath(candidate.Instance.StateDir, pair, "jobctrl.db", sourceVersion)
	if err != nil {
		return "", err
	}
	return buildV15CandidateFromSource(candidate, source, sourceVersion, journalID)
}

func migrationPython(ctx launchContext) string {
	if ctx.SourcePython != "" {
		return ctx.SourcePython
	}
	return filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
}

func buildV15CandidateFromSource(candidate launchContext, source string, sourceVersion int64, journalID string) (string, error) {
	path := v15CandidatePath(candidate.Instance.StateDir, journalID)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("v15 migration candidate path already exists")
	}
	python := migrationPython(candidate)
	arguments := []string{
		"-I", "-B", "-m", "jobctrl.infrastructure.migrations.legacy_to_v15_execute",
		"--source", source,
		"--candidate", path,
		"--source-version", strconv.FormatInt(sourceVersion, 10),
	}
	if sourceVersion == legacyJobCtrlSchemaVersion {
		arguments = append(arguments, "--migration-at", time.Now().UTC().Format(time.RFC3339Nano))
	}
	command := exec.Command(python, arguments...)
	command.Env = candidate.Environment
	command.Dir = candidate.Instance.StateDir
	output, err := command.Output()
	if err != nil || len(output) > 4096 {
		cleanupV15Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed exact-v15 candidate execution failed")
	}
	var receipt sealedV15CandidateReceipt
	if err := decodeSingleJSON(output, &receipt); err != nil ||
		receipt.SchemaVersion != 1 || receipt.Status != "ready" ||
		receipt.UserVersion != currentJobCtrlSchemaVersion || receipt.JobCount < 0 || receipt.TableCount != 130 ||
		!validSHA256(receipt.SourceDataDigest) || !validSHA256(receipt.CandidateDataDigest) ||
		receipt.SourceDataDigest != receipt.CandidateDataDigest || !validSHA256(receipt.CandidateSHA256) {
		cleanupV15Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed exact-v15 candidate receipt is invalid")
	}
	info, statErr := os.Lstat(path)
	if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		cleanupV15Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v15 candidate is not an owner-private regular file")
	}
	digest, digestErr := sha256Path(path)
	if digestErr != nil || digest != receipt.CandidateSHA256 {
		cleanupV15Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v15 candidate digest verification failed")
	}
	version, versionErr := sqliteUserVersion(python, path)
	if versionErr != nil || version != currentJobCtrlSchemaVersion {
		cleanupV15Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v15 candidate schema verification failed")
	}
	if err := v15SourceBinder(candidate, source, path); err != nil {
		cleanupV15Candidate(candidate.Instance.StateDir, journalID)
		return "", err
	}
	return path, nil
}

func pairedV15SourceSchemaVersion(pair databasePair) (int64, error) {
	if pair.SchemaVersion != 1 || pair.ID == "" || len(pair.Files) != 2 {
		return 0, errors.New("migration requires a complete paired backup")
	}
	for _, file := range pair.Files {
		if file.Name != "jobctrl.db" {
			continue
		}
		switch file.SQLiteUserVer {
		case legacyJobCtrlSchemaVersion, exactJobCtrlSchemaVersion, previousJobCtrlSchemaVersion,
			v9JobCtrlSchemaVersion, v10JobCtrlSchemaVersion, v11JobCtrlSchemaVersion, v12JobCtrlSchemaVersion, v13JobCtrlSchemaVersion, v14JobCtrlSchemaVersion:
			return file.SQLiteUserVer, nil
		default:
			return 0, errors.New("paired backup has an unsupported JobCtrl schema version")
		}
	}
	return 0, errors.New("paired backup does not contain jobctrl.db")
}

func installSealedV15Candidate(candidate launchContext, candidatePath string) error {
	info, err := os.Lstat(candidatePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("v15 activation candidate is not an owner-private regular file")
	}
	live := filepath.Join(candidate.Instance.StateDir, "jobctrl.db")
	if err := checkDatabasePublication(live); err != nil {
		return err
	}
	liveInfo, err := os.Lstat(live)
	if err != nil || !liveInfo.Mode().IsRegular() || liveInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("live database is not a regular file")
	}
	python := migrationPython(candidate)
	command := exec.Command(python, "-I", "-B", "-m", "jobctrl.infrastructure.migrations.v15_activation",
		"--mode", "activate", "--live", live, "--candidate", candidatePath, "--receipt", candidatePath+".source-binding.json")
	command.Env = candidate.Environment
	output, activationErr := command.CombinedOutput()
	// Preserve a publication refusal that appeared while the child was running;
	// callers must not treat it as a generic activation failure and roll back.
	if err := checkDatabasePublication(live); err != nil {
		return err
	}
	if activationErr != nil {
		if strings.TrimSpace(string(output)) == "v15_source_changed" {
			return errV15SourceChanged
		}
		return errors.New("locked exact-v15 activation failed")
	}
	version, err := sqliteUserVersion(python, live)
	if errors.Is(err, errUnresolvedDatabasePublication) {
		return err
	}
	if err != nil || version != currentJobCtrlSchemaVersion {
		return errors.New("installed v15 database did not reopen at the exact schema version")
	}
	return nil
}

func v15CandidatePath(stateDir, journalID string) string {
	digest := sha256.Sum256([]byte(journalID))
	return filepath.Join(stateDir, ".jobctrl-v15-candidate-"+hex.EncodeToString(digest[:])[:24]+".db")
}

func cleanupV15Candidate(stateDir, journalID string) {
	candidate := v15CandidatePath(stateDir, journalID)
	v14Intermediate := candidate + ".exact-v14-intermediate"
	v13Intermediate := v14Intermediate + ".exact-v13-intermediate"
	v12Intermediate := v13Intermediate + ".exact-v12-intermediate"
	v11Intermediate := v12Intermediate + ".exact-v11-intermediate"
	v10Intermediate := v11Intermediate + ".exact-v10-intermediate"
	paths := []string{
		candidate, candidate + ".source-binding.json", v14Intermediate,
		v13Intermediate, v12Intermediate, v11Intermediate, v10Intermediate,
		v10Intermediate + ".exact-v9-intermediate",
		v10Intermediate + ".exact-v9-intermediate.exact-v8-intermediate",
		v10Intermediate + ".exact-v9-intermediate.exact-v8-intermediate.exact-v7-intermediate",
	}
	for _, path := range paths {
		_ = os.Remove(path)
		for _, suffix := range []string{"-journal", "-shm", "-wal"} {
			_ = os.Remove(path + suffix)
		}
	}
}

func bindV15Source(candidate launchContext, source, path string) error {
	if err := checkDatabasePublication(filepath.Join(candidate.Instance.StateDir, "jobctrl.db")); err != nil {
		return err
	}
	python := migrationPython(candidate)
	command := exec.Command(python, "-I", "-B", "-m", "jobctrl.infrastructure.migrations.v15_activation",
		"--mode", "bind", "--source", source, "--live", filepath.Join(candidate.Instance.StateDir, "jobctrl.db"),
		"--candidate", path, "--receipt", path+".source-binding.json")
	command.Env = candidate.Environment
	output, err := command.CombinedOutput()
	if publicationErr := checkDatabasePublication(filepath.Join(candidate.Instance.StateDir, "jobctrl.db")); publicationErr != nil {
		return publicationErr
	}
	if err != nil {
		if strings.TrimSpace(string(output)) == "v15_source_changed" {
			return errV15SourceChanged
		}
		return errors.New("exact-v15 live source binding failed")
	}
	return nil
}

// A separate private intent keeps the historical journal wire shape compatible
// with the previous launcher while distinguishing refusal from a partial restore.
type v15SourcePreservationIntent struct {
	SchemaVersion int    `json:"schemaVersion"`
	JournalID     string `json:"journalId"`
	BackupID      string `json:"backupId"`
	SourceVersion int64  `json:"sourceVersion"`
}

// Interrupted transitions can have been started by the prior launcher. Read
// either version's durable preservation receipt, but reject ambiguous state.
func readMigrationSourcePreservation(stateDir, journalID string) (*v15SourcePreservationIntent, bool, error) {
	current, err := readV15SourcePreservation(stateDir, journalID)
	if err != nil {
		return nil, false, err
	}
	legacy, err := readV14SourcePreservation(stateDir, journalID)
	if err != nil {
		return nil, false, err
	}
	if current != nil && legacy != nil {
		return nil, false, errors.New("multiple source preservation intents exist for the transition")
	}
	if legacy != nil {
		return &v15SourcePreservationIntent{SchemaVersion: legacy.SchemaVersion, JournalID: legacy.JournalID,
			BackupID: legacy.BackupID, SourceVersion: legacy.SourceVersion}, true, nil
	}
	return current, false, nil
}

func v15SourcePreservationPath(stateDir, journalID string) string {
	return v15CandidatePath(stateDir, journalID) + ".preserve-source.json"
}

func readV15SourcePreservation(stateDir, journalID string) (*v15SourcePreservationIntent, error) {
	path := v15SourcePreservationPath(stateDir, journalID)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("v15 source preservation intent is not owner-private")
	}
	var intent v15SourcePreservationIntent
	if err := decodeStrictRegular(path, &intent); err != nil || intent.SchemaVersion != 1 || intent.JournalID != journalID || intent.BackupID == "" || intent.SourceVersion < 6 || intent.SourceVersion > v14JobCtrlSchemaVersion {
		return nil, errors.New("v15 source preservation intent is invalid")
	}
	return &intent, nil
}

func writeV15SourcePreservation(stateDir, journalID, backupID string, version int64) error {
	if journalID == "" || backupID == "" || version < 6 || version > v14JobCtrlSchemaVersion {
		return errors.New("v15 source preservation intent binding is invalid")
	}
	existing, err := readV15SourcePreservation(stateDir, journalID)
	if err != nil {
		return err
	}
	intent := v15SourcePreservationIntent{1, journalID, backupID, version}
	if existing != nil {
		if *existing != intent {
			return errors.New("v15 source preservation intent binding mismatch")
		}
		return nil
	}
	return writeJSONAtomic(v15SourcePreservationPath(stateDir, journalID), intent)
}

func clearV15SourcePreservation(stateDir, journalID string) error {
	if err := os.Remove(v15SourcePreservationPath(stateDir, journalID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(stateDir)
}
