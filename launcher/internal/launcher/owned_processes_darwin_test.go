//go:build darwin

package launcher

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
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

func registerVerifiedScopeChildCleanup(t *testing.T, ctx launchContext, pid int) {
	t.Helper()
	identity, err := processStartIdentity(pid)
	if err != nil {
		t.Fatalf("owned synthetic child identity unavailable: %v", err)
	}
	ids, err := processCoalitionIDs(pid)
	if err != nil {
		t.Fatalf("owned synthetic child scope unavailable: %v", err)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		t.Fatalf("owned synthetic scope receipt unavailable: %v", err)
	}
	verified := false
	for _, scope := range scopes {
		verified = verified || scope.CoalitionIDs == ids
	}
	if !verified {
		t.Fatal("synthetic child does not match the test's owned scope")
	}
	t.Cleanup(func() {
		if err := signalExecutionRoot(ids, pid, identity, syscall.SIGKILL); err != nil {
			t.Errorf("cleanup verified synthetic child: %v", err)
		}
	})
}

func TestNativeOwnedProcessCensusIsInstanceBound(t *testing.T) {
	ctx, _ := issue1275State(t, componentRecord{})
	python := migrationIntegrationPython(t)
	own := exec.Command(python, "-I", "-B", "-c", "import time; time.sleep(60)")
	own.Env = ownedProcessEnvironment(ctx)
	own.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := own.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = own.Process.Kill(); _ = own.Wait() }()
	foreign := exec.Command(python, "-I", "-B", "-c", "import time; time.sleep(60)")
	foreign.Env = []string{processOwnerVariable + "=another-instance"}
	if err := foreign.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = foreign.Process.Kill(); _ = foreign.Wait() }()
	found, err := discoverOwnedProcesses(ctx, instanceState{})
	if err != nil {
		t.Fatal(err)
	}
	if len(found) != 1 || found[0].PID != own.Process.Pid {
		t.Fatalf("wrong owned process census: %v", found)
	}
	if err := terminateOwnedProcesses(ctx, instanceState{}); err != nil {
		t.Fatal(err)
	}
	if !processPIDAlive(foreign.Process.Pid) {
		t.Fatal("another instance was terminated")
	}
}

