//go:build darwin

package launcher

import (
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

func isApplyExecution(args []string) bool {
	return len(args) == 1 && args[0] == applyWorkerArgument
}

func authenticatedApplyExecution(ctx launchContext) (bool, error) {
	owned, err := authenticatedOwnedExecution(ctx)
	if err != nil || !owned {
		return false, err
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return false, err
	}
	for _, scope := range scopes {
		if scope.ID == environmentMap(ctx.Environment)[executionScopeVariable] {
			return scope.Purpose == "apply", nil
		}
	}
	return false, errors.New("Apply execution receipt is missing")
}

// The private Apply command has finished. Join its helper and retire only its
// exact receipt after either its durable completion proof or a zero census.
// Other scopes may remain live.
func completeApplyExecution(ctx launchContext, scope executionScope) error {
	if exited, err := waitExecutionRoot(scope.RootPID, scope.RootIdentity, shutdownTimeout); err != nil {
		return err
	} else if !exited {
		return errors.New("Apply execution helper did not exit")
	}
	controlPath := ctx.Instance.ControlPath
	if controlPath == "" {
		controlPath = filepath.Join(filepath.Dir(ctx.Instance.StatePath), "control.lock")
	}
	lock, err := acquireLock(controlPath, false)
	if err != nil {
		return err
	}
	defer releaseLock(lock)
	if err := validateExecutionScope(ctx, scope); err != nil {
		return err
	}
	boot, err := executionBootSession()
	if err != nil || boot != scope.BootSession {
		return errors.Join(errors.New("Apply scope boot identity changed"), err)
	}
	raw, err := json.Marshal(scope)
	if err != nil {
		return err
	}
	expected := executionCompletionForReceipt(scope, append(raw, '\n'), boot)
	completion, completionErr := readExecutionCompletion(ctx, scope.ID)
	proved := completionErr == nil && scope.Purpose == "apply"
	if completionErr != nil && !errors.Is(completionErr, os.ErrNotExist) {
		return completionErr
	}
	if proved && (completion.Scope != scope || completion.ReceiptSHA256 != expected.ReceiptSHA256 || completion.VerificationBootSession != boot) {
		return errors.New("Apply execution completion does not match its exact receipt and boot")
	}
	if !proved {
		if zero, err := waitExecutionMembers(scope.CoalitionIDs, shutdownTimeout); err != nil {
			return err
		} else if !zero {
			return errors.New("Apply execution retained owned descendants")
		}
	}
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return err
	}
	for _, active := range scopes {
		if active.ID != scope.ID {
			continue
		}
		if active != scope {
			return errors.New("Apply execution receipt changed before completion")
		}
		return retireExecutionScopes(ctx, []executionScope{scope}, false, false)
	}
	// A concurrent ordinary Stop may have completed and retired this exact
	// receipt while the controller was joining its helper. Absence alone is
	// never completion; require the exact original bytes' durable proof.
	if !proved {
		return errors.Join(errors.New("Apply execution receipt disappeared without its exact completion"), completionErr)
	}
	return nil
}

// The trusted native helper has joined/drained the command and will return
// without launching further work. Persist the exact proof before reporting a
// result, so losing the activity controller at any later point cannot strand
// verified custody. The controller or ordinary Stop retires the active label.
func attestApplyHelperCompletion(environment []string, ids [2]uint64) error {
	instance, err := resolveInstance(environment)
	if err != nil {
		return err
	}
	ctx := launchContext{Instance: instance, Environment: environment}
	lock, err := acquireLock(instance.ControlPath, false)
	if err != nil {
		return err
	}
	defer releaseLock(lock)
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return err
	}
	boot, err := executionBootSession()
	if err != nil {
		return err
	}
	identity, err := processStartIdentity(os.Getpid())
	if err != nil {
		return err
	}
	for _, scope := range scopes {
		if scope.ID != environmentMap(environment)[executionScopeVariable] {
			continue
		}
		if scope.Purpose != "apply" || scope.RootPID != os.Getpid() || scope.RootIdentity != identity || scope.CoalitionIDs != ids || scope.BootSession != boot {
			return errors.New("completed Apply helper does not own its receipt")
		}
		if zero, err := waitExecutionMembers(ids, shutdownTimeout); err != nil {
			return err
		} else if !zero {
			return errors.New("completed Apply scope retained descendants")
		}
		dir, err := executionScopeDirectory(ctx, false)
		if err != nil {
			return err
		}
		file, err := os.OpenFile(filepath.Join(dir, scope.ID+".json"), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
		if err != nil {
			return err
		}
		raw, err := io.ReadAll(io.LimitReader(file, 16385))
		file.Close()
		var current executionScope
		if err != nil || decodeExecutionReceipt(raw, &current) != nil || current != scope {
			return errors.Join(errors.New("completed Apply receipt changed"), err)
		}
		return publishExecutionCompletion(ctx, executionCompletionForReceipt(scope, raw, boot))
	}
	return errors.New("completed Apply execution receipt is missing")
}
