//go:build darwin

package launcher

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
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

type sourceMigrationFixture struct {
	ctx     launchContext
	python  string
	state   string
	command *exec.Cmd
	done    chan error
}

func managedSourceMigrationFixture(t *testing.T, binary, python string, existing ...forwardUpdateFixture) sourceMigrationFixture {
	t.Helper()
	root, home := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	worker := `import os,pathlib,sqlite3,time
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
r=pathlib.Path(os.environ['JOBCTRL_DIR']); r.mkdir(parents=True,exist_ok=True)
if not (r/'jobctrl.db').exists():
 c=sqlite3.connect(r/'jobctrl.db'); create_exact_v14_schema(c)
 c.execute("insert into candidate_profiles (tenant_id,profile_id,personal_full_name,updated_at) values ('synthetic','default','before','t')")
 c.execute("insert into resume_templates (tenant_id,template_id,display_name,created_at,updated_at) values ('synthetic','default','before','t','t')"); c.commit(); c.close()
if not (r/'temporal.db').exists() and not (r/'temporal'/'temporal.db').exists():
 c=sqlite3.connect(r/'temporal.db'); c.execute('create table history(value text)'); c.execute("insert into history values ('before')"); c.commit(); c.close()
pathlib.Path(os.environ['TEST_WORKER_PID']).write_text(str(os.getpid()))
while True: time.sleep(1)`
	api := `import http.server,json,os,pathlib,socketserver
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  try: pid=int(pathlib.Path(os.environ['TEST_WORKER_PID']).read_text())
  except Exception: pid=0
  d=os.environ['JOBCTRL_DIR']; b=json.dumps({'ok':True,'appDir':d,'dbPath':str(pathlib.Path(d)/'jobctrl.db'),'worker':{'status':'healthy','heartbeat':{'pid':pid}}}).encode()
  self.send_response(200); self.end_headers(); self.wfile.write(b)
 def log_message(self,*args): pass
class Server(http.server.HTTPServer):
 def server_bind(self):
  # HTTPServer's reverse DNS lookup can hang on a hosted runner even after
  # binding the socket. This owned loopback fixture has no need for DNS.
  socketserver.TCPServer.server_bind(self)
  self.server_name,self.server_port='127.0.0.1',self.server_address[1]
Server(('127.0.0.1',int(os.environ['JOBCTRL_API_PORT'])),H).serve_forever()`
	history := `import os,pathlib,sqlite3,time
r=pathlib.Path(os.environ['JOBCTRL_DIR'])
while not (r/'temporal.db').exists() and not (r/'temporal'/'temporal.db').exists(): time.sleep(.05)
p=(r/'temporal'/'temporal.db') if (r/'temporal'/'temporal.db').exists() else (r/'temporal.db')
c=sqlite3.connect(p)
while True: time.sleep(1)`
	for name, content := range map[string]string{"worker.py": worker, "api.py": api, "history.py": history} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(content), 0600); err != nil {
			t.Fatal(err)
		}
	}
	script := `#!/bin/bash
"$TEST_PYTHON" "$TEST_ROOT/worker.py" & worker=$!
"$TEST_PYTHON" "$TEST_ROOT/api.py" & api=$!
"$TEST_PYTHON" "$TEST_ROOT/history.py" & temporal=$!
printf 'source-ready\n' >&3
exec 3>&-
trap 'kill "$worker" "$api" "$temporal" 2>/dev/null || :; wait; exit 0' TERM INT
while :; do sleep 1; done
`
	if err := os.WriteFile(filepath.Join(root, "scripts", "dev"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	workerDir := filepath.Join(root, "workers", "automation")
	if err := os.MkdirAll(workerDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(filepath.Dir(python)), filepath.Join(workerDir, ".venv")); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	state, runtimeHome := filepath.Join(home, "workspace"), filepath.Join(home, "runtime")
	if len(existing) != 0 {
		state, runtimeHome = existing[0].data, existing[0].home
		home = environmentMap(existing[0].env)["HOME"]
	}
	env := append(os.Environ(), "HOME="+home, "JOBCTRL_DIR="+state, "JOBCTRL_RUNTIME_HOME="+runtimeHome,
		"JOBCTRL_API_PORT="+fmt.Sprint(port), "JOBCTRL_API_HOST=127.0.0.1", "TEST_PYTHON="+python,
		"TEST_ROOT="+root, "TEST_WORKER_PID="+filepath.Join(root, "worker.pid"))
	inst, err := resolveInstance(env)
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: inst, Environment: env, SourcePython: python}
	logPath := filepath.Join(root, "source-fixture.log")
	logFile, err := os.Create(logPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = logFile.Close() })
	command := exec.Command(binary, "run", root)
	command.Stdout, command.Stderr = logFile, logFile
	command.Env = env
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	t.Cleanup(func() {
		_ = stop(ctx)
		_ = command.Process.Kill()
	})
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		markers, _ := filepath.Glob(filepath.Join(inst.Dir, "source-runs", "*.json"))
		if len(markers) > 0 {
			return sourceMigrationFixture{ctx, python, state, command, done}
		}
		select {
		case err := <-done:
			t.Fatalf("owned synthetic source exited: %v", err)
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	logSyntheticSourceDiagnostics(t, ctx, root, logPath)
	t.Fatal("owned synthetic source did not prove healthy readiness")
	return sourceMigrationFixture{}
}

