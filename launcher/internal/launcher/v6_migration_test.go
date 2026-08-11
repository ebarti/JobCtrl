package launcher

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type v6ActivationFixture struct {
	runtime   string
	state     string
	python    string
	store     *release.Store
	active    release.Active
	old       release.Receipt
	candidate release.Receipt
	ctx       launchContext
}

func newV6ActivationFixture(t *testing.T) v6ActivationFixture {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	return newV6ActivationFixtureWithPython(t, python)
}

func newV6ActivationFixtureWithPython(t *testing.T, python string) v6ActivationFixture {
	t.Helper()
	runtime, state := t.TempDir(), t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	old := installLifecycleRelease(t, runtime, "local-v6-old-build-0001", 1, python)
	candidate := installLifecycleRelease(t, runtime, "local-v7-new-build-0002", 2, python)
	active, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture")
	if err != nil {
		t.Fatal(err)
	}
	verifiedOld, err := verifyInstalledReleaseForExecution(store, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(runtime, verifiedOld); err != nil {
		t.Fatal(err)
	}
	seedLifecycleSQLitePair(t, python, state, "old")
	setJobCtrlUserVersion(t, python, state, legacyJobCtrlSchemaVersion)
	return v6ActivationFixture{
		runtime: runtime, state: state, python: python, store: store, active: active, old: old, candidate: candidate,
		ctx: launchContext{
			PayloadRoot: filepath.Join(runtime, "releases", old.BuildID, "payload"),
			Instance: instance{
				RuntimeHome: runtime,
				StateDir:    state,
				StatePath:   filepath.Join(state, "state.json"),
				ControlPath: filepath.Join(state, "control.lock"),
			},
			Environment: []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime, "JOBCTRL_DIR=" + state},
		},
	}
}

func migrationIntegrationPython(t *testing.T) string {
	t.Helper()
	python := os.Getenv("JOBCTRL_MIGRATION_TEST_PYTHON")
	if python == "" {
		var err error
		python, err = exec.LookPath("python3")
		if err != nil {
			if os.Getenv("CI") != "" {
				t.Fatal("python3 is required for the native migration integration test")
			}
			t.Skip("python3 unavailable for the native migration integration test")
		}
	}
	probe := exec.Command(python, "-I", "-B", "-c", "import jobctrl.infrastructure.migrations.v6_to_v8_execute")
	if output, err := probe.CombinedOutput(); err != nil {
		if os.Getenv("CI") != "" || os.Getenv("JOBCTRL_MIGRATION_TEST_PYTHON") != "" {
			t.Fatalf("native migration integration Python is not provisioned: %v %s", err, output)
		}
		t.Skip("jobctrl migration package is unavailable to the native integration test")
	}
	return python
}

func createShippedV6Fixture(t *testing.T, python, path string) {
	t.Helper()
	automationRoot, err := filepath.Abs(filepath.Join("..", "..", "..", "workers", "automation"))
	if err != nil {
		t.Fatal(err)
	}
	code := `import pathlib,sys
sys.path.insert(0, sys.argv[1])
from tests.v6_migration_fixture import create_shipped_v6_database
create_shipped_v6_database(pathlib.Path(sys.argv[2]))`
	command := exec.Command(python, "-I", "-B", "-c", code, automationRoot, path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("create shipped-v6 migration fixture: %v %s", err, output)
	}
}

func reopenMigratedV8WithCandidateRuntime(ctx launchContext, database string) error {
	python := filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
	code := `import sys
from jobctrl.database import close_connection, open_exact_v8_database
path=sys.argv[1]
connection=open_exact_v8_database(path)
try:
    row=connection.execute("SELECT job_id,url FROM jobs").fetchone()
    if row is None or not row[0] or row[0] == row[1] or row[1] != "https://jobs.example/shipped-v6":
        raise SystemExit(2)
finally:
    close_connection(path)`
	command := exec.Command(python, "-I", "-B", "-c", code, database)
	command.Env = ctx.Environment
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("candidate runtime failed to reopen exact v8: %w: %s", err, output)
	}
	return nil
}

