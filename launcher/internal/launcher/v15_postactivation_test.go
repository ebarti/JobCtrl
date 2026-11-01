package launcher

import (
	"crypto/sha256"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// Record every owned state file, including SQLite companions, retained
// candidates and backups, plus the durable release selection and journal.
func snapshotPreservedTransition(t *testing.T, f v6ActivationFixture) map[string]string {
	t.Helper()
	files := make(map[string]string)
	record := func(path string) error {
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		files[path] = fmt.Sprintf("%x", sha256.Sum256(data))
		return nil
	}
	if err := filepath.WalkDir(f.state, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			return record(path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(f.runtime, release.ActiveFile), filepath.Join(f.runtime, release.JournalFile), filepath.Join(f.runtime, "bin", "jobctrl")} {
		if err := record(path); err != nil {
			t.Fatal(err)
		}
	}
	return files
}

func assertRepeatedRecoveryRefusesWithoutMutation(t *testing.T, f v6ActivationFixture) {
	t.Helper()
	journal, err := f.store.ReadJournal()
	if err != nil || !journal.Resumable() || !journal.PreserveLiveOnFailure {
		t.Fatalf("transition is not durably fenced: %#v, %v", journal, err)
	}
	before := snapshotPreservedTransition(t, f)
	for attempt := 0; attempt < 2; attempt++ {
		recovered, err := recoverInterruptedTransition(f.ctx, f.store)
		if recovered || err == nil || !strings.Contains(err.Error(), "retain the live databases") {
			t.Fatalf("recovery attempt %d: recovered=%v error=%v", attempt, recovered, err)
		}
		if after := snapshotPreservedTransition(t, f); !reflect.DeepEqual(before, after) {
			t.Fatalf("recovery attempt %d changed the live pair, sidecars, backup, journal or release selection", attempt)
		}
	}
}

// Exercise independent writers after real v15 activation before candidate failure.
func TestV15FailurePreservesPostActivationCommits(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	f := newV6ActivationFixtureWithPython(t, python)
	database := filepath.Join(f.state, "jobctrl.db")
	temporal := filepath.Join(f.state, "temporal.db")
	if err := os.Remove(database); err != nil {
		t.Fatal(err)
	}
	seed := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
c=sqlite3.connect(sys.argv[1]); create_exact_v14_schema(c)
c.execute("INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','019ed290-3340-7000-8000-000000000891','https://jobs.example/qa','before-backup')");c.commit();c.close()`
	if out, err := exec.Command(python, "-I", "-B", "-c", seed, database).CombinedOutput(); err != nil {
		t.Fatalf("seed %v %s", err, out)
	}
	sealedV7CandidateBuilder = buildSealedV15Candidate
	sealedV7CandidateInstaller = installSealedV15Candidate
	starts, oldStarts := 0, 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
		if receipt == f.old {
			oldStarts++
			return nil
		}
		if receipt != f.candidate {
			t.Fatalf("unexpected receipt %v", receipt)
		}
		starts++
		// These are two separate independent SQLite connections after v15 activation.
		write := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); assert c.execute('PRAGMA user_version').fetchone()[0] == 15
c.execute("UPDATE jobs SET title='post-activation-commit' WHERE tenant_id='local'"); c.commit(); c.close()
c=sqlite3.connect(sys.argv[2]); c.execute("UPDATE t SET v='post-activation-temporal'"); c.commit(); c.close()`
		if out, err := exec.Command(python, "-I", "-B", "-c", write, database, temporal).CombinedOutput(); err != nil {
			t.Fatalf("independent write %v %s", err, out)
		}
		t.Log("independent connections committed after schema v15 activation")
		return errors.New("synthetic generic candidate readiness failure")
	}
	err := promoteExisting(f.ctx, f.store, f.active, f.candidate.BuildID, "update", io.Discard)
	if err == nil || !strings.Contains(err.Error(), "synthetic generic candidate readiness failure") {
		t.Fatalf("promotion result %v", err)
	}
	if starts != 1 || oldStarts != 0 {
		t.Fatalf("candidate starts %d; predecessor starts %d", starts, oldStarts)
	}
	read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print('job_version=',c.execute('PRAGMA user_version').fetchone()[0]); print('job_title=',c.execute('SELECT title FROM jobs').fetchone()[0]); c.close()
c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True); print('temporal=',c.execute('SELECT v FROM t').fetchone()[0]);c.close()`
	out, e := exec.Command(python, "-I", "-B", "-c", read, database, temporal).CombinedOutput()
	if e != nil {
		t.Fatalf("readback %v %s", e, out)
	}
	t.Logf("after rollback: %s", out)
	if !strings.Contains(string(out), "post-activation-temporal") || !strings.Contains(string(out), "job_title= post-activation-commit") || !strings.Contains(string(out), "job_version= 15") {
		t.Fatalf("unexpected rollback state %s", out)
	}
	assertRepeatedRecoveryRefusesWithoutMutation(t, f)
}

func TestV15SameVersionFailurePreservesPostStartCommits(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	f := newV6ActivationFixtureWithPython(t, python)
	database := filepath.Join(f.state, "jobctrl.db")
	temporal := filepath.Join(f.state, "temporal.db")
	if err := os.Remove(database); err != nil {
		t.Fatal(err)
	}
	seed := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v15 import create_exact_v15_schema
c=sqlite3.connect(sys.argv[1]); create_exact_v15_schema(c)
c.execute("INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','019ed290-3340-7000-8000-000000000891','https://jobs.example/qa','before-backup')");c.commit();c.close()`
	if out, err := exec.Command(python, "-I", "-B", "-c", seed, database).CombinedOutput(); err != nil {
		t.Fatalf("seed %v %s", err, out)
	}
	sealedV7CandidateBuilder = buildSealedV15Candidate
	sealedV7CandidateInstaller = installSealedV15Candidate
	starts, oldStarts := 0, 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
		if receipt == f.old {
			oldStarts++
			return nil
		}
		if receipt != f.candidate {
			t.Fatalf("unexpected receipt %v", receipt)
		}
		starts++
		// These are two separate independent SQLite connections after v15 activation.
		write := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); assert c.execute('PRAGMA user_version').fetchone()[0] == 15
