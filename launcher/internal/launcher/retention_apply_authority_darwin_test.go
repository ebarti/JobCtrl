//go:build darwin

package launcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
)

// These authority records and census results are synthetic. The separate
// promotion test exercises the real selector and native completion boundary.
func TestRetentionInstalledApplySyntheticAuthority(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		allow bool
	}{
		{"exact completion", true},
		{"exact completion without registry", true},
		{"prior boot completion", true},
		{"no execution receipt", true},
		{"ordinary execution", true},
		{"unpublished temporary receipt", true},
		{"missing completion", false},
		{"missing completion without registry", false},
		{"malformed receipt", false},
		{"foreign receipt", false},
		{"unsafe execution directory", false},
		{"unsafe completion directory", false},
		{"linked receipt", false},
		{"hardlinked receipt", false},
		{"linked completion", false},
		{"malformed completion", false},
		{"mismatched completion scope", false},
		{"mismatched completion digest", false},
		{"wrong verification boot", false},
		{"active coalition", false},
		{"reaped coalition", true},
		{"unavailable coalition", false},
		{"receipt changed after collection", false},
		{"completion changed after collection", false},
		{"receipt published after collection", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			public, private, python := retentionSigningKey(t)
			prunablePath := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
			if err := os.RemoveAll(prunablePath); err != nil {
				t.Fatal(err)
			}
			fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
			stageSignedRetentionPrior(t, fixture, public, private, python)
			unrelated := stageSignedRetentionRelease(t, fixture.store.Home, "retention-foreign-0005", 5, public, private, python)
			foreign := filepath.Join(fixture.store.Home, "releases", unrelated.BuildID, "payload", "launcher", "foreign-owned.txt")
			if err := os.WriteFile(foreign, []byte("preserve unrelated synthetic bytes"), 0600); err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(scenario.name, "without registry") {
				state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: fixture.instance.ID, CanonicalStateDir: fixture.instance.StateDir,
					PayloadRoot: filepath.Join(fixture.store.Home, "releases", fixture.active.BuildID, "payload"), BuildID: fixture.active.BuildID,
					ManifestSHA256: fixture.active.ManifestSHA256, Components: map[string]componentRecord{}}
				if err := writeState(fixture.instance.StatePath, state); err != nil {
					t.Fatal(err)
				}
			}
			boot, err := executionBootSession()
			if err != nil {
				t.Fatal(err)
			}
			otherBoot := func(boot string) string {
				first := byte('0')
				if boot[0] == '0' {
					first = '1'
				}
				return string(first) + boot[1:]
			}
			id := strings.Repeat("a", 32)
			scope := executionScope{SchemaVersion: 1, ID: id, InstanceID: fixture.instance.ID,
				StateDir: fixture.instance.StateDir, RuntimeHome: fixture.instance.RuntimeHome, BootSession: boot,
				JobLabel: "dev.jobctrl.exec." + fixture.instance.ID + "." + id, Domain: fmt.Sprintf("user/%d", os.Getuid()),
				RootPID: 1001, RootIdentity: "1001:1:0", CoalitionIDs: [2]uint64{12345, 54321}, Purpose: "apply"}
			if scenario.name == "ordinary execution" {
				scope.Purpose = ""
			}
			if scenario.name == "prior boot completion" {
				scope.BootSession = otherBoot(boot)
			}
			executions := filepath.Join(fixture.instance.Dir, "executions")
			completed := filepath.Join(fixture.instance.Dir, "completed-executions")
			receiptPath, completionPath := filepath.Join(executions, id+".json"), filepath.Join(completed, id+".json")
			if scenario.name != "no execution receipt" && scenario.name != "receipt published after collection" {
				if err := os.Mkdir(executions, 0700); err != nil {
					t.Fatal(err)
				}
				if scenario.name == "foreign receipt" {
					scope.InstanceID = strings.Repeat("b", 64)
				}
				if err := writeJSONAtomic(receiptPath, scope); err != nil {
					t.Fatal(err)
				}
			}
			if scenario.name != "no execution receipt" && scenario.name != "receipt published after collection" &&
				scenario.name != "missing completion" && scenario.name != "missing completion without registry" && scenario.name != "ordinary execution" && scenario.name != "unpublished temporary receipt" {
				if err := os.Mkdir(completed, 0700); err != nil {
					t.Fatal(err)
				}
				raw, err := os.ReadFile(receiptPath)
				if err != nil {
					t.Fatal(err)
				}
				proof := executionCompletionForReceipt(scope, raw, boot)
				switch scenario.name {
				case "mismatched completion scope":
					proof.Scope.RootIdentity = "1001:2:0"
				case "mismatched completion digest":
					proof.ReceiptSHA256 = strings.Repeat("0", 64)
				case "wrong verification boot":
					proof.VerificationBootSession = otherBoot(boot)
				}
				if err := writeJSONAtomic(completionPath, proof); err != nil {
					t.Fatal(err)
				}
			}
			switch scenario.name {
			case "malformed receipt":
				if err := os.WriteFile(receiptPath, []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			case "malformed completion":
				if err := os.WriteFile(completionPath, []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			case "unsafe execution directory":
				if err := os.Chmod(executions, 0755); err != nil {
					t.Fatal(err)
				}
			case "unsafe completion directory":
				if err := os.Chmod(completed, 0755); err != nil {
					t.Fatal(err)
				}
			case "unpublished temporary receipt":
				temporary := filepath.Join(executions, "."+id+".json."+strings.Repeat("c", 32))
				if err := os.Rename(receiptPath, temporary); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(temporary, []byte("{"), 0600); err != nil {
					t.Fatal(err)
				}
			case "hardlinked receipt":
				if err := os.Link(receiptPath, filepath.Join(fixture.instance.Dir, "foreign-hardlink")); err != nil {
					t.Fatal(err)
				}
			case "linked completion":
				target := filepath.Join(fixture.instance.Dir, "foreign-completion")
				if err := os.Rename(completionPath, target); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, completionPath); err != nil {
					t.Fatal(err)
				}
			case "linked receipt":
				target := filepath.Join(fixture.instance.Dir, "foreign-receipt")
				if err := os.Rename(receiptPath, target); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, receiptPath); err != nil {
					t.Fatal(err)
				}
			}
			previousCount, previousHook := readCoalitionActiveTaskCount, afterRetentionReferenceCollection
			t.Cleanup(func() { readCoalitionActiveTaskCount, afterRetentionReferenceCollection = previousCount, previousHook })
			readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
				if id != scope.CoalitionIDs[0] || scenario.name == "prior boot completion" {
					return 0, errors.New("unexpected synthetic coalition read")
				}
				switch scenario.name {
				case "active coalition":
					return 1, nil
				case "unavailable coalition":
					return 0, syscall.EPERM
				case "reaped coalition":
					return 0, syscall.ESRCH
				default:
					return 0, nil
				}
			}
			switch scenario.name {
			case "receipt changed after collection", "completion changed after collection":
				path := receiptPath
				if scenario.name == "completion changed after collection" {
					path = completionPath
				}
				afterRetentionReferenceCollection = func() {
					raw, err := os.ReadFile(path)
					if err == nil {
						err = os.Rename(path, path+"-saved")
					}
					if err == nil {
						err = os.WriteFile(path, raw, 0600)
					}
					if err != nil {
						t.Fatalf("replace synthetic authority: %v", err)
					}
				}
			case "receipt published after collection":
				afterRetentionReferenceCollection = func() {
					if err := os.Mkdir(executions, 0700); err != nil {
						t.Fatal(err)
					}
					if err := writeJSONAtomic(receiptPath, scope); err != nil {
						t.Fatal(err)
					}
				}
			}
			err = retainReleases(fixture.store, fixture.instance.StateDir)
			_, statErr := os.Stat(prunablePath)
			if scenario.allow {
				if err != nil || !errors.Is(statErr, os.ErrNotExist) {
					t.Fatalf("safe authority blocked normal pruning: retention=%v release=%v", err, statErr)
				}
			} else if err == nil || statErr != nil {
				t.Fatalf("uncertain authority permitted pruning: retention=%v release=%v", err, statErr)
			}
			if raw, err := os.ReadFile(foreign); err != nil || string(raw) != "preserve unrelated synthetic bytes" {
				t.Fatalf("unrelated release contents changed: %q %v", raw, err)
			}
		})
	}
}
