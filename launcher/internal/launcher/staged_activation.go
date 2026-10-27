package launcher

import (
	"errors"
	"io"
	"os"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// PromoteStagedRelease lets the newly authenticated installer own activation
// instead of handing migration decisions back to an immutable old launcher.
// Both acquisition adapters use the same signed receipts and lifecycle locks.
func PromoteStagedRelease(home, build, source string, env []string, output io.Writer) error {
	if source != "homebrew" && source != "curl" {
		return errors.New("staged activation requires an authenticated acquisition adapter")
	}
	store, err := release.Open(home)
	if err != nil {
		return err
	}
	candidate, err := readInstalledReceipt(store.Home, build)
	if err != nil {
		return err
	}
	env = append(append([]string{}, env...), "JOBCTRL_RUNTIME_HOME="+store.Home, "JOBCTRL_ACQUISITION_SOURCE="+source)
	if journal, err := store.ReadJournal(); err == nil && journal.Resumable() {
		if err := handoffRecoveryController(store, candidate); err != nil {
			return err
		}
		if handled, err := recoverRevokedTransitionBeforePrepare(env, output); handled {
			if err != nil {
				return err
			}
		} else if _, err := recoverInterruptedTransitionBeforeBootstrap(env, output); err != nil {
			return err
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	active, err := store.ReadActive()
	if err != nil {
		return err
	}
	if err := VerifyPublicSelectorForExecution(store.Home); err != nil {
		return err
	}
	ctx, err := transitionContextForReceipt(env, store, candidate)
	if err != nil {
		return err
	}
	return promoteExisting(ctx, store, active, build, "update", output)
}
