//go:build darwin

package launcher

import (
	"bytes"
	"context"
	"encoding/binary"
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

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type v6ControllerFixture struct {
	Active, Candidate, Controller launchContext
	Ready, Continue               string
}

// The copied test executable exercises the real helper and quiescence code
// from a synthetic installed selector. Production has no such test entry.
func init() {
	if len(os.Args) != 3 || os.Args[1] != "__v6-controller-proof-test" {
		return
	}
	raw, err := os.ReadFile(os.Args[2])
	var fixture v6ControllerFixture
	if err == nil {
		err = json.Unmarshal(raw, &fixture)
	}
	if err == nil {
		if fixture.Ready != "" {
			err = os.WriteFile(fixture.Ready, []byte("ready"), 0600)
			deadline := time.Now().Add(15 * time.Second)
			for err == nil {
				if _, statErr := os.Stat(fixture.Continue); statErr == nil {
					break
				}
				if time.Now().After(deadline) {
					err = errors.New("synthetic handoff controller was not released")
					break
				}
				time.Sleep(10 * time.Millisecond)
			}
		}
	}
	if err == nil {
		err = proveStoppedTemporalQuiescence(fixture.Active, fixture.Candidate, fixture.Controller)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	os.Exit(0)
}

// This is a synthetic executable: it deliberately does not run a Temporal
// server. Its detached child has an empty environment and a different session.
const temporalProbeFixtureSource = `package main
import (
 "encoding/json"
 "fmt"
 "net/http"
 "os"
 "os/exec"
 "os/signal"
 "path/filepath"
 "strconv"
 "strings"
 "syscall"
 "time"
)
func main() {
 data := os.Getenv("JOBCTRL_DIR")
 switch filepath.Base(os.Args[0]) {
 case "temporal":
  if len(os.Args) < 2 || os.Args[1] != "operator" { _ = os.WriteFile(filepath.Join(data,"server-ready"),[]byte("ready"),0600); for { time.Sleep(time.Hour) } }
  mode, _ := os.ReadFile(filepath.Join(data,"probe-mode"))
  switch strings.TrimSpace(string(mode)) {
  case "error": fmt.Fprintln(os.Stderr,"synthetic cluster unavailable"); os.Exit(17)
  case "flood": fmt.Fprint(os.Stdout,strings.Repeat("y",262144)); fmt.Fprint(os.Stderr,"synthetic failure: ",strings.Repeat("x",262144)); os.Exit(17)
  case "require-server":
   if _, err := os.Stat(filepath.Join(data,"server-ready")); err != nil { os.Exit(28) }
   _ = os.WriteFile(filepath.Join(data,"probe-success"),[]byte("healthy"),0600)
   return
  case "damage":
   scope := os.Getenv("JOBCTRL_EXECUTION_SCOPE")
   if len(scope) != 32 { os.Exit(24) }
   receipt := filepath.Join(os.Getenv("JOBCTRL_TEST_PROBE_RECEIPTS"),scope+".json")
   file, err := os.OpenFile(receipt,os.O_RDONLY|syscall.O_NOFOLLOW,0)
   if err != nil { os.Exit(25) }
   info, err := file.Stat()
   if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 { os.Exit(25) }
   if os.WriteFile(filepath.Join(data,"probe-scope-id"),[]byte(scope),0600) != nil { os.Exit(27) }
   if file.Chmod(0644) != nil { os.Exit(26) }
   file.Close()
   fmt.Fprintln(os.Stderr,"synthetic health output")
   return
  case "hang", "orphan":
   if strings.TrimSpace(string(mode)) == "hang" { signal.Ignore(syscall.SIGTERM,syscall.SIGINT) }
   child := exec.Command("/bin/sleep", "120")
   child.Env = []string{}
   child.SysProcAttr = &syscall.SysProcAttr{Setsid:true}
   if child.Start() != nil { os.Exit(23) }
   _ = os.WriteFile(filepath.Join(data,"probe-pids"), []byte(fmt.Sprintf("%d %d",os.Getpid(),child.Process.Pid)), 0600)
   if strings.TrimSpace(string(mode)) == "orphan" { return }
   for { time.Sleep(time.Hour) }
  default: _ = os.WriteFile(filepath.Join(data,"probe-success"),[]byte("healthy"),0600); fmt.Fprintln(os.Stdout,"healthy"); return
  }
 case "python3":
  _ = os.WriteFile(filepath.Join(data,"worker.pid"),[]byte(strconv.Itoa(os.Getpid())),0600)
  for { time.Sleep(time.Hour) }
 case "node":
  http.HandleFunc("/v1/health",func(w http.ResponseWriter,r *http.Request){
   raw,_:=os.ReadFile(filepath.Join(data,"worker.pid")); pid,_:=strconv.Atoi(string(raw))
   _=json.NewEncoder(w).Encode(map[string]any{"worker":map[string]any{"status":"healthy","heartbeat":map[string]int{"pid":pid}}})
  })
  _=http.ListenAndServe("127.0.0.1:8766",nil)
 }
}`

type temporalFixture struct {
	payload, launcher, data, runtime, home string
	env                                    []string
}

func buildTemporalProbeFixture(t *testing.T) temporalFixture {
	t.Helper()
	payload, manifest := verifiedPayloadFixture(t)
	root := t.TempDir()
	launcher := filepath.Join(payload, "launcher", "jobctrl")
	source := filepath.Join(root, "component.go")
	if err := os.WriteFile(source, []byte(temporalProbeFixtureSource), 0600); err != nil {
		t.Fatal(err)
	}
	component := filepath.Join(root, "component")
	for _, args := range [][]string{{"build", "-o", launcher, "./cmd/jobctrl"}, {"build", "-o", component, source}} {
		command := exec.Command("go", args...)
		command.Dir = filepath.Clean(filepath.Join("..", ".."))
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build synthetic fixture: %v\n%s", err, output)
		}
	}
	raw, err := os.ReadFile(component)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"temporal/temporal", "python/bin/python3", "node/bin/node"} {
		path := filepath.Join(payload, name)
		if err := os.MkdirAll(filepath.Dir(path), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, raw, 0755); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(payload, "launcher", "runtime-manifest.json"), []byte(validRuntimeManifest), 0644); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, payload, &manifest)
	writeLocalEnvelope(t, payload, manifest)
	home, data, runtime := filepath.Join(root, "home"), filepath.Join(root, "data"), filepath.Join(root, "runtime")
	for _, dir := range []string{home, data} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	env := []string{"HOME=" + home, "JOBCTRL_DIR=" + data, "JOBCTRL_RUNTIME_HOME=" + runtime, "PATH=/usr/bin:/bin:/usr/sbin:/sbin"}
	return temporalFixture{payload, launcher, data, runtime, home, env}
}

