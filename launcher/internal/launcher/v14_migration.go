package launcher

// Native binding for exact-v14 candidates. The Python payload owns the frozen
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

var errV14SourceChanged = errors.New("v14 live source changed or has an unmanaged writer")

var v14SourceBinder = bindV14Source

type sealedV14CandidateReceipt struct {
	CandidateDataDigest string `json:"candidate_data_digest"`
	CandidateSHA256     string `json:"candidate_sha256"`
	JobCount            int    `json:"job_count"`
	SchemaVersion       int    `json:"schema_version"`
	SourceDataDigest    string `json:"source_data_digest"`
	Status              string `json:"status"`
	TableCount          int    `json:"table_count"`
	UserVersion         int64  `json:"user_version"`
}

func buildSealedV14Candidate(candidate launchContext, pair databasePair, journalID string) (string, error) {
	sourceVersion, err := pairedV14SourceSchemaVersion(pair)
	if err != nil {
		return "", err
	}
	source, err := pairedDatabasePath(candidate.Instance.StateDir, pair, "jobctrl.db", sourceVersion)
	if err != nil {
		return "", err
	}
	path := v14CandidatePath(candidate.Instance.StateDir, journalID)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("v14 migration candidate path already exists")
	}
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	arguments := []string{
		"-I", "-B", "-m", "jobctrl.infrastructure.migrations.legacy_to_v14_execute",
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
		cleanupV14Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed exact-v14 candidate execution failed")
	}
	var receipt sealedV14CandidateReceipt
	if err := decodeSingleJSON(output, &receipt); err != nil ||
		receipt.SchemaVersion != 1 || receipt.Status != "ready" ||
		receipt.UserVersion != currentJobCtrlSchemaVersion || receipt.JobCount < 0 || receipt.TableCount != 128 ||
		!validSHA256(receipt.SourceDataDigest) || !validSHA256(receipt.CandidateDataDigest) ||
		receipt.SourceDataDigest != receipt.CandidateDataDigest || !validSHA256(receipt.CandidateSHA256) {
		cleanupV14Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed exact-v14 candidate receipt is invalid")
	}
	info, statErr := os.Lstat(path)
	if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		cleanupV14Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v14 candidate is not an owner-private regular file")
	}
	digest, digestErr := sha256Path(path)
	if digestErr != nil || digest != receipt.CandidateSHA256 {
		cleanupV14Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v14 candidate digest verification failed")
	}
	version, versionErr := sqliteUserVersion(python, path)
	if versionErr != nil || version != currentJobCtrlSchemaVersion {
		cleanupV14Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v14 candidate schema verification failed")
	}
	if err := v14SourceBinder(candidate, source, path); err != nil {
		cleanupV14Candidate(candidate.Instance.StateDir, journalID)
		return "", err
	}
	return path, nil
}

func pairedV14SourceSchemaVersion(pair databasePair) (int64, error) {
	if pair.SchemaVersion != 1 || pair.ID == "" || len(pair.Files) != 2 {
		return 0, errors.New("migration requires a complete paired backup")
	}
	for _, file := range pair.Files {
		if file.Name != "jobctrl.db" {
			continue
		}
		switch file.SQLiteUserVer {
		case legacyJobCtrlSchemaVersion, exactJobCtrlSchemaVersion, previousJobCtrlSchemaVersion,
			v9JobCtrlSchemaVersion, v10JobCtrlSchemaVersion, v11JobCtrlSchemaVersion, v12JobCtrlSchemaVersion, v13JobCtrlSchemaVersion:
			return file.SQLiteUserVer, nil
		default:
			return 0, errors.New("paired backup has an unsupported JobCtrl schema version")
		}
	}
	return 0, errors.New("paired backup does not contain jobctrl.db")
}

