package launcher

import (
	"errors"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// The synthetic leader owns a same-group child and must finish its work before
// the child exits. External group-wide TERM breaks that ordering.
func TestCooperativeStopDrainsOwnedChild(t *testing.T) {
	dir := os.Getenv("JOBCTRL_TEST_DRAIN_DIR")
	switch os.Getenv("JOBCTRL_TEST_DRAIN_ROLE") {
	case "child":
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM)
		defer signal.Stop(sig)
		if err := os.WriteFile(filepath.Join(dir, "child-ready"), []byte("ready"), 0600); err != nil {
			t.Fatal(err)
		}
		for {
			select {
			case <-sig:
				_ = os.WriteFile(filepath.Join(dir, "child-signaled"), []byte("unsafe"), 0600)
				os.Exit(2)
			default:
				if _, err := os.Stat(filepath.Join(dir, "child-release")); err == nil {
					return
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
	case "leader":
		executable, err := os.Executable()
		if err != nil {
			t.Fatal(err)
		}
		child := exec.Command(executable, "-test.run=^TestCooperativeStopDrainsOwnedChild$")
		child.Env = append(os.Environ(), "JOBCTRL_TEST_DRAIN_ROLE=child")
		if err := child.Start(); err != nil {
			t.Fatal(err)
		}
		defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
		sig := make(chan os.Signal, 1)
		signal.Notify(sig, syscall.SIGTERM)
		defer signal.Stop(sig)
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(filepath.Join(dir, "child-ready")); err == nil {
				break
			}
			time.Sleep(10 * time.Millisecond)
		}
		if _, err := os.Stat(filepath.Join(dir, "child-ready")); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dir, "leader-ready"), []byte("ready"), 0600); err != nil {
			t.Fatal(err)
		}
		select {
		case <-sig:
		case <-time.After(10 * time.Second):
			t.Fatal("leader never received stop")
		}
		if err := os.WriteFile(filepath.Join(dir, "child-release"), []byte("stop"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := child.Wait(); err != nil {
			t.Fatalf("child did not drain cleanly: %v", err)
		}
		if err := os.WriteFile(filepath.Join(dir, "drained"), []byte("done"), 0600); err != nil {
			t.Fatal(err)
		}
		return
	}
	dir = t.TempDir()
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	leader := exec.Command(executable, "-test.run=^TestCooperativeStopDrainsOwnedChild$")
	leader.Env = []string{"JOBCTRL_TEST_DRAIN_ROLE=leader", "JOBCTRL_TEST_DRAIN_DIR=" + dir, "PATH=/usr/bin:/bin"}
	leader.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := leader.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := make(chan error, 1)
	go func() { reaped <- leader.Wait() }()
	record, err := recordForProcess(leader.Process.Pid, "", executable)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if recordMatchesLiveProcess(record) {
			_ = syscall.Kill(record.PID, syscall.SIGKILL)
		}
		select {
		case <-reaped:
		case <-time.After(time.Second):
		}
	})
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(dir, "leader-ready")); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(dir, "leader-ready")); err != nil {
		t.Fatal(err)
	}
	ctx, state := issue1275State(t, record)
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("owned component did not stop: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "child-signaled")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("child received external group signal: %v", err)
	}
	if raw, err := os.ReadFile(filepath.Join(dir, "drained")); err != nil || string(raw) != "done" {
		t.Fatalf("leader did not finish drain: %q %v", raw, err)
	}
}

func TestCooperativeStopEscalatesVerifiedHungLeader(t *testing.T) {
	ready := filepath.Join(t.TempDir(), "ready")
	child := exec.Command("/bin/sh", "-c", `trap '' TERM; printf ready > "$1"; exec /bin/sleep 60`, "fixture", ready)
	child.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := make(chan error, 1)
	go func() { reaped <- child.Wait() }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(ready); err != nil {
		t.Fatal(err)
	}
	record, err := recordForProcess(child.Process.Pid, "", "/bin/sleep")
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for !recordMatchesLiveProcess(record) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !recordMatchesLiveProcess(record) {
		t.Fatal("owned child did not exec sleep")
	}
	t.Cleanup(func() {
		if recordMatchesLiveProcess(record) {
			_ = syscall.Kill(record.PID, syscall.SIGKILL)
		}
		select {
		case <-reaped:
		case <-time.After(time.Second):
		}
	})
	if err := terminateCooperativeRecord(record, 100*time.Millisecond); err != nil {
		t.Fatalf("verified hung leader did not terminate: %v", err)
	}
	if processPIDAlive(record.PID) || processGroupAlive(record.PGID) {
		t.Fatal("hung leader or its group survived")
	}
}

func TestCooperativeStopRefusesGroupAfterLeaderExits(t *testing.T) {
	dir := t.TempDir()
	childPath, readyPath := filepath.Join(dir, "child"), filepath.Join(dir, "ready")
	leader := exec.Command("/bin/sh", "-c", `trap 'exit 0' TERM; /bin/sleep 60 & printf '%s' "$!" > "$1"; printf ready > "$2"; wait`, "fixture", childPath, readyPath)
	leader.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := leader.Start(); err != nil {
		t.Fatal(err)
	}
	reaped := make(chan error, 1)
	go func() { reaped <- leader.Wait() }()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(readyPath); err == nil {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if _, err := os.Stat(readyPath); err != nil {
		t.Fatal(err)
	}
	leaderExecutable, err := processExecutable(leader.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	leaderRecord, err := recordForProcess(leader.Process.Pid, "", leaderExecutable)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(childPath)
	if err != nil {
		t.Fatal(err)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(string(raw)))
	if err != nil {
		t.Fatal(err)
	}
	childRecord, err := recordForProcess(childPID, "", "/bin/sleep")
	if err != nil {
		t.Fatal(err)
	}
	deadline = time.Now().Add(5 * time.Second)
	for !recordMatchesLiveProcess(childRecord) && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if !recordMatchesLiveProcess(childRecord) {
		t.Fatal("owned child did not exec sleep")
	}
	t.Cleanup(func() {
		if recordMatchesLiveProcess(childRecord) {
			_ = syscall.Kill(childPID, syscall.SIGKILL)
		}
		if recordMatchesLiveProcess(leaderRecord) {
			_ = syscall.Kill(leaderRecord.PID, syscall.SIGKILL)
		}
		select {
		case <-reaped:
		case <-time.After(time.Second):
		}
	})
	if err := terminateCooperativeRecord(leaderRecord, 2*time.Second); err == nil || !strings.Contains(err.Error(), "ownership is unresolved") {
		t.Fatalf("expected unresolved group refusal, got %v", err)
	}
	if !recordMatchesLiveProcess(childRecord) {
		t.Fatal("unanchored child was signaled or lost ownership")
	}
}

func TestCooperativeStopRefusesUnverifiedLeader(t *testing.T) {
	_, record, _ := startOwnedSleep(t)
	record.StartIdentity = "different-start"
	if err := terminateCooperativeRecord(record, 100*time.Millisecond); err == nil {
		t.Fatal("unverified leader must be refused")
	}
	if !processPIDAlive(record.PID) {
		t.Fatal("unverified process was signaled")
	}
}
