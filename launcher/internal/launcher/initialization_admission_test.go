package launcher

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestSQLiteOnlineBackupRefusesUnresolvedInitialization(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "jobctrl.db")
	destination := filepath.Join(root, "backup.db")
	if err := os.WriteFile(source, []byte("synthetic database"), 0600); err != nil {
		t.Fatal(err)
	}
	staging := filepath.Join(root, ".jobctrl-init-synthetic")
	if err := os.Mkdir(staging, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(source, filepath.Join(staging, "candidate.db")); err != nil {
		t.Fatal(err)
	}
	sidecar := source + "-wal"
	if err := os.WriteFile(sidecar, []byte("unfamiliar companion"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := sqliteOnlineBackup("unavailable-python", source, destination)
	if err == nil || !strings.Contains(err.Error(), "unresolved publication") {
		t.Fatalf("unexpected error: %v", err)
	}
	if got, err := os.ReadFile(sidecar); err != nil || string(got) != "unfamiliar companion" {
		t.Fatalf("companion changed: %q %v", got, err)
	}
	if _, err := os.Stat(destination); !os.IsNotExist(err) {
		t.Fatalf("destination exists or is inaccessible: %v", err)
	}
}

func TestNativeLifecycleRefusesUnresolvedPublicationWithoutMutation(t *testing.T) {
	python := migrationIntegrationPython(t)
	fixture := newV6ActivationFixtureWithPython(t, python)
	pair, err := snapshotPair(fixture.ctx, fixture.old)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	journal.BackupID = pair.ID
	if err := fixture.store.Advance(&journal, release.PairBackedUp, nil); err != nil {
		t.Fatal(err)
	}
	live := filepath.Join(fixture.state, "jobctrl.db")
	stage := filepath.Join(fixture.state, ".jobctrl-init-synthetic")
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(live, filepath.Join(stage, "candidate.db")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(live+"-wal", []byte("unfamiliar companion"), 0600); err != nil {
		t.Fatal(err)
	}
	beforeDB, err := os.ReadFile(live)
	if err != nil {
		t.Fatal(err)
	}
	beforeJournal, err := fixture.store.ReadJournal()
	if err != nil {
		t.Fatal(err)
	}
	starts := 0
	oldStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = oldStart })
	startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
	if recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store); recovered || !errors.Is(err, errUnresolvedDatabasePublication) {
		t.Fatalf("recovery = %v, %v", recovered, err)
	}
	afterJournal, err := fixture.store.ReadJournal()
	if err != nil || afterJournal.State != beforeJournal.State || afterJournal.ID != beforeJournal.ID {
		t.Fatalf("journal changed: before=%+v after=%+v err=%v", beforeJournal, afterJournal, err)
	}
	for name, call := range map[string]func() error{
		"start":    func() error { return executeStart(fixture.ctx, []string{"--no-open"}, io.Discard) },
		"update":   func() error { return update(fixture.ctx, []string{"--to", fixture.candidate.BuildID}, io.Discard) },
		"rollback": func() error { return rollback(fixture.ctx, []string{"--to", fixture.old.BuildID}, io.Discard) },
		"backup":   func() error { return backup(fixture.ctx, nil, io.Discard) },
		"restore":  func() error { return restorePair(fixture.ctx, pair) },
	} {
		if err := call(); !errors.Is(err, errUnresolvedDatabasePublication) {
			t.Errorf("%s did not fail closed: %v", name, err)
		}
	}
	if starts != 0 {
		t.Errorf("started an older runtime %d times", starts)
	}
	afterDB, err := os.ReadFile(live)
	if err != nil || !bytes.Equal(beforeDB, afterDB) {
		t.Errorf("live DB changed: %v", err)
	}
	if got, err := os.ReadFile(live + "-wal"); err != nil || string(got) != "unfamiliar companion" {
		t.Errorf("WAL changed: %q %v", got, err)
	}
}

func TestSchemaActivationRefusesUnresolvedPublicationBeforeReplacingLiveDB(t *testing.T) {
	for name, activate := range map[string]func(launchContext, string) error{
		"v7":  installSealedV7Candidate,
		"v8":  installSealedV8Candidate,
		"v9":  installSealedV9Candidate,
		"v10": installSealedV10Candidate,
		"v11": installSealedV11Candidate,
		"v14": installSealedV14Candidate,
	} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			live := filepath.Join(root, "jobctrl.db")
			candidate := filepath.Join(root, "upgrade.db")
			if err := os.WriteFile(live, []byte("live"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(candidate, []byte("candidate"), 0600); err != nil {
				t.Fatal(err)
			}
			stage := filepath.Join(root, ".jobctrl-init-synthetic")
			if err := os.Mkdir(stage, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.Link(live, filepath.Join(stage, "candidate.db")); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(live+"-wal", []byte("unfamiliar"), 0600); err != nil {
				t.Fatal(err)
			}
			ctx := launchContext{Instance: instance{StateDir: root}}
			if err := activate(ctx, candidate); !errors.Is(err, errUnresolvedDatabasePublication) {
				t.Fatalf("activation did not fail closed: %v", err)
			}
			for filename, want := range map[string]string{live: "live", candidate: "candidate", live + "-wal": "unfamiliar"} {
				if got, err := os.ReadFile(filename); err != nil || string(got) != want {
					t.Errorf("file %s changed: %q %v", filename, got, err)
				}
			}
		})
	}
}

func TestSQLiteUserVersionRefusesUnresolvedInitializationBeforeSQLiteRead(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "jobctrl.db")
	python := migrationIntegrationPython(t)
	seed := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL"); c.execute("CREATE TABLE sample(v TEXT)"); c.execute("INSERT INTO sample VALUES('synthetic')"); c.execute("PRAGMA user_version=14"); c.commit(); os._exit(0)`
	if output, err := exec.Command(python, "-I", "-B", "-c", seed, source).CombinedOutput(); err != nil {
		t.Fatalf("seed crashed-WAL database: %v %s", err, output)
	}
	staging := filepath.Join(root, ".jobctrl-init-synthetic")
	if err := os.Mkdir(staging, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(source, filepath.Join(staging, "candidate.db")); err != nil {
		t.Fatal(err)
	}
	before := make(map[string][]byte)
	for _, suffix := range []string{"", "-wal", "-shm"} {
		value, err := os.ReadFile(source + suffix)
		if err != nil {
			t.Fatalf("read %s before probe: %v", suffix, err)
		}
		before[suffix] = value
	}
	_, err := sqliteUserVersion(python, source)
	if err == nil || !strings.Contains(err.Error(), "unresolved publication") {
		t.Errorf("expected unresolved-publication refusal, got %v", err)
	}
	for suffix, old := range before {
		got, readErr := os.ReadFile(source + suffix)
		if readErr != nil || !bytes.Equal(got, old) {
			t.Errorf("database companion %q changed during refused version probe: %v", suffix, readErr)
		}
	}
}
