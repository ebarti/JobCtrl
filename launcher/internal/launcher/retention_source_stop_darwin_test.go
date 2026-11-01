//go:build darwin

package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

type syntheticStoppedSource struct {
	fixture       retentionFixture
	ctx           launchContext
	scope         executionScope
	completion    executionCompletion
	completionRaw []byte
	completedPath string
	referenced    string
	count         *uint64
	countErr      *error
}

// completeStoppedState is exercised on synthetic metadata after a simulated
// zero-census precondition; the bootout and scope counter are test seams. This
// verifies the native writer's file contract, not actual process cleanup.
func newSyntheticStoppedSource(t *testing.T, previousBoot bool) syntheticStoppedSource {
	t.Helper()
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	if err := os.RemoveAll(filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	stageSignedRetentionPrior(t, fixture, public, private, python)
	referenced := stageSignedRetentionRelease(t, fixture.store.Home, "retention-stopped-pair-0004", 4, public, private, python)
	writeRetentionPair(t, fixture.instance.StateDir, "pair-stopped-source", referenced)

	sourceRoot, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(sourceRoot, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	script := []byte("#!/bin/sh\n# synthetic stopped source\n")
	if err := os.WriteFile(filepath.Join(sourceRoot, "scripts", "dev"), script, 0o700); err != nil {
		t.Fatal(err)
	}
	boot, err := executionBootSession()
	if err != nil {
		t.Fatal(err)
	}
	birthBoot := boot
	if previousBoot {
		first := byte('0')
		if boot[0] == '0' {
			first = '1'
		}
		birthBoot = string(first) + boot[1:]
	}
	id := strings.Repeat("c", 32)
	scope := executionScope{SchemaVersion: 1, ID: id, InstanceID: fixture.instance.ID,
		StateDir: fixture.instance.StateDir, RuntimeHome: fixture.instance.RuntimeHome, BootSession: birthBoot,
		JobLabel: "dev.jobctrl.exec." + fixture.instance.ID + "." + id, Domain: fmt.Sprintf("user/%d", os.Getuid()),
		RootPID: 1001, RootIdentity: "1001:1:0", CoalitionIDs: [2]uint64{12345, 54321}, Purpose: "source"}
	started := time.Now().UTC().Add(-time.Minute)
	digest := sha256.Sum256(script)
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: fixture.instance.ID,
		CanonicalStateDir: fixture.instance.StateDir, PayloadRoot: sourceRoot, BuildID: "source",
		ManifestSHA256: hex.EncodeToString(digest[:]), StartedAt: started, ExecutionScopeID: scope.ID,
		Components: map[string]componentRecord{}}
	if err := writeState(fixture.instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: fixture.instance}
	for _, dir := range []string{"executions", "source-runs"} {
		if err := os.Mkdir(filepath.Join(fixture.instance.Dir, dir), 0o700); err != nil {
			t.Fatal(err)
		}
	}
	if err := writeJSONAtomic(filepath.Join(fixture.instance.Dir, "executions", id+".json"), scope); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(fixture.instance.Dir, "source-runs", id+".json"), sourceExecutionMarker{1, fixture.instance.ID, id}); err != nil {
		t.Fatal(err)
	}
	oldBootout, oldCount := bootoutOwnedExecution, readCoalitionActiveTaskCount
	t.Cleanup(func() { bootoutOwnedExecution, readCoalitionActiveTaskCount = oldBootout, oldCount })
	bootouts := 0
	bootoutOwnedExecution = func(domain, label string) error {
		if domain != scope.Domain || label != scope.JobLabel {
			return errors.New("unexpected synthetic execution label")
		}
		bootouts++
		return nil
	}
	var count uint64
	var countErr error
	readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
		if id != scope.CoalitionIDs[0] {
			return 0, errors.New("unexpected synthetic coalition")
		}
		return count, countErr
	}
	if err := completeStoppedState(ctx, state); err != nil || bootouts != 1 {
		t.Fatalf("synthetic native stop writer failed: %v", err)
	}
	stopped, err := readState(fixture.instance.StatePath)
	if err != nil || !stopped.OwnershipVerified || stopped.StoppedAt == nil {
		t.Fatalf("native stop did not write the stopped registry: %v", err)
	}
	completion, err := readExecutionCompletion(ctx, id)
	if err != nil || completion.Scope != scope || completion.VerificationBootSession != boot ||
		!completion.CompletedAt.Before(*stopped.StoppedAt) {
		t.Fatalf("native stop did not publish completion before the stopped registry: %v", err)
	}
	if proven, err := sourceScopedExecutionProven(ctx); err != nil || !proven {
		t.Fatalf("native source authority did not accept its stopped completion: %v", err)
	}
	path := filepath.Join(fixture.instance.Dir, "completed-executions", id+".json")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return syntheticStoppedSource{fixture, ctx, scope, completion, raw, path, referenced.BuildID, &count, &countErr}
}