func reopenMigratedV8WithTypeScriptAPI(database string) error {
	apiRoot, err := filepath.Abs(filepath.Join("..", "..", "..", "apps", "api"))
	if err != nil {
		return err
	}
	runner := os.Getenv("JOBCTRL_MIGRATION_TEST_NODE")
	if runner == "" {
		var err error
		runner, err = exec.LookPath("node")
		if err != nil {
			return fmt.Errorf("locate Node.js for TypeScript API reopen probe: %w", err)
		}
	}
	probe := filepath.Join(apiRoot, "test", "support", "reopen-exact-v8.ts")
	command := exec.Command(runner, "--import", "tsx", probe, database)
	command.Dir = apiRoot
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("TypeScript API failed to reopen exact v8: %w: %s", err, output)
	}
	return nil
}

func reopenRestoredV6WithPriorRuntime(ctx launchContext, database string) error {
	python := filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
	code := `import pathlib,sqlite3,sys
uri=pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro"
connection=sqlite3.connect(uri,uri=True)
try:
    version=connection.execute("PRAGMA user_version").fetchone()[0]
    row=connection.execute("SELECT url FROM jobs").fetchone()
    if version != 6 or row != ("https://jobs.example/shipped-v6",):
        raise SystemExit(2)
finally:
    connection.close()`
	command := exec.Command(python, "-I", "-B", "-c", code, database)
	command.Env = ctx.Environment
	if output, err := command.CombinedOutput(); err != nil {
		return fmt.Errorf("prior runtime failed to reopen restored v6: %w: %s", err, output)
	}
	return nil
}

func setJobCtrlUserVersion(t *testing.T, python, state string, version int64) {
	t.Helper()
	code := "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version='+sys.argv[2]); c.commit(); c.close()"
	if output, err := exec.Command(python, "-c", code, filepath.Join(state, "jobctrl.db"), strconv.FormatInt(version, 10)).CombinedOutput(); err != nil {
		t.Fatalf("set jobctrl user_version: %v %s", err, output)
	}
}

func syntheticV7CandidateBuilder(t *testing.T, python string) func(launchContext, databasePair, string) (string, error) {
	t.Helper()
	return func(candidate launchContext, pair databasePair, journalID string) (string, error) {
		source, err := pairedDatabasePath(candidate.Instance.StateDir, pair, "jobctrl.db", legacyJobCtrlSchemaVersion)
		if err != nil {
			return "", err
		}
		path := v7CandidatePath(candidate.Instance.StateDir, journalID)
		if _, err := sqliteOnlineBackup(python, source, path); err != nil {
			return "", err
		}
		if err := os.Chmod(path, 0o600); err != nil {
			return "", err
		}
		code := "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=7'); c.commit(); c.close()"
		if output, err := exec.Command(python, "-c", code, path).CombinedOutput(); err != nil {
			return "", errors.New(strings.TrimSpace(string(output)))
		}
		return path, nil
	}
}

func postStampFailureCandidateBuilder() func(launchContext, databasePair, string) (string, error) {
	return func(candidate launchContext, pair databasePair, journalID string) (string, error) {
		source, err := pairedDatabasePath(candidate.Instance.StateDir, pair, "jobctrl.db", legacyJobCtrlSchemaVersion)
		if err != nil {
			return "", err
		}
		path := v8CandidatePath(candidate.Instance.StateDir, journalID)
		python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
		code := `import sys
from jobctrl.infrastructure.migrations.v6_to_v8_execute import CandidateExecutionError, execute_v6_to_v8_candidate
reached_after_stamp = False
def fail_after_stamp():
    global reached_after_stamp
    reached_after_stamp = True
    raise RuntimeError("synthetic post-stamp verification failure")
try:
    execute_v6_to_v8_candidate(
        sys.argv[1],
        sys.argv[2],
        migration_at="2026-07-31T14:00:00+00:00",
        _after_v8_stamp=fail_after_stamp,
    )
except CandidateExecutionError:
    if reached_after_stamp:
        print("post_stamp_failure")
        raise SystemExit(1)
raise SystemExit(2)`
		command := exec.Command(python, "-I", "-B", "-c", code, source, path)
		command.Env = candidate.Environment
		command.Dir = candidate.Instance.StateDir
		output, runErr := command.CombinedOutput()
		if runErr == nil || string(output) != "post_stamp_failure\n" {
			cleanupV8Candidate(candidate.Instance.StateDir, journalID)
			return "", errors.New("post-stamp verification failure did not reach the verifier seam")
		}
		cleanupV8Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("synthetic post-stamp verification failure")
	}
}

