//go:build darwin

package launcher

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"testing"
	"time"
)

func TestActualNativeApplyModuleReleasesSameJobAndPreservesPeer(t *testing.T) {
	runActualNativeApplyModuleFixture(t, false)
}

func TestActualTemporalApplyUsesIndependentNativeScopes(t *testing.T) {
	runActualNativeApplyModuleFixture(t, true)
}

func runActualNativeApplyModuleFixture(t *testing.T, temporal bool) {
	t.Helper()
	python := migrationIntegrationPython(t)
	workerSource, err := filepath.Abs(filepath.Join("..", "..", "..", "workers", "automation", "src"))
	if err != nil {
		t.Fatal(err)
	}
	harness := filepath.Join(filepath.Dir(workerSource), "tests", "helpers", "apply_execution_native.py")
	payload, manifest := verifiedPayloadFixture(t)
	moduleRoot := filepath.Clean(filepath.Join("..", ".."))
	launcher := filepath.Join(payload, "launcher", "jobctrl")
	build := exec.Command("go", "build", "-o", launcher, "./cmd/jobctrl")
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build native fixture: %v %s", err, output)
	}
	adapterSource := filepath.Join(t.TempDir(), "python-adapter.go")
	bootstrap := fmt.Sprintf("import sys,runpy;sys.path[:0]=[%q,%q];runpy.run_module('jobctrl.apply.execution',run_name='__main__')", workerSource, filepath.Dir(workerSource))
	if temporal {
		// This literal QA payload controls only external browser/agent ports;
		// the fixed production module, claims, saga and native scope are real.
		bootstrap = fmt.Sprintf("import sys,runpy;sys.path[:0]=[%q,%q];from tests.helpers.apply_execution_ports import install;install();runpy.run_module('jobctrl.apply.execution',run_name='__main__')", workerSource, filepath.Dir(workerSource))
	}
	adapter := fmt.Sprintf("package main\nimport (\"os\";\"syscall\")\nfunc main(){const python=%q;args:=os.Args[1:];if len(args)!=4||args[0]!=\"-I\"||args[1]!=\"-B\"||args[2]!=\"-m\"||args[3]!=\"jobctrl.apply.execution\"{os.Exit(112)};if syscall.Exec(python,[]string{python,\"-I\",\"-B\",\"-c\",%q},os.Environ())!=nil{os.Exit(111)}}\n", python, bootstrap)
	if err := os.WriteFile(adapterSource, []byte(adapter), 0600); err != nil {
		t.Fatal(err)
	}
	adapterTarget := filepath.Join(payload, "python", "bin", "python3")
	if err := os.MkdirAll(filepath.Dir(adapterTarget), 0755); err != nil {
		t.Fatal(err)
	}
	build = exec.Command("go", "build", "-o", adapterTarget, adapterSource)
	build.Dir = moduleRoot
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build inventoried CPython adapter: %v %s", err, output)
	}
	if err := os.WriteFile(filepath.Join(payload, "launcher", "runtime-manifest.json"), []byte(validRuntimeManifest), 0644); err != nil {
		t.Fatal(err)
	}
	policy, err := os.ReadFile(filepath.Join("..", "..", "..", "packaging", "distribution", "capability-policy.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(payload, "release"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(payload, "release", "capability-policy.json"), policy, 0644); err != nil {
		t.Fatal(err)
	}
	component := manifest.Components[0]
	component.ID, component.Path = "owned-release-policy", "release"
	manifest.Components = append(manifest.Components, component)
	if temporal {
		mcp := filepath.Join(payload, "playwright-mcp", "bin", "playwright-mcp")
		if err := os.MkdirAll(filepath.Dir(mcp), 0755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(mcp, []byte("#!/bin/sh\nexit 111\n"), 0755); err != nil {
			t.Fatal(err)
		}
		component.ID, component.Path = "playwright-mcp", "playwright-mcp"
		manifest.Components = append(manifest.Components, component)
	}
	sort.Slice(manifest.Components, func(i, j int) bool { return manifest.Components[i].ID < manifest.Components[j].ID })
	refreshFixtureManifest(t, payload, &manifest)
	writeLocalEnvelope(t, payload, manifest)
	home, evidence := t.TempDir(), t.TempDir()
	environment := []string{"HOME=" + home, "PATH=/usr/bin:/bin", "JOBCTRL_DIR=" + filepath.Join(home, "data"), "JOBCTRL_RUNTIME_HOME=" + filepath.Join(home, "runtime"), executionQASandboxVariable + "=" + executionQASandboxSelector, "LANGFUSE_DISABLE=1", "OTEL_SDK_DISABLED=true"}
	if temporal {
		temporalCLI := os.Getenv("JOBCTRL_TEMPORAL_CLI_PATH")
		if temporalCLI == "" {
			temporalCLI, err = exec.LookPath("temporal")
			if err != nil {
				t.Fatalf("Temporal integration requires JOBCTRL_TEMPORAL_CLI_PATH or temporal on the test runner PATH: %v", err)
			}
		}
		info, statErr := os.Stat(temporalCLI)
		if !filepath.IsAbs(temporalCLI) || statErr != nil || !info.Mode().IsRegular() || info.Mode()&0111 == 0 {
			t.Fatalf("Temporal integration requires an absolute executable CLI path, got %q: %v", temporalCLI, statErr)
		}
		environment = append(environment, "JOBCTRL_TEMPORAL_CLI_PATH="+temporalCLI)
	}
	instance, err := resolveInstance(environment)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(instance.RuntimeHome, "bin"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(launcher, filepath.Join(instance.RuntimeHome, "bin", "jobctrl")); err != nil {
		t.Fatal(err)
	}
	executable, err := CurrentProcessExecutable()
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Executable: executable, Instance: instance, Environment: environment}
	defer func() {
		if err := stop(ctx); err != nil {
			t.Errorf("owned fixture cleanup: %v", err)
		}
	}()
	defer func() {
		if t.Failed() {
			preserveApplyFailureEvidence(t, evidence, instance)
		}
	}()
	peerFixture := t.TempDir()
	if err := os.WriteFile(filepath.Join(peerFixture, "mode"), []byte("peer"), 0600); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(ctx)
	if err != nil {
		t.Fatal(err)
	}
	peerCtx := ctx
	peerCtx.Environment = append(append([]string{}, environment...), "JOBCTRL_APPLY_TEST_ROOT="+peerFixture, "JOBCTRL_APPLY_TEST_CONTEXT="+string(encoded))
	if err := runInOwnedExecution(peerCtx, []string{"__apply-test-peer"}, io.Discard, os.Stderr); err != nil {
		var diagnostic []byte
		if log, openErr := os.Open(filepath.Join(peerFixture, "writer.log")); openErr == nil {
			diagnostic, _ = io.ReadAll(io.LimitReader(log, 4096))
			log.Close()
			_ = os.WriteFile(filepath.Join(evidence, "peer-writer.log"), diagnostic, 0600)
		}
		t.Fatalf("owned synthetic peer startup: %v; bounded writer stderr: %s", err, diagnostic)
	}
	peerRaw, err := os.ReadFile(filepath.Join(peerFixture, "writer.pid"))
	if err != nil {
		t.Fatal(err)
	}
	peerPID, _ := strconv.Atoi(string(peerRaw))
	peerIdentity, err := processStartIdentity(peerPID)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"seed", "run"} {
		arguments := []string{"-I", "-B", harness, mode, workerSource, instance.StateDir, evidence}
		if temporal && mode == "run" {
			arguments = []string{"-I", "-B", filepath.Join(filepath.Dir(harness), "apply_execution_temporal.py"), workerSource, instance.StateDir, evidence}
		}
		command := exec.Command(python, arguments...)
		command.Env = environment
		if mode == "run" {
			command.Env = append(append([]string{}, environment...), "JOBCTRL_RUNTIME_MODE=bundled", "JOBCTRL_PAYLOAD_DIR="+payload)
		}
		if output, err := command.CombinedOutput(); err != nil {
			logs, _ := filepath.Glob(filepath.Join(instance.StateDir, "apply-invocations", "*", "launcher.log"))
			for _, log := range logs {
				raw, _ := os.ReadFile(log)
				output = append(output, raw...)
			}
			t.Fatalf("actual fixed Apply module %s: %v %s", mode, err, output)
		}
		if temporal && mode == "run" {
			trace, err := os.ReadFile(filepath.Join(evidence, "temporal-native-attempts.json"))
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("actual Temporal activity attempt history: %s", trace)
		}
	}
	var runs []struct {
		RequestID string `json:"request_id"`
		ScopeID   string `json:"scope_id"`
	}
	if temporal {
		if _, err := os.Stat(filepath.Join(evidence, "temporal-native-results.json")); err != nil {
			t.Fatal(err)
		}
		files, err := filepath.Glob(filepath.Join(instance.StateDir, "apply-invocations", "*", "result.json"))
		if len(files) != 7 {
			for _, path := range files {
				var trace struct {
					RequestID string          `json:"request_id"`
					Output    json.RawMessage `json:"output"`
					Error     json.RawMessage `json:"error"`
					Binding   struct {
						Scope executionScope `json:"scope"`
					} `json:"native_custody"`
				}
				raw, readErr := os.ReadFile(path)
				decodeErr := json.Unmarshal(raw, &trace)
				_, proofErr := readExecutionCompletion(ctx, trace.Binding.Scope.ID)
				_, custodyErr := os.Stat(filepath.Join(instance.StateDir, "apply-runs", trace.RequestID, "custody.json"))
				log, _ := os.ReadFile(filepath.Join(filepath.Dir(path), "launcher.log"))
				if len(log) > 1000 {
					log = log[len(log)-1000:]
				}
				t.Logf("actual native request=%s scope=%s output=%s error=%s read=%v decode=%v proof=%v custody=%v controllerTail=%s", trace.RequestID, trace.Binding.Scope.ID, trace.Output, trace.Error, readErr, decodeErr, proofErr, custodyErr, log)
			}
		}
		if err != nil || len(files) != 7 {
			t.Fatalf("real Temporal activity results missing: %v count=%d", err, len(files))
		}
		for _, path := range files {
			var result struct {
				RequestID string `json:"request_id"`
				Binding   struct {
					Scope executionScope `json:"scope"`
				} `json:"native_custody"`
			}
			raw, err := os.ReadFile(path)
			if err != nil || json.Unmarshal(raw, &result) != nil {
				t.Fatal("invalid actual Temporal native result")
			}
			runs = append(runs, struct {
				RequestID string `json:"request_id"`
				ScopeID   string `json:"scope_id"`
			}{result.RequestID, result.Binding.Scope.ID})
		}
	} else {
		results, err := os.ReadFile(filepath.Join(evidence, "fixed-module-results.json"))
		if err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal(results, &runs); err != nil || len(runs) != 2 || runs[0].ScopeID == runs[1].ScopeID {
			t.Fatalf("independent activity scopes missing: %v %s", err, results)
		}
	}
	for _, run := range runs {
		completion, err := readExecutionCompletion(ctx, run.ScopeID)
		if err != nil {
			t.Fatal(err)
		}
		var writer struct {
			PID int `json:"pid"`
			SID int `json:"sid"`
		}
		raw, err := os.ReadFile(filepath.Join(evidence, "writer-"+run.ScopeID+".json"))
		if err != nil || json.Unmarshal(raw, &writer) != nil || writer.PID != writer.SID || writer.PID <= 0 {
			t.Fatal("actual native preflight did not produce an escaped writer")
		}
		// The native completion certified the exact coalition. Independently
		// require that the synthetic writer cannot continue its output.
		tickPath := filepath.Join(evidence, "ticks-"+run.ScopeID)
		before, err := os.ReadFile(tickPath)
		if err != nil {
			t.Fatal(err)
		}
		time.Sleep(50 * time.Millisecond)
		after, err := os.ReadFile(tickPath)
		if err != nil || string(after) != string(before) || completion.Scope.ID != run.ScopeID {
			t.Fatal("native completion left its escaped writer active")
		}
		if _, err := os.Stat(filepath.Join(instance.StateDir, "apply-runs", run.RequestID, "custody.json")); !os.IsNotExist(err) {
			t.Fatal("native completion did not release the exact run's custody")
		}
	}
	if temporal {
		observations, err := filepath.Glob(filepath.Join(instance.StateDir, "qa-census-observations", "*.json"))
		if err != nil || len(observations) == 0 {
			t.Fatal("native process-session census observations missing")
		}
		for _, path := range observations {
			var observation struct {
				SessionID int               `json:"session_id"`
				Outcome   string            `json:"outcome"`
				Samples   []json.RawMessage `json:"samples"`
			}
			raw, err := os.ReadFile(path)
			if err != nil || json.Unmarshal(raw, &observation) != nil || observation.SessionID <= 0 || len(observation.Samples) == 0 || observation.Outcome != "verified" {
				t.Fatal("invalid or refused native process-session census observation")
			}
		}
		t.Logf("observed %d real owned-session cleanup censuses", len(observations))
	}
	if current, err := processStartIdentity(peerPID); err != nil || current != peerIdentity {
		t.Fatalf("same-instance peer did not survive both Apply runs: %v", err)
	}
	active, err := readOwnedExecutionScopes(ctx)
	if err != nil || len(active) != 1 {
		t.Fatalf("Apply retirement changed its peer or retained a completed scope: %v", err)
	}
	if err := stop(ctx); err != nil {
		t.Fatal(err)
	}
	if !waitForOwnedRecordExit(componentRecord{PID: peerPID, StartIdentity: peerIdentity}, time.Second) {
		t.Fatal("final cleanup left the control alive")
	}
}

