//go:build darwin

package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func completedExecutionTestScope(t *testing.T) (launchContext, executionScope, []byte) {
	t.Helper()
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath, ctx.Instance.LockPath = filepath.Join(root, "control.lock"), filepath.Join(root, "instance.lock")
	err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "exit", "unused"}, io.Discard, io.Discard)
	var exited interface{ ExitCode() int }
	if !errors.As(err, &exited) || exited.ExitCode() != 17 {
		t.Fatalf("owned fixture did not report its real exit: %v", err)
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("missing fixture scope: %v", err)
	}
	dir, err := executionScopeDirectory(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(filepath.Join(dir, scopes[0].ID+".json"))
	if err != nil {
		t.Fatal(err)
	}
	return ctx, scopes[0], raw
}

func init() {
	if len(os.Args) == 8 && os.Args[1] == "__native-apply-custody-test" {
		arguments := []string{os.Args[3], "-I", "-B", os.Args[4], os.Args[2], os.Args[5], os.Args[6], os.Args[7]}
		if syscall.Exec(os.Args[3], arguments, os.Environ()) != nil {
			os.Exit(83)
		}
	}
	if len(os.Args) == 4 && os.Args[1] == "__read-execution-completion-test" {
		var ctx launchContext
		if json.Unmarshal([]byte(os.Args[2]), &ctx) != nil {
			os.Exit(81)
		}
		completion, err := readExecutionCompletion(ctx, os.Args[3])
		if err != nil || json.NewEncoder(os.Stdout).Encode(completion) != nil {
			os.Exit(82)
		}
		os.Exit(0)
	}
}

