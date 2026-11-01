package launcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// temporalHistoryPath selects the only existing history, retaining source
// workspaces created before the installed and source defaults were unified.
// Never guess if both locations or a detached SQLite companion exist.
func temporalHistoryPath(stateDir string) (string, error) {
	root := filepath.Join(stateDir, "temporal.db")
	legacyDir := filepath.Join(stateDir, "temporal")
	legacy := filepath.Join(legacyDir, "temporal.db")
	info, err := os.Lstat(legacyDir)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("inspect Temporal history directory: %w", err)
	}
	if err == nil && (!info.IsDir() || info.Mode()&os.ModeSymlink != 0) {
		return "", errors.New("Temporal history directory is not a regular directory")
	}
	present := make(map[string]bool, 2)
	for _, path := range []string{root, legacy} {
		info, err := os.Lstat(path)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return "", fmt.Errorf("inspect Temporal history: %w", err)
		}
		if err == nil {
			if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
				return "", errors.New("Temporal history is not a regular file")
			}
			present[path] = true
			continue
		}
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, err := os.Lstat(path + suffix); !errors.Is(err, os.ErrNotExist) {
				return "", errors.New("orphaned Temporal SQLite companions exist; preserve them for recovery")
			}
		}
	}
	if present[root] && present[legacy] {
		return "", errors.New("multiple Temporal histories exist; preserve both and resolve the workspace identity")
	}
	if present[legacy] {
		return legacy, nil
	}
	return root, nil
}

func withTemporalHistory(ctx launchContext) (launchContext, error) {
	path, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return ctx, err
	}
	environment := make([]string, 0, len(ctx.Environment)+1)
	for _, value := range ctx.Environment {
		if !strings.HasPrefix(value, "JOBCTRL_TEMPORAL_DB=") {
			environment = append(environment, value)
		}
	}
	ctx.Environment = append(environment, "JOBCTRL_TEMPORAL_DB="+path)
	return ctx, nil
}
