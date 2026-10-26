package launcher

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestRunAuthenticatesTransitionStartupBeforeDispatch(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	previousChannel, previousKey, previousStart := releaseChannel, releaseTrustKeyBase64, startCommand
	t.Cleanup(func() {
		releaseChannel, releaseTrustKeyBase64, startCommand = previousChannel, previousKey, previousStart
	})
	releaseChannel, releaseTrustKeyBase64 = "stable", base64.StdEncoding.EncodeToString(public)
	sentinel := errors.New("authenticated transition reached start")
	for _, scenario := range []struct {
		name       string
		state      release.State
		args       []string
		journal    string
		selector   bool
		controller bool
		old        bool
		tampered   bool
		revoked    bool
		allow      bool
	}{
		{name: "candidate", state: release.CandidateStarting, args: []string{"start", "--no-open"}, allow: true},
		{name: "rollback predecessor", state: release.RollbackRestoring, args: []string{"start", "--no-open"}, old: true, allow: true},
		{name: "public selector", state: release.CandidateStarting, args: []string{"start", "--no-open"}, selector: true},
		{name: "authenticated selector candidate", state: release.CandidateStarting, args: []string{"start", "--no-open"}, selector: true, controller: true, allow: true},
		{name: "authenticated selector rollback", state: release.RollbackRestoring, args: []string{"start", "--no-open"}, selector: true, controller: true, old: true, allow: true},
		{name: "selector wrong journal", state: release.CandidateStarting, args: []string{"start", "--no-open"}, selector: true, controller: true, journal: "wrong"},
		{name: "selector missing journal", state: release.CandidateStarting, args: []string{"start", "--no-open"}, selector: true, controller: true, journal: "missing"},
		{name: "selector wrong target", state: release.CandidateStarting, args: []string{"start", "--no-open"}, selector: true, controller: true, old: true},
		{name: "selector wrong manifest", state: release.CandidateStarting, args: []string{"start", "--no-open"}, selector: true, controller: true, tampered: true},
		{name: "selector other command", state: release.CandidateStarting, args: []string{"status"}, selector: true, controller: true},
		{name: "wrong journal", state: release.CandidateStarting, args: []string{"start", "--no-open"}, journal: "wrong"},
		{name: "environment flag alone", state: release.CandidateStarting, args: []string{"start", "--no-open"}, journal: "missing"},
		{name: "wrong executable state", state: release.CandidateHealthy, args: []string{"start", "--no-open"}},
		{name: "wrong release", state: release.CandidateStarting, args: []string{"start", "--no-open"}, old: true},
		{name: "wrong manifest receipt", state: release.CandidateStarting, args: []string{"start", "--no-open"}, tampered: true},
		{name: "revoked rollback predecessor", state: release.RollbackRestoring, args: []string{"start", "--no-open"}, old: true, revoked: true},
		{name: "other command", state: release.CandidateStarting, args: []string{"version"}},
		{name: "other start arguments", state: release.CandidateStarting, args: []string{"start", "--foreground"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			home, state := t.TempDir(), t.TempDir()
			old := newSignedHomebrewBootstrapFixture(t, private, "signed-transition-old-0001", 1, 1, python)
			candidate := newSignedHomebrewBootstrapFixture(t, private, "signed-transition-new-0002", 2, 1, python)
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
			journal, err := store.Begin("update", &old.receipt, &candidate.receipt, candidate.receipt.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			if scenario.tampered {
				journal.Candidate.ManifestSHA256 = strings.Repeat("0", 64)
			}
			if err := store.Advance(&journal, scenario.state, nil); err != nil {
				t.Fatal(err)
			}
			if scenario.revoked {
				if _, err := store.RecordMetadata("stable", 2, 1, candidate.buildID, candidate.receipt.DescriptorSHA256, []string{old.buildID}); err != nil {
					t.Fatal(err)
				}
			}
			journalID := journal.ID
			if scenario.journal == "wrong" {
				journalID = "forged-journal"
			} else if scenario.journal == "missing" {
				journalID = ""
			}
			build := candidate.buildID
			if scenario.old {
				build = old.buildID
			}
			executable := filepath.Join(home, "releases", build, "payload", "launcher", "jobctrl")
			if scenario.selector {
				executable = filepath.Join(home, "bin", "jobctrl")
			}
			calls := 0
			startCommand = func(ctx launchContext, _ []string, _ io.Writer) error {
				calls++
				if ctx.Distribution.BuildID != build {
					t.Fatalf("started %q, wanted %q", ctx.Distribution.BuildID, build)
				}
				return sentinel
			}
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + state,
				"JOBCTRL_TRANSITION_CANDIDATE=1", "JOBCTRL_TRANSITION_JOURNAL=" + journalID}
			if scenario.controller {
				env = append(env, "JOBCTRL_TRANSITION_TARGET="+build)
			}
			var output bytes.Buffer
			err = Run(executable, scenario.args, env, &output, &output)
			if scenario.allow {
				if !errors.Is(err, sentinel) || calls != 1 {
					t.Fatalf("authorized startup was blocked: calls=%d, err=%v", calls, err)
				}
			} else if err == nil || errors.Is(err, sentinel) || calls != 0 {
				t.Fatalf("unauthorized startup reached dispatch: calls=%d, err=%v", calls, err)
			}
		})
	}
}

