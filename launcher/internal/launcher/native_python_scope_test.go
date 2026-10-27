//go:build darwin

package launcher

import (
	"bytes"
	"encoding/json"
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

// This unsigned synthetic payload proves the actual native Run/launchd/helper/
// dispatchPython/CPython mechanism. It does not qualify a signed distribution.
func TestNativePythonDispatchOwnedScopeLoopbackSandbox(t *testing.T) {
	python := migrationIntegrationPython(t)
	payload, manifest := verifiedPayloadFixture(t)
	home, venv := t.TempDir(), filepath.Join(t.TempDir(), "venv")
	environment := []string{"HOME=" + home, "JOBCTRL_DIR=" + filepath.Join(home, "data"), "JOBCTRL_RUNTIME_HOME=" + filepath.Join(home, "runtime"), "PATH=/usr/bin:/bin", executionQASandboxVariable + "=" + executionQASandboxSelector}
	create := exec.Command(python, "-I", "-B", "-m", "venv", "--without-pip", venv)
	create.Env = environment
	if output, err := create.CombinedOutput(); err != nil {
		t.Fatalf("create owned CPython venv: %v\n%s", err, output)
	}
	venvPython := filepath.Join(venv, "bin", "python3")
	locate := exec.Command(venvPython, "-I", "-B", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))")
	locate.Env = environment
	output, err := locate.Output()
	if err != nil {
		t.Fatal(err)
	}
	site := strings.TrimSpace(string(output))
	relative, err := filepath.Rel(venv, site)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		t.Fatal("venv site-packages escaped owned root")
	}
	module := filepath.Join(site, "jobctrl")
	if err = os.MkdirAll(module, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(module, "__init__.py"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	probe := `import errno,json,socket,sys
assert sys.argv[1] == "network-permission-probe"
host,port=sys.argv[2].rsplit(":",1)
with socket.create_connection((host,int(port)),timeout=2): pass
with socket.socket(socket.AF_INET,socket.SOCK_STREAM) as remote:
 remote.setblocking(False)
 denied=remote.connect_ex(("192.0.2.1",9))
assert denied == errno.EPERM, denied
print(json.dumps({"loopback":True,"nonloopbackErrno":denied,"interpreter":sys.implementation.name,"command":sys.argv[1]}))
`
	if err = os.WriteFile(filepath.Join(module, "__main__.py"), []byte(probe), 0600); err != nil {
		t.Fatal(err)
	}
	launcher := filepath.Join(payload, "launcher", "jobctrl")
	moduleRoot := filepath.Clean(filepath.Join("..", ".."))
	build := exec.Command("go", "build", "-o", launcher, "./cmd/jobctrl")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build actual native launcher: %v\n%s", err, output)
	}
	adapterSource := filepath.Join(t.TempDir(), "owned-python-adapter.go")
	adapter := fmt.Sprintf("package main\nimport (\"os\";\"syscall\")\nfunc main(){const python=%q;args:=append([]string{python},os.Args[1:]...);if syscall.Exec(python,args,os.Environ())!=nil{os.Exit(111)}}\n", venvPython)
	if err = os.WriteFile(adapterSource, []byte(adapter), 0600); err != nil {
		t.Fatal(err)
	}
	adapterTarget := filepath.Join(payload, "python", "bin", "python3")
	if err = os.MkdirAll(filepath.Dir(adapterTarget), 0755); err != nil {
		t.Fatal(err)
	}
	build = exec.Command("go", "build", "-o", adapterTarget, adapterSource)
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build regular inventoried CPython adapter: %v\n%s", err, output)
	}
	if err = os.WriteFile(filepath.Join(payload, "launcher", "runtime-manifest.json"), []byte(validRuntimeManifest), 0644); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, payload, &manifest)
	writeLocalEnvelope(t, payload, manifest)
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
	command := exec.Command(launcher, "network-permission-probe", listener.Addr().String())
	command.Env = environment
	command.Dir = home
	var stdout, stderr bytes.Buffer
	command.Stdout = &stdout
	command.Stderr = &stderr
	if err = command.Run(); err != nil {
		t.Fatalf("actual native-to-CPython network dispatch: %v\n%s", err, stderr.String())
	}
	var result struct {
		Loopback         bool   `json:"loopback"`
		NonloopbackErrno int    `json:"nonloopbackErrno"`
		Interpreter      string `json:"interpreter"`
		Command          string `json:"command"`
	}
	if err = json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatalf("CPython result: %v %s", err, stdout.String())
	}
	if !result.Loopback || result.NonloopbackErrno != int(syscall.EPERM) || result.Interpreter != "cpython" || result.Command != "network-permission-probe" {
		t.Fatalf("unexpected CPython socket proof: %+v", result)
	}
	select {
	case err := <-accepted:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("actual CPython loopback connection was not observed")
	}
	ctx, err := prepare(launcher, environment)
	if err != nil {
		t.Fatal(err)
	}
	defer ctx.selection.Close()
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		t.Fatalf("Python scope was not published: %v (%d receipts)", err, len(scopes))
	}
	stop := exec.Command(launcher, "stop")
	stop.Env = environment
	stop.Dir = home
	if output, err := stop.CombinedOutput(); err != nil {
		t.Fatalf("actual native stop after CPython exit: %v\n%s", err, output)
	}
	if scopes, err = readOwnedExecutionScopes(ctx); err != nil || len(scopes) != 0 {
		t.Fatalf("actual native stop did not retire Python scope: %v (%d receipts)", err, len(scopes))
	}
}