func preserveMigrationSeams(t *testing.T) {
	t.Helper()
	oldProof := temporalQuiescenceProof
	oldBuilder := sealedV7CandidateBuilder
	oldInstaller := sealedV7CandidateInstaller
	oldStart := startReleaseCommand
	oldFailure := transitionFailure
	oldSidecarRemoval := removeSQLiteSidecar
	t.Cleanup(func() {
		temporalQuiescenceProof = oldProof
		sealedV7CandidateBuilder = oldBuilder
		sealedV7CandidateInstaller = oldInstaller
		startReleaseCommand = oldStart
		transitionFailure = oldFailure
		removeSQLiteSidecar = oldSidecarRemoval
	})
}

func TestV6ToV7ActivationBlocksRunningOldIdentityWorkBeforeBackupOrMutation(t *testing.T) {
	preserveMigrationSeams(t)
	fixture := newV6ActivationFixture(t)
	before := lifecycleDatabaseDigests(t, fixture.state)
	proofs, builds, starts := 0, 0, 0
	temporalQuiescenceProof = func(_, _ launchContext) error {
		proofs++
		return errors.New("Temporal quiescence preflight failed")
	}
	sealedV7CandidateBuilder = func(launchContext, databasePair, string) (string, error) {
		builds++
		return "", nil
	}
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
		if receipt != fixture.old || journalID == "" {
			t.Fatalf("blocked activation executed unexpected release %#v journal=%q", receipt, journalID)
		}
		starts++
		return nil
	}

	err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard)
	if err == nil || !strings.Contains(err.Error(), "blocked before backup") {
		t.Fatalf("running workflow did not block activation: %v", err)
	}
	if proofs != 1 || builds != 0 || starts != 1 {
		t.Fatalf("blocked activation proof/build/start counts = %d/%d/%d", proofs, builds, starts)
	}
	if after := lifecycleDatabaseDigests(t, fixture.state); !sameDatabaseDigests(before, after) {
		t.Fatalf("blocked activation changed the live pair: before=%v after=%v", before, after)
	}
	if entries, readErr := os.ReadDir(filepath.Join(fixture.state, "backups")); readErr == nil && len(entries) != 0 {
		t.Fatalf("blocked activation created a paired backup before quiescence: %v", entries)
	} else if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		t.Fatal(readErr)
	}
	journal, err := fixture.store.ReadJournal()
	if err != nil || journal.State != release.RolledBack || journal.BackupID != "" {
		t.Fatalf("blocked activation journal = %#v, %v", journal, err)
	}
}

func TestV6ToV7ActivationMigratesAndExplicitRollbackReopensV6Pair(t *testing.T) {
	preserveMigrationSeams(t)
	fixture := newV6ActivationFixture(t)
	temporalQuiescenceProof = func(_, _ launchContext) error { return nil }
	sealedV7CandidateBuilder = syntheticV7CandidateBuilder(t, fixture.python)
	sealedV7CandidateInstaller = installSealedV7Candidate
	oldStarts, candidateStarts := 0, 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
		if journalID == "" {
			t.Fatal("activation execution was not bound to its journal")
		}
		switch receipt.BuildID {
		case fixture.old.BuildID:
			oldStarts++
		case fixture.candidate.BuildID:
			candidateStarts++
			if version, err := sqliteUserVersion(fixture.python, filepath.Join(fixture.state, "jobctrl.db")); err != nil || version != exactJobCtrlSchemaVersion {
				t.Fatalf("candidate did not reopen exact v7: version=%d err=%v", version, err)
			}
		default:
			t.Fatalf("unexpected release start %#v", receipt)
		}
		return nil
	}

	var output bytes.Buffer
	if err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", &output); err != nil {
		t.Fatalf("v6-to-v7 activation: %v", err)
	}
	if oldStarts != 0 || candidateStarts != 1 {
		t.Fatalf("activation start counts old=%d candidate=%d", oldStarts, candidateStarts)
	}
	active, err := fixture.store.ReadActive()
	if err != nil || active.Receipt != fixture.candidate {
		t.Fatalf("v7 activation pointer = %#v, %v", active, err)
	}
	pair, err := retainedPairForReceipt(fixture.state, fixture.old)
	if err != nil {
		t.Fatalf("pre-upgrade pair was not retained: %v", err)
	}
	jobBackup, err := pairedDatabasePath(fixture.state, pair, "jobctrl.db", legacyJobCtrlSchemaVersion)
	if err != nil {
		t.Fatal(err)
	}
	if version, err := sqliteUserVersion(fixture.python, filepath.Join(fixture.state, "jobctrl.db")); err != nil || version != exactJobCtrlSchemaVersion {
		t.Fatalf("live database is not exact v7: version=%d err=%v", version, err)
	}

	if err := rollbackExisting(fixture.ctx, fixture.store, active, fixture.old.BuildID, &output); err != nil {
		t.Fatalf("explicit previous-version rollback: %v", err)
	}
	active, err = fixture.store.ReadActive()
	if err != nil || active.Receipt != fixture.old {
		t.Fatalf("rollback pointer = %#v, %v", active, err)
	}
	if oldStarts != 1 || candidateStarts != 1 {
		t.Fatalf("rollback start counts old=%d candidate=%d", oldStarts, candidateStarts)
	}
	if version, err := sqliteUserVersion(filepath.Join(fixture.runtime, "releases", fixture.old.BuildID, "payload", "python", "bin", "python3"), filepath.Join(fixture.state, "jobctrl.db")); err != nil || version != legacyJobCtrlSchemaVersion {
		t.Fatalf("previous release did not reopen restored v6: version=%d err=%v", version, err)
	}
	restored, err := sha256Path(filepath.Join(fixture.state, "jobctrl.db"))
	if err != nil {
		t.Fatal(err)
	}
	backupDigest, err := sha256Path(jobBackup)
	if err != nil || restored != backupDigest {
		t.Fatalf("rollback did not restore exact pre-upgrade job database: restored=%s backup=%s err=%v", restored, backupDigest, err)
	}
}

