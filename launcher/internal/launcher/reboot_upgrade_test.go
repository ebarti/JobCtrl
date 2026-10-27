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
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type rebootUpdateFixture struct {
	home, data, python string
	store              *release.Store
	old, candidate     homebrewBootstrapFixture
	env                []string
	ctx                launchContext
}

func newRebootUpdateFixture(t *testing.T) rebootUpdateFixture {
	t.Helper()
	python := migrationIntegrationPython(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	home, data := t.TempDir(), t.TempDir()
	old := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "reboot-prior-0001", 1, 1, "/bin/false", 1, 1)
	candidate := newSignedHomebrewBootstrapFixtureWithCompatibility(t, private, "reboot-target-0002", 2, 2, python, 2, 2)
	candidate = signBridgeTransitionFixture(t, candidate, private, "")
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
	return rebootUpdateFixture{home, data, python, store, old, candidate, env, ctx}
}

func TestRebootUpdateRefusesBeforeSelectionOrDatabaseMutation(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	f := newRebootUpdateFixture(t)
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
	if !errors.Is(err, errRebootRequired) {
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

func TestRebootUpdateForwardRecoveryPreservesLaterProtectedWrites(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	f := newRebootUpdateFixture(t)
	beforeInfo, err := os.Stat(filepath.Join(f.data, "jobctrl.db"))
	if err != nil {
		t.Fatal(err)
	}
	if err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard); !errors.Is(err, errRebootRequired) {
		t.Fatalf("initial request did not establish reboot recovery: %v", err)
	}
	syntheticBoot(t, syntheticBootTwo)
	previous := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previous })
	starts := 0
	startReleaseCommand = func(ctx launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt {
			t.Fatal("recovery tried to execute the predecessor")
		}
		starts++
		if err := recordExecutionBoot(ctx); err != nil {
			t.Fatal(err)
		}
		write := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]);assert c.execute('PRAGMA user_version').fetchone()[0] == 15
