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

func TestNativeLifecycleRefusesUnresolvedPublicationWithProvisionedPython(t *testing.T) {
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

func TestV15ActivationPreservesPublicationRefusalAfterChild(t *testing.T) {
	root := t.TempDir()
	live := filepath.Join(root, "jobctrl.db")
	candidate := filepath.Join(root, ".v15-candidate.db")
	for _, path := range []string{live, candidate} {
		if err := os.WriteFile(path, []byte("synthetic database"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	bin := filepath.Join(root, "runtime", "python", "bin")
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	// Model an independent publication marker appearing after the native
	// preflight but before the child returns; no real database is opened.
	child := "#!/bin/sh\nmkdir \"$JOBCTRL_TEST_STAGE\"\nln \"$JOBCTRL_TEST_LIVE\" \"$JOBCTRL_TEST_STAGE/candidate.db\"\n"
	if err := os.WriteFile(filepath.Join(bin, "python3"), []byte(child), 0700); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{PayloadRoot: filepath.Join(root, "runtime"), Instance: instance{StateDir: root}, Environment: []string{"JOBCTRL_TEST_STAGE=" + filepath.Join(root, ".jobctrl-init-synthetic"), "JOBCTRL_TEST_LIVE=" + live}}
	err := installSealedV15Candidate(ctx, candidate)
	if !errors.Is(err, errUnresolvedDatabasePublication) {
		t.Fatalf("expected typed publication refusal, got %v", err)
	}
}

func TestPromotionRefusesUnresolvedInitializationWithoutRestart(t *testing.T) {
	fixture := newV6ActivationFixture(t)
	source := filepath.Join(fixture.state, "jobctrl.db")
	if err := os.Remove(source); err != nil {
		t.Fatal(err)
	}
	seed := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1]); c.execute("PRAGMA journal_mode=WAL")
c.execute("CREATE TABLE item(value)"); c.execute("INSERT INTO item VALUES (42)"); c.commit(); os._exit(0)`
	if output, err := exec.Command(fixture.python, "-c", seed, source).CombinedOutput(); err != nil {
		t.Fatalf("seed synthetic WAL: %v %s", err, output)
	}
	staging := filepath.Join(fixture.state, ".jobctrl-init-synthetic")
	if err := os.Mkdir(staging, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(source, filepath.Join(staging, "candidate.db")); err != nil {
		t.Fatal(err)
	}
	paths := []string{source, source + "-wal", source + "-shm", filepath.Join(staging, "candidate.db"), filepath.Join(fixture.state, "temporal.db")}
	before := make(map[string][]byte, len(paths))
	for _, path := range paths {
		var err error
		before[path], err = os.ReadFile(path)
		if err != nil {
			t.Fatalf("read %s: %v", path, err)
		}
	}
	oldStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = oldStart })
	starts := 0
	startReleaseCommand = func(_ launchContext, _ release.Receipt, _ string) error {
		starts++
		// A predecessor without the guard can open the live SQLite file.
		code := `import pathlib,sqlite3,sys; c=sqlite3.connect(pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro",uri=True); c.execute("PRAGMA user_version").fetchone(); c.close()`
		output, err := exec.Command(fixture.python, "-c", code, source).CombinedOutput()
		if err != nil {
			t.Fatalf("synthetic predecessor SQLite read: %v %s", err, output)
		}
		return nil
	}
	err := promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard)
	if err == nil || !strings.Contains(err.Error(), "unresolved publication") {
		t.Errorf("unexpected promotion error: %v", err)
	}
	if starts != 0 {
		t.Errorf("unsafe predecessor was started %d times", starts)
	}
	if err := startRelease(fixture.ctx, fixture.old, ""); err == nil || !strings.Contains(err.Error(), "unresolved publication") {
		t.Errorf("actual release start did not refuse before subprocess: %v", err)
	}
	if err := executeStart(fixture.ctx, []string{"--no-open"}, io.Discard); err == nil || !strings.Contains(err.Error(), "unresolved publication") {
		t.Errorf("public start did not refuse before service startup: %v", err)
	}
	if err := restorePair(fixture.ctx, databasePair{}); err == nil || !strings.Contains(err.Error(), "unresolved publication") {
		t.Errorf("paired restore did not refuse before touching files: %v", err)
	}
	// Simulate a crash at the durable quiescing state, before refusal can be
	// recorded. Recovery must not start the predecessor or restore either DB.
	journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.Advance(&journal, release.Quiescing, nil); err != nil {
		t.Fatal(err)
	}
	if _, err := recoverInterruptedTransition(fixture.ctx, fixture.store); err == nil || !strings.Contains(err.Error(), "unresolved publication") {
		t.Errorf("interrupted recovery did not refuse: %v", err)
	}
	if starts != 0 {
		t.Errorf("recovery started unsafe predecessor %d times", starts)
	}
	for _, path := range paths {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, before[path]) {
			t.Errorf("file %s changed: %v", path, err)
		}
	}
}

