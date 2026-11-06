package launcher

import (
	"errors"
	"fmt"
	"os"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// Revocation blocks new work, not native cleanup of existing owned writers.
// Only an exact stop from authenticated selector bytes may use this evidence
// route; generic preparation still requires execution permission.
func stopUnsafeActiveBeforePrepare(executable string, args, env []string) (bool, error) {
	if len(args) != 1 || args[0] != "stop" {
		return false, nil
	}
	home, err := runtimeHomeFromEnv(env)
	if err != nil {
		return false, nil
	}
	store, err := release.Open(home)
	if err != nil {
		return true, err
	}
	selection, err := store.SelectionLock(false)
	if err != nil {
		return true, err
	}
	defer selection.Close()
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return true, err
	}
	journal, err := store.ReadJournal()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return true, fmt.Errorf("authenticate transition before native stop: %w", err)
	}
	if err == nil && journal.Resumable() {
		return false, nil // The existing transition-specific cleanup owns this case.
	}
	active, err := store.ReadActive()
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return true, err
	}
	selector, err := readInstalledReceipt(store.Home, active.SelectorBuildID)
	if err != nil {
		return true, err
	}
	if selector.Channel != active.Receipt.Channel || selector.Sequence < active.Receipt.Sequence {
		return true, errors.New("native stop selector does not bind the selected release channel and sequence")
	}
	policy, err := store.ReadChannelState(active.Receipt.Channel)
	if err != nil {
		return true, err
	}
	if policy.Permit(active.Receipt) == nil && policy.Permit(selector) == nil {
		return false, nil
	}
	// Only revocation and the safety floor are execution-only fences. Retain all
	// sequence/build/descriptor identity checks against this same policy snapshot.
	// This copy never changes the persisted policy or grants an execution route.
	evidencePolicy := policy
	evidencePolicy.MinimumSafeSequence = 0
	evidencePolicy.RevokedBuildIDs = map[string]bool{}
	for _, receipt := range []release.Receipt{active.Receipt, selector} {
		if err := evidencePolicy.Permit(receipt); err != nil {
			return true, fmt.Errorf("authenticate native stop channel identity: %w", err)
		}
	}
	current, err := verifyInstalledReleaseEvidence(store, active.Receipt, false)
	if err != nil {
		return true, err
	}
	if err := readPythonApplicationSchemaContract(current); err != nil {
		return true, err
	}
	controller := current
	if selector != active.Receipt {
		controller, err = verifyInstalledReleaseEvidence(store, selector, false)
		if err != nil {
			return true, err
		}
		if err := readPythonApplicationSchemaContract(controller); err != nil {
			return true, err
		}
	}
	if !selectorMatchesEvidence(store.Home, controller) {
		return true, errors.New("native stop selector differs from its authenticated release evidence")
	}
	// A same-build Homebrew frontend contains these exact authenticated launcher
	// bytes. It may stop directly without acquisition, staging or another exec.
	// An unmatched frontend or foreign executable gets no cleanup exception.
	controllerContext := launchContext{Distribution: controller.distribution, Instance: instance{RuntimeHome: store.Home}}
	if err := verifyOwnedExecutionExecutable(controllerContext, executable); err != nil {
		return true, fmt.Errorf("authenticate native stop controller: %w", err)
	}
	cleanupEnv := append(append([]string{}, env...), "JOBCTRL_RUNTIME_HOME="+store.Home)
	instance, err := resolveInstance(cleanupEnv)
	if err != nil {
		return true, err
	}
	ctx := verifiedReleaseContext(launchContext{Instance: instance, Environment: cleanupEnv}, current)
	return true, stop(ctx)
}