// Log only fixture-owned state when readiness fails; this makes hosted failures
// actionable without exposing any real workspace or weakening ownership checks.
func logSyntheticSourceDiagnostics(t *testing.T, ctx launchContext, root string, logs ...string) {
	t.Helper()
	for _, path := range logs {
		contents, err := os.ReadFile(path)
		t.Logf("synthetic log %s: %s (read: %v)", path, contents, err)
	}
	workerData, workerErr := os.ReadFile(filepath.Join(root, "worker.pid"))
	worker, _ := strconv.Atoi(strings.TrimSpace(string(workerData)))
	state, stateErr := readState(ctx.Instance.StatePath)
	t.Logf("synthetic worker PID: %d (read: %v), source supervisor PID: %d (state: %v)", worker, workerErr, state.Supervisor.PID, stateErr)
	for _, pid := range []int{worker, state.Supervisor.PID} {
		if pid <= 0 {
			continue
		}
		identity, identityErr := processStartIdentity(pid)
		coalition, coalitionErr := processCoalitionIDs(pid)
		t.Logf("synthetic PID %d: identity %s (%v), coalition %v (%v)", pid, identity, identityErr, coalition, coalitionErr)
	}
	values := environmentMap(ctx.Environment)
	client := http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	response, err := client.Get("http://" + net.JoinHostPort("127.0.0.1", values["JOBCTRL_API_PORT"]) + "/v1/health")
	if err == nil {
		body, bodyErr := io.ReadAll(io.LimitReader(response.Body, 4096))
		response.Body.Close()
		t.Logf("synthetic health: status %d, body %s (read: %v)", response.StatusCode, body, bodyErr)
	} else {
		t.Logf("synthetic health: %v", err)
	}
	path, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		t.Logf("synthetic history path: %v", err)
		return
	}
	output, err := exec.Command("/usr/sbin/lsof", "-nP", "-Fp", path).CombinedOutput()
	t.Logf("synthetic history holders: %s (%v)", output, err)
}

func buildSourceFixture(t *testing.T) string {
	t.Helper()
	binary := filepath.Join(t.TempDir(), "jobctrl-source")
	build := exec.Command("go", "build", "-o", binary, "./cmd/jobctrl-source")
	build.Dir = filepath.Join("..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build source controller: %v\n%s", err, output)
	}
	return binary
}

