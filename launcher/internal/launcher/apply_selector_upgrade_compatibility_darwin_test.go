//go:build darwin

package launcher

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// The default predecessor is an explicitly synthetic protocol-2 selector model
// without the new Apply entry. The same production handoff assertions can also
// qualify an actual archived selector supplied through this owned test fixture.
// No test invokes the application, browser, provider or Keychain ports.
func TestApplySelectorUpgradeReplacesPreApplyControllerBeforeStartup(t *testing.T) {
	python := migrationIntegrationPython(t)
	moduleRoot := filepath.Clean(filepath.Join("..", ".."))
	build := func(target, source string) {
		t.Helper()
		command := exec.Command("go", "build", "-o", target, source)
		command.Dir = moduleRoot
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("build owned selector fixture: %v %s", err, output)
		}
	}
	artifacts := t.TempDir()
	candidateBinary := filepath.Join(artifacts, "candidate-selector")
	build(candidateBinary, "./cmd/jobctrl")
	oldBinary := os.Getenv("JOBCTRL_TEST_PRE_APPLY_SELECTOR")
	if oldBinary == "" {
		model := filepath.Join(artifacts, "pre-apply-selector-model.go")
		if err := os.WriteFile(model, []byte("package main\nimport \"os\"\nfunc main(){os.Stderr.WriteString(\"synthetic protocol-2 selector model: fixed Apply entry unavailable\\n\");os.Exit(64)}\n"), 0600); err != nil {
			t.Fatal(err)
		}
		oldBinary = filepath.Join(artifacts, "pre-apply-selector-model")
		build(oldBinary, model)
		t.Log("predecessor is a synthetic protocol-2/pre-Apply selector model, not an archived binary")
	} else {
		if !filepath.IsAbs(oldBinary) || filepath.Clean(oldBinary) != oldBinary {
			t.Fatal("archived selector fixture must be a normalized absolute path")
		}
		info, err := os.Lstat(oldBinary)
		if err != nil || !info.Mode().IsRegular() || info.Mode().Perm()&0111 == 0 {
			t.Fatalf("archived selector fixture is not a regular executable: %v", err)
		}
		digest, err := sha256Path(oldBinary)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("qualifying explicitly supplied archived selector sha256=%s", digest)
	}

	// This inventoried fake Python port accepts only the fixed Apply module.
	// Non-module invocations delegate the launcher's literal SQLite backup code
	// to CPython. Every other module, including the old generic CLI route, fails
	// before importing any application code.
	adapterSource := filepath.Join(artifacts, "python-port.go")
	adapterCode := fmt.Sprintf(`package main
import("encoding/json";"os";"syscall")
func main(){
 args:=os.Args[1:]
 for i,arg:=range args {if arg=="-m" {
  if len(args)!=4||i!=2||args[0]!="-I"||args[1]!="-B"||args[3]!="jobctrl.apply.execution" {os.Exit(112)}
  scope:=os.Getenv("JOBCTRL_EXECUTION_SCOPE")
  if scope==""||os.Getenv("JOBCTRL_APPLY_EXECUTION_SCOPE")!=scope {os.Exit(113)}
  raw,_:=json.Marshal(map[string]string{"scope":scope,"module":args[3]})
  if os.WriteFile(os.Getenv("JOBCTRL_TEST_APPLY_SELECTOR_MARKER"),raw,0600)!=nil {os.Exit(114)}
  return
 }}
 const python=%q
 if syscall.Exec(python,append([]string{python},args...),os.Environ())!=nil {os.Exit(111)}
}
`, python)
	if err := os.WriteFile(adapterSource, []byte(adapterCode), 0600); err != nil {
		t.Fatal(err)
	}
	adapterBinary := filepath.Join(artifacts, "python-port")
	build(adapterBinary, adapterSource)

	home, state := t.TempDir(), t.TempDir()
	environment := []string{"HOME=" + home, "PATH=/usr/bin:/bin", "JOBCTRL_RUNTIME_HOME=" + filepath.Join(home, "runtime"), "JOBCTRL_DIR=" + state, executionQASandboxVariable + "=" + executionQASandboxSelector}
	instance, err := resolveInstance(environment)
	if err != nil {
		t.Fatal(err)
	}
	store, err := release.Open(instance.RuntimeHome)
	if err != nil {
		t.Fatal(err)
	}
	old := installApplySelectorCompatibilityRelease(t, store.Home, "local-apply-selector-old-0001", 1, python, oldBinary, adapterBinary)
	candidate := installApplySelectorCompatibilityRelease(t, store.Home, "local-apply-selector-new-0002", 2, python, candidateBinary, adapterBinary)
	active, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture")
	if err != nil {
		t.Fatal(err)
	}
	verifiedOld, err := verifyInstalledReleaseForExecution(store, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(store.Home, verifiedOld); err != nil {
		t.Fatal(err)
	}
	if verifiedOld.runtime.LauncherProtocol != 2 {
		t.Fatal("predecessor fixture is not protocol 2")
	}
	seedLifecycleSQLitePair(t, python, instance.StateDir, "pre-apply")
	executable, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Executable: executable, Instance: instance, Environment: environment}
	defer func() {
		if err := stop(ctx); err != nil {
			t.Errorf("owned selector fixture cleanup: %v", err)
		}
	}()
	selector := filepath.Join(store.Home, "bin", "jobctrl")
	marker := filepath.Join(artifacts, "fixed-apply.json")
	command := exec.Command(selector, applyExecutionArgument)
	command.Env = append(append([]string{}, environment...), "JOBCTRL_TEST_APPLY_SELECTOR_MARKER="+marker)
	if output, err := command.CombinedOutput(); err == nil {
		t.Fatalf("pre-Apply predecessor unexpectedly exposed fixed Apply: %s", output)
	}
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("pre-Apply rejection reached the fixed fake module")
	}

	candidateBytes, err := os.ReadFile(candidateBinary)
	if err != nil {
		t.Fatal(err)
	}
	priorStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = priorStart })
	starts := 0
	startReleaseCommand = func(_ launchContext, target release.Receipt, journal string) error {
		starts++
		if journal == "" || (target != candidate && target != old) {
			t.Fatal("startup lost its exact transition target")
		}
		installed, err := os.ReadFile(selector)
		if err != nil || !bytes.Equal(installed, candidateBytes) {
			t.Fatal("candidate startup or rollback preceded the capable selector handoff")
		}
		// The promoter already holds the exclusive selection lock here.
		if !selectorMatchesRelease(store, selector, candidate.BuildID) {
			t.Fatal("startup selector is not the authenticated candidate")
		}
		return nil
	}
	if err := promoteExisting(ctx, store, active, candidate.BuildID, "update", io.Discard); err != nil {
		t.Fatalf("production upgrade from pre-Apply selector: %v", err)
	}
	active, err = store.ReadActive()
	if err != nil || active.Receipt != candidate || active.SelectorBuildID != candidate.BuildID || starts != 1 {
		t.Fatalf("upgrade did not select the exact candidate and controller: %+v %v starts=%d", active, err, starts)
	}
	firstScope := verifyApplySelectorFixedEntry(t, ctx, selector, marker)
	if err := rollbackExisting(ctx, store, active, old.BuildID, io.Discard); err != nil {
		t.Fatalf("production rollback: %v", err)
	}
	active, err = store.ReadActive()
	if err != nil || active.Receipt != old || active.SelectorBuildID != candidate.BuildID || starts != 2 {
		t.Fatalf("rollback did not retain the capable selector: %+v %v starts=%d", active, err, starts)
	}
	secondScope := verifyApplySelectorFixedEntry(t, ctx, selector, marker)
	if firstScope == secondScope {
		t.Fatal("fixed Apply invocations reused an execution scope")
	}
	t.Log("production upgrade replaced the predecessor before startup; fixed Apply completed before and after rollback through the retained candidate selector")
}

