//go:build darwin

package launcher

import (
	"fmt"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestSourceRuntimeSharesNativeOwnershipAndStopsOnlyItsWorkspace(t *testing.T) {
	binary := filepath.Join(t.TempDir(), "jobctrl-source")
	build := exec.Command("go", "build", "-o", binary, "./cmd/jobctrl-source")
	build.Dir = filepath.Join("..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build source controller: %v\n%s", err, output)
	}
	runtimeHome := filepath.Join(t.TempDir(), "runtime")
	type source struct {
		ctx     launchContext
		command *exec.Cmd
		done    chan error
	}
	start := func() source {
		root, home := t.TempDir(), t.TempDir()
		if err := os.Mkdir(filepath.Join(root, "scripts"), 0700); err != nil {
			t.Fatal(err)
		}
		script := "#!/bin/bash\nprintf started > \"$TEST_SOURCE_READY\"\ntrap 'exit 0' TERM INT\nwhile :; do sleep 0.1; done\n"
		if err := os.WriteFile(filepath.Join(root, "scripts", "dev"), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
		state, ready := filepath.Join(home, "workspace"), filepath.Join(home, "ready")
		env := append(os.Environ(), "HOME="+home, "JOBCTRL_DIR="+state, "JOBCTRL_RUNTIME_HOME="+runtimeHome, "TEST_SOURCE_READY="+ready)
		inst, err := resolveInstance(env)
		if err != nil {
			t.Fatal(err)
		}
		ctx := launchContext{Executable: binary, Instance: inst, Environment: env}
		command := exec.Command(binary, "run", root)
		command.Env = env
		command.Stdout, command.Stderr = os.Stdout, os.Stderr
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- command.Wait() }()
		deadline := time.Now().Add(20 * time.Second)
		for time.Now().Before(deadline) {
			if _, err := os.Stat(ready); err == nil {
				return source{ctx, command, done}
			}
			select {
			case err := <-done:
				t.Fatalf("source exited before readiness: %v", err)
			default:
			}
			time.Sleep(50 * time.Millisecond)
		}
		_ = command.Process.Kill()
		t.Fatal("source did not become ready")
		return source{}
	}
	first, peer := start(), start()
	t.Cleanup(func() {
		_ = stop(first.ctx)
		_ = stop(peer.ctx)
		_ = first.command.Process.Kill()
		_ = peer.command.Process.Kill()
	})
	state, err := readState(first.ctx.Instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	badSwitch := exec.Command(binary, "switch", state.PayloadRoot)
	badSwitch.Env = append(append([]string{}, first.ctx.Environment...), "TEMPORAL_ADDRESS=localhost:9999")
	if output, err := badSwitch.CombinedOutput(); err == nil || !strings.Contains(string(output), "requires the local Temporal server") {
		t.Fatalf("invalid switch did not refuse before stopping: %v %s", err, output)
	}
	select {
	case err := <-first.done:
		t.Fatalf("invalid switch stopped the source fleet: %v", err)
	default:
	}
	if lock, err := acquireLock(first.ctx.Instance.LockPath, true); err == nil {
		releaseLock(lock)
		t.Fatal("source did not reserve the installed instance lock")
	}
	lockPath := filepath.Join(runtimeHome, "selection.lock")
	selection, err := os.OpenFile(lockPath, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err = syscall.Flock(int(selection.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		selection.Close()
		t.Fatalf("source retained selection lock after admission: %v", err)
	}
	_ = syscall.Flock(int(selection.Fd()), syscall.LOCK_UN)
	_ = selection.Close()
	if err := stop(first.ctx); err != nil {
		t.Fatalf("native stop could not drain source: %v", err)
	}
	select {
	case err := <-first.done:
		if err != nil && !strings.Contains(err.Error(), "signal: terminated") {
			t.Fatalf("stopped source returned unexpected error: %v", err)
		}
	case <-time.After(15 * time.Second):
		t.Fatal("source remained alive after native stop")
	}
	select {
	case err := <-peer.done:
		t.Fatalf("stopping one workspace stopped another: %v", err)
	default:
	}
	if err := stop(peer.ctx); err != nil {
		t.Fatalf("stop peer: %v", err)
	}
	select {
	case <-peer.done:
	case <-time.After(15 * time.Second):
		t.Fatal("peer remained alive after native stop")
	}
}

func TestSourceWorkspaceRequiresTheSameDatabaseAndTemporalServer(t *testing.T) {
	home := t.TempDir()
	state := filepath.Join(home, "workspace")
	inst, err := resolveInstance([]string{"HOME=" + home, "JOBCTRL_DIR=" + state, "JOBCTRL_RUNTIME_HOME=" + filepath.Join(home, "runtime")})
	if err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		name string
		env  []string
		ok   bool
	}{
		{"defaults", nil, true},
		{"same paths", []string{"JOBCTRL_DB_PATH=" + filepath.Join(state, "jobctrl.db"), "JOBCTRL_TEMPORAL_DB=" + filepath.Join(state, "temporal.db"), "TEMPORAL_ADDRESS=127.0.0.1:7233", "TEMPORAL_NAMESPACE=default"}, true},
		{"other database", []string{"JOBCTRL_DB_PATH=" + filepath.Join(home, "other.db")}, false},
		{"other history", []string{"JOBCTRL_TEMPORAL_DB=" + filepath.Join(home, "other.db")}, false},
		{"other server", []string{"TEMPORAL_ADDRESS=localhost:9999"}, false},
		{"other namespace", []string{"TEMPORAL_NAMESPACE=other"}, false},
	} {
		t.Run(test.name, func(t *testing.T) {
			err := validateSourceWorkspacePaths(launchContext{Instance: inst, Environment: test.env})
			if (err == nil) != test.ok {
				t.Fatalf("workspace binding returned %v, want admitted=%v", err, test.ok)
			}
		})
	}
}

func TestSourceTemporalWitnessRequiresAnotherScopedHistoryHolder(t *testing.T) {
	python, root := migrationIntegrationPython(t), t.TempDir()
	path := filepath.Join(root, "temporal.db")
	scope, err := processCoalitionIDs(os.Getpid())
	if err != nil {
		t.Fatal(err)
	}
	startHolder := func(name string) *exec.Cmd {
		ready := filepath.Join(root, name+"-ready")
		code := `import pathlib,sqlite3,sys,time
c=sqlite3.connect(sys.argv[1]); pathlib.Path(sys.argv[2]).write_text('ready')
while True: time.sleep(1)`
		cmd := exec.Command(python, "-I", "-B", "-c", code, path, ready)
		if err := cmd.Start(); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill(); _ = cmd.Wait() })
		for deadline := time.Now().Add(10 * time.Second); ; time.Sleep(50 * time.Millisecond) {
			if _, err := os.Stat(ready); err == nil {
				return cmd
			}
			if time.Now().After(deadline) {
				t.Fatal("synthetic history holder did not start")
			}
		}
	}
	worker := startHolder("worker")
	ctx := launchContext{Instance: instance{StateDir: root}}
	if sourceTemporalHistoryReady(ctx, worker.Process.Pid, scope) {
		t.Fatal("a worker holding the file alone established Temporal ownership")
	}
	history := startHolder("history")
	if !sourceTemporalHistoryReady(ctx, worker.Process.Pid, scope) {
		t.Fatal("a separate scoped history holder was not detected")
	}
	if err := history.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = history.Wait()
	if sourceTemporalHistoryReady(ctx, worker.Process.Pid, scope) {
		t.Fatal("an exited history holder still established Temporal ownership")
	}
}