func writeSyntheticLaterData(t *testing.T, f sourceMigrationFixture) {
	t.Helper()
	code := `import os,pathlib,sqlite3,sys
r=pathlib.Path(sys.argv[1]); c=sqlite3.connect(r/'jobctrl.db')
c.execute('pragma journal_mode=wal'); c.execute('pragma wal_autocheckpoint=0')
c.execute("update candidate_profiles set personal_full_name='after' where tenant_id='synthetic'")
c.execute("update resume_templates set display_name='after' where tenant_id='synthetic'"); c.commit()
d=sqlite3.connect(r/'temporal.db'); d.execute('pragma journal_mode=wal'); d.execute('pragma wal_autocheckpoint=0')
d.execute("update history set value='after'"); d.commit()
os._exit(0)`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", code, f.state).CombinedOutput(); err != nil {
		t.Fatalf("write synthetic later data: %v\n%s", err, output)
	}
	for _, name := range []string{"jobctrl.db-wal", "temporal.db-wal"} {
		if info, err := os.Stat(filepath.Join(f.state, name)); err != nil || info.Size() <= 32 {
			t.Fatalf("synthetic writer did not leave committed WAL data in %s: %v", name, err)
		}
	}
}

func assertSyntheticLaterData(t *testing.T, f sourceMigrationFixture) {
	t.Helper()
	code := `import pathlib,sqlite3,sys
from jobctrl.infrastructure.migrations.schema_manifest import EXACT_V15_MANIFEST,assert_exact_manifest
r=pathlib.Path(sys.argv[1]); c=sqlite3.connect(r/'jobctrl.db'); assert_exact_manifest(c,EXACT_V15_MANIFEST)
assert c.execute("select personal_full_name from candidate_profiles where tenant_id='synthetic'").fetchone()==('after',)
assert c.execute("select display_name from resume_templates where tenant_id='synthetic'").fetchone()==('after',)
assert c.execute('pragma integrity_check').fetchone()==('ok',); c.close()
c=sqlite3.connect(r/'temporal.db'); assert c.execute('select value from history').fetchone()==('after',); c.close()`
	if output, err := exec.Command(f.python, "-I", "-B", "-c", code, f.state).CombinedOutput(); err != nil {
		t.Fatalf("later synthetic data was not preserved: %v\n%s", err, output)
	}
}

func TestSourceMigrationPreservesLaterWritesAcrossEveryDurableBoundary(t *testing.T) {
	python, binary := migrationIntegrationPython(t), buildSourceFixture(t)
	for _, stage := range []string{"starting", "backed_up", "candidate_ready", "activating", "activated"} {
		t.Run(stage, func(t *testing.T) {
			f := managedSourceMigrationFixture(t, binary, python)
			sourceMigrationCheckpoint = func(current string) error {
				if current == stage {
					return errors.New("synthetic interruption")
				}
				return nil
			}
			t.Cleanup(func() { sourceMigrationCheckpoint = nil })
			if err := automaticSourceMigration(f.ctx, io.Discard); err == nil || !strings.Contains(err.Error(), "synthetic interruption") {
				t.Fatalf("expected interruption at %s, got %v", stage, err)
			}
			select {
			case <-f.done:
			case <-time.After(15 * time.Second):
				t.Fatal("source owner did not stop before backup")
			}
			if _, err := readSourceMigrationJournal(f.ctx); err != nil {
				t.Fatalf("interrupted source journal missing: %v", err)
			}
			writeSyntheticLaterData(t, f)
			sourceMigrationCheckpoint = nil
			if err := automaticSourceMigration(f.ctx, io.Discard); err != nil {
				t.Fatalf("resume source migration: %v", err)
			}
			assertSyntheticLaterData(t, f)
			if _, err := readSourceMigrationJournal(f.ctx); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("completed source journal remains: %v", err)
			}
		})
	}
}

func TestSourceMigrationProcessHelper(t *testing.T) {
	stage := os.Getenv("JOBCTRL_TEST_SOURCE_CRASH_STAGE")
	if stage == "" {
		return
	}
	env := os.Environ()
	inst, err := resolveInstance(env)
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: inst, Environment: env, SourcePython: os.Getenv("JOBCTRL_MIGRATION_TEST_PYTHON")}
	sourceMigrationCheckpoint = func(current string) error {
		if current == stage {
			os.Exit(74) // Simulate loss of the controller without running defers.
		}
		return nil
	}
	if err := automaticSourceMigration(ctx, io.Discard); err != nil {
		t.Fatal(err)
	}
	t.Fatal("requested interruption was not reached")
}

