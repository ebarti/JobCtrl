//go:build darwin

package launcher

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestPayloadQASandboxKeepsExactProfileAndArguments(t *testing.T) {
	arguments := []string{"-I", "argument with spaces", "literal<&>\nvalue"}
	command := payloadCommand([]string{executionQASandboxVariable + "=" + executionQASandboxSelector}, "/owned/python", arguments...)
	want := append([]string{"/usr/bin/sandbox-exec", "-p", executionQASandboxProfile, "/owned/python"}, arguments...)
	if command.Err != nil || command.Path != "/usr/bin/sandbox-exec" || !reflect.DeepEqual(command.Args, want) {
		t.Fatalf("fixed profile or literal payload arguments changed: %v, %q", command.Err, command.Args)
	}
	plain := payloadCommand([]string{"PATH=/usr/bin:/bin"}, "/owned/python", arguments...)
	if plain.Err != nil || plain.Path != "/owned/python" || !reflect.DeepEqual(plain.Args, append([]string{"/owned/python"}, arguments...)) {
		t.Fatalf("normal payload dispatch changed: %v, %q", plain.Err, plain.Args)
	}
}

func TestPayloadUnknownQASandboxNeverExecutes(t *testing.T) {
	marker := filepath.Join(t.TempDir(), "must-not-exist")
	environment := []string{executionQASandboxVariable + "=untrusted-profile"}
	command := payloadCommand(environment, "/usr/bin/touch", marker)
	if err := command.Run(); err == nil || !strings.Contains(err.Error(), "unknown execution QA sandbox restriction") {
		t.Fatalf("unknown payload restriction did not fail closed: %v", err)
	}
	if err := execPayload(environment, "/usr/bin/touch", marker); err == nil || !strings.Contains(err.Error(), "unknown execution QA sandbox restriction") {
		t.Fatalf("unknown exec restriction did not fail closed: %v", err)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatalf("refused payload ran: %v", err)
	}
}