func TestRetentionAcceptsNativeStoppedSourceCompletion(t *testing.T) {
	for _, scenario := range []string{"same boot native stop", "cross boot native stop", "cross boot independent of stop order"} {
		t.Run(scenario, func(t *testing.T) {
			crossBoot := scenario != "same boot native stop"
			f := newSyntheticStoppedSource(t, crossBoot)
			if crossBoot && f.completion.VerificationBootSession == f.scope.BootSession {
				t.Fatal("synthetic cross-boot case did not separate birth and verification boot")
			}
			if scenario == "cross boot independent of stop order" {
				state, err := readState(f.ctx.Instance.StatePath)
				if err != nil {
					t.Fatal(err)
				}
				before := f.completion.CompletedAt.Add(-time.Second)
				state.StoppedAt = &before
				if err := writeState(f.ctx.Instance.StatePath, state); err != nil {
					t.Fatal(err)
				}
			}
			if err := retainReleases(f.fixture.store, f.ctx.Instance.StateDir); err != nil {
				t.Fatalf("native stopped source completion prevented retention: %v", err)
			}
			if _, err := os.Lstat(filepath.Join(f.fixture.store.Home, "releases", f.fixture.prunable.BuildID)); !os.IsNotExist(err) {
				t.Fatalf("unreferenced signed release was not pruned: %v", err)
			}
			if _, err := os.Stat(filepath.Join(f.fixture.store.Home, "releases", f.referenced, "receipt.json")); err != nil {
				t.Fatalf("backup-referenced release was removed: %v", err)
			}
		})
	}
}

func TestRetentionStoppedSourceRejectsUncertainAuthority(t *testing.T) {
	f := newSyntheticStoppedSource(t, false)
	for _, scenario := range []string{"missing", "malformed", "wrong purpose", "foreign workspace", "mismatched digest", "invalid verification boot", "contradictory verification boot", "active scope", "unavailable scope", "replaced after collection"} {
		t.Run(scenario, func(t *testing.T) {
			swapped := false
			t.Cleanup(func() {
				*f.count, *f.countErr, afterRetentionReferenceCollection = 0, nil, nil
				if swapped {
					_ = os.Remove(f.completedPath)
					_ = os.Rename(f.completedPath+"-saved", f.completedPath)
				} else {
					_ = os.WriteFile(f.completedPath, f.completionRaw, 0o600)
				}
			})
			changed := f.completion
			switch scenario {
			case "missing":
				if err := os.Remove(f.completedPath); err != nil {
					t.Fatal(err)
				}
			case "malformed":
				if err := os.WriteFile(f.completedPath, []byte("{"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "wrong purpose", "foreign workspace", "mismatched digest", "invalid verification boot", "contradictory verification boot":
				switch scenario {
				case "wrong purpose":
					changed.Scope.Purpose = "apply"
				case "foreign workspace":
					changed.Scope.StateDir = t.TempDir()
				case "invalid verification boot":
					changed.VerificationBootSession = "invalid"
				case "contradictory verification boot":
					first := byte('0')
					if changed.VerificationBootSession[0] == '0' {
						first = '1'
					}
					changed.VerificationBootSession = string(first) + changed.VerificationBootSession[1:]
				}
				raw, err := json.Marshal(changed.Scope)
				if err != nil {
					t.Fatal(err)
				}
				digest := sha256.Sum256(append(raw, '\n'))
				changed.ReceiptSHA256 = hex.EncodeToString(digest[:])
				if scenario == "mismatched digest" {
					changed.ReceiptSHA256 = strings.Repeat("a", 64)
				}
				if err := writeJSONAtomic(f.completedPath, changed); err != nil {
					t.Fatal(err)
				}
			case "active scope":
				*f.count = 1
			case "unavailable scope":
				*f.countErr = syscall.EPERM
			case "replaced after collection":
				afterRetentionReferenceCollection = func() {
					afterRetentionReferenceCollection = nil
					if err := os.Rename(f.completedPath, f.completedPath+"-saved"); err != nil {
						t.Fatal(err)
					}
					swapped = true
					if err := os.WriteFile(f.completedPath, f.completionRaw, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := retainReleases(f.fixture.store, f.ctx.Instance.StateDir); err == nil {
				t.Fatal("uncertain stopped source authority permitted pruning")
			}
			for _, build := range []string{f.fixture.prunable.BuildID, f.referenced} {
				if _, err := os.Stat(filepath.Join(f.fixture.store.Home, "releases", build)); err != nil {
					t.Fatalf("uncertain authority removed release %s: %v", build, err)
				}
			}
		})
	}
	// Ensure the rejected mutations did not permanently alter the proof.
	if got, err := os.ReadFile(f.completedPath); err != nil || !bytes.Equal(got, f.completionRaw) {
		t.Fatalf("synthetic completion was not restored: %v", err)
	}
}
