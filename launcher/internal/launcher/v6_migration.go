package launcher

// Native activation glue for local schema transitions. The Python payload owns
// candidate population and exact-schema verification; this launcher boundary
// owns process quiescence, paired backup binding, atomic installation, and
// recovery.

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
	"strconv"
	"strings"
	"syscall"
	"time"
)

const (
	legacyJobCtrlSchemaVersion   = int64(6)
	exactJobCtrlSchemaVersion    = int64(7)
	previousJobCtrlSchemaVersion = int64(8)
	currentJobCtrlSchemaVersion  = int64(9)
)

var (
	temporalQuiescenceProof = proveStoppedTemporalQuiescence
	// These seam names are retained for the existing lifecycle fault-injection
	// matrix. Production builds and installs the current exact-v9 candidate.
	sealedV7CandidateBuilder   = buildSealedV9Candidate
	sealedV7CandidateInstaller = installSealedV9Candidate
)

type temporalQuiescenceReceipt struct {
	RunningExecutionCount int    `json:"running_execution_count"`
	SchemaVersion         int    `json:"schema_version"`
	Status                string `json:"status"`
}

type sealedV7CandidateReceipt struct {
	CandidateLogicalDigest string `json:"candidate_logical_digest"`
	CandidateSHA256        string `json:"candidate_sha256"`
	JobCount               int    `json:"job_count"`
	SchemaVersion          int    `json:"schema_version"`
	SourceDigest           string `json:"source_digest"`
	Status                 string `json:"status"`
	TableCount             int    `json:"table_count"`
	UserVersion            int64  `json:"user_version"`
}

func verifiedReleaseContext(base launchContext, verified verifiedRelease) launchContext {
	return launchContext{
		Executable:   filepath.Join(verified.payloadRoot, "launcher", "jobctrl"),
		PayloadRoot:  verified.payloadRoot,
		Manifest:     verified.runtime,
		Distribution: verified.distribution,
		Instance:     base.Instance,
		Environment: childEnvironment(
			base.Environment,
			verified.payloadRoot,
			base.Instance.StateDir,
			verified.runtime,
		),
	}
}

func jobCtrlSchemaVersion(ctx launchContext) (int64, error) {
	python := filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
	return sqliteUserVersion(python, filepath.Join(ctx.Instance.StateDir, "jobctrl.db"))
}

func sqliteUserVersion(python, database string) (int64, error) {
	info, err := os.Lstat(database)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return 0, errors.New("database is not a regular file")
	}
	code := `import pathlib,sqlite3,sys
p=pathlib.Path(sys.argv[1]).resolve().as_uri()+"?mode=ro"
c=sqlite3.connect(p,uri=True)
try: print(c.execute("PRAGMA user_version").fetchone()[0])
finally: c.close()`
	command := exec.Command(python, "-I", "-B", "-c", code, database)
	output, err := command.Output()
	if err != nil || len(output) > 32 {
		return 0, errors.New("read SQLite schema version failed")
	}
	version, err := strconv.ParseInt(strings.TrimSpace(string(output)), 10, 64)
	if err != nil {
		return 0, errors.New("SQLite schema version is invalid")
	}
	return version, nil
}