func TestHistoricalControllerCandidateMigratesItsVerifiedPair(t *testing.T) {
	python := migrationIntegrationPython(t)
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	for _, scenario := range []string{"migration", "missing pair", "changed source", "wrong journal"} {
		t.Run(scenario, func(t *testing.T) {
			home, state := t.TempDir(), t.TempDir()
			old := newSignedHomebrewBootstrapFixture(t, private, "historical-old-0001", 1, 1, python)
			candidate := newSignedHomebrewBootstrapFixture(t, private, "historical-new-0002", 2, 1, python)
			for _, fixture := range []homebrewBootstrapFixture{old, candidate} {
				if err := stageHomebrewFixture(home, fixture, public); err != nil {
					t.Fatal(err)
				}
			}
			store, err := release.Open(home)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.WriteSelectedActive(old.receipt, 0, candidate.buildID, "homebrew"); err != nil {
				t.Fatal(err)
			}
			seedHomebrewSQLitePair(t, python, state)
			database := filepath.Join(state, "jobctrl.db")
			if err := os.Remove(database); err != nil {
				t.Fatal(err)
			}
			code := `import sqlite3,sys
from jobctrl.infrastructure.migrations.schema_v11 import create_exact_v11_schema
c=sqlite3.connect(sys.argv[1]); create_exact_v11_schema(c)
c.execute("INSERT INTO jobs(tenant_id,job_id,url,title) VALUES('local','019ed290-3340-7000-8000-000000000891','https://jobs.example/preserved','Preserved historical job')")
c.commit(); c.close()`
			if output, err := exec.Command(python, "-I", "-B", "-c", code, database).CombinedOutput(); err != nil {
				t.Fatalf("seed source: %v %s", err, output)
			}
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + state}
			ctx, err := transitionContextForReceipt(env, store, candidate.receipt)
			if err != nil {
				t.Fatal(err)
			}
			pair, err := snapshotPair(ctx, old.receipt)
			if err != nil {
				t.Fatal(err)
			}
			journal, err := store.Begin("update", &old.receipt, &candidate.receipt, candidate.receipt.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			journal.BackupID = pair.ID
			if scenario == "missing pair" {
				journal.BackupID = ""
			}
			if err := store.Advance(&journal, release.CandidateStarting, nil); err != nil {
				t.Fatal(err)
			}
			id := journal.ID
			if scenario == "wrong journal" {
				id = "wrong"
			}
			ctx.Environment = append(ctx.Environment, "JOBCTRL_TRANSITION_JOURNAL="+id)
			if scenario == "changed source" {
				if output, err := exec.Command(python, "-I", "-B", "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute(\"UPDATE jobs SET title='Newer writer'\"); c.commit(); c.close()", database).CombinedOutput(); err != nil {
					t.Fatalf("change source: %v %s", err, output)
				}
			}
			before, err := sha256Path(database)
			if err != nil {
				t.Fatal(err)
			}
			err = migrateHistoricalTransition(ctx)
			if scenario != "migration" {
				if err == nil {
					t.Fatal("invalid migration succeeded")
				}
				after, hashErr := sha256Path(database)
				if hashErr != nil || after != before {
					t.Fatal("refused migration changed the live source")
				}
				return
			}
			if err != nil {
				t.Fatalf("historical candidate migration: %v", err)
			}
			if version, err := jobCtrlSchemaVersion(ctx); err != nil || version != currentJobCtrlSchemaVersion {
				t.Fatalf("migrated version = %d, %v", version, err)
			}
			if err := migrateHistoricalTransition(ctx); err != nil {
				t.Fatalf("already-migrated retry: %v", err)
			}
			if err := restorePair(ctx, pair); err != nil {
				t.Fatal(err)
			}
			if version, err := jobCtrlSchemaVersion(ctx); err != nil || version != 11 {
				t.Fatalf("restored version = %d, %v", version, err)
			}
		})
	}
}