func TestV6ToV8NativePrivateExecutorMigratesAndRollsBackRealSchema(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	fixture := newV6ActivationFixtureWithPython(t, python)
	database := filepath.Join(fixture.state, "jobctrl.db")
	if err := os.Remove(database); err != nil {
		t.Fatal(err)
	}
	createShippedV6Fixture(t, python, database)
	next := installLifecycleRelease(t, fixture.runtime, "local-v8-next-build-0003", 3, python)

	// Temporal quiescence has its own real gated-process regression below. This
	// test keeps that network boundary closed while crossing the production Go
	// candidate builder, private Python module, atomic install, runtime reopen,
	// retained-pair rollback, and prior-runtime reopen in one transaction.
	temporalQuiescenceProof = func(_, _ launchContext) error { return nil }
	migrationBuilds := 0
	sealedV7CandidateBuilder = func(candidate launchContext, pair databasePair, journalID string) (string, error) {
		migrationBuilds++
		return buildSealedV8Candidate(candidate, pair, journalID)
	}
	sealedV7CandidateInstaller = installSealedV8Candidate
	candidateStarts, oldStarts := 0, 0
	startReleaseCommand = func(base launchContext, receipt release.Receipt, journalID string) error {
		if journalID == "" {
			return errors.New("release start is not bound to its migration journal")
		}
		verified, err := verifyInstalledReleaseForExecution(fixture.store, receipt)
		if err != nil {
			return err
		}
		runtimeContext := verifiedReleaseContext(base, verified)
		switch receipt.BuildID {
		case fixture.candidate.BuildID, next.BuildID:
			candidateStarts++
			if err := reopenMigratedV8WithCandidateRuntime(runtimeContext, database); err != nil {
				return err
			}
			return reopenMigratedV8WithTypeScriptAPI(database)
		case fixture.old.BuildID:
			oldStarts++
			return reopenRestoredV6WithPriorRuntime(runtimeContext, database)
		default:
			return fmt.Errorf("unexpected release start %s", receipt.BuildID)
		}
	}

	var output bytes.Buffer
	if err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", &output); err != nil {
		t.Fatalf("native v6-to-v8 activation: %v", err)
	}
	active, err := fixture.store.ReadActive()
	if err != nil || active.Receipt != fixture.candidate || candidateStarts != 1 || oldStarts != 0 || migrationBuilds != 1 {
		t.Fatalf("native v8 activation = active:%#v candidate starts:%d old starts:%d migration builds:%d err:%v", active, candidateStarts, oldStarts, migrationBuilds, err)
	}
	pair, err := retainedPairForReceipt(fixture.state, fixture.old)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := pairedDatabasePath(fixture.state, pair, "jobctrl.db", legacyJobCtrlSchemaVersion)
	if err != nil {
		t.Fatal(err)
	}
	backupDigest, err := sha256Path(backup)
	if err != nil {
		t.Fatal(err)
	}
	verifiedOld, err := verifyInstalledReleaseForExecution(fixture.store, fixture.old)
	if err != nil {
		t.Fatal(err)
	}
	if err := reopenRestoredV6WithPriorRuntime(verifiedReleaseContext(fixture.ctx, verifiedOld), backup); err != nil {
		t.Fatalf("paired backup did not preserve the shipped v6 source: %v", err)
	}
	if err := promoteExisting(fixture.ctx, fixture.store, active, next.BuildID, "update", &output); err != nil {
		t.Fatalf("native exact-v8 promotion: %v", err)
	}
	active, err = fixture.store.ReadActive()
	if err != nil || active.Receipt != next || candidateStarts != 2 || oldStarts != 0 || migrationBuilds != 1 {
		t.Fatalf("native exact-v8 promotion = active:%#v candidate starts:%d old starts:%d migration builds:%d err:%v", active, candidateStarts, oldStarts, migrationBuilds, err)
	}

	if err := rollbackExisting(fixture.ctx, fixture.store, active, fixture.old.BuildID, &output); err != nil {
		t.Fatalf("native previous-version rollback: %v", err)
	}
	active, err = fixture.store.ReadActive()
	if err != nil || active.Receipt != fixture.old || candidateStarts != 2 || oldStarts != 1 || migrationBuilds != 1 {
		t.Fatalf("native v6 rollback = active:%#v candidate starts:%d old starts:%d err:%v", active, candidateStarts, oldStarts, err)
	}
	if digest, err := sha256Path(database); err != nil || digest != backupDigest {
		t.Fatalf("native rollback did not restore exact paired-backup bytes: backup=%s restored=%s err=%v", backupDigest, digest, err)
	}
}

