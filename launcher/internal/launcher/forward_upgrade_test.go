package launcher

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type forwardUpdateFixture struct {
	home, data, python string
	store              *release.Store
	old, candidate     homebrewBootstrapFixture
	env                []string
	ctx                launchContext
}

func newForwardUpdateFixture(t *testing.T) forwardUpdateFixture {
	return newForwardUpdateFixtureWithSourceProtocol(t, 1, false)
}

func newForwardUpdateFixtureWithSourceProtocol(t *testing.T, sourceProtocol int, sourceDeclaresV15 bool) forwardUpdateFixture {
	t.Helper()
	python := migrationIntegrationPython(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	home, data := t.TempDir(), t.TempDir()
	old := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "forward-prior-0001", 1, sourceProtocol, "/bin/false", sourceProtocol, sourceProtocol)
	if sourceDeclaresV15 {
		old = signBridgeTransitionFixture(t, old, private, "")
	}
	candidate := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "forward-target-0002", 2, 2, python, 2, 2)
	candidate = signBridgeTransitionFixture(t, candidate, private, "")
	if sourceProtocol == 2 {
		allowOldRetentionRollback(t, &candidate, private)
	}
	for _, fixture := range []homebrewBootstrapFixture{old, candidate} {
		if err := stageHomebrewFixture(home, fixture, public); err != nil {
			t.Fatal(err)
		}
	}
	store, err := release.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteSelectedActive(old.receipt, 0, old.buildID, "homebrew"); err != nil {
		t.Fatal(err)
	}
	verified, err := verifyInstalledReleaseForExecution(store, old.receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(home, verified); err != nil {
		t.Fatal(err)
	}
	seed := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
c=sqlite3.connect(sys.argv[1]); create_exact_v14_schema(c)
c.execute("INSERT INTO candidate_profiles (tenant_id,profile_id,personal_full_name,updated_at) VALUES ('synthetic','default','initial-profile','t')")
c.execute("INSERT INTO discovery_settings (tenant_id,search_config_json,created_at,updated_at) VALUES ('synthetic','{\"search\":\"initial\"}','t','t')")
c.execute("INSERT INTO resume_templates (tenant_id,template_id,display_name,created_at,updated_at) VALUES ('synthetic','owned','initial-resume','t','t')")
c.commit();c.close()
c=sqlite3.connect(sys.argv[2]);c.execute('CREATE TABLE t(v TEXT)');c.execute("INSERT INTO t VALUES ('initial-temporal')");c.commit();c.close()`
	if output, err := exec.Command(python, "-I", "-B", "-c", seed, filepath.Join(data, "jobctrl.db"), filepath.Join(data, "temporal.db")).CombinedOutput(); err != nil {
		t.Fatalf("seed exact synthetic source: %v %s", err, output)
	}
	for _, name := range []string{"config.json", "search.json", "resume.txt"} {
		if err := os.WriteFile(filepath.Join(data, name), []byte("owned-synthetic-"+name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	env := []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + data}
	ctx, err := transitionContextForReceipt(env, store, candidate.receipt)
	if err != nil {
		t.Fatal(err)
	}
	return forwardUpdateFixture{home, data, python, store, old, candidate, env, ctx}
}

func seedForwardSchema15(t *testing.T, f forwardUpdateFixture) {
	t.Helper()
	upgrade := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v15 import upgrade_exact_v14_schema_to_v15
c=sqlite3.connect(sys.argv[1]);upgrade_exact_v14_schema_to_v15(c);c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", upgrade, filepath.Join(f.data, "jobctrl.db")).CombinedOutput(); err != nil {
		t.Fatalf("seed a schema-15 predecessor: %v %s", err, output)
	}
}

func TestForwardUpdateSchema15BackupSupportsCompatibleRollback(t *testing.T) {
	f := newForwardUpdateFixtureWithSourceProtocol(t, 2, true)
	seedForwardSchema15(t, f)
	previousStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previousStart })
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt == f.candidate.receipt {
			write := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("UPDATE candidate_profiles SET personal_full_name='candidate-write' WHERE tenant_id='synthetic'");c.commit();c.close()
c=sqlite3.connect(sys.argv[2]);c.execute("UPDATE t SET v='candidate-temporal'");c.commit();c.close()`
			if output, err := exec.Command(f.python, "-I", "-B", "-c", write, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
				t.Fatalf("write candidate data: %v %s", err, output)
			}
		} else if receipt != f.old.receipt {
			t.Fatalf("unexpected release start: %s", receipt.BuildID)
		}
		return nil
	}
	if err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard); err != nil {
		t.Fatalf("promote compatible release: %v", err)
	}
	journal, err := f.store.ReadJournal()
	if err != nil || journal.SourceSchemaVersion != 15 || journal.BackupID == "" {
		t.Fatalf("missing schema-15 transition backup: %#v %v", journal, err)
	}
	var pair databasePair
	if err := decodeStrictRegular(filepath.Join(f.data, "backups", journal.BackupID, "pair.json"), &pair); err != nil {
		t.Fatal(err)
	}
	if pair.ReleaseReceipt != f.old.receipt {
		t.Fatalf("pre-upgrade backup bound to %s instead of predecessor %s", pair.ReleaseReceipt.BuildID, f.old.buildID)
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"rollback", "--to", f.old.buildID}, f.env, io.Discard, io.Discard); err != nil {
		t.Fatalf("roll back to the compatible predecessor: %v", err)
	}
	read := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);assert c.execute('PRAGMA user_version').fetchone() == (15,);assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('initial-profile',);c.close()
