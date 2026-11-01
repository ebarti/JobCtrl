package launcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// A handoff intent is an installer-owned, forward-only operation. Runtime
// commands cannot interpret, change, or remove it; even an unreadable or
// malformed intent must be preserved for the installer to inspect.
var errPendingBridgeHandoff = errors.New("bridge handoff requires installer recovery; runtime operations are blocked")

func refusePendingBridgeHandoff(runtimeHome string) error {
	if runtimeHome == "" {
		return errors.New("runtime home is required to inspect bridge handoff")
	}
	_, err := os.Lstat(filepath.Join(runtimeHome, "bridge-handoff.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect bridge handoff: %w", err)
	}
	return errPendingBridgeHandoff
}
