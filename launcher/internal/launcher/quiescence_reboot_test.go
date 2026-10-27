package launcher

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const syntheticBootOne = "11111111-1111-4111-8111-111111111111"
const syntheticBootTwo = "22222222-2222-4222-8222-222222222222"

func syntheticBoot(t *testing.T, value string) {
	t.Helper()
	previous := readBootSession
	readBootSession = func() (string, error) { return value, nil }
	t.Cleanup(func() { readBootSession = previous })
}

// Model persisted metadata from an earlier boot for actual executable tests.
// All recorded fixture processes must be gone before changing the owned file.
// Production has no command or environment flag that performs this operation.
func markOwnedFixtureReboot(t *testing.T, path string) {
	t.Helper()
	state, err := readState(path)
	if err != nil || supervisorMayBeLive(state.Supervisor) {
		t.Fatalf("fixture supervisor has not exited: %v", err)
	}
	for _, component := range state.Components {
		if componentMayBeLive(component) {
			t.Fatal("fixture component group has not exited")
		}
	}
	boot, err := bootSessionIdentity()
	if err != nil {
		t.Fatal(err)
	}
	prior := syntheticBootOne
	if boot == prior {
		prior = syntheticBootTwo
	}
	ctx := launchContext{Instance: instance{ID: state.InstanceID, StateDir: state.CanonicalStateDir, StatePath: path}}
	if err := writeJSONAtomic(executionFencePath(ctx), executionBootFence{1, state.InstanceID, state.CanonicalStateDir, prior}); err != nil {
		t.Fatal(err)
	}
}

func TestKernelBootSessionIdentityIsStable(t *testing.T) {
	first, err := bootSessionIdentity()
	if err != nil {
		t.Fatal(err)
	}
	second, err := bootSessionIdentity()
	if err != nil || first != second || !validBootSession(first) {
		t.Fatalf("kernel boot identity was not stable and valid: %v", err)
	}
}

func TestRebootFencePreservesRefusedRegistryAndRecoversAfterBoot(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	record, child, _ := startDetachedWriter(t)
	ctx, _ := issue1275State(t, record)
	before, err := os.ReadFile(ctx.Instance.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); !errors.Is(err, errRebootRequired) {
		t.Fatalf("detached writer did not require a reboot: %v", err)
	}
	after, err := os.ReadFile(ctx.Instance.StatePath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatal("refusal changed registry bytes")
	}
	fence, err := readExecutionFence(ctx)
	if err != nil || fence.BootSession != syntheticBootOne {
		t.Fatalf("legacy fence was not durably recorded: %v", err)
	}
	if info, err := os.Stat(executionFencePath(ctx)); err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("fence is not owner-private")
	}
	if err := stop(ctx); !errors.Is(err, errRebootRequired) {
		t.Fatalf("repeated stop bypassed the current boot: %v", err)
	}
	// End the test-owned process before simulating a different boot. The test
	// does not reboot the host or pretend a live old process can cross a boot.
	if !recordMatchesLiveProcess(child) {
		t.Fatal("test lost its child identity")
	}
	if err := syscall.Kill(child.PID, syscall.SIGTERM); err != nil || !waitForPIDExit(child.PID, 5*time.Second) {
		t.Fatal("test-owned child did not exit")
	}
	syntheticBoot(t, syntheticBootTwo)
	if err := stop(ctx); err != nil {
		t.Fatalf("safe stop after reboot: %v", err)
	}
	state, err := readState(ctx.Instance.StatePath)
	if err != nil || state.StoppedAt == nil {
		t.Fatalf("reboot recovery did not record stopped state: %v", err)
	}
	if err := validateStartState(ctx, state); err != nil {
		t.Fatalf("restart remained blocked after the proven boot boundary: %v", err)
	}
}

func TestCLIExecutionFenceWorksWithoutComponentRegistry(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	ctx, _ := issue1275State(t, componentRecord{})
	if err := os.Remove(ctx.Instance.StatePath); err != nil {
		t.Fatal(err)
	}
	if err := recordExecutionBoot(ctx); err != nil {
		t.Fatal(err)
	}
	if err := stop(ctx); !errors.Is(err, errRebootRequired) {
		t.Fatalf("missing registry hid possible CLI descendants: %v", err)
	}
	var out bytes.Buffer
	if err := status(ctx, &out, true); err != nil || !bytes.Contains(out.Bytes(), []byte("reboot-required")) {
		t.Fatalf("status hid CLI quiescence uncertainty: %v", err)
	}
	syntheticBoot(t, syntheticBootTwo)
	if err := stop(ctx); err != nil {
		t.Fatalf("CLI fence did not recover after reboot: %v", err)
	}
}

func TestExecutionFenceRejectsMalformedForeignAndUnavailableIdentity(t *testing.T) {
	for _, contents := range []string{"not-json", `{"schemaVersion":1,"instanceId":"foreign","stateDir":"/foreign","bootSession":"` + syntheticBootOne + `"}`} {
		t.Run(contents[:5], func(t *testing.T) {
			ctx, _ := issue1275State(t, componentRecord{})
			path := executionFencePath(ctx)
			if err := os.WriteFile(path, []byte(contents), 0600); err != nil {
				t.Fatal(err)
			}
			if err := recordExecutionBoot(ctx); err == nil {
				t.Fatal("unfamiliar fence was overwritten")
			}
			if raw, err := os.ReadFile(path); err != nil || string(raw) != contents {
				t.Fatal("unfamiliar fence changed")
			}
		})
	}
	ctx, _ := issue1275State(t, componentRecord{})
	previous := readBootSession
	readBootSession = func() (string, error) { return "", errors.New("synthetic denied kernel read") }
	t.Cleanup(func() { readBootSession = previous })
	if err := recordExecutionBoot(ctx); err == nil {
		t.Fatal("missing kernel authority admitted execution")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(ctx.Instance.StatePath), "execution-boot.json")); !os.IsNotExist(err) {
		t.Fatal("failed boot read published an execution fence")
	}
}

func TestExecutionFenceRejectsAmbiguousJSONAndUnsafeFiles(t *testing.T) {
	syntheticBoot(t, syntheticBootOne)
	for _, shape := range []string{"duplicate", "case-variant", "trailing", "symlink", "fifo"} {
		t.Run(shape, func(t *testing.T) {
			ctx, _ := issue1275State(t, componentRecord{})
			path := executionFencePath(ctx)
			raw, err := json.Marshal(executionBootFence{1, ctx.Instance.ID, ctx.Instance.StateDir, syntheticBootOne})
			if err != nil {
				t.Fatal(err)
			}
			switch shape {
			case "duplicate":
				raw = []byte(strings.TrimSuffix(string(raw), "}") + `,"bootSession":"` + syntheticBootTwo + `"}`)
			case "case-variant":
				raw = []byte(strings.TrimSuffix(string(raw), "}") + `,"BootSession":"` + syntheticBootTwo + `"}`)
			case "trailing":
				raw = append(raw, []byte(`{}`)...)
			case "symlink":
				target := filepath.Join(t.TempDir(), "retained")
				if err := os.WriteFile(target, raw, 0600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, path); err != nil {
					t.Fatal(err)
				}
			case "fifo":
				if err := syscall.Mkfifo(path, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if shape != "symlink" && shape != "fifo" {
				if err := os.WriteFile(path, raw, 0600); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := runtimeQuiescent(ctx, instanceState{}); err == nil {
				t.Fatal("ambiguous or unsafe metadata authorized quiescence")
			}
			if err := recordExecutionBoot(ctx); err == nil {
				t.Fatal("ambiguous or unsafe metadata was replaced")
			}
		})
	}
}