c=sqlite3.connect(sys.argv[2]);assert c.execute('SELECT v FROM t').fetchone() == ('initial-temporal',);c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
		t.Fatalf("rollback did not restore the paired predecessor data: %v %s", err, output)
	}
}

func TestForwardUpdateSchema15WithoutProvenPredecessorDoesNotAuthorizeRollback(t *testing.T) {
	for _, source := range []struct {
		name     string
		protocol int
	}{
		{"protocol 1", 1},
		{"protocol 2 without signed schema declaration", 2},
	} {
		t.Run(source.name, func(t *testing.T) {
			f := newForwardUpdateFixtureWithSourceProtocol(t, source.protocol, false)
			seedForwardSchema15(t, f)
			previousStart := startReleaseCommand
			t.Cleanup(func() { startReleaseCommand = previousStart })
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
				if receipt != f.candidate.receipt {
					t.Fatal("started an unproven predecessor")
				}
				return nil
			}
			if err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard); err != nil {
				t.Fatal(err)
			}
			journal, err := f.store.ReadJournal()
			if err != nil {
				t.Fatal(err)
			}
			var pair databasePair
			if err := decodeStrictRegular(filepath.Join(f.data, "backups", journal.BackupID, "pair.json"), &pair); err != nil {
				t.Fatal(err)
			}
			if pair.ReleaseReceipt != f.candidate.receipt {
				t.Fatalf("unproven predecessor acquired a rollback pair: %#v", pair.ReleaseReceipt)
			}
			if _, err := retainedPairForReceipt(f.data, f.old.receipt); err == nil {
				t.Fatal("rollback pair found for predecessor without proof of schema-15 support")
			}
		})
	}
}

