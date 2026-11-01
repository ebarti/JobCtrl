package launcher

import (
	"bytes"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestHistoricalActivationRefusesUnresolvedPublication(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	tests := map[string]func(launchContext, string) error{
		"v7 activation":  installSealedV7Candidate,
		"v8 activation":  installSealedV8Candidate,
		"v9 activation":  installSealedV9Candidate,
		"v10 activation": installSealedV10Candidate,
		"v11 activation": installSealedV11Candidate,
		"v14 activation": installSealedV14Candidate,
		"v14 source binding": func(ctx launchContext, candidate string) error {
			return bindV14Source(ctx, candidate, candidate)
		},
	}
	for name, activate := range tests {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			live := filepath.Join(root, "jobctrl.db")
			seed := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL")
c.execute("CREATE TABLE item(value)"); c.execute("INSERT INTO item VALUES (42)"); c.commit(); os._exit(0)`
			if output, err := exec.Command(python, "-c", seed, live).CombinedOutput(); err != nil {
				t.Fatalf("seed synthetic WAL: %v %s", err, output)
			}
			staging := filepath.Join(root, ".jobctrl-init-synthetic")
			if err := os.Mkdir(staging, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Link(live, filepath.Join(staging, "candidate.db")); err != nil {
				t.Fatal(err)
			}
			candidate := filepath.Join(root, ".sealed-candidate.db")
			if err := os.WriteFile(candidate, []byte("synthetic candidate"), 0600); err != nil {
				t.Fatal(err)
			}
			runtime := filepath.Join(root, "runtime")
			bin := filepath.Join(runtime, "python", "bin")
			if err := os.MkdirAll(bin, 0700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(root, "subprocess-started")
			if err := os.WriteFile(filepath.Join(bin, "python3"), []byte("#!/bin/sh\nprintf started > \"$TEST_START_MARKER\"\nexit 1\n"), 0700); err != nil {
				t.Fatal(err)
			}
			ctx := launchContext{PayloadRoot: runtime, Instance: instance{StateDir: root}, Environment: []string{"TEST_START_MARKER=" + marker}}
			paths := []string{live, live + "-wal", live + "-shm", filepath.Join(staging, "candidate.db"), candidate}
			before := make(map[string][]byte, len(paths))
			for _, path := range paths {
				before[path], err = os.ReadFile(path)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := activate(ctx, candidate); err == nil || !strings.Contains(err.Error(), "unresolved publication") {
				t.Errorf("expected publication refusal, got %v", err)
			}
			if _, err := os.Lstat(marker); !os.IsNotExist(err) {
				t.Errorf("subprocess launched: %v", err)
			}
			for _, path := range paths {
				after, err := os.ReadFile(path)
				if err != nil || !bytes.Equal(after, before[path]) {
					t.Errorf("file changed %s: %v", path, err)
				}
			}
		})
	}
}