func TestSourceMigrationRecoversAfterControllerProcessLoss(t *testing.T) {
	python, binary := migrationIntegrationPython(t), buildSourceFixture(t)
	for _, stage := range []string{"backed_up", "activating", "activated"} {
		t.Run(stage, func(t *testing.T) {
			f := managedSourceMigrationFixture(t, binary, python)
			child := exec.Command(os.Args[0], "-test.run=^TestSourceMigrationProcessHelper$")
			child.Env = append(append([]string{}, f.ctx.Environment...), "JOBCTRL_MIGRATION_TEST_PYTHON="+python, "JOBCTRL_TEST_SOURCE_CRASH_STAGE="+stage)
			if output, err := child.CombinedOutput(); err == nil {
				t.Fatalf("controller did not exit at %s: %s", stage, output)
			} else if exited, ok := err.(*exec.ExitError); !ok || exited.ExitCode() != 74 {
				t.Fatalf("controller exited unexpectedly at %s: %v %s", stage, err, output)
			}
			select {
			case <-f.done:
			case <-time.After(15 * time.Second):
				t.Fatal("source owner did not stop before interruption")
			}
			writeSyntheticLaterData(t, f)
			if err := automaticSourceMigration(f.ctx, io.Discard); err != nil {
				t.Fatalf("retry after process loss: %v", err)
			}
			assertSyntheticLaterData(t, f)
		})
	}
}

func TestInterruptedSourceMigrationRefusesInstalledWriters(t *testing.T) {
	home := t.TempDir()
	env := []string{"HOME=" + home, "JOBCTRL_DIR=" + filepath.Join(home, "workspace"), "JOBCTRL_RUNTIME_HOME=" + filepath.Join(home, "runtime")}
	inst, err := resolveInstance(env)
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: inst, Environment: env}
	id, err := releaseRandomID()
	if err != nil {
		t.Fatal(err)
	}
	journal := sourceMigrationJournal{SchemaVersion: 1, ID: id, BackupID: "source-pair-" + id, SourceVersion: 14, Stage: "backed_up"}
	if err := writeSourceMigrationJournal(ctx, journal); err != nil {
		t.Fatal(err)
	}
	for name, run := range map[string]func() error{
		"start":     func() error { return executeStart(ctx, nil, io.Discard) },
		"backup":    func() error { return backup(ctx, nil, io.Discard) },
		"restore":   func() error { return restorePair(ctx, databasePair{}) },
		"selection": func() error { return CheckWorkspaceSelection(inst.RuntimeHome, home, env, true) },
	} {
		if err := run(); err == nil || !strings.Contains(err.Error(), "source workspace migration is unfinished") {
			t.Errorf("installed %s did not preserve the source journal: %v", name, err)
		}
	}
	if got, err := readSourceMigrationJournal(ctx); err != nil || got != journal {
		t.Fatalf("installed commands changed the source journal: %+v %v", got, err)
	}
}

