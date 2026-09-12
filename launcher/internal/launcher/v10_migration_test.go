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

func fakeV10BuilderContext(t *testing.T, sourceVersion int64) (launchContext, databasePair, string, string) {
	t.Helper()
	state, payload := t.TempDir(), t.TempDir()
	pairID := "pair-v10-builder"
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
  printf '10\n'
  exit 0
fi
exit 43
`
	if err := os.WriteFile(python, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	candidateBytes := "sealed exact-v10 candidate"
	digest := sha256.Sum256([]byte(candidateBytes))
	receipt, err := json.Marshal(sealedV10CandidateReceipt{
		CandidateDataDigest: strings.Repeat("a", 64),
		CandidateSHA256:     hex.EncodeToString(digest[:]),
		JobCount:            1,
		SchemaVersion:       1,
		SourceDataDigest:    strings.Repeat("a", 64),
		Status:              "ready",
		TableCount:          118,
		UserVersion:         currentJobCtrlSchemaVersion,
	})
	if err != nil {
		t.Fatal(err)
	}
	module := "jobctrl.infrastructure.migrations.v9_to_v10_execute"
	if sourceVersion < v9JobCtrlSchemaVersion {
		module = "jobctrl.infrastructure.migrations.legacy_to_v10_execute"
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
	return ctx, pair, "journal-v10-builder", argumentsPath
}

func TestBuildSealedV10CandidateDispatchesByPairedSourceVersion(t *testing.T) {
	for _, sourceVersion := range []int64{
		legacyJobCtrlSchemaVersion,
		exactJobCtrlSchemaVersion,
		previousJobCtrlSchemaVersion,
		v9JobCtrlSchemaVersion,
	} {
		t.Run("source-v"+strconv.FormatInt(sourceVersion, 10), func(t *testing.T) {
			ctx, pair, journalID, argumentsPath := fakeV10BuilderContext(t, sourceVersion)

			candidate, err := buildSealedV10Candidate(ctx, pair, journalID)
			if err != nil {
				t.Fatalf("build exact-v10 candidate: %v", err)
			}
			if candidate != v10CandidatePath(ctx.Instance.StateDir, journalID) {
				t.Fatalf("candidate path = %q", candidate)
			}
			arguments, err := os.ReadFile(argumentsPath)
			if err != nil {
				t.Fatal(err)
			}
			hasSourceVersion := strings.Contains(string(arguments), "--source-version")
			if hasSourceVersion != (sourceVersion < v9JobCtrlSchemaVersion) {
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

func TestBuildSealedV10CandidateRejectsUnknownReceiptFieldsAndCleansFile(t *testing.T) {
	ctx, pair, journalID, _ := fakeV10BuilderContext(t, previousJobCtrlSchemaVersion)
	for index, value := range ctx.Environment {
		if strings.HasPrefix(value, "JOBCTRL_TEST_RECEIPT=") {
			ctx.Environment[index] = `JOBCTRL_TEST_RECEIPT={"candidate_data_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","candidate_sha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","job_count":1,"schema_version":1,"source_data_digest":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"ready","table_count":117,"user_version":10,"unexpected":true}`
		}
	}

	if _, err := buildSealedV10Candidate(ctx, pair, journalID); err == nil || !strings.Contains(err.Error(), "receipt is invalid") {
		t.Fatalf("unbounded receipt passed: %v", err)
	}
	if _, err := os.Lstat(v10CandidatePath(ctx.Instance.StateDir, journalID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("invalid receipt left candidate behind: %v", err)
	}
}

func v10CandidateArtifactPaths(stateDir, journalID string) []string {
	candidate := v10CandidatePath(stateDir, journalID)
	intermediate := vLegacyToV10IntermediatePath(candidate)
	basePaths := []string{candidate, intermediate, intermediate + ".exact-v8-intermediate", intermediate + ".exact-v8-intermediate.exact-v7-intermediate"}
	paths := make([]string, 0, len(basePaths)*4)
	for _, path := range basePaths {
		paths = append(paths, path)
		for _, suffix := range []string{"-journal", "-shm", "-wal"} {
			paths = append(paths, path+suffix)
		}
	}
	return paths
}

func TestInterruptedV10MigrationRecoveryRemovesCandidatesIntermediatesAndSidecars(t *testing.T) {
	for _, stage := range []release.State{release.PolicyPending, release.MigrationCandidateReady, release.MigrationActivated} {
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
			artifactPaths := v10CandidateArtifactPaths(fixture.state, journal.ID)
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

func syntheticV10CandidateBuilder(t *testing.T, python string, expectedSourceVersion int64) func(launchContext, databasePair, string) (string, error) {
	t.Helper()
	return func(candidate launchContext, pair databasePair, journalID string) (string, error) {
		source, err := pairedDatabasePath(candidate.Instance.StateDir, pair, "jobctrl.db", expectedSourceVersion)
		if err != nil {
			return "", err
		}
		path := v10CandidatePath(candidate.Instance.StateDir, journalID)
		if _, err := sqliteOnlineBackup(python, source, path); err != nil {
			return "", err
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return "", err
		}
		code := "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=10'); c.commit(); c.close()"
		if output, err := exec.Command(python, "-c", code, path).CombinedOutput(); err != nil {
			return "", errors.New(strings.TrimSpace(string(output)))
		}
		return path, nil
	}
}

func TestLifecycleMigratesV6V7V8AndV9ToV10AndRestoresExactSourceOnRollback(t *testing.T) {
	for _, sourceVersion := range []int64{
		legacyJobCtrlSchemaVersion,
		exactJobCtrlSchemaVersion,
		previousJobCtrlSchemaVersion,
		v9JobCtrlSchemaVersion,
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
			sealedV7CandidateBuilder = syntheticV10CandidateBuilder(t, fixture.python, sourceVersion)
			sealedV7CandidateInstaller = installSealedV10Candidate
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
				t.Fatalf("promote v%d to v10: %v", sourceVersion, err)
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

// Cross the production Go/Python boundary using exact, populated source schemas.
// Startup is intercepted, but admission still runs in both shipped runtimes.
func TestV10NativeExactSourcesRestorePairedState(t *testing.T) {
	for _, scenario := range []struct {
		version       int64
		failReadiness bool
	}{{7, false}, {8, false}, {9, false}, {9, true}} {
		name := "source-v" + strconv.FormatInt(scenario.version, 10)
		if scenario.failReadiness {
			name += "-readiness-failure"
		}
		t.Run(name, func(t *testing.T) {
			preserveMigrationSeams(t)
			python := migrationIntegrationPython(t)
			fixture := newV6ActivationFixtureWithPython(t, python)
			database := filepath.Join(fixture.state, "jobctrl.db")
			if err := os.Remove(database); err != nil {
				t.Fatal(err)
			}
			code := `import importlib,sqlite3,sys
v=int(sys.argv[2]); c=sqlite3.connect(sys.argv[1])
m=importlib.import_module('jobctrl.infrastructure.migrations.schema_v'+str(v))
getattr(m,'create_exact_v'+str(v)+'_schema')(c)
c.execute("INSERT INTO jobs(tenant_id,job_id,url,title,application_url) VALUES('local','019ed290-3340-7000-8000-000000000891','https://jobs.example/shipped-v6','Preserved title','https://apply.example/legacy')")
c.execute("INSERT INTO job_enrichments(tenant_id,job_id,current_status,application_url,attempts_json,updated_at) VALUES('local','019ed290-3340-7000-8000-000000000891','completed','https://apply.example/canonical','[]','preserved-time')")
c.commit(); c.close()`
			if output, err := exec.Command(python, "-I", "-B", "-c", code, database, strconv.FormatInt(scenario.version, 10)).CombinedOutput(); err != nil {
				t.Fatalf("seed exact source: %v %s", err, output)
			}
			sealedV7CandidateBuilder = buildSealedV10Candidate
			sealedV7CandidateInstaller = installSealedV10Candidate
			temporalQuiescenceProof = func(_, _ launchContext) error { t.Fatal("v7+ requested v6 Temporal identity proof"); return nil }
			assertRestored := func() {
				t.Helper()
				pair, err := retainedPairForReceipt(fixture.state, fixture.old)
				if err != nil {
					t.Fatal(err)
				}
				for _, expected := range pair.Files {
					actual, err := sha256Path(filepath.Join(fixture.state, expected.Name))
					if err != nil || actual != expected.SHA256 {
						t.Fatalf("restored %s differs from paired backup: %s / %s, %v", expected.Name, actual, expected.SHA256, err)
					}
				}
				code := `import sqlite3,sys
from jobctrl.infrastructure.migrations import schema_manifest
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
v=int(sys.argv[2])
assert c.execute('PRAGMA user_version').fetchone()[0] == v
schema_manifest.assert_exact_manifest(c,getattr(schema_manifest,'EXACT_V'+str(v)+'_MANIFEST'))
assert c.execute('SELECT application_url FROM jobs').fetchone() == ('https://apply.example/legacy',)
c.close()`
				if output, err := exec.Command(python, "-I", "-B", "-c", code, database, strconv.FormatInt(scenario.version, 10)).CombinedOutput(); err != nil {
					t.Fatalf("reopen restored schema: %v %s", err, output)
				}
			}
			candidateStarts, oldStarts := 0, 0
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
				if journalID == "" {
					t.Fatal("startup has no journal binding")
				}
				if receipt == fixture.old {
					oldStarts++
					assertRestored()
					return nil
				}
				if receipt != fixture.candidate {
					t.Fatalf("unexpected startup %#v", receipt)
				}
				candidateStarts++
				code := `import sys
from jobctrl.database import open_exact_v10_database,close_connection
c=open_exact_v10_database(sys.argv[1])
assert c.execute('PRAGMA user_version').fetchone()[0] == 10
assert 'application_url' not in {r[1] for r in c.execute('PRAGMA table_info(jobs)')}
assert tuple(c.execute('SELECT title FROM jobs').fetchone()) == ('Preserved title',)
assert tuple(c.execute('SELECT application_url,updated_at FROM job_enrichments').fetchone()) == ('https://apply.example/canonical','preserved-time')
assert {r[0] for r in c.execute('SELECT application_url FROM job_application_locators')} == {'https://apply.example/legacy','https://apply.example/canonical'}
assert not c.execute('PRAGMA foreign_key_check').fetchall()
close_connection(sys.argv[1])`
				if output, err := exec.Command(python, "-I", "-B", "-c", code, database).CombinedOutput(); err != nil {
					t.Fatalf("native v10 admission/transfer: %v %s", err, output)
				}
				if err := reopenMigratedV10WithTypeScriptAPI(database); err != nil {
					t.Fatal(err)
				}
				// Make Temporal restoration observable rather than relying on an unchanged file.
				code = "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE t SET v='candidate-temporal'\"); c.commit(); c.close()"
				if output, err := exec.Command(python, "-I", "-B", "-c", code, filepath.Join(fixture.state, "temporal.db")).CombinedOutput(); err != nil {
					t.Fatalf("write owned Temporal marker: %v %s", err, output)
				}
				if scenario.failReadiness {
					return errors.New("synthetic v10 readiness failure")
				}
				return nil
			}
			err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard)
			journal, journalErr := fixture.store.ReadJournal()
			if journalErr != nil {
				t.Fatal(journalErr)
			}
			migrationJournalID := journal.ID
			if scenario.failReadiness {
				if err == nil || !strings.Contains(err.Error(), "synthetic v10 readiness failure") {
					t.Fatalf("readiness failure result: %v", err)
				}
			} else {
				if err != nil {
					t.Fatalf("native promotion: %v", err)
				}
				active, err := fixture.store.ReadActive()
				if err != nil || active.Receipt != fixture.candidate {
					t.Fatalf("candidate pointer: %#v %v", active, err)
				}
				if err := rollbackExisting(fixture.ctx, fixture.store, active, fixture.old.BuildID, io.Discard); err != nil {
					t.Fatalf("explicit rollback: %v", err)
				}
			}
			active, err := fixture.store.ReadActive()
			if err != nil || active.Receipt != fixture.old || candidateStarts != 1 || oldStarts != 1 {
				t.Fatalf("final pointer=%#v candidate=%d old=%d err=%v", active, candidateStarts, oldStarts, err)
			}
			assertRestored()
			for _, path := range v10CandidateArtifactPaths(fixture.state, migrationJournalID) {
				if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("left migration artifact %s: %v", path, err)
				}
			}
		})
	}
}

func TestV10FreshRuntimePromotesWithoutMigration(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	fixture := newV6ActivationFixtureWithPython(t, python)
	database := filepath.Join(fixture.state, "jobctrl.db")
	if err := os.Remove(database); err != nil {
		t.Fatal(err)
	}
	code := `import sys
from jobctrl.database import create_exact_v10_database,close_connection
c=create_exact_v10_database(sys.argv[1])
assert c.execute('PRAGMA user_version').fetchone()[0] == 10
assert 'application_url' not in {r[1] for r in c.execute('PRAGMA table_info(jobs)')}
close_connection(sys.argv[1])`
	if output, err := exec.Command(python, "-I", "-B", "-c", code, database).CombinedOutput(); err != nil {
		t.Fatalf("fresh v10 creation: %v %s", err, output)
	}
	sealedV7CandidateBuilder = func(_ launchContext, _ databasePair, _ string) (string, error) {
		t.Fatal("fresh v10 attempted migration")
		return "", nil
	}
	starts := 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != fixture.candidate {
			t.Fatalf("unexpected fresh startup %#v", receipt)
		}
		starts++
		code := "import sys; from jobctrl.database import open_exact_v10_database,close_connection; open_exact_v10_database(sys.argv[1]); close_connection(sys.argv[1])"
		if output, err := exec.Command(python, "-I", "-B", "-c", code, database).CombinedOutput(); err != nil {
			t.Fatalf("fresh v10 admission: %v %s", err, output)
		}
		return nil
	}
	if err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard); err != nil || starts != 1 {
		t.Fatalf("fresh promotion: starts=%d err=%v", starts, err)
	}
}

func TestBuildSealedV10CandidateRejectsBrokenSeal(t *testing.T) {
	for _, field := range []string{"source_data_digest", "candidate_sha256", "user_version", "oversized"} {
		t.Run(field, func(t *testing.T) {
			ctx, pair, journalID, _ := fakeV10BuilderContext(t, v9JobCtrlSchemaVersion)
			for index, value := range ctx.Environment {
				if !strings.HasPrefix(value, "JOBCTRL_TEST_RECEIPT=") {
					continue
				}
				var receipt map[string]any
				if err := json.Unmarshal([]byte(strings.TrimPrefix(value, "JOBCTRL_TEST_RECEIPT=")), &receipt); err != nil {
					t.Fatal(err)
				}
				if field == "user_version" {
					receipt[field] = 9
				} else {
					receipt[field] = strings.Repeat("b", 64)
				}
				encoded, err := json.Marshal(receipt)
				if err != nil {
					t.Fatal(err)
				}
				if field == "oversized" {
					encoded = []byte(strings.Repeat(" ", 4097) + string(encoded))
				}
				ctx.Environment[index] = "JOBCTRL_TEST_RECEIPT=" + string(encoded)
			}
			if _, err := buildSealedV10Candidate(ctx, pair, journalID); err == nil {
				t.Fatal("invalid seal accepted")
			}
			if _, err := os.Lstat(v10CandidatePath(ctx.Instance.StateDir, journalID)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("invalid seal left candidate: %v", err)
			}
		})
	}
}

func TestV10NativeExecutorRejectsMerelyStampedV9WithoutChangingPair(t *testing.T) {
	python := migrationIntegrationPython(t)
	fixture := newV6ActivationFixtureWithPython(t, python)
	// The generic fixture contains only t(v), deliberately not the exact v9 shape.
	setJobCtrlUserVersion(t, python, fixture.state, 9)
	pair, err := snapshotPair(fixture.ctx, fixture.old)
	if err != nil {
		t.Fatal(err)
	}
	before := lifecycleDatabaseDigests(t, fixture.state)
	candidate := fixture.ctx
	candidate.PayloadRoot = filepath.Join(fixture.runtime, "releases", fixture.candidate.BuildID, "payload")
	journalID := "reject-malformed-v9"
	if _, err := buildSealedV10Candidate(candidate, pair, journalID); err == nil {
		t.Fatal("merely stamped v9 source was admitted")
	}
	for name, expected := range before {
		actual, err := sha256Path(filepath.Join(fixture.state, name))
		if err != nil || actual != expected {
			t.Fatalf("rejected migration changed live %s: %s / %s, %v", name, actual, expected, err)
		}
	}
	for _, expected := range pair.Files {
		actual, err := sha256Path(filepath.Join(fixture.state, "backups", pair.ID, expected.Name))
		if err != nil || actual != expected.SHA256 {
			t.Fatalf("rejected migration changed paired %s: %s / %s, %v", expected.Name, actual, expected.SHA256, err)
		}
	}
	for _, path := range v10CandidateArtifactPaths(fixture.state, journalID) {
		if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
			t.Errorf("rejected source left artifact %s: %v", path, err)
		}
	}
}
