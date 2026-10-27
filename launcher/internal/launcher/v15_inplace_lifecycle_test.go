package launcher

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestV14InPlaceActivationPreservesProtectedDataAndPostStartCommits(t *testing.T) {
	preserveMigrationSeams(t)
	python := migrationIntegrationPython(t)
	f := newV6ActivationFixtureWithPython(t, python)
	database, temporal := filepath.Join(f.state, "jobctrl.db"), filepath.Join(f.state, "temporal.db")
	resume, settings := filepath.Join(f.state, "owned-resume.txt"), filepath.Join(f.state, "owned-settings.json")
	if err := os.Remove(database); err != nil {
		t.Fatal(err)
	}
	seed := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
c=sqlite3.connect(sys.argv[1]); create_exact_v14_schema(c)
c.execute("INSERT INTO candidate_profiles (tenant_id,profile_id,personal_full_name,updated_at) VALUES ('synthetic','default','initial-profile','t')")
c.execute("INSERT INTO discovery_settings (tenant_id,search_config_json,created_at,updated_at) VALUES ('synthetic','{\"search\":\"initial\"}','t','t')")
c.execute("INSERT INTO resume_templates (tenant_id,template_id,display_name,created_at,updated_at) VALUES ('synthetic','owned','initial-resume','t','t')")
c.commit(); c.close()`
	if out, err := exec.Command(python, "-I", "-B", "-c", seed, database).CombinedOutput(); err != nil {
		t.Fatalf("seed synthetic source: %v %s", err, out)
	}
	for _, file := range []string{resume, settings} {
		if err := os.WriteFile(file, []byte("owned-synthetic-file"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	initialInfo, err := os.Stat(database)
	if err != nil {
		t.Fatal(err)
	}
	sealedV7CandidateBuilder, sealedV7CandidateInstaller = buildSealedV15Candidate, installSealedV15Candidate
	oldStarts, candidateStarts := 0, 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt == f.old {
			oldStarts++
			return nil
		}
		candidateStarts++
		liveInfo, err := os.Stat(database)
		if err != nil || !os.SameFile(initialInfo, liveInfo) {
			t.Fatalf("source inode replaced: %v", err)
		}
		write := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); assert c.execute('PRAGMA user_version').fetchone()[0] == 15
c.execute("UPDATE candidate_profiles SET personal_full_name='later-profile' WHERE tenant_id='synthetic'")
c.execute("UPDATE discovery_settings SET search_config_json='{\"search\":\"later\"}' WHERE tenant_id='synthetic'")
c.execute("UPDATE resume_templates SET display_name='later-resume' WHERE tenant_id='synthetic' AND template_id='owned'")
c.commit(); c.close()
c=sqlite3.connect(sys.argv[2]); c.execute("UPDATE t SET v='later-temporal'"); c.commit(); c.close()`
		if out, err := exec.Command(python, "-I", "-B", "-c", write, database, temporal).CombinedOutput(); err != nil {
			t.Fatalf("write synthetic later commits: %v %s", err, out)
		}
		return errors.New("synthetic readiness failure after protected writes")
	}
	err = promoteExisting(f.ctx, f.store, f.active, f.candidate.BuildID, "update", io.Discard)
	if err == nil || !strings.Contains(err.Error(), "synthetic readiness failure") || oldStarts != 0 || candidateStarts != 1 {
		t.Fatalf("promotion result=%v old=%d candidate=%d", err, oldStarts, candidateStarts)
	}
	assertRepeatedRecoveryRefusesWithoutMutation(t, f)
	pair, err := retainedPairForReceipt(f.state, f.old)
	if err != nil {
		t.Fatal(err)
	}
	backup := filepath.Join(f.state, "backups", pair.ID, "jobctrl.db")
	read := `import sqlite3,sys
live=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
assert live.execute('PRAGMA user_version').fetchone()[0] == 15
assert live.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('later-profile',)
assert live.execute("SELECT search_config_json FROM discovery_settings WHERE tenant_id='synthetic'").fetchone() == ('{\"search\":\"later\"}',)
assert live.execute("SELECT display_name FROM resume_templates WHERE tenant_id='synthetic' AND template_id='owned'").fetchone() == ('later-resume',)
assert live.execute('PRAGMA integrity_check').fetchone() == ('ok',)
live.close()
backup=sqlite3.connect('file:'+sys.argv[2]+'?mode=ro',uri=True)
assert backup.execute('PRAGMA user_version').fetchone()[0] == 14
assert backup.execute("SELECT personal_full_name FROM candidate_profiles WHERE tenant_id='synthetic'").fetchone() == ('initial-profile',)
assert backup.execute("SELECT search_config_json FROM discovery_settings WHERE tenant_id='synthetic'").fetchone() == ('{\"search\":\"initial\"}',)
assert backup.execute("SELECT display_name FROM resume_templates WHERE tenant_id='synthetic' AND template_id='owned'").fetchone() == ('initial-resume',)
backup.close()
t=sqlite3.connect('file:'+sys.argv[3]+'?mode=ro',uri=True);assert t.execute('SELECT v FROM t').fetchone() == ('later-temporal',);t.close()`
	if out, err := exec.Command(python, "-I", "-B", "-c", read, database, backup, temporal).CombinedOutput(); err != nil {
		t.Fatalf("read synthetic live and backup: %v %s", err, out)
	}
	for _, file := range []string{resume, settings} {
		contents, err := os.ReadFile(file)
		if err != nil || string(contents) != "owned-synthetic-file" {
			t.Fatalf("protected file not preserved: %v", err)
		}
	}
}
