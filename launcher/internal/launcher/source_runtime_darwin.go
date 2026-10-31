//go:build darwin

package launcher

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

type sourceExecutionMarker struct {
	SchemaVersion int    `json:"schemaVersion"`
	InstanceID    string `json:"instanceId"`
	ScopeID       string `json:"scopeId"`
}

// RunSource admits the source fleet to the same workspace locks and durable
// process scope as installed releases. The source checkout is trusted by its
// developer; it does not impersonate an authenticated release receipt.
func RunSource(executable string, args, env []string, stdout, stderr io.Writer) error {
	if handled, err := ownedExecutionHelper(args); handled {
		return err
	}
	if len(args) < 2 || (args[0] != "run" && args[0] != "stop" && args[0] != "switch" && args[0] != "verify" && args[0] != "__source-run") {
		return errors.New("usage: jobctrl-source run|stop SOURCE_ROOT [component...]")
	}
	root, err := filepath.EvalSymlinks(args[1])
	if err != nil || !filepath.IsAbs(root) {
		return errors.New("source root must be an existing absolute directory")
	}
	script := filepath.Join(root, "scripts", "dev")
	info, err := os.Lstat(script)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("source development launcher is not a regular file")
	}
	for _, name := range args[2:] {
		switch name {
		case "temporal", "api", "web", "worker", "docs", "demo-api", "demo-web":
		default:
			return fmt.Errorf("unknown source component %q", name)
		}
	}
	inst, err := resolveInstance(env)
	if err != nil {
		return err
	}
	ctx := launchContext{Executable: executable, Instance: inst, Environment: env}
	if args[0] == "verify" {
		owned, err := authenticatedOwnedExecution(ctx)
		if err != nil || !owned {
			return errors.Join(errors.New("source runtime requires an authenticated workspace execution scope"), err)
		}
		return nil
	}
	if args[0] == "stop" || args[0] == "switch" {
		if args[0] == "switch" {
			if err := validateSourceWorkspacePaths(ctx); err != nil {
				return err
			}
			store, err := release.Open(inst.RuntimeHome)
			if err != nil {
				return err
			}
			selection, err := store.SelectionLock(false)
			if err != nil {
				return err
			}
			defer selection.Close()
			if err := refusePendingBridgeHandoff(store.Home); err != nil {
				return err
			}
			if journal, err := store.ReadJournal(); err == nil && journal.Resumable() {
				return errors.New("an installed update is unfinished; finish its recovery before switching to source development")
			} else if err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		state, err := readState(inst.StatePath)
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		if err != nil {
			return err
		}
		if args[0] == "stop" && state.BuildID != "source" {
			return nil
		}
		return stop(ctx)
	}
	if err := validateSourceWorkspacePaths(ctx); err != nil {
		return err
	}
	if args[0] == "__source-run" {
		return runSourceInsideScope(ctx, script, args[2:], stdout, stderr)
	}
	ctx.SourcePython = filepath.Join(root, "workers", "automation", ".venv", "bin", "python")
	if err := automaticSourceMigration(ctx, stderr); err != nil {
		return err
	}
	store, err := release.Open(inst.RuntimeHome)
	if err != nil {
		return err
	}
	selection, err := store.SelectionLock(false)
	if err != nil {
		return err
	}
	defer selection.Close()
	if err := refusePendingBridgeHandoff(store.Home); err != nil {
		return err
	}
	journal, err := store.ReadJournal()
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if err == nil && journal.Resumable() {
		return errors.New("an installed update is unfinished; finish its recovery before starting source development")
	}
	command := append([]string{"__source-run", root}, args[2:]...)
	return runInOwnedExecutionWithAdmission(ctx, command, stdout, stderr, selection.Close)
}