// proveStoppedTemporalQuiescence reopens only the old Temporal service after
// the managed tree has stopped. With API and worker absent, no new workflow can
// be admitted between the visibility proof and the paired snapshot.
func proveStoppedTemporalQuiescence(active, candidate launchContext) error {
	state, err := temporalProofState(active)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(active.Instance.LogDir, 0o700); err != nil {
		return err
	}
	temporal, err := startGatedTemporal(active)
	if err != nil {
		return fmt.Errorf("start Temporal quiescence service: %w", err)
	}
	record := temporal.record
	state.Components = map[string]componentRecord{"temporal": record}
	state.StoppedAt = nil
	if err := writeState(active.Instance.StatePath, state); err != nil {
		temporal.abandon()
		return fmt.Errorf("record Temporal quiescence service: %w", err)
	}
	if err := temporal.release(); err != nil {
		_ = terminateRecord(record)
		return fmt.Errorf("release Temporal quiescence service: %w", err)
	}
	cleanup := func() error {
		var stopErr error
		if recordMatchesLiveProcess(record) {
			stopErr = terminateRecord(record)
		} else if processPIDAlive(record.PID) {
			stopErr = errors.New("Temporal quiescence service identity changed before stop")
		}
		now := time.Now().UTC()
		record.ExitedAt = &now
		if stopErr != nil {
			record.ExitError = stopErr.Error()
			state.StoppedAt = nil
		} else {
			state.StoppedAt = &now
		}
		state.Components["temporal"] = record
		if writeErr := writeState(active.Instance.StatePath, state); writeErr != nil && stopErr == nil {
			stopErr = writeErr
		}
		return stopErr
	}

	signals := make(chan os.Signal)
	proofErr := waitForTemporal(active, temporal.command, temporal.exits, signals)
	if proofErr == nil {
		proofErr = runTemporalQuiescenceModule(candidate)
	}
	if cleanupErr := cleanup(); cleanupErr != nil {
		if proofErr != nil {
			return fmt.Errorf("%v; stop Temporal quiescence service: %w", proofErr, cleanupErr)
		}
		return fmt.Errorf("stop Temporal quiescence service: %w", cleanupErr)
	}
	return proofErr
}

const gatedTemporalScript = `IFS= read -r gate <&3 || exit 75
[ "$gate" = "start" ] || exit 75
"$@" & child=$!
trap 'kill -TERM "$child" 2>/dev/null; wait "$child" 2>/dev/null' INT TERM HUP EXIT
wait "$child"
status=$?
trap - EXIT
exit "$status"`

type gatedTemporalProcess struct {
	command *exec.Cmd
	record  componentRecord
	gate    *os.File
	exits   chan componentExit
}

func startGatedTemporal(ctx launchContext) (*gatedTemporalProcess, error) {
	spec, err := componentByName(ctx.Manifest, "temporal")
	if err != nil {
		return nil, err
	}
	executable := filepath.Join(ctx.PayloadRoot, spec.Executable)
	if !safeRelativePath(spec.Executable) || !strings.HasPrefix(filepath.Clean(executable), filepath.Clean(ctx.PayloadRoot)+string(filepath.Separator)) {
		return nil, errors.New("unsafe Temporal component executable")
	}
	arguments := make([]string, len(spec.Arguments))
	for index, argument := range spec.Arguments {
		arguments[index] = substitute(argument, ctx)
	}
	logPath := filepath.Join(ctx.Instance.LogDir, "temporal.log")
	if info, err := os.Stat(logPath); err == nil && info.Size() > 0 {
		_ = os.Remove(logPath + ".1")
		if err := os.Rename(logPath, logPath+".1"); err != nil {
			return nil, fmt.Errorf("rotate temporal log: %w", err)
		}
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	gateRead, gateWrite, err := os.Pipe()
	if err != nil {
		_ = logFile.Close()
		return nil, err
	}
	argv := []string{"-c", gatedTemporalScript, "jobctrl-temporal-quiescence", executable}
	argv = append(argv, arguments...)
	command := exec.Command("/bin/bash", argv...)
	command.Env, command.Dir, command.Stdout, command.Stderr = temporalGateEnvironment(ctx.Environment), ctx.Instance.StateDir, logFile, logFile
	command.ExtraFiles = []*os.File{gateRead}
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		_ = gateRead.Close()
		_ = gateWrite.Close()
		_ = logFile.Close()
		return nil, err
	}
	_ = gateRead.Close()
	_ = logFile.Close()
	exits := make(chan componentExit, 1)
	go waitComponent("temporal", command, exits)
	record, err := recordForProcess(command.Process.Pid, logPath, "/bin/bash")
	if err != nil {
		_ = gateWrite.Close()
		return nil, err
	}
	return &gatedTemporalProcess{command: command, record: record, gate: gateWrite, exits: exits}, nil
}

