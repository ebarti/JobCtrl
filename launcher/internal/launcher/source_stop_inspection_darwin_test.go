//go:build darwin

package launcher

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

func TestSourceStopExplainsInspectionFailureWithoutInstalledCommand(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.MkdirAll(filepath.Join(source, "scripts"), 0700); err != nil {
		t.Fatal(err)
	}
	// RunSource validates the source entry; the stop path never executes it.
	if err := os.WriteFile(filepath.Join(source, "scripts", "dev"), []byte("synthetic source marker\n"), 0600); err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + root, "JOBCTRL_DIR=" + filepath.Join(root, "workspace"),
		"JOBCTRL_RUNTIME_HOME=" + filepath.Join(root, "runtime"), "PATH=/usr/bin:/bin"}
	inst, err := resolveInstance(env)
	if err != nil {
		t.Fatal(err)
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: inst.ID,
		CanonicalStateDir: inst.StateDir, PayloadRoot: source, BuildID: "source",
		ManifestSHA256: strings.Repeat("a", 64), Components: map[string]componentRecord{}}
	if err := writeState(inst.StatePath, state); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(inst.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	previous := inspectOwnedProcesses
	inspections := 0
	inspectOwnedProcesses = func(launchContext, instanceState, ...executionWitnesses) ([]ownedProcess, error) {
		inspections++
		return nil, fmt.Errorf("%w: %w", errOwnershipInspection, syscall.EPERM)
	}
	t.Cleanup(func() { inspectOwnedProcesses = previous })
	err = RunSource(filepath.Join(root, "no-such-launcher"), []string{"stop", source}, env, io.Discard, io.Discard)
	if !errors.Is(err, syscall.EPERM) || !errors.Is(err, errOwnershipInspection) || inspections != 1 {
		t.Fatalf("source stop did not preserve its inspection refusal: %v", err)
	}
	message := err.Error()
	if !strings.Contains(message, "cannot verify JobCtrl process ownership") ||
		!strings.Contains(message, "resolve the inspection issue and retry the stop operation") ||
		strings.Contains(strings.ToLower(message), "jobctrl stop") ||
		strings.Contains(strings.ToLower(message), "reboot") ||
		strings.Contains(strings.ToLower(message), "still running") {
		t.Fatalf("source stop returned misleading guidance: %v", err)
	}
	after, err := os.ReadFile(inst.StatePath)
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("source stop changed its unverified registry: %v", err)
	}
}
