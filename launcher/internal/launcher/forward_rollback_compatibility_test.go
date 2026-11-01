package launcher

import (
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// Reproduce the immutable predecessor's published behavior: it wrote the
// candidate receipt into the original pre-upgrade snapshot's pair metadata.
func legacyForwardRollbackFixture(t *testing.T) (forwardUpdateFixture, release.Journal, release.Active, verifiedRelease, verifiedRelease) {
	t.Helper()
	f := newForwardUpdateFixtureWithSourceProtocol(t, 2, true)
	seedForwardSchema15(t, f)
	previousStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previousStart })
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt && receipt != f.old.receipt {
			t.Fatalf("unexpected synthetic release start: %s", receipt.BuildID)
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
	pairPath := filepath.Join(f.data, "backups", journal.BackupID, "pair.json")
	var pair databasePair
	if err := decodeStrictRegular(pairPath, &pair); err != nil {
		t.Fatal(err)
	}
	pair.ReleaseReceipt = f.candidate.receipt
	if err := writeJSONAtomic(pairPath, pair); err != nil {
		t.Fatal(err)
	}
	active, err := f.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	current, err := verifyInstalledReleaseForExecution(f.store, active.Receipt)
	if err != nil {
		t.Fatal(err)
	}
	predecessor, err := verifyInstalledReleaseForExecution(f.store, f.old.receipt)
	if err != nil {
		t.Fatal(err)
	}
	return f, journal, active, current, predecessor
}

func TestRollbackAcceptsVerifiedLegacyForwardSnapshot(t *testing.T) {
	f, _, _, _, _ := legacyForwardRollbackFixture(t)
	write := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);c.execute("UPDATE candidate_profiles SET personal_full_name='later-profile' WHERE tenant_id='synthetic'");c.commit();c.close()
c=sqlite3.connect(sys.argv[2]);c.execute("UPDATE t SET v='later-temporal'");c.commit();c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", write, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
		t.Fatalf("seed later candidate data: %v %s", err, output)
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"rollback", "--to", f.old.buildID}, f.env, io.Discard, io.Discard); err != nil {
		t.Fatalf("verified legacy rollback failed: %v", err)
	}
	read := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]);assert c.execute('PRAGMA user_version').fetchone() == (15,);assert c.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('initial-profile',);c.close()
c=sqlite3.connect(sys.argv[2]);assert c.execute('SELECT v FROM t').fetchone() == ('initial-temporal',);c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", read, filepath.Join(f.data, "jobctrl.db"), filepath.Join(f.data, "temporal.db")).CombinedOutput(); err != nil {
		t.Fatalf("legacy rollback did not restore both predecessor databases: %v %s", err, output)
	}
}

func TestLegacyForwardSnapshotRejectsUnprovenProvenance(t *testing.T) {
	f, journal, active, current, predecessor := legacyForwardRollbackFixture(t)
	ctx, err := transitionContextForReceipt(f.env, f.store, active.Receipt)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := compatibleForwardRollbackPair(ctx, journal, active, current, predecessor); err != nil {
		t.Fatalf("valid synthetic forward snapshot rejected: %v", err)
	}
	for _, testCase := range []struct {
		name   string
		mutate func(*release.Journal, *release.Active, *verifiedRelease)
	}{
		{"unfinished transition", func(j *release.Journal, _ *release.Active, _ *verifiedRelease) { j.State = release.CandidateHealthy }},
		{"cross-schema source", func(j *release.Journal, _ *release.Active, _ *verifiedRelease) { j.SourceSchemaVersion = 14 }},
		{"later recovery backup", func(j *release.Journal, _ *release.Active, _ *verifiedRelease) { j.RecoveryBackupID = j.BackupID }},
		{"unexpected generation", func(_ *release.Journal, a *release.Active, _ *verifiedRelease) { a.Generation++ }},
		{"unsafe backup path", func(j *release.Journal, _ *release.Active, _ *verifiedRelease) { j.BackupID = "../foreign" }},
		{"missing predecessor contract", func(_ *release.Journal, _ *release.Active, v *verifiedRelease) { v.distribution.Files = nil }},
	} {
		t.Run(testCase.name, func(t *testing.T) {
			j, a, v := journal, active, predecessor
			testCase.mutate(&j, &a, &v)
			if _, err := compatibleForwardRollbackPair(ctx, j, a, current, v); err == nil {
				t.Fatal("unproven snapshot was accepted")
			}
		})
	}
	backup := filepath.Join(f.data, "backups", journal.BackupID, "temporal.db")
	raw, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(backup, append(raw, 0), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := compatibleForwardRollbackPair(ctx, journal, active, current, predecessor); err == nil {
		t.Fatal("changed backup database was accepted")
	}
	beforeDatabases := lifecycleDatabaseDigests(t, f.data)
	beforeJournal, err := os.ReadFile(filepath.Join(f.home, release.JournalFile))
	if err != nil {
		t.Fatal(err)
	}
	if err := Run(filepath.Join(f.home, "bin", "jobctrl"), []string{"rollback", "--to", f.old.buildID}, f.env, io.Discard, io.Discard); err == nil {
		t.Fatal("public rollback accepted a changed legacy backup")
	}
	if after, err := f.store.ReadActive(); err != nil || after != active {
		t.Fatalf("refused rollback changed the selected release: %#v %v", after, err)
	}
	if after, err := os.ReadFile(filepath.Join(f.home, release.JournalFile)); err != nil || string(after) != string(beforeJournal) {
		t.Fatalf("refused rollback changed the journal: %v", err)
	}
	if after := lifecycleDatabaseDigests(t, f.data); !sameDatabaseDigests(beforeDatabases, after) {
		t.Fatal("refused rollback changed the live database pair")
	}
}
