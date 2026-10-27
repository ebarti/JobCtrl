//go:build darwin

package launcher

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

// A compiled test binary exercises the production helper entry without an
// environment-authorized production bypass or shell wrapper.
func init() {
	if len(os.Args) > 1 && os.Args[1] == executionHelperArgument {
		_, err := ownedExecutionHelper(os.Args[1:])
		if err != nil {
			os.Exit(1)
		}
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == "__scope-test-command" {
		if len(os.Args) != 6 {
			os.Exit(91)
		}
		ctx := launchContext{Instance: instance{ID: os.Args[3], StatePath: os.Args[2], StateDir: filepath.Join(filepath.Dir(os.Args[2]), "data"), RuntimeHome: filepath.Join(filepath.Dir(os.Args[2]), "runtime")}, Environment: os.Environ()}
		valid, err := authenticatedOwnedExecution(ctx)
		if err != nil || !valid {
			fmt.Fprintln(os.Stderr, "scope authentication failed")
			os.Exit(92)
		}
		fmt.Fprintln(os.Stdout, "scope authenticated")
		fmt.Fprintln(os.Stderr, "scope stderr")
		if os.Args[4] == "exit" {
			os.Exit(17)
		}
		if os.Args[4] == "stdin" {
			_, _ = io.Copy(os.Stdout, os.Stdin)
			os.Exit(0)
		}
		// Parent exits while a new session execs a platform binary. Its environment
		// is intentionally empty; coalition membership is the durable authority.
		command := exec.Command("/usr/bin/python3", "-c", `import os,sys
pid=os.fork()
if pid:
 open(sys.argv[1],"w").write(str(pid))
 os._exit(0)
os.setsid()
f=os.open("/dev/null",os.O_RDWR)
for n in (0,1,2): os.dup2(f,n)
os.execve("/bin/sleep",["sleep","60"],{})`, os.Args[5])
		if command.Run() != nil {
			os.Exit(93)
		}
		os.Exit(0)
	}
}
func executionTestContext(t *testing.T) launchContext {
	t.Helper()
	root := t.TempDir()
	executable, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	id, err := releaseRandomID()
	if err != nil {
		t.Fatal(err)
	}
	return launchContext{Executable: executable, Instance: instance{ID: id, StatePath: filepath.Join(root, "state.json"), StateDir: filepath.Join(root, "data"), RuntimeHome: filepath.Join(root, "runtime")}, Environment: []string{"PATH=/usr/bin:/bin", "SYNTHETIC_EXECUTION_SECRET=must-stay-off-disk"}}
}
func TestOwnedExecutionLaunchdIsolation(t *testing.T) {
	contexts := []launchContext{executionTestContext(t), executionTestContext(t)}
	var scopes []executionScope
	var pids []int
	defer func() {
		for i, pid := range pids {
			ids, err := processCoalitionIDs(pid)
			if err == nil && ids == scopes[i].CoalitionIDs {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	}()
	for _, ctx := range contexts {
		pidfile := filepath.Join(filepath.Dir(ctx.Instance.StatePath), "child.pid")
		var out, stderr bytes.Buffer
		if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "detach", pidfile}, &out, &stderr); err != nil {
			t.Fatal(err)
		}
		if out.String() != "scope authenticated\n" || stderr.String() != "scope stderr\n" {
			t.Fatalf("stdio not forwarded: %q %q", out.String(), stderr.String())
		}
		receipts, err := readOwnedExecutionScopes(ctx)
		if err != nil || len(receipts) != 1 {
			t.Fatalf("receipts: %v %v", receipts, err)
		}
		scope := receipts[0]
		scopes = append(scopes, scope)
		raw, err := os.ReadFile(filepath.Join(filepath.Dir(ctx.Instance.StatePath), "executions", scope.ID+".json"))
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(raw, []byte("must-stay-off-disk")) || bytes.Contains(raw, []byte("Environment")) {
			t.Fatal("environment persisted")
		}
		raw, err = os.ReadFile(pidfile)
		if err != nil {
			t.Fatal(err)
		}
		pid, err := strconv.Atoi(string(raw))
		if err != nil {
			t.Fatal(err)
		}
		pids = append(pids, pid)
		deadline := time.Now().Add(3 * time.Second)
		for {
			path, _ := processExecutable(pid)
			if path == "/bin/sleep" || path == "/usr/bin/sleep" {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("platform child did not exec: %q", path)
			}
			time.Sleep(10 * time.Millisecond)
		}
		ids, err := processCoalitionIDs(pid)
		if err != nil || ids != scope.CoalitionIDs {
			t.Fatalf("detached child lost coalition: %v %v", ids, err)
		}
		if _, err = processStartIdentity(scope.RootPID); !errors.Is(err, syscall.ESRCH) {
			t.Fatalf("helper root not reaped: %v", err)
		}
		forged := ctx
		forged.Environment = append(forged.Environment, executionScopeVariable+"="+scope.ID)
		if valid, err := authenticatedOwnedExecution(forged); valid || err == nil {
			t.Fatal("outer process authorized by environment alone")
		}
	}
	if scopes[0].CoalitionIDs[0] == scopes[1].CoalitionIDs[0] || scopes[0].CoalitionIDs[1] == scopes[1].CoalitionIDs[1] {
		t.Fatal("instances shared coalition")
	}
	identity, err := processStartIdentity(pids[0])
	if err != nil {
		t.Fatal(err)
	}
	ids, err := processCoalitionIDs(pids[0])
	if err != nil || ids != scopes[0].CoalitionIDs {
		t.Fatal("cleanup authority mismatch")
	}
	after, err := processStartIdentity(pids[0])
	if err != nil || after != identity {
		t.Fatal("cleanup PID identity changed")
	}
	if err = syscall.Kill(pids[0], syscall.SIGKILL); err != nil {
		t.Fatal(err)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		info, err := procInfo(pids[0], procPIDTBSDInfo, procBSDInfoSize)
		if errors.Is(err, syscall.ESRCH) || (err == nil && info[4] == 5) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("owned detached child survived cleanup")
		}
		time.Sleep(10 * time.Millisecond)
	}
	ids, err = processCoalitionIDs(pids[1])
	if err != nil || ids != scopes[1].CoalitionIDs {
		t.Fatal("second instance was not preserved")
	}
}
func TestOwnedExecutionExitStatus(t *testing.T) {
	ctx := executionTestContext(t)
	var out, stderr bytes.Buffer
	err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "exit", "unused"}, &out, &stderr)
	var exited interface{ ExitCode() int }
	if !errors.As(err, &exited) || exited.ExitCode() != 17 {
		t.Fatalf("wrong exit result: %v", err)
	}
	if out.String() != "scope authenticated\n" || stderr.String() != "scope stderr\n" {
		t.Fatal("stdio lost on failure")
	}
}
func TestOwnedExecutionParentEOFDoesNotAdmitWork(t *testing.T) {
	directory, err := os.MkdirTemp("/tmp", "jc-exec-eof-")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(directory)
	socket := filepath.Join(directory, "control")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: socket, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	_ = listener.SetDeadline(time.Now().Add(3 * time.Second))
	executable, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	challenge, err := releaseRandomID()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(executable, executionHelperArgument, socket, challenge)
	if err = child.Start(); err != nil {
		t.Fatal(err)
	}
	defer child.Process.Kill()
	connection, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	var hello executionHello
	if err = json.NewDecoder(connection).Decode(&hello); err != nil {
		t.Fatal(err)
	}
	if hello.PID != child.Process.Pid || hello.Challenge != challenge {
		t.Fatal("helper handshake mismatch")
	}
	// Even descriptors alone must not admit a partially transmitted command.
	null, err := os.OpenFile(os.DevNull, os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer null.Close()
	if _, _, err = connection.WriteMsgUnix([]byte{1}, syscall.UnixRights(int(null.Fd()), int(null.Fd()), int(null.Fd())), nil); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(directory, "must-not-exist")
	payload, err := json.Marshal(executionCommand{"/usr/bin/touch", []string{marker}, nil, directory})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = connection.Write(payload[:len(payload)-1])
	connection.Close()
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("incomplete authorization succeeded")
		}
	case <-time.After(3 * time.Second):
		t.Fatal("helper did not stop after parent EOF")
	}
	if _, err := os.Stat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("partially authorized target executed")
	}
}
func TestOwnedExecutionRejectsUnsafeReceipts(t *testing.T) {
	ctx := executionTestContext(t)
	dir, err := executionScopeDirectory(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	path := filepath.Join(dir, id+".json")
	if err = os.Symlink(filepath.Join(dir, "missing"), path); err != nil {
		t.Fatal(err)
	}
	if _, err = readOwnedExecutionScopes(ctx); err == nil {
		t.Fatal("linked receipt accepted")
	}
	os.Remove(path)
	if err = os.WriteFile(path, []byte(`{"unknown":true}`), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = readOwnedExecutionScopes(ctx); err == nil {
		t.Fatal("unfamiliar receipt accepted")
	}
	os.Remove(path)
	if err = os.WriteFile(path, []byte(`{}`), 0644); err != nil {
		t.Fatal(err)
	}
	if _, err = readOwnedExecutionScopes(ctx); err == nil {
		t.Fatal("public receipt accepted")
	}
}

func TestOwnedExecutionStdin(t *testing.T) {
	ctx := executionTestContext(t)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	_, _ = io.WriteString(writer, "synthetic stdin\n")
	writer.Close()
	original := os.Stdin
	os.Stdin = reader
	defer func() { os.Stdin = original }()
	var output bytes.Buffer
	if err = runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "stdin", "unused"}, &output, io.Discard); err != nil {
		t.Fatal(err)
	}
	if output.String() != "scope authenticated\nsynthetic stdin\n" {
		t.Fatalf("stdin was not forwarded: %q", output.String())
	}
}