func TestForwardUpdateSchema15RecoveryBackupTracksCandidateWrites(t *testing.T) {
	f := newForwardUpdateFixtureWithSourceProtocol(t, 2, true)
	seedForwardSchema15(t, f)
	previousStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previousStart })
	starts := 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt {
			t.Fatal("forward recovery started the predecessor")
		}
		starts++
		if starts == 1 {
			write := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL');c.execute("UPDATE candidate_profiles SET personal_full_name='later-profile' WHERE tenant_id='synthetic'");c.commit()
c=sqlite3.connect(sys.argv[2]);c.execute('PRAGMA journal_mode=WAL');c.execute("UPDATE t SET v='later-temporal'");c.commit();os._exit(0)`
			if output, err := exec.Command(f.python, "-I", "-B", "-c", write, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
				t.Fatalf("write candidate data before readiness failure: %v %s", err, output)
			}
			return errors.New("synthetic readiness failure")
		}
		return nil
	}
	if err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard); err == nil || !strings.Contains(err.Error(), "synthetic readiness failure") {
		t.Fatalf("expected candidate readiness failure: %v", err)
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, io.Discard, io.Discard); err != nil {
		t.Fatalf("resume forward update: %v", err)
	}
	journal, err := f.store.ReadJournal()
	if err != nil || journal.BackupID == "" || journal.RecoveryBackupID == "" {
		t.Fatalf("missing initial or recovery backup: %#v %v", journal, err)
	}
	for id, expected := range map[string]release.Receipt{journal.BackupID: f.old.receipt, journal.RecoveryBackupID: f.candidate.receipt} {
		var pair databasePair
		if err := decodeStrictRegular(filepath.Join(f.data, "backups", id, "pair.json"), &pair); err != nil || pair.ReleaseReceipt != expected {
			t.Fatalf("backup %s has wrong release identity: %#v %v", id, pair.ReleaseReceipt, err)
		}
	}
	read := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('later-profile',);c.close()
c=sqlite3.connect(sys.argv[2]);assert c.execute('SELECT v FROM t').fetchone() == ('later-temporal',);c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "backups", journal.RecoveryBackupID, "jobctrl.db"), filepath.Join(f.data, "backups", journal.RecoveryBackupID, "temporal.db")).CombinedOutput(); err != nil {
		t.Fatalf("recovery backup lost candidate writes: %v %s", err, output)
	}
}

func TestForwardUpdateRefusesBeforeSelectionOrDatabaseMutation(t *testing.T) {
	priorInspect := inspectOwnedProcesses
	t.Cleanup(func() { inspectOwnedProcesses = priorInspect })
	inspectOwnedProcesses = func(launchContext, instanceState, ...executionWitnesses) ([]ownedProcess, error) {
		return nil, errors.New("synthetic inspection failure")
	}

	f := newForwardUpdateFixture(t)
	before := lifecycleDatabaseDigests(t, f.data)
	active, err := f.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	selector, err := sha256Path(filepath.Join(f.home, "bin", "jobctrl"))
	if err != nil {
		t.Fatal(err)
	}
	err = PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "synthetic inspection failure") {
		t.Fatalf("unproven legacy writers were admitted: %v", err)
	}
	if after, err := f.store.ReadActive(); err != nil || after != active {
		t.Fatalf("source selection changed on refusal: %v", err)
	}
	if after, err := sha256Path(filepath.Join(f.home, "bin", "jobctrl")); err != nil || after != selector {
		t.Fatal("source selector changed on refusal")
	}
	if !sameDatabaseDigests(before, lifecycleDatabaseDigests(t, f.data)) {
		t.Fatal("refusal changed database bytes")
	}
	if _, err := f.store.ReadJournal(); !os.IsNotExist(err) {
		t.Fatalf("refusal created a transition journal: %v", err)
	}
	if _, err := os.Stat(filepath.Join(f.data, "backups")); !os.IsNotExist(err) {
		t.Fatal("refusal created a backup")
	}
}

func TestForwardUpdateRecoveryPreservesLaterProtectedWrites(t *testing.T) {

	f := newForwardUpdateFixture(t)
	beforeInfo, err := os.Stat(filepath.Join(f.data, "jobctrl.db"))
	if err != nil {
		t.Fatal(err)
	}

	previous := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previous })
	starts := 0
	startReleaseCommand = func(ctx launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt {
			t.Fatal("recovery tried to execute the predecessor")
		}
		starts++
		write := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]);assert c.execute('PRAGMA user_version').fetchone()[0] == 15
c.execute('PRAGMA journal_mode=WAL');attempt=int(sys.argv[3])
t=sqlite3.connect(sys.argv[2]);t.execute('PRAGMA journal_mode=WAL')
if attempt>1:
 assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('later-profile-'+str(attempt-1),)
 assert t.execute('SELECT v FROM t').fetchone() == ('later-temporal-'+str(attempt-1),)
c.execute("UPDATE candidate_profiles SET personal_full_name=? WHERE tenant_id='synthetic'",('later-profile-'+str(attempt),))
c.execute("UPDATE discovery_settings SET search_config_json=? WHERE tenant_id='synthetic'",('{"search":"later-'+str(attempt)+'"}',))
c.execute("UPDATE resume_templates SET display_name=? WHERE tenant_id='synthetic'",('later-resume-'+str(attempt),));c.commit()
t.execute('UPDATE t SET v=?',('later-temporal-'+str(attempt),));t.commit()
os._exit(0)`
		if output, err := exec.Command(f.python, "-I", "-B", "-c", write, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db"), strconv.Itoa(starts)).CombinedOutput(); err != nil {
			t.Fatalf("later owned writes failed: %v %s", err, output)
		}
		if starts < 3 {
			for _, name := range []string{"jobctrl.db-wal", "temporal.db-wal"} {
				if info, err := os.Stat(filepath.Join(f.data, name)); err != nil || info.Size() <= 32 {
					t.Fatalf("synthetic process exit did not retain acknowledged WAL writes: %v", err)
				}
			}
			return errors.New("synthetic readiness failure after acknowledged writes")
		}
		return nil
	}
	err = PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard)
	if err == nil || !strings.Contains(err.Error(), "synthetic readiness failure") || starts != 1 {
		t.Fatalf("candidate failure was not retained: %v starts=%d", err, starts)
	}
	journal, err := f.store.ReadJournal()
	if err != nil || !journal.ForwardOnlyUpgrade || !journal.Resumable() || journal.BackupID == "" {
		t.Fatalf("resumable forward journal was not retained: %v", err)
	}
	journalBytes, err := os.ReadFile(filepath.Join(f.home, release.JournalFile))
	if err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"stop"}, f.env, &out, io.Discard); err != nil {
		t.Fatalf("documented public cleanup was blocked: %v", err)
	}
	if after, err := os.ReadFile(filepath.Join(f.home, release.JournalFile)); err != nil || !bytes.Equal(journalBytes, after) || starts != 1 {
		t.Fatalf("cleanup advanced recovery or executed a payload: %v starts=%d", err, starts)
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, &out, io.Discard); err == nil || !strings.Contains(err.Error(), "synthetic readiness failure") {
		t.Fatalf("repeated failure did not preserve forward recovery: %v", err)
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, &out, io.Discard); err != nil {
		t.Fatalf("forward update recovery failed: %v", err)
	}
	active, err := f.store.ReadActive()
	if err != nil || active.Receipt != f.candidate.receipt || active.Generation != 2 || starts != 3 {
		t.Fatalf("candidate not selected exactly once: %v starts=%d", err, starts)
	}
	completed, err := f.store.ReadJournal()
	if err != nil || completed.State != release.Promoted || completed.RecoveryBackupID == "" || completed.BackupID != journal.BackupID {
		t.Fatalf("forward recovery did not retain both backups and complete: %v", err)
	}
	afterInfo, err := os.Stat(filepath.Join(f.data, "jobctrl.db"))
	if err != nil || !os.SameFile(beforeInfo, afterInfo) {
		t.Fatal("migration or recovery replaced the live database inode")
	}
	read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
