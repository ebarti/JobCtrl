package launcher

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The component itself reads the registry before performing its first write.
// This exercises the real launch gate and does not rely on scheduler timing.
func TestComponentLaunchPublishesBeforeExecution(t *testing.T) {
	ctx, state := issue1275State(t, componentRecord{})
	delete(state.Components, "worker")
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	ctx.Instance.LogDir = t.TempDir()
	if err := os.Symlink("/bin/sh", filepath.Join(ctx.PayloadRoot, "shell")); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "executed")
	ctx.Manifest.Components = []commandSpec{{Name: "worker", Executable: "shell", Arguments: []string{"-c", `grep -q '"worker"' "$1" && printf ready > "$2"`, "worker", ctx.Instance.StatePath, marker}}}
	cmd, err := startComponent(ctx, &state, "worker")
	if err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err != nil {
		t.Fatalf("component did not observe published state: %v", err)
	}
	if data, err := os.ReadFile(marker); err != nil || string(data) != "ready" {
		t.Fatalf("component failed to observe its durable registry: %q, %v", data, err)
	}
	recorded, err := readState(ctx.Instance.StatePath)
	if err != nil || recorded.Components["worker"].PID != cmd.Process.Pid {
		t.Fatalf("wrong published component: %+v, %v", recorded.Components["worker"], err)
	}
}

func TestGatedComponentRejectsIncompleteMessageAndEOF(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "executed")
	gateRead, gateWrite, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command("/bin/bash", "-p", "-c", gatedComponentScript, "fixture", "/bin/sh", "-c", `printf unsafe > "$1"`, "worker", marker)
	cmd.Env = []string{"BASH_FUNC_read%%=() { gate=start; }"}
	cmd.ExtraFiles = []*os.File{gateRead}
	if err := cmd.Start(); err != nil {
		_ = gateRead.Close()
		_ = gateWrite.Close()
		t.Fatal(err)
	}
	_ = gateRead.Close()
	if _, err := gateWrite.WriteString("start"); err != nil {
		_ = gateWrite.Close()
		_ = cmd.Wait()
		t.Fatal(err)
	}
	_ = gateWrite.Close()
	if err := cmd.Wait(); err == nil {
		t.Fatal("incomplete gate message unexpectedly authorized execution")
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("component executed after incomplete gate message: %v", err)
	}
}

func TestGateClosesOnSupervisorCrash(t *testing.T) {
	if os.Getenv("JOBCTRL_TEST_GATE_HELPER") == "1" {
		gateRead, gateWrite, err := os.Pipe()
		if err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("/bin/bash", "-p", "-c", gatedComponentScript, "fixture", "/bin/sh", "-c", `printf unsafe > "$1"`, "worker", os.Getenv("JOBCTRL_TEST_GATE_MARKER"))
		cmd.ExtraFiles = []*os.File{gateRead}
		cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		_ = gateRead.Close()
		if err := os.WriteFile(os.Getenv("JOBCTRL_TEST_GATE_PID"), []byte(strconv.Itoa(cmd.Process.Pid)), 0o600); err != nil {
			t.Fatal(err)
		}
		// The parent test kills this supervisor while it owns the only writer.
		// Keep a live reference until then so the gate remains open.
		time.Sleep(time.Minute)
		_ = gateWrite.Close()
		_ = cmd.Wait()
		return
	}
	dir := t.TempDir()
	marker, pidPath := filepath.Join(dir, "executed"), filepath.Join(dir, "pid")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	helper := exec.Command(binary, "-test.run=^TestGateClosesOnSupervisorCrash$")
	helper.Env = append(os.Environ(), "JOBCTRL_TEST_GATE_HELPER=1", "JOBCTRL_TEST_GATE_MARKER="+marker, "JOBCTRL_TEST_GATE_PID="+pidPath)
	if err := helper.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = helper.Process.Kill(); _ = helper.Wait() })
	var child componentRecord
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if raw, err := os.ReadFile(pidPath); err == nil {
			if pid, err := strconv.Atoi(string(raw)); err == nil {
				if record, err := recordForProcess(pid, "", "/bin/bash"); err == nil {
					child = record
					break
				}
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child.PID == 0 {
		t.Fatal("helper did not start its gated child")
	}
	t.Cleanup(func() {
		if recordMatchesLiveProcess(child) {
			_ = syscall.Kill(child.PID, syscall.SIGKILL)
		}
	})
	if err := helper.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = helper.Wait()
	if !waitForPIDExit(child.PID, 5*time.Second) {
		t.Fatal("gated child survived supervisor crash")
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("component executed after supervisor crash: %v", err)
	}
}

func TestComponentLaunchRefusesUnpublishedExecution(t *testing.T) {
	ctx, state := issue1275State(t, componentRecord{})
	delete(state.Components, "worker")
	ctx.Instance.LogDir = t.TempDir()
	if err := os.Symlink("/bin/sh", filepath.Join(ctx.PayloadRoot, "shell")); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "executed")
	ctx.Instance.StatePath = filepath.Join(t.TempDir(), "missing", "state.json")
	// Exported Bash functions must not bypass the admission gate.
	ctx.Environment = []string{"BASH_FUNC_read%%=() { gate=start; }", "BASH_FUNC_exec%%=() { command \"$@\"; }"}
	ctx.Manifest.Components = []commandSpec{{Name: "worker", Executable: "shell", Arguments: []string{"-c", `printf unsafe > "$1"`, "worker", marker}}}
	if cmd, err := startComponent(ctx, &state, "worker"); err == nil || cmd != nil {
		t.Fatalf("launch should fail before the component executes: %v", err)
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("component executed without a published registry: %v", err)
	}
}

