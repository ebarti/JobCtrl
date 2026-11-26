package launcher

import (
	"context"
	"errors"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Only the explicit credentials command can open this private socket. Desktop
// and source clients use the normal workspace socket, which stays offline.
func migrateStoppedCredentials(ctx launchContext, args []string, stdout, stderr io.Writer) (result error) {
	if ctx.SourcePython == "" && ctx.Manifest.SchemaVersion != 2 {
		return errors.New("credential migration requires an initialized PostgreSQL workspace")
	}
	if err := checkDatabasePublication(filepath.Join(ctx.Instance.StateDir, "jobctrl.db")); err != nil {
		return err
	}
	owned, err := authenticatedOwnedExecution(ctx)
	if err != nil || !owned {
		return errors.Join(errors.New("credential migration requires its authenticated workspace scope"), err)
	}
	// Serialize new CLI admissions and starts for the duration of native
	// mutation. The credential service independently serializes the OS store.
	control, err := acquireLock(ctx.Instance.ControlPath, false)
	if err != nil {
		return err
	}
	defer releaseLock(control)
	instance, err := acquireLock(ctx.Instance.LockPath, true)
	if err != nil {
		return errors.New("stop the JobCtrl workspace before migrating credentials")
	}
	defer releaseLock(instance)
	state, err := readState(ctx.Instance.StatePath)
	if err != nil {
		return errors.Join(errors.New("stop the initialized JobCtrl workspace before migrating credentials"), err)
	}
	if err := validateStateIdentity(ctx, state); err != nil {
		return err
	}
	if !state.OwnershipVerified || state.StoppedAt == nil {
		return errors.New("verified stopped workspace required for credential migration")
	}
	if remaining, err := inspectOwnedProcesses(ctx, state); err != nil {
		return err
	} else if len(remaining) != 0 {
		return errors.New("other workspace activity is registered; run jobctrl stop before migrating credentials")
	}
	active, err := readPostgresSelection(ctx, "active.json")
	if err != nil {
		return errors.Join(errors.New("credential migration requires an existing active PostgreSQL generation"), err)
	}
	data := active.path(ctx)
	if err := coldPostgres(data); err != nil {
		return err
	}
	socket, err := os.MkdirTemp("/private/tmp", "jc-pg-credentials-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(socket)
	environment := make([]string, 0, len(ctx.Environment)+1)
	for _, entry := range ctx.Environment {
		if !strings.HasPrefix(entry, "PG") && !strings.HasPrefix(entry, "DBOS_") && !strings.HasPrefix(entry, "JOBCTRL_DATABASE_URL=") {
			environment = append(environment, entry)
		}
	}
	ctx.Environment = append(environment, "JOBCTRL_DATABASE_URL="+postgresSocketURL(socket))
	stopping, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer cancel()
	cmd := localCommand(ctx, postgresTool(ctx, "postgres"), "-D", data, "-c", "listen_addresses=", "-c", "unix_socket_directories="+socket, "-c", "unix_socket_permissions=0700", "-p", "5432")
	if err := cmd.Start(); err != nil {
		return err
	}
	done := make(chan struct{})
	var exitErr error
	go func() { exitErr = cmd.Wait(); close(done) }()
	defer func() {
		// Fast shutdown drains clients and checkpoints the cluster before the
		// original workspace lock or the command's process scope can retire.
		select {
		case <-done:
		default:
			_ = cmd.Process.Signal(syscall.SIGINT)
			<-done
		}
		if exitErr != nil {
			result = errors.Join(result, errors.New("credential maintenance PostgreSQL exited unexpectedly"))
		}
		result = errors.Join(result, coldPostgres(data))
	}()
	deadline := time.NewTimer(startupTimeout)
	defer deadline.Stop()
	for {
		pid, e := postgresPIDForSocket(data, socket)
		if e == nil && pid == cmd.Process.Pid {
			actual, e := postgresCommand(ctx, "psql", "-XAtw", "-h", socket, "-p", "5432", "-U", "jobctrl", "-d", "jobctrl", "-c", "SHOW data_directory")
			if e == nil && actual == data {
				break
			}
		}
		select {
		case <-done:
			return errors.New("credential maintenance PostgreSQL did not become ready")
		case <-stopping.Done():
			return stopping.Err()
		case <-deadline.C:
			return errors.New("credential maintenance PostgreSQL startup timed out")
		case <-time.After(150 * time.Millisecond):
		}
	}
	python := migrationPython(ctx)
	probe := localCommand(ctx, python, "-I", "-B", "-c", `from pathlib import Path
import sys
from jobctrl.app.database import Database
status = Database.probe(Path(sys.argv[1]))
sys.exit(0 if status and status["state"] == "active" else 1)`, ctx.Instance.StateDir)
	if err := probe.Run(); err != nil {
		return errors.New("the credential database does not match this workspace")
	}
	command := localCommand(ctx, python, append([]string{"-I", "-B", "-m", "jobctrl", "credentials", "migrate"}, args...)...)
	command.Dir, err = os.Getwd()
	if err != nil {
		return err
	}
	command.Stdout, command.Stderr = stdout, stderr
	if err := stopping.Err(); err != nil {
		return err
	}
	if err := command.Start(); err != nil {
		return err
	}
	finished := make(chan error, 1)
	go func() { finished <- command.Wait() }()
	select {
	case err := <-finished:
		return err
	case <-stopping.Done():
		_ = command.Process.Signal(syscall.SIGTERM)
		return errors.Join(stopping.Err(), <-finished)
	}
}
