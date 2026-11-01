package launcher

import (
	"encoding/json"
	"errors"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestInterruptedV14RecoveryPreservesActualExecutorStagesAndSidecars(t *testing.T) {
	python := migrationIntegrationPython(t)
	for _, stage := range []release.State{release.PolicyPending, release.MigrationCandidateReady, release.MigrationActivated} {
		t.Run(string(stage), func(t *testing.T) {
			preserveMigrationSeams(t)
			fixture := newV6ActivationFixtureWithPython(t, python)
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
			// Let the actual composite executors compute every nested path. Exit
			// abruptly at the innermost boundary, before their cleanup can run.
			code := `import importlib,json,os,sys
from pathlib import Path
paths=[Path(sys.argv[2])]
def traced(original):
    def call(source,candidate,**kwargs):
        paths.append(Path(candidate))
        return original(source,candidate,**kwargs)
    return call
for module_name,function in [
    ('legacy_to_v14_execute','execute_legacy_to_v13_candidate'),
    ('legacy_to_v13_execute','execute_legacy_to_v12_candidate'),
    ('legacy_to_v12_execute','execute_legacy_to_v11_candidate'),
    ('legacy_to_v11_execute','execute_legacy_to_v10_candidate'),
    ('legacy_to_v10_execute','execute_legacy_to_v9_candidate'),
    ('legacy_to_v9_execute','execute_v6_to_v8_candidate')]:
    module=importlib.import_module('jobctrl.infrastructure.migrations.'+module_name)
    setattr(module,function,traced(getattr(module,function)))
def interrupt(source,candidate,**kwargs):
    paths.append(Path(candidate))
    artifacts=[]
    for path in dict.fromkeys(paths):
        for suffix in ('','-journal','-shm','-wal'):
            artifact=Path(str(path)+suffix)
            artifact.write_bytes(('retained:'+str(artifact)).encode())
            artifacts.append(str(artifact))
    receipt=Path(sys.argv[2]+'.source-binding.json')
    receipt.touch(mode=0o600)
    artifacts.append(str(receipt))
    print(json.dumps(artifacts),flush=True)
    os._exit(73)
module=importlib.import_module('jobctrl.infrastructure.migrations.v6_to_v8_execute')
module.execute_v6_to_v7_candidate=interrupt
from jobctrl.infrastructure.migrations.legacy_to_v14_execute import execute_legacy_to_v14_candidate
execute_legacy_to_v14_candidate(sys.argv[1],sys.argv[2],source_version=6,migration_at='2026-10-07T00:00:00+00:00')`
			output, err := exec.Command(python, "-I", "-B", "-c", code, filepath.Join(fixture.state, "jobctrl.db"), v14CandidatePath(fixture.state, journal.ID)).CombinedOutput()
			var exit *exec.ExitError
			if !errors.As(err, &exit) || exit.ExitCode() != 73 {
				t.Fatalf("executor did not reach injected interruption: %v %s", err, output)
			}
			var artifacts []string
			if err := json.Unmarshal(output, &artifacts); err != nil || len(artifacts) != 33 {
				t.Fatalf("actual executor artifacts = %s, %v", output, err)
			}
			// Writes through separate connections after the paired snapshot must
			// survive even though the executor has left interrupted artifacts.
			setLifecycleSQLitePair(t, python, fixture.state, "post-snapshot-")
			values := lifecycleDatabaseValues(t, python, fixture.state)
			if values["jobctrl.db"] != "post-snapshot-jobctrl.db" || values["temporal.db"] != "post-snapshot-temporal.db" {
				t.Fatalf("independent writes not committed: %v", values)
			}
			backupValues := lifecycleDatabaseValues(t, python, filepath.Join(fixture.state, "backups", pair.ID))
			if backupValues["jobctrl.db"] != "oldjobctrl.db" || backupValues["temporal.db"] != "oldtemporal.db" {
				t.Fatalf("paired backup does not retain original values: %v", backupValues)
			}
			oldStarts := 0
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
				if receipt != fixture.old || journalID != journal.ID {
					t.Fatal("recovery selected the wrong release")
				}
				oldStarts++
				return nil
			}
			// Freeze the journal, active selection, selector, paired backup, live
			// databases and all real executor artifacts including sidecars.
			paths := append([]string{}, artifacts...)
			paths = append(paths,
				filepath.Join(fixture.runtime, release.JournalFile),
				filepath.Join(fixture.runtime, release.ActiveFile),
				filepath.Join(fixture.runtime, "bin", "jobctrl"),
				filepath.Join(fixture.state, "jobctrl.db"),
				filepath.Join(fixture.state, "temporal.db"),
				filepath.Join(fixture.state, "backups", pair.ID, "pair.json"),
			)
			for _, file := range pair.Files {
				paths = append(paths, filepath.Join(fixture.state, "backups", pair.ID, file.Name))
			}
			snapshot := func() map[string]string {
				t.Helper()
				digests := make(map[string]string, len(paths))
				for _, path := range paths {
					digest, err := sha256Path(path)
					if err != nil {
						t.Fatalf("read retained file %s: %v", path, err)
					}
					digests[path] = digest
				}
				return digests
			}
			before := snapshot()
			for attempt := 0; attempt < 2; attempt++ {
				recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store)
				if recovered || err == nil || !strings.Contains(err.Error(), "retain the live databases") {
					t.Fatalf("attempt %d: recovery at %s = %v, %v", attempt, stage, recovered, err)
				}
				if after := snapshot(); !reflect.DeepEqual(before, after) {
					t.Fatalf("attempt %d changed the live pair, backup, artifacts, journal, active or selector", attempt)
				}
				retained, err := fixture.store.ReadJournal()
				if err != nil || retained.ID != journal.ID || retained.State != stage || !retained.Resumable() || retained.BackupID != pair.ID {
					t.Fatalf("attempt %d: transition is not retained for explicit recovery: %#v, %v", attempt, retained, err)
				}
			}
			if oldStarts != 0 {
				t.Fatalf("predecessor started %d times", oldStarts)
			}
			if after := lifecycleDatabaseValues(t, python, fixture.state); !reflect.DeepEqual(values, after) {
				t.Fatalf("independent post-snapshot writes changed: before=%v after=%v", values, after)
			}
			if after := lifecycleDatabaseValues(t, python, filepath.Join(fixture.state, "backups", pair.ID)); !reflect.DeepEqual(backupValues, after) {
				t.Fatalf("retained backup values changed: before=%v after=%v", backupValues, after)
			}
		})
	}
}