func installSealedV14Candidate(candidate launchContext, candidatePath string) error {
	info, err := os.Lstat(candidatePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("v14 activation candidate is not an owner-private regular file")
	}
	live := filepath.Join(candidate.Instance.StateDir, "jobctrl.db")
	liveInfo, err := os.Lstat(live)
	if err != nil || !liveInfo.Mode().IsRegular() || liveInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("live database is not a regular file")
	}
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	command := exec.Command(python, "-I", "-B", "-m", "jobctrl.infrastructure.migrations.v14_activation",
		"--mode", "activate", "--live", live, "--candidate", candidatePath, "--receipt", candidatePath+".source-binding.json")
	command.Env = candidate.Environment
	output, activationErr := command.CombinedOutput()
	if activationErr != nil {
		if strings.TrimSpace(string(output)) == "v14_source_changed" {
			return errV14SourceChanged
		}
		return errors.New("locked exact-v14 activation failed")
	}
	if version, err := sqliteUserVersion(python, live); err != nil || version != currentJobCtrlSchemaVersion {
		return errors.New("installed v14 database did not reopen at the exact schema version")
	}
	return nil
}

func v14CandidatePath(stateDir, journalID string) string {
	digest := sha256.Sum256([]byte(journalID))
	return filepath.Join(stateDir, ".jobctrl-v14-candidate-"+hex.EncodeToString(digest[:])[:24]+".db")
}

func cleanupV14Candidate(stateDir, journalID string) {
	candidate := v14CandidatePath(stateDir, journalID)
	v12Intermediate := candidate + ".exact-v12-intermediate"
	v11Intermediate := v12Intermediate + ".exact-v11-intermediate"
	v10Intermediate := v11Intermediate + ".exact-v10-intermediate"
	paths := []string{
		candidate,
		v12Intermediate,
		candidate + ".source-binding.json",
		v11Intermediate,
		v10Intermediate,
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

func bindV14Source(candidate launchContext, source, path string) error {
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	command := exec.Command(python, "-I", "-B", "-m", "jobctrl.infrastructure.migrations.v14_activation",
		"--mode", "bind", "--source", source, "--live", filepath.Join(candidate.Instance.StateDir, "jobctrl.db"),
		"--candidate", path, "--receipt", path+".source-binding.json")
	command.Env = candidate.Environment
	output, err := command.CombinedOutput()
	if err != nil {
		if strings.TrimSpace(string(output)) == "v14_source_changed" {
			return errV14SourceChanged
		}
		return errors.New("exact-v14 live source binding failed")
	}
	return nil
}

// A separate private intent keeps the historical journal wire shape compatible
// with the previous launcher while distinguishing refusal from a partial restore.
type v14SourcePreservationIntent struct {
	SchemaVersion int    `json:"schemaVersion"`
	JournalID     string `json:"journalId"`
	BackupID      string `json:"backupId"`
	SourceVersion int64  `json:"sourceVersion"`
}

func v14SourcePreservationPath(stateDir, journalID string) string {
	return v14CandidatePath(stateDir, journalID) + ".preserve-source.json"
}

func readV14SourcePreservation(stateDir, journalID string) (*v14SourcePreservationIntent, error) {
	path := v14SourcePreservationPath(stateDir, journalID)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, errors.New("v14 source preservation intent is not owner-private")
	}
	var intent v14SourcePreservationIntent
	if err := decodeStrictRegular(path, &intent); err != nil || intent.SchemaVersion != 1 || intent.JournalID != journalID || intent.BackupID == "" || intent.SourceVersion < 6 || intent.SourceVersion > v13JobCtrlSchemaVersion {
		return nil, errors.New("v14 source preservation intent is invalid")
	}
	return &intent, nil
}

func writeV14SourcePreservation(stateDir, journalID, backupID string, version int64) error {
	if journalID == "" || backupID == "" || version < 6 || version > v13JobCtrlSchemaVersion {
		return errors.New("v14 source preservation intent binding is invalid")
	}
	existing, err := readV14SourcePreservation(stateDir, journalID)
	if err != nil {
		return err
	}
	intent := v14SourcePreservationIntent{1, journalID, backupID, version}
	if existing != nil {
		if *existing != intent {
			return errors.New("v14 source preservation intent binding mismatch")
		}
		return nil
	}
	return writeJSONAtomic(v14SourcePreservationPath(stateDir, journalID), intent)
}

func clearV14SourcePreservation(stateDir, journalID string) error {
	if err := os.Remove(v14SourcePreservationPath(stateDir, journalID)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return syncDirectory(stateDir)
}
