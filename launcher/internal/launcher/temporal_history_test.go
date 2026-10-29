package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestTemporalHistoryPathPreservesUniqueHistoryAndRefusesAmbiguity(t *testing.T) {
	for _, scenario := range []struct {
		name, expected string
		files          []string
		wantError      bool
	}{
		{"new", "temporal.db", nil, false},
		{"installed", "temporal.db", []string{"temporal.db"}, false},
		{"legacy source", "temporal/temporal.db", []string{"temporal/temporal.db"}, false},
		{"both histories", "", []string{"temporal.db", "temporal/temporal.db"}, true},
		{"orphaned legacy WAL", "", []string{"temporal.db", "temporal/temporal.db-wal"}, true},
		{"orphaned installed WAL", "", []string{"temporal/temporal.db", "temporal.db-wal"}, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root := t.TempDir()
			for _, name := range scenario.files {
				path := filepath.Join(root, name)
				if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(path, []byte(name), 0600); err != nil {
					t.Fatal(err)
				}
			}
			got, err := temporalHistoryPath(root)
			if scenario.wantError {
				if err == nil {
					t.Fatalf("accepted ambiguous history as %q", got)
				}
				for _, name := range scenario.files {
					if raw, err := os.ReadFile(filepath.Join(root, name)); err != nil || string(raw) != name {
						t.Fatalf("refusal changed %s: %v", name, err)
					}
				}
				return
			}
			if err != nil || got != filepath.Join(root, scenario.expected) {
				t.Fatalf("history = %q, error %v", got, err)
			}
			value, err := substitute("--db=${TEMPORAL_DB}", launchContext{Instance: instance{StateDir: root}})
			if err != nil || value != "--db="+got {
				t.Fatalf("Temporal command = %q, error %v", value, err)
			}
		})
	}
}

func TestTemporalHistoryPathRefusesLinkedLegacyDirectory(t *testing.T) {
	root, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(root, "temporal")); err != nil {
		t.Fatal(err)
	}
	if _, err := temporalHistoryPath(root); err == nil {
		t.Fatal("followed a linked history directory")
	}
}

func TestInstalledTemporalComponentStartsWithLegacySourceHistory(t *testing.T) {
	root, payload := t.TempDir(), t.TempDir()
	legacyDir := filepath.Join(root, "temporal")
	if err := os.Mkdir(legacyDir, 0700); err != nil {
		t.Fatal(err)
	}
	legacy := filepath.Join(legacyDir, "temporal.db")
	if err := os.WriteFile(legacy, []byte("owned-history"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(payload, "temporal"), 0700); err != nil {
		t.Fatal(err)
	}
	component := filepath.Join(payload, "temporal", "temporal")
	if err := os.WriteFile(component, []byte("#!/bin/sh\nprintf '%s\\n' \"$@\" \"$JOBCTRL_TEMPORAL_DB\" > \"$TEST_ARGS\"\nexec /bin/sleep 30\n"), 0700); err != nil {
		t.Fatal(err)
	}
	argsFile := filepath.Join(root, "args")
	ctx := launchContext{PayloadRoot: payload, Environment: []string{"TEST_ARGS=" + argsFile},
		Instance: instance{StateDir: root, StatePath: filepath.Join(root, "state.json"), LogDir: root},
		Manifest: runtimeManifest{Components: []commandSpec{{Name: "temporal", Executable: "temporal/temporal", Arguments: []string{"--db-filename", "${TEMPORAL_DB}"}}}}}
	state := instanceState{Components: map[string]componentRecord{}}
	child, err := startComponent(ctx, &state, "temporal")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = child.Process.Kill(); _ = child.Wait() })
	var raw []byte
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw, err = os.ReadFile(argsFile)
		if err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err != nil || string(raw) != "--db-filename\n"+legacy+"\n"+legacy+"\n" {
		t.Fatalf("installed Temporal command did not use the source history: %q %v", raw, err)
	}
	if _, err := os.Lstat(filepath.Join(root, "temporal.db")); !os.IsNotExist(err) {
		t.Fatal("installed start created a second history")
	}
}

func TestInstalledBackupRefusesUnverifiedLegacySourceHistory(t *testing.T) {
	f := newV6ActivationFixture(t)
	legacyDir := filepath.Join(f.state, "temporal")
	if err := os.Mkdir(legacyDir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(f.state, "temporal.db"), filepath.Join(legacyDir, "temporal.db")); err != nil {
		t.Fatal(err)
	}
	if unused, err := unusedDatabasePair(f.state); err != nil || unused {
		t.Fatalf("legacy pair was not admitted: unused=%v error=%v", unused, err)
	}
	before, err := sha256Path(filepath.Join(f.state, "jobctrl.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := snapshotPair(f.ctx, f.old); err == nil || !strings.Contains(err.Error(), "unverified runtime ownership") {
		t.Fatalf("legacy backup must refuse without a source ownership proof: %v", err)
	}
	after, err := sha256Path(filepath.Join(f.state, "jobctrl.db"))
	if err != nil || before != after {
		t.Fatal("refused backup changed the live application database")
	}
}