func runSourceInsideScope(ctx launchContext, script string, targets []string, stdout, stderr io.Writer) (result error) {
	owned, err := authenticatedOwnedExecution(ctx)
	if err != nil || !owned {
		return errors.Join(errors.New("source runtime requires an authenticated workspace execution scope"), err)
	}
	lock, err := acquireLock(ctx.Instance.LockPath, true)
	if err != nil {
		return fmt.Errorf("another JobCtrl runtime owns this workspace: %w", err)
	}
	defer releaseLock(lock)
	previous, readErr := readState(ctx.Instance.StatePath)
	if readErr != nil && !errors.Is(readErr, os.ErrNotExist) {
		return readErr
	}
	if readErr == nil {
		if err := validateStartState(ctx, previous); err != nil {
			return err
		}
	}
	if remaining, err := inspectOwnedProcesses(ctx, previous); err != nil {
		return err
	} else if len(remaining) != 0 {
		return errors.New("a prior workspace execution remains active; stop it before starting source development")
	}
	supervisor, err := recordForProcess(os.Getpid(), "", ctx.Executable)
	if err != nil {
		return err
	}
	digest, err := sha256Path(script)
	if err != nil {
		return err
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: ctx.Instance.ID,
		CanonicalStateDir: ctx.Instance.StateDir, PayloadRoot: filepath.Dir(filepath.Dir(script)),
		BuildID: "source", ManifestSHA256: digest, StartedAt: time.Now().UTC(), Supervisor: supervisor,
		Components: map[string]componentRecord{}, ExecutionScopeID: environmentMap(ctx.Environment)[executionScopeVariable]}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		return err
	}
	defer func() {
		cleanupErr := terminateOwnedProcesses(ctx, state)
		if cleanupErr == nil {
			now := time.Now().UTC()
			state.OwnershipVerified, state.StoppedAt = true, &now
		} else {
			state.OwnershipVerified, state.StoppedAt = false, nil
			result = errors.Join(result, fmt.Errorf("verify source runtime shutdown: %w", cleanupErr))
		}
		if err := writeState(ctx.Instance.StatePath, state); err != nil {
			result = errors.Join(result, err)
		}
	}()
	arguments := append([]string{script, "run"}, targets...)
	child := exec.Command("/bin/bash", arguments...)
	child.Dir = filepath.Dir(filepath.Dir(script))
	child.Env = make([]string, 0, len(ctx.Environment)+2)
	for _, pair := range ctx.Environment {
		if !strings.HasPrefix(pair, "JOBCTRL_DEV_INNER=") && !strings.HasPrefix(pair, "JOBCTRL_DIR=") {
			child.Env = append(child.Env, pair)
		}
	}
	child.Env = append(child.Env, "JOBCTRL_DEV_INNER=1", "JOBCTRL_DIR="+ctx.Instance.StateDir)
	readyRead, readyWrite, err := os.Pipe()
	if err != nil {
		return err
	}
	defer readyRead.Close()
	child.Env = append(child.Env, "JOBCTRL_DEV_READY_FD=3")
	child.ExtraFiles = []*os.File{readyWrite}
	child.Stdin, child.Stdout, child.Stderr = os.Stdin, stdout, stderr
	if err := child.Start(); err != nil {
		readyWrite.Close()
		return err
	}
	readyWrite.Close()
	finished := make(chan struct{})
	go func() {
		line, err := bufio.NewReader(io.LimitReader(readyRead, 64)).ReadString('\n')
		if err != nil || line != "source-ready\n" {
			return
		}
		id := environmentMap(ctx.Environment)[executionScopeVariable]
		if !executionIDValid(id) || !sourceHasFullFleet(targets) {
			return
		}
		// A launched diagnostic-only API does not prove that a source fleet
		// actually owned this workspace. Bind readiness to a healthy worker in
		// this same kernel scope before recording its source-run witness.
		for !sourceWorkerReady(ctx) {
			select {
			case <-finished:
				return
			case <-time.After(500 * time.Millisecond):
			}
		}
		dir := filepath.Join(ctx.Instance.Dir, "source-runs")
		if err := ensureSafeDirectory(dir); err != nil {
			return
		}
		_ = writeJSONAtomic(filepath.Join(dir, id+".json"), sourceExecutionMarker{1, ctx.Instance.ID, id})
	}()
	signals := make(chan os.Signal, 2)
	signal.Notify(signals, os.Interrupt, syscall.SIGTERM)
	defer signal.Stop(signals)
	done := make(chan error, 1)
	go func() { done <- child.Wait(); close(finished) }()
	stopping := false
	for {
		select {
		case sig := <-signals:
			if !stopping {
				stopping = true
				_ = child.Process.Signal(sig)
			}
		case err := <-done:
			if stopping {
				// The scope controller still proves the child scope has drained.
				return nil
			}
			return err
		}
	}
}