func TestDevelopmentEntryAutomaticallyMigratesOwnedWorkspace(t *testing.T) {
	python := migrationIntegrationPython(t)
	root, home := t.TempDir(), t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	scriptBytes, err := os.ReadFile(filepath.Join(moduleRoot, "..", "scripts", "dev"))
	if err != nil {
		t.Fatal(err)
	}
	dev := filepath.Join(root, "scripts", "dev")
	if err := os.WriteFile(dev, scriptBytes, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moduleRoot, filepath.Join(root, "launcher")); err != nil {
		t.Fatal(err)
	}
	workerDir := filepath.Join(root, "workers", "automation")
	if err := os.MkdirAll(workerDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Dir(filepath.Dir(python)), filepath.Join(workerDir, ".venv")); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	state := filepath.Join(home, "workspace")
	if err := os.MkdirAll(filepath.Join(state, "temporal"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(state, "temporal", "temporal.db"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	workerCode := `import os,pathlib,sqlite3,time
from jobctrl.infrastructure.migrations.schema_v14 import create_exact_v14_schema
root=pathlib.Path(os.environ['JOBCTRL_DIR']); root.mkdir(parents=True,exist_ok=True)
p=root/'jobctrl.db'
if not p.exists():
 c=sqlite3.connect(p); create_exact_v14_schema(c)
 c.execute("insert into candidate_profiles (tenant_id,profile_id,personal_full_name,updated_at) values ('synthetic','default','owned-profile','t')")
 c.execute("insert into resume_templates (tenant_id,template_id,display_name,created_at,updated_at) values ('synthetic','owned','owned-resume','t','t')")
 c.commit(); c.close()
pathlib.Path(os.environ['TEST_WORKER_PID']).write_text(str(os.getpid()))
while True: time.sleep(1)`
	temporalCode := `import os,pathlib,sqlite3,time
p=pathlib.Path(os.environ['JOBCTRL_TEMPORAL_DB']); p.parent.mkdir(parents=True,exist_ok=True)
c=sqlite3.connect(p); c.execute('create table if not exists history(value text)')
if not c.execute('select count(*) from history').fetchone()[0]: c.execute("insert into history values ('owned-history')")
c.commit()
while True: time.sleep(1)`
	apiCode := `import http.server,json,os,pathlib,socketserver
class H(http.server.BaseHTTPRequestHandler):
 def do_GET(self):
  try: pid=int(pathlib.Path(os.environ['TEST_WORKER_PID']).read_text())
  except Exception: pid=0
  d=os.environ['JOBCTRL_DIR']; body=json.dumps({'ok':True,'appDir':d,'dbPath':str(pathlib.Path(d)/'jobctrl.db'),'worker':{'status':'healthy','heartbeat':{'pid':pid}}}).encode()
  self.send_response(200); self.send_header('Content-Type','application/json'); self.end_headers(); self.wfile.write(body)
 def log_message(self,*args): pass
class Server(http.server.HTTPServer):
 def server_bind(self):
  # HTTPServer's reverse DNS lookup can hang on a hosted runner even after
  # binding the socket. This owned loopback fixture has no need for DNS.
  socketserver.TCPServer.server_bind(self)
  self.server_name,self.server_port='127.0.0.1',self.server_address[1]
Server(('127.0.0.1',int(os.environ['JOBCTRL_API_PORT'])),H).serve_forever()`
	for name, contents := range map[string]string{"worker.py": workerCode, "temporal.py": temporalCode, "api.py": apiCode} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(contents), 0600); err != nil {
			t.Fatal(err)
		}
	}
	for name, target := range map[string]string{"uv": "worker.py", "temporal": "temporal.py", "pnpm": "api.py"} {
		content := "#!/bin/bash\nexec \"$TEST_PYTHON\" \"$TEST_ROOT/" + target + "\"\n"
		if err := os.WriteFile(filepath.Join(bin, name), []byte(content), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(bin, "curl"), []byte("#!/bin/bash\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := listener.Addr().(*net.TCPAddr).Port
	listener.Close()
	runtimeHome := filepath.Join(home, "runtime")
	env := append(os.Environ(), "HOME="+home, "JOBCTRL_DIR="+state, "JOBCTRL_RUNTIME_HOME="+runtimeHome,
		"JOBCTRL_DEV_DIR="+filepath.Join(root, "dev"), "JOBCTRL_USER_ENV_PATH="+filepath.Join(home, "missing.env"),
		"TEST_ROOT="+root, "TEST_PYTHON="+python, "TEST_WORKER_PID="+filepath.Join(root, "worker.pid"),
		"JOBCTRL_API_PORT="+fmt.Sprint(port), "JOBCTRL_DEV_INNER=", "JOBCTRL_TEMPORAL_DB="+filepath.Join(state, "temporal", "temporal.db"), "PATH="+bin+":"+os.Getenv("PATH"))
	inst, err := resolveInstance(env)
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: inst, Environment: env}
	start := func() (*exec.Cmd, <-chan error) {
		command := exec.Command(dev, "run", "temporal", "api", "worker")
		command.Env, command.Stdout, command.Stderr = env, os.Stdout, os.Stderr
		if err := command.Start(); err != nil {
			t.Fatal(err)
		}
		done := make(chan error, 1)
		go func() { done <- command.Wait() }()
		return command, done
	}
	first, firstDone := start()
	var second *exec.Cmd
	t.Cleanup(func() {
		_ = stop(ctx)
		_ = first.Process.Kill()
		if second != nil {
			_ = second.Process.Kill()
		}
	})
	markerPattern := filepath.Join(inst.Dir, "source-runs", "*.json")
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		markers, _ := filepath.Glob(markerPattern)
		if len(markers) > 0 {
			break
		}
		select {
		case err := <-firstDone:
			t.Fatalf("first source runtime exited: %v", err)
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	markers, _ := filepath.Glob(markerPattern)
	if len(markers) != 1 {
		logSyntheticSourceDiagnostics(t, ctx, root,
			filepath.Join(root, "dev", "logs", "worker.log"),
			filepath.Join(root, "dev", "logs", "api.log"),
			filepath.Join(root, "dev", "logs", "temporal.log"))
		t.Fatal("source did not establish its own healthy worker receipt")
	}
	if version, err := sqliteUserVersion(python, filepath.Join(state, "jobctrl.db")); err != nil || version != 14 {
		t.Fatalf("synthetic source schema = %d, %v", version, err)
	}
	second, secondDone := start()
	select {
	case <-firstDone:
	case <-time.After(30 * time.Second):
		t.Fatal("migration did not stop the old scoped source runtime")
	}
	deadline = time.Now().Add(40 * time.Second)
	for time.Now().Before(deadline) {
		if version, err := sqliteUserVersion(python, filepath.Join(state, "jobctrl.db")); err == nil && version == 15 {
			break
		}
		select {
		case err := <-secondDone:
			t.Fatalf("migration runtime exited: %v", err)
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	if version, err := sqliteUserVersion(python, filepath.Join(state, "jobctrl.db")); err != nil || version != 15 {
		t.Fatalf("automatic source migration schema = %d, %v", version, err)
	}
	backups, err := filepath.Glob(filepath.Join(state, "backups", "source-pair-*", "source-pair.json"))
	if err != nil || len(backups) != 1 {
		t.Fatalf("source paired backup = %v, %v", backups, err)
	}
	check := `import pathlib,sqlite3,sys
r=pathlib.Path(sys.argv[1]); b=pathlib.Path(sys.argv[2]).parent
c=sqlite3.connect(r/'jobctrl.db')
assert c.execute("select personal_full_name from candidate_profiles where tenant_id='synthetic'").fetchone()==('owned-profile',)
assert c.execute("select display_name from resume_templates where tenant_id='synthetic' and template_id='owned'").fetchone()==('owned-resume',)
assert c.execute('pragma integrity_check').fetchone()==('ok',); c.close()
c=sqlite3.connect(b/'jobctrl.db'); assert c.execute('pragma user_version').fetchone()==(14,); c.close()
c=sqlite3.connect(b/'temporal.db'); assert c.execute('select value from history').fetchone()==('owned-history',); c.close()`
	if output, err := exec.Command(python, "-I", "-B", "-c", check, state, backups[0]).CombinedOutput(); err != nil {
		t.Fatalf("source migration did not preserve synthetic data: %v\n%s", err, output)
	}
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		markers, _ = filepath.Glob(markerPattern)
		if len(markers) >= 2 {
			break
		}
		select {
		case err := <-secondDone:
			t.Fatalf("migrated source exited before readiness: %v", err)
		default:
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(markers) < 2 {
		t.Fatal("migrated source did not become healthy")
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("stop migrated source: %v", err)
	}
	select {
	case <-secondDone:
	case <-time.After(15 * time.Second):
		t.Fatal("migrated source remained alive")
	}
	payload := t.TempDir()
	if err := os.Symlink(filepath.Dir(filepath.Dir(python)), filepath.Join(payload, "python")); err != nil {
		t.Fatal(err)
	}
	ctx.PayloadRoot = payload
	pair, err := snapshotPair(ctx, lifecycleReceipt("local-build-0000001", "curl", 1))
	if err != nil {
		t.Fatalf("installed paired backup did not use the managed source history: %v", err)
	}
	checkHistory := `import sqlite3,sys
c=sqlite3.connect(sys.argv[1]); assert c.execute('select value from history').fetchone()==('owned-history',); c.close()`
	if output, err := exec.Command(python, "-I", "-B", "-c", checkHistory, filepath.Join(state, "backups", pair.ID, "temporal.db")).CombinedOutput(); err != nil {
		t.Fatalf("installed backup did not preserve the source history: %v\n%s", err, output)
	}
	// Exercise the supported detached entry point against the same workspace.
	// Its writers must remain inside the native scope after the command exits.
	detached := exec.Command(dev, "start", "temporal", "api", "worker")
	detached.Env = env
	if output, err := detached.CombinedOutput(); err != nil {
		t.Fatalf("start detached source: %v\n%s", err, output)
	}
	deadline = time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		markers, _ = filepath.Glob(markerPattern)
		if len(markers) >= 3 {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if len(markers) < 3 {
		t.Fatal("detached source did not establish a healthy owned fleet")
	}
	if lock, err := acquireLock(inst.LockPath, true); err == nil {
		releaseLock(lock)
		t.Fatal("detached source did not retain native workspace ownership")
	}
	stopDetached := exec.Command(dev, "stop", "temporal", "api", "worker")
	stopDetached.Env = env
	if output, err := stopDetached.CombinedOutput(); err != nil {
		t.Fatalf("stop detached source: %v\n%s", err, output)
	}
	if lock, err := acquireLock(inst.LockPath, true); err != nil {
		t.Fatalf("detached source retained ownership after stop: %v", err)
	} else {
		releaseLock(lock)
	}
}

func TestDevelopmentEntryPointUsesNativeWorkspaceScope(t *testing.T) {
	root, home := t.TempDir(), t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	moduleRoot, err := filepath.Abs(filepath.Join("..", ".."))
	if err != nil {
		t.Fatal(err)
	}
	scriptBytes, err := os.ReadFile(filepath.Join(moduleRoot, "..", "scripts", "dev"))
	if err != nil {
		t.Fatal(err)
	}
	dev := filepath.Join(root, "scripts", "dev")
	if err := os.WriteFile(dev, scriptBytes, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moduleRoot, filepath.Join(root, "launcher")); err != nil {
		t.Fatal(err)
	}
	bin := filepath.Join(root, "bin")
	if err := os.Mkdir(bin, 0700); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(root, "ready")
	for name, contents := range map[string]string{
		"pnpm": "#!/bin/bash\nprintf started > \"$TEST_SOURCE_READY\"\ntrap 'exit 0' TERM INT\nwhile :; do sleep 0.1; done\n",
		"curl": "#!/bin/bash\nexit 1\n",
	} {
		if err := os.WriteFile(filepath.Join(bin, name), []byte(contents), 0700); err != nil {
			t.Fatal(err)
		}
	}
	state := filepath.Join(home, "workspace")
	env := append(os.Environ(), "HOME="+home, "JOBCTRL_DIR="+state,
		"JOBCTRL_RUNTIME_HOME="+filepath.Join(home, "runtime"), "JOBCTRL_DEV_DIR="+filepath.Join(root, "dev"),
		"JOBCTRL_USER_ENV_PATH="+filepath.Join(home, "missing.env"), "TEST_SOURCE_READY="+ready,
		"PATH="+bin+":"+os.Getenv("PATH"), "JOBCTRL_API_PORT=0", "JOBCTRL_DEV_INNER=")
	inst, err := resolveInstance(env)
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: inst, Environment: env}
	spoofed := exec.Command(dev, "run", "api")
	spoofed.Env = append(append([]string{}, env...), "JOBCTRL_DEV_INNER=1")
	if output, err := spoofed.CombinedOutput(); err == nil || !strings.Contains(string(output), "authenticated workspace execution scope") {
		t.Fatalf("an environment flag bypassed source ownership: %v %s", err, output)
	}
	if _, err := os.Stat(ready); !os.IsNotExist(err) {
		t.Fatal("unowned source API started")
	}
	command := exec.Command(dev, "run", "api")
	command.Env = env
	command.Stdout, command.Stderr = os.Stdout, os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- command.Wait() }()
	t.Cleanup(func() { _ = stop(ctx); _ = command.Process.Kill() })
	deadline := time.Now().Add(25 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		select {
		case err := <-done:
			t.Fatalf("development entry exited before readiness: %v", err)
		default:
		}
		time.Sleep(50 * time.Millisecond)
	}
	if _, err := os.Stat(ready); err != nil {
		t.Fatal("development entry did not become ready")
	}
	if lock, err := acquireLock(inst.LockPath, true); err == nil {
		releaseLock(lock)
		t.Fatal("development entry did not claim the shared instance lock")
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("native stop did not drain development entry: %v", err)
	}
	select {
	case <-done:
	case <-time.After(15 * time.Second):
		t.Fatal("development entry remained alive after native stop")
	}
}
