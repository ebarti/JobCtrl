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
	"os/signal"
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
	if len(os.Args) > 1 && os.Args[1] == "__scope-test-outer" {
		if len(os.Args) != 7 {
			os.Exit(94)
		}
		executable, err := CurrentProcessExecutable()
		if err != nil {
			os.Exit(95)
		}
		ctx := launchContext{Executable: executable, Instance: instance{ID: os.Args[3], StatePath: filepath.Join(os.Args[2], "state.json"), StateDir: filepath.Join(os.Args[2], "data"), RuntimeHome: filepath.Join(os.Args[2], "runtime")}, Environment: os.Environ()}
		mode := os.Args[4]
		if mode == "restore" {
			mode = "exit"
		}
		err = runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, mode, os.Args[5] + "|" + os.Args[6]}, os.Stdout, os.Stderr)
		if os.Args[4] == "restore" {
			_ = syscall.Kill(os.Getpid(), syscall.SIGTERM)
			time.Sleep(100 * time.Millisecond)
			os.Exit(97)
		}
		var exited interface{ ExitCode() int }
		if errors.As(err, &exited) {
			os.Exit(exited.ExitCode())
		}
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(96)
		}
		os.Exit(0)
	}
	if len(os.Args) > 1 && os.Args[1] == executionHelperArgument {
		// Only this compiled test helper shortens the ignoring-root fixture's
		// grace. Production commands retain their configured shutdown budgets.
		executionCommandGrace = func(args []string) time.Duration {
			if len(args) > 3 && args[0] == "__scope-test-command" && args[3] == "ignore-root" {
				return time.Second
			}
			return executionShutdownGrace(args)
		}
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
		if os.Args[4] == "network" {
			connection, err := net.DialTimeout("tcp", os.Args[5], 2*time.Second)
			if err != nil {
				fmt.Fprintln(os.Stderr, "loopback connect failed")
				os.Exit(102)
			}
			connection.Close()
			fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_STREAM, 0)
			if err != nil {
				os.Exit(103)
			}
			_ = syscall.SetNonblock(fd, true)
			err = syscall.Connect(fd, &syscall.SockaddrInet4{Port: 9, Addr: [4]byte{192, 0, 2, 1}})
			syscall.Close(fd)
			if !errors.Is(err, syscall.EPERM) {
				fmt.Fprintf(os.Stderr, "nonloopback connect was not EPERM: %v\n", err)
				os.Exit(104)
			}
			fmt.Fprintln(os.Stdout, "loopback allowed; nonloopback denied")
			os.Exit(0)
		}
		if os.Args[4] == "signal" || os.Args[4] == "disconnect" || os.Args[4] == "ignore-root" {
			paths := strings.Split(os.Args[5], "|")
			script := `import os,signal,sys,time
os.setsid()
def received(value,frame):
 if sys.argv[3] == "ignore-root":
  with open(sys.argv[2],"a") as f: f.write(str(value)+'\n')
 else: open(sys.argv[2],"w").write(str(value))
 if sys.argv[3] not in ("disconnect","ignore-root"): sys.exit(23)
signal.signal(signal.SIGINT,received)
signal.signal(signal.SIGTERM,received)
open(sys.argv[1],"w").write(str(os.getpid()))
while True: time.sleep(.05)`
			arguments := []string{"/usr/bin/python3", "-c", script, paths[0], paths[1], os.Args[4]}
			if os.Args[4] == "signal" || os.Args[4] == "ignore-root" {
				// Match production's direct-Python exec: PID/start identity stays
				// bound to the command root across the native-to-Python exec.
				_ = syscall.Exec(arguments[0], arguments, os.Environ())
				os.Exit(98)
			}
			// This native parent exits on TERM, leaving an ignoring detached
			// child to exercise the separately timed leftover escalation.
			command := exec.Command(arguments[0], arguments[1:]...)
			if command.Run() != nil {
				os.Exit(23)
			}
			os.Exit(0)
		}
		if os.Args[4] == "supervisor" {
			paths := strings.Split(os.Args[5], "|")
			read, write, err := os.Pipe()
			if err != nil {
				os.Exit(99)
			}
			command := exec.Command("/usr/bin/python3", "-c", `import os,signal,sys
os.setsid()
def external(value,frame): open(sys.argv[2],"w").write(str(value))
signal.signal(signal.SIGTERM,external)
signal.signal(signal.SIGINT,external)
open(sys.argv[1],"w").write(str(os.getpid()))
if sys.stdin.readline().strip()=="drain": open(sys.argv[2]+".drained","w").write("ordered")`, paths[0], paths[1])
			command.Stdin = read
			stopping := make(chan os.Signal, 1)
			signal.Notify(stopping, os.Interrupt, syscall.SIGTERM)
			if command.Start() != nil {
				os.Exit(100)
			}
			<-stopping
			time.Sleep(200 * time.Millisecond)
			_, _ = io.WriteString(write, "drain\n")
			write.Close()
			read.Close()
			if command.Wait() != nil {
				os.Exit(101)
			}
			signal.Stop(stopping)
			os.Exit(42)
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
		registerVerifiedScopeChildCleanup(t, ctx, pid)
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
	if err = signalExecutionRoot(ids, pids[0], identity, syscall.SIGKILL); err != nil {
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
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath, ctx.Instance.LockPath = filepath.Join(root, "control.lock"), filepath.Join(root, "instance.lock")
	originalCount := readCoalitionActiveTaskCount
	unprovedCount := false
	readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
		count, err := originalCount(id)
		if (err == nil && count > 0) || (err != nil && !errors.Is(err, syscall.ESRCH)) {
			unprovedCount = true
		}
		return count, err
	}
	defer func() { readCoalitionActiveTaskCount = originalCount }()
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
	readCoalitionActiveTaskCount = originalCount
	if output.String() != "scope authenticated\nsynthetic stdin\n" {
		t.Fatalf("stdin was not forwarded: %q", output.String())
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("finished empty execution lost its active receipt: %v", err)
	}
	completion, err := readExecutionCompletion(ctx, scopes[0].ID)
	if errors.Is(err, os.ErrNotExist) && unprovedCount {
		// The kernel may still count a task briefly after the helper exits. The
		// controller must retain the active receipt instead of guessing zero;
		// an independently verified stop can then attest and retire it.
		if err := stop(ctx); err != nil {
			t.Fatalf("stop could not verify the finished scope: %v", err)
		}
		completion, err = readExecutionCompletion(ctx, scopes[0].ID)
		raw, marshalErr := json.Marshal(scopes[0])
		expected := executionCompletionForReceipt(scopes[0], append(raw, '\n'), scopes[0].BootSession)
		if err != nil || marshalErr != nil || completion.Scope != scopes[0] || completion.Scope.Purpose != "" || completion.ReceiptSHA256 != expected.ReceiptSHA256 || completion.VerificationBootSession != scopes[0].BootSession {
			t.Fatalf("stop did not preserve the exact finished scope: %v", err)
		}
		if _, err := os.Stat(filepath.Join(root, "executions", scopes[0].ID+".json")); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("verified stop retained the active receipt: %v", err)
		}
		return
	}
	if err != nil || completion.Scope != scopes[0] || completion.Scope.Purpose != "" || completion.VerificationBootSession != completion.Scope.BootSession {
		t.Fatalf("finished execution completion does not match its scope: %v", err)
	}
	proofPath := filepath.Join(root, "completed-executions", scopes[0].ID+".json")
	proof, err := os.ReadFile(proofPath)
	if err != nil {
		t.Fatal(err)
	}
	oldCount, oldPIDs := readCoalitionActiveTaskCount, scopedProcessIDs
	defer func() { readCoalitionActiveTaskCount, scopedProcessIDs = oldCount, oldPIDs }()
	readCoalitionActiveTaskCount = func(uint64) (uint64, error) { return 0, syscall.ESRCH }
	scopedProcessIDs = func() ([]int, error) { return nil, syscall.EPERM }
	changed := completion
	changed.ReceiptSHA256 = strings.Repeat("0", 64)
	if err := writeJSONAtomic(proofPath, changed); err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("mismatched proof retired an unverified scope: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "executions", scopes[0].ID+".json")); err != nil {
		t.Fatalf("unverified scope receipt was not retained: %v", err)
	}
	if err := os.WriteFile(proofPath, proof, 0600); err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("exact same-boot proof did not permit normal stop: %v", err)
	}
}

