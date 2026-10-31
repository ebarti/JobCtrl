//go:build darwin

package launcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// releaseQACheckpoint is an opt-in pause for crash-testing the actual signed
// binary. It can only stop the current process, after its journal was synced;
// it cannot admit a release, alter migration decisions, or grant authority.
// Both the runtime and data directories must be inside a marked temporary root.
func releaseQACheckpoint(store *release.Store, state release.State) error {
	if os.Getenv("JOBCTRL_RELEASE_QA_PAUSE") != string(state) {
		return nil
	}
	root, err := filepath.EvalSymlinks(os.Getenv("JOBCTRL_RELEASE_QA_ROOT"))
	if err != nil {
		return errors.New("release QA checkpoint requires an existing temporary root")
	}
	temp, err := filepath.EvalSymlinks(os.TempDir())
	if err != nil || !releaseQAWithin(temp, root) {
		return errors.New("release QA root must be inside the system temporary directory")
	}
	marker := filepath.Join(root, ".jobctrl-release-qa")
	info, err := os.Lstat(marker)
	if err != nil || !info.Mode().IsRegular() || info.Size() > 128 {
		return errors.New("release QA root is missing its regular fixture marker")
	}
	contents, err := os.ReadFile(marker)
	if err != nil || string(contents) != "jobctrl-release-qa-v1\n" {
		return errors.New("release QA fixture marker is invalid")
	}
	for _, directory := range []string{store.Home, os.Getenv("JOBCTRL_DIR")} {
		resolved, err := filepath.EvalSymlinks(directory)
		if err != nil || !releaseQAWithin(root, resolved) {
			return errors.New("release QA requires a runtime and workspace inside its fixture root")
		}
	}
	if _, err := fmt.Fprintf(os.Stderr, "jobctrl-release-qa-checkpoint:%s\n", state); err != nil {
		return err
	}
	return syscall.Kill(os.Getpid(), syscall.SIGSTOP)
}

func releaseQAWithin(root, value string) bool {
	relative, err := filepath.Rel(root, value)
	return err == nil && relative != "." && relative != ".." && !filepath.IsAbs(relative) && !strings.HasPrefix(relative, ".."+string(filepath.Separator))
}
