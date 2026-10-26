package installer

import (
	"bytes"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPendingBridgeHandoffRefusesActualLocalInstaller(t *testing.T) {
	for _, kind := range []string{"malformed", "symlink", "directory"} {
		t.Run(kind, func(t *testing.T) {
			root := t.TempDir()
			archive, descriptor, signature := localFixture(t, root)
			home := filepath.Join(root, "runtime")
			for _, dir := range []string{"staging/stage-interrupted", "bin", "instances/test"} {
				if err := os.MkdirAll(filepath.Join(home, dir), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			// release.Open normally chmods management directories. A known
			// pending intent must be refused before that metadata is touched.
			if err := os.Chmod(filepath.Join(home, "staging"), 0o750); err != nil {
				t.Fatal(err)
			}
			files := map[string][]byte{
				"staging/stage-interrupted/retain": []byte("owned stage"),
				"bin/jobctrl":                      []byte("selector"),
				"instances/test/jobctrl.db":        []byte("database"),
				"instances/test/jobctrl.db-wal":    []byte("wal"),
				"instances/test/jobctrl.db-shm":    []byte("shm"),
				"instances/test/temporal.db":       []byte("temporal"),
			}
			for name, raw := range files {
				if err := os.WriteFile(filepath.Join(home, name), raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			intent := filepath.Join(home, "bridge-handoff.json")
			switch kind {
			case "malformed":
				if err := os.WriteFile(intent, []byte("not-json"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink(filepath.Join(root, "missing"), intent); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(intent, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			_, err := InstallFromLocalFiles(Options{Home: home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true, StageOnly: true}, descriptor, signature, archive)
			if err == nil || !strings.Contains(err.Error(), "unfinished bridge handoff") {
				t.Fatalf("installer did not refuse: %v", err)
			}
			for name, want := range files {
				got, err := os.ReadFile(filepath.Join(home, name))
				if err != nil || !bytes.Equal(got, want) {
					t.Fatalf("%s changed: %v", name, err)
				}
			}
			if _, err := os.Lstat(intent); err != nil {
				t.Fatalf("handoff disappeared: %v", err)
			}
			if info, err := os.Stat(filepath.Join(home, "staging")); err != nil || info.Mode().Perm() != 0o750 {
				t.Fatalf("staging permissions changed: %v %v", info, err)
			}
			if _, err := os.Stat(filepath.Join(home, "releases", "fixture-build-0001")); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("release was staged: %v", err)
			}
		})
	}
}

func TestPendingBridgeHandoffRefusesDownloadBeforeStagingOrNetwork(t *testing.T) {
	home := t.TempDir()
	if err := os.WriteFile(filepath.Join(home, "bridge-handoff.json"), []byte("pending"), 0o600); err != nil {
		t.Fatal(err)
	}
	called := false
	client := &http.Client{Transport: channelPointerRoundTripper(func(*http.Request) (*http.Response, error) {
		called = true
		return nil, errors.New("unexpected network access")
	})}
	descriptor := stableDescriptor("https://example.test/release.zip")
	_, err := downloadAndInstall(Options{Home: home}, descriptor, []byte("descriptor"), "https://example.test/descriptor.json", client)
	if err == nil || !strings.Contains(err.Error(), "unfinished bridge handoff") {
		t.Fatalf("download did not refuse: %v", err)
	}
	if called {
		t.Fatal("download attempted network access")
	}
	if _, err := os.Stat(filepath.Join(home, "staging")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("staging was created: %v", err)
	}
}