func TestV6ToV8NativeVerificationFailureRestoresAndReopensV6(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	fixture := newV6ActivationFixtureWithPython(t, python)
	database := filepath.Join(fixture.state, "jobctrl.db")
	if err := os.Remove(database); err != nil {
		t.Fatal(err)
	}
	createShippedV6Fixture(t, python, database)

	temporalQuiescenceProof = func(_, _ launchContext) error { return nil }
	sealedV7CandidateBuilder = postStampFailureCandidateBuilder()
	sealedV7CandidateInstaller = installSealedV8Candidate
	candidateStarts, oldStarts := 0, 0
	startReleaseCommand = func(base launchContext, receipt release.Receipt, journalID string) error {
		if journalID == "" {
			return errors.New("release start is not bound to its migration journal")
		}
		verified, err := verifyInstalledReleaseForExecution(fixture.store, receipt)
		if err != nil {
			return err
		}
		runtimeContext := verifiedReleaseContext(base, verified)
		switch receipt.BuildID {
		case fixture.old.BuildID:
			oldStarts++
			return reopenRestoredV6WithPriorRuntime(runtimeContext, database)
		case fixture.candidate.BuildID:
			candidateStarts++
			if err := reopenMigratedV8WithCandidateRuntime(runtimeContext, database); err != nil {
				return err
			}
			return reopenMigratedV8WithTypeScriptAPI(database)
		default:
			return fmt.Errorf("unexpected release start %s", receipt.BuildID)
		}
	}

	var output bytes.Buffer
	if err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", &output); err == nil {
		t.Fatal("native activation unexpectedly accepted a post-stamp verification failure")
	}
	active, err := fixture.store.ReadActive()
	if err != nil || active.Receipt != fixture.old || candidateStarts != 0 || oldStarts != 1 {
		t.Fatalf("post-stamp rollback = active:%#v candidate starts:%d old starts:%d err:%v", active, candidateStarts, oldStarts, err)
	}
	pair, err := retainedPairForReceipt(fixture.state, fixture.old)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := pairedDatabasePath(fixture.state, pair, "jobctrl.db", legacyJobCtrlSchemaVersion)
	if err != nil {
		t.Fatal(err)
	}
	backupDigest, err := sha256Path(backup)
	if err != nil {
		t.Fatal(err)
	}
	if restoredDigest, err := sha256Path(database); err != nil || restoredDigest != backupDigest {
		t.Fatalf("post-stamp rollback did not restore exact v6 bytes: backup=%s restored=%s err=%v", backupDigest, restoredDigest, err)
	}

	sealedV7CandidateBuilder = buildSealedV8Candidate
	if err := promoteExisting(fixture.ctx, fixture.store, active, fixture.candidate.BuildID, "update", &output); err != nil {
		t.Fatalf("native retry after post-stamp failure: %v", err)
	}
	active, err = fixture.store.ReadActive()
	if err != nil || active.Receipt != fixture.candidate || candidateStarts != 1 || oldStarts != 1 {
		t.Fatalf("post-stamp retry = active:%#v candidate starts:%d old starts:%d err:%v", active, candidateStarts, oldStarts, err)
	}
}

