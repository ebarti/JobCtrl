package launcher

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

var readBootSession = bootSessionIdentity

var errRebootRequired = errors.New("component descendant ownership is unverified; reboot this Mac before retrying backup, update, rollback or restart. Do not restore a backup or delete the runtime registry")

type executionBootFence struct {
	SchemaVersion int    `json:"schemaVersion"`
	InstanceID    string `json:"instanceId"`
	StateDir      string `json:"stateDir"`
	BootSession   string `json:"bootSession"`
}

func validBootSession(value string) bool {
	if len(value) != 36 || value[8] != '-' || value[13] != '-' || value[18] != '-' || value[23] != '-' {
		return false
	}
	raw, err := hex.DecodeString(strings.ReplaceAll(value, "-", ""))
	return err == nil && len(raw) == 16 && value != "00000000-0000-0000-0000-000000000000"
}

func executionFencePath(ctx launchContext) string {
	return filepath.Join(filepath.Dir(ctx.Instance.StatePath), "execution-boot.json")
}

func readExecutionFence(ctx launchContext) (executionBootFence, error) {
	var fence executionBootFence
	if ctx.Instance.StatePath == "" || ctx.Instance.StateDir == "" {
		return fence, errors.New("runtime identity is required for quiescence verification")
	}
	fd, err := syscall.Open(executionFencePath(ctx), syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return fence, err
	}
	file := os.NewFile(uintptr(fd), "execution boot fence")
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() <= 0 || info.Size() > 4096 {
		return fence, errors.New("execution boot fence is not a bounded private regular file")
	}
	decoder := json.NewDecoder(io.LimitReader(file, 4097))
	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return fence, errors.New("execution boot fence is not an object")
	}
	seen := map[string]bool{}
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || seen[key] {
			return fence, errors.New("execution boot fence has duplicate or invalid fields")
		}
		seen[key] = true
		switch key {
		case "schemaVersion":
			err = decoder.Decode(&fence.SchemaVersion)
		case "instanceId":
			err = decoder.Decode(&fence.InstanceID)
		case "stateDir":
			err = decoder.Decode(&fence.StateDir)
		case "bootSession":
			err = decoder.Decode(&fence.BootSession)
		default:
			return fence, errors.New("execution boot fence has unknown fields")
		}
		if err != nil {
			return fence, errors.New("execution boot fence has invalid field values")
		}
	}
	if token, err := decoder.Token(); err != nil || token != json.Delim('}') || len(seen) != 4 {
		return fence, errors.New("execution boot fence is incomplete")
	}
	if _, err := decoder.Token(); err != io.EOF {
		return fence, errors.New("execution boot fence has trailing content")
	}
	if fence.SchemaVersion != 1 || fence.InstanceID != ctx.Instance.ID || fence.StateDir != ctx.Instance.StateDir || !validBootSession(fence.BootSession) {
		return fence, errors.New("execution boot fence does not bind this workspace; retain it for inspection")
	}
	return fence, nil
}

// Persist before admitting a component or Python CLI. Detached descendants may
// outlive the direct process and its locks. A subsequent boot is the simple,
// explicit recovery boundary; no environment variable can override it.
func recordExecutionBoot(ctx launchContext) error {
	if ctx.Instance.StatePath == "" || ctx.Instance.StateDir == "" || ctx.Instance.ID == "" {
		return errors.New("runtime identity is required before execution")
	}
	if _, err := readExecutionFence(ctx); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	boot, err := readBootSession()
	if err != nil {
		return fmt.Errorf("cannot read the kernel boot identity; no new execution was admitted: %w", err)
	}
	if !validBootSession(boot) {
		return errors.New("kernel boot identity is invalid; no new execution was admitted")
	}
	return writeJSONAtomic(executionFencePath(ctx), executionBootFence{1, ctx.Instance.ID, ctx.Instance.StateDir, boot})
}

func runtimeQuiescent(ctx launchContext, state instanceState) (bool, error) {
	fence, err := readExecutionFence(ctx)
	if errors.Is(err, os.ErrNotExist) {
		return len(state.Components) == 0 && !supervisorMayBeLive(state.Supervisor), nil
	}
	if err != nil {
		return false, err
	}
	boot, err := readBootSession()
	if err != nil || !validBootSession(boot) {
		return false, errors.New("cannot verify the kernel boot identity; quiescence remains unverified")
	}
	if verifiedRuntimeRecordLive(state) {
		return false, nil
	}
	return !strings.EqualFold(fence.BootSession, boot), nil
}

func verifiedRuntimeRecordLive(state instanceState) bool {
	if recordMatchesLiveProcess(state.Supervisor) {
		return true
	}
	for _, record := range state.Components {
		if recordMatchesLiveProcess(record) {
			return true
		}
	}
	return false
}

// stop creates the initial fence for legacy runtimes before asking the user to
// reboot. It never rewrites an existing fence or changes user/registry bytes.
func ensureLegacyExecutionFence(ctx launchContext, state instanceState) error {
	if fence, err := readExecutionFence(ctx); errors.Is(err, os.ErrNotExist) {
		if len(state.Components) > 0 || supervisorMayBeLive(state.Supervisor) {
			if err := recordExecutionBoot(ctx); err != nil {
				return fmt.Errorf("record legacy reboot recovery boundary: %w", err)
			}
		}
		return nil
	} else if err != nil {
		return err
	} else if verifiedRuntimeRecordLive(state) {
		boot, err := readBootSession()
		if err != nil || !validBootSession(boot) {
			return errors.New("cannot verify the boot of a live runtime")
		}
		if !strings.EqualFold(fence.BootSession, boot) {
			// An older launcher can restart after the requested reboot without
			// updating this fence. Re-arm it before terminating that generation.
			return recordExecutionBoot(ctx)
		}
	}
	return nil
}
