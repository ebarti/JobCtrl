//go:build darwin

package launcher

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"
)

type ownedWitnessLockResult struct {
	file      *os.File
	coalition uint64
	err       error
}

func TestOrdinaryWitnessControlLockIsBounded(t *testing.T) {
	for _, holdPastDeadline := range []bool{false, true} {
		t.Run(fmt.Sprintf("hold-past-deadline=%t", holdPastDeadline), func(t *testing.T) {
			root, err := os.MkdirTemp("", "jobctrl-ordinary-witness-lock-")
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
			originalStdin, originalCount := os.Stdin, readCoalitionActiveTaskCount
			os.Stdin = reader
			acquired := make(chan ownedWitnessLockResult, 1)
			done := make(chan error, 1)
			var held *os.File
			donePending := false
			defer func() {
				releaseLock(held)
				if donePending {
					select {
					case <-done:
					case <-time.After(10 * time.Second):
						t.Errorf("owned execution did not finish; synthetic root retained")
					}
				}
				os.Stdin, readCoalitionActiveTaskCount = originalStdin, originalCount
				reader.Close()
			}()
			var once sync.Once
			readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
				count, err := originalCount(id)
				// The lock is acquired at a real zero for this private scope,
				// never by inventing a kernel observation or coalition ID.
				if err == nil && count == 0 || errors.Is(err, syscall.ESRCH) {
					once.Do(func() {
						lock, lockErr := acquireLock(ctx.Instance.ControlPath, true)
						acquired <- ownedWitnessLockResult{lock, id, lockErr}
					})
				}
				return count, err
			}
			donePending = true
			go func() {
				done <- runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "stdin", "unused"}, io.Discard, io.Discard)
			}()
			var binding ownedWitnessLockResult
			select {
			case binding = <-acquired:
				held = binding.file
				if binding.err != nil {
					t.Fatalf("could not hold the real control lock: %v", binding.err)
				}
			case err := <-done:
				donePending = false
				t.Fatalf("execution finished without a real zero and lock contention: %v", err)
			case <-time.After(10 * time.Second):
				t.Fatal("owned execution did not reach its lock contention")
			}
			scopes, err := readOwnedExecutionScopes(ctx)
			if err != nil || len(scopes) != 1 || scopes[0].CoalitionIDs[0] != binding.coalition {
				t.Fatalf("lock was not bound to the actual synthetic scope: %v", err)
			}
			receipt := filepath.Join(root, "executions", scopes[0].ID+".json")
			before, err := os.ReadFile(receipt)
			if err != nil {
				t.Fatal(err)
			}
			if holdPastDeadline {
				// Wait longer than the product's observation deadline while
				// still holding the real lock. Release before reporting a
				// failure so even the broken baseline can finish cleanly.
				select {
				case err = <-done:
					donePending = false
					if err != nil {
						t.Fatalf("contended execution failed: %v", err)
					}
				case <-time.After(time.Second):
					releaseLock(held)
					held = nil
					select {
					case <-done:
						donePending = false
					case <-time.After(10 * time.Second):
					}
					t.Fatal("completion remained blocked beyond the deadline while the lock was held")
				}
				if _, err := readExecutionCompletion(ctx, scopes[0].ID); !errors.Is(err, os.ErrNotExist) {
					t.Fatalf("contended execution published unverified completion: %v", err)
				}
				after, err := os.ReadFile(receipt)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatalf("contended execution changed its active receipt: %v", err)
				}
				if second, err := acquireLock(ctx.Instance.ControlPath, true); !errors.Is(err, ErrLockHeld) {
					releaseLock(second)
					t.Fatalf("long holder did not retain the real lock: %v", err)
				}
				releaseLock(held)
				held = nil
				return
			}
			time.Sleep(30 * time.Millisecond)
			releaseLock(held)
			held = nil
			select {
			case err = <-done:
				donePending = false
				if err != nil {
					t.Fatalf("execution did not complete after lock release: %v", err)
				}
			case <-time.After(10 * time.Second):
				t.Fatal("owned execution did not finish after lock release")
			}
			completion, err := readExecutionCompletion(ctx, scopes[0].ID)
			if err != nil || completion.Scope != scopes[0] || completion.VerificationBootSession != scopes[0].BootSession {
				t.Fatalf("short contention lost the exact completion: %v", err)
			}
			readCoalitionActiveTaskCount = originalCount
			if err := stop(ctx); err != nil {
				t.Fatalf("exact completion did not permit stop: %v", err)
			}
			if err := runInOwnedExecution(ctx, []string{"__scope-test-command", ctx.Instance.StatePath, ctx.Instance.ID, "stdin", "unused"}, io.Discard, io.Discard); err != nil {
				t.Fatalf("same-boot subsequent execution was blocked: %v", err)
			}
			if err := stop(ctx); err != nil {
				t.Fatalf("restarted synthetic execution did not stop: %v", err)
			}
		})
	}
}
