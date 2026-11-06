package launcher

import (
	"errors"
	"fmt"
	"path/filepath"
)

// The installer already authenticated the payload and holds both lifecycle
// locks. Database admission must precede stop or selection changes: a legacy
// workspace is transferred explicitly to a different fresh target workspace.
func CheckWorkspaceSelection(home, payloadRoot string, env []string, initial bool) error {
	env = append(append([]string{}, env...), "JOBCTRL_RUNTIME_HOME="+home)
	inst, err := resolveInstance(env)
	if err != nil {
		return err
	}
	target, err := loadRuntimeManifest(filepath.Join(payloadRoot, "launcher", "runtime-manifest.json"))
	if err != nil {
		return err
	}
	distribution, err := loadAndVerifyDistributionManifest(payloadRoot)
	if err != nil {
		return err
	}
	ctx := launchContext{PayloadRoot: payloadRoot, Instance: inst, Environment: env, Manifest: target, Distribution: distribution}
	if err := refusePendingSourceMigration(ctx); err != nil {
		return err
	}
	if err := refusePendingBridgeHandoff(home); err != nil {
		return err
	}
	verified := verifiedRelease{payloadRoot: payloadRoot, runtime: target, distribution: distribution}
	if initial {
		transferred, err := admitInitialProfileTransfer(ctx, verified)
		if transferred || err != nil {
			return err
		}
	}
	if err := admitPythonApplicationLifecycle(ctx, verified); err != nil {
		return err
	}
	unused, err := unusedDatabasePair(inst.StateDir)
	if err != nil {
		return err
	}
	if unused {
		return nil
	}
	if !usesPythonApplication(target) {
		return errors.New("workspace selection requires the Python application")
	}
	if initial {
		if err := stop(ctx); err != nil {
			return fmt.Errorf("clean up owned workspace before selection: %w", err)
		}
		// Recheck after the native stop proof and before installer publication.
		return admitPythonApplicationLifecycle(ctx, verified)
	}
	return nil
}
