package launcher

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

var homebrewCodeSignCommand = func(path string, args ...string) (string, error) {
	output, err := exec.Command(path, args...).CombinedOutput()
	return string(output), err
}

// Homebrew's build sandbox cannot consult Apple's syspolicy service. The
// formula verifies strict Developer ID signatures before caching its binaries;
// this normal-user boundary requires live notarization before running the
// installer. That installer verifies the entire payload before activation.
func verifyHomebrewBootstrapNotarization(root string) error {
	for _, name := range []string{"jobctrl", "jobctrl-installer"} {
		target := filepath.Join(root, name)
		info, err := os.Lstat(target)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode()&0o111 == 0 {
			return fmt.Errorf("Homebrew bootstrap %s is not a regular executable", name)
		}
		output, err := homebrewCodeSignCommand("/usr/bin/codesign", "--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=2", target)
		if err != nil {
			return fmt.Errorf("Homebrew bootstrap notarization verification failed for %s: %w: %s", name, err, output)
		}
	}
	return nil
}