func installApplySelectorCompatibilityRelease(t *testing.T, home, build string, sequence uint64, python, launcher, adapter string) release.Receipt {
	t.Helper()
	receipt := installLifecycleRelease(t, home, build, sequence, python)
	root := filepath.Join(home, "releases", build, "payload")
	for target, source := range map[string]string{"launcher/jobctrl": launcher, "python/bin/python3": adapter} {
		raw, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(root, target), raw, 0755); err != nil {
			t.Fatal(err)
		}
	}
	var manifest distributionManifest
	if err := decodeStrictRegular(filepath.Join(root, "manifest.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, root, &manifest)
	writeLocalEnvelope(t, root, manifest)
	digest, err := sha256Path(filepath.Join(root, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	receipt.ManifestSHA256 = digest
	if err := writeJSONAtomic(filepath.Join(home, "releases", build, "receipt.json"), selectorReceipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: int64(receipt.Sequence), ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}); err != nil {
		t.Fatal(err)
	}
	return receipt
}

func verifyApplySelectorFixedEntry(t *testing.T, ctx launchContext, selector, marker string) string {
	t.Helper()
	if err := os.Remove(marker); err != nil && !os.IsNotExist(err) {
		t.Fatal(err)
	}
	command := exec.Command(selector, applyExecutionArgument)
	command.Env = append(append([]string{}, ctx.Environment...), "JOBCTRL_TEST_APPLY_SELECTOR_MARKER="+marker)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("actual fixed Apply entry: %v %s", err, output)
	}
	var result struct{ Scope, Module string }
	raw, err := os.ReadFile(marker)
	if err != nil || json.Unmarshal(raw, &result) != nil || result.Scope == "" || result.Module != "jobctrl.apply.execution" {
		t.Fatalf("fixed fake module was not invoked: %v %s", err, raw)
	}
	completion, err := readExecutionCompletion(ctx, result.Scope)
	if err != nil || completion.Scope.ID != result.Scope || completion.Scope.Purpose != "apply" {
		t.Fatalf("fixed invocation did not produce its exact Apply completion: %v", err)
	}
	return result.Scope
}
