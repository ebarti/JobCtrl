package launcher

import (
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestInterruptedV14RecoveryRemovesActualExecutorStagesAndSidecars(t *testing.T) {
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
            artifact.touch(mode=0o600)
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
			oldStarts := 0
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
				if receipt != fixture.old || journalID != journal.ID {
					t.Fatal("recovery selected the wrong release")
				}
				oldStarts++
				return nil
			}
			if recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store); !recovered || err != nil {
				t.Fatalf("recover interrupted %s = %v, %v", stage, recovered, err)
			}
			if oldStarts != 1 {
				t.Fatalf("predecessor starts = %d", oldStarts)
			}
			for _, path := range artifacts {
				if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
					t.Errorf("actual executor artifact survived recovery: %q, %v", path, err)
				}
			}
		})
	}
}