c.execute("UPDATE jobs SET title='post-activation-commit' WHERE tenant_id='local'"); c.commit(); c.close()
c=sqlite3.connect(sys.argv[2]); c.execute("UPDATE t SET v='post-activation-temporal'"); c.commit(); c.close()`
		if out, err := exec.Command(python, "-I", "-B", "-c", write, database, temporal).CombinedOutput(); err != nil {
			t.Fatalf("independent write %v %s", err, out)
		}
		t.Log("independent connections committed after schema v15 activation")
		return errors.New("synthetic generic candidate readiness failure")
	}
	err := promoteExisting(f.ctx, f.store, f.active, f.candidate.BuildID, "update", io.Discard)
	if err == nil || !strings.Contains(err.Error(), "synthetic generic candidate readiness failure") {
		t.Fatalf("promotion result %v", err)
	}
	if starts != 1 || oldStarts != 0 {
		t.Fatalf("candidate starts %d; predecessor starts %d", starts, oldStarts)
	}
	read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True); print('job_version=',c.execute('PRAGMA user_version').fetchone()[0]); print('job_title=',c.execute('SELECT title FROM jobs').fetchone()[0]); c.close()
c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True); print('temporal=',c.execute('SELECT v FROM t').fetchone()[0]);c.close()`
	out, e := exec.Command(python, "-I", "-B", "-c", read, database, temporal).CombinedOutput()
	if e != nil {
		t.Fatalf("readback %v %s", e, out)
	}
	t.Logf("after rollback: %s", out)
	if !strings.Contains(string(out), "post-activation-temporal") || !strings.Contains(string(out), "job_title= post-activation-commit") || !strings.Contains(string(out), "job_version= 15") {
		t.Fatalf("unexpected rollback state %s", out)
	}
	assertRepeatedRecoveryRefusesWithoutMutation(t, f)
}

