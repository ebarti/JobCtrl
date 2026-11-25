//go:build darwin

package launcher

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
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
	if len(args) < 2 || (args[0] != "run" && args[0] != "stop" && args[0] != "switch" && args[0] != "verify" && args[0] != "postgres" && args[0] != "__source-run") {
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
		case "postgres", "api", "web", "worker", "docs", "demo-api", "demo-web":
		default:
			return fmt.Errorf("unknown source component %q", name)
		}
	}
	inst, err := resolveInstance(env)
	if err != nil {
		return err
	}
	ctx := launchContext{Executable: executable, Instance: inst, Environment: env}
	if args[0] == "postgres" {
		if len(args) != 2 {
			return errors.New("usage: jobctrl-source postgres SOURCE_ROOT")
		}
		return sourcePostgres(ctx, root)
	}
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
	if err := checkPythonApplicationWorkspace(ctx); err != nil {
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
	child := payloadCommand(ctx.Environment, "/bin/bash", arguments...)
	child.Dir = filepath.Dir(filepath.Dir(script))
	child.Env = make([]string, 0, len(ctx.Environment)+3)
	for _, pair := range ctx.Environment {
		if !strings.HasPrefix(pair, "JOBCTRL_DEV_INNER=") && !strings.HasPrefix(pair, "JOBCTRL_DIR=") && !strings.HasPrefix(pair, "JOBCTRL_SOURCE_LAUNCHER=") {
			child.Env = append(child.Env, pair)
		}
	}
	// The service owner must retain the process that forwards TERM to the
	// postmaster. A go-run wrapper can exit before its compiled child drains.
	child.Env = append(child.Env, "JOBCTRL_DEV_INNER=1", "JOBCTRL_DIR="+ctx.Instance.StateDir, "JOBCTRL_SOURCE_LAUNCHER="+ctx.Executable)
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
		OK          bool   `json:"ok"`
		Application string `json:"application"`
		WorkspaceID string `json:"workspaceId"`
		Worker      struct {
			Status string `json:"status"`
			PID    int    `json:"pid"`
		} `json:"worker"`
	}
	if response.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(response.Body, 64<<10)).Decode(&result) != nil ||
		!result.OK || result.Application != "jobctrl-python" || result.Worker.Status != "healthy" || result.Worker.PID <= 0 {
		return false
	}
	if result.WorkspaceID != ctx.Instance.ID {
		return false
	}
	pid := result.Worker.PID
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
	if err != nil || before != after {
		return false
	}
	server, err := postgresPID(ctx)
	if err != nil {
		return false
	}
	serverIDs, err := processCoalitionIDs(server)
	return err == nil && serverIDs == current
}

func sourceHasFullFleet(targets []string) bool {
	if len(targets) == 0 {
		return true
	}
	seen := map[string]bool{}
	for _, target := range targets {
		seen[target] = true
	}
	return seen["postgres"] && seen["api"] && seen["worker"]
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

func validateSourceWorkspacePaths(ctx launchContext) error {
	values := environmentMap(ctx.Environment)
	if configured := values["JOBCTRL_DATABASE_URL"]; configured != "" {
		u, err := url.Parse(configured)
		if err != nil || u.Scheme != "postgresql" || u.Host != "" || u.Path != "/jobctrl" || (u.User == nil || u.User.String() != "jobctrl") || u.Query().Get("host") != postgresSocket(ctx.Instance.StateDir) || u.Query().Get("port") != "5432" || len(u.Query()) != 2 {
			return errors.New("source database URL must select the workspace's managed PostgreSQL socket")
		}
	}
	return nil
}

func sourcePostgres(ctx launchContext, root string) error {
	owned, err := authenticatedOwnedExecution(ctx)
	if err != nil || !owned {
		return errors.Join(errors.New("source PostgreSQL requires its workspace execution scope"), err)
	}
	ctx.SourcePython = filepath.Join(root, "workers", "automation", ".venv", "bin", "python")
	dir := environmentMap(ctx.Environment)["JOBCTRL_POSTGRES_BIN_DIR"]
	if dir == "" {
		dir = filepath.Join(root, ".dev", "postgres-runtime", "bin")
	}
	if !filepath.IsAbs(dir) {
		return errors.New("PostgreSQL binaries require an absolute directory")
	}
	ctx.Environment = append(ctx.Environment, "JOBCTRL_POSTGRES_BIN_DIR="+dir, "JOBCTRL_DATABASE_URL="+postgresURL(ctx.Instance.StateDir))
	if err := checkPythonApplicationWorkspace(ctx); err != nil {
		return err
	}
	selection, err := preparePostgres(ctx)
	if err != nil {
		return err
	}
	ctx.PostgresData = selection.path(ctx)
	cmd := localCommand(ctx, postgresTool(ctx, "postgres"), "-D", ctx.PostgresData, "-c", "listen_addresses=", "-c", "unix_socket_directories="+postgresSocket(ctx.Instance.StateDir), "-c", "unix_socket_permissions=0700", "-p", "5432")
	cmd.Stdout, cmd.Stderr = os.Stdout, os.Stderr
	stop, done := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer done()
	if err = cmd.Start(); err != nil {
		return err
	}
	exited := make(chan error, 1)
	go func() { exited <- cmd.Wait() }()
	shutdown := func() error { _ = cmd.Process.Signal(syscall.SIGINT); return <-exited }
	deadline := time.NewTimer(startupTimeout)
	defer deadline.Stop()
	for verifyPostmaster(ctx) != nil {
		select {
		case <-stop.Done():
			return shutdown()
		case err := <-exited:
			return fmt.Errorf("source PostgreSQL exited before readiness: %v", err)
		case <-deadline.C:
			_ = shutdown()
			return errors.New("PostgreSQL startup timed out")
		case <-time.After(150 * time.Millisecond):
		}
	}
	if err := admitPostgres(ctx, selection, cmd.Process.Pid); err != nil {
		_ = shutdown()
		return err
	}
	select {
	case err := <-exited:
		return err
	case <-stop.Done():
		return shutdown()
	}
}
