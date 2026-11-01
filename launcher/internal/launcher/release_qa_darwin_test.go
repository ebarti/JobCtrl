//go:build darwin

package launcher

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestReleaseQACheckpointHelper(t *testing.T) {
	if os.Getenv("JOBCTRL_RELEASE_QA_HELPER") != "1" {
		return
	}
	store := &release.Store{Home: os.Getenv("JOBCTRL_RUNTIME_HOME")}
	journal := release.Journal{SchemaVersion: 2, ID: "owned-release-qa"}
	if err := advance(store, &journal, release.MetadataVerified); err != nil {
		t.Fatal(err)
	}
}

func TestReleaseQACheckpointRequiresMarkedTemporaryWorkspace(t *testing.T) {
	root := t.TempDir()
	runtime, workspace := filepath.Join(root, "runtime"), filepath.Join(root, "workspace")
	for _, directory := range []string{runtime, workspace} {
		if err := os.Mkdir(directory, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, ".jobctrl-release-qa"), []byte("jobctrl-release-qa-v1\n"), 0600); err != nil {
		t.Fatal(err)
	}
	store := &release.Store{Home: runtime}
	t.Setenv("JOBCTRL_RELEASE_QA_PAUSE", string(release.MetadataVerified))
	t.Setenv("JOBCTRL_RELEASE_QA_ROOT", root)
	t.Setenv("JOBCTRL_DIR", filepath.Dir(root))
	if err := releaseQACheckpoint(store, release.PairBackedUp); err != nil {
		t.Fatalf("unselected checkpoint was not inert: %v", err)
	}
	if err := releaseQACheckpoint(store, release.MetadataVerified); err == nil {
		t.Fatal("checkpoint admitted a workspace outside the marked fixture")
	}
	t.Setenv("JOBCTRL_DIR", workspace)
	marker := filepath.Join(root, ".jobctrl-release-qa")
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(root, "missing-marker"), marker); err != nil {
		t.Fatal(err)
	}
	if err := releaseQACheckpoint(store, release.MetadataVerified); err == nil {
		t.Fatal("checkpoint admitted a symlinked fixture marker")
	}
	if err := os.Remove(marker); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(marker, []byte("jobctrl-release-qa-v1\n"), 0600); err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	child := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestReleaseQACheckpointHelper$")
	child.Env = append(os.Environ(), "JOBCTRL_RELEASE_QA_HELPER=1", "JOBCTRL_RUNTIME_HOME="+runtime, "JOBCTRL_DIR="+workspace)
	stderr, err := child.StderrPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stderr).ReadString('\n')
	if err != nil || strings.TrimSpace(line) != "jobctrl-release-qa-checkpoint:metadata_verified" {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatalf("expected the child to reach its QA checkpoint: %q, %v", line, err)
	}
	contents, err := os.ReadFile(filepath.Join(runtime, "transition.json"))
	var journal release.Journal
	if err != nil || json.Unmarshal(contents, &journal) != nil || journal.State != release.MetadataVerified {
		_ = child.Process.Kill()
		_ = child.Wait()
		t.Fatalf("checkpoint preceded its durable journal: %s, %v", contents, err)
	}
	if err := child.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := child.Wait(); err == nil {
		t.Fatal("interrupted checkpoint child exited successfully")
	}
	if ctx.Err() != nil {
		t.Fatal("checkpoint child did not stop within the deadline")
	}
}