assert c.execute('PRAGMA user_version').fetchone() == (15,)
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('later-profile-3',)
assert c.execute("SELECT search_config_json FROM discovery_settings WHERE tenant_id='synthetic'").fetchone() == ('{\"search\":\"later-3\"}',)
assert c.execute("SELECT display_name FROM resume_templates WHERE tenant_id='synthetic'").fetchone() == ('later-resume-3',)
assert c.execute('PRAGMA integrity_check').fetchone() == ('ok',)
c.close(); c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
assert c.execute('SELECT v FROM t').fetchone() == ('later-temporal-3',); c.close()
c=sqlite3.connect('file:'+sys.argv[3]+'?mode=ro',uri=True)
assert c.execute('PRAGMA user_version').fetchone() == (15,)
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('later-profile-2',);c.close()
c=sqlite3.connect('file:'+sys.argv[4]+'?mode=ro',uri=True)
assert c.execute('SELECT v FROM t').fetchone() == ('later-temporal-2',);c.close()
c=sqlite3.connect('file:'+sys.argv[5]+'?mode=ro',uri=True)
assert c.execute('PRAGMA user_version').fetchone() == (14,)
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('initial-profile',);c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db"), filepath.Join(f.data, "backups", completed.RecoveryBackupID, "jobctrl.db"), filepath.Join(f.data, "backups", completed.RecoveryBackupID, "temporal.db"), filepath.Join(f.data, "backups", completed.BackupID, "jobctrl.db")).CombinedOutput(); err != nil {
		t.Fatalf("later protected values were not preserved: %v %s", err, output)
	}
	for _, name := range []string{"config.json", "search.json", "resume.txt"} {
		raw, err := os.ReadFile(filepath.Join(f.data, name))
		if err != nil || string(raw) != "owned-synthetic-"+name {
			t.Fatalf("protected file %s changed: %v", name, err)
		}
	}
	if !strings.Contains(out.String(), fmt.Sprintf("JobCtrl %s is active", f.candidate.buildID)) {
		t.Fatal("completion was not reported")
	}
}

func TestForwardUpdateRecoversEveryDurableBoundaryThroughCorrectController(t *testing.T) {
	for _, boundary := range []release.State{release.MetadataVerified, release.PairBackedUp, release.SelectorHandoffPending, release.SelectorReplaced, release.MigrationCandidateReady, release.MigrationActivated, release.CandidateStarting, release.CandidateHealthy, release.PolicyFinalized} {
		t.Run(string(boundary), func(t *testing.T) {

			f := newForwardUpdateFixture(t)

			priorStart, priorFailure := startReleaseCommand, transitionFailure
			t.Cleanup(func() { startReleaseCommand, transitionFailure = priorStart, priorFailure })
			startReleaseCommand = func(ctx launchContext, receipt release.Receipt, _ string) error {
				if receipt != f.candidate.receipt {
					t.Fatal("durable recovery executed the predecessor")
				}
				return nil
			}
			transitionFailure = func(state release.State) error {
				if state == boundary {
					return errTransitionInterrupted
				}
				return nil
			}
			err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard)
			if !errors.Is(err, errTransitionInterrupted) {
				t.Fatalf("durable boundary was not interrupted: %v", err)
			}
			journal, err := f.store.ReadJournal()
			if err != nil || !journal.Resumable() || journal.State != boundary {
				t.Fatalf("interrupted journal was not retained: %v", err)
			}
			write := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL')
c.execute("UPDATE candidate_profiles SET personal_full_name='after-interruption' WHERE tenant_id='synthetic'")
c.execute("UPDATE discovery_settings SET search_config_json='{\"search\":\"after-interruption\"}' WHERE tenant_id='synthetic'")
c.execute("UPDATE resume_templates SET display_name='after-interruption' WHERE tenant_id='synthetic'");c.commit()
t=sqlite3.connect(sys.argv[2]);t.execute('PRAGMA journal_mode=WAL');t.execute("UPDATE t SET v='after-interruption'");t.commit();os._exit(0)`
			if output, err := exec.Command(f.python, "-I", "-B", "-c", write, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
				t.Fatalf("independent synthetic commits failed: %v %s", err, output)
			}
			for _, name := range []string{"jobctrl.db-wal", "temporal.db-wal"} {
				if info, err := os.Stat(filepath.Join(f.data, name)); err != nil || info.Size() <= 32 {
					t.Fatalf("independent committed WAL missing: %s %v", name, err)
				}
			}
			transitionFailure = nil

			var recoveryErr error
			if boundary == release.MetadataVerified || boundary == release.PairBackedUp || boundary == release.SelectorHandoffPending {
				// The immutable protocol-1 public binary cannot read journal v2.
				// Retrying the authenticated new installer reaches this entry;
				// calling the new Run with an old filepath would not prove that.
				recoveryErr = PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard)
			} else {
				recoveryErr = Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, io.Discard, io.Discard)
			}
			if recoveryErr != nil {
				t.Fatalf("forward recovery through the required controller failed: %v", recoveryErr)
			}
			read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);assert c.execute('PRAGMA user_version').fetchone() == (15,)
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('after-interruption',)
assert c.execute("SELECT search_config_json FROM discovery_settings WHERE tenant_id='synthetic'").fetchone() == ('{\"search\":\"after-interruption\"}',)
assert c.execute("SELECT display_name FROM resume_templates WHERE tenant_id='synthetic'").fetchone() == ('after-interruption',);c.close()
c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);assert c.execute('SELECT v FROM t').fetchone() == ('after-interruption',);c.close()`
			if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
				t.Fatalf("recovery lost acknowledged data: %v %s", err, output)
			}
			for _, name := range []string{"config.json", "search.json", "resume.txt"} {
				if raw, err := os.ReadFile(filepath.Join(f.data, name)); err != nil || string(raw) != "owned-synthetic-"+name {
					t.Fatalf("recovery changed protected file %s: %v", name, err)
				}
			}
		})
	}
}