func TestV6ToV7ActivationFailuresRestoreRetryableV6Pair(t *testing.T) {
	for _, stage := range []string{"before swap", "after swap"} {
		t.Run(stage, func(t *testing.T) {
			preserveMigrationSeams(t)
			fixture := newV6ActivationFixture(t)
			temporalQuiescenceProof = func(_, _ launchContext) error { return nil }
			builder := syntheticV7CandidateBuilder(t, fixture.python)
			if stage == "before swap" {
				sealedV7CandidateBuilder = func(launchContext, databasePair, string) (string, error) {
					return "", errors.New("synthetic pre-swap failure")
				}
			} else {
				sealedV7CandidateBuilder = builder
				sealedV7CandidateInstaller = func(candidate launchContext, path string) error {
					if err := installSealedV7Candidate(candidate, path); err != nil {
						return err
					}
					if version, err := sqliteUserVersion(fixture.python, filepath.Join(fixture.state, "jobctrl.db")); err != nil || version != exactJobCtrlSchemaVersion {
						t.Fatalf("post-swap fixture never activated v7: version=%d err=%v", version, err)
					}
					return errors.New("synthetic post-swap failure")
				}
			}
			oldStarts, candidateStarts := 0, 0
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
				if receipt == fixture.old {
					oldStarts++
				} else {
					candidateStarts++
				}
				return nil
			}

			err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard)
			if err == nil || !strings.Contains(err.Error(), "synthetic") {
				t.Fatalf("%s activation failure = %v", stage, err)
			}
			if oldStarts != 1 || candidateStarts != 0 {
				t.Fatalf("%s start counts old=%d candidate=%d", stage, oldStarts, candidateStarts)
			}
			if version, err := sqliteUserVersion(fixture.python, filepath.Join(fixture.state, "jobctrl.db")); err != nil || version != legacyJobCtrlSchemaVersion {
				t.Fatalf("%s did not restore retryable v6: version=%d err=%v", stage, version, err)
			}
			active, err := fixture.store.ReadActive()
			if err != nil || active.Receipt != fixture.old {
				t.Fatalf("%s active pointer = %#v, %v", stage, active, err)
			}
			journal, err := fixture.store.ReadJournal()
			if err != nil || journal.State != release.RolledBack || journal.BackupID == "" {
				t.Fatalf("%s rollback journal = %#v, %v", stage, journal, err)
			}
		})
	}
}

func TestV6ToV7InterruptedCandidateBoundariesRestoreThePairedV6State(t *testing.T) {
	for _, stage := range []release.State{release.MigrationCandidateReady, release.MigrationActivated} {
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
			builder := syntheticV7CandidateBuilder(t, fixture.python)
			candidateContext := launchContext{
				PayloadRoot: filepath.Join(fixture.runtime, "releases", fixture.candidate.BuildID, "payload"),
				Instance:    fixture.ctx.Instance,
			}
			candidatePath, err := builder(candidateContext, pair, journal.ID)
			if err != nil {
				t.Fatal(err)
			}
			if stage == release.MigrationActivated {
				if err := installSealedV7Candidate(candidateContext, candidatePath); err != nil {
					t.Fatal(err)
				}
			}
			if err := fixture.store.Advance(&journal, stage, nil); err != nil {
				t.Fatal(err)
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
			if version, err := sqliteUserVersion(fixture.python, filepath.Join(fixture.state, "jobctrl.db")); err != nil || version != legacyJobCtrlSchemaVersion {
				t.Fatalf("interrupted %s did not restore v6: version=%d err=%v", stage, version, err)
			}
			if _, err := os.Lstat(v7CandidatePath(fixture.state, journal.ID)); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("interrupted %s left candidate staging behind: %v", stage, err)
			}
			loaded, err := fixture.store.ReadJournal()
			if err != nil || loaded.State != release.RolledBack || loaded.Resumable() {
				t.Fatalf("interrupted %s journal = %#v, %v", stage, loaded, err)
			}
		})
	}
}