// A conservative nonzero observation must never authorize completion, but a
// later real stop can verify and retire the same synthetic execution safely.
func TestFinishedOrdinaryExecutionRecoversFromTransientScopeCount(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath, ctx.Instance.LockPath = filepath.Join(root, "control.lock"), filepath.Join(root, "instance.lock")
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	writer.Close()
	stdin, originalCount := os.Stdin, readCoalitionActiveTaskCount
	os.Stdin = reader
	injected := false
	readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
		if !injected {
			injected = true
			return 1, nil
		}
		return originalCount(id)
	}
	defer func() { os.Stdin, readCoalitionActiveTaskCount = stdin, originalCount }()
	command := []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "stdin", "unused"}
	if err := runInOwnedExecution(ctx, command, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	readCoalitionActiveTaskCount = originalCount
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 || !injected {
		t.Fatalf("unproved execution did not retain its receipt: %v", err)
	}
	if _, err := readExecutionCompletion(ctx, scopes[0].ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("nonzero count published an unverified proof: %v", err)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("real stop could not verify the retained scope: %v", err)
	}
	completion, err := readExecutionCompletion(ctx, scopes[0].ID)
	raw, marshalErr := json.Marshal(scopes[0])
	expected := executionCompletionForReceipt(scopes[0], append(raw, '\n'), scopes[0].BootSession)
	if err != nil || marshalErr != nil || completion.Scope != scopes[0] || completion.Scope.Purpose != "" || completion.ReceiptSHA256 != expected.ReceiptSHA256 || completion.VerificationBootSession != scopes[0].BootSession {
		t.Fatalf("stop did not preserve the exact finished scope: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "executions", scopes[0].ID+".json")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("verified stop retained the active receipt: %v", err)
	}
	if err := runInOwnedExecution(ctx, command, io.Discard, io.Discard); err != nil {
		t.Fatalf("restart after verified stop failed: %v", err)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("cleanup after restart failed: %v", err)
	}
	if retained, err := readExecutionCompletion(ctx, scopes[0].ID); err != nil || retained != completion {
		t.Fatalf("restart changed the original completion proof: %v", err)
	}
}

func TestFinishedOrdinaryExecutionRetainsReceiptWhenScopeCountUnavailable(t *testing.T) {
	ctx := executionTestContext(t)
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	writer.Close()
	stdin, count := os.Stdin, readCoalitionActiveTaskCount
	os.Stdin = reader
	readCoalitionActiveTaskCount = func(uint64) (uint64, error) { return 0, syscall.EPERM }
	defer func() { os.Stdin, readCoalitionActiveTaskCount = stdin, count }()
	if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "stdin", "unused"}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("unavailable native scope count retired the receipt: %v", err)
	}
	if _, err := readExecutionCompletion(ctx, scopes[0].ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unavailable native scope count published a proof: %v", err)
	}
}