func TestStopCleansDetachedWriterAndAllowsNormalRestart(t *testing.T) {
	for _, ignoreTERM := range []bool{false, true} {
		t.Run(fmt.Sprint(ignoreTERM), func(t *testing.T) {
			ctx, state := issue1275State(t, componentRecord{})
			delete(state.Components, "worker")
			ctx.Instance.LogDir = t.TempDir()
			python := migrationIntegrationPython(t)
			if err := os.Symlink(python, filepath.Join(ctx.PayloadRoot, "owned-python")); err != nil {
				t.Fatal(err)
			}
			dir := t.TempDir()
			pidFile, writer := filepath.Join(dir, "pid"), filepath.Join(dir, "writes")
			code := `import os,signal,sys,time
if os.fork(): os._exit(0)
os.setsid()
if sys.argv[3]=='true': signal.signal(signal.SIGTERM,signal.SIG_IGN)
open(sys.argv[1],'w').write(str(os.getpid()))
while True:
 with open(sys.argv[2],'a') as f: f.write('owned\\n'); f.flush()
 time.sleep(.02)
`
			ctx.Manifest.Components = []commandSpec{{Name: "worker", Executable: "owned-python", Arguments: []string{"-I", "-B", "-c", code, pidFile, writer, strconv.FormatBool(ignoreTERM)}}}
			if err := writeState(ctx.Instance.StatePath, state); err != nil {
				t.Fatal(err)
			}
			ctx.Executable, _ = CurrentProcessExecutable()
			ctx.Instance.RuntimeHome = t.TempDir()
			encoded, err := json.Marshal(ctx)
			if err != nil {
				t.Fatal(err)
			}
			if err := runInOwnedExecution(ctx, []string{"__scope-component-test", string(encoded)}, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			state, err = readState(ctx.Instance.StatePath)
			if err != nil {
				t.Fatal(err)
			}
			var pid int
			for deadline := time.Now().Add(5 * time.Second); time.Now().Before(deadline); {
				if raw, err := os.ReadFile(pidFile); err == nil {
					pid, _ = strconv.Atoi(string(raw))
					if pid > 0 {
						break
					}
				}
				time.Sleep(10 * time.Millisecond)
			}
			if pid == 0 {
				t.Fatal("owned detached writer did not start")
			}
			registerVerifiedScopeChildCleanup(t, ctx, pid)
			if processGroupAlive(state.Components["worker"].PGID) {
				t.Fatal("fixture did not escape its recorded process group")
			}
			var out bytes.Buffer
			if err := status(ctx, &out, true); err != nil || !strings.Contains(out.String(), "orphaned") {
				t.Fatalf("status hid detached child: %v %s", err, out.String())
			}
			if err := stop(ctx); err != nil {
				t.Fatalf("normal cleanup failed: %v", err)
			}
			after, err := readState(ctx.Instance.StatePath)
			if err != nil || after.StoppedAt == nil {
				t.Fatalf("successful stop not recorded: %v", err)
			}
			if p, err := inspectOwnedProcesses(ctx, after); err != nil || len(p) != 0 {
				t.Fatalf("owned processes remain: %v count=%d", err, len(p))
			}
			if err := validateStartState(ctx, after); err != nil {
				t.Fatalf("restart still blocked: %v", err)
			}
			before, err := os.Stat(writer)
			if err != nil {
				t.Fatal(err)
			}
			time.Sleep(100 * time.Millisecond)
			afterFile, err := os.Stat(writer)
			if err != nil || before.Size() != afterFile.Size() {
				t.Fatal("writer survived successful cleanup")
			}
		})
	}
}

func TestStopReportsActualInspectionFailureWithoutChangingRegistry(t *testing.T) {
	ctx, _ := issue1275State(t, componentRecord{})
	before, err := os.ReadFile(ctx.Instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	prior := inspectOwnedProcesses
	t.Cleanup(func() { inspectOwnedProcesses = prior })
	inspectOwnedProcesses = func(launchContext, instanceState, ...executionWitnesses) ([]ownedProcess, error) {
		return nil, errors.New("synthetic permission failure")
	}
	if err := stop(ctx); err == nil || !strings.Contains(err.Error(), "synthetic permission failure") {
		t.Fatalf("actual cleanup failure hidden: %v", err)
	}
	after, err := os.ReadFile(ctx.Instance.StatePath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("failed cleanup changed registry")
	}
}

func TestOwnershipRetryCannotAdoptReusedProcessIdentity(t *testing.T) {
	ctx, _ := issue1275State(t, componentRecord{})
	child := exec.Command(migrationIntegrationPython(t), "-I", "-B", "-c", "import time;time.sleep(60)")
	child.Env = ownedProcessEnvironment(ctx)
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	prior := readProcessOwnership
	t.Cleanup(func() { readProcessOwnership = prior })
	calls := 0
	readProcessOwnership = func(pid int) (ownedProcess, error) {
		if pid != child.Process.Pid {
			return prior(pid)
		}
		p, err := prior(pid)
		if err != nil {
			return p, err
		}
		calls++
		if calls == 1 {
			return p, syscall.EIO
		}
		p.Identity = "replacement-identity"
		p.owner = "another-instance"
		return p, nil
	}
	owned, err := discoverOwnedProcesses(ctx, instanceState{})
	if err != nil {
		t.Fatal(err)
	}
	if len(owned) != 0 {
		t.Fatal("inspection retry transferred authority to a different process identity")
	}
	if !processPIDAlive(child.Process.Pid) {
		t.Fatal("ownership retry signaled a replacement process")
	}
}

func TestActualStopFindsDetachedPlatformExecutionAndPreservesOtherInstance(t *testing.T) {
	contexts := []launchContext{executionTestContext(t), executionTestContext(t)}
	pids := make([]int, 0, 2)
	for i := range contexts {
		ctx := &contexts[i]
		root := filepath.Dir(ctx.Instance.StatePath)
		ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
		ctx.Instance.LockPath = filepath.Join(root, "instance.lock")
		pidfile := filepath.Join(root, "child.pid")
		if err := runInOwnedExecution(*ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "detach", pidfile}, io.Discard, io.Discard); err != nil {
			t.Fatal(err)
		}
		raw, err := os.ReadFile(pidfile)
		if err != nil {
			t.Fatal(err)
		}
		pid, err := strconv.Atoi(string(raw))
		if err != nil {
			t.Fatal(err)
		}
		pids = append(pids, pid)
		registerVerifiedScopeChildCleanup(t, *ctx, pid)
		for deadline := time.Now().Add(3 * time.Second); ; {
			p, err := readProcessScope(pid)
			if err == nil && p.ParentPID == 1 && p.owner == "" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("fixture did not become an untagged platform orphan: %v", err)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	var statusOut bytes.Buffer
	if err := status(contexts[0], &statusOut, true); err != nil || !strings.Contains(statusOut.String(), "orphaned") {
		t.Fatalf("status hid platform child: %v %s", err, statusOut.String())
	}
	if err := stop(contexts[0]); err != nil {
		t.Fatal(err)
	}
	if owned, err := inspectOwnedProcesses(contexts[0], instanceState{}); err != nil || len(owned) != 0 {
		t.Fatalf("cleanup incomplete: %v count=%d", err, len(owned))
	}
	if !processPIDAlive(pids[1]) {
		t.Fatal("cleanup killed the other instance")
	}
	if err := stop(contexts[0]); err != nil {
		t.Fatalf("repeated cleanup failed: %v", err)
	}
	// A new tracked command is admitted normally after successful cleanup.
	var restarted bytes.Buffer
	err := runInOwnedExecution(contexts[0], []string{"__scope-test-command", contexts[0].Instance.StatePath, contexts[0].Instance.ID, "stdin", "unused"}, &restarted, io.Discard)
	if err != nil {
		t.Fatalf("normal restart required manual recovery: %v", err)
	}
	if err := stop(contexts[0]); err != nil {
		t.Fatal(err)
	}
	if err := stop(contexts[1]); err != nil {
		t.Fatal(err)
	}
}

func init() {
	if len(os.Args) == 5 && os.Args[1] == "__scope-stop-checkpoint-test" {
		root, id, stage := os.Args[2], os.Args[3], os.Args[4]
		ctx := launchContext{Instance: instance{ID: id, StatePath: filepath.Join(root, "state.json"), StateDir: filepath.Join(root, "data"), RuntimeHome: filepath.Join(root, "runtime"), ControlPath: filepath.Join(root, "control.lock"), LockPath: filepath.Join(root, "instance.lock")}}
		stopCompletionCheckpoint = func(at string) error {
			if at == stage {
				os.Exit(77)
			}
			return nil
		}
		if err := stop(ctx); err != nil {
			os.Exit(91)
		}
		os.Exit(92)
	}
}

func TestStopFinalizationRecoversAfterActualProcessInterruption(t *testing.T) {
	for _, stage := range []string{"stopped-proof-durable", "execution-completions-durable", "execution-receipts-retired"} {
		t.Run(stage, func(t *testing.T) {
			ctx := executionTestContext(t)
			root := filepath.Dir(ctx.Instance.StatePath)
			ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
			ctx.Instance.LockPath = filepath.Join(root, "instance.lock")
			pidfile := filepath.Join(root, "child.pid")
			if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "detach", pidfile}, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			raw, err := os.ReadFile(pidfile)
			if err != nil {
				t.Fatal(err)
			}
			pid, _ := strconv.Atoi(string(raw))
			registerVerifiedScopeChildCleanup(t, ctx, pid)
			scopes, err := readOwnedExecutionScopes(ctx)
			if err != nil || len(scopes) != 1 {
				t.Fatalf("missing scope: %v", err)
			}
			state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: ctx.Instance.ID, CanonicalStateDir: ctx.Instance.StateDir, PayloadRoot: root, BuildID: "checkpoint-fixture", ManifestSHA256: strings.Repeat("a", 64), Components: map[string]componentRecord{}, ExecutionScopeID: scopes[0].ID}
			if err := writeState(ctx.Instance.StatePath, state); err != nil {
				t.Fatal(err)
			}
			executable, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			child := exec.Command(executable, "__scope-stop-checkpoint-test", root, ctx.Instance.ID, stage)
			if err := child.Run(); err == nil {
				t.Fatal("stop process did not terminate at durable checkpoint")
			} else if exit, ok := err.(*exec.ExitError); !ok || exit.ExitCode() != 77 {
				t.Fatalf("wrong checkpoint exit: %v", err)
			}
			stopped, err := readState(ctx.Instance.StatePath)
			if err != nil || !stopped.OwnershipVerified || stopped.StoppedAt == nil {
				t.Fatalf("durable stop proof missing: %v", err)
			}
			completion, err := readExecutionCompletion(ctx, scopes[0].ID)
			if err != nil || completion.Scope != scopes[0] {
				t.Fatalf("interrupted stop lost its exact scope proof: %v", err)
			}
			if err := stop(ctx); err != nil {
				t.Fatalf("interrupted cleanup was not recoverable: %v", err)
			}
			if rows, err := readOwnedExecutionScopes(ctx); err != nil || len(rows) != 0 {
				t.Fatalf("receipts not retired: %v", err)
			}
			if completion, err := readExecutionCompletion(ctx, scopes[0].ID); err != nil || completion.Scope != scopes[0] {
				t.Fatalf("interrupted stop lost its durable execution completion: %v", err)
			}
		})
	}
}

func init() {
	if len(os.Args) == 3 && os.Args[1] == "__scope-component-test" {
		var ctx launchContext
		if json.Unmarshal([]byte(os.Args[2]), &ctx) != nil {
			os.Exit(81)
		}
		ctx.Environment = os.Environ()
		if valid, err := authenticatedOwnedExecution(ctx); err != nil || !valid {
			os.Exit(82)
		}
		state, err := readState(ctx.Instance.StatePath)
		if err != nil {
			os.Exit(83)
		}
		state.ExecutionScopeID = environmentMap(ctx.Environment)[executionScopeVariable]
		state.OwnershipVerified = false
		if writeState(ctx.Instance.StatePath, state) != nil {
			os.Exit(84)
		}
		child, err := startComponent(ctx, &state, "worker")
		if err != nil {
			os.Exit(85)
		}
		if child.Wait() != nil {
			os.Exit(86)
		}
		os.Exit(0)
	}
}

func TestStopAllowsScopedCommandRootToDrainItsOwnChild(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
	ctx.Instance.LockPath = filepath.Join(root, "instance.lock")
	pidfile, marker := filepath.Join(root, "child.pid"), filepath.Join(root, "external-term")
	done := make(chan error, 1)
	go func() {
		done <- runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "supervisor", pidfile + "|" + marker}, io.Discard, io.Discard)
	}()
	for deadline := time.Now().Add(5 * time.Second); ; {
		if _, err := os.Stat(pidfile); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("scoped command child did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := stop(ctx); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		var code interface{ ExitCode() int }
		if !errors.As(err, &code) || code.ExitCode() != 42 {
			t.Fatalf("root did not finish its own clean shutdown: %v", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("scoped command did not exit")
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("stop signaled a cooperative child before its root could drain it")
	}
}

func init() {
	if len(os.Args) == 4 && os.Args[1] == "__scope-platform-orphan-test" {
		var ctx launchContext
		if json.Unmarshal([]byte(os.Args[2]), &ctx) != nil {
			os.Exit(81)
		}
		ctx.Environment = os.Environ()
		if valid, err := authenticatedOwnedExecution(ctx); err != nil || !valid {
			os.Exit(82)
		}
		command := exec.Command("/usr/bin/python3", "-c", `import os,sys
pid=os.fork()
if pid:
 open(sys.argv[1],'w').write(str(pid));os._exit(0)
os.setsid()
f=os.open('/dev/null',os.O_RDWR)
for n in (0,1,2):os.dup2(f,n)
os.execve('/bin/sleep',['sleep','60'],{})`, os.Args[3])
		if command.Run() != nil {
			os.Exit(83)
		}
		os.Exit(0)
	}
}

func TestDirectBackupCleansScopedPlatformOrphanAndReopensPair(t *testing.T) {
	fixture := newV6ActivationFixtureWithPython(t, migrationIntegrationPython(t))
	fixture.ctx.Instance.ID = "scoped-backup-fixture"
	fixture.ctx.Executable, _ = CurrentProcessExecutable()
	encoded, err := json.Marshal(fixture.ctx)
	if err != nil {
		t.Fatal(err)
	}
	pidfile := filepath.Join(t.TempDir(), "pid")
	if err := runInOwnedExecution(fixture.ctx, []string{"__scope-platform-orphan-test", string(encoded), pidfile}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(pidfile)
	if err != nil {
		t.Fatal(err)
	}
	pid, _ := strconv.Atoi(string(raw))
	registerVerifiedScopeChildCleanup(t, fixture.ctx, pid)
	for deadline := time.Now().Add(3 * time.Second); ; {
		p, err := readProcessScope(pid)
		if err == nil && p.ParentPID == 1 && p.owner == "" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("platform orphan fixture not ready: %v", err)
		}
		time.Sleep(10 * time.Millisecond)
	}
	before := lifecycleDatabaseValues(t, fixture.python, fixture.state)
	outputDir := t.TempDir()
	if err := backup(fixture.ctx, []string{"--output", outputDir}, io.Discard); err != nil {
		t.Fatalf("direct backup did not clean its detached process: %v", err)
	}
	if p, err := inspectOwnedProcesses(fixture.ctx, instanceState{}); err != nil || len(p) != 0 {
		t.Fatalf("backup ran before complete cleanup: %v count=%d", err, len(p))
	}
	entries, err := os.ReadDir(outputDir)
	if err != nil || len(entries) != 1 {
		t.Fatalf("coherent pair missing: %v", err)
	}
	live := lifecycleDatabaseValues(t, fixture.python, fixture.state)
	saved := lifecycleDatabaseValues(t, fixture.python, filepath.Join(outputDir, entries[0].Name()))
	if !sameDatabaseDigests(before, live) || !sameDatabaseDigests(live, saved) {
		t.Fatal("backup changed or failed to reopen the protected synthetic pair")
	}
}

func TestForgedScopeEnvironmentCannotHideLiveTransport(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
	ctx.Instance.LockPath = filepath.Join(root, "instance.lock")
	pidfile, marker := filepath.Join(root, "pid"), filepath.Join(root, "signal")
	done := make(chan error, 1)
	go func() {
		done <- runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "signal", pidfile + "|" + marker}, io.Discard, io.Discard)
	}()
	for deadline := time.Now().Add(5 * time.Second); ; {
		if _, err := os.Stat(pidfile); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("scoped command did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	defer func() {
		_ = stop(ctx)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
		}
	}()
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("scope missing: %v", err)
	}
	forged := ctx
	forged.Environment = append(append([]string{}, ctx.Environment...), executionScopeVariable+"="+scopes[0].ID)
	members, err := discoverOwnedProcesses(forged, instanceState{})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, member := range members {
		if member.PID == scopes[0].RootPID {
			found = true
		}
	}
	if !found {
		t.Fatal("environment flag hid a live transport without kernel ownership")
	}
}