func temporalGateEnvironment(environment []string) []string {
	filtered := make([]string, 0, len(environment))
	for _, pair := range environment {
		key, _, found := strings.Cut(pair, "=")
		if found && key == "BASH_ENV" {
			continue
		}
		filtered = append(filtered, pair)
	}
	return filtered
}

func (process *gatedTemporalProcess) release() error {
	if process == nil || process.gate == nil {
		return errors.New("Temporal quiescence gate is unavailable")
	}
	_, writeErr := io.WriteString(process.gate, "start\n")
	closeErr := process.gate.Close()
	process.gate = nil
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

func (process *gatedTemporalProcess) abandon() {
	if process == nil {
		return
	}
	if process.gate != nil {
		_ = process.gate.Close()
		process.gate = nil
	}
	select {
	case <-process.exits:
	case <-time.After(shutdownTimeout):
		if recordMatchesLiveProcess(process.record) {
			_ = terminateRecord(process.record)
		}
	}
}

func temporalProofState(ctx launchContext) (instanceState, error) {
	if current, err := readState(ctx.Instance.StatePath); err == nil {
		if err := validateStateIdentity(ctx, current); err != nil {
			return instanceState{}, err
		}
		if stateHasLiveProcesses(current) {
			return instanceState{}, errors.New("managed runtime is still live before Temporal quiescence proof")
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return instanceState{}, err
	}
	digest, err := manifestDigest(ctx.PayloadRoot)
	if err != nil {
		return instanceState{}, err
	}
	now := time.Now().UTC()
	return instanceState{
		SchemaVersion:     stateSchemaVersion,
		InstanceID:        ctx.Instance.ID,
		CanonicalStateDir: ctx.Instance.StateDir,
		PayloadRoot:       ctx.PayloadRoot,
		BuildID:           ctx.Distribution.BuildID,
		ManifestSHA256:    digest,
		Ports: runtimePorts{
			TemporalGRPC: ctx.Manifest.Ports.TemporalGRPC,
			TemporalUI:   ctx.Manifest.Ports.TemporalUI,
			API:          ctx.Manifest.Ports.API,
		},
		StartedAt:  now,
		StoppedAt:  &now,
		Components: map[string]componentRecord{},
	}, nil
}

func runTemporalQuiescenceModule(candidate launchContext) error {
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	command := exec.Command(
		python,
		"-I",
		"-B",
		"-m",
		"jobctrl.infrastructure.migrations.v6_to_v7_quiescence",
	)
	command.Env = candidate.Environment
	command.Dir = candidate.Instance.StateDir
	output, err := command.Output()
	if err != nil || len(output) > 1024 {
		return errors.New("Temporal quiescence preflight failed")
	}
	var receipt temporalQuiescenceReceipt
	if err := decodeSingleJSON(output, &receipt); err != nil ||
		receipt.SchemaVersion != 1 || receipt.Status != "quiescent" || receipt.RunningExecutionCount != 0 {
		return errors.New("Temporal quiescence preflight returned invalid evidence")
	}
	return nil
}

func buildSealedV7Candidate(candidate launchContext, pair databasePair, journalID string) (string, error) {
	source, err := pairedDatabasePath(candidate.Instance.StateDir, pair, "jobctrl.db", legacyJobCtrlSchemaVersion)
	if err != nil {
		return "", err
	}
	path := v7CandidatePath(candidate.Instance.StateDir, journalID)
	if _, err := os.Lstat(path); !errors.Is(err, os.ErrNotExist) {
		return "", errors.New("v7 migration candidate path already exists")
	}
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	command := exec.Command(
		python,
		"-I",
		"-B",
		"-m",
		"jobctrl.infrastructure.migrations.v6_to_v7_execute",
		"--source",
		source,
		"--candidate",
		path,
		"--migration-at",
		time.Now().UTC().Format(time.RFC3339Nano),
	)
	command.Env = candidate.Environment
	command.Dir = candidate.Instance.StateDir
	output, err := command.Output()
	if err != nil || len(output) > 4096 {
		cleanupV7Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v6-to-v7 candidate execution failed")
	}
	var receipt sealedV7CandidateReceipt
	if err := decodeSingleJSON(output, &receipt); err != nil ||
		receipt.SchemaVersion != 1 || receipt.Status != "ready" ||
		receipt.UserVersion != exactJobCtrlSchemaVersion || receipt.JobCount < 0 || receipt.TableCount < 1 ||
		!validSHA256(receipt.SourceDigest) || !validSHA256(receipt.CandidateLogicalDigest) || !validSHA256(receipt.CandidateSHA256) {
		cleanupV7Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v6-to-v7 candidate receipt is invalid")
	}
	info, statErr := os.Lstat(path)
	if statErr != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		cleanupV7Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v7 candidate is not an owner-private regular file")
	}
	digest, digestErr := sha256Path(path)
	if digestErr != nil || digest != receipt.CandidateSHA256 {
		cleanupV7Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v7 candidate digest verification failed")
	}
	version, versionErr := sqliteUserVersion(python, path)
	if versionErr != nil || version != exactJobCtrlSchemaVersion {
		cleanupV7Candidate(candidate.Instance.StateDir, journalID)
		return "", errors.New("sealed v7 candidate schema verification failed")
	}
	return path, nil
}

func pairedDatabasePath(stateDir string, pair databasePair, name string, version int64) (string, error) {
	if pair.SchemaVersion != 1 || pair.ID == "" || len(pair.Files) != 2 {
		return "", errors.New("migration requires a complete paired backup")
	}
	found := false
	for _, file := range pair.Files {
		if file.Name == name && file.SQLiteUserVer == version {
			found = true
		}
	}
	if !found {
		return "", errors.New("paired backup does not contain the required database version")
	}
	path := filepath.Join(stateDir, "backups", pair.ID, name)
	actual, err := describeDatabase(path, name, version)
	if err != nil {
		return "", err
	}
	for _, expected := range pair.Files {
		if expected.Name == name && (actual.SHA256 != expected.SHA256 || actual.SizeBytes != expected.SizeBytes) {
			return "", errors.New("paired backup database verification failed")
		}
	}
	return path, nil
}

func installSealedV7Candidate(candidate launchContext, candidatePath string) error {
	info, err := os.Lstat(candidatePath)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm()&0o077 != 0 {
		return errors.New("v7 activation candidate is not an owner-private regular file")
	}
	live := filepath.Join(candidate.Instance.StateDir, "jobctrl.db")
	liveInfo, err := os.Lstat(live)
	if err != nil || !liveInfo.Mode().IsRegular() || liveInfo.Mode()&os.ModeSymlink != 0 {
		return errors.New("live v6 database is not a regular file")
	}
	if err := os.Rename(candidatePath, live); err != nil {
		return fmt.Errorf("atomically install exact-v7 database: %w", err)
	}
	if err := cleanupSQLiteSidecars(candidate.Instance.StateDir, "jobctrl.db"); err != nil {
		return err
	}
	python := filepath.Join(candidate.PayloadRoot, "python", "bin", "python3")
	if version, err := sqliteUserVersion(python, live); err != nil || version != exactJobCtrlSchemaVersion {
		return errors.New("installed v7 database did not reopen at the exact schema version")
	}
	return nil
}

func v7CandidatePath(stateDir, journalID string) string {
	digest := sha256.Sum256([]byte(journalID))
	return filepath.Join(stateDir, ".jobctrl-v7-candidate-"+hex.EncodeToString(digest[:])[:24]+".db")
}

func cleanupV7Candidate(stateDir, journalID string) {
	for _, path := range []string{
		v7CandidatePath(stateDir, journalID),
		v8CandidatePath(stateDir, journalID),
		v9CandidatePath(stateDir, journalID),
	} {
		_ = os.Remove(path)
		for _, suffix := range []string{"-journal", "-shm", "-wal"} {
			_ = os.Remove(path + suffix)
		}
	}
}

func decodeSingleJSON(raw []byte, destination any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		return errors.New("trailing JSON value")
	}
	return nil
}

func validSHA256(value string) bool {
	if len(value) != sha256.Size*2 {
		return false
	}
	decoded, err := hex.DecodeString(value)
	return err == nil && len(decoded) == sha256.Size
}
