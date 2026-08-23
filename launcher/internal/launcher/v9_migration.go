package launcher

// Native binding for exact-v9 candidates. Existing v6/v7 installations retain
// their private identity/compensation migration path through exact v8; exact-v8
// installations receive only the additive optional position-summary column.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"time"
)

type sealedV9CandidateReceipt struct {
	CandidateDataDigest string `json:"candidate_data_digest"`
	CandidateSHA256     string `json:"candidate_sha256"`
	JobCount            int    `json:"job_count"`
	SchemaVersion       int    `json:"schema_version"`
	SourceDataDigest    string `json:"source_data_digest"`
	Status              string `json:"status"`
	TableCount          int    `json:"table_count"`
	UserVersion         int64  `json:"user_version"`
}

func buildSealedV9Candidate(candidate launchContext, pair databasePair, journalID string) (string, error) {
	sourceVersion, err := pairedV9SourceSchemaVersion(pair)
	if err != nil {
		return "", err
	}
	source, err := pairedDatabasePath(candidate.Instance.StateDir, pair, "jobctrl.db", sourceVersion)
	if err != nil {
		return "", err
	}
	path := v9CandidatePath(candidate.Instance.StateDir, journalID)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("v9 migration candidate path already exists")
	}
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	module := ""
	arguments := []string{"-I", "-B", "-m"}
	switch sourceVersion {
	case legacyJobCtrlSchemaVersion, exactJobCtrlSchemaVersion:
		module = "jobctrl.infrastructure.migrations.legacy_to_v9_execute"
	case previousJobCtrlSchemaVersion:
		module = "jobctrl.infrastructure.migrations.v8_to_v9_execute"
	default:
		return "", errors.New("unsupported source schema for exact-v9 migration")
	}
	arguments = append(arguments, module, "--source", source, "--candidate", path)
	if sourceVersion == legacyJobCtrlSchemaVersion || sourceVersion == exactJobCtrlSchemaVersion {
		arguments = append(arguments, "--source-version", strconv.FormatInt(sourceVersion, 10))
	}
	if sourceVersion == legacyJobCtrlSchemaVersion {
		arguments = append(arguments, "--migration-at", time.Now().UTC().Format(time.RFC3339Nano))
	}
	command := exec.Command(python, arguments...)
	command.Env = candidate.Environment
	command.Dir = candidate.Instance.StateDir
	output, err := command.Output()
	if err != nil || len(output) > 4096 {
		cleanupV9Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed exact-v9 candidate execution failed")
	}
	var receipt sealedV9CandidateReceipt
	if err := decodeSingleJSON(output, &receipt); err != nil ||
		receipt.SchemaVersion != 1 || receipt.Status != "ready" ||
		receipt.UserVersion != currentJobCtrlSchemaVersion || receipt.JobCount < 0 || receipt.TableCount < 1 ||
		!validSHA256(receipt.SourceDataDigest) || !validSHA256(receipt.CandidateDataDigest) ||
		receipt.SourceDataDigest != receipt.CandidateDataDigest || !validSHA256(receipt.CandidateSHA256) {
		cleanupV9Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed exact-v9 candidate receipt is invalid")
	}
	info, statErr := os.Lstat(path)
	if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		cleanupV9Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v9 candidate is not an owner-private regular file")
	}
	digest, digestErr := sha256Path(path)
	if digestErr != nil || digest != receipt.CandidateSHA256 {
		cleanupV9Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v9 candidate digest verification failed")
	}
	version, versionErr := sqliteUserVersion(python, path)
	if versionErr != nil || version != currentJobCtrlSchemaVersion {
		cleanupV9Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v9 candidate schema verification failed")
	}
	return path, nil
}

func pairedV9SourceSchemaVersion(pair databasePair) (int64, error) {
	if pair.SchemaVersion != 1 || pair.ID == "" || len(pair.Files) != 2 {
		return 0, errors.New("migration requires a complete paired backup")
	}
	for _, file := range pair.Files {
		if file.Name != "jobctrl.db" {
			continue
		}
		switch file.SQLiteUserVer {
		case legacyJobCtrlSchemaVersion, exactJobCtrlSchemaVersion, previousJobCtrlSchemaVersion:
			return file.SQLiteUserVer, nil
		default:
			return 0, errors.New("paired backup has an unsupported JobCtrl schema version")
		}
	}
	return 0, errors.New("paired backup does not contain jobctrl.db")
}

func installSealedV9Candidate(candidate launchContext, candidatePath string) error {
	info, err := os.Lstat(candidatePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("v9 activation candidate is not an owner-private regular file")
	}
	live := filepath.Join(candidate.Instance.StateDir, "jobctrl.db")
	liveInfo, err := os.Lstat(live)
	if err != nil || !liveInfo.Mode().IsRegular() || liveInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("live database is not a regular file")
	}
	if err := os.Rename(candidatePath, live); err != nil {
		return errors.New("atomically install exact-v9 database")
	}
	if err := cleanupSQLiteSidecars(candidate.Instance.StateDir, "jobctrl.db"); err != nil {
		return err
	}
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	if version, err := sqliteUserVersion(python, live); err != nil || version != currentJobCtrlSchemaVersion {
		return errors.New("installed v9 database did not reopen at the exact schema version")
	}
	return nil
}

func v9CandidatePath(stateDir, journalID string) string {
	digest := sha256.Sum256([]byte(journalID))
	return filepath.Join(stateDir, ".jobctrl-v9-candidate-"+hex.EncodeToString(digest[:])[:24]+".db")
}

func vLegacyToV9IntermediatePath(candidatePath string) string {
	return candidatePath + ".exact-v8-intermediate"
}

func cleanupV9Candidate(stateDir, journalID string) {
	candidate := v9CandidatePath(stateDir, journalID)
	intermediate := vLegacyToV9IntermediatePath(candidate)
	for _, path := range []string{candidate, intermediate, intermediate + ".exact-v7-intermediate"} {
		_ = os.Remove(path)
		for _, suffix := range []string{"-journal", "-shm", "-wal"} {
			_ = os.Remove(path + suffix)
		}
	}
}