func TestOwnedExecutionForwardsSignalsAndControllerEOF(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		signal   syscall.Signal
		expected int
	}{{"interrupt", syscall.SIGINT, 23}, {"terminate", syscall.SIGTERM, 23}, {"disconnect", syscall.SIGKILL, -1}} {
		t.Run(scenario.name, func(t *testing.T) {
			ctx := executionTestContext(t)
			root := filepath.Dir(ctx.Instance.StatePath)
			pidfile, marker := filepath.Join(root, "signal-child.pid"), filepath.Join(root, "signal-received")
			mode := "signal"
			if scenario.name == "disconnect" {
				mode = "disconnect"
			}
			outer := exec.Command(ctx.Executable, "__scope-test-outer", root, ctx.Instance.ID, mode, pidfile, marker)
			outer.Env = []string{"PATH=/usr/bin:/bin"}
			var output bytes.Buffer
			outer.Stdout = &output
			outer.Stderr = &output
			if err := outer.Start(); err != nil {
				t.Fatal(err)
			}
			defer outer.Process.Kill()
			var pid int
			deadline := time.Now().Add(10 * time.Second)
			for {
				raw, err := os.ReadFile(pidfile)
				if err == nil {
					pid, _ = strconv.Atoi(string(raw))
					if pid > 0 {
						break
					}
				}
				if time.Now().After(deadline) {
					outer.Process.Kill()
					outer.Wait()
					t.Fatalf("signal target did not start: %s", output.String())
				}
				time.Sleep(10 * time.Millisecond)
			}
			identity, err := processStartIdentity(pid)
			if err != nil {
				t.Fatal(err)
			}
			scopes, err := readOwnedExecutionScopes(ctx)
			if err != nil || len(scopes) != 1 {
				t.Fatalf("missing durable scope: %v", err)
			}
			defer cleanupExecutionTestArtifacts(scopes[0])
			ids, err := processCoalitionIDs(pid)
			if err != nil || ids != scopes[0].CoalitionIDs {
				t.Fatal("signal target authority mismatch")
			}
			defer func() {
				_ = signalExecutionRoot(ids, pid, identity, syscall.SIGKILL)
			}()
			if err = outer.Process.Signal(scenario.signal); err != nil {
				t.Fatal(err)
			}
			waited := make(chan error, 1)
			go func() { waited <- outer.Wait() }()
			select {
			case err = <-waited:
			case <-time.After(10 * time.Second):
				t.Fatal("outer did not report actual command result")
			}
			var exited *exec.ExitError
			if !errors.As(err, &exited) || (scenario.expected >= 0 && exited.ExitCode() != scenario.expected) {
				t.Fatalf("unexpected outer result: %v; output=%s", err, output.String())
			}
			deadline = time.Now().Add(10 * time.Second)
			for {
				raw, readErr := os.ReadFile(marker)
				wanted := int(scenario.signal)
				if scenario.signal == syscall.SIGKILL {
					wanted = int(syscall.SIGTERM)
				}
				if readErr == nil && string(raw) == strconv.Itoa(wanted) {
					break
				}
				if time.Now().After(deadline) {
					t.Fatalf("owned child did not receive forwarded signal %d: %q %v", wanted, raw, readErr)
				}
				time.Sleep(10 * time.Millisecond)
			}
			deadline = time.Now().Add(10 * time.Second)
			for {
				info, inspectErr := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
				if errors.Is(inspectErr, syscall.ESRCH) || (inspectErr == nil && info[4] == 5) {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("owned child survived controller shutdown")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if scopesAfter, err := readOwnedExecutionScopes(ctx); err != nil || len(scopesAfter) != 1 {
				t.Fatal("durable receipt lost during cancellation")
			}
		})
	}
}

func TestExecutionMembersRetriesUncertainZero(t *testing.T) {
	child := exec.Command("/bin/sleep", "60")
	child.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	pid := child.Process.Pid
	identity, err := processStartIdentity(pid)
	if err != nil {
		t.Fatal(err)
	}
	ids, err := processCoalitionIDs(pid)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"transient-coalition", "departed-parent", "persistent-uncertainty", "permission-failure"} {
		t.Run(scenario, func(t *testing.T) {
			originalPIDs, originalCoalitions := executionProcessIDs, executionProcessCoalitions
			t.Cleanup(func() {
				executionProcessIDs, executionProcessCoalitions = originalPIDs, originalCoalitions
			})
			departedPID := 0
			if scenario == "departed-parent" {
				departed := exec.Command("/usr/bin/true")
				if err := departed.Run(); err != nil {
					t.Fatal(err)
				}
				departedPID = departed.Process.Pid
			}
			passes, reads := 0, 0
			executionProcessIDs = func() ([]int, error) {
				passes++
				if departedPID > 0 && passes == 1 {
					// Model the enumerated parent disappearing after a fork.
					// The next complete census exposes its surviving child.
					return []int{departedPID}, nil
				}
				return []int{pid}, nil
			}
			executionProcessCoalitions = func(target int) ([2]uint64, error) {
				if target != pid {
					t.Fatalf("inspected a process outside the synthetic census: %d", target)
				}
				reads++
				if scenario == "persistent-uncertainty" || (scenario == "transient-coalition" && reads == 1) {
					return [2]uint64{}, syscall.ESRCH
				}
				if scenario == "permission-failure" {
					return [2]uint64{}, syscall.EPERM
				}
				return processCoalitionIDs(target)
			}
			members, err := executionMembers(ids)
			if scenario == "permission-failure" {
				if !errors.Is(err, syscall.EPERM) || passes < 2 {
					t.Fatalf("permission failure became cleanup success: %v passes=%d", err, passes)
				}
				return
			}
			if scenario == "persistent-uncertainty" {
				if err == nil || reads != 32 {
					t.Fatalf("persistent uncertainty certified zero: %v passes=%d", err, passes)
				}
				return
			}
			if err != nil || passes < 2 || len(members) != 1 || members[0].PID != pid || members[0].Identity != identity {
				t.Fatalf("uncertain pass lost the live owned child: %v passes=%d members=%v", err, passes, members)
			}
		})
	}
}