func (f temporalFixture) setMode(t *testing.T, mode string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(f.data, "probe-mode"), []byte(mode), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(f.data, "probe-pids")); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func (f temporalFixture) command(args ...string) *exec.Cmd {
	command := exec.Command(f.launcher, args...)
	command.Env, command.Dir = f.env, f.home
	return command
}

func (f temporalFixture) stop(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, f.launcher, "stop")
	command.Env, command.Dir = f.env, f.home
	if output, err := command.CombinedOutput(); err != nil {
		t.Errorf("stop synthetic instance: %v: %s", err, output)
	}
}

type observedProbeProcess struct {
	pid       int
	identity  string
	coalition [2]uint64
}

func waitSyntheticProbe(t *testing.T, f temporalFixture) []observedProbeProcess {
	t.Helper()
	var pids []int
	for deadline := time.Now().Add(8 * time.Second); time.Now().Before(deadline); {
		raw, err := os.ReadFile(filepath.Join(f.data, "probe-pids"))
		fields := strings.Fields(string(raw))
		if err == nil && len(fields) == 2 {
			for _, field := range fields {
				pid, _ := strconv.Atoi(field)
				pids = append(pids, pid)
			}
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if len(pids) != 2 || pids[0] <= 0 || pids[1] <= 0 {
		t.Fatal("synthetic probe did not publish its two live PIDs")
	}
	var observed []observedProbeProcess
	for _, pid := range pids {
		identity, err := processStartIdentity(pid)
		if err != nil {
			t.Fatal(err)
		}
		ids, err := processCoalitionIDs(pid)
		if err != nil {
			t.Fatal(err)
		}
		observed = append(observed, observedProbeProcess{pid, identity, ids})
	}
	if observed[0].coalition != observed[1].coalition {
		t.Fatal("probe child escaped its native ownership scope")
	}
	return observed
}

func assertProbeGone(t *testing.T, observed []observedProbeProcess) {
	t.Helper()
	for _, p := range observed {
		info, err := processBSDInfoIncludingZombies(p.pid)
		if errors.Is(err, syscall.ESRCH) || (err == nil && (processIdentityFromBSD(info) != p.identity || binary.LittleEndian.Uint32(info[4:]) == 5)) {
			continue
		}
		t.Fatalf("owned probe PID %d survived or could not be inspected: %v", p.pid, err)
	}
}

func assertFixturePortsFree(t *testing.T) {
	t.Helper()
	var listeners []net.Listener
	defer func() {
		for _, l := range listeners {
			l.Close()
		}
	}()
	for _, port := range []int{7233, 8233, 8766} {
		listener, err := net.Listen("tcp4", fmt.Sprintf("127.0.0.1:%d", port))
		if err != nil {
			t.Skipf("fixed fixture port %d unavailable: %v", port, err)
		}
		listeners = append(listeners, listener)
	}
}

func TestTemporalProbeBoundsOutputAndOwnedDescendants(t *testing.T) {
	f := buildTemporalProbeFixture(t)
	inst, err := resolveInstance(f.env)
	if err != nil {
		t.Fatal(err)
	}
	var manifest runtimeManifest
	if err := json.Unmarshal([]byte(validRuntimeManifest), &manifest); err != nil {
		t.Fatal(err)
	}
	executable, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Executable: executable, PayloadRoot: f.payload, Manifest: manifest, Instance: inst, Environment: f.env}
	peer := exec.Command("/bin/sleep", "120")
	if err := peer.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Process.Kill(); _ = peer.Wait() }()
	peerID, err := processStartIdentity(peer.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"healthy", "error", "flood", "orphan", "hang"} {
		t.Run(mode, func(t *testing.T) {
			f.setMode(t, mode)
			if mode == "hang" {
				parent, cancel := context.WithCancel(context.Background())
				done := make(chan error, 1)
				go func() { done <- probeTemporal(parent, ctx, ctx) }()
				joined := false
				defer func() {
					cancel()
					if !joined {
						<-done
					}
				}()
				observed := waitSyntheticProbe(t, f)
				started := time.Now()
				cancel()
				err := <-done
				joined = true
				if !errors.Is(err, context.Canceled) || time.Since(started) > 5*time.Second {
					t.Fatalf("cancellation was not prompt and truthful: %v, %s", err, time.Since(started))
				}
				assertProbeGone(t, observed)
			} else {
				err := probeTemporal(context.Background(), ctx, ctx)
				switch mode {
				case "healthy", "orphan":
					if err != nil {
						t.Fatal(err)
					}
				case "error":
					if err == nil || !strings.Contains(err.Error(), "synthetic cluster unavailable") {
						t.Fatalf("diagnostic lost: %v", err)
					}
				case "flood":
					if err == nil || !strings.Contains(err.Error(), "output truncated") || len(err.Error()) > temporalProbeOutputLimit+512 {
						t.Fatalf("unbounded or missing flood diagnostic: %v", err)
					}
				}
				if mode == "orphan" {
					raw, err := os.ReadFile(filepath.Join(f.data, "probe-pids"))
					if err != nil {
						t.Fatal(err)
					}
					for _, field := range strings.Fields(string(raw)) {
						pid, _ := strconv.Atoi(field)
						if info, err := processBSDInfoIncludingZombies(pid); err == nil && binary.LittleEndian.Uint32(info[4:]) != 5 {
							t.Fatalf("completed probe left PID %d live", pid)
						}
					}
				}
			}
			if current, err := processStartIdentity(peer.Process.Pid); err != nil || current != peerID {
				t.Fatal("probe cleanup affected unrelated peer")
			}
			scopes, err := readOwnedExecutionScopes(ctx)
			if err != nil || len(scopes) != 0 {
				t.Fatalf("probe receipt was not safely retired: %v, %v", scopes, err)
			}
		})
	}
}

