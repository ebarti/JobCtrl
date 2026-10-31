// jobctrl-source is the locally trusted development lifecycle controller.
package main

import (
	"fmt"
	"os"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
)

func main() {
	executable, err := launcher.CurrentProcessExecutable()
	if err == nil {
		err = launcher.RunSource(executable, os.Args[1:], os.Environ(), os.Stdout, os.Stderr)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "jobctrl development:", err)
		os.Exit(launcher.ExitCode(err))
	}
}