func TestOwnedExecutionCancellationEscalatesIgnoringRoot(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	pidfile, marker := filepath.Join(root, "ignoring-root.pid"), filepath.Join(root, "signals")
	outer := exec.Command(ctx.Executable, "__scope-test-outer", root, ctx.Instance.ID, "ignore-root", pidfile, marker)
	outer.Env = []string{"PATH=/usr/bin:/bin"}
	var output bytes.Buffer
	outer.Stdout, outer.Stderr = &output, &output
	if err := outer.Start(); err != nil {
		t.Fatal(err)
	}
	waited := make(chan error, 1)
	go func() { waited <- outer.Wait() }()
	defer outer.Process.Kill()
	var pid int
	for deadline := time.Now().Add(10 * time.Second); ; {
		if raw, err := os.ReadFile(pidfile); err == nil {
			pid, _ = strconv.Atoi(string(raw))
			if pid > 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("ignoring command root did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	identity, err := processStartIdentity(pid)
	if err != nil {
		t.Fatal(err)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("missing durable scope: %v", err)
	}
	defer cleanupExecutionTestArtifacts(scopes[0])
	defer func() {
		_ = signalExecutionRoot(scopes[0].CoalitionIDs, pid, identity, syscall.SIGKILL)
	}()
	started := time.Now()
	if err := outer.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	for deadline := time.Now().Add(5 * time.Second); ; {
		if raw, err := os.ReadFile(marker); err == nil && string(raw) == "15\n" {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("root did not receive the first cancellation")
		}
		time.Sleep(10 * time.Millisecond)
	}
	// Repeated cancellation must neither interrupt the admitted drain nor
	// restart its deadline. The actual root deliberately ignores both signals.
	if err := outer.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	time.Sleep(150 * time.Millisecond)
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "15\n" {
		t.Fatalf("duplicate root signal during its clean-shutdown grace: %q %v", raw, err)
	}
	select {
	case err := <-waited:
		var exited *exec.ExitError
		if !errors.As(err, &exited) || exited.ExitCode() != 128+int(syscall.SIGKILL) {
			t.Fatalf("forced root exit did not preserve its actual result: %v; output=%s", err, output.String())
		}
	case <-time.After(12 * time.Second):
		t.Fatal("cancellation never escalated the ignoring root")
	}
	if time.Since(started) < time.Second {
		t.Fatal("root was killed before its admitted grace elapsed")
	}
	if members, err := executionMembers(scopes[0].CoalitionIDs); err != nil || len(members) != 0 {
		t.Fatalf("command result preceded verified cleanup: %v remaining=%d", err, len(members))
	}
	if receipts, err := readOwnedExecutionScopes(ctx); err != nil || len(receipts) != 1 {
		t.Fatal("cancellation discarded its durable ownership receipt")
	}
}

func TestOwnedExecutionMalformedReceiptPreserved(t *testing.T) {
	ctx := executionTestContext(t)
	dir, err := executionScopeDirectory(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	boot, err := executionBootSession()
	if err != nil {
		t.Fatal(err)
	}
	scope := executionScope{1, id, ctx.Instance.ID, ctx.Instance.StateDir, ctx.Instance.RuntimeHome, boot, "dev.jobctrl.exec." + ctx.Instance.ID + "." + id, "gui/" + strconv.Itoa(os.Getuid()), 123, "123:1234:123", [2]uint64{123, 124}, ""}
	valid, err := json.Marshal(scope)
	if err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string][]byte{
		"duplicate":            append(append([]byte{}, valid[:len(valid)-1]...), []byte(`,"id":"`+id+`"}`)...),
		"case variant":         bytes.Replace(valid, []byte(`"rootPid"`), []byte(`"RootPID"`), 1),
		"case alias collision": append(append([]byte{}, valid[:len(valid)-1]...), []byte(`,"ID":"`+id+`"}`)...),
		"unknown":              append(append([]byte{}, valid[:len(valid)-1]...), []byte(`,"unknown":1}`)...),
		"trailing":             append(append([]byte{}, valid...), []byte(`{}`)...),
	} {
		t.Run(name, func(t *testing.T) {
			path := filepath.Join(dir, id+".json")
			if err := os.WriteFile(path, raw, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err := readOwnedExecutionScopes(ctx); err == nil {
				t.Fatal("malformed receipt accepted")
			}
			after, err := os.ReadFile(path)
			if err != nil || !bytes.Equal(after, raw) {
				t.Fatal("rejected receipt bytes changed")
			}
		})
	}
}

func cleanupExecutionTestArtifacts(scope executionScope) {
	_ = exec.Command("/bin/launchctl", "bootout", scope.Domain+"/"+scope.JobLabel).Run()
	paths, _ := filepath.Glob("/tmp/jc-exec-*/job.plist")
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		// Only the private manifest containing this test's exact random receipt
		// label grants cleanup ownership. Concurrent scopes have different labels.
		if err == nil && bytes.Contains(raw, []byte("<string>"+scope.JobLabel+"</string>")) {
			_ = os.RemoveAll(filepath.Dir(path))
		}
	}
}

func TestOwnedExecutionRestoresOuterSignalHandler(t *testing.T) {
	ctx := executionTestContext(t)
	outer := exec.Command(ctx.Executable, "__scope-test-outer", filepath.Dir(ctx.Instance.StatePath), ctx.Instance.ID, "restore", "unused", "unused")
	outer.Env = []string{"PATH=/usr/bin:/bin"}
	err := outer.Run()
	var exited *exec.ExitError
	if !errors.As(err, &exited) {
		t.Fatalf("outer did not exit on restored TERM handler: %v", err)
	}
	status := exited.Sys().(syscall.WaitStatus)
	if !status.Signaled() || status.Signal() != syscall.SIGTERM {
		t.Fatalf("outer signal handler remained installed: %v", status)
	}
}

func TestOwnedExecutionAdmissionSerializesWithStop(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
	ctx.Instance.LockPath = filepath.Join(root, "instance.lock")
	control, err := acquireLock(ctx.Instance.ControlPath, false)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { releaseLock(control) }()
	pidfile, marker := filepath.Join(root, "admitted.pid"), filepath.Join(root, "signal")
	outer := exec.Command(ctx.Executable, "__scope-test-outer", root, ctx.Instance.ID, "signal", pidfile, marker)
	outer.Env = []string{"PATH=/usr/bin:/bin"}
	if err = outer.Start(); err != nil {
		t.Fatal(err)
	}
	defer outer.Process.Kill()
	time.Sleep(75 * time.Millisecond)
	if _, err := os.Stat(filepath.Join(root, "executions")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("admission published while stop held exclusive control lock")
	}
	releaseLock(control)
	control = nil
	deadline := time.Now().Add(10 * time.Second)
	for {
		if raw, err := os.ReadFile(pidfile); err == nil && len(raw) > 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("admission did not proceed after control lock release")
		}
		time.Sleep(10 * time.Millisecond)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("admitted receipt: %v", err)
	}
	defer cleanupExecutionTestArtifacts(scopes[0])
	control, err = acquireLock(ctx.Instance.ControlPath, true)
	if err != nil {
		t.Fatalf("hung command retained admission lock: %v", err)
	}
	releaseLock(control)
	control = nil
	// Exercise the actual product stop entry after admission, rather than
	// holding the lock until the long-running CLI's result arrives.
	if err = stop(ctx); err != nil {
		t.Fatalf("actual stop could not drain admitted command: %v", err)
	}
	waited := make(chan error, 1)
	go func() { waited <- outer.Wait() }()
	select {
	case <-waited:
	case <-time.After(5 * time.Second):
		t.Fatal("stopped command did not return")
	}
}

func TestOwnedExecutionTemporaryReceiptsAndRetirement(t *testing.T) {
	ctx := executionTestContext(t)
	dir, err := executionScopeDirectory(ctx, true)
	if err != nil {
		t.Fatal(err)
	}
	id := strings.Repeat("a", 32)
	boot, err := executionBootSession()
	if err != nil {
		t.Fatal(err)
	}
	scope := executionScope{1, id, ctx.Instance.ID, ctx.Instance.StateDir, ctx.Instance.RuntimeHome, boot, "dev.jobctrl.exec." + ctx.Instance.ID + "." + id, "gui/" + strconv.Itoa(os.Getuid()), 123, "123:1234:123", [2]uint64{123, 124}, ""}
	if err = writeJSONAtomic(filepath.Join(dir, id+".json"), scope); err != nil {
		t.Fatal(err)
	}
	temporary := filepath.Join(dir, "."+id+".json."+strings.Repeat("b", 32))
	temporaryBytes := []byte(`{"schemaVersion":1,"unfinished":`)
	if err = os.WriteFile(temporary, temporaryBytes, 0600); err != nil {
		t.Fatal(err)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("private atomic temporary blocked valid final receipt: %v", err)
	}
	final := filepath.Join(dir, id+".json")
	original, err := os.ReadFile(final)
	if err != nil {
		t.Fatal(err)
	}
	originalBootout := bootoutOwnedExecution
	defer func() { bootoutOwnedExecution = originalBootout }()
	called := false
	bootoutOwnedExecution = func(domain, label string) error {
		called = true
		if domain != scope.Domain || label != scope.JobLabel {
			t.Fatal("foreign job submitted for retirement")
		}
		return errors.New("synthetic launchd denial")
	}
	if err = retireOwnedExecutionScopes(ctx); err == nil || !called {
		t.Fatal("real retirement failure was suppressed")
	}
	after, err := os.ReadFile(final)
	if err != nil || !bytes.Equal(after, original) {
		t.Fatal("failed retirement changed final receipt bytes")
	}
	after, err = os.ReadFile(temporary)
	if err != nil || !bytes.Equal(after, temporaryBytes) {
		t.Fatal("failed retirement changed private atomic temporary")
	}
	changed := append(append([]byte{}, original...), '\n')
	bootoutOwnedExecution = func(domain, label string) error { return os.WriteFile(final, changed, 0600) }
	if err = retireOwnedExecutionScopes(ctx); err == nil {
		t.Fatal("changed receipt was retired")
	}
	after, err = os.ReadFile(final)
	if err != nil || !bytes.Equal(after, changed) {
		t.Fatal("retirement overwrote concurrently changed metadata")
	}
	if err = os.WriteFile(final, original, 0600); err != nil {
		t.Fatal(err)
	}
	bootoutOwnedExecution = originalBootout
	control, err := acquireLock(filepath.Join(filepath.Dir(ctx.Instance.StatePath), "control.lock"), false)
	if err != nil {
		t.Fatal(err)
	}
	defer releaseLock(control)
	if err = retireOwnedExecutionScopes(ctx); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(final); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("validated inactive receipt was not retired")
	}
	after, err = os.ReadFile(temporary)
	if err != nil || !bytes.Equal(after, temporaryBytes) {
		t.Fatal("successful retirement deleted or changed unadmitted temporary")
	}
	if err = retireOwnedExecutionScopes(ctx); err != nil {
		t.Fatalf("retirement not idempotent: %v", err)
	}
}

func TestOwnedExecutionSupervisorOwnsOrderedDrain(t *testing.T) {
	for _, requested := range []syscall.Signal{syscall.SIGTERM, syscall.SIGKILL} {
		t.Run(strconv.Itoa(int(requested)), func(t *testing.T) {
			ctx := executionTestContext(t)
			root := filepath.Dir(ctx.Instance.StatePath)
			pidfile, marker := filepath.Join(root, "ordered-child.pid"), filepath.Join(root, "external-term")
			outer := exec.Command(ctx.Executable, "__scope-test-outer", root, ctx.Instance.ID, "supervisor", pidfile, marker)
			outer.Env = []string{"PATH=/usr/bin:/bin"}
			if err := outer.Start(); err != nil {
				t.Fatal(err)
			}
			defer outer.Process.Kill()
			deadline := time.Now().Add(10 * time.Second)
			for {
				if raw, err := os.ReadFile(pidfile); err == nil && len(raw) > 0 {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("supervisor child did not start")
				}
				time.Sleep(10 * time.Millisecond)
			}
			scopes, err := readOwnedExecutionScopes(ctx)
			if err != nil || len(scopes) != 1 {
				t.Fatalf("missing supervisor scope: %v", err)
			}
			defer cleanupExecutionTestArtifacts(scopes[0])
			if err = outer.Process.Signal(requested); err != nil {
				t.Fatal(err)
			}
			waited := make(chan error, 1)
			go func() { waited <- outer.Wait() }()
			select {
			case err = <-waited:
			case <-time.After(10 * time.Second):
				t.Fatal("supervisor did not finish ordered drain")
			}
			if requested == syscall.SIGTERM {
				var exited *exec.ExitError
				if !errors.As(err, &exited) || exited.ExitCode() != 42 {
					t.Fatalf("lost supervisor actual result: %v", err)
				}
			}
			deadline = time.Now().Add(5 * time.Second)
			for {
				if _, err := os.Stat(marker + ".drained"); err == nil {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("supervisor was not allowed to drain child")
				}
				time.Sleep(10 * time.Millisecond)
			}
			if raw, err := os.ReadFile(marker); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("child received external TERM during supervisor drain: %q %v", raw, err)
			}
			// The helper must observe a real zero census before EOF cleanup ends.
			deadline = time.Now().Add(5 * time.Second)
			for {
				if _, err := processStartIdentity(scopes[0].RootPID); errors.Is(err, syscall.ESRCH) {
					break
				}
				if time.Now().After(deadline) {
					t.Fatal("helper failed to finish after owned scope drained")
				}
				time.Sleep(10 * time.Millisecond)
			}
		})
	}
}