func TestSourceMigrationPreservesUnverifiedAndUnsupportedPairs(t *testing.T) {
	python := migrationIntegrationPython(t)
	for _, version := range []int{13, 14, 16} {
		t.Run(fmt.Sprint(version), func(t *testing.T) {
			home := t.TempDir()
			env := []string{"HOME=" + home, "JOBCTRL_DIR=" + filepath.Join(home, "workspace"), "JOBCTRL_RUNTIME_HOME=" + filepath.Join(home, "runtime")}
			inst, err := resolveInstance(env)
			if err != nil {
				t.Fatal(err)
			}
			ctx := launchContext{Instance: inst, Environment: env, SourcePython: python}
			code := `import pathlib,sqlite3,sys
r=pathlib.Path(sys.argv[1]); (r/'temporal').mkdir()
c=sqlite3.connect(r/'jobctrl.db'); c.execute('create table sentinel(value text)'); c.execute("insert into sentinel values ('preserve')"); c.execute('pragma user_version='+sys.argv[2]); c.commit(); c.close()
c=sqlite3.connect(r/'temporal'/'temporal.db'); c.execute('create table sentinel(value text)'); c.execute("insert into sentinel values ('history')"); c.commit(); c.close()`
			if output, err := exec.Command(python, "-I", "-B", "-c", code, inst.StateDir, fmt.Sprint(version)).CombinedOutput(); err != nil {
				t.Fatalf("seed synthetic pair: %v %s", err, output)
			}
			database, history := filepath.Join(inst.StateDir, "jobctrl.db"), filepath.Join(inst.StateDir, "temporal", "temporal.db")
			beforeDB, _ := sha256Path(database)
			beforeHistory, _ := sha256Path(history)
			var messages strings.Builder
			if err := automaticSourceMigration(ctx, &messages); err != nil {
				t.Fatalf("diagnostic-only admission: %v", err)
			}
			if version == 14 && !strings.Contains(messages.String(), "ownership is unverified") {
				t.Fatalf("missing ownership diagnostic: %q", messages.String())
			}
			afterDB, _ := sha256Path(database)
			afterHistory, _ := sha256Path(history)
			if beforeDB != afterDB || beforeHistory != afterHistory {
				t.Fatal("refused migration changed the synthetic workspace")
			}
			if _, err := readSourceMigrationJournal(ctx); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("refused migration wrote a journal: %v", err)
			}
		})
	}
}