// Preserve only owned synthetic logs, history and ownership metadata before
// TempDir cleanup. Database/profile/artifact payloads are never copied.
func preserveApplyFailureEvidence(t *testing.T, evidence string, instance instance) {
	t.Helper()
	destination, err := os.MkdirTemp("", "jobctrl-apply-failure-evidence-")
	if err != nil {
		t.Logf("preserve owned failure evidence: %v", err)
		return
	}
	for name, root := range map[string]string{"scenario": evidence, "invocations": filepath.Join(instance.StateDir, "apply-invocations"), "census": filepath.Join(instance.StateDir, "qa-census-observations"), "executions": filepath.Join(filepath.Dir(instance.StatePath), "executions"), "completions": filepath.Join(filepath.Dir(instance.StatePath), "completed-executions")} {
		err := filepath.WalkDir(root, func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() || !entry.Type().IsRegular() {
				return nil
			}
			if !strings.HasSuffix(entry.Name(), ".json") && !strings.HasSuffix(entry.Name(), ".log") {
				return nil
			}
			relative, err := filepath.Rel(root, path)
			if err != nil {
				return err
			}
			target := filepath.Join(destination, name, relative)
			if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
				return err
			}
			raw, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			return os.WriteFile(target, raw, 0600)
		})
		if err != nil && !os.IsNotExist(err) {
			t.Logf("preserve owned %s: %v", name, err)
		}
	}
	t.Logf("owned synthetic failure metadata retained at %s", destination)
}
