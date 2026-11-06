package launcher

// Python-application admission is deliberately separate from historical schema
// migrations. The breaking transition preserves Profile into a fresh workspace;
// a launcher must never turn starting/updating into an implicit data reset.

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const pythonApplicationID = 0x4A435354

func usesPythonApplication(manifest runtimeManifest) bool {
	for _, component := range manifest.Components {
		if component.Name != "api" || component.Executable != "python/bin/python3" {
			continue
		}
		for index, argument := range component.Arguments {
			if argument == "-m" && index+1 < len(component.Arguments) && component.Arguments[index+1] == "jobctrl.app.server" {
				return true
			}
		}
	}
	return false
}

// A retained historical payload may be inspected, backed up or explicitly
// stopped/uninstalled. It can never launch an old API, worker or business CLI.
func historicalInspectionCommand(args []string) bool {
	if len(args) == 0 {
		return true
	}
	switch args[0] {
	case "help", "--help", "-h", "stop", "logs", "version", "backup", "uninstall":
		return true
	case "status":
		for _, argument := range args[1:] {
			if argument == "--pipeline" {
				return false
			}
		}
		return true
	default:
		return false
	}
}

func checkPythonApplicationWorkspace(ctx launchContext) error {
	database := filepath.Join(ctx.Instance.StateDir, "jobctrl.db")
	info, err := os.Lstat(database)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Python application database must be a regular file")
	}
	if err := refuseUnresolvedInitialization(database, info); err != nil {
		return err
	}
	python := migrationPython(ctx)
	code := `import os,pathlib,sqlite3,stat,struct,sys
path=pathlib.Path(sys.argv[1])
fd=os.open(path,os.O_RDONLY|getattr(os,"O_NOFOLLOW",0))
try:
    info=os.fstat(fd)
    header=os.read(fd,100)
finally: os.close(fd)
if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or (os.name!="nt" and (info.st_uid!=os.getuid() or info.st_mode&0o077)):
    raise SystemExit(2)
if len(header)!=100 or header[:16]!=b"SQLite format 3\x00":
    raise SystemExit(3)
# The target identity is published before WAL is enabled. Never open SQLite
# against a legacy workspace: even mode=ro can create WAL shared memory.
if struct.unpack(">I",header[68:72])[0]!=0x4A435354 or struct.unpack(">I",header[60:64])[0]!=1:
    print("profile-transfer-required")
    raise SystemExit(0)
p=path.resolve().as_uri()+"?mode=ro"
c=sqlite3.connect(p,uri=True,timeout=2)
try:
    application=c.execute("PRAGMA application_id").fetchone()[0]
    version=c.execute("PRAGMA user_version").fetchone()[0]
    if application != 0x4A435354 or version != 1:
        print("profile-transfer-required")
    else:
        metadata=dict(c.execute("SELECT key,value FROM app_metadata"))
        print("compatible" if metadata=={"application":"jobctrl-python","schema_version":"1"} else "incompatible")
finally: c.close()`
	command := payloadCommand(ctx.Environment, python, "-I", "-B", "-c", code, database)
	command.Env = ctx.Environment
	output, err := command.Output()
	if err != nil || len(output) > 128 {
		return errors.New("cannot inspect Python application database; preserve the workspace and inspect its access/schema")
	}
	if strings.TrimSpace(string(output)) != "compatible" {
		return errors.New("workspace requires explicit Profile-only transfer: jobctrl profile-transfer --source SOURCE --target NEW_WORKSPACE --confirm-profile-only-reset --browser-sources BROWSER_MANIFEST.json; then select JOBCTRL_DIR=NEW_WORKSPACE. Source data is preserved")
	}
	return nil
}