func TestInstalledStartupExplainsDatabaseVersionMismatch(t *testing.T) {
	python := migrationIntegrationPython(t)
	root, payload := t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(payload, "python", "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(python, filepath.Join(payload, "python", "bin", "python3")); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{PayloadRoot: payload, Instance: instance{StateDir: root}}
	if err := checkStartSchemaVersion(ctx); err != nil {
		t.Fatalf("new workspace was refused: %v", err)
	}
	for _, test := range []struct {
		version int
		message string
	}{{14, "needs an upgrade"}, {15, ""}, {16, "newer JobCtrl build"}} {
		code := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute('pragma user_version='+sys.argv[2]); c.close()`
		if output, err := exec.Command(python, "-I", "-B", "-c", code, filepath.Join(root, "jobctrl.db"), fmt.Sprint(test.version)).CombinedOutput(); err != nil {
			t.Fatalf("seed schema version: %v %s", err, output)
		}
		err := checkStartSchemaVersion(ctx)
		if test.message == "" && err != nil || test.message != "" && (err == nil || !strings.Contains(err.Error(), test.message)) {
			t.Fatalf("schema %d startup message: %v", test.version, err)
		}
	}
}

func TestInstalledForwardUpdateUsesOwnedLegacySourceHistory(t *testing.T) {
	f := newForwardUpdateFixture(t)
	legacyDir := filepath.Join(f.data, "temporal")
	if err := os.Mkdir(legacyDir, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(legacyDir, "temporal.db")
	if err := os.Rename(filepath.Join(f.data, "temporal.db"), legacy); err != nil {
		t.Fatal(err)
	}
	owner := managedSourceMigrationFixture(t, buildSourceFixture(t), f.python, f)
	if _, err := snapshotPair(f.ctx, f.old.receipt); err == nil || !strings.Contains(err.Error(), "databases may be open") {
		t.Fatalf("legacy history was backed up while its source owner was active: %v", err)
	}
	var statusOutput strings.Builder
	if err := status(f.ctx, &statusOutput, false); err != nil || !strings.Contains(statusOutput.String(), "source supervisor running") {
		t.Fatalf("installed status did not identify the source fleet: %q %v", statusOutput.String(), err)
	}
	statusOutput.Reset()
	if err := status(f.ctx, &statusOutput, true); err != nil || !strings.Contains(statusOutput.String(), `"status":"source-running"`) || !strings.Contains(statusOutput.String(), `"components":{}`) {
		t.Fatalf("installed JSON status misreported source components: %q %v", statusOutput.String(), err)
	}
	if err := backup(f.ctx, nil, io.Discard); err == nil || !strings.Contains(err.Error(), "stop the source development stack") {
		t.Fatalf("installed backup did not preserve the running source fleet: %v", err)
	}
	active, err := f.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	if err := rollbackExisting(f.ctx, f.store, active, f.candidate.buildID, io.Discard); err == nil || !strings.Contains(err.Error(), "paired rollback is unavailable") {
		t.Fatalf("installed rollback did not preserve legacy source history: %v", err)
	}
	if _, err := f.store.ReadJournal(); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("refused backup or rollback created an update journal: %v", err)
	}
	select {
	case err := <-owner.done:
		t.Fatalf("installed backup stopped the source fleet: %v", err)
	default:
	}
	previous := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previous })
	startReleaseCommand = func(ctx launchContext, receipt release.Receipt, _ string) error {
		if receipt != f.candidate.receipt {
			t.Fatal("update started the wrong candidate")
		}
		if history, err := temporalHistoryPath(ctx.Instance.StateDir); err != nil || !sourcePathMatches(history, legacy) {
			t.Fatalf("candidate did not select source history: %s %v", history, err)
		}
		return nil // Readiness is covered by the native launcher integration lane.
	}
	// A separately owned writer must not be mistaken for part of the stopped
	// source scope. Its acknowledged history update must survive the retry.
	ready := filepath.Join(t.TempDir(), "foreign-ready")
	foreignCode := `import pathlib,sqlite3,sys,time
c=sqlite3.connect(sys.argv[1]); c.execute("update t set v='foreign-later'"); c.commit()
pathlib.Path(sys.argv[2]).write_text('ready')
while True: time.sleep(1)`
	foreign := exec.Command(f.python, "-I", "-B", "-c", foreignCode, legacy, ready)
	if err := foreign.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = foreign.Process.Kill(); _ = foreign.Wait() })
	for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(50 * time.Millisecond) {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("synthetic foreign history writer did not start")
		}
	}
	if err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard); err == nil || !strings.Contains(err.Error(), "databases may be open") {
		t.Fatalf("installed update did not refuse the foreign history writer: %v", err)
	}
	select {
	case <-owner.done:
	case <-time.After(15 * time.Second):
		t.Fatal("installed update did not stop the source owner")
	}
	if err := foreign.Process.Signal(syscall.Signal(0)); err != nil {
		t.Fatalf("installed update stopped the foreign writer: %v", err)
	}
	if err := foreign.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := foreign.Wait(); err == nil {
		t.Fatal("synthetic foreign writer did not stop")
	}
	if err := PromoteStagedRelease(f.home, f.candidate.buildID, "homebrew", f.env, io.Discard); err != nil {
		t.Fatalf("retry installed forward update after foreign writer stopped: %v", err)
	}
	if err := refuseBackupOfRunningSource(f.ctx); err != nil {
		t.Fatalf("stopped source fleet still blocks installed backup: %v", err)
	}
	if version, err := sqliteUserVersion(f.python, filepath.Join(f.data, "jobctrl.db")); err != nil || version != 15 {
		t.Fatalf("installed update did not activate schema 15: %d %v", version, err)
	}
	journal, err := f.store.ReadJournal()
	if err != nil || journal.BackupID == "" {
		t.Fatalf("installed update did not record its pair: %+v %v", journal, err)
	}
	code := `import sqlite3,sys
for path in sys.argv[1:]:
 c=sqlite3.connect(path); assert c.execute('select v from t').fetchone()==('foreign-later',); c.close()`
	backup := filepath.Join(f.data, "backups", journal.BackupID, "temporal.db")
	if output, err := exec.Command(f.python, "-I", "-B", "-c", code, legacy, backup).CombinedOutput(); err != nil {
		t.Fatalf("installed update lost source history: %v %s", err, output)
	}
	if _, err := os.Lstat(filepath.Join(f.data, "temporal.db")); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("installed update created a separate Temporal history")
	}
}