func TestInitialSelectionPreservesUnpairedLegacyWorkspace(t *testing.T) {

	f := newForwardUpdateFixture(t)
	if err := os.Remove(filepath.Join(f.home, release.ActiveFile)); err != nil {
		t.Fatal(err)
	}
	before := lifecycleDatabaseDigests(t, f.data)

	if err := bootstrapFirstInstallWithEnv(f.store, f.candidate.receipt, f.env); err == nil || !strings.Contains(err.Error(), "predecessor") {
		t.Fatalf("initial selection stranded schema 14 without its predecessor: %v", err)
	}
	if _, err := f.store.ReadActive(); !os.IsNotExist(err) {
		t.Fatal("initial selection created an active record")
	}
	if !sameDatabaseDigests(before, lifecycleDatabaseDigests(t, f.data)) {
		t.Fatal("initial selection changed existing database bytes")
	}
	if err := CheckWorkspaceSelection(f.home, f.ctx.PayloadRoot, f.env, false); err == nil {
		t.Fatal("same-active adoption bypassed the schema guard")
	}
}

func TestInitialSelectionCanReinstallExactV15AfterUpgrade(t *testing.T) {

	f := newForwardUpdateFixture(t)
	upgrade := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v15 import upgrade_exact_v14_schema_to_v15
c=sqlite3.connect(sys.argv[1]);upgrade_exact_v14_schema_to_v15(c);c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", upgrade, filepath.Join(f.data, "jobctrl.db")).CombinedOutput(); err != nil {
		t.Fatalf("seed an owned schema-15 reinstall: %v %s", err, output)
	}
	if err := os.Remove(filepath.Join(f.home, release.ActiveFile)); err != nil {
		t.Fatal(err)
	}
	before := lifecycleDatabaseDigests(t, f.data)

	if err := bootstrapFirstInstallWithEnv(f.store, f.candidate.receipt, f.env); err != nil {
		t.Fatalf("preserving reinstall failed: %v", err)
	}
	if !sameDatabaseDigests(before, lifecycleDatabaseDigests(t, f.data)) {
		t.Fatal("reinstall changed existing database bytes")
	}
}

// Interrupt after real schema activation and candidate admission, leaving the
// live pair and authenticated source selection for the public recovery entry.
func interruptForwardUpdate(t *testing.T, boundary release.State) forwardUpdateFixture {
	t.Helper()

	f := newForwardUpdateFixture(t)

	priorStart, priorFailure := startReleaseCommand, transitionFailure
	t.Cleanup(func() { startReleaseCommand, transitionFailure = priorStart, priorFailure })
	startReleaseCommand = func(ctx launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt {
			t.Fatal("recovery executed retired source code")
		}
		return nil
	}
	transitionFailure = func(state release.State) error {
		if state == boundary {
			return errTransitionInterrupted
		}
		return nil
	}
	if err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard); !errors.Is(err, errTransitionInterrupted) {
		t.Fatalf("missing interrupted boundary: %v", err)
	}
	transitionFailure = nil

	return f
}

func TestForwardUpdateRecoversWithoutExecutingRevokedPredecessor(t *testing.T) {
	f := interruptForwardUpdate(t, release.PolicyFinalized)
	// Model durable security policy written just before the interruption. The
	// retired release remains immutable evidence, but must never run again.
	if _, err := f.store.RecordMetadata(f.candidate.receipt.Channel, f.candidate.receipt.Sequence, f.candidate.receipt.Sequence,
		f.candidate.buildID, f.candidate.receipt.DescriptorSHA256, []string{f.old.buildID}); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyInstalledReleaseForExecution(f.store, f.old.receipt); err == nil {
		t.Fatal("revoked predecessor still executable")
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"stop"}, f.env, io.Discard, io.Discard); err != nil {
		t.Fatalf("cleanup depended on a revoked predecessor: %v", err)
	}
	beforeInfo, err := os.Stat(filepath.Join(f.data, "jobctrl.db"))
	if err != nil {
		t.Fatal(err)
	}
	attempts := 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt {
			t.Fatal("recovery executed the revoked predecessor")
		}
		attempts++
		write := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL');attempt=int(sys.argv[3])
t=sqlite3.connect(sys.argv[2]);t.execute('PRAGMA journal_mode=WAL')
if attempt>1:
 assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('revoked-recovery-profile-'+str(attempt-1),)
 assert t.execute('SELECT v FROM t').fetchone() == ('revoked-recovery-temporal-'+str(attempt-1),)