c.execute('PRAGMA journal_mode=WAL')
c.execute("UPDATE candidate_profiles SET personal_full_name='later-profile' WHERE tenant_id='synthetic'")
c.execute("UPDATE discovery_settings SET search_config_json='{\"search\":\"later\"}' WHERE tenant_id='synthetic'")
c.execute("UPDATE resume_templates SET display_name='later-resume' WHERE tenant_id='synthetic'");c.commit()
t=sqlite3.connect(sys.argv[2]);t.execute('PRAGMA journal_mode=WAL');t.execute("UPDATE t SET v='later-temporal'");t.commit()
os._exit(0)`
		if output, err := exec.Command(f.python, "-I", "-B", "-c", write, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
			t.Fatalf("later owned writes failed: %v %s", err, output)
		}
		if starts == 1 {
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
	if err != nil || !journal.RebootUpgrade || !journal.Resumable() || journal.BackupID == "" {
		t.Fatalf("resumable forward journal was not retained: %v", err)
	}
	beforeRetry := lifecycleDatabaseDigests(t, f.data)
	var out bytes.Buffer
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, &out, io.Discard); !errors.Is(err, errRebootRequired) {
		t.Fatalf("same-boot retry admitted possible detached writers: %v", err)
	}
	if !sameDatabaseDigests(beforeRetry, lifecycleDatabaseDigests(t, f.data)) {
		t.Fatal("refused recovery changed later data")
	}
	// The controlled SQL children have exited; model a subsequent boot before
	// invoking the actual public update dispatcher again.
	syntheticBoot(t, "33333333-3333-4333-8333-333333333333")
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, &out, io.Discard); err != nil {
		t.Fatalf("forward update recovery failed: %v", err)
	}
	active, err := f.store.ReadActive()
	if err != nil || active.Receipt != f.candidate.receipt || active.Generation != 2 || starts != 2 {
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
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('later-profile',)
assert c.execute("SELECT search_config_json FROM discovery_settings WHERE tenant_id='synthetic'").fetchone() == ('{\"search\":\"later\"}',)
assert c.execute("SELECT display_name FROM resume_templates WHERE tenant_id='synthetic'").fetchone() == ('later-resume',)
assert c.execute('PRAGMA integrity_check').fetchone() == ('ok',)
c.close(); c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
assert c.execute('SELECT v FROM t').fetchone() == ('later-temporal',); c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
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

func TestRebootUpdateRecoversEveryDurableBoundaryForward(t *testing.T) {
	for _, boundary := range []release.State{release.MetadataVerified, release.PairBackedUp, release.SelectorHandoffPending, release.SelectorReplaced, release.MigrationCandidateReady, release.MigrationActivated, release.CandidateStarting, release.CandidateHealthy, release.PolicyFinalized} {
		t.Run(string(boundary), func(t *testing.T) {
			syntheticBoot(t, syntheticBootOne)
			f := newRebootUpdateFixture(t)
			if err := recordExecutionBoot(f.ctx); err != nil {
				t.Fatal(err)
			}
			syntheticBoot(t, syntheticBootTwo)
			priorStart, priorFailure := startReleaseCommand, transitionFailure
			t.Cleanup(func() { startReleaseCommand, transitionFailure = priorStart, priorFailure })
			startReleaseCommand = func(ctx launchContext, receipt release.Receipt, _ string) error {
				if receipt != f.candidate.receipt {
					t.Fatal("durable recovery executed the predecessor")
				}
				return recordExecutionBoot(ctx)
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
			write := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("UPDATE candidate_profiles SET personal_full_name='after-interruption' WHERE tenant_id='synthetic'");c.commit();c.close()
c=sqlite3.connect(sys.argv[2]);c.execute("UPDATE t SET v='after-interruption'");c.commit();c.close()`
			if output, err := exec.Command(f.python, "-I", "-B", "-c", write, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
				t.Fatalf("independent synthetic commits failed: %v %s", err, output)
			}
			transitionFailure = nil
			syntheticBoot(t, "33333333-3333-4333-8333-333333333333")
			if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, io.Discard, io.Discard); err != nil {
				t.Fatalf("forward recovery failed: %v", err)
			}
			read := `import sqlite3,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True);assert c.execute('PRAGMA user_version').fetchone() == (15,)
assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('after-interruption',);c.close()
c=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True);assert c.execute('SELECT v FROM t').fetchone() == ('after-interruption',);c.close()`
			if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
				t.Fatalf("recovery lost acknowledged data: %v %s", err, output)
			}
		})
	}
}

func TestInitialSelectionPreservesUnpairedLegacyWorkspace(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	f := newRebootUpdateFixture(t)
	if err := os.Remove(filepath.Join(f.home, release.ActiveFile)); err != nil {
		t.Fatal(err)
	}
	before := lifecycleDatabaseDigests(t, f.data)
	if err := bootstrapFirstInstallWithEnv(f.store, f.candidate.receipt, f.env); !errors.Is(err, errRebootRequired) {
		t.Fatalf("initial selection bypassed reboot admission: %v", err)
	}
	syntheticBoot(t, syntheticBootTwo)
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

func TestInitialSelectionCanReinstallExactV15AfterReboot(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	f := newRebootUpdateFixture(t)
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
	if err := bootstrapFirstInstallWithEnv(f.store, f.candidate.receipt, f.env); !errors.Is(err, errRebootRequired) {
		t.Fatalf("existing data bypassed reboot admission: %v", err)
	}
	syntheticBoot(t, syntheticBootTwo)
	if err := bootstrapFirstInstallWithEnv(f.store, f.candidate.receipt, f.env); err != nil {
		t.Fatalf("preserving reinstall failed: %v", err)
	}
	if !sameDatabaseDigests(before, lifecycleDatabaseDigests(t, f.data)) {
		t.Fatal("reinstall changed existing database bytes")
	}
}

func TestLegacyRestartAfterRebootRearmsQuiescenceFence(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	ctx, state := issue1275State(t, componentRecord{})
	if err := recordExecutionBoot(ctx); err != nil {
		t.Fatal(err)
	}
	syntheticBoot(t, syntheticBootTwo)
	_, record, reaped := startOwnedSleep(t)
	state.Components["worker"] = record
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); !errors.Is(err, errRebootRequired) {
		t.Fatalf("legacy restart bypassed the reboot fence: %v", err)
	}
	<-reaped
	if err := stop(ctx); !errors.Is(err, errRebootRequired) {
		t.Fatalf("leader exit cleared a re-armed descendant fence: %v", err)
	}
	fence, err := readExecutionFence(ctx)
	if err != nil || fence.BootSession != syntheticBootTwo {
		t.Fatalf("restarted legacy runtime did not re-arm the boot fence: %v", err)
	}
}