func sourceWorkerReady(ctx launchContext) bool {
	values := environmentMap(ctx.Environment)
	if address := values["TEMPORAL_ADDRESS"]; address != "" && address != "localhost:7233" && address != "127.0.0.1:7233" && address != "[::1]:7233" {
		return false
	}
	host, port := values["JOBCTRL_API_HOST"], values["JOBCTRL_API_PORT"]
	if host == "" {
		host = "127.0.0.1"
	}
	if port == "" {
		port = "8766"
	}
	if host != "localhost" && (net.ParseIP(host) == nil || !net.ParseIP(host).IsLoopback()) {
		return false
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return false
	}
	client := http.Client{Timeout: time.Second, Transport: &http.Transport{Proxy: nil, DisableKeepAlives: true}}
	response, err := client.Get("http://" + net.JoinHostPort(host, port) + "/v1/health")
	if err != nil {
		return false
	}
	defer response.Body.Close()
	var result struct {
		OK     bool   `json:"ok"`
		DBPath string `json:"dbPath"`
		AppDir string `json:"appDir"`
		Worker struct {
			Status    string `json:"status"`
			Heartbeat *struct {
				PID int `json:"pid"`
			} `json:"heartbeat"`
		} `json:"worker"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&result) != nil ||
		!result.OK || result.Worker.Status != "healthy" || result.Worker.Heartbeat == nil || result.Worker.Heartbeat.PID <= 0 {
		return false
	}
	if !sourcePathMatches(result.DBPath, filepath.Join(ctx.Instance.StateDir, "jobctrl.db")) || !sourcePathMatches(result.AppDir, ctx.Instance.StateDir) {
		return false
	}
	pid := result.Worker.Heartbeat.PID
	before, err := processStartIdentity(pid)
	if err != nil {
		return false
	}
	worker, err := processCoalitionIDs(pid)
	if err != nil {
		return false
	}
	current, err := processCoalitionIDs(os.Getpid())
	if err != nil || worker != current {
		return false
	}
	after, err := processStartIdentity(pid)
	return err == nil && before == after && sourceTemporalHistoryReady(ctx, pid, current)
}

// A healthy worker alone can be connected to another Temporal server. Only
// record a source witness once a different process in this same kernel scope
// has the selected history open as well.
func sourceTemporalHistoryReady(ctx launchContext, workerPID int, scope [2]uint64) bool {
	path, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return false
	}
	output, err := exec.Command("/usr/sbin/lsof", "-nP", "-Fp", path).Output()
	if err != nil {
		return false
	}
	for _, line := range strings.Split(string(output), "\n") {
		if !strings.HasPrefix(line, "p") {
			continue
		}
		pid, err := strconv.Atoi(strings.TrimPrefix(line, "p"))
		if err != nil || pid <= 0 || pid == workerPID || pid == os.Getpid() {
			continue
		}
		before, err := processStartIdentity(pid)
		if err != nil {
			continue
		}
		ids, err := processCoalitionIDs(pid)
		if err != nil || ids != scope {
			continue
		}
		after, err := processStartIdentity(pid)
		if err == nil && before == after {
			return true
		}
	}
	return false
}

func sourceHasFullFleet(targets []string) bool {
	if len(targets) == 0 {
		return true
	}
	seen := map[string]bool{}
	for _, target := range targets {
		seen[target] = true
	}
	return seen["temporal"] && seen["api"] && seen["worker"]
}

func refuseBackupOfRunningSource(ctx launchContext) error {
	scopes, err := readOwnedExecutionScopes(ctx)
	if err != nil {
		return err
	}
	for _, scope := range scopes {
		if scope.Purpose == "source" {
			return errors.New("stop the source development stack before running the installed backup command")
		}
	}
	state, err := readState(ctx.Instance.StatePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if state.BuildID == "source" && stateHasLiveProcesses(state) {
		return errors.New("stop the source development stack before running the installed backup command")
	}
	return nil
}

func sourcePathMatches(path, expected string) bool {
	if path == "" || !filepath.IsAbs(path) {
		return false
	}
	resolve := func(value string) (string, error) {
		if resolved, err := filepath.EvalSymlinks(value); err == nil {
			return resolved, nil
		} else if !errors.Is(err, os.ErrNotExist) {
			return "", err
		}
		parent, err := filepath.EvalSymlinks(filepath.Dir(value))
		if err != nil {
			return "", err
		}
		return filepath.Join(parent, filepath.Base(value)), nil
	}
	actual, err := resolve(filepath.Clean(path))
	if err != nil {
		return false
	}
	want, err := resolve(expected)
	return err == nil && actual == want
}

func validateSourceWorkspacePaths(ctx launchContext) error {
	values := environmentMap(ctx.Environment)
	if address := values["TEMPORAL_ADDRESS"]; address != "" && address != "localhost:7233" && address != "127.0.0.1:7233" && address != "[::1]:7233" {
		return errors.New("the shared workspace requires the local Temporal server at localhost:7233")
	}
	if namespace := values["TEMPORAL_NAMESPACE"]; namespace != "" && namespace != "default" {
		return errors.New("the shared workspace requires the default Temporal namespace")
	}
	if configured := values["JOBCTRL_DB_PATH"]; configured != "" && !sourcePathMatches(configured, filepath.Join(ctx.Instance.StateDir, "jobctrl.db")) {
		return errors.New("the source database must belong to JOBCTRL_DIR; use a separate JOBCTRL_DIR for an isolated workspace")
	}
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return err
	}
	if configured := values["JOBCTRL_TEMPORAL_DB"]; configured != "" && !sourcePathMatches(configured, temporal) {
		return errors.New("the Temporal history must belong to the shared JOBCTRL_DIR workspace")
	}
	return nil
}