c.execute("UPDATE candidate_profiles SET personal_full_name=? WHERE tenant_id='synthetic'",('revoked-recovery-profile-'+str(attempt),))
c.execute("UPDATE discovery_settings SET search_config_json=? WHERE tenant_id='synthetic'",('{"search":"revoked-recovery-'+str(attempt)+'"}',))
c.execute("UPDATE resume_templates SET display_name=? WHERE tenant_id='synthetic'",('revoked-recovery-resume-'+str(attempt),));c.commit()
t.execute('UPDATE t SET v=?',('revoked-recovery-temporal-'+str(attempt),));t.commit();os._exit(0)`
		if output, err := exec.Command(f.python, "-I", "-B", "-c", write, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db"), strconv.Itoa(attempts)).CombinedOutput(); err != nil {
			t.Fatalf("revoked recovery owned writes failed: %v %s", err, output)
		}
		if attempts < 3 {
			return errors.New("synthetic repeated readiness failure")
		}
		return nil
	}
	for attempt := 1; attempt <= 3; attempt++ {
		err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, io.Discard, io.Discard)
		if attempt < 3 {
			if err == nil || !strings.Contains(err.Error(), "synthetic repeated readiness failure") {
				t.Fatalf("unexpected repeated recovery result: %v", err)
			}
			if journal, err := f.store.ReadJournal(); err != nil || !journal.Resumable() || journal.RecoveryBackupID == "" {
				t.Fatalf("repeated recovery lost resumable journal/current backup: %v", err)
			}
		} else if err != nil {
			t.Fatalf("forward recovery depended on revoked code: %v", err)
		}
		read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);attempt=sys.argv[3]
assert c.execute('PRAGMA user_version').fetchone() == (15,)
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('revoked-recovery-profile-'+attempt,)
assert c.execute("SELECT search_config_json FROM discovery_settings WHERE tenant_id='synthetic'").fetchone() == ('{\"search\":\"revoked-recovery-'+attempt+'\"}',)
assert c.execute("SELECT display_name FROM resume_templates WHERE tenant_id='synthetic'").fetchone() == ('revoked-recovery-resume-'+attempt,)
c.close();t=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
assert t.execute('SELECT v FROM t').fetchone() == ('revoked-recovery-temporal-'+attempt,)`
		if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db"), strconv.Itoa(attempt)).CombinedOutput(); err != nil {
			t.Fatalf("revoked recovery lost protected commits: %v %s", err, output)
		}
		if afterInfo, err := os.Stat(filepath.Join(f.data, "jobctrl.db")); err != nil || !os.SameFile(beforeInfo, afterInfo) {
			t.Fatal("revoked recovery replaced live inode")
		}
		for _, name := range []string{"config.json", "search.json", "resume.txt"} {
			if raw, err := os.ReadFile(filepath.Join(f.data, name)); err != nil || string(raw) != "owned-synthetic-"+name {
				t.Fatalf("revoked recovery changed protected file %s: %v", name, err)
			}
		}
	}
	if active, err := f.store.ReadActive(); err != nil || active.Receipt != f.candidate.receipt || active.Generation != 2 {
		t.Fatalf("forward selection failed: %v", err)
	}
}

func TestForwardUpdateCompletesAfterSelectionWriteWithoutRestart(t *testing.T) {
	f := interruptForwardUpdate(t, release.PolicyFinalized)
	if _, err := f.store.WriteSelectedActive(f.candidate.receipt, 1, f.candidate.buildID, "homebrew"); err != nil {
		t.Fatal(err)
	}
	startReleaseCommand = func(launchContext, release.Receipt, string) error {
		t.Fatal("already-selected healthy target was restarted during finalization")
		return nil
	}
	if err := os.Remove(filepath.Join(f.home, "current.json")); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	journal, err := f.store.ReadJournal()
	if err != nil || journal.State != release.Promoted {
		t.Fatalf("finalization was not durable: %v", err)
	}
	var mirror release.Receipt
	if err := decodeStrictRegular(filepath.Join(f.home, "current.json"), &mirror); err != nil || mirror != f.candidate.receipt {
		t.Fatalf("legacy mirror not completed: %v", err)
	}
}

func TestForwardUpdateRefusesRecoveryIdentityAndSchemaDrift(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*testing.T, forwardUpdateFixture)
	}{
		{"candidate-revoked", func(t *testing.T, f forwardUpdateFixture) {
			state, err := f.store.ReadChannelState(f.candidate.receipt.Channel)
			if err != nil {
				t.Fatal(err)
			}
			state.RevokedBuildIDs[f.candidate.buildID] = true
			if err := f.store.CommitMetadata(state); err != nil {
				t.Fatal(err)
			}
		}},
		{"selection-changed", func(t *testing.T, f forwardUpdateFixture) {
			if _, err := f.store.WriteSelectedActive(f.old.receipt, 1, f.old.buildID, "curl"); err != nil {
				t.Fatal(err)
			}
		}},
		{"unknown-source-schema", func(t *testing.T, f forwardUpdateFixture) {
			journal, err := f.store.ReadJournal()
			if err != nil {
				t.Fatal(err)
			}
			journal.SourceSchemaVersion = 99
			if err := f.store.Advance(&journal, journal.State, nil); err != nil {
				t.Fatal(err)
			}
		}},
		{"regressed-live-schema", func(t *testing.T, f forwardUpdateFixture) {
			if out, err := exec.Command(f.python, "-I", "-B", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=14'); c.close()", filepath.Join(f.data, "jobctrl.db")).CombinedOutput(); err != nil {
				t.Fatalf("owned regression: %v %s", err, out)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := interruptForwardUpdate(t, release.CandidateHealthy)
			tc.mutate(t, f)
			before := lifecycleDatabaseDigests(t, f.data)
			activeBefore, err := f.store.ReadActive()
			if err != nil {
				t.Fatal(err)
			}
			journalBefore, err := os.ReadFile(filepath.Join(f.home, release.JournalFile))
			if err != nil {
				t.Fatal(err)
			}
			startReleaseCommand = func(launchContext, release.Receipt, string) error {
				t.Fatal("refused recovery executed a payload")
				return nil
			}
			if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, io.Discard, io.Discard); err == nil {
				t.Fatal("unsafe recovery was admitted")
			}
			if !sameDatabaseDigests(before, lifecycleDatabaseDigests(t, f.data)) {
				t.Fatal("refused recovery changed database bytes")
			}
			activeAfter, err := f.store.ReadActive()
			if err != nil || activeAfter != activeBefore {
				t.Fatalf("refusal changed selection: %v", err)
			}
			journalAfter, err := os.ReadFile(filepath.Join(f.home, release.JournalFile))
			if err != nil || !bytes.Equal(journalBefore, journalAfter) {
				t.Fatalf("refusal changed journal: %v", err)
			}
		})
	}
}

