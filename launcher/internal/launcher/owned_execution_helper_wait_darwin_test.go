//go:build darwin

package launcher

import (
	"io"
	"os/exec"
	"strings"
	"testing"
)

func TestOrdinaryExecutionRequiresHelperExit(t *testing.T) {
	// The child is owned by this test and exits on the private pipe's EOF.
	// No numeric PID is used to signal or clean it up.
	child := exec.Command("/bin/cat")
	input, err := child.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	child.Stdout = io.Discard
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = input.Close()
		_ = child.Wait()
	}()
	identity, err := processStartIdentity(child.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	err = attestFinishedOrdinaryExecution(launchContext{}, executionScope{
		RootPID: child.Process.Pid, RootIdentity: identity,
	})
	if err == nil || !strings.Contains(err.Error(), "helper did not exit") {
		t.Fatalf("live helper was not reported as an incomplete execution: %v", err)
	}
}
