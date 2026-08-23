package launcher

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func fakeV9BuilderContext(t *testing.T, sourceVersion int64) (launchContext, databasePair, string, string) {
	t.Helper()
	state, payload := t.TempDir(), t.TempDir()
	pairID := "pair-v9-builder"
	pairDir := filepath.Join(state, "backups", pairID)
	if err := os.MkdirAll(pairDir, 0o700); err != nil {
		t.Fatal(err)
	}
	jobPath := filepath.Join(pairDir, "jobctrl.db")
	temporalPath := filepath.Join(pairDir, "temporal.db")
	if err := os.WriteFile(jobPath, []byte("sealed source"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(temporalPath, []byte("temporal source"), 0o600); err != nil {
		t.Fatal(err)
	}
	jobFile, err := describeDatabase(jobPath, "jobctrl.db", sourceVersion)
	if err != nil {
		t.Fatal(err)
	}
	temporalFile, err := describeDatabase(temporalPath, "temporal.db", 0)
	if err != nil {
		t.Fatal(err)
	}
	pair := databasePair{SchemaVersion: 1, ID: pairID, Files: []databaseFile{jobFile, temporalFile}}

	python := filepath.Join(payload, "python", "bin", "python3")
	if err := os.MkdirAll(filepath.Dir(python), 0o700); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
set -eu
if [ "$3" = "-m" ]; then
  [ "$4" = "$JOBCTRL_TEST_EXPECTED_MODULE" ] || exit 41
  printf '%s\n' "$@" > "$JOBCTRL_TEST_ARGUMENTS"
  candidate=""
  previous=""
  for argument in "$@"; do
    if [ "$previous" = "--candidate" ]; then candidate="$argument"; fi
    previous="$argument"
  done
  [ -n "$candidate" ] || exit 42
  umask 077
  printf '%s' "$JOBCTRL_TEST_CANDIDATE" > "$candidate"
  printf '%s\n' "$JOBCTRL_TEST_RECEIPT"
  exit 0
fi
if [ "$3" = "-c" ]; then
  printf '9\n'
  exit 0
fi
exit 43
`
	if err := os.WriteFile(python, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	candidateBytes := "sealed exact-v9 candidate"
	digest := sha256.Sum256([]byte(candidateBytes))
	receipt, err := json.Marshal(sealedV9CandidateReceipt{
		CandidateDataDigest: strings.Repeat("a", 64),
		CandidateSHA256:     hex.EncodeToString(digest[:]),
		JobCount:            1,
		SchemaVersion:       1,
		SourceDataDigest:    strings.Repeat("a", 64),
		Status:              "ready",
		TableCount:          117,
		UserVersion:         currentJobCtrlSchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	module := "jobctrl.infrastructure.migrations.v8_to_v9_execute"
	if sourceVersion == legacyJobCtrlSchemaVersion || sourceVersion == exactJobCtrlSchemaVersion {
		module = "jobctrl.infrastructure.migrations.legacy_to_v9_execute"
	}
	argumentsPath := filepath.Join(state, "migration-arguments.txt")
	ctx := launchContext{
		PayloadRoot: payload,
		Instance:    instance{StateDir: state},
		Environment: []string{
			"JOBCTRL_TEST_EXPECTED_MODULE=" + module,
			"JOBCTRL_TEST_ARGUMENTS=" + argumentsPath,
			"JOBCTRL_TEST_CANDIDATE=" + candidateBytes,
			"JOBCTRL_TEST_RECEIPT=" + string(receipt),
		},
	}
	return ctx, pair, "journal-v9-builder", argumentsPath
}

func TestBuildSealedV9CandidateDispatchesByPairedSourceVersion(t *testing.T) {
	for _, sourceVersion := range []int64{
		legacyJobCtrlSchemaVersion,
		exactJobCtrlSchemaVersion,
		previousJobCtrlSchemaVersion,
	} {
		t.Run("source-v"+strconv.FormatInt(sourceVersion, 10), func(t *testing.T) {
			ctx, pair, journalID, argumentsPath := fakeV9BuilderContext(t, sourceVersion)

			candidate, err := buildSealedV9Candidate(ctx, pair, journalID)
			if err != nil {
				t.Fatalf("build exact-v9 candidate: %v", err)
			}
			if candidate != v9CandidatePath(ctx.Instance.StateDir, journalID) {
				t.Fatalf("candidate path = %q", candidate)
			}
			arguments, err := os.ReadFile(argumentsPath)
			if err != nil {
				t.Fatal(err)
			}
			hasSourceVersion := strings.Contains(string(arguments), "--source-version")
			if hasSourceVersion != (sourceVersion < previousJobCtrlSchemaVersion) {
				t.Fatalf("source-version presence from v%d = %v", sourceVersion, hasSourceVersion)
			}
			hasMigrationAt := strings.Contains(string(arguments), "--migration-at")
			if hasMigrationAt != (sourceVersion == legacyJobCtrlSchemaVersion) {
				t.Fatalf("migration-at presence from v%d = %v", sourceVersion, hasMigrationAt)
			}
			info, err := os.Stat(candidate)
			if err != nil {
				t.Fatal(err)
			}
			if info.Mode().Perm()&0o077 != 0 {
				t.Fatalf("candidate permissions = %#o", info.Mode().Perm())
			}
		})
	}
}

func TestBuildSealedV9CandidateRejectsUnboundedReceiptAndCleansFile(t *testing.T) {
	ctx, pair, journalID, _ := fakeV9BuilderContext(t, previousJobCtrlSchemaVersion)
	for index, value := range ctx.Environment {
		if strings.HasPrefix(value, "JOBCTRL_TEST_RECEIPT=") {
			ctx.Environment[index] = `JOBCTRL_TEST_RECEIPT={"candidate_data_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","candidate_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","job_count":1,"schema_version":1,"source_data_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"ready","table_count":117,"user_version":9,"unexpected":true}`
		}
	}

	if _, err := buildSealedV9Candidate(ctx, pair, journalID); err == nil || !strings.Contains(err.Error(), "receipt is invalid") {
		t.Fatalf("unbounded receipt passed: %v", err)
	}
	if _, err := os.Lstat(v9CandidatePath(ctx.Instance.StateDir, journalID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid receipt left candidate behind: %v", err)
	}
}

func v9CandidateArtifactPaths(stateDir, journalID string) []string {
	candidate := v9CandidatePath(stateDir, journalID)
	intermediate := vLegacyToV9IntermediatePath(candidate)
	basePaths := []string{candidate, intermediate, intermediate + ".exact-v7-intermediate"}
	paths := make([]string, 0, len(basePaths)*4)
	for _, path := range basePaths {
		paths = append(paths, path)
		for _, suffix := range []string{"-journal", "-shm", "-wal"} {
			paths = append(paths, path+suffix)
		}
	}
	return paths
}

func TestInterruptedV9MigrationRecoveryRemovesCandidatesIntermediatesAndSidecars(t *testing.T) {
	for _, stage := range []release.State{release.PolicyPending, release.MigrationCandidateReady} {
		t.Run(string(stage), func(t *testing.T) {
			preserveMigrationSeams(t)
			fixture := newV6ActivationFixture(t)
			pair, err := snapshotPair(fixture.ctx, fixture.old)
			if err != nil {
				t.Fatal(err)
			}
			journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			journal.BackupID = pair.ID
			if err := fixture.store.Advance(&journal, stage, nil); err != nil {
				t.Fatal(err)
			}
			artifactPaths := v9CandidateArtifactPaths(fixture.state, journal.ID)
			for _, path := range artifactPaths {
				if err := os.WriteFile(path, []byte("owner-private migration artifact"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			oldStarts := 0
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
				if receipt != fixture.old || journalID != journal.ID {
					t.Fatalf("interrupted recovery executed unexpected release %#v journal=%q", receipt, journalID)
				}
				oldStarts++
				return nil
			}

			recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store)
			if !recovered || err != nil {
				t.Fatalf("recover interrupted %s = recovered:%v err:%v", stage, recovered, err)
			}
			if oldStarts != 1 {
				t.Fatalf("interrupted %s old starts = %d", stage, oldStarts)
			}
			for _, path := range artifactPaths {
				if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("interrupted %s left migration artifact %q behind: %v", stage, path, err)
				}
			}
			loaded, err := fixture.store.ReadJournal()
			if err != nil || loaded.State != release.RolledBack || loaded.Resumable() {
				t.Fatalf("interrupted %s journal = %#v, %v", stage, loaded, err)
			}
		})
	}
}

func syntheticV9CandidateBuilder(t *testing.T, python string, expectedSourceVersion int64) func(launchContext, databasePair, string) (string, error) {
	t.Helper()
	return func(candidate launchContext, pair databasePair, journalID string) (string, error) {
		source, err := pairedDatabasePath(candidate.Instance.StateDir, pair, "jobctrl.db", expectedSourceVersion)
		if err != nil {
			return "", err
		}
		path := v9CandidatePath(candidate.Instance.StateDir, journalID)
		if _, err := sqliteOnlineBackup(python, source, path); err != nil {
			return "", err
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return "", err
		}
		code := "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=9'); c.commit(); c.close()"
		if output, err := exec.Command(python, "-c", code, path).CombinedOutput(); err != nil {
			return "", errors.New(strings.TrimSpace(string(output)))
		}
		return path, nil
	}
}

func TestLifecycleMigratesV6V7AndV8ToV9AndRestoresExactSourceOnRollback(t *testing.T) {
	for _, sourceVersion := range []int64{
		legacyJobCtrlSchemaVersion,
		exactJobCtrlSchemaVersion,
		previousJobCtrlSchemaVersion,
	} {
		t.Run("source-v"+strconv.FormatInt(sourceVersion, 10), func(t *testing.T) {
			preserveMigrationSeams(t)
			fixture := newV6ActivationFixture(t)
			setJobCtrlUserVersion(t, fixture.python, fixture.state, sourceVersion)
			proofs := 0
			temporalQuiescenceProof = func(_, _ launchContext) error {
				proofs++
				return nil
			}
			sealedV7CandidateBuilder = syntheticV9CandidateBuilder(t, fixture.python, sourceVersion)
			sealedV7CandidateInstaller = installSealedV9Candidate
			candidateStarts, oldStarts := 0, 0
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
				if journalID == "" {
					t.Fatal("release start is not bound to a journal")
				}
				switch receipt.BuildID {
				case fixture.candidate.BuildID:
					candidateStarts++
					version, err := sqliteUserVersion(fixture.python, filepath.Join(fixture.state, "jobctrl.db"))
					if err != nil || version != currentJobCtrlSchemaVersion {
						t.Fatalf("candidate opened schema v%d, err=%v", version, err)
					}
				case fixture.old.BuildID:
					oldStarts++
				default:
					t.Fatalf("unexpected release start %#v", receipt)
				}
				return nil
			}

			if err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard); err != nil {
				t.Fatalf("promote v%d to v9: %v", sourceVersion, err)
			}
			if candidateStarts != 1 || oldStarts != 0 {
				t.Fatalf("promotion starts candidate=%d old=%d", candidateStarts, oldStarts)
			}
			expectedProofs := 0
			if sourceVersion == legacyJobCtrlSchemaVersion {
				expectedProofs = 1
			}
			if proofs != expectedProofs {
				t.Fatalf("v%d Temporal proofs = %d", sourceVersion, proofs)
			}
			active, err := fixture.store.ReadActive()
			if err != nil {
				t.Fatal(err)
			}
			if err := rollbackExisting(fixture.ctx, fixture.store, active, fixture.old.BuildID, io.Discard); err != nil {
				t.Fatalf("rollback to v%d: %v", sourceVersion, err)
			}
			version, err := sqliteUserVersion(fixture.python, filepath.Join(fixture.state, "jobctrl.db"))
			if err != nil || version != sourceVersion {
				t.Fatalf("rollback restored v%d, err=%v; expected v%d", version, err, sourceVersion)
			}
		})
	}
}