// Exercise the public promotion boundary with a real setsid writer, rather
// than treating a mocked stop or an absent registry as quiescence evidence.
func TestForwardUpdateCleansDetachedWriterBeforeBackup(t *testing.T) {
	f := newForwardUpdateFixture(t)
	pidFile := filepath.Join(t.TempDir(), "owned-writer.pid")
	code := `import os,signal,sqlite3,sys,time
if os.fork(): os._exit(0)
os.setsid();signal.signal(signal.SIGTERM,signal.SIG_IGN)
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL')
t=sqlite3.connect(sys.argv[2]);t.execute('PRAGMA journal_mode=WAL')
c.execute("UPDATE candidate_profiles SET personal_full_name='owned-detached-writer' WHERE tenant_id='synthetic'");c.commit()
t.execute("UPDATE t SET v='owned-detached-writer'");t.commit()
open(sys.argv[3],'w').write(str(os.getpid()))
while True:
 c.execute("UPDATE candidate_profiles SET personal_full_name='owned-detached-writer' WHERE tenant_id='synthetic'");c.commit()
 t.execute("UPDATE t SET v='owned-detached-writer'");t.commit();time.sleep(.02)
`
	writer := exec.Command(f.python, "-I", "-B", "-c", code, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db"), pidFile)
	writer.Env = ownedProcessEnvironment(f.ctx)
	if err := writer.Run(); err != nil {
		t.Fatal(err)
	}
	// Only synthetic instance-owned processes may be reclaimed on a failed test.
	t.Cleanup(func() { _ = terminateOwnedProcesses(f.ctx, instanceState{}) })
	pid := 0
	for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
		if raw, err := os.ReadFile(pidFile); err == nil {
			pid, _ = strconv.Atoi(string(raw))
			if pid > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if pid == 0 || !processPIDAlive(pid) {
		t.Fatal("owned detached writer did not become live")
	}
	processes, err := discoverOwnedProcesses(f.ctx, instanceState{})
	if err != nil || len(processes) != 1 || processes[0].PID != pid {
		t.Fatalf("detached writer did not have exact instance ownership: %v %v", processes, err)
	}
	previous := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previous })
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt || processPIDAlive(pid) {
			t.Fatal("candidate started before the authenticated detached writer exited")
		}
		return nil
	}
	started := time.Now()
	if err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard); err != nil {
		t.Fatalf("forward migration after actual writer cleanup: %v", err)
	}
	if time.Since(started) < shutdownTimeout || processPIDAlive(pid) {
		t.Fatal("TERM-ignoring writer was not waited through the clean-shutdown timeout")
	}
	read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
assert c.execute('PRAGMA user_version').fetchone() == (15,)
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('owned-detached-writer',)
c.close();t=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
assert t.execute('SELECT v FROM t').fetchone() == ('owned-detached-writer',)
`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
		t.Fatalf("cleanup/migration lost acknowledged writer commits: %v %s", err, output)
	}
}

func TestInitialSelectionRefusesIncompleteOrUnsafePair(t *testing.T) {
	for _, kind := range []string{"missing-temporal", "temporal-symlink", "orphan-sidecar"} {
		t.Run(kind, func(t *testing.T) {
			f := newForwardUpdateFixture(t)
			upgrade := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v15 import upgrade_exact_v14_schema_to_v15
c=sqlite3.connect(sys.argv[1]);upgrade_exact_v14_schema_to_v15(c);c.close()`
			if output, err := exec.Command(f.python, "-I", "-B", "-c", upgrade, filepath.Join(f.data, "jobctrl.db")).CombinedOutput(); err != nil {
				t.Fatalf("owned v15 fixture: %v %s", err, output)
			}
			if err := os.Remove(filepath.Join(f.home, release.ActiveFile)); err != nil {
				t.Fatal(err)
			}
			if err := os.Remove(filepath.Join(f.data, "temporal.db")); err != nil {
				t.Fatal(err)
			}
			control := filepath.Join(t.TempDir(), "preserved-control")
			if err := os.WriteFile(control, []byte("owned-external-control"), 0600); err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "temporal-symlink":
				if err := os.Symlink(control, filepath.Join(f.data, "temporal.db")); err != nil {
					t.Fatal(err)
				}
			case "orphan-sidecar":
				if err := os.Remove(filepath.Join(f.data, "jobctrl.db")); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(f.data, "jobctrl.db-wal"), []byte("owned-orphaned-wal"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			before := map[string][]byte{}
			for _, name := range []string{"jobctrl.db", "temporal.db", "jobctrl.db-wal"} {
				raw, err := os.ReadFile(filepath.Join(f.data, name))
				if err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
				before[name] = raw
			}
			for _, initial := range []bool{true, false} {
				if err := CheckWorkspaceSelection(f.home, f.ctx.PayloadRoot, f.env, initial); err == nil {
					t.Fatal("unsafe pair passed workspace selection")
				}
			}
			if err := bootstrapFirstInstallWithEnv(f.store, f.candidate.receipt, f.env); err == nil {
				t.Fatal("unsafe pair acquired an initial selection")
			}
			if _, err := f.store.ReadActive(); !os.IsNotExist(err) {
				t.Fatalf("unsafe pair became selected: %v", err)
			}
			if _, err := f.store.ReadJournal(); !os.IsNotExist(err) {
				t.Fatalf("unsafe selection created a journal: %v", err)
			}
			for name, raw := range before {
				after, err := os.ReadFile(filepath.Join(f.data, name))
				if raw == nil && !os.IsNotExist(err) {
					t.Fatalf("refusal created %s", name)
				}
				if err != nil && !os.IsNotExist(err) {
					t.Fatal(err)
				}
				if !bytes.Equal(raw, after) {
					t.Fatalf("refusal changed %s", name)
				}
			}
			if raw, err := os.ReadFile(control); err != nil || string(raw) != "owned-external-control" {
				t.Fatalf("refusal changed external control: %v", err)
			}
			if kind == "temporal-symlink" {
				if target, err := os.Readlink(filepath.Join(f.data, "temporal.db")); err != nil || target != control {
					t.Fatal("refusal changed database symlink")
				}
			}
		})
	}
}