func TestOwnedExecutionFixedLoopbackSandbox(t *testing.T) {
	if executionQASandboxProfile != loopbackOnlySandboxProfile {
		t.Fatal("execution sandbox differs from established loopback profile")
	}
	ctx := executionTestContext(t)
	ctx.Environment = append(ctx.Environment, executionQASandboxVariable+"="+executionQASandboxSelector)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	accepted := make(chan error, 1)
	go func() {
		connection, err := listener.Accept()
		if err == nil {
			connection.Close()
		}
		accepted <- err
	}()
	var out, stderr bytes.Buffer
	if err = runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "network", listener.Addr().String()}, &out, &stderr); err != nil {
		t.Fatalf("sandboxed native helper network check: %v; stderr=%s", err, stderr.String())
	}
	select {
	case err := <-accepted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("loopback connection was not observed")
	}
	if !strings.Contains(out.String(), "loopback allowed; nonloopback denied") {
		t.Fatalf("missing network proof: %s", out.String())
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("sandboxed helper did not authenticate durable scope: %v", err)
	}
}

func TestOwnedExecutionUnknownSandboxRefusesBeforeAdmission(t *testing.T) {
	ctx := executionTestContext(t)
	ctx.Environment = append(ctx.Environment, executionQASandboxVariable+"=untrusted-profile")
	if err := runInOwnedExecution(ctx, []string{"unused"}, io.Discard, io.Discard); err == nil {
		t.Fatal("unknown sandbox selector accepted")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(ctx.Instance.StatePath), "executions")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("unknown sandbox selector created receipt directory")
	}
}