func TestGatedComponentRetainsRecordedIdentityAfterExec(t *testing.T) {
	ctx, state := issue1275State(t, componentRecord{})
	delete(state.Components, "worker")
	ctx.Instance.LogDir = t.TempDir()
	if err := os.Symlink("/bin/sleep", filepath.Join(ctx.PayloadRoot, "sleep")); err != nil {
		t.Fatal(err)
	}
	ctx.Manifest.Components = []commandSpec{{Name: "worker", Executable: "sleep", Arguments: []string{"60"}}}
	cmd, err := startComponent(ctx, &state, "worker")
	if err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- cmd.Wait() }()
	t.Cleanup(func() {
		if recordMatchesLiveProcess(state.Components["worker"]) {
			_ = syscall.Kill(cmd.Process.Pid, syscall.SIGKILL)
		}
		select {
		case <-waited:
		case <-time.After(2 * time.Second):
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for !recordMatchesLiveProcess(state.Components["worker"]) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !recordMatchesLiveProcess(state.Components["worker"]) {
		t.Fatal("component did not retain its published identity across exec")
	}
	if err := terminateRecord(state.Components["worker"]); err != nil {
		t.Fatalf("published component could not be safely stopped: %v", err)
	}
}

// startOrphanedGroup starts an owned process group, obtains an independent
// identity for its child, then kills and reaps only the leader.  Cleanup never
// signals a PID unless its current identity still matches that owned child.
func startOrphanedGroup(t *testing.T) (componentRecord, componentRecord) {
	t.Helper()
	childPath := filepath.Join(t.TempDir(), "child.pid")
	leader := exec.Command("/bin/sh", "-c", `sleep 60 & echo $! > "$1"; wait`, "fixture", childPath)
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
	var childPID int
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw, readErr := os.ReadFile(childPath)
		if readErr == nil {
			childPID, _ = strconv.Atoi(strings.TrimSpace(string(raw)))
			if childPID > 0 {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childPID == 0 {
		t.Fatal("owned child did not publish its PID")
	}
	var child componentRecord
	for time.Now().Before(deadline) {
		exe, readErr := processExecutable(childPID)
		if readErr == nil && sameExecutable(exe, "/bin/sleep") {
			child, readErr = recordForProcess(childPID, "", exe)
			if readErr == nil {
				break
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	if child.PID != childPID || child.PGID != record.PGID {
		t.Fatalf("child not in recorded group: leader=%+v child=%+v", record, child)
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
	if processPIDAlive(record.PID) || !recordMatchesLiveProcess(child) || !processGroupAlive(record.PGID) {
		t.Fatalf("fixture did not leave an orphan in the original group: leader=%+v child=%+v", record, child)
	}
	return record, child
}

func issue1275State(t *testing.T, component componentRecord) (launchContext, instanceState) {
	t.Helper()
	payload, stateRoot := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(payload, "manifest.json"), []byte("synthetic manifest"), 0o644); err != nil {
		t.Fatal(err)
	}
	digest, err := manifestDigest(payload)
	if err != nil {
		t.Fatal(err)
	}
	manifest := runtimeManifest{}
	manifest.Ports.TemporalGRPC, manifest.Ports.TemporalUI, manifest.Ports.API = 7233, 8233, 8766
	ctx := launchContext{PayloadRoot: payload, Manifest: manifest, Distribution: distributionManifest{BuildID: "build"}, Instance: instance{ID: "instance", StateDir: stateRoot, StatePath: filepath.Join(stateRoot, "state.json"), LockPath: filepath.Join(stateRoot, "instance.lock"), ControlPath: filepath.Join(stateRoot, "control.lock")}}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: "instance", CanonicalStateDir: stateRoot, PayloadRoot: payload, BuildID: "build", ManifestSHA256: digest, Ports: runtimePorts{TemporalGRPC: 7233, TemporalUI: 8233, API: 8766}, Components: map[string]componentRecord{"worker": component}}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	return ctx, state
}

func TestIssue1275OrphanedGroupBlocksStopStartAndRecoversAfterExit(t *testing.T) {
	record, child := startOrphanedGroup(t)
	ctx, state := issue1275State(t, record)
	previousSignal := signalProcessGroup
	calls := 0
	signalProcessGroup = func(int, syscall.Signal) error { calls++; return errors.New("unexpected group signal") }
	t.Cleanup(func() { signalProcessGroup = previousSignal })
	if !stateHasLiveProcesses(state) {
		t.Fatal("orphaned recorded group falsely treated as stopped")
	}
	var out bytes.Buffer
	if err := status(ctx, &out, true); err != nil {
		t.Fatal(err)
	}
	var observed struct {
		Status     string `json:"status"`
		Components map[string]struct {
			State string `json:"state"`
		} `json:"components"`
	}
	if err := json.Unmarshal(out.Bytes(), &observed); err != nil {
		t.Fatal(err)
	}
	if observed.Status == "stopped" || observed.Components["worker"].State == "stopped" {
		t.Fatalf("status hid an orphan: %s", out.String())
	}
	if err := validateStartState(ctx, state); err == nil {
		t.Fatal("start accepted live orphaned component group")
	}
	if err := stop(ctx); err == nil {
		t.Fatal("stop accepted live orphaned component group")
	}
	persisted, err := readState(ctx.Instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if persisted.StoppedAt != nil {
		t.Fatal("stop recorded false quiescence")
	}
	if calls != 0 {
		t.Fatalf("stop signaled unverified process group %d times", calls)
	}
	if !recordMatchesLiveProcess(child) {
		t.Fatal("stop harmed the owned orphan")
	}
	if err := syscall.Kill(child.PID, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if !waitForProcessGroupExit(record.PGID, 5*time.Second) {
		t.Fatal("fixture group did not exit")
	}
	syntheticBoot(t, syntheticBootTwo)
	if err := stop(ctx); err != nil {
		t.Fatalf("stop did not recover after group exit: %v", err)
	}
	persisted, err = readState(ctx.Instance.StatePath)
	if err != nil || persisted.StoppedAt == nil {
		t.Fatalf("stopped state not recorded: %+v %v", persisted, err)
	}
	if err := validateStartState(ctx, persisted); err != nil {
		t.Fatalf("start still refused after safe exit: %v", err)
	}
}

func TestIssue1275ForeignReusedIdentityDoesNotAuthorizeSignaling(t *testing.T) {
	_, record, reaped := startOwnedSleep(t)
	record.StartIdentity = "synthetic-stale-identity"
	ctx, state := issue1275State(t, record)
	previousSignal := signalProcessGroup
	calls := 0
	signalProcessGroup = func(int, syscall.Signal) error { calls++; return errors.New("unexpected group signal") }
	t.Cleanup(func() { signalProcessGroup = previousSignal })
	if !stateHasLiveProcesses(state) {
		t.Fatal("live unverified PID/group was treated as absent")
	}
	if err := validateStartState(ctx, state); err == nil {
		t.Fatal("start accepted unverified live record")
	}
	if err := stop(ctx); err == nil {
		t.Fatal("stop accepted unverified live record")
	}
	if calls != 0 {
		t.Fatalf("unverified group signaled %d times", calls)
	}
	if !processPIDAlive(record.PID) {
		t.Fatal("stop signaled unrelated fixture")
	}
	// Existing fixture cleanup owns and reaps this synthetic child.
	_ = reaped
}

func TestIssue1275MatchingLeaderInSharedGroupDoesNotAuthorizeGroupSignal(t *testing.T) {
	executable, err := processExecutable(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(os.Getpid(), "", executable)
	if err != nil {
		t.Fatal(err)
	}
	if record.PGID == record.PID {
		t.Skip("test process is itself a group leader; shared-group fixture unavailable")
	}
	previousSignal := signalProcessGroup
	calls := 0
	signalProcessGroup = func(int, syscall.Signal) error { calls++; return nil }
	t.Cleanup(func() { signalProcessGroup = previousSignal })
	if err := terminateRecord(record); err == nil {
		t.Fatal("shared process group unexpectedly authorized termination")
	}
	if calls != 0 {
		t.Fatalf("shared process group signaled %d times", calls)
	}
}

func TestIssue1275MalformedComponentRecordCannotCertifyQuiescence(t *testing.T) {
	ctx, state := issue1275State(t, componentRecord{})
	if !stateHasLiveProcesses(state) {
		t.Fatal("incomplete component ownership was treated as quiescent")
	}
	if err := validateStartState(ctx, state); err == nil {
		t.Fatal("start accepted incomplete component ownership")
	}
	if err := stop(ctx); err == nil {
		t.Fatal("stop accepted incomplete component ownership")
	}
	persisted, err := readState(ctx.Instance.StatePath)
	if err != nil || persisted.StoppedAt != nil {
		t.Fatalf("invalid record reported stopped: %+v %v", persisted, err)
	}
}

func TestIssue1275MalformedSupervisorCannotCertifyQuiescence(t *testing.T) {
	ctx, state := issue1275State(t, componentRecord{})
	state.Components = map[string]componentRecord{}
	state.Supervisor = componentRecord{PID: 12345}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	if !stateHasLiveProcesses(state) {
		t.Fatal("incomplete supervisor ownership treated as quiescent")
	}
	if err := validateStartState(ctx, state); err == nil {
		t.Fatal("start accepted incomplete supervisor ownership")
	}
	if err := stop(ctx); err == nil {
		t.Fatal("stop accepted incomplete supervisor ownership")
	}
	persisted, err := readState(ctx.Instance.StatePath)
	if err != nil || persisted.StoppedAt != nil {
		t.Fatalf("invalid supervisor reported stopped: %+v %v", persisted, err)
	}
}

func TestIssue1275DirectBackupRefusesLiveOrphanWithoutChangingDatabases(t *testing.T) {
	fixture := newV6ActivationFixture(t)
	fixture.ctx.Instance.ID = "synthetic-instance"
	record, child := startOrphanedGroup(t)
	digest, err := manifestDigest(fixture.ctx.PayloadRoot)
	if err != nil {
		t.Fatal(err)
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: fixture.ctx.Instance.ID, CanonicalStateDir: fixture.state, PayloadRoot: fixture.ctx.PayloadRoot, BuildID: fixture.old.BuildID, ManifestSHA256: digest, Components: map[string]componentRecord{"worker": record}}
	if err := writeState(fixture.ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	before := lifecycleDatabaseDigests(t, fixture.state)
	outputDir := t.TempDir()
	err = backup(fixture.ctx, []string{"--output", outputDir}, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "quiesce") {
		t.Fatalf("backup did not refuse unsafe quiescence: %v", err)
	}
	if entries, e := os.ReadDir(outputDir); e != nil || len(entries) != 0 {
		t.Fatalf("backup created an output before quiescence: %v %v", entries, e)
	}
	after := lifecycleDatabaseDigests(t, fixture.state)
	if !sameDatabaseDigests(before, after) {
		t.Fatalf("backup refusal changed synthetic DBs: %v -> %v", before, after)
	}
	if !recordMatchesLiveProcess(child) {
		t.Fatal("backup affected the unverified orphan")
	}
	// The test owns this child and verified its complete identity above. End
	// it directly, then require a fresh stop and a successful public backup.
	if err := syscall.Kill(child.PID, syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	if !waitForProcessGroupExit(record.PGID, 5*time.Second) {
		t.Fatal("fixture group did not exit")
	}
	syntheticBoot(t, syntheticBootTwo)
	if err := stop(fixture.ctx); err != nil {
		t.Fatalf("stop after group exit: %v", err)
	}
	if err := backup(fixture.ctx, []string{"--output", outputDir}, &bytes.Buffer{}); err != nil {
		t.Fatalf("backup after safe stop: %v", err)
	}
	entries, err := os.ReadDir(outputDir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected one recovered backup pair: %v %v", entries, err)
	}
	liveValues := lifecycleDatabaseValues(t, fixture.python, fixture.state)
	backupValues := lifecycleDatabaseValues(t, fixture.python, filepath.Join(outputDir, entries[0].Name()))
	if !sameDatabaseDigests(liveValues, backupValues) {
		t.Fatalf("backup pair reopened with wrong values: %v != %v", liveValues, backupValues)
	}
}

func TestIssue1275UpdateRefusesLiveOrphanBeforeSnapshot(t *testing.T) {
	fixture := newV6ActivationFixture(t)
	fixture.ctx.Instance.ID = "synthetic-instance"
	record, child := startOrphanedGroup(t)
	digest, err := manifestDigest(fixture.ctx.PayloadRoot)
	if err != nil {
		t.Fatal(err)
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: fixture.ctx.Instance.ID, CanonicalStateDir: fixture.state, PayloadRoot: fixture.ctx.PayloadRoot, BuildID: fixture.old.BuildID, ManifestSHA256: digest, Components: map[string]componentRecord{"worker": record}}
	if err := writeState(fixture.ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	before := lifecycleDatabaseDigests(t, fixture.state)
	err = promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "quiesce") {
		t.Fatalf("update did not refuse unsafe quiescence: %v", err)
	}
	after := lifecycleDatabaseDigests(t, fixture.state)
	if !sameDatabaseDigests(before, after) {
		t.Fatalf("update refusal changed synthetic DBs: %v -> %v", before, after)
	}
	if entries, e := os.ReadDir(filepath.Join(fixture.state, "backups")); e == nil && len(entries) != 0 {
		t.Fatalf("update created snapshot before quiescence: %v", entries)
	} else if e != nil && !os.IsNotExist(e) {
		t.Fatal(e)
	}
	if !recordMatchesLiveProcess(child) {
		t.Fatal("update affected the unverified orphan")
	}
}

func TestIssue1275RollbackRefusesLiveOrphanBeforeRestoringPair(t *testing.T) {
	fixture := newV6ActivationFixture(t)
	fixture.ctx.Instance.ID = "synthetic-instance"
	if _, err := snapshotPair(fixture.ctx, fixture.old); err != nil {
		t.Fatalf("seed retained pair: %v", err)
	}
	active, err := fixture.store.WriteSelectedActive(fixture.candidate, fixture.active.Generation, fixture.old.BuildID, "local-fixture")
	if err != nil {
		t.Fatal(err)
	}
	record, child := startOrphanedGroup(t)
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
	if err != nil {
		t.Fatal(err)
	}
	err = rollbackExisting(fixture.ctx, fixture.store, active, fixture.old.BuildID, &bytes.Buffer{})
	if err == nil || !strings.Contains(err.Error(), "component") {
		t.Fatalf("rollback did not refuse unsafe quiescence: %v", err)
	}
	after := lifecycleDatabaseDigests(t, fixture.state)
	if !sameDatabaseDigests(before, after) {
		t.Fatalf("rollback refusal changed synthetic DBs: %v -> %v", before, after)
	}
	afterBackups, err := os.ReadDir(filepath.Join(fixture.state, "backups"))
	if err != nil || len(afterBackups) != len(beforeBackups) {
		t.Fatalf("rollback created snapshot before quiescence: %v %v", afterBackups, err)
	}
	if !recordMatchesLiveProcess(child) {
		t.Fatal("rollback affected the unverified orphan")
	}
}
