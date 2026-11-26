package launcher

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
)

type postgresSelection struct {
	SchemaVersion int    `json:"schemaVersion"`
	WorkspaceID   string `json:"workspaceId"`
	Generation    string `json:"generation"`
}

var errDesktopSQLiteUpgrade = errors.New("existing SQLite workspace requires a verified PostgreSQL upgrade before desktop startup")

func postgresRoot(ctx launchContext) string { return filepath.Join(ctx.Instance.StateDir, "postgres") }
func (s postgresSelection) path(ctx launchContext) string {
	return filepath.Join(postgresRoot(ctx), s.Generation)
}
func postgresSocket(workspace string) string {
	sum := sha256.Sum256([]byte(workspace))
	return filepath.Join("/private/tmp", fmt.Sprintf("jobctrl-pg-%d-%x", os.Getuid(), sum[:12]))
}
func postgresURL(workspace string) string {
	return postgresSocketURL(postgresSocket(workspace))
}
func postgresSocketURL(socket string) string {
	query := url.Values{"host": {socket}, "port": {"5432"}}
	return "postgresql://jobctrl@/jobctrl?" + query.Encode()
}
func privatePostgresPath(path string, dir bool) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || int(owner.Uid) != os.Getuid() || info.Mode().Perm()&0077 != 0 || info.Mode()&os.ModeSymlink != 0 || (dir && !info.IsDir()) || (!dir && (!info.Mode().IsRegular() || owner.Nlink != 1)) {
		return errors.New("PostgreSQL storage must be a private owned regular path")
	}
	return nil
}
func ensurePostgresDirectory(path string) error {
	if err := os.Mkdir(path, 0700); err != nil && !errors.Is(err, os.ErrExist) {
		return err
	}
	return privatePostgresPath(path, true)
}
func readPostgresSelection(ctx launchContext, name string) (s postgresSelection, err error) {
	root := postgresRoot(ctx)
	if err = privatePostgresPath(root, true); err != nil {
		return
	}
	path := filepath.Join(root, name)
	if err = privatePostgresPath(path, false); err != nil {
		return
	}
	if err = decodeStrictRegular(path, &s); err != nil {
		return
	}
	raw, e := hex.DecodeString(s.Generation)
	if e != nil || len(raw) != 16 || s.Generation != hex.EncodeToString(raw) || s.SchemaVersion != 1 || s.WorkspaceID != ctx.Instance.ID {
		err = errors.New("invalid PostgreSQL selection for this workspace")
	}
	return
}
func validatePostgresVersion(data string) error {
	if err := privatePostgresPath(data, true); err != nil {
		return err
	}
	path := filepath.Join(data, "PG_VERSION")
	if err := privatePostgresPath(path, false); err != nil {
		return err
	}
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != "17\n" {
		return errors.New("unsupported PostgreSQL data directory; preserve the cluster before upgrading")
	}
	return nil
}
func postgresTool(ctx launchContext, name string) string {
	if ctx.SourcePython != "" {
		return filepath.Join(environmentMap(ctx.Environment)["JOBCTRL_POSTGRES_BIN_DIR"], name)
	}
	return filepath.Join(ctx.PayloadRoot, "postgres", "bin", name)
}
func localCommand(ctx launchContext, exe string, args ...string) *exec.Cmd {
	cmd := payloadCommand(ctx.Environment, exe, args...)
	cmd.Env = ctx.Environment
	cmd.Dir = ctx.Instance.StateDir
	return cmd
}
func postgresCommand(ctx launchContext, name string, args ...string) (string, error) {
	out := &boundedProbeOutput{}
	cmd := localCommand(ctx, postgresTool(ctx, name), args...)
	cmd.Stdout, cmd.Stderr = out, out
	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("PostgreSQL %s: %w: %s", name, err, out.String())
	}
	return strings.TrimSpace(out.String()), nil
}
func preparePostgres(ctx launchContext) (postgresSelection, error) {
	var empty postgresSelection
	workspace, err := os.Lstat(ctx.Instance.StateDir)
	if err != nil {
		return empty, err
	}
	owner, owned := workspace.Sys().(*syscall.Stat_t)
	if !owned || int(owner.Uid) != os.Getuid() || !workspace.IsDir() || workspace.Mode().Perm()&0022 != 0 {
		return empty, errors.New("PostgreSQL requires an owned workspace directory protected from other writers")
	}
	if err := ensurePostgresDirectory(postgresSocket(ctx.Instance.StateDir)); err != nil {
		return empty, err
	}
	root := postgresRoot(ctx)
	if err := ensurePostgresDirectory(root); err != nil {
		return empty, err
	}
	active, err := readPostgresSelection(ctx, "active.json")
	if err == nil {
		return active, validatePostgresVersion(active.path(ctx))
	}
	if !errors.Is(err, os.ErrNotExist) {
		return empty, err
	}
	pending, err := readPostgresSelection(ctx, "pending.json")
	if errors.Is(err, os.ErrNotExist) {
		entries, e := os.ReadDir(root)
		if e != nil {
			return empty, e
		}
		if len(entries) != 0 {
			return empty, errors.New("unbound PostgreSQL files exist; preserve the workspace for recovery")
		}
		// A missing cluster with an already bound application identity cannot be reinitialized.
		if _, e = os.Lstat(filepath.Join(ctx.Instance.StateDir, ".jobctrl-postgres-identity")); !errors.Is(e, os.ErrNotExist) {
			return empty, errors.New("workspace identity exists without its PostgreSQL cluster")
		}
		id, e := releaseRandomID()
		if e != nil {
			return empty, e
		}
		pending = postgresSelection{1, ctx.Instance.ID, id}
		if e = writeJSONAtomic(filepath.Join(root, "pending.json"), pending); e != nil {
			return empty, e
		}
	} else if err != nil {
		return empty, err
	}
	data := pending.path(ctx)
	if _, err := os.Lstat(data); err == nil {
		return pending, validatePostgresVersion(data)
	} else if !errors.Is(err, os.ErrNotExist) {
		return empty, err
	}
	stage, err := os.MkdirTemp(root, ".init-")
	if err != nil {
		return empty, err
	}
	defer os.RemoveAll(stage)
	if _, err := postgresCommand(ctx, "initdb", "--pgdata", stage, "--encoding=UTF8", "--locale=C", "--username=jobctrl", "--auth-local=trust", "--auth-host=reject", "--no-instructions"); err != nil {
		return empty, err
	}
	if err := os.Rename(stage, data); err != nil {
		return empty, err
	}
	return pending, syncDirectory(root)
}
func verifyPostmaster(ctx launchContext) error {
	got, err := postgresCommand(ctx, "psql", "-XAtw", "-h", postgresSocket(ctx.Instance.StateDir), "-p", "5432", "-U", "jobctrl", "-d", "postgres", "-c", "SHOW data_directory")
	if err != nil {
		return err
	}
	if got != ctx.PostgresData {
		return errors.New("workspace socket belongs to another PostgreSQL data directory")
	}
	return nil
}
func admitPostgres(ctx launchContext, selection postgresSelection, expectedPID int) error {
	pid, err := postgresPIDForData(ctx, selection.path(ctx))
	if err != nil || pid != expectedPID {
		return errors.New("workspace PostgreSQL is not the postmaster started by this supervisor")
	}
	if err := verifyPostmaster(ctx); err != nil {
		return err
	}
	active, err := readPostgresSelection(ctx, "active.json")
	if err == nil && active != selection {
		return errors.New("active PostgreSQL generation changed")
	}
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	activeAlready := err == nil
	if !activeAlready {
		socket := postgresSocket(ctx.Instance.StateDir)
		base := []string{"-h", socket, "-p", "5432", "-U", "jobctrl"}
		query := []string{"-XAtw", "-d", "postgres", "-c", "SELECT count(*) FROM pg_database WHERE datname='jobctrl'"}
		count, e := postgresCommand(ctx, "psql", append(base, query...)...)
		if e != nil {
			return e
		}
		if count == "0" {
			if _, e = postgresCommand(ctx, "createdb", append(base, "-w", "--encoding=UTF8", "--template=template0", "jobctrl")...); e != nil {
				return e
			}
		} else if count != "1" {
			return errors.New("cannot establish workspace database identity")
		}
	}
	python := migrationPython(ctx)
	src := filepath.Join(ctx.Instance.StateDir, "jobctrl.db")
	_, sourceErr := os.Lstat(src)
	if sourceErr != nil && !errors.Is(sourceErr, os.ErrNotExist) {
		return sourceErr
	}
	if !activeAlready && sourceErr == nil {
		if err := checkPythonApplicationWorkspace(ctx); err != nil {
			return err
		}
		temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
		if err != nil {
			return err
		}
		if err = refuseOpenWorkspaceDatabases(src, temporal); err != nil {
			return err
		}
		return errDesktopSQLiteUpgrade
	} else if !activeAlready {
		cmd := localCommand(ctx, python, "-I", "-B", "-c", "from pathlib import Path; from jobctrl.app.database import Database; import sys; Database(Path(sys.argv[1]))", ctx.Instance.StateDir)
		if err := cmd.Run(); err != nil {
			return fmt.Errorf("initialize PostgreSQL workspace: %w", err)
		}
	}
	cmd := localCommand(ctx, python, "-I", "-B", "-c", `from pathlib import Path
import sys
from jobctrl.app.database import Database
p=Database.probe(Path(sys.argv[1]))
raise SystemExit(0 if p and p['state']=='active' else 1)`, ctx.Instance.StateDir)
	if err := cmd.Run(); err != nil {
		return errors.New("database is not bound and active for this workspace; preserve the cluster")
	}
	if journal := environmentMap(ctx.Environment)["JOBCTRL_TRANSITION_JOURNAL"]; journal != "" {
		cmd := localCommand(ctx, python, "-I", "-B", "-m", "jobctrl.app.workflow_compat", "--workspace", ctx.Instance.StateDir)
		if err := cmd.Run(); err != nil {
			return errors.New("candidate is incompatible with pending durable work; live database and receipts preserved")
		}
	}
	if activeAlready {
		return nil
	}
	if err := os.Rename(filepath.Join(postgresRoot(ctx), "pending.json"), filepath.Join(postgresRoot(ctx), "active.json")); err != nil {
		return err
	}
	return syncDirectory(postgresRoot(ctx))
}
func postgresPID(ctx launchContext) (int, error) {
	active, err := readPostgresSelection(ctx, "active.json")
	if err != nil {
		return 0, err
	}
	return postgresPIDForData(ctx, active.path(ctx))
}
func postgresPIDForData(ctx launchContext, data string) (int, error) {
	return postgresPIDForSocket(data, postgresSocket(ctx.Instance.StateDir))
}
func postgresPIDForSocket(data, socket string) (int, error) {
	raw, err := os.ReadFile(filepath.Join(data, "postmaster.pid"))
	if err != nil {
		return 0, err
	}
	fields := strings.Split(string(raw), "\n")
	if len(fields) < 6 || fields[1] != data || fields[4] != socket {
		return 0, errors.New("postmaster identity does not match workspace")
	}
	return strconv.Atoi(fields[0])
}

func preflightPostgresUpdate(ctx launchContext) error {
	selected, err := readPostgresSelection(ctx, "active.json")
	if errors.Is(err, os.ErrNotExist) {
		return nil
	} // A current Python SQLite predecessor is checked by its staged importer.
	if err != nil {
		return err
	}
	data := selected.path(ctx)
	var check *exec.Cmd
	if _, err = os.Lstat(filepath.Join(data, "postmaster.pid")); err == nil {
		ctx.PostgresData = data
		if err := verifyPostmaster(ctx); err != nil {
			return err
		}
		check = localCommand(ctx, migrationPython(ctx), "-I", "-B", "-m", "jobctrl.app.workflow_compat", "--workspace", ctx.Instance.StateDir)
	} else {
		if err := coldPostgres(data); err != nil {
			return err
		}
		check = localCommand(ctx, migrationPython(ctx), "-I", "-B", "-c", postgresFileProof, postgresTool(ctx, "postgres"), data, ctx.Instance.StateDir, "workflows")
	}
	if err := check.Run(); err != nil {
		return errors.New("candidate cannot resume all pending workflows and action contracts; current release preserved")
	}
	return nil
}