// Interrupt after real schema activation and candidate admission, leaving the
// live pair and authenticated source selection for the public recovery entry.
func interruptRebootUpdate(t *testing.T, boundary release.State) rebootUpdateFixture {
	t.Helper()
	syntheticBoot(t, syntheticBootOne)
	f := newRebootUpdateFixture(t)
	if err := recordExecutionBoot(f.ctx); err != nil {
		t.Fatal(err)
	}
	syntheticBoot(t, syntheticBootTwo)
	priorStart, priorFailure := startReleaseCommand, transitionFailure
	t.Cleanup(func() { startReleaseCommand, transitionFailure = priorStart, priorFailure })
	startReleaseCommand = func(ctx launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt {
			t.Fatal("recovery executed retired source code")
		}
		return recordExecutionBoot(ctx)
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
	syntheticBoot(t, "33333333-3333-4333-8333-333333333333")
	return f
}

func TestRebootUpdateRecoversWithoutExecutingRevokedPredecessor(t *testing.T) {
	f := interruptRebootUpdate(t, release.PolicyFinalized)
	// Model durable security policy written just before the interruption. The
	// retired release remains immutable evidence, but must never run again.
	if _, err := f.store.RecordMetadata(f.candidate.receipt.Channel, f.candidate.receipt.Sequence, f.candidate.receipt.Sequence,
		f.candidate.buildID, f.candidate.receipt.DescriptorSHA256, []string{f.old.buildID}); err != nil {
		t.Fatal(err)
	}
	if _, err := verifyInstalledReleaseForExecution(f.store, f.old.receipt); err == nil {
		t.Fatal("revoked predecessor still executable")
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"update"}, f.env, io.Discard, io.Discard); err != nil {
		t.Fatalf("forward recovery depended on revoked code: %v", err)
	}
	if active, err := f.store.ReadActive(); err != nil || active.Receipt != f.candidate.receipt || active.Generation != 2 {
		t.Fatalf("forward selection failed: %v", err)
	}
}

func TestRebootUpdateCompletesAfterSelectionWriteWithoutRestart(t *testing.T) {
	f := interruptRebootUpdate(t, release.PolicyFinalized)
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

func TestRebootUpdateRefusesRecoveryIdentityAndSchemaDrift(t *testing.T) {
	cases := []struct {
		name   string
		mutate func(*testing.T, rebootUpdateFixture)
	}{
		{"candidate-revoked", func(t *testing.T, f rebootUpdateFixture) {
			state, err := f.store.ReadChannelState(f.candidate.receipt.Channel)
			if err != nil {
				t.Fatal(err)
			}
			state.RevokedBuildIDs[f.candidate.buildID] = true
			if err := f.store.CommitMetadata(state); err != nil {
				t.Fatal(err)
			}
		}},
		{"selection-changed", func(t *testing.T, f rebootUpdateFixture) {
			if _, err := f.store.WriteSelectedActive(f.old.receipt, 1, f.old.buildID, "curl"); err != nil {
				t.Fatal(err)
			}
		}},
		{"unknown-source-schema", func(t *testing.T, f rebootUpdateFixture) {
			journal, err := f.store.ReadJournal()
			if err != nil {
				t.Fatal(err)
			}
			journal.SourceSchemaVersion = 99
			if err := f.store.Advance(&journal, journal.State, nil); err != nil {
				t.Fatal(err)
			}
		}},
		{"regressed-live-schema", func(t *testing.T, f rebootUpdateFixture) {
			if out, err := exec.Command(f.python, "-I", "-B", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('PRAGMA user_version=14'); c.close()", filepath.Join(f.data, "jobctrl.db")).CombinedOutput(); err != nil {
				t.Fatalf("owned regression: %v %s", err, out)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			f := interruptRebootUpdate(t, release.CandidateHealthy)
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