func TestV6ToV7RollbackDoesNotRestartOldReleaseWhenSidecarCleanupFails(t *testing.T) {
	preserveMigrationSeams(t)
	fixture := newV6ActivationFixture(t)
	temporalQuiescenceProof = func(_, _ launchContext) error { return nil }
	sealedV7CandidateBuilder = syntheticV7CandidateBuilder(t, fixture.python)
	failCleanup := false
	removeSQLiteSidecar = func(path string) error {
		if failCleanup && strings.HasSuffix(path, "temporal.db-journal") {
			return errors.New("synthetic non-removable sidecar")
		}
		return os.Remove(path)
	}
	sealedV7CandidateInstaller = func(candidate launchContext, path string) error {
		if err := installSealedV7Candidate(candidate, path); err != nil {
			return err
		}
		failCleanup = true
		return errors.New("synthetic post-swap failure")
	}
	starts := 0
	startReleaseCommand = func(launchContext, release.Receipt, string) error {
		starts++
		return nil
	}

	err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard)
	if err == nil || !strings.Contains(err.Error(), "paired rollback restore failed") || !strings.Contains(err.Error(), "sidecar") {
		t.Fatalf("sidecar cleanup failure did not fail closed: %v", err)
	}
	if starts != 0 {
		t.Fatalf("old release restarted before exact paired cleanup: starts=%d", starts)
	}
	journal, err := fixture.store.ReadJournal()
	if err != nil || journal.State != release.RollbackRestoring || !journal.Resumable() {
		t.Fatalf("sidecar failure did not remain recoverable: %#v, %v", journal, err)
	}

	failCleanup = false
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != fixture.old {
			t.Fatalf("sidecar recovery started unexpected release %#v", receipt)
		}
		starts++
		return nil
	}
	recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store)
	if !recovered || err != nil || starts != 1 {
		t.Fatalf("sidecar cleanup retry = recovered:%v starts:%d err:%v", recovered, starts, err)
	}
	if version, err := sqliteUserVersion(fixture.python, filepath.Join(fixture.state, "jobctrl.db")); err != nil || version != legacyJobCtrlSchemaVersion {
		t.Fatalf("sidecar cleanup retry did not reopen v6: version=%d err=%v", version, err)
	}
}

func TestV6MigrationQuiescenceReceiptParserIsStrictAndSanitized(t *testing.T) {
	payload, state := t.TempDir(), t.TempDir()
	python := filepath.Join(payload, "python", "bin", "python3")
	if err := os.MkdirAll(filepath.Dir(python), 0o700); err != nil {
		t.Fatal(err)
	}
	script := `#!/bin/sh
if [ "$4" = "jobctrl.infrastructure.migrations.v6_to_v7_quiescence" ]; then
  if [ "${JOBCTRL_TEST_FAIL:-}" = "1" ]; then
    printf '%s\n' "$JOBCTRL_TEST_PRIVATE" >&2
    exit 1
  fi
  printf '%s\n' "$JOBCTRL_TEST_RECEIPT"
  exit 0
fi
exit 2
`
	if err := os.WriteFile(python, []byte(script), 0o755); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{PayloadRoot: payload, Instance: instance{StateDir: state}}
	ctx.Environment = []string{`JOBCTRL_TEST_RECEIPT={"running_execution_count":0,"schema_version":1,"status":"quiescent"}`}
	if err := runTemporalQuiescenceModule(ctx); err != nil {
		t.Fatalf("valid bounded receipt rejected: %v", err)
	}
	ctx.Environment = []string{`JOBCTRL_TEST_RECEIPT={"running_execution_count":0,"schema_version":1,"status":"quiescent","unexpected":true}`}
	if err := runTemporalQuiescenceModule(ctx); err == nil || !strings.Contains(err.Error(), "invalid evidence") {
		t.Fatalf("receipt with an unknown field passed: %v", err)
	}
	private := "/private/sensitive/state.db workflow-private-id"
	ctx.Environment = []string{"JOBCTRL_TEST_FAIL=1", "JOBCTRL_TEST_PRIVATE=" + private}
	if err := runTemporalQuiescenceModule(ctx); err == nil || strings.Contains(fmt.Sprint(err), private) || err.Error() != "Temporal quiescence preflight failed" {
		t.Fatalf("private subprocess failure was not sanitized: %v", err)
	}
}

