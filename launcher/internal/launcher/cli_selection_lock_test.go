package launcher

import (
	"bytes"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// The child executes the real native-to-Python dispatch. Its synthetic Python
// executable waits for the parent so the real backup can race the command.
func TestInstalledCLILockSurvivesExecAndFencesBackup(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	if os.Getenv("JOBCTRL_TEST_CLI_LOCK_HELPER") == "1" {
		store, err := release.Open(os.Getenv("JOBCTRL_TEST_CLI_LOCK_RUNTIME"))
		if err != nil {
			t.Fatal(err)
		}
		var lock *release.Lock
		if os.Getenv("JOBCTRL_TEST_CLI_DIRECT") != "1" {
			lock, err = store.SelectionLock(false)
			if err != nil {
				t.Fatal(err)
			}
		}
		defer lock.Close()
		ctx := launchContext{
			PayloadRoot: os.Getenv("JOBCTRL_TEST_CLI_LOCK_PAYLOAD"),
			Instance: instance{ID: "synthetic-instance", RuntimeHome: store.Home,
				StateDir: os.Getenv("JOBCTRL_TEST_CLI_STATE"), StatePath: filepath.Join(os.Getenv("JOBCTRL_TEST_CLI_STATE"), "state.json")},
			selection: lock,
			Environment: []string{
				"JOBCTRL_TEST_CLI_READY=" + os.Getenv("JOBCTRL_TEST_CLI_READY"),
				"JOBCTRL_TEST_CLI_RELEASE=" + os.Getenv("JOBCTRL_TEST_CLI_RELEASE"),
			},
		}
		if err := dispatchPython(ctx, []string{"synthetic-command"}); err != nil {
			t.Fatal(err)
		}
		return
	}
	runCLILockAndRebootScenario(t, false)
}

func TestDirectPayloadCLILockAndRebootFence(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	runCLILockAndRebootScenario(t, true)
}

func runCLILockAndRebootScenario(t *testing.T, direct bool) {
	fixture := newV6ActivationFixture(t)
	fixture.ctx.Instance.ID = "synthetic-instance"
	payload := t.TempDir()
	venv := filepath.Join(payload, "python")
	createVenv := exec.Command(fixture.python, "-I", "-B", "-m", "venv", "--without-pip", venv)
	createVenv.Env = []string{"HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"}
	if output, err := createVenv.CombinedOutput(); err != nil {
		t.Fatalf("create synthetic Python runtime: %v: %s", err, output)
	}
	python := filepath.Join(venv, "bin", "python3")
	findSite := exec.Command(python, "-I", "-B", "-c", "import sysconfig; print(sysconfig.get_path('purelib'))")
	findSite.Env = []string{"HOME=" + t.TempDir(), "PATH=/usr/bin:/bin"}
	siteOutput, err := findSite.Output()
	if err != nil {
		t.Fatal(err)
	}
	site := strings.TrimSpace(string(siteOutput))
	inside, err := isOwnedPythonSite(venv, site)
	if err != nil || !inside {
		t.Fatalf("synthetic Python site escaped the owned environment: %q %v", site, err)
	}
	packageDir := filepath.Join(site, "jobctrl")
	if err := os.MkdirAll(packageDir, 0o700); err != nil {
		t.Fatal(err)
	}
	program := "import os, time\nfrom pathlib import Path\nPath(os.environ['JOBCTRL_TEST_CLI_READY']).write_text('ready')\nwhile not Path(os.environ['JOBCTRL_TEST_CLI_RELEASE']).exists(): time.sleep(0.05)\n"
	if err := os.WriteFile(filepath.Join(packageDir, "__main__.py"), []byte(program), 0o600); err != nil {
		t.Fatal(err)
	}
	coordination := t.TempDir()
	ready, releasePath := filepath.Join(coordination, "ready"), filepath.Join(coordination, "release")
	binary, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	child := exec.Command(binary, "-test.run=^TestInstalledCLILockSurvivesExecAndFencesBackup$")
	child.Env = []string{
		"JOBCTRL_TEST_CLI_LOCK_HELPER=1", "JOBCTRL_TEST_CLI_LOCK_RUNTIME=" + fixture.runtime,
		"JOBCTRL_TEST_CLI_STATE=" + fixture.state,
		"JOBCTRL_TEST_CLI_LOCK_PAYLOAD=" + payload,
		"JOBCTRL_TEST_CLI_READY=" + ready, "JOBCTRL_TEST_CLI_RELEASE=" + releasePath,
	}
	if direct {
		child.Env = append(child.Env, "JOBCTRL_TEST_CLI_DIRECT=1")
	}
	var childOutput bytes.Buffer
	child.Stdout, child.Stderr = &childOutput, &childOutput
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	childDone := make(chan error, 1)
	go func() { childDone <- child.Wait() }()
	childExited := false
	t.Cleanup(func() {
		if childExited {
			return
		}
		_ = os.WriteFile(releasePath, []byte("release"), 0o600)
		select {
		case <-childDone:
		case <-time.After(5 * time.Second):
			_ = child.Process.Kill()
			<-childDone
		}
	})
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		select {
		case err := <-childDone:
			childExited = true
			t.Fatalf("synthetic command exited before ready: %v: %s", err, childOutput.String())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatal("synthetic command did not become ready")
		}
		time.Sleep(10 * time.Millisecond)
	}
	output := t.TempDir()
	if err := stopStandalone(fixture.ctx); !errors.Is(err, errRebootRequired) {
		t.Fatalf("stop passed live CLI admission: %v", err)
	}
	backupDone := make(chan error, 1)
	go func() { backupDone <- backup(fixture.ctx, []string{"--output", output}, &bytes.Buffer{}) }()
	select {
	case err := <-backupDone:
		t.Fatalf("backup passed the live command's selection lock: %v", err)
	case <-time.After(300 * time.Millisecond):
	}
	entries, err := os.ReadDir(output)
	if err != nil || len(entries) != 0 {
		t.Fatalf("backup wrote a pair while the command was live: %v, %v", entries, err)
	}
	if err := os.WriteFile(releasePath, []byte("release"), 0o600); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-backupDone:
		if !errors.Is(err, errRebootRequired) {
			t.Fatalf("command exit falsely certified descendant quiescence: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("backup did not resume after command exit")
	}
	entries, err = os.ReadDir(output)
	if err != nil || len(entries) != 0 {
		t.Fatalf("backup wrote a pair before reboot recovery: %v, %v", entries, err)
	}
	select {
	case err := <-childDone:
		childExited = true
		if err != nil {
			t.Fatalf("synthetic command failed: %v %s", err, childOutput.String())
		}
	case <-time.After(5 * time.Second):
		t.Fatal("owned command did not exit")
	}
	syntheticBoot(t, syntheticBootTwo)
	if err := backup(fixture.ctx, []string{"--output", output}, &bytes.Buffer{}); err != nil {
		t.Fatalf("backup after reboot recovery failed: %v", err)
	}
	entries, err = os.ReadDir(output)
	if err != nil || len(entries) != 1 {
		t.Fatalf("expected one paired backup after reboot recovery: %v, %v", entries, err)
	}
}

// Compare resolved paths: on macOS Python may report /private/var while Go's
// temporary directory is spelled /var, which is a symlink to the same tree.
func isOwnedPythonSite(venv, site string) (bool, error) {
	resolvedVenv, err := filepath.EvalSymlinks(venv)
	if err != nil {
		return false, err
	}
	resolvedSite, err := filepath.EvalSymlinks(site)
	if err != nil {
		return false, err
	}
	rel, err := filepath.Rel(resolvedVenv, resolvedSite)
	if err != nil {
		return false, err
	}
	return rel != ".." && !strings.HasPrefix(rel, ".."+string(os.PathSeparator)), nil
}

func TestOwnedPythonSiteResolvesAliasesAndRejectsEscapes(t *testing.T) {
	root := t.TempDir()
	venv := filepath.Join(root, "venv")
	site := filepath.Join(venv, "lib", "site-packages")
	if err := os.MkdirAll(site, 0o700); err != nil {
		t.Fatal(err)
	}
	alias := filepath.Join(root, "alias")
	if err := os.Symlink(venv, alias); err != nil {
		t.Fatal(err)
	}
	inside, err := isOwnedPythonSite(alias, site)
	if err != nil || !inside {
		t.Fatalf("alias to owned environment refused: inside=%v err=%v", inside, err)
	}
	outside := filepath.Join(root, "outside")
	if err := os.Mkdir(outside, 0o700); err != nil {
		t.Fatal(err)
	}
	escape := filepath.Join(venv, "escape")
	if err := os.Symlink(outside, escape); err != nil {
		t.Fatal(err)
	}
	inside, err = isOwnedPythonSite(venv, escape)
	if err != nil || inside {
		t.Fatalf("site symlink to outside accepted: inside=%v err=%v", inside, err)
	}
}
