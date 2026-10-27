package installer

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Call with the release transition lock held. Any entry at this path is an
// unresolved legacy handoff, including malformed files and symlinks. Preserve
// it for inspection; ordinary installation must not guess how to repair it.
func refusePendingBridgeHandoff(home string) error {
	_, err := os.Lstat(filepath.Join(home, "bridge-handoff.json"))
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("inspect bridge handoff: %w", err)
	}
	return errors.New("unfinished bridge handoff requires inspection; preserve the installation metadata and live workspace")
}