func TestForwardCleanupStopsRevokedCandidateWithoutExecutingIt(t *testing.T) {
	f := interruptForwardUpdate(t, release.CandidateHealthy)
	policy, err := f.store.ReadChannelState(f.candidate.receipt.Channel)
	if err != nil {
		t.Fatal(err)
	}
	policy.RevokedBuildIDs[f.candidate.buildID] = true
	if err := f.store.CommitMetadata(policy); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyInstalledReleaseForExecution(f.store, f.candidate.receipt); err == nil {
		t.Fatal("revoked candidate remained executable")
	}
	ready := filepath.Join(t.TempDir(), "writer-ready")
	code := `import pathlib,sqlite3,sys,time
c=sqlite3.connect(sys.argv[1]);c.execute('PRAGMA journal_mode=WAL')
c.execute("UPDATE candidate_profiles SET personal_full_name='revoked-candidate-live-write' WHERE tenant_id='synthetic'");c.commit()
t=sqlite3.connect(sys.argv[2]);t.execute('PRAGMA journal_mode=WAL');t.execute("UPDATE t SET v='revoked-candidate-temporal'");t.commit()
pathlib.Path(sys.argv[3]).write_text('ready')
while True: time.sleep(.05)`
	writer := exec.Command(f.python, "-I", "-B", "-c", code, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db"), ready)
	writer.Env = ownedProcessEnvironment(f.ctx)
	if err := writer.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- writer.Wait() }()
	t.Cleanup(func() {
		if processPIDAlive(writer.Process.Pid) {
			_ = writer.Process.Kill()
		}
	})
	for deadline := time.Now().Add(5 * time.Second); ; {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("owned candidate writer did not commit")
		}
		time.Sleep(10 * time.Millisecond)
	}
	journalBefore, err := os.ReadFile(filepath.Join(f.home, release.JournalFile))
	if err != nil {
		t.Fatal(err)
	}
	activeBefore, err := f.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	backupsBefore, err := os.ReadDir(filepath.Join(f.data, "backups"))
	if err != nil {
		t.Fatal(err)
	}
	startReleaseCommand = func(launchContext, release.Receipt, string) error {
		t.Fatal("pure cleanup executed a payload")
		return nil
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"stop"}, f.env, io.Discard, io.Discard); err != nil {
		t.Fatalf("revocation blocked pure native cleanup: %v", err)
	}
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("candidate writer survived cleanup")
	}
	if processPIDAlive(writer.Process.Pid) {
		t.Fatal("cleanup returned with candidate writer still live")
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, io.Discard, io.Discard); err == nil {
		t.Fatal("cleanup granted a revoked candidate permission to resume")
	}
	if after, err := os.ReadFile(filepath.Join(f.home, release.JournalFile)); err != nil || !bytes.Equal(journalBefore, after) {
		t.Fatalf("pure cleanup changed the forward journal: %v", err)
	}
	if after, err := f.store.ReadActive(); err != nil || after != activeBefore {
		t.Fatalf("pure cleanup changed release selection: %v", err)
	}
	if after, err := os.ReadDir(filepath.Join(f.data, "backups")); err != nil || len(after) != len(backupsBefore) {
		t.Fatalf("pure cleanup created a backup: %v", err)
	}
	read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
assert c.execute('PRAGMA user_version').fetchone() == (15,)
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('revoked-candidate-live-write',)
c.close();t=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
assert t.execute('SELECT v FROM t').fetchone() == ('revoked-candidate-temporal',)`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
		t.Fatalf("cleanup lost acknowledged candidate writes: %v %s", err, output)
	}
}
