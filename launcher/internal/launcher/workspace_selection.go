package launcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// The caller authenticates the candidate and owns both lifecycle locks. An
// initial selection must not strand schema 14 without its recorded predecessor.
// Reinstallation of schema 15 keeps the live workspace after reboot admission.
func CheckWorkspaceSelection(home, payloadRoot string, env []string, initial bool) error {
	env = append(append([]string{}, env...), "JOBCTRL_RUNTIME_HOME="+home)
	inst, err := resolveInstance(env)
	if err != nil {
		return err
	}
	ctx := launchContext{PayloadRoot: payloadRoot, Instance: inst, Environment: env}
	target, err := loadRuntimeManifest(filepath.Join(payloadRoot, "launcher", "runtime-manifest.json"))
	if err != nil {
		return err
	}
	expectedVersion := int64(15)
	if target.LauncherProtocol == 1 {
		expectedVersion = 14
	} else if target.LauncherProtocol != 2 {
		return errors.New("unsupported target controller for workspace selection")
	}
	appInfo, appErr := os.Lstat(filepath.Join(inst.StateDir, "jobctrl.db"))
	if errors.Is(appErr, os.ErrNotExist) {
		if initial {
			if _, err := os.Lstat(filepath.Join(inst.StateDir, "temporal.db")); err == nil || !errors.Is(err, os.ErrNotExist) {
				return errors.New("existing Temporal data has no application database; preserve the workspace for recovery before installing")
			}
		}
		return nil
	}
	if appErr != nil || !appInfo.Mode().IsRegular() || appInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("existing application database is not a regular owned file; preserve it for inspection")
	}
	if initial {
		if _, err := readExecutionFence(ctx); errors.Is(err, os.ErrNotExist) {
			if err := recordExecutionBoot(ctx); err != nil {
				return err
			}
			return fmt.Errorf("existing workspace requires a stopped-writer boundary; %w; rerun the authenticated installer after reboot", errRebootRequired)
		} else if err != nil {
			return err
		}
		state, stateErr := readState(inst.StatePath)
		if stateErr != nil && !errors.Is(stateErr, os.ErrNotExist) {
			return stateErr
		}
		if stateErr == nil {
			if err := ensureLegacyExecutionFence(ctx, state); err != nil {
				return err
			}
		}
		if quiet, err := runtimeQuiescent(ctx, state); err != nil {
			return err
		} else if !quiet {
			return errRebootRequired
		}
	}
	version, err := jobCtrlSchemaVersion(ctx)
	if err != nil {
		return err
	}
	if version != expectedVersion {
		return errors.New("existing workspace needs its authenticated predecessor selection for migration; preserve its databases and installation metadata, and run the new installer against that original installation")
	}
	return nil
}
