//go:build darwin

package launcher

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func init() {
	if len(os.Args) != 4 || os.Args[1] != "__zero-census-fork-test" {
		return
	}
	var ctx launchContext
	if json.Unmarshal([]byte(os.Args[2]), &ctx) != nil {
		os.Exit(81)
	}
	ctx.Environment = os.Environ()
	if valid, err := authenticatedOwnedExecution(ctx); err != nil || !valid {
		os.Exit(82)
	}
	root := os.Args[3]
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(scopes) != 1 {
		os.Exit(83)
	}
	scope := scopes[0]
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: ctx.Instance.ID, CanonicalStateDir: ctx.Instance.StateDir, PayloadRoot: root, BuildID: "owned-zero-census", ManifestSHA256: strings.Repeat("a", 64), Components: map[string]componentRecord{}, ExecutionScopeID: scope.ID}
	if writeState(ctx.Instance.StatePath, state) != nil {
		os.Exit(84)
	}
	ready, trigger, childFile := filepath.Join(root, "ready"), filepath.Join(root, "fork"), filepath.Join(root, "child")
	script := `import os,sys,time
open(sys.argv[1],'w').write(str(os.getpid()))
while not os.path.exists(sys.argv[2]): time.sleep(.001)
child=os.fork()
if child:
 open(sys.argv[3],'w').write(str(child))
 os._exit(0)
os.setsid()
os.execve('/bin/sleep',['sleep','60'],{})
`
	parent := exec.Command("/usr/bin/python3", "-I", "-B", "-c", script, ready, trigger, childFile)
	if parent.Start() != nil {
		os.Exit(85)
	}
	childPID, childIdentity := 0, ""
	finish := func() {
		scopedProcessIDs = userProcessIDs
		stopCompletionCheckpoint = nil
		if childPID > 0 {
			_ = signalExecutionRoot(scope.CoalitionIDs, childPID, childIdentity, syscall.SIGKILL)
		}
		_ = parent.Process.Kill()
		_ = parent.Wait()
	}
	for deadline := time.Now().Add(3 * time.Second); ; {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			finish()
			os.Exit(86)
		}
		time.Sleep(time.Millisecond)
	}
	censuses := 0
	scopedProcessIDs = func() ([]int, error) {
		pids, err := userProcessIDs()
		if err != nil {
			return nil, err
		}
		censuses++
		// The initial ownership and cooperative-root passes each have a
		// before/after fence. Synchronize the fifth (final-drain) snapshot.
		if censuses != 5 {
			return pids, nil
		}
		found := false
		for _, pid := range pids {
			if pid == parent.Process.Pid {
				found = true
			}
		}
		if !found {
			return nil, errors.New("real census omitted owned fixture parent")
		}
		if err := os.WriteFile(trigger, []byte("fork"), 0600); err != nil {
			return nil, err
		}
		for deadline := time.Now().Add(3 * time.Second); ; {
			if raw, err := os.ReadFile(childFile); err == nil {
				childPID, _ = strconv.Atoi(string(raw))
			}
			info, err := processBSDInfoIncludingZombies(parent.Process.Pid)
			if err == nil && binary.LittleEndian.Uint32(info[4:]) == 5 && childPID > 0 {
				break
			}
			if time.Now().After(deadline) {
				return nil, errors.New("fixture parent did not become retained kernel zombie")
			}
			time.Sleep(time.Millisecond)
		}
		for _, pid := range pids {
			if pid == childPID {
				return nil, errors.New("successor was not born after the real snapshot")
			}
		}
		childIdentity, err = processStartIdentity(childPID)
		if err != nil {
			return nil, err
		}
		ids, err := processCoalitionIDs(childPID)
		if err != nil || ids != scope.CoalitionIDs {
			return nil, fmt.Errorf("owned successor coalition mismatch: %v", err)
		}
		// Return the unchanged kernel PID list: only the race timing is controlled.
		return pids, nil
	}
	reached := false
	stopCompletionCheckpoint = func(at string) error {
		if at != "execution-completions-durable" {
			return nil
		}
		completion, err := readExecutionCompletion(ctx, scope.ID)
		if err != nil || completion.Scope != scope {
			return errors.New("exact completion missing at durable checkpoint")
		}
		info, err := processBSDInfoIncludingZombies(childPID)
		if err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		if err == nil && processIdentityFromBSD(info) == childIdentity && binary.LittleEndian.Uint32(info[4:]) != 5 {
			return errors.New("durable completion preceded the after-snapshot successor exit")
		}
		reached = true
		return errors.New("owned interruption after verified completion")
	}
	err = stop(ctx)
	finish()
	if !reached || err == nil || !strings.Contains(err.Error(), "owned interruption after verified completion") {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(87)
	}
	os.Exit(0)
}

func TestNativeZeroCensusFencesForkBeforeZombieInspection(t *testing.T) {
	ctx := executionTestContext(t)
	root := filepath.Dir(ctx.Instance.StatePath)
	ctx.Instance.ControlPath, ctx.Instance.LockPath = filepath.Join(root, "control.lock"), filepath.Join(root, "instance.lock")
	encoded, err := json.Marshal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		if err := stop(ctx); err != nil {
			t.Errorf("owned scope cleanup: %v", err)
		}
	}()
	if err := runInOwnedExecution(ctx, []string{"__zero-census-fork-test", string(encoded), root}, io.Discard, os.Stderr); err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); err != nil {
		t.Fatalf("interrupted finalization did not resume normally: %v", err)
	}
}

func TestExecutionZeroRequiresStableKernelBirthInventory(t *testing.T) {
	for _, changing := range []bool{false, true} {
		t.Run(strconv.FormatBool(changing), func(t *testing.T) {
			child := exec.Command("/bin/sleep", "60")
			if err := child.Start(); err != nil {
				t.Fatal(err)
			}
			defer func() { _ = child.Process.Kill(); _ = child.Wait() }()
			pid := child.Process.Pid
			oldPIDs, oldBSD := executionProcessIDs, executionProcessBSDInfo
			t.Cleanup(func() { executionProcessIDs, executionProcessBSDInfo = oldPIDs, oldBSD })
			executionProcessIDs = func() ([]int, error) { return []int{pid}, nil }
			reads := 0
			executionProcessBSDInfo = func(target int) ([]byte, error) {
				info, err := processBSDInfoIncludingZombies(target)
				if err != nil {
					return nil, err
				}
				reads++
				pass := (reads - 1) / 2
				if (changing && pass%2 == 1) || (!changing && pass > 0) {
					// Model a reused generation only for this owned synthetic PID;
					// no signal path is exercised and real kernel membership is read.
					seconds := binary.LittleEndian.Uint64(info[procBSDStartSeconds:])
					binary.LittleEndian.PutUint64(info[procBSDStartSeconds:], seconds+1)
				}
				return info, nil
			}
			members, err := executionMembers([2]uint64{^uint64(0), ^uint64(0) - 1})
			if changing {
				if err == nil {
					t.Fatal("changing generations certified zero")
				}
				return
			}
			if err != nil || len(members) != 0 || reads < 6 {
				t.Fatalf("zero did not wait for a stable replacement generation: %v reads=%d", err, reads)
			}
		})
	}
}
