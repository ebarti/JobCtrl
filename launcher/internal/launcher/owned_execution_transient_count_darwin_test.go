//go:build darwin

package launcher

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// The fake count is a transient observation only. Every accepting zero or
// reaped observation below comes from the real, privately owned coalition.
func TestOrdinaryCompletionRetriesTransientCountWhileWitnessIsHeld(t *testing.T) {
	for _, scenario := range []struct {
		name           string
		zeroToReplace  int
		observationErr error
		persistent     bool
	}{
		{"first-nonzero", 1, nil, false},
		{"first-unavailable", 1, syscall.EPERM, false},
		{"second-nonzero", 2, nil, false},
		{"second-unavailable", 2, syscall.EPERM, false},
		{"persistent-nonzero", 0, nil, true},
		{"persistent-unavailable", 0, syscall.EPERM, true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			root, err := os.MkdirTemp("", "jobctrl-ordinary-witness-")
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("retained synthetic evidence root: %s", root)
			executable, err := CurrentProcessExecutable()
			if err != nil {
				t.Fatal(err)
			}
			id, err := releaseRandomID()
			if err != nil {
				t.Fatal(err)
			}
			ctx := launchContext{
				Executable: executable,
				Instance: instance{ID: id, StatePath: filepath.Join(root, "state.json"),
					StateDir: filepath.Join(root, "data"), RuntimeHome: filepath.Join(root, "runtime"),
					ControlPath: filepath.Join(root, "control.lock"), LockPath: filepath.Join(root, "instance.lock")},
				Environment: []string{"PATH=/usr/bin:/bin:/usr/sbin:/sbin", executionQASandboxVariable + "=" + executionQASandboxSelector},
			}
			reader, writer, err := os.Pipe()
			if err != nil {
				t.Fatal(err)
			}
			if err := writer.Close(); err != nil {
				t.Fatal(err)
			}
			originalStdin, originalCount, originalPIDs := os.Stdin, readCoalitionActiveTaskCount, scopedProcessIDs
			os.Stdin = reader
			t.Cleanup(func() {
				os.Stdin, readCoalitionActiveTaskCount, scopedProcessIDs = originalStdin, originalCount, originalPIDs
				reader.Close()
			})
			observations, injected := 0, false
			var witnessedID uint64
			readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
				if scenario.persistent {
					injected, witnessedID = true, id
					if scenario.observationErr != nil {
						return 0, scenario.observationErr
					}
					return 1, nil
				}
				count, err := originalCount(id)
				t.Logf("owned coalition kernel count: %d, error: %v", count, err)
				if err == nil && count == 0 || errors.Is(err, syscall.ESRCH) {
					observations++
					if !injected && observations == scenario.zeroToReplace {
						injected, witnessedID = true, id
						if scenario.observationErr != nil {
							return 0, scenario.observationErr
						}
						return 1, nil
					}
				}
				return count, err
			}
			if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "stdin", "unused"}, io.Discard, io.Discard); err != nil {
				t.Fatal(err)
			}
			scopes, err := readOwnedExecutionScopes(ctx)
			if err != nil || len(scopes) != 1 {
				t.Fatalf("owned receipt unavailable: %v", err)
			}
			if !injected || witnessedID != scopes[0].CoalitionIDs[0] {
				t.Fatal("transient was not injected into the actual owned scope")
			}
			completion, err := readExecutionCompletion(ctx, scopes[0].ID)
			if scenario.persistent {
				if !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("uncertain scope published completion: %v", err)
				}
				receipt := filepath.Join(root, "executions", scopes[0].ID+".json")
				before, err := os.ReadFile(receipt)
				if err != nil {
					t.Fatal(err)
				}
				if scenario.observationErr != nil {
					readCoalitionActiveTaskCount = func(uint64) (uint64, error) { return 0, syscall.EPERM }
				} else {
					readCoalitionActiveTaskCount = func(uint64) (uint64, error) { return 1, nil }
				}
				scopedProcessIDs = func() ([]int, error) { return nil, syscall.EPERM }
				// An invalid executable prevents this synthetic start from ever
				// launching a process if admission incorrectly passes inspection.
				diagnosticCtx := ctx
				diagnosticCtx.Executable = filepath.Join(root, "no-such-launcher")
				for _, action := range []struct {
					name string
					args []string
				}{
					{"status", []string{"status"}},
					{"start", []string{"start", "--no-open"}},
					{"stop", []string{"stop"}},
				} {
					diagnosticErr := dispatchCommand(diagnosticCtx, action.args, io.Discard, io.Discard)
					if !errors.Is(diagnosticErr, syscall.EPERM) {
						t.Fatalf("%s accepted uncertain ownership: %v", action.name, diagnosticErr)
					}
					message := diagnosticErr.Error()
					if !strings.Contains(message, "cannot verify JobCtrl process ownership") ||
						strings.Contains(message, "retry the stop operation") != (action.name == "stop") ||
						strings.Contains(strings.ToLower(message), "jobctrl stop") ||
						strings.Contains(strings.ToLower(message), "reboot") ||
						strings.Contains(strings.ToLower(message), "still running") {
						t.Fatalf("%s produced a misleading inspection refusal: %v", action.name, diagnosticErr)
					}
					after, err := os.ReadFile(receipt)
					if err != nil || !bytes.Equal(before, after) {
						t.Fatalf("%s changed the uncertain receipt: %v", action.name, err)
					}
				}
				return
			}
			if err != nil || completion.Scope != scopes[0] || completion.VerificationBootSession != scopes[0].BootSession {
				t.Fatalf("authenticated witness was dropped before real zero: %v", err)
			}
			// A later Stop cannot obtain a fresh global census. Its exact proof
			// must still allow retirement without touching an unrelated PID.
			readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
				if id == witnessedID {
					return 0, syscall.ESRCH
				}
				return originalCount(id)
			}
			scopedProcessIDs = func() ([]int, error) { return nil, syscall.EPERM }
			if err := stop(ctx); err != nil {
				t.Fatalf("exact completion could not retire safely: %v", err)
			}
			remaining, err := readOwnedExecutionScopes(ctx)
			if err != nil || len(remaining) != 0 {
				t.Fatalf("verified active receipt was not retired: %v", err)
			}
		})
	}
}