func TestOwnedExecutionPlistPreservesCompiledProfileText(t *testing.T) {
	plist := executionPlist("owned-label", "/tmp/native&<helper>", "/tmp/socket", "challenge", true)
	if !bytes.Contains(plist, []byte(executionQASandboxProfile)) {
		t.Fatal("launchd plist did not preserve literal compiled sandbox profile")
	}
	if bytes.Contains(plist, []byte("&#")) {
		t.Fatal("launchd plist uses truncating numeric character references")
	}
	if !bytes.Contains(plist, []byte("/tmp/native&amp;&lt;helper&gt;")) {
		t.Fatal("plist element text is not safely escaped")
	}
}

func TestOwnedExecutionRejectsChangedInventoryDigestBeforeAdmission(t *testing.T) {
	ctx := executionTestContext(t)
	if err := json.Unmarshal([]byte(`{"files":[{"type":"file","path":"launcher/jobctrl","mode":"0755","sha256":"`+strings.Repeat("0", 64)+`"}]}`), &ctx.Distribution); err != nil {
		t.Fatal(err)
	}
	if err := runInOwnedExecution(ctx, []string{"unused"}, io.Discard, io.Discard); err == nil {
		t.Fatal("changed authenticated inventory digest accepted")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(ctx.Instance.StatePath), "executions")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("mismatched executable published execution receipt")
	}
	actual, err := sha256Path(ctx.Executable)
	if err != nil {
		t.Fatal(err)
	}
	ctx.Distribution.Files[0].SHA256 = actual
	if err = verifyOwnedExecutionExecutable(ctx, ctx.Executable); err != nil {
		t.Fatalf("matching authenticated inventory rejected: %v", err)
	}
}
