package launcher

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
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
