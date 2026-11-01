package launcher

import (
	"errors"
	"fmt"
	"path/filepath"
)

// The caller authenticates the candidate and owns both lifecycle locks. An
// initial selection must not strand schema 14 without its recorded predecessor.
// Reinstallation of schema 15 keeps the live workspace after cleanup admission.
func CheckWorkspaceSelection(home, payloadRoot string, env []string, initial bool) error {
	env = append(append([]string{}, env...), "JOBCTRL_RUNTIME_HOME="+home)
	inst, err := resolveInstance(env)
	if err != nil {
		return err
	}
	ctx := launchContext{PayloadRoot: payloadRoot, Instance: inst, Environment: env}
	if err := refusePendingSourceMigration(ctx); err != nil {
		return err
	}
	if err := requireLegacySourceOwnership(ctx); err != nil {
		return err
	}
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
	unused, err := unusedDatabasePair(inst.StateDir)
	if err != nil {
		return err
	}
	if unused {
		return nil
	}
	if initial {
		if err := stop(ctx); err != nil {
			return fmt.Errorf("clean up existing workspace before selection: %w", err)
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
