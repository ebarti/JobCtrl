//go:build darwin

package launcher

import (
	"bytes"
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
			parent, err := startComponent(ctx, &state, "worker")
			if err != nil {
				t.Fatal(err)
			}
			if err := parent.Wait(); err != nil {
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
			defer syscall.Kill(pid, syscall.SIGKILL)
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
	inspectOwnedProcesses = func(launchContext, instanceState) ([]ownedProcess, error) {
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
	defer func() {
		for _, pid := range pids {
			_ = syscall.Kill(pid, syscall.SIGKILL)
		}
	}()
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
