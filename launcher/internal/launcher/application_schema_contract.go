package launcher

// The application identity is independent of launcher protocol compatibility.
// A signed target release must declare the exact database it understands; a
// historical migration declaration cannot authorize this breaking cutover.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

const pythonApplicationUserVersion = int64(1)
const applicationSchemaContractPath = "launcher/application-schema.json"
const applicationSchemaContractBytes = "{\"schemaVersion\":1,\"application\":\"jobctrl-python\",\"applicationId\":1245926228,\"userVersion\":1}\n"

func readPythonApplicationSchemaContract(verified verifiedRelease) error {
	if !usesPythonApplication(verified.runtime) || verified.runtime.LauncherProtocol != launcherProtocol || !protocolSupports(verified.distribution, launcherProtocol) {
		return errors.New("release is not a compatible Python application; preserve the source and use explicit Profile-only transfer into a fresh workspace")
	}
	var digest string
	count := 0
	for _, file := range verified.distribution.Files {
		if file.Path != applicationSchemaContractPath {
			continue
		}
		count++
		if file.Type != "file" || file.Mode != "0644" || file.SizeBytes != int64(len(applicationSchemaContractBytes)) || !validSHA256(file.SHA256) {
			return errors.New("application schema declaration has invalid signed file metadata")
		}
		digest = file.SHA256
	}
	if count != 1 {
		return errors.New("release must declare exactly one authenticated Python application schema")
	}
	dir := filepath.Join(verified.payloadRoot, "launcher")
	info, err := os.Lstat(dir)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("application schema directory is not a regular directory")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return fmt.Errorf("open application schema directory: %w", err)
	}
	defer root.Close()
	opened, err := root.Stat(".")
	if err != nil || !os.SameFile(info, opened) {
		return errors.New("application schema directory changed during admission")
	}
	file, err := root.OpenFile("application-schema.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return fmt.Errorf("open authenticated application schema declaration: %w", err)
	}
	defer file.Close()
	stat, err := file.Stat()
	if err != nil || !stat.Mode().IsRegular() || stat.Mode().Perm() != 0o644 || stat.Size() != int64(len(applicationSchemaContractBytes)) {
		return errors.New("application schema declaration differs from signed file metadata")
	}
	raw, err := io.ReadAll(io.LimitReader(file, int64(len(applicationSchemaContractBytes)+1)))
	if err != nil {
		return errors.New("cannot read application schema declaration")
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != digest || !bytes.Equal(raw, []byte(applicationSchemaContractBytes)) {
		return errors.New("authenticated release does not declare the exact Python application identity")
	}
	return nil
}

func admitPythonApplicationLifecycle(ctx launchContext, verified verifiedRelease) error {
	if err := readPythonApplicationSchemaContract(verified); err != nil {
		return err
	}
	if err := checkPythonApplicationWorkspace(verifiedReleaseContext(ctx, verified)); err != nil {
		return err
	}
	temporal, err := temporalHistoryPath(ctx.Instance.StateDir)
	if err != nil {
		return err
	}
	if temporal != filepath.Join(ctx.Instance.StateDir, "temporal.db") {
		return errors.New("legacy Temporal history requires explicit Profile-only transfer into a fresh workspace; source data is preserved")
	}
	return nil
}

// Pair metadata binds both files and the target identity. Inspect self-contained
// backup bytes only; an unfamiliar sidecar must not become restore authority.
func verifyPythonApplicationPair(ctx launchContext, pair databasePair) error {
	if pair.SchemaVersion != 1 || !pair.ReleaseReceipt.Valid() || pair.CreatedAt.IsZero() || len(pair.Files) != 2 ||
		!filepath.IsLocal(pair.ID) || filepath.Base(pair.ID) != pair.ID || pair.ID == "." {
		return errors.New("backup is not a complete bound target database pair")
	}
	dir := filepath.Join(ctx.Instance.StateDir, "backups", pair.ID)
	for _, path := range []string{filepath.Join(ctx.Instance.StateDir, "backups"), dir} {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("backup pair path is not a regular directory")
		}
	}
	seen := map[string]bool{}
	for _, expected := range pair.Files {
		if (expected.Name != "jobctrl.db" && expected.Name != "temporal.db") || seen[expected.Name] || expected.SizeBytes <= 0 || !validSHA256(expected.SHA256) || expected.SQLiteUserVer < 0 {
			return errors.New("backup pair contains an invalid or repeated database")
		}
		seen[expected.Name] = true
		if expected.Name == "jobctrl.db" && (expected.SQLiteApplicationID != pythonApplicationID || expected.SQLiteUserVer != pythonApplicationUserVersion) {
			return errors.New("legacy or unknown database pair cannot be restored into the Python application")
		}
		for _, suffix := range []string{"-wal", "-shm", "-journal"} {
			if _, err := os.Lstat(filepath.Join(dir, expected.Name+suffix)); !errors.Is(err, os.ErrNotExist) {
				return errors.New("backup database pair has an unverified SQLite companion")
			}
		}
		actual, err := describeDatabase(filepath.Join(dir, expected.Name), expected.Name, expected.SQLiteUserVer)
		if err != nil || actual.SHA256 != expected.SHA256 || actual.SizeBytes != expected.SizeBytes {
			return errors.New("backup database pair digest/size verification failed")
		}
	}
	backupContext := ctx
	backupContext.Instance.StateDir = dir
	return checkPythonApplicationWorkspace(backupContext)
}

// Model calls may have charged an external provider even after its process
// exits. A rollback cannot remove unresolved accounting from the live ledger.
func refuseUnresolvedPythonSpendRecovery(ctx launchContext) error {
	if err := checkPythonApplicationWorkspace(ctx); err != nil {
		return err
	}
	code := `import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro"
c=sqlite3.connect(p,uri=True,timeout=2)
try:
    row=c.execute("SELECT 1 FROM app_model_calls WHERE (provider_started IS NULL OR provider_started!=0) AND (status IN ('running','uncertain') OR cost_usd IS NULL OR input_tokens IS NULL OR output_tokens IS NULL OR cost_source IS NULL) LIMIT 1").fetchone()
    print("unresolved" if row else "settled")
finally: c.close()`
	command := payloadCommand(ctx.Environment, migrationPython(ctx), "-I", "-B", "-c", code, filepath.Join(ctx.Instance.StateDir, "jobctrl.db"))
	command.Env = ctx.Environment
	output, err := command.Output()
	if err != nil || !bytes.Equal(output, []byte("settled\n")) {
		return errors.New("Python application model accounting is unresolved or cannot be verified; preserve the live database, receipts, paired backups and transition journal")
	}
	return nil
}
