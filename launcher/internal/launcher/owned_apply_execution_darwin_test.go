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
	"os/signal"
	"path/filepath"
	"strconv"
	"syscall"
	"testing"
	"time"
)

func init() {
	if len(os.Args) == 4 && os.Args[1] == "__apply-test-controller" {
		var ctx launchContext
		if json.Unmarshal([]byte(os.Args[2]), &ctx) != nil {
			os.Exit(91)
		}
		ctx.Environment = append(ctx.Environment, "JOBCTRL_APPLY_TEST_ROOT="+os.Args[3], "JOBCTRL_APPLY_TEST_CONTEXT="+os.Args[2])
		if err := runInOwnedExecution(ctx, []string{applyWorkerArgument}, os.Stdout, os.Stderr); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(ExitCode(err))
		}
		os.Exit(0)
	}
	if len(os.Args) != 2 || (os.Args[1] != applyWorkerArgument && os.Args[1] != "__apply-test-peer" && os.Args[1] != "__apply-test-ordinary") || os.Getenv("JOBCTRL_APPLY_TEST_ROOT") == "" {
		return
	}
	root := os.Getenv("JOBCTRL_APPLY_TEST_ROOT")
	var ctx launchContext
	if json.Unmarshal([]byte(os.Getenv("JOBCTRL_APPLY_TEST_CONTEXT")), &ctx) != nil {
		os.Exit(92)
	}
	ctx.Environment = os.Environ()
	if owned, err := authenticatedOwnedExecution(ctx); err != nil || !owned {
		os.Exit(93)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		os.Exit(94)
	}
	var own executionScope
	for _, scope := range scopes {
		if scope.ID == os.Getenv(executionScopeVariable) {
			own = scope
		}
	}
	if os.Args[1] == "__apply-test-ordinary" {
		// An authentic ordinary scope cannot promote itself merely by copying
		// its scope hint into the private Apply environment variable.
		ctx.Environment = append(ctx.Environment, applyExecutionVariable+"="+own.ID)
		if owned, err := authenticatedApplyExecution(ctx); err != nil || owned {
			os.Exit(98)
		}
		os.Exit(0)
	}
	peer := os.Args[1] == "__apply-test-peer"
	if own.ID == "" || (!peer && os.Getenv(applyExecutionVariable) != own.ID) || writeJSONAtomic(filepath.Join(root, "scope.json"), own) != nil {
		os.Exit(95)
	}
	script := `import os,signal,sys,time
os.setsid()
if sys.argv[3] != 'peer': signal.signal(signal.SIGTERM,signal.SIG_IGN)
open(sys.argv[1],'w').write(str(os.getpid()))
while True:
 open(sys.argv[2],'w').write(str(time.monotonic_ns()))
 time.sleep(.01)
`
	mode, _ := os.ReadFile(filepath.Join(root, "mode"))
	writer := exec.Command("/usr/bin/python3", "-I", "-B", "-c", script, filepath.Join(root, "writer.pid"), filepath.Join(root, "ticks"), string(mode))
	writer.Stdout, writer.Stderr = io.Discard, io.Discard
	if writer.Start() != nil {
		os.Exit(96)
	}
	for deadline := time.Now().Add(5 * time.Second); ; {
		if raw, err := os.ReadFile(filepath.Join(root, "writer.pid")); err == nil && len(raw) > 0 {
			break
		}
		if time.Now().After(deadline) {
			os.Exit(97)
		}
		time.Sleep(time.Millisecond)
	}
	if string(mode) == "failure" {
		os.Exit(23)
	}
	if string(mode) == "cancel" || string(mode) == "eof" {
		cancel := make(chan os.Signal, 1)
		signal.Notify(cancel, syscall.SIGTERM, syscall.SIGINT)
		_ = os.WriteFile(filepath.Join(root, "cancellable"), []byte("ready"), 0600)
		<-cancel
	}
	os.Exit(0)
}

