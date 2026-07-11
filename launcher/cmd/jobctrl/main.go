package main

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
)

func main() {
	executable, err := installedExecutable()
	if err != nil {
		fmt.Fprintln(os.Stderr, "jobctrl:", err)
		os.Exit(1)
	}
	if err := launcher.Run(executable, os.Args[1:], os.Environ(), os.Stdout, os.Stderr); err != nil {
		fmt.Fprintln(os.Stderr, "jobctrl:", err)
		os.Exit(launcher.ExitCode(err))
	}
}

// installedExecutable deliberately ignores argv[0] and does not re-resolve a
// mutable PATH after process start. PATH and Homebrew shims may leave argv[0]
// or os.Executable() bare; the kernel's current-process path is the authority
// used to bind lifecycle re-exec to the payload that is already running.
func installedExecutable() (string, error) {
	executable, kernelErr := launcher.CurrentProcessExecutable()
	if kernelErr != nil {
		var osErr error
		executable, osErr = os.Executable()
		if osErr != nil {
			return "", fmt.Errorf("locate running launcher executable (kernel: %v): %w", kernelErr, osErr)
		}
		if !filepath.IsAbs(executable) {
			return "", fmt.Errorf("kernel executable lookup failed (%v) and os.Executable returned non-absolute path %q", kernelErr, executable)
		}
	}
	if !filepath.IsAbs(executable) {
		return "", fmt.Errorf("kernel returned non-absolute launcher executable path %q", executable)
	}
	executable, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("canonicalize running launcher executable: %w", err)
	}
	return executable, nil
}
