package launcher

import (
	"errors"
	"os"
	"path/filepath"
)

// A selected installation need not have been started yet. Only absence of both
// databases and every SQLite sidecar establishes that initialization is safe.
func unusedDatabasePair(stateDir string) (bool, error) {
	present := 0
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		info, err := os.Lstat(filepath.Join(stateDir, name))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return false, err
		}
		if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return false, errors.New("release database pair contains an unsafe file")
		}
		present++
	}
	if present == 2 {
		return false, nil
	}
	if present != 0 {
		return false, errors.New("release database pair is incomplete; preserve existing data and recover it before updating")
	}
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, err := os.Lstat(filepath.Join(stateDir, name+suffix)); !errors.Is(err, os.ErrNotExist) {
				return false, errors.New("unused installation has orphaned SQLite sidecars; preserve them before recovery")
			}
		}
	}
	return true, nil
}
