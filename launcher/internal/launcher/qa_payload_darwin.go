//go:build darwin

package launcher

import (
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func validateExecutionQASandbox(environment []string) error {
	selector := environmentMap(environment)[executionQASandboxVariable]
	if selector != "" && selector != executionQASandboxSelector {
		return errors.New("unknown execution QA sandbox restriction")
	}
	return nil
}

// Native control must stay outside Seatbelt to manage launchd scopes. Apply
// the fixed, additional QA restriction at each payload boundary instead. This
// cannot remove a sandbox inherited from an already-restricted caller.
func payloadCommand(environment []string, executable string, arguments ...string) *exec.Cmd {
	effectiveEnvironment := environment
	if effectiveEnvironment == nil {
		effectiveEnvironment = os.Environ()
	}
	command := exec.Command(executable, arguments...)
	command.Env = environment
	if err := validateExecutionQASandbox(effectiveEnvironment); err != nil {
		command.Err = err
		return command
	}
	if environmentMap(effectiveEnvironment)[executionQASandboxVariable] == executionQASandboxSelector {
		arguments = append([]string{"-p", executionQASandboxProfile, executable}, arguments...)
		command = exec.Command("/usr/bin/sandbox-exec", arguments...)
		command.Env = environment
	}
	return command
}

func execPayload(environment []string, executable string, arguments ...string) error {
	command := payloadCommand(environment, executable, arguments...)
	if command.Err != nil {
		return command.Err
	}
	return syscall.Exec(command.Path, command.Args, environment)
}
