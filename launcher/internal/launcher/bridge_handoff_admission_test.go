package launcher

import (
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestBridgeHandoffAdmissionPreservesAnyIntent(t *testing.T) {
	for _, kind := range []string{"regular", "malformed", "symlink", "directory"} {
		t.Run(kind, func(t *testing.T) {
			home := t.TempDir()
			path := filepath.Join(home, "bridge-handoff.json")
			switch kind {
			case "regular":
				if err := os.WriteFile(path, []byte(`{"schemaVersion":1}`), 0600); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				if err := os.WriteFile(path, []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			case "symlink":
				if err := os.Symlink("missing-target", path); err != nil {
					t.Fatal(err)
				}
			case "directory":
				if err := os.Mkdir(path, 0700); err != nil {
					t.Fatal(err)
				}
			}
			before, err := os.Lstat(path)
			if err != nil {
				t.Fatal(err)
			}
			if err := refusePendingBridgeHandoff(home); !errors.Is(err, errPendingBridgeHandoff) {
				t.Fatalf("admission = %v", err)
			}
			after, err := os.Lstat(path)
			if err != nil || !os.SameFile(before, after) {
				t.Fatalf("intent was changed or removed: %v", err)
			}
		})
	}
}

func TestBridgeHandoffAdmissionAllowsMissingIntentOnly(t *testing.T) {
	home := t.TempDir()
	if err := refusePendingBridgeHandoff(home); err != nil {
		t.Fatal(err)
	}
	if err := refusePendingBridgeHandoff(filepath.Join(home, "new-home")); err != nil {
		t.Fatal(err)
	}
	if err := refusePendingBridgeHandoff(""); err == nil {
		t.Fatal("empty home admitted")
	}
	if err := os.WriteFile(filepath.Join(home, "not-directory"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if err := refusePendingBridgeHandoff(filepath.Join(home, "not-directory")); err == nil {
		t.Fatal("inaccessible intent path admitted")
	}
}

func TestRunRefusesPendingHandoffBeforeDispatch(t *testing.T) {
	for _, command := range []string{"start", "update", "rollback", "uninstall", "__supervise"} {
		t.Run(command, func(t *testing.T) {
			home := t.TempDir()
			runtimeHome := filepath.Join(home, "runtime")
			if err := os.Mkdir(runtimeHome, 0700); err != nil {
				t.Fatal(err)
			}
			intent := filepath.Join(runtimeHome, "bridge-handoff.json")
			if err := os.WriteFile(intent, []byte("pending"), 0600); err != nil {
				t.Fatal(err)
			}
			state := filepath.Join(home, "state")
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + runtimeHome, "JOBCTRL_DIR=" + state}
			if err := Run(filepath.Join(home, "jobctrl"), []string{command}, env, io.Discard, io.Discard); !errors.Is(err, errPendingBridgeHandoff) {
				t.Fatalf("Run %s = %v", command, err)
			}
			if _, err := os.Lstat(state); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("created state before refusal: %v", err)
			}
			if got, err := os.ReadFile(intent); err != nil || string(got) != "pending" {
				t.Fatalf("intent changed: %q %v", got, err)
			}
		})
	}
}

func TestWaitingLifecycleCommandRechecksBridgeHandoffUnderLock(t *testing.T) {
	for _, command := range []string{"update", "rollback", "uninstall", "recovery", "backup"} {
		t.Run(command, func(t *testing.T) {
			home := t.TempDir()
			store, err := release.Open(home)
			if err != nil {
				t.Fatal(err)
			}
			transition, err := store.TransitionLock()
			if err != nil {
				t.Fatal(err)
			}
			ctx := launchContext{Instance: instance{RuntimeHome: home, StateDir: filepath.Join(home, "state")}}
			result := make(chan error, 1)
			go func() {
				switch command {
				case "update":
					result <- promoteExisting(ctx, store, release.Active{}, "candidate", "update", io.Discard)
				case "rollback":
					result <- rollbackExisting(ctx, store, release.Active{}, "prior", io.Discard)
				case "uninstall":
					result <- uninstall(ctx, nil, io.Discard)
				case "recovery":
					_, err := recoverInterruptedTransition(ctx, store)
					result <- err
				case "backup":
					result <- backup(ctx, nil, io.Discard)
				}
			}()
			path := filepath.Join(home, "bridge-handoff.json")
			if err := os.WriteFile(path, []byte("pending"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := transition.Close(); err != nil {
				t.Fatal(err)
			}
			if err := <-result; !errors.Is(err, errPendingBridgeHandoff) {
				t.Fatalf("%s = %v", command, err)
			}
			if got, err := os.ReadFile(path); err != nil || string(got) != "pending" {
				t.Fatalf("intent changed: %q %v", got, err)
			}
			if command == "backup" {
				if _, err := os.Lstat(filepath.Join(home, "state", "backups")); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("backup created output before refusal: %v", err)
				}
			}
		})
	}
}