func TestV15InterruptedRecoveryPreservesPostActivationCommits(t *testing.T) {
	for _, crashAt := range []string{"candidate-ready", "candidate-starting"} {
		t.Run(crashAt, func(t *testing.T) {
			preserveMigrationSeams(t)
			python := migrationIntegrationPython(t)
			f := newV6ActivationFixtureWithPython(t, python)
			database, temporal := filepath.Join(f.state, "jobctrl.db"), filepath.Join(f.state, "temporal.db")
			if err := os.Remove(database); err != nil {
				t.Fatal(err)
			}
			seed := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
c=sqlite3.connect(sys.argv[1]);create_exact_v14_schema(c);c.execute("INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','019ed290-3340-7000-8000-000000000891','https://jobs.example/qa','before-backup')");c.commit();c.close()`
			if out, err := exec.Command(python, "-I", "-B", "-c", seed, database).CombinedOutput(); err != nil {
				t.Fatalf("seed %v %s", err, out)
			}
			sealedV7CandidateBuilder = buildSealedV15Candidate
			oldStarts := 0
			writeAndCrash := func() {
				write := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);assert c.execute('PRAGMA user_version').fetchone()[0]==15;c.execute("UPDATE jobs SET title='post-activation-commit'");c.commit();c.close()
c=sqlite3.connect(sys.argv[2]);c.execute("UPDATE t SET v='post-activation-temporal'");c.commit();c.close()`
				if out, err := exec.Command(python, "-I", "-B", "-c", write, database, temporal).CombinedOutput(); err != nil {
					t.Fatalf("write %v %s", err, out)
				}
				panic("synthetic crash after independent writes")
			}
			sealedV7CandidateInstaller = func(ctx launchContext, path string) error {
				if err := installSealedV15Candidate(ctx, path); err != nil {
					return err
				}
				if crashAt == "candidate-ready" {
					writeAndCrash()
				}
				return nil
			}
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
				if receipt == f.old {
					oldStarts++
					return nil
				}
				writeAndCrash()
				return nil
			}
			func() {
				defer func() {
					if v := recover(); v != "synthetic crash after independent writes" {
						t.Fatalf("panic %v", v)
					}
				}()
				_ = promoteExisting(f.ctx, f.store, f.active, f.candidate.BuildID, "update", io.Discard)
			}()
			journal, err := f.store.ReadJournal()
			if err != nil || (crashAt == "candidate-ready" && journal.State != release.MigrationCandidateReady) || (crashAt == "candidate-starting" && journal.State != release.CandidateStarting) {
				t.Fatalf("crash journal = %#v, %v", journal, err)
			}
			recovered, err := recoverInterruptedTransition(f.ctx, f.store)
			if err == nil || recovered || !strings.Contains(err.Error(), "retain the live databases") {
				t.Fatalf("recovery=%v err=%v", recovered, err)
			}
			read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);print('job_version=',c.execute('PRAGMA user_version').fetchone()[0]);print('job_title=',c.execute('SELECT title FROM jobs').fetchone()[0]);c.close()
c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);print('temporal=',c.execute('SELECT v FROM t').fetchone()[0]);c.close()`
			out, err := exec.Command(python, "-I", "-B", "-c", read, database, temporal).CombinedOutput()
			if err != nil {
				t.Fatalf("readback %v %s", err, out)
			}
			t.Logf("after crash recovery: %s", out)
			if !strings.Contains(string(out), "post-activation-temporal") || !strings.Contains(string(out), "job_title= post-activation-commit") || !strings.Contains(string(out), "job_version= 15") {
				t.Fatalf("unexpected retained data: %s", out)
			}
			if oldStarts != 0 {
				t.Fatalf("predecessor started %d times", oldStarts)
			}
			assertRepeatedRecoveryRefusesWithoutMutation(t, f)
		})
	}
}

func TestRollbackTargetFailurePreservesPostStartCommits(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	f := newV6ActivationFixtureWithPython(t, python)
	if _, err := snapshotPair(f.ctx, f.old); err != nil {
		t.Fatal(err)
	}
	active, err := f.store.WriteSelectedActive(f.candidate, f.active.Generation, f.candidate.BuildID, "local-fixture")
	if err != nil {
		t.Fatal(err)
	}
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.old {
			t.Fatalf("unexpected restart %s", receipt.BuildID)
		}
		setLifecycleSQLitePair(t, python, f.state, "post-target")
		return errors.New("synthetic target startup failure")
	}
	err = rollbackExisting(f.ctx, f.store, active, f.old.BuildID, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "retain the live databases") {
		t.Fatalf("rollback result %v", err)
	}
	values := lifecycleDatabaseValues(t, python, f.state)
	if values["jobctrl.db"] != "post-targetjobctrl.db" || values["temporal.db"] != "post-targettemporal.db" {
		t.Fatalf("post-start commits lost: %v", values)
	}
	journal, err := f.store.ReadJournal()
	if err != nil || !journal.PreserveLiveOnFailure || !journal.Resumable() {
		t.Fatalf("journal %#v %v", journal, err)
	}
	before := lifecycleDatabaseDigests(t, f.state)
	recovered, err := recoverInterruptedTransition(f.ctx, f.store)
	if err == nil || recovered || !sameDatabaseDigests(before, lifecycleDatabaseDigests(t, f.state)) {
		t.Fatalf("recovery=%v err=%v", recovered, err)
	}
	assertRepeatedRecoveryRefusesWithoutMutation(t, f)
}

func TestPreBackupPredecessorInterruptionRecoversWithoutPairRestore(t *testing.T) {
	preserveMigrationSeams(t)
	f := newV6ActivationFixture(t)
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		if err := os.Remove(filepath.Join(f.state, name)); err != nil {
			t.Fatal(err)
		}
	}
	starts := 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.old {
			t.Fatalf("unexpected candidate started: %s", receipt.BuildID)
		}
		starts++
		if starts == 1 {
			panic("synthetic pre-backup interruption")
		}
		seedLifecycleSQLitePair(t, f.python, f.state, "recovered")
		return nil
	}
	func() {
		defer func() {
			if p := recover(); p != "synthetic pre-backup interruption" {
				t.Fatalf("unexpected interruption %v", p)
			}
		}()
		_ = promoteExisting(f.ctx, f.store, f.active, f.candidate.BuildID, "update", io.Discard)
	}()
	j, err := f.store.ReadJournal()
	if err != nil || j.State != release.RollbackRestoring || j.BackupID != "" || j.TargetBackupID != "" || j.PreserveLiveOnFailure {
		t.Fatalf("journal %#v %v", j, err)
	}
	recovered, err := recoverInterruptedTransition(f.ctx, f.store)
	if err != nil || !recovered {
		t.Fatalf("pre-backup recovery=%v err=%v", recovered, err)
	}
	if starts != 2 {
		t.Fatalf("predecessor starts=%d", starts)
	}
	if _, err := os.Stat(filepath.Join(f.state, "backups")); !os.IsNotExist(err) {
		t.Fatalf("unexpected paired backup: %v", err)
	}
}

func TestRollbackRefusesFencedJournalUnderLock(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	f := newV6ActivationFixtureWithPython(t, python)
	if _, err := snapshotPair(f.ctx, f.old); err != nil {
		t.Fatal(err)
	}
	active, err := f.store.WriteSelectedActive(f.candidate, f.active.Generation, f.candidate.BuildID, "local-fixture")
	if err != nil {
		t.Fatal(err)
	}
	j, err := f.store.Begin("update", &f.old, &f.candidate, f.candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	j.PreserveLiveOnFailure = true
	if err := f.store.Advance(&j, release.PairBackedUp, nil); err != nil {
		t.Fatal(err)
	}
	setLifecycleSQLitePair(t, python, f.state, "newer")
	before := snapshotPreservedTransition(t, f)
	err = rollbackExisting(f.ctx, f.store, active, f.old.BuildID, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "unfinished update transition") {
		t.Fatalf("rollback result %v", err)
	}
	if after := snapshotPreservedTransition(t, f); !reflect.DeepEqual(before, after) {
		t.Fatal("refused rollback changed journal, selection, backup or live databases")
	}
}

func TestBackupRefusesFencedJournalUnderLock(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	f := newV6ActivationFixtureWithPython(t, python)
	j, err := f.store.Begin("update", &f.old, &f.candidate, f.candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	j.PreserveLiveOnFailure = true
	if err := f.store.Advance(&j, release.PairBackedUp, nil); err != nil {
		t.Fatal(err)
	}
	setLifecycleSQLitePair(t, python, f.state, "newer")
	before := snapshotPreservedTransition(t, f)
	outdir := filepath.Join(t.TempDir(), "not-created")
	err = backup(f.ctx, []string{"--output", outdir}, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "unfinished update transition") {
		t.Fatalf("backup result %v", err)
	}
	if after := snapshotPreservedTransition(t, f); !reflect.DeepEqual(before, after) {
		t.Fatal("refused backup changed journal, selection or live databases")
	}
	if _, err := os.Lstat(outdir); !os.IsNotExist(err) {
		t.Fatalf("refused backup created its destination: %v", err)
	}
}
