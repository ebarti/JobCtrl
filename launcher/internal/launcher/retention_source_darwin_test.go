//go:build darwin

package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"
)

func TestRetentionPreservesSourceMigrationBackups(t *testing.T) {
	for _, legacy := range []bool{false, true} {
		name := "shared Temporal history"
		if legacy {
			name = "legacy source Temporal history"
		}
		t.Run(name, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			public, private, python := retentionSigningKey(t)
			dir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
			if err := os.RemoveAll(dir); err != nil {
				t.Fatal(err)
			}
			fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
			stageSignedRetentionPrior(t, fixture, public, private, python)
			temporal := filepath.Join(fixture.instance.StateDir, "temporal.db")
			if legacy {
				temporal = filepath.Join(fixture.instance.StateDir, "temporal", "temporal.db")
				if err := os.Mkdir(filepath.Dir(temporal), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			database := filepath.Join(fixture.instance.StateDir, "jobctrl.db")
			code := `import sqlite3,sys
for path,version in ((sys.argv[1],14),(sys.argv[2],0)):
 c=sqlite3.connect(path);c.execute('create table t(v text)');c.execute('insert into t values(?)',('synthetic',));c.execute('pragma user_version='+str(version));c.commit();c.close()`
			if output, err := exec.Command(python, "-I", "-B", "-c", code, database, temporal).CombinedOutput(); err != nil {
				t.Fatalf("seed synthetic source workspace: %v %s", err, output)
			}
			id := strings.Repeat("a", 32)
			journal := sourceMigrationJournal{SchemaVersion: 1, ID: id, SourceVersion: 14, Stage: "starting"}
			ctx := launchContext{Instance: fixture.instance, SourcePython: python}
			source, err := sourceSnapshotPair(ctx, journal, temporal)
			if err != nil {
				t.Fatalf("create owned source migration backup: %v", err)
			}
			backupDir := filepath.Dir(source)
			metadataPath := filepath.Join(backupDir, "source-pair.json")
			metadata, err := os.ReadFile(metadataPath)
			if err != nil {
				t.Fatal(err)
			}
			backupDigests := lifecycleDatabaseDigests(t, backupDir)
			liveDatabase, err := sha256Path(database)
			if err != nil {
				t.Fatal(err)
			}
			liveTemporal, err := sha256Path(temporal)
			if err != nil {
				t.Fatal(err)
			}
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
				t.Fatalf("source backup prevented retention: %v", err)
			}
			if _, err := os.Lstat(dir); !os.IsNotExist(err) {
				t.Fatalf("unreferenced signed release was not pruned: %v", err)
			}
			if got, err := os.ReadFile(metadataPath); err != nil || !bytes.Equal(got, metadata) {
				t.Fatalf("source backup metadata changed: %v", err)
			}
			if got := lifecycleDatabaseDigests(t, backupDir); !reflect.DeepEqual(got, backupDigests) {
				t.Fatal("source backup pair bytes changed")
			}
			if got, err := sha256Path(database); err != nil || got != liveDatabase {
				t.Fatalf("live synthetic application database changed: %v", err)
			}
			if got, err := sha256Path(temporal); err != nil || got != liveTemporal {
				t.Fatalf("live synthetic Temporal history changed: %v", err)
			}
		})
	}
}

func TestRetentionRefusesUnverifiedSourceRuntimeRegistry(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	dir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	stageSignedRetentionPrior(t, fixture, public, private, python)
	other, err := resolveInstance([]string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + fixture.instance.RuntimeHome, "JOBCTRL_DIR=" + filepath.Join(t.TempDir(), "source-workspace")})
	if err != nil {
		t.Fatal(err)
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: other.ID, CanonicalStateDir: other.StateDir, PayloadRoot: t.TempDir(), BuildID: "source", ManifestSHA256: strings.Repeat("a", 64), Components: map[string]componentRecord{}}
	if err := writeState(other.StatePath, state); err != nil {
		t.Fatal(err)
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
		t.Fatal("unverified source registry silently permitted pruning")
	}
	if _, err := os.Stat(filepath.Join(dir, "receipt.json")); err != nil {
		t.Fatalf("unverified source registry allowed a release to be removed: %v", err)
	}
}