func TestV6MigrationTemporalProofRunsWithoutWorkerOrAPIAdmission(t *testing.T) {
	payload, state := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(payload, "manifest.json"), []byte("{}"), 0o600); err != nil {
		t.Fatal(err)
	}
	var manifest runtimeManifest
	if err := json.Unmarshal([]byte(validRuntimeManifest), &manifest); err != nil {
		t.Fatal(err)
	}
	for index := range manifest.Components {
		if manifest.Components[index].Name == "temporal" {
			manifest.Components[index].Arguments = []string{"60"}
		}
	}
	temporal := filepath.Join(payload, "temporal", "temporal")
	if err := os.MkdirAll(filepath.Dir(temporal), 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(state, "temporal-opened")
	bashEnvMarker := filepath.Join(state, "bash-env-sourced")
	bashEnv := filepath.Join(state, "bash-env")
	if err := os.WriteFile(bashEnv, []byte("printf sourced > \"$JOBCTRL_TEST_BASH_ENV_MARKER\"\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	temporalScript := "#!/bin/sh\nprintf opened > \"$JOBCTRL_TEST_TEMPORAL_MARKER\"\nexec /bin/sleep 60\n"
	if err := os.WriteFile(temporal, []byte(temporalScript), 0o755); err != nil {
		t.Fatal(err)
	}
	python := filepath.Join(payload, "python", "bin", "python3")
	if err := os.MkdirAll(filepath.Dir(python), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(python, []byte("#!/bin/sh\nprintf '%s\\n' '{\"running_execution_count\":0,\"schema_version\":1,\"status\":\"quiescent\"}'\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	instance := instance{
		ID:        "migration-proof-instance",
		StateDir:  state,
		StatePath: filepath.Join(state, "state.json"),
		LogDir:    filepath.Join(state, "logs"),
	}
	if err := os.MkdirAll(instance.LogDir, 0o700); err != nil {
		t.Fatal(err)
	}
	active := launchContext{
		PayloadRoot:  payload,
		Manifest:     manifest,
		Distribution: distributionManifest{BuildID: "local-v6-proof-build"},
		Instance:     instance,
		Environment: []string{
			"PATH=/usr/bin:/bin:/usr/sbin:/sbin",
			"BASH_ENV=" + bashEnv,
			"JOBCTRL_TEST_BASH_ENV_MARKER=" + bashEnvMarker,
			"JOBCTRL_TEST_TEMPORAL_MARKER=" + marker,
		},
	}
	candidate := active
	oldProbe := temporalHealthProbe
	t.Cleanup(func() { temporalHealthProbe = oldProbe })
	temporalHealthProbe = func(launchContext) error {
		if _, err := os.Lstat(marker); err != nil {
			return err
		}
		return nil
	}

	// Parent death closes every inherited pipe descriptor. Closing the gate
	// before registration reproduces that boundary without killing the test
	// process: the wrapper must exit without ever opening Temporal's database.
	unregistered, err := startGatedTemporal(active)
	if err != nil {
		t.Fatal(err)
	}
	unregistered.abandon()
	if _, err := os.Lstat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unregistered Temporal child crossed its startup gate: %v", err)
	}
	if _, err := os.Lstat(bashEnvMarker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("BASH_ENV executed before the durable Temporal gate: %v", err)
	}

	if err := proveStoppedTemporalQuiescence(active, candidate); err != nil {
		t.Fatalf("stopped-runtime Temporal proof: %v", err)
	}
	if contents, err := os.ReadFile(marker); err != nil || string(contents) != "opened" {
		t.Fatalf("registered Temporal service never crossed its gate: %q, %v", contents, err)
	}
	registry, err := readState(instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if registry.StoppedAt == nil || stateHasLiveProcesses(registry) {
		t.Fatalf("Temporal proof left a live process registry: %#v", registry)
	}
	if _, found := registry.Components["worker"]; found {
		t.Fatal("Temporal proof started or recorded a worker admission surface")
	}
	if _, found := registry.Components["api"]; found {
		t.Fatal("Temporal proof started or recorded an API admission surface")
	}
	if _, found := registry.Components["temporal"]; !found {
		t.Fatal("Temporal proof did not retain its stopped process evidence")
	}
}
