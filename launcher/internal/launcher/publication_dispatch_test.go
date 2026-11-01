package launcher

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPublicDispatchRefusesUnresolvedDatabasePublication(t *testing.T) {
	root := t.TempDir()
	database := filepath.Join(root, "jobctrl.db")
	if err := os.WriteFile(database, []byte("synthetic database"), 0600); err != nil {
		t.Fatal(err)
	}
	stage := filepath.Join(root, ".jobctrl-init-synthetic")
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(database, filepath.Join(stage, "candidate.db")); err != nil {
		t.Fatal(err)
	}
	paths := []string{database, database + "-wal", database + "-shm", filepath.Join(stage, "candidate.db")}
	for _, path := range paths[1:3] {
		if err := os.WriteFile(path, []byte("unfamiliar "+filepath.Base(path)), 0600); err != nil {
			t.Fatal(err)
		}
	}
	before := make(map[string][]byte, len(paths))
	for _, path := range paths {
		var err error
		before[path], err = os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
	}
	ctx := launchContext{PayloadRoot: filepath.Join(root, "missing-runtime"), Instance: instance{StateDir: root, LockPath: filepath.Join(root, "supervisor.lock")}}
	var ready bytes.Buffer
	for name, call := range map[string]func() error{
		"start":           func() error { return executeStart(ctx, []string{"--no-open"}, io.Discard) },
		"supervisor":      func() error { return supervise(ctx, &ready) },
		"python dispatch": func() error { return dispatchPython(ctx, []string{"status"}) },
	} {
		if err := call(); !errors.Is(err, errUnresolvedDatabasePublication) {
			t.Errorf("%s did not refuse unresolved publication: %v", name, err)
		}
	}
	if !strings.Contains(ready.String(), "unresolved publication") {
		t.Errorf("supervisor did not notify readiness failure: %q", ready.String())
	}
	if _, err := os.Lstat(ctx.Instance.LockPath); !os.IsNotExist(err) {
		t.Errorf("supervisor lock created before refusal: %v", err)
	}
	for _, path := range paths {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, before[path]) {
			t.Errorf("file %s changed: %v", path, err)
		}
	}
}