func TestSchemaVersionRefusesUnresolvedInitializationBeforeSQLiteOpen(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	root := t.TempDir()
	source := filepath.Join(root, "jobctrl.db")
	// Exit without closing SQLite to retain real WAL and shared-memory files.
	seed := `import os,sqlite3,sys
c=sqlite3.connect(sys.argv[1])
c.execute("PRAGMA journal_mode=WAL")
c.execute("PRAGMA user_version=14")
c.execute("CREATE TABLE item(value)")
c.execute("INSERT INTO item VALUES (42)")
c.commit()
os._exit(0)`
	if output, err := exec.Command(python, "-c", seed, source).CombinedOutput(); err != nil {
		t.Fatalf("seed synthetic WAL: %v %s", err, output)
	}
	staging := filepath.Join(root, ".jobctrl-init-synthetic")
	if err := os.Mkdir(staging, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(source, filepath.Join(staging, "candidate.db")); err != nil {
		t.Fatal(err)
	}
	paths := []string{source, source + "-wal", source + "-shm", filepath.Join(staging, "candidate.db")}
	contents := make(map[string][]byte, len(paths))
	for _, path := range paths {
		contents[path], err = os.ReadFile(path)
		if err != nil {
			t.Fatalf("read synthetic file %s: %v", path, err)
		}
	}
	ctx := launchContext{PayloadRoot: filepath.Join(root, "missing-runtime"), Instance: instance{StateDir: root}}
	for name, probe := range map[string]func() (int64, error){
		"schema version":  func() (int64, error) { return sqliteUserVersion(python, source) },
		"lifecycle entry": func() (int64, error) { return jobCtrlSchemaVersion(ctx) },
	} {
		_, err = probe()
		if err == nil || !strings.Contains(err.Error(), "unresolved publication") {
			t.Errorf("%s: expected unresolved publication refusal, got %v", name, err)
		}
	}
	for _, path := range paths {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, contents[path]) {
			t.Errorf("synthetic file %s changed after schema probe: %v", path, err)
		}
	}
}

func TestV15ActivationAndBindingRefuseUnresolvedInitialization(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
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
	candidate := filepath.Join(root, ".v15-candidate.db")
	if err := os.WriteFile(candidate, []byte("synthetic sealed candidate"), 0600); err != nil {
		t.Fatal(err)
	}
	started := filepath.Join(root, "python-started")
	runtime := filepath.Join(root, "runtime")
	bin := filepath.Join(runtime, "python", "bin")
	if err := os.MkdirAll(bin, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(bin, "python3"), []byte("#!/bin/sh\nprintf started > \"$JOBCTRL_TEST_START_MARKER\"\nexit 1\n"), 0700); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{PayloadRoot: runtime, Instance: instance{StateDir: root}, Environment: []string{"JOBCTRL_TEST_START_MARKER=" + started}}
	paths := []string{live, live + "-wal", live + "-shm", filepath.Join(staging, "candidate.db"), candidate}
	before := make(map[string][]byte, len(paths))
	for _, path := range paths {
		before[path], err = os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
	}
	for name, call := range map[string]func() error{
		"activation":     func() error { return installSealedV15Candidate(ctx, candidate) },
		"source binding": func() error { return bindV15Source(ctx, candidate, candidate) },
	} {
		if err := call(); err == nil || !strings.Contains(err.Error(), "unresolved publication") {
			t.Errorf("%s did not refuse unresolved publication: %v", name, err)
		}
	}
	if _, err := os.Lstat(started); !os.IsNotExist(err) {
		t.Errorf("activation subprocess was launched: %v", err)
	}
	for _, path := range paths {
		got, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(got, before[path]) {
			t.Errorf("synthetic file %s changed: %v", path, err)
		}
	}
}

func TestSQLiteOnlineBackupIgnoresUnrelatedInitialization(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	root := t.TempDir()
	source := filepath.Join(root, "jobctrl.db")
	destination := filepath.Join(root, "backup.db")
	if output, err := exec.Command(python, "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('create table t(v)'); c.execute('insert into t values (42)'); c.commit()", source).CombinedOutput(); err != nil {
		t.Fatalf("seed database: %v %s", err, output)
	}
	staging := filepath.Join(root, ".jobctrl-init-unrelated")
	if err := os.Mkdir(staging, 0700); err != nil {
		t.Fatal(err)
	}
	candidate := filepath.Join(staging, "candidate.db")
	if err := os.WriteFile(candidate, []byte("unrelated candidate"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := sqliteOnlineBackup(python, source, destination); err != nil {
		t.Fatalf("unrelated staging blocked a healthy database: %v", err)
	}
	if version, err := sqliteUserVersion(python, source); err != nil || version != 0 {
		t.Fatalf("unrelated staging blocked the schema version probe: version=%d error=%v", version, err)
	}
	if got, err := os.ReadFile(candidate); err != nil || string(got) != "unrelated candidate" {
		t.Fatalf("unrelated candidate changed: %q %v", got, err)
	}
	if output, err := exec.Command(python, "-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); assert c.execute('select v from t').fetchone() == (42,)", destination).CombinedOutput(); err != nil {
		t.Fatalf("verify backup: %v %s", err, output)
	}
}