func TestTemporalProbeActualStartupAndStatus(t *testing.T) {
	assertFixturePortsFree(t)
	f := buildTemporalProbeFixture(t)
	t.Cleanup(func() { f.stop(t) })
	peer := exec.Command("/bin/sleep", "120")
	if err := peer.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Process.Kill(); _ = peer.Wait() }()
	peerID, err := processStartIdentity(peer.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	f.setMode(t, "healthy")
	if output, err := f.command("start", "--no-open").CombinedOutput(); err != nil {
		t.Fatalf("synthetic start: %v: %s", err, output)
	}
	if output, err := f.command("status", "--json").CombinedOutput(); err != nil || !bytes.Contains(output, []byte(`"status":"running"`)) {
		t.Fatalf("healthy status: %v: %s", err, output)
	}
	f.setMode(t, "error")
	for _, args := range [][]string{{"status"}, {"status", "--json"}} {
		output, err := f.command(args...).CombinedOutput()
		if err != nil || !bytes.Contains(output, []byte("synthetic cluster unavailable")) {
			t.Fatalf("public status omitted Temporal diagnostic: %v: %s", err, output)
		}
	}
	f.setMode(t, "hang")
	status := f.command("status", "--json")
	var statusOutput bytes.Buffer
	status.Stdout, status.Stderr = &statusOutput, &statusOutput
	started := time.Now()
	if err := status.Start(); err != nil {
		t.Fatal(err)
	}
	observed := waitSyntheticProbe(t, f)
	if err := status.Wait(); err != nil || time.Since(started) > 8*time.Second || !strings.Contains(statusOutput.String(), `"state":"unhealthy"`) || !strings.Contains(statusOutput.String(), `"status":"degraded"`) {
		t.Fatalf("hung status was not bounded/degraded: %v, %s, %s", err, time.Since(started), statusOutput.String())
	}
	assertProbeGone(t, observed)
	if current, err := processStartIdentity(peer.Process.Pid); err != nil || current != peerID {
		t.Fatal("status probe signaled unrelated peer")
	}
	f.setMode(t, "healthy")
	if output, err := f.command("status", "--json").CombinedOutput(); err != nil || !bytes.Contains(output, []byte(`"status":"running"`)) {
		t.Fatalf("status probe harmed the running fleet: %v: %s", err, output)
	}

	// Stop must not wait indefinitely on a concurrent status probe's receipt
	// or its TERM-ignoring health process.
	f.setMode(t, "hang")
	status = f.command("status", "--json")
	statusOutput.Reset()
	status.Stdout, status.Stderr = &statusOutput, &statusOutput
	if err := status.Start(); err != nil {
		t.Fatal(err)
	}
	observed = waitSyntheticProbe(t, f)
	stopDone := make(chan error, 1)
	stopCommand := f.command("stop")
	var stopOutput bytes.Buffer
	stopCommand.Stdout, stopCommand.Stderr = &stopOutput, &stopOutput
	started = time.Now()
	go func() { stopDone <- stopCommand.Run() }()
	select {
	case err := <-stopDone:
		if err != nil || time.Since(started) > 8*time.Second {
			t.Fatalf("stop during status probe: %v, %s: %s", err, time.Since(started), stopOutput.String())
		}
	case <-time.After(8 * time.Second):
		t.Fatal("stop did not finish during status probe")
	}
	statusDone := make(chan error, 1)
	go func() { statusDone <- status.Wait() }()
	select {
	case err := <-statusDone:
		if err != nil {
			t.Fatalf("concurrent status did not finish: %v: %s", err, statusOutput.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("status remained blocked after stop")
	}
	assertProbeGone(t, observed)
	if current, err := processStartIdentity(peer.Process.Pid); err != nil || current != peerID {
		t.Fatal("stop during status affected unrelated peer")
	}

	f.setMode(t, "hang")
	foreground := f.command("start", "--foreground", "--no-open")
	var foregroundOutput bytes.Buffer
	foreground.Stdout, foreground.Stderr = &foregroundOutput, &foregroundOutput
	if err := foreground.Start(); err != nil {
		t.Fatal(err)
	}
	observed = waitSyntheticProbe(t, f)
	started = time.Now()
	if err := foreground.Process.Signal(syscall.SIGTERM); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- foreground.Wait() }()
	select {
	case err := <-done:
		if err != nil || time.Since(started) > 8*time.Second {
			t.Fatalf("foreground cancellation: %v, %s: %s", err, time.Since(started), foregroundOutput.String())
		}
	case <-time.After(8 * time.Second):
		t.Fatal("foreground cancellation did not complete")
	}
	assertProbeGone(t, observed)
	if current, err := processStartIdentity(peer.Process.Pid); err != nil || current != peerID {
		t.Fatal("foreground cancellation affected unrelated peer")
	}
	f.stop(t)

	f.setMode(t, "hang")
	detached := f.command("start", "--no-open")
	var startOutput bytes.Buffer
	detached.Stdout, detached.Stderr = &startOutput, &startOutput
	started = time.Now()
	if err := detached.Start(); err != nil {
		t.Fatal(err)
	}
	observed = waitSyntheticProbe(t, f)
	done = make(chan error, 1)
	go func() { done <- detached.Wait() }()
	select {
	case err := <-done:
		elapsed := time.Since(started)
		if err == nil || elapsed < startupTimeout-2*time.Second || elapsed > startupTimeout+8*time.Second || !strings.Contains(startOutput.String(), "before startup deadline") {
			t.Fatalf("detached startup deadline: %v, %s: %s", err, elapsed, startOutput.String())
		}
	case <-time.After(startupTimeout + 8*time.Second):
		t.Fatal("detached startup exceeded host deadline")
	}
	assertProbeGone(t, observed)
	if current, err := processStartIdentity(peer.Process.Pid); err != nil || current != peerID {
		t.Fatal("startup deadline affected unrelated peer")
	}
	inst, err := resolveInstance(f.env)
	if err != nil {
		t.Fatal(err)
	}
	state, err := readState(inst.StatePath)
	if err != nil || state.StoppedAt == nil || !state.OwnershipVerified || stateHasLiveProcesses(state) {
		t.Fatalf("startup cleanup did not establish verified stopped proof: %#v, %v", state, err)
	}
	f.setMode(t, "healthy")
	if output, err := f.command("start", "--no-open").CombinedOutput(); err != nil {
		t.Fatalf("normal restart after automatic startup cleanup: %v: %s", err, output)
	}
	f.stop(t)
}

func TestPublicStatusReportsTemporalProbeCleanupFailure(t *testing.T) {
	assertFixturePortsFree(t)
	f := buildTemporalProbeFixture(t)
	t.Cleanup(func() { f.stop(t) })
	f.setMode(t, "healthy")
	if output, err := f.command("start", "--no-open").CombinedOutput(); err != nil {
		t.Fatalf("synthetic start: %v: %s", err, output)
	}
	inst, err := resolveInstance(f.env)
	if err != nil {
		t.Fatal(err)
	}
	receipts := filepath.Join(inst.Dir, "executions")
	f.env = append(f.env, "JOBCTRL_TEST_PROBE_RECEIPTS="+receipts)
	// Only the fixture's own scope receipt is modified, then restored so the
	// ordinary stop gate can retire it. Never repair an unfamiliar path.
	restore := func() {
		raw, readErr := os.ReadFile(filepath.Join(f.data, "probe-scope-id"))
		if readErr != nil {
			return
		}
		id := string(raw)
		if !executionIDValid(id) {
			t.Error("invalid synthetic probe receipt identity")
			return
		}
		path := filepath.Join(receipts, id+".json")
		file, openErr := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if openErr != nil {
			t.Errorf("refusing to restore unfamiliar synthetic receipt: %v", openErr)
			return
		}
		defer file.Close()
		info, statErr := file.Stat()
		if statErr != nil {
			t.Errorf("inspect synthetic receipt: %v", statErr)
			return
		}
		stat, ok := info.Sys().(*syscall.Stat_t)
		if !ok || !info.Mode().IsRegular() || (info.Mode().Perm() != 0644 && info.Mode().Perm() != 0600) || int(stat.Uid) != os.Getuid() || stat.Nlink != 1 {
			t.Error("refusing to restore unfamiliar synthetic receipt")
			return
		}
		if err := file.Chmod(0600); err != nil {
			t.Errorf("restore synthetic receipt mode: %v", err)
		}
	}
	defer restore()
	f.setMode(t, "damage")
	command := f.command("status", "--json")
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	err = command.Run()
	var result struct {
		Status     string `json:"status"`
		Components map[string]struct {
			State       string `json:"state"`
			HealthError string `json:"healthError"`
		} `json:"components"`
	}
	decodeErr := json.Unmarshal(stdout.Bytes(), &result)
	if err == nil || decodeErr != nil || result.Status != "degraded" || result.Components["temporal"].State != "unhealthy" || !strings.Contains(result.Components["temporal"].HealthError, "cleanup") || !strings.Contains(stderr.String(), "cleanup") {
		t.Fatalf("public status hid probe cleanup failure: %v, %v, stdout=%s stderr=%s", err, decodeErr, stdout.String(), stderr.String())
	}
}

func TestV6QuiescenceProbesOldTemporalWithCurrentController(t *testing.T) {
	f := buildTemporalProbeFixture(t)
	f.setMode(t, "require-server")
	inst, err := resolveInstance(f.env)
	if err != nil {
		t.Fatal(err)
	}
	current, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	currentBytes, err := os.ReadFile(current)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.launcher, currentBytes, 0755); err != nil {
		t.Fatal(err)
	}
	var oldManifest distributionManifest
	if err := decodeStrictRegular(filepath.Join(f.payload, "manifest.json"), &oldManifest); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, f.payload, &oldManifest)
	writeLocalEnvelope(t, f.payload, oldManifest)
	var manifest runtimeManifest
	if err := json.Unmarshal([]byte(validRuntimeManifest), &manifest); err != nil {
		t.Fatal(err)
	}
	distribution, err := loadAndVerifyDistributionManifest(f.payload)
	if err != nil {
		t.Fatal(err)
	}
	active := launchContext{Executable: f.launcher, PayloadRoot: f.payload, Manifest: manifest, Distribution: distribution, Instance: inst, Environment: f.env}
	if sameExecutable(current, active.Executable) {
		t.Fatalf("fixture did not separate current controller and old payload: %v", err)
	}
	controllerPayload, controllerManifest := verifiedPayloadFixture(t)
	controllerCopy := filepath.Join(controllerPayload, "launcher", "jobctrl")
	if err := os.WriteFile(controllerCopy, currentBytes, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(controllerCopy, 0755); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, controllerPayload, &controllerManifest)
	writeLocalEnvelope(t, controllerPayload, controllerManifest)
	verifiedController, err := loadAndVerifyDistributionManifest(controllerPayload)
	if err != nil {
		t.Fatal(err)
	}
	controller := active
	controller.Executable = current
	controller.PayloadRoot = controllerPayload
	controller.Distribution = verifiedController
	candidate := active
	candidate.PayloadRoot = t.TempDir()
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	if err := os.MkdirAll(filepath.Dir(python), 0700); err != nil {
		t.Fatal(err)
	}
	script := "#!/bin/sh\nprintf invoked > \"$JOBCTRL_DIR/quiescence-module\"\nprintf '%s\\n' '{\"running_execution_count\":0,\"schema_version\":1,\"status\":\"quiescent\"}'\n"
	if err := os.WriteFile(python, []byte(script), 0755); err != nil {
		t.Fatal(err)
	}
	if err := proveStoppedTemporalQuiescence(active, candidate, controller); err != nil {
		t.Fatalf("old-runtime quiescence proof with current controller: %v", err)
	}
	for _, name := range []string{"probe-success", "quiescence-module"} {
		if _, err := os.Stat(filepath.Join(f.data, name)); err != nil {
			t.Fatalf("actual quiescence path omitted %s: %v", name, err)
		}
	}
	state, err := readState(inst.StatePath)
	if err != nil || state.StoppedAt == nil || stateHasLiveProcesses(state) {
		t.Fatalf("quiescence proof did not stop its synthetic service: %#v, %v", state, err)
	}
	if _, exists := state.Components["worker"]; exists {
		t.Fatal("quiescence proof started worker")
	}
	if _, exists := state.Components["api"]; exists {
		t.Fatal("quiescence proof started API")
	}

	// Hold the old public controller across selector replacement. Both selector
	// binaries are inventoried test executables; the new one has distinct bytes.
	store, err := release.Open(inst.RuntimeHome)
	if err != nil {
		t.Fatal(err)
	}
	newBinary := filepath.Join(t.TempDir(), "new-controller")
	build := exec.Command("go", "test", "-c", "-ldflags=-buildid=jobctrl-v6-handoff-qa", "-o", newBinary, "./internal/launcher")
	build.Dir = filepath.Clean(filepath.Join("..", ".."))
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build synthetic replacement controller: %v: %s", err, output)
	}
	oldDigest, err := sha256Path(current)
	if err != nil {
		t.Fatal(err)
	}
	newDigest, err := sha256Path(newBinary)
	if err != nil || oldDigest == newDigest {
		t.Fatalf("synthetic selector binaries must differ: %v", err)
	}
	oldReceipt := installApplySelectorCompatibilityRelease(t, store.Home, "local-controller-old-0001", 1, "/usr/bin/python3", current, current)
	newReceipt := installApplySelectorCompatibilityRelease(t, store.Home, "local-controller-new-0002", 2, "/usr/bin/python3", newBinary, newBinary)
	oldVerified, err := verifyInstalledReleaseForExecution(store, oldReceipt)
	if err != nil {
		t.Fatal(err)
	}
	newVerified, err := verifyInstalledReleaseForExecution(store, newReceipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(store.Home, oldVerified); err != nil {
		t.Fatal(err)
	}
	selection, err := store.WriteSelectedActive(oldReceipt, 0, oldReceipt.BuildID, "local-fixture")
	if err != nil {
		t.Fatal(err)
	}
	selector := filepath.Join(store.Home, "bin", "jobctrl")
	beforeFile, err := os.Stat(selector)
	if err != nil {
		t.Fatal(err)
	}
	selectorController := active
	selectorController.Executable = selector
	if sameExecutable(selector, active.Executable) {
		t.Fatal("selector and old payload are not distinct")
	}
	for _, name := range []string{"probe-success", "quiescence-module", "server-ready"} {
		if err := os.Remove(filepath.Join(f.data, name)); err != nil {
			t.Fatal(err)
		}
	}
	ready, proceed := filepath.Join(f.home, "controller-ready"), filepath.Join(f.home, "controller-continue")
	request, err := json.Marshal(v6ControllerFixture{Active: active, Candidate: candidate, Controller: selectorController, Ready: ready, Continue: proceed})
	if err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(f.home, "quiescence-request.json")
	if err := os.WriteFile(requestPath, request, 0600); err != nil {
		t.Fatal(err)
	}
	command := exec.Command(selector, "__v6-controller-proof-test", requestPath)
	command.Env, command.Dir = f.env, f.home
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	completed := make(chan error, 1)
	go func() { completed <- command.Wait() }()
	joined := false
	identity, identityErr := processStartIdentity(command.Process.Pid)
	defer func() {
		if !joined {
			if currentID, err := processStartIdentity(command.Process.Pid); identity != "" && err == nil && currentID == identity {
				_ = command.Process.Kill()
			}
			<-completed
		}
		if state, err := readState(inst.StatePath); err == nil {
			if record, ok := state.Components["temporal"]; ok && recordMatchesLiveProcess(record) {
				_ = terminateRecord(record)
			}
		}
	}()
	if identityErr != nil {
		t.Fatal(identityErr)
	}
	for deadline := time.Now().Add(10 * time.Second); ; {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		select {
		case err := <-completed:
			joined = true
			t.Fatalf("old controller exited before handoff: %v: %s", err, output.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("old controller did not reach handoff gate")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := handoffPublicSelector(store.Home, newVerified); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteSelectedActive(oldReceipt, selection.Generation, newReceipt.BuildID, selection.Acquisition); err != nil {
		t.Fatal(err)
	}
	afterFile, err := os.Stat(selector)
	if err != nil || os.SameFile(beforeFile, afterFile) {
		t.Fatalf("selector inode did not change: %v", err)
	}
	if digest, err := sha256Path(selector); err != nil || digest != newDigest {
		t.Fatalf("replacement selector did not match authenticated candidate: %v", err)
	}
	if currentID, err := processStartIdentity(command.Process.Pid); err != nil || currentID != identity {
		t.Fatalf("old controller did not remain alive through handoff: %v", err)
	}
	if err := os.WriteFile(proceed, []byte("go"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-completed:
		joined = true
		if err != nil {
			t.Fatalf("live old controller could not complete quiescence after handoff: %v: %s", err, output.String())
		}
	case <-time.After(40 * time.Second):
		t.Fatal("live old controller did not finish quiescence")
	}
	for _, name := range []string{"probe-success", "quiescence-module"} {
		if _, err := os.Stat(filepath.Join(f.data, name)); err != nil {
			t.Fatalf("selector proof omitted %s: %v", name, err)
		}
	}
	state, err = readState(inst.StatePath)
	if err != nil || state.StoppedAt == nil || stateHasLiveProcesses(state) {
		t.Fatalf("selector proof did not stop its synthetic service: %#v, %v", state, err)
	}
	if err := os.WriteFile(selector, []byte("tampered synthetic selector"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := verifyOwnedExecutionExecutable(selectorController, selector); err == nil {
		t.Fatal("tampered public selector was accepted")
	}

	foreign := controller
	foreign.Executable = active.Executable
	if err := probeTemporal(context.Background(), active, foreign); err == nil || !strings.Contains(err.Error(), "does not match authenticated executable") {
		t.Fatalf("foreign controller was accepted: %v", err)
	}
	foreign = controller
	foreign.Instance.ID += "-other"
	if err := probeTemporal(context.Background(), active, foreign); err == nil || !strings.Contains(err.Error(), "different instance") {
		t.Fatalf("foreign instance was accepted: %v", err)
	}
}

func TestStartupFailureReportsCleanupFailure(t *testing.T) {
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "manifest.json"), []byte("synthetic"), 0600); err != nil {
		t.Fatal(err)
	}
	executable, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Executable: executable, PayloadRoot: root, Instance: instance{ID: "synthetic", StateDir: root, StatePath: filepath.Join(root, "state.json"), LockPath: filepath.Join(root, "instance.lock"), LogDir: root}}
	ctx.Manifest.Ports.TemporalGRPC = listener.Addr().(*net.TCPAddr).Port
	previous := inspectOwnedProcesses
	inspectOwnedProcesses = func(launchContext, instanceState, ...executionWitnesses) ([]ownedProcess, error) {
		return nil, errors.New("synthetic census failure")
	}
	defer func() { inspectOwnedProcesses = previous }()
	var ready bytes.Buffer
	err = supervise(ctx, &ready)
	if !errors.Is(err, ErrPortInUse) || !strings.Contains(err.Error(), "synthetic census failure") || !strings.Contains(ready.String(), "synthetic census failure") {
		t.Fatalf("startup and cleanup failures must both be reported: %v, %s", err, ready.String())
	}
	raw, err := os.ReadFile(ctx.Instance.StatePath)
	var state instanceState
	if err == nil {
		err = json.Unmarshal(raw, &state)
	}
	if err != nil || state.StoppedAt != nil || state.OwnershipVerified {
		t.Fatalf("cleanup failure claimed stopped proof: %#v, %v", state, err)
	}
}

// The cleanup owner has the control lock but has not observed this scope yet.
// A real joined/zero probe must leave proof before its job can disappear.
func TestTemporalProbeCompletionPrecedesFirstStopCensus(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath = filepath.Join(root, "control.lock")
	ctx.Instance.LockPath = filepath.Join(root, "instance.lock")
	if err := os.Mkdir(ctx.Instance.StateDir, 0700); err != nil {
		t.Fatal(err)
	}
	peer := exec.Command("/bin/sleep", "120")
	if err := peer.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = peer.Process.Kill(); _ = peer.Wait() }()
	peerIdentity, err := processStartIdentity(peer.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	parent, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	joined := false
	var control *os.File
	defer func() {
		cancel()
		releaseLock(control)
		if !joined {
			select {
			case <-done:
			case <-time.After(15 * time.Second):
				t.Error("owned probe controller did not settle during cleanup")
			}
		}
		if err := stop(ctx); err != nil {
			t.Errorf("final synthetic probe cleanup: %v", err)
		}
	}()
	// A held platform command isolates the native probe lifetime machinery;
	// public Temporal startup/status are covered by the actual fixture above.
	go func() {
		done <- runTemporalProbeInOwnedExecution(parent, ctx, "/bin/sleep", []string{"120"}, io.Discard)
	}()
	var scope executionScope
	var observed []observedProbeProcess
	for deadline := time.Now().Add(8 * time.Second); ; {
		scopes, err := readOwnedExecutionScopes(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if len(scopes) == 1 {
			scope = scopes[0]
			members, err := executionMembers(scope.CoalitionIDs)
			if err != nil {
				t.Fatal(err)
			}
			if len(members) == 2 {
				for _, member := range members {
					observed = append(observed, observedProbeProcess{member.PID, member.Identity, member.CoalitionIDs})
				}
				break
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("probe helper and its actual command did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	control, err = acquireLock(ctx.Instance.ControlPath, false)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	select {
	case err := <-done:
		joined = true
		var cleanupErr *temporalProbeCleanupError
		if !errors.Is(err, context.Canceled) || errors.As(err, &cleanupErr) {
			t.Fatalf("contended probe cleanup did not preserve verified completion: %v", err)
		}
	case <-time.After(12 * time.Second):
		t.Fatal("probe waited on the cleanup owner's control lock")
	}
	assertProbeGone(t, observed)
	completion, err := readExecutionCompletion(ctx, scope.ID)
	activePath := filepath.Join(root, "executions", scope.ID+".json")
	raw, readErr := os.ReadFile(activePath)
	expected := executionCompletionForReceipt(scope, raw, scope.BootSession)
	if err != nil || readErr != nil || completion.Scope != scope || completion.ReceiptSHA256 != expected.ReceiptSHA256 || completion.VerificationBootSession != scope.BootSession {
		t.Fatalf("probe returned without exact durable proof while receipt remained active: %v, %v", err, readErr)
	}
	proofPath := filepath.Join(root, "completed-executions", scope.ID+".json")
	proof, err := os.ReadFile(proofPath)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := os.WriteFile(proofPath, proof, 0600); err != nil {
			t.Errorf("restore owned completion control: %v", err)
		}
	}()
	oldCount, oldPIDs, oldBSD := readCoalitionActiveTaskCount, scopedProcessIDs, executionProcessBSDInfo
	defer func() {
		readCoalitionActiveTaskCount, scopedProcessIDs, executionProcessBSDInfo = oldCount, oldPIDs, oldBSD
	}()
	readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
		if id == scope.CoalitionIDs[0] {
			return 0, syscall.ESRCH // Reaping is not itself completion authority.
		}
		return oldCount(id)
	}
	censusReads := 0
	scopedProcessIDs = func() ([]int, error) { censusReads++; return []int{peer.Process.Pid}, nil }
	executionProcessBSDInfo = func(pid int) ([]byte, error) {
		if pid == peer.Process.Pid {
			return nil, syscall.EPERM
		}
		return oldBSD(pid)
	}
	// This is the lock holder's FIRST census: there is no local witness map.
	if members, err := inspectOwnedProcesses(ctx, instanceState{}); err != nil || len(members) != 0 || censusReads != 0 {
		t.Fatalf("durable completion could not resolve the first census: %v, %v", members, err)
	}
	for _, fault := range []string{"missing", "wrong-boot", "wrong-receipt", "malformed"} {
		t.Run(fault, func(t *testing.T) {
			defer func() {
				if err := os.WriteFile(proofPath, proof, 0600); err != nil {
					t.Errorf("restore exact synthetic proof: %v", err)
				}
			}()
			changed := completion
			switch fault {
			case "missing":
				err = os.Remove(proofPath)
			case "wrong-boot":
				changed.VerificationBootSession = "00000000-0000-0000-0000-000000000000"
				if changed.VerificationBootSession == scope.BootSession {
					changed.VerificationBootSession = "11111111-1111-1111-1111-111111111111"
				}
				err = writeJSONAtomic(proofPath, changed)
			case "wrong-receipt":
				changed.ReceiptSHA256 = strings.Repeat("0", 64)
				err = writeJSONAtomic(proofPath, changed)
			case "malformed":
				err = os.WriteFile(proofPath, []byte("{}\n"), 0600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if members, err := inspectOwnedProcesses(ctx, instanceState{}); !errors.Is(err, syscall.EPERM) || len(members) != 0 {
				t.Fatalf("unproved reaped coalition was accepted: %v, %v", members, err)
			}
			if fault != "missing" {
				before, _ := os.ReadFile(proofPath)
				if err := preserveTemporalProbeCompletion(ctx, scope); err == nil {
					t.Fatal("invalid existing completion was overwritten or accepted")
				}
				after, _ := os.ReadFile(proofPath)
				if !bytes.Equal(before, after) {
					t.Fatal("refused completion changed the owned evidence")
				}
			}
		})
	}
	if identity, err := processStartIdentity(peer.Process.Pid); err != nil || identity != peerIdentity {
		t.Fatal("probe or first-census cleanup affected the unrelated peer")
	}
	releaseLock(control)
	control = nil
	if err := stop(ctx); err != nil {
		t.Fatalf("first real Stop could not retire the proved probe: %v", err)
	}
	if scopes, err := readOwnedExecutionScopes(ctx); err != nil || len(scopes) != 0 {
		t.Fatalf("proved probe receipt survived Stop: %v, %v", scopes, err)
	}
	readCoalitionActiveTaskCount, scopedProcessIDs, executionProcessBSDInfo = oldCount, oldPIDs, oldBSD
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	defer reader.Close()
	writer.Close()
	stdin := os.Stdin
	os.Stdin = reader
	defer func() { os.Stdin = stdin }()
	if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "stdin", "unused"}, io.Discard, io.Discard); err != nil {
		t.Fatalf("normal admission after probe cleanup required manual recovery: %v", err)
	}
	if err := stop(ctx); err != nil {
		t.Fatal(err)
	}
	if after, err := os.ReadFile(proofPath); err != nil || !bytes.Equal(proof, after) {
		t.Fatal("Stop or restart replaced the probe's original completion proof")
	}
}
