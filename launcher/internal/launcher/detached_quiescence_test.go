package launcher

import (
	"bytes"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// This fixture deliberately leaves the recorded group. It uses only private
// synthetic files and verifies the child's complete identity before cleanup.
func startDetachedWriter(t *testing.T) (componentRecord, componentRecord, string) {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	directory := t.TempDir()
	childPath := filepath.Join(directory, "child.pid")
	writes := filepath.Join(directory, "writer")
	code := `import os,sys,time
pid=os.fork()
if pid:
    while True: time.sleep(.05)
os.setsid()
with open(sys.argv[1], 'w') as stream:
    stream.write(str(os.getpid()))
while True:
    with open(sys.argv[2], 'a') as stream: stream.write('synthetic\n')
    time.sleep(.02)
`
	leader := exec.Command(python, "-I", "-B", "-c", code, childPath, writes)
	leader.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := leader.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = leader.Process.Kill(); _ = leader.Wait() })
	executable, err := processExecutable(leader.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(leader.Process.Pid, "", executable)
	if err != nil {
		t.Fatal(err)
	}
	var child componentRecord
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(childPath); err == nil {
			pid, _ := strconv.Atoi(strings.TrimSpace(string(raw)))
			if executable, err := processExecutable(pid); err == nil {
				child, _ = recordForProcess(pid, "", executable)
				if child.PID == pid && child.PID > 0 && child.PGID == pid {
					break
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child.PID <= 0 {
		t.Fatal("synthetic detached child did not publish its identity")
	}
	t.Cleanup(func() {
		if recordMatchesLiveProcess(child) {
			_ = syscall.Kill(child.PID, syscall.SIGKILL)
		}
	})
	if err := leader.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = leader.Wait()
	if processPIDAlive(record.PID) || processGroupAlive(record.PGID) || !recordMatchesLiveProcess(child) {
		t.Fatal("synthetic fixture did not leave a live detached child outside the dead recorded group")
	}
	return record, child, writes
}

func TestDetachedWriterStopCannotCertifyQuiescence(t *testing.T) {
	record, child, writes := startDetachedWriter(t)
	ctx, _ := issue1275State(t, record)
	before, err := os.Stat(writes)
	if err != nil {
		t.Fatal(err)
	}
	stopErr := stop(ctx)
	state, err := readState(ctx.Instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := status(ctx, &output, true); err != nil {
		t.Fatal(err)
	}
	var result struct {
		Status string `json:"status"`
	}
	if err := json.Unmarshal(output.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	after, err := os.Stat(writes)
	if err != nil || after.Size() <= before.Size() || !recordMatchesLiveProcess(child) {
		t.Fatal("synthetic child did not remain a verified live writer during stop/readback")
	}
	if stopErr == nil || state.StoppedAt != nil || result.Status == "stopped" {
		t.Fatalf("false quiescence with a verified detached writer: stopErr=%v stoppedAtSet=%v status=%s writerContinued=true", stopErr, state.StoppedAt != nil, result.Status)
	}
}

func TestDetachedWriterLifecycleRequiresQuiescence(t *testing.T) {
	for _, operation := range []string{"backup", "update", "rollback"} {
		t.Run(operation, func(t *testing.T) {
			fixture := newV6ActivationFixture(t)
			fixture.ctx.Instance.ID = "synthetic-instance"
			// This scenario tests process admission, not the legacy Temporal
			// migration preflight. Use the fixture's current-schema release path.
			setJobCtrlUserVersion(t, fixture.python, fixture.state, currentJobCtrlSchemaVersion)
			active := fixture.active
			if operation == "rollback" {
				if _, err := snapshotPair(fixture.ctx, fixture.old); err != nil {
					t.Fatal(err)
				}
				var err error
				active, err = fixture.store.WriteSelectedActive(fixture.candidate, active.Generation, fixture.old.BuildID, "local-fixture")
				if err != nil {
					t.Fatal(err)
				}
			}
			record, child, _ := startDetachedWriter(t)
			digest, err := manifestDigest(fixture.ctx.PayloadRoot)
			if err != nil {
				t.Fatal(err)
			}
			state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: fixture.ctx.Instance.ID, CanonicalStateDir: fixture.state, PayloadRoot: fixture.ctx.PayloadRoot, BuildID: fixture.old.BuildID, ManifestSHA256: digest, Components: map[string]componentRecord{"worker": record}}
			if err := writeState(fixture.ctx.Instance.StatePath, state); err != nil {
				t.Fatal(err)
			}
			before := lifecycleDatabaseDigests(t, fixture.state)
			beforeBackups, err := os.ReadDir(filepath.Join(fixture.state, "backups"))
			if err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			outputDir := t.TempDir()
			switch operation {
			case "backup":
				err = backup(fixture.ctx, []string{"--output", outputDir}, io.Discard)
			case "update":
				err = promoteExisting(fixture.ctx, fixture.store, active, fixture.candidate.BuildID, "update", io.Discard)
			case "rollback":
				err = rollbackExisting(fixture.ctx, fixture.store, active, fixture.old.BuildID, io.Discard)
			}
			if !recordMatchesLiveProcess(child) {
				t.Fatal("lifecycle operation harmed the unverified detached child")
			}
			afterBackups, readErr := os.ReadDir(filepath.Join(fixture.state, "backups"))
			if readErr != nil && !os.IsNotExist(readErr) {
				t.Fatal(readErr)
			}
			output, readErr := os.ReadDir(outputDir)
			if readErr != nil {
				t.Fatal(readErr)
			}
			if err == nil || !(strings.Contains(err.Error(), "quiesce") || strings.Contains(err.Error(), "component")) || len(output) != 0 || len(beforeBackups) != len(afterBackups) || !sameDatabaseDigests(before, lifecycleDatabaseDigests(t, fixture.state)) {
				t.Fatalf("%s crossed an unverified detached-writer boundary: error=%v outputPairs=%d retainedPairsBefore=%d retainedPairsAfter=%d", operation, err, len(output), len(beforeBackups), len(afterBackups))
			}
		})
	}
}