func TestNativeCompletionRecoversApplyCustodyAfterEscapedWriter(t *testing.T) {
	python := migrationIntegrationPython(t)
	workerSource, err := filepath.Abs(filepath.Join("..", "..", "..", "workers", "automation", "src"))
	if err != nil {
		t.Fatal(err)
	}
	harness := filepath.Join(filepath.Dir(workerSource), "tests", "helpers", "apply_custody_native.py")
	if _, err := os.Stat(harness); err != nil {
		t.Fatal(err)
	}
	newContext := func() launchContext {
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
		return launchContext{Executable: executable, Instance: instance, Environment: environment}
	}
	ctx, peer := newContext(), executionTestContext(t)
	peerRoot := filepath.Dir(peer.Instance.StatePath)
	peer.Instance.ControlPath, peer.Instance.LockPath = filepath.Join(peerRoot, "control.lock"), filepath.Join(peerRoot, "instance.lock")
	defer func() { _ = stop(ctx); _ = stop(peer) }()
	evidence := t.TempDir()
	arguments := func(mode string) []string {
		return []string{"__native-apply-custody-test", mode, python, harness, workerSource, ctx.Instance.StateDir, evidence}
	}
	logPath := filepath.Join(evidence, "native-harness.log")
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer logFile.Close()
	done := make(chan error, 1)
	go func() { done <- runInOwnedExecution(ctx, arguments("hold"), logFile, logFile) }()
	waitFile := func(name string) []byte {
		t.Helper()
		for deadline := time.Now().Add(25 * time.Second); ; {
			if raw, err := os.ReadFile(filepath.Join(evidence, name)); err == nil && len(raw) > 0 {
				return raw
			}
			select {
			case err := <-done:
				output, _ := os.ReadFile(logPath)
				t.Fatalf("native Apply harness exited before publishing %s: %v %s", name, err, output)
			default:
			}
			if time.Now().After(deadline) {
				output, _ := os.ReadFile(logPath)
				t.Fatalf("native Apply harness did not publish %s: %s", name, output)
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	waitFile("hold-ready")
	var binding struct {
		Scope         executionScope `json:"scope"`
		ReceiptSHA256 string         `json:"receipt_sha256"`
	}
	if err := json.Unmarshal(waitFile("owner-bound.json"), &binding); err != nil {
		t.Fatal(err)
	}
	if err := validateExecutionScope(ctx, binding.Scope); err != nil {
		t.Fatal(err)
	}
	var writer struct {
		PID int `json:"pid"`
		SID int `json:"sid"`
	}
	if err := json.Unmarshal(waitFile("writer-ready.json"), &writer); err != nil {
		t.Fatal(err)
	}
	writerIdentity, err := processStartIdentity(writer.PID)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if current, err := processStartIdentity(writer.PID); err == nil && current == writerIdentity {
			_ = syscall.Kill(writer.PID, syscall.SIGKILL)
		}
	}()
	if ids, err := processCoalitionIDs(writer.PID); err != nil || ids != binding.Scope.CoalitionIDs || writer.SID != writer.PID {
		t.Fatalf("writer did not retain native custody while escaping its Apply session: %v", err)
	}
	peerPIDFile := filepath.Join(t.TempDir(), "peer.pid")
	if err := runInOwnedExecution(peer, []string{"__scope-test-command", peer.Instance.StatePath, peer.Instance.ID, "detach", peerPIDFile}, io.Discard, io.Discard); err != nil {
		t.Fatal(err)
	}
	peerRaw, err := os.ReadFile(peerPIDFile)
	if err != nil {
		t.Fatal(err)
	}
	var peerPID int
	if _, err := fmt.Sscanf(string(peerRaw), "%d", &peerPID); err != nil {
		t.Fatal(err)
	}
	peerIdentity, err := processStartIdentity(peerPID)
	if err != nil {
		t.Fatal(err)
	}
	journalPath := strings.TrimSpace(string(waitFile("journal-path")))
	insideOwnedApp := func(path string) bool {
		relative, err := filepath.Rel(ctx.Instance.StateDir, path)
		return err == nil && filepath.IsAbs(path) && relative != "." && relative != ".." && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
	}
	if !insideOwnedApp(journalPath) {
		t.Fatal("custody harness named a journal outside its owned app directory")
	}
	journalPath, err = filepath.EvalSymlinks(journalPath)
	if err != nil || !insideOwnedApp(journalPath) {
		t.Fatalf("custody journal redirected outside the owned app: %v", err)
	}
	journalBefore, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	refuse := exec.Command(python, "-I", "-B", harness, "refuse", workerSource, ctx.Instance.StateDir, evidence)
	refuse.Env = ownedProcessEnvironment(ctx)
	if output, err := refuse.CombinedOutput(); err != nil {
		t.Fatalf("specific predecessor custody was not retained before native stop: %v %s", err, output)
	}
	if after, err := os.ReadFile(journalPath); err != nil || !bytes.Equal(journalBefore, after) {
		t.Fatal("pre-stop recovery changed its journal")
	}
	if !processPIDAlive(writer.PID) {
		t.Fatal("read-only refusal terminated the escaped writer")
	}
	// Observe actual writer progress before asking the native scope to stop.
	beforeStop := waitFile("writer-ticks")
	for deadline := time.Now().Add(5 * time.Second); ; {
		current, err := os.ReadFile(filepath.Join(evidence, "writer-ticks"))
		if err == nil && len(current) > 0 && !bytes.Equal(beforeStop, current) {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("escaped writer did not make progress before native stop")
		}
		time.Sleep(10 * time.Millisecond)
	}
	started := time.Now()
	if err := stop(ctx); err != nil {
		t.Fatal(err)
	}
	if time.Since(started) < shutdownTimeout {
		t.Fatal("TERM-ignoring writer was not given its shutdown deadline")
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("stopped scoped command did not finish")
	}
	completion, err := readExecutionCompletion(ctx, binding.Scope.ID)
	if err != nil || completion.Scope != binding.Scope || completion.ReceiptSHA256 != binding.ReceiptSHA256 {
		t.Fatalf("native stop did not attest the exact journal-bound scope: %v", err)
	}
	if !processPIDAlive(peerPID) {
		t.Fatal("native cleanup terminated the other instance")
	}
	ticks := waitFile("writer-ticks")
	time.Sleep(100 * time.Millisecond)
	if after, err := os.ReadFile(filepath.Join(evidence, "writer-ticks")); err != nil || !bytes.Equal(ticks, after) {
		t.Fatal("writer survived successful native cleanup")
	}
	// Stop itself required the complete coalition census before attesting.
	// Independently check these exact owned kernel identities after that proof;
	// unrelated process creation after stop does not invalidate its zero event.
	for _, original := range []componentRecord{{PID: writer.PID, StartIdentity: writerIdentity}, {PID: binding.Scope.RootPID, StartIdentity: binding.Scope.RootIdentity}} {
		if !waitForOwnedRecordExit(original, time.Second) {
			t.Fatalf("native completion preceded owned PID %d exit", original.PID)
		}
	}
	if err := runInOwnedExecution(ctx, arguments("recover"), logFile, logFile); err != nil {
		output, _ := os.ReadFile(logPath)
		t.Fatalf("fresh native execution could not consume completion: %v %s", err, output)
	}
	waitFile("recovered")
	if _, err := os.Stat(journalPath); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("recovered Apply journal was not retired")
	}
	if retained, err := readExecutionCompletion(ctx, binding.Scope.ID); err != nil || retained != completion {
		t.Fatal("normal restart replaced its predecessor's completion")
	}
	if !processPIDAlive(peerPID) {
		t.Fatal("normal restart disturbed the other instance")
	}
	for _, owned := range []launchContext{ctx, peer} {
		if err := stop(owned); err != nil {
			t.Fatalf("final owned instance cleanup failed: %v", err)
		}
		scopes, err := readOwnedExecutionScopes(owned)
		if err != nil || len(scopes) != 0 {
			t.Fatalf("final owned instance retained execution scopes: %v", err)
		}
	}
	if !waitForOwnedRecordExit(componentRecord{PID: peerPID, StartIdentity: peerIdentity}, time.Second) {
		t.Fatal("final cleanup left the owned control process alive")
	}
}

func TestExecutionCompletionSurvivesFreshProcessAndRestart(t *testing.T) {
	ctx, scope, original := completedExecutionTestScope(t)
	if err := stop(ctx); err != nil {
		t.Fatal(err)
	}
	completion, err := readExecutionCompletion(ctx, scope.ID)
	digest := sha256.Sum256(original)
	if err != nil || completion.Scope != scope || completion.ReceiptSHA256 != hex.EncodeToString(digest[:]) || completion.VerificationBootSession != scope.BootSession {
		t.Fatalf("completion lost its exact retired identity: %v", err)
	}
	dir, err := executionCompletionDirectory(ctx, false)
	if err != nil {
		t.Fatal(err)
	}
	proofPath := filepath.Join(dir, scope.ID+".json")
	proof, err := os.ReadFile(proofPath)
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(launchContext{Instance: ctx.Instance})
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(ctx.Executable, "__read-execution-completion-test", string(encoded), scope.ID)
	raw, err := command.Output()
	var observed executionCompletion
	if err != nil || decodeExecutionCompletion(raw, &observed) != nil || observed != completion {
		t.Fatalf("fresh process could not recover the exact completion: %v", err)
	}
	if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "stdin", "unused"}, io.Discard, io.Discard); err != nil {
		t.Fatalf("normal restart was blocked: %v", err)
	}
	if err := stop(ctx); err != nil {
		t.Fatal(err)
	}
	after, err := os.ReadFile(proofPath)
	if err != nil || !bytes.Equal(proof, after) {
		t.Fatal("new execution replaced its predecessor's durable proof")
	}
}