// These are synthetic authority records and a synthetic scope counter. They
// test retention's receipt binding without claiming a real native completion.
func TestRetentionSyntheticCompletedExecutionAuthority(t *testing.T) {
	// These controls invoke the native completion writer on owned synthetic
	// scope metadata. The bootout and coalition counter remain test-only seams;
	// the different birth boot is simulated without rebooting the machine.
	attachPrior := func(t *testing.T, f syntheticStoppedSource, birthBoot string) executionScope {
		t.Helper()
		scope := f.scope
		scope.ID = strings.Repeat("d", 32)
		scope.JobLabel = "dev.jobctrl.exec." + scope.InstanceID + "." + scope.ID
		scope.RootPID, scope.RootIdentity = 1002, "1002:1:0"
		scope.CoalitionIDs, scope.BootSession = [2]uint64{23456, 65432}, birthBoot
		if err := writeJSONAtomic(filepath.Join(f.ctx.Instance.Dir, "executions", scope.ID+".json"), scope); err != nil {
			t.Fatal(err)
		}
		return scope
	}
	otherBoot := func(boot string) string {
		first := byte('0')
		if boot[0] == '0' {
			first = '1'
		}
		return string(first) + boot[1:]
	}
	for _, result := range []string{"zero", "reaped"} {
		t.Run("contradictory verification boot "+result, func(t *testing.T) {
			f := newSyntheticStoppedSource(t, false)
			prior := attachPrior(t, f, f.scope.BootSession)
			raw, err := json.Marshal(prior)
			if err != nil {
				t.Fatal(err)
			}
			completion := executionCompletionForReceipt(prior, append(raw, '\n'), prior.BootSession)
			// Only the verification boot changes; scope and digest still match.
			completion.VerificationBootSession = otherBoot(prior.BootSession)
			if err := writeJSONAtomic(filepath.Join(f.ctx.Instance.Dir, "completed-executions", prior.ID+".json"), completion); err != nil {
				t.Fatal(err)
			}
			previousCount := readCoalitionActiveTaskCount
			t.Cleanup(func() { readCoalitionActiveTaskCount = previousCount })
			readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
				if id == prior.CoalitionIDs[0] && result == "reaped" {
					return 0, syscall.ESRCH
				}
				if id == prior.CoalitionIDs[0] {
					return 0, nil
				}
				return previousCount(id)
			}
			if err := retainReleases(f.fixture.store, f.ctx.Instance.StateDir); err == nil {
				t.Error("contradictory same-boot prior completion permitted pruning")
			}
			for _, build := range []string{f.fixture.prunable.BuildID, f.referenced} {
				if _, err := os.Stat(filepath.Join(f.fixture.store.Home, "releases", build)); err != nil {
					t.Errorf("contradictory prior completion removed release %s: %v", build, err)
				}
			}
		})
	}
	t.Run("prior boot verified on current boot", func(t *testing.T) {
		f := newSyntheticStoppedSource(t, false)
		prior := attachPrior(t, f, otherBoot(f.scope.BootSession))
		if err := retireExecutionScopes(f.ctx, []executionScope{prior}, false, true); err != nil {
			t.Fatalf("native completion writer rejected synthetic earlier-boot receipt: %v", err)
		}
		completion, err := readExecutionCompletion(f.ctx, prior.ID)
		if err != nil || completion.Scope != prior || completion.VerificationBootSession != f.scope.BootSession ||
			completion.VerificationBootSession == prior.BootSession {
			t.Fatalf("native writer did not preserve the synthetic cross-boot identity: %v", err)
		}
		previousCount := readCoalitionActiveTaskCount
		t.Cleanup(func() { readCoalitionActiveTaskCount = previousCount })
		readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
			if id == prior.CoalitionIDs[0] {
				return 0, errors.New("must not inspect an earlier-boot synthetic coalition")
			}
			return previousCount(id)
		}
		if err := retainReleases(f.fixture.store, f.ctx.Instance.StateDir); err != nil {
			t.Fatalf("valid earlier-boot prior completion prevented retention: %v", err)
		}
		if _, err := os.Lstat(filepath.Join(f.fixture.store.Home, "releases", f.fixture.prunable.BuildID)); !os.IsNotExist(err) {
			t.Fatalf("earlier-boot prior completion prevented pruning: %v", err)
		}
		if _, err := os.Stat(filepath.Join(f.fixture.store.Home, "releases", f.referenced, "receipt.json")); err != nil {
			t.Fatalf("earlier-boot prior completion removed the paired release: %v", err)
		}
	})

	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	if err := os.RemoveAll(filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	stageSignedRetentionPrior(t, fixture, public, private, python)
	referenced := stageSignedRetentionRelease(t, fixture.store.Home, "retention-source-pair-0004", 4, public, private, python)
	writeRetentionPair(t, fixture.instance.StateDir, "pair-synthetic-source", referenced)

	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(root, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	script := []byte("#!/bin/sh\n# synthetic source authority\n")
	if err := os.WriteFile(filepath.Join(root, "scripts", "dev"), script, 0o700); err != nil {
		t.Fatal(err)
	}
	boot, err := executionBootSession()
	if err != nil {
		t.Fatal(err)
	}
	makeScope := func(id string, pid int) executionScope {
		return executionScope{SchemaVersion: 1, ID: id, InstanceID: fixture.instance.ID,
			StateDir: fixture.instance.StateDir, RuntimeHome: fixture.instance.RuntimeHome, BootSession: boot,
			JobLabel: "dev.jobctrl.exec." + fixture.instance.ID + "." + id, Domain: fmt.Sprintf("user/%d", os.Getuid()),
			RootPID: pid, RootIdentity: fmt.Sprintf("%d:1:0", pid), CoalitionIDs: [2]uint64{12345, 54321}, Purpose: "source"}
	}
	current := makeScope(strings.Repeat("a", 32), 1001)
	prior := makeScope(strings.Repeat("b", 32), 1002)
	stopped := time.Now().UTC().Add(-time.Second)
	scriptDigest := sha256.Sum256(script)
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: fixture.instance.ID,
		CanonicalStateDir: fixture.instance.StateDir, PayloadRoot: root, BuildID: "source",
		ManifestSHA256: hex.EncodeToString(scriptDigest[:]), StartedAt: stopped.Add(-time.Second),
		StoppedAt: &stopped, OwnershipVerified: true, ExecutionScopeID: current.ID, Components: map[string]componentRecord{}}
	if err := writeState(fixture.instance.StatePath, state); err != nil {
		t.Fatal(err)
	}
	executions := filepath.Join(fixture.instance.Dir, "executions")
	completed := filepath.Join(fixture.instance.Dir, "completed-executions")
	for _, dir := range []string{executions, completed} {
		if err := os.Mkdir(dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	writeScope := func(scope executionScope) {
		t.Helper()
		if err := writeJSONAtomic(filepath.Join(executions, scope.ID+".json"), scope); err != nil {
			t.Fatal(err)
		}
		raw, err := json.Marshal(scope)
		if err != nil {
			t.Fatal(err)
		}
		completion := executionCompletionForReceipt(scope, append(raw, '\n'), boot)
		if err := writeJSONAtomic(filepath.Join(completed, scope.ID+".json"), completion); err != nil {
			t.Fatal(err)
		}
	}
	writeScope(current)
	writeScope(prior)
	completionPath := filepath.Join(completed, prior.ID+".json")
	completionRaw, err := os.ReadFile(completionPath)
	if err != nil {
		t.Fatal(err)
	}
	previousCount := readCoalitionActiveTaskCount
	t.Cleanup(func() { readCoalitionActiveTaskCount = previousCount })
	var count uint64
	var countErr error
	readCoalitionActiveTaskCount = func(id uint64) (uint64, error) {
		if id != prior.CoalitionIDs[0] {
			return 0, errors.New("unexpected synthetic scope")
		}
		return count, countErr
	}
	for _, scenario := range []string{"missing", "malformed", "mismatched", "active", "unavailable", "replaced after collection"} {
		t.Run(scenario, func(t *testing.T) {
			swapped := false
			var mutationErr error
			t.Cleanup(func() {
				count, countErr, afterRetentionReferenceCollection = 0, nil, nil
				if swapped {
					_ = os.Remove(completionPath)
					_ = os.Rename(completionPath+"-saved", completionPath)
				} else {
					_ = os.WriteFile(completionPath, completionRaw, 0o600)
				}
			})
			switch scenario {
			case "missing":
				mutationErr = os.Remove(completionPath)
			case "malformed":
				mutationErr = os.WriteFile(completionPath, []byte("{"), 0o600)
			case "mismatched":
				changed := bytes.Replace(completionRaw, []byte(`"purpose":"source"`), []byte(`"purpose":"apply"`), 1)
				if bytes.Equal(changed, completionRaw) {
					t.Fatal("synthetic completion has no purpose binding")
				}
				mutationErr = os.WriteFile(completionPath, changed, 0o600)
			case "active":
				count = 1
			case "unavailable":
				countErr = syscall.EPERM
			case "replaced after collection":
				afterRetentionReferenceCollection = func() {
					afterRetentionReferenceCollection = nil
					if err := os.Rename(completionPath, completionPath+"-saved"); err != nil {
						t.Fatal(err)
					}
					swapped = true
					if err := os.WriteFile(completionPath, completionRaw, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if mutationErr != nil {
				t.Fatal(mutationErr)
			}
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
				t.Fatal("uncertain prior authority permitted pruning")
			}
			if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)); err != nil {
				t.Fatalf("uncertain prior authority removed the control release: %v", err)
			}
		})
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
		t.Fatalf("matched synthetic prior completion prevented retention: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)); !os.IsNotExist(err) {
		t.Fatalf("completed prior authority prevented pruning the unreferenced control: %v", err)
	}
	if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", referenced.BuildID, "receipt.json")); err != nil {
		t.Fatalf("paired release was removed: %v", err)
	}
}

// The source controller obtains a real private native execution receipt. The
// caller's test overlay limits process discovery to the owned synthetic scope.
func startRetentionSourceRuntime(t *testing.T, fixture retentionFixture, ownedRoot string) (instance, string, executionScope, func() bool) {
	t.Helper()
	binary := filepath.Join(ownedRoot, "jobctrl-source")
	build := exec.Command("go", "build", "-o", binary, "./cmd/jobctrl-source")
	build.Dir = filepath.Join("..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build source controller: %v\n%s", err, output)
	}
	root, home := filepath.Join(ownedRoot, "source"), filepath.Join(ownedRoot, "source-home")
	if err := os.MkdirAll(filepath.Join(root, "scripts"), 0o700); err != nil {
		t.Fatal(err)
	}
	script := filepath.Join(root, "scripts", "dev")
	if err := os.WriteFile(script, []byte("#!/bin/sh\nprintf 'source-ready\\n' >&3\nprintf ready > \"$RETENTION_TEST_READY\"\nIFS= read -r finish\n"), 0o700); err != nil {
		t.Fatal(err)
	}
	ready := filepath.Join(root, "ready")
	if err := os.Remove(ready); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	env := append(os.Environ(), "HOME="+home, "JOBCTRL_DIR="+filepath.Join(home, "workspace"),
		"JOBCTRL_RUNTIME_HOME="+fixture.instance.RuntimeHome, "RETENTION_TEST_READY="+ready,
		executionQASandboxVariable+"="+executionQASandboxSelector)
	inst, err := resolveInstance(env)
	if err != nil {
		t.Fatal(err)
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	command := exec.Command(binary, "run", root, "docs")
	command.Env, command.Stdin = env, reader
	var output bytes.Buffer
	command.Stdout, command.Stderr = &output, &output
	if err := command.Start(); err != nil {
		reader.Close()
		writer.Close()
		t.Fatal(err)
	}
	reader.Close()
	done := make(chan struct{})
	var waitErr error
	go func() { waitErr = command.Wait(); close(done) }()
	var once sync.Once
	completed := false
	finish := func() bool {
		once.Do(func() {
			_, _ = io.WriteString(writer, "finish\n")
			_ = writer.Close()
			select {
			case <-done:
				if waitErr != nil {
					t.Errorf("owned synthetic source runtime failed: %v %s", waitErr, output.String())
				} else {
					completed = true
				}
			case <-time.After(15 * time.Second):
				t.Error("owned synthetic source runtime did not exit; preserving its workspace")
			}
		})
		return completed
	}
	t.Cleanup(func() { finish() })
	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(ready); err == nil {
			state, err := readState(inst.StatePath)
			if err != nil {
				t.Fatal(err)
			}
			scopes, err := readOwnedExecutionScopes(launchContext{Instance: inst})
			if err != nil || len(scopes) != 1 || scopes[0].ID != state.ExecutionScopeID || scopes[0].Purpose != "source" {
				t.Fatalf("source registry has no matching native execution receipt: %v", err)
			}
			ids, err := processCoalitionIDs(state.Supervisor.PID)
			if err != nil || !recordMatchesLiveProcess(state.Supervisor) || ids != scopes[0].CoalitionIDs {
				t.Fatalf("source supervisor is not live in its native execution scope: %v", err)
			}
			return inst, script, scopes[0], finish
		}
		select {
		case <-done:
			t.Fatalf("owned synthetic source runtime exited early: %v %s", waitErr, output.String())
		default:
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatal("owned synthetic source runtime did not become ready")
	return instance{}, "", executionScope{}, finish
}

func TestRetentionAuthenticatesSourceRuntimeAndProtectsItsPair(t *testing.T) {
	ownedRoot, err := os.MkdirTemp("", "jobctrl-retention-source-")
	if err != nil {
		t.Fatal(err)
	}
	startedScopes, cleanedScopes := 0, 0
	t.Cleanup(func() {
		if startedScopes == 0 || cleanedScopes != startedScopes {
			t.Logf("preserved owned synthetic workspace without every native completion: %s", ownedRoot)
			return
		}
		if err := os.RemoveAll(ownedRoot); err != nil {
			t.Errorf("remove completed synthetic workspace: %v", err)
		}
	})
	fixture := newRetentionFixtureAt(t, filepath.Join(ownedRoot, "installed-home"))
	public, private, python := retentionSigningKey(t)
	referencedDir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
	if err := os.RemoveAll(referencedDir); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	stageSignedRetentionPrior(t, fixture, public, private, python)
	unreferenced := stageSignedRetentionRelease(t, fixture.store.Home, "retention-clean-0007", 7, public, private, python)
	startSource := func() (instance, string, executionScope, func() bool) {
		startedScopes++
		source, script, scope, finish := startRetentionSourceRuntime(t, fixture, ownedRoot)
		t.Cleanup(func() {
			if !finish() {
				return
			}
			completion, err := readExecutionCompletion(launchContext{Instance: source}, scope.ID)
			if errors.Is(err, os.ErrNotExist) {
				return // The native controller may leave an uncompleted receipt.
			}
			raw, marshalErr := json.Marshal(scope)
			digest := sha256.Sum256(append(raw, '\n'))
			if err == nil && marshalErr == nil && completion.Scope == scope &&
				completion.VerificationBootSession == scope.BootSession && completion.ReceiptSHA256 == hex.EncodeToString(digest[:]) {
				cleanedScopes++
			} else {
				t.Errorf("owned synthetic source completion did not match its observed scope: %v", err)
			}
		})
		return source, script, scope, finish
	}
	source, script, firstScope, finish := startSource()
	seedLifecycleSQLitePair(t, python, source.StateDir, "source-owned-")
	pair, err := snapshotPair(launchContext{Instance: source, PayloadRoot: filepath.Join(referencedDir, "payload")}, fixture.prunable)
	if err != nil {
		t.Fatal(err)
	}
	pairDir := filepath.Join(source.StateDir, "backups", pair.ID)
	pairDigests := lifecycleDatabaseDigests(t, pairDir)
	argument := fixture.instance.StateDir
	comparison := os.Getenv("JOBCTRL_TEST_RETENTION_COMPARISON")
	if comparison == "main" {
		argument = fixture.instance.RuntimeHome
	}
	err = retainReleases(fixture.store, argument)
	if comparison == "regression" {
		if err == nil {
			t.Fatal("previous candidate did not reproduce its source-registry refusal")
		}
		for _, build := range []string{fixture.prunable.BuildID, unreferenced.BuildID} {
			if _, statErr := os.Stat(filepath.Join(fixture.store.Home, "releases", build)); statErr != nil {
				t.Fatalf("source-registry refusal removed release %s: %v", build, statErr)
			}
		}
		return
	}
	if err != nil {
		t.Fatalf("authenticated source registry stopped retention: %v", err)
	}
	_, referencedErr := os.Stat(filepath.Join(referencedDir, "receipt.json"))
	if comparison == "main" {
		if !errors.Is(referencedErr, os.ErrNotExist) {
			t.Fatalf("main did not reproduce the referenced-release loss: %v", referencedErr)
		}
	} else if referencedErr != nil {
		t.Fatalf("source workspace's paired release was removed: %v", referencedErr)
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", unreferenced.BuildID)); !os.IsNotExist(err) {
		t.Fatalf("unreferenced signed release was not pruned: %v", err)
	}
	if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
		t.Fatal("source workspace backup pair changed")
	}
	if comparison == "main" {
		return
	}

	// A changed source checkout is not authenticated merely by the scope.
	next := stageSignedRetentionRelease(t, fixture.store.Home, "retention-clean-0008", 8, public, private, python)
	state, err := readState(source.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	receiptPath := filepath.Join(source.Dir, "executions", state.ExecutionScopeID+".json")
	receipt, err := os.ReadFile(receiptPath)
	if err != nil {
		t.Fatal(err)
	}
	for _, scenario := range []string{"malformed", "wrong purpose", "replaced after collection"} {
		t.Run(scenario, func(t *testing.T) {
			swapped := false
			t.Cleanup(func() {
				afterRetentionReferenceCollection = nil
				if swapped {
					_ = os.Remove(receiptPath)
					_ = os.Rename(receiptPath+"-saved", receiptPath)
				} else {
					_ = os.WriteFile(receiptPath, receipt, 0o600)
				}
			})
			switch scenario {
			case "malformed":
				if err := os.WriteFile(receiptPath, []byte("{"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "wrong purpose":
				changed := bytes.Replace(receipt, []byte(`"purpose":"source"`), []byte(`"purpose":"apply"`), 1)
				if bytes.Equal(changed, receipt) {
					t.Fatal("source receipt has no purpose binding")
				}
				if err := os.WriteFile(receiptPath, changed, 0o600); err != nil {
					t.Fatal(err)
				}
			case "replaced after collection":
				afterRetentionReferenceCollection = func() {
					afterRetentionReferenceCollection = nil
					if err := os.Rename(receiptPath, receiptPath+"-saved"); err != nil {
						t.Fatal(err)
					}
					swapped = true
					if err := os.WriteFile(receiptPath, receipt, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
				t.Fatal("uncertain source execution authority permitted pruning")
			}
			if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", next.BuildID)); err != nil {
				t.Fatalf("uncertain source authority removed an unreferenced release: %v", err)
			}
			if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
				t.Fatal("source backup pair changed on refusal")
			}
		})
	}
	original, err := os.ReadFile(script)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(script, append(original, []byte("# changed\n")...), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
		t.Fatal("changed source launcher silently authorized pruning")
	}
	if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", next.BuildID)); err != nil {
		t.Fatalf("uncertain source authority removed an unreferenced release: %v", err)
	}
	if err := os.WriteFile(script, original, 0o700); err != nil {
		t.Fatal(err)
	}
	finish()
	state, err = readState(source.StatePath)
	if err != nil || !state.OwnershipVerified || state.StoppedAt == nil {
		t.Fatalf("source runtime did not publish its stopped state: %v", err)
	}
	ctx := launchContext{Instance: source}
	completion, err := readExecutionCompletion(ctx, state.ExecutionScopeID)
	if errors.Is(err, os.ErrNotExist) {
		if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
			t.Fatal("a stopped source without native completion permitted pruning")
		}
		if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", next.BuildID)); err != nil {
			t.Fatalf("missing source completion removed an unreferenced release: %v", err)
		}
		if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
			t.Fatal("source backup pair changed when completion was unavailable")
		}
		t.Log("native source completion was unavailable; verified fail-closed retention and preserved the fixture")
		return
	}
	if err != nil || completion.Scope != firstScope || completion.Scope.Purpose != "source" {
		t.Fatalf("source runtime did not publish its authenticated completion: %v", err)
	}
	completionPath := filepath.Join(source.Dir, "completed-executions", state.ExecutionScopeID+".json")
	completionRaw, err := os.ReadFile(completionPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(completionPath, []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
		t.Fatal("malformed source completion permitted pruning")
	}
	if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", next.BuildID)); err != nil {
		t.Fatalf("malformed source completion removed an unreferenced release: %v", err)
	}
	if err := os.WriteFile(completionPath, completionRaw, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
		t.Fatalf("authenticated stopped source registry prevented retention: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", next.BuildID)); !os.IsNotExist(err) {
		t.Fatalf("unreferenced release was not pruned after source completion: %v", err)
	}
	if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
		t.Fatal("stopped source backup pair changed")
	}

	// Successful source executions leave a receipt and a completion behind.
	// Keep that authentic historical pair while a later source run is live.
	// Remove the old receipt only while starting/stopping the second synthetic
	// run so its shutdown never probes a potentially reused historical PID.
	pythonDir := filepath.Join(ownedRoot, "source", "workers", "automation", ".venv", "bin")
	if err := os.MkdirAll(pythonDir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(python, filepath.Join(pythonDir, "python")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(receiptPath); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.WriteFile(receiptPath, receipt, 0o600) })
	secondSource, _, secondScope, finishSecond := startSource()
	if secondSource != source || secondScope.ID == firstScope.ID {
		t.Fatal("second source run did not create a distinct scope for the same workspace")
	}
	t.Cleanup(func() { _ = os.Remove(receiptPath) })
	if err := os.WriteFile(receiptPath, receipt, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.WriteFile(completionPath, completionRaw, 0o600) })
	last := stageSignedRetentionRelease(t, fixture.store.Home, "retention-clean-0009", 9, public, private, python)
	for _, scenario := range []string{"missing", "malformed"} {
		t.Run("prior completion "+scenario, func(t *testing.T) {
			t.Cleanup(func() { _ = os.WriteFile(completionPath, completionRaw, 0o600) })
			if scenario == "missing" {
				err = os.Remove(completionPath)
			} else {
				err = os.WriteFile(completionPath, []byte("{"), 0o600)
			}
			if err != nil {
				t.Fatal(err)
			}
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
				t.Fatal("uncertain prior execution completion permitted pruning")
			}
			if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", last.BuildID)); err != nil {
				t.Fatalf("uncertain prior authority removed an unreferenced release: %v", err)
			}
		})
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
		t.Fatalf("completed prior execution prevented retention: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", last.BuildID)); !os.IsNotExist(err) {
		t.Fatalf("unreferenced release was not pruned with a completed prior scope: %v", err)
	}
	if _, err := os.Stat(filepath.Join(referencedDir, "receipt.json")); err != nil {
		t.Fatalf("source backup release changed after a subsequent run: %v", err)
	}
	if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
		t.Fatal("source backup pair changed after a subsequent run")
	}
	if err := os.Remove(receiptPath); err != nil {
		t.Fatal(err)
	}
	if !finishSecond() {
		t.Fatal("second synthetic source scope did not finish")
	}
	if err := os.WriteFile(receiptPath, receipt, 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := readExecutionCompletion(ctx, secondScope.ID); errors.Is(err, os.ErrNotExist) {
		pending := stageSignedRetentionRelease(t, fixture.store.Home, "retention-clean-0010", 10, public, private, python)
		if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
			t.Fatal("second stopped source without native completion permitted pruning")
		}
		if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", pending.BuildID)); err != nil {
			t.Fatalf("missing second completion removed an unreferenced release: %v", err)
		}
		t.Log("second native completion was unavailable; verified fail-closed retention and preserved the fixture")
	} else if err != nil {
		t.Fatalf("read second source completion: %v", err)
	}
}