func TestApplyExecutionCompletesOnlyItsOwnedCoalition(t *testing.T) {
	for _, mode := range []string{"success", "failure", "cancel", "eof"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			environment := []string{"HOME=" + root, "PATH=/usr/bin:/bin", "JOBCTRL_DIR=" + filepath.Join(root, "data"), "JOBCTRL_RUNTIME_HOME=" + filepath.Join(root, "runtime")}
			instance, err := resolveInstance(environment)
			if err != nil {
				t.Fatal(err)
			}
			executable, err := CurrentProcessExecutable()
			if err != nil {
				t.Fatal(err)
			}
			ctx := launchContext{Executable: executable, Instance: instance, Environment: environment}
			encoded, err := json.Marshal(ctx)
			if err != nil {
				t.Fatal(err)
			}
			peerFixture := t.TempDir()
			if err := os.WriteFile(filepath.Join(peerFixture, "mode"), []byte("peer"), 0600); err != nil {
				t.Fatal(err)
			}
			peerContext := ctx
			peerContext.Environment = append(append([]string{}, environment...), "JOBCTRL_APPLY_TEST_ROOT="+peerFixture, "JOBCTRL_APPLY_TEST_CONTEXT="+string(encoded))
			peerFile := filepath.Join(peerFixture, "writer.pid")
			if err := runInOwnedExecution(peerContext, []string{"__apply-test-peer"}, io.Discard, os.Stderr); err != nil {
				t.Fatal(err)
			}
			defer func() {
				if err := stop(ctx); err != nil {
					t.Errorf("final owned cleanup: %v", err)
				}
			}()
			peerRaw, err := os.ReadFile(peerFile)
			if err != nil {
				t.Fatal(err)
			}
			peerPID, _ := strconv.Atoi(string(peerRaw))
			if peerPID == 0 {
				_, _ = fmt.Sscanf(string(peerRaw), "%d", &peerPID)
			}
			peerIdentity, err := processStartIdentity(peerPID)
			if err != nil {
				t.Fatal(err)
			}
			fixture := t.TempDir()
			if err := os.WriteFile(filepath.Join(fixture, "mode"), []byte(mode), 0600); err != nil {
				t.Fatal(err)
			}
			controller := exec.Command(ctx.Executable, "__apply-test-controller", string(encoded), fixture)
			log, err := os.Create(filepath.Join(fixture, "controller.log"))
			if err != nil {
				t.Fatal(err)
			}
			defer log.Close()
			controller.Stdout, controller.Stderr = log, log
			if err := controller.Start(); err != nil {
				t.Fatal(err)
			}
			defer controller.Process.Kill()
			waitFile := func(name string) []byte {
				t.Helper()
				for deadline := time.Now().Add(25 * time.Second); ; {
					if raw, err := os.ReadFile(filepath.Join(fixture, name)); err == nil && len(raw) > 0 {
						return raw
					}
					if time.Now().After(deadline) {
						output, _ := os.ReadFile(log.Name())
						t.Fatalf("fixture did not publish %s: %s", name, output)
					}
					time.Sleep(10 * time.Millisecond)
				}
			}
			var scope executionScope
			if err := json.Unmarshal(waitFile("scope.json"), &scope); err != nil {
				t.Fatal(err)
			}
			writerPID, _ := strconv.Atoi(string(waitFile("writer.pid")))
			writerIdentity, err := processStartIdentity(writerPID)
			if err != nil {
				t.Fatal(err)
			}
			if mode == "cancel" || mode == "eof" {
				waitFile("cancellable")
				requested := syscall.SIGTERM
				if mode == "eof" {
					requested = syscall.SIGKILL
				}
				if err := controller.Process.Signal(requested); err != nil {
					t.Fatal(err)
				}
			}
			err = controller.Wait()
			if mode == "success" || mode == "cancel" {
				if err != nil {
					output, _ := os.ReadFile(log.Name())
					t.Fatalf("clean controller exit: %v %s", err, output)
				}
			} else if mode == "failure" {
				var exited *exec.ExitError
				if !errors.As(err, &exited) || exited.ExitCode() != 23 {
					t.Fatalf("original command failure code lost: %v", err)
				}
			}
			var completion executionCompletion
			for deadline := time.Now().Add(15 * time.Second); ; {
				completion, err = readExecutionCompletion(ctx, scope.ID)
				if err == nil {
					break
				}
				if time.Now().After(deadline) {
					output, _ := os.ReadFile(log.Name())
					t.Fatalf("scope completion missing: %v %s", err, output)
				}
				time.Sleep(20 * time.Millisecond)
			}
			if completion.Scope != scope || !waitForOwnedRecordExit(componentRecord{PID: writerPID, StartIdentity: writerIdentity}, time.Second) {
				t.Fatal("completion preceded exact detached writer exit")
			}
			if current, err := processStartIdentity(peerPID); err != nil || current != peerIdentity {
				t.Fatalf("Apply cleanup affected another live scope of the same instance: %v", err)
			}
			active, err := readOwnedExecutionScopes(ctx)
			if err != nil {
				t.Fatal(err)
			}
			foundOwn, foundPeer := false, false
			for _, receipt := range active {
				foundOwn = foundOwn || receipt.ID == scope.ID
				foundPeer = foundPeer || receipt.ID != scope.ID
			}
			if !foundPeer || (mode != "eof" && foundOwn) {
				t.Fatal("selected retirement changed another scope or retained its normal receipt")
			}
			if err := stop(ctx); err != nil {
				t.Fatal(err)
			}
			if !waitForOwnedRecordExit(componentRecord{PID: peerPID, StartIdentity: peerIdentity}, time.Second) {
				t.Fatal("final test cleanup left its control alive")
			}
		})
	}
}

func TestApplyCompletionInspectionFailureRetainsExactReceipt(t *testing.T) {
	ctx, scope, before := completedExecutionTestScope(t)
	child := exec.Command("/bin/sleep", "60")
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
	previousIDs, previousCoalitions := executionProcessIDs, executionProcessCoalitions
	executionProcessIDs = func() ([]int, error) { return []int{child.Process.Pid}, nil }
	executionProcessCoalitions = func(pid int) ([2]uint64, error) {
		if pid != child.Process.Pid {
			t.Fatal("inspection escaped the owned fixture")
		}
		return [2]uint64{}, syscall.EPERM
	}
	defer func() { executionProcessIDs, executionProcessCoalitions = previousIDs, previousCoalitions }()
	if err := completeApplyExecution(ctx, scope); !errors.Is(err, syscall.EPERM) {
		t.Fatalf("failed kernel census certified completion: %v", err)
	}
	if _, err := readExecutionCompletion(ctx, scope.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("inspection failure published a completion: %v", err)
	}
	path := filepath.Join(filepath.Dir(ctx.Instance.StatePath), "executions", scope.ID+".json")
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("inspection failure changed the exact active receipt")
	}
}

func TestApplyWorkerRejectsOrdinaryScopeWithForgedPurposeHint(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath, ctx.Instance.LockPath = filepath.Join(root, "control.lock"), filepath.Join(root, "instance.lock")
	encoded, err := json.Marshal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	ctx.Environment = append(ctx.Environment, "JOBCTRL_APPLY_TEST_ROOT="+t.TempDir(), "JOBCTRL_APPLY_TEST_CONTEXT="+string(encoded))
	if err := runInOwnedExecution(ctx, []string{"__apply-test-ordinary"}, io.Discard, os.Stderr); err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); err != nil {
		t.Fatal(err)
	}
}