func TestExecutionCompletionRefusesUnsafeOrMismatchedProof(t *testing.T) {
	for _, fault := range []string{"symlink", "hardlink", "malformed", "duplicate", "mismatched-receipt", "unsafe-mode", "linked-directory"} {
		t.Run(fault, func(t *testing.T) {
			ctx, scope, original := completedExecutionTestScope(t)
			completion := executionCompletionForReceipt(scope, original, scope.BootSession)
			dir := filepath.Join(filepath.Dir(ctx.Instance.StatePath), "completed-executions")
			if fault == "linked-directory" {
				if err := os.Symlink(t.TempDir(), dir); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Mkdir(dir, 0700); err != nil {
					t.Fatal(err)
				}
				path := filepath.Join(dir, scope.ID+".json")
				if err := writeJSONAtomic(path, completion); err != nil {
					t.Fatal(err)
				}
				switch fault {
				case "symlink":
					if err := os.Rename(path, path+".original"); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(path+".original", path); err != nil {
						t.Fatal(err)
					}
				case "hardlink":
					if err := os.Link(path, path+".linked"); err != nil {
						t.Fatal(err)
					}
				case "malformed":
					if err := os.WriteFile(path, []byte("{}\n"), 0600); err != nil {
						t.Fatal(err)
					}
				case "duplicate":
					raw, _ := os.ReadFile(path)
					raw = bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1)
					if err := os.WriteFile(path, raw, 0600); err != nil {
						t.Fatal(err)
					}
				case "mismatched-receipt":
					completion.ReceiptSHA256 = strings.Repeat("a", 64)
					if err := writeJSONAtomic(path, completion); err != nil {
						t.Fatal(err)
					}
				case "unsafe-mode":
					if err := os.Chmod(path, 0644); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := stop(ctx); err == nil {
				t.Fatal("unsafe completion metadata authorized retirement")
			}
			active := filepath.Join(filepath.Dir(ctx.Instance.StatePath), "executions", scope.ID+".json")
			after, err := os.ReadFile(active)
			if err != nil || !bytes.Equal(original, after) {
				t.Fatal("completion refusal changed the original execution receipt")
			}
		})
	}
}

func TestFailedNativeCleanupCannotPublishExecutionCompletion(t *testing.T) {
	ctx, scope, original := completedExecutionTestScope(t)
	prior := inspectOwnedProcesses
	t.Cleanup(func() { inspectOwnedProcesses = prior })
	inspectOwnedProcesses = func(launchContext, instanceState) ([]ownedProcess, error) {
		return nil, errors.New("synthetic kernel inspection failure")
	}
	if err := stop(ctx); err == nil || !strings.Contains(err.Error(), "synthetic kernel inspection failure") {
		t.Fatalf("inspection failure was suppressed: %v", err)
	}
	if _, err := readExecutionCompletion(ctx, scope.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("unverified cleanup published a completion: %v", err)
	}
	after, err := os.ReadFile(filepath.Join(filepath.Dir(ctx.Instance.StatePath), "executions", scope.ID+".json"))
	if err != nil || !bytes.Equal(original, after) {
		t.Fatal("failed cleanup changed its receipt")
	}
}

func TestOwnedEnvironmentUsesResolvedRuntimeHome(t *testing.T) {
	ctx := executionTestContext(t)
	ctx.Environment = append(ctx.Environment, "JOBCTRL_RUNTIME_HOME=relative-runtime", "JOBCTRL_RUNTIME_HOME=other-runtime")
	environment := ownedProcessEnvironment(ctx)
	count := 0
	for _, value := range environment {
		if strings.HasPrefix(value, "JOBCTRL_RUNTIME_HOME=") {
			count++
			if value != "JOBCTRL_RUNTIME_HOME="+ctx.Instance.RuntimeHome {
				t.Fatal("native child inherited unresolved runtime home")
			}
		}
	}
	if count != 1 {
		t.Fatalf("runtime home has %d authorities", count)
	}
}
