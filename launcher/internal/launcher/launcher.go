// Package launcher owns the installed JobCtrl process boundary. It deliberately
// has no domain logic: it validates payload metadata, manages bundled processes,
// and transparently dispatches the embedded Python CLI.
package launcher

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	pathpkg "path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var (
	sha256Pattern        = regexp.MustCompile(`^[a-f0-9]{64}$`)
	componentIDPattern   = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{1,63}$`)
	buildIDPattern       = regexp.MustCompile(`^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$`)
	semverPattern        = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$`)
	minimumOSPattern     = regexp.MustCompile(`^[0-9]+(?:\.[0-9]+){1,2}$`)
	requiredComponentIDs = []string{"jobctrl-launcher", "jobctrl-api", "jobctrl-web", "jobctrl-worker", "node-runtime", "python-runtime", "temporal-runtime"}
)

const (
	launcherProtocol   = 1
	stateSchemaVersion = 1
	logLineLimit       = 200
	startupTimeout     = 30 * time.Second
	// Detached start spans two sequential supervisor health phases: Temporal,
	// then API/worker. The parent must not kill a supervisor that is still
	// within those valid phase deadlines.
	detachedStartupTimeout = 2*startupTimeout + 5*time.Second
	shutdownTimeout        = 5 * time.Second
)

var (
	ErrAlreadyRunning     = errors.New("an active JobCtrl instance already owns this state directory")
	ErrPortInUse          = errors.New("a required fixed loopback port is already in use")
	ErrLockHeld           = errors.New("the JobCtrl instance lock is held")
	errStartupInterrupted = errors.New("supervisor startup interrupted")
)

type commandSpec struct {
	Name       string   `json:"name"`
	Executable string   `json:"executable"`
	Arguments  []string `json:"arguments"`
}

type runtimeManifest struct {
	SchemaVersion    int `json:"schemaVersion"`
	LauncherProtocol int `json:"launcherProtocol"`
	Ports            struct {
		TemporalGRPC int `json:"temporalGrpc"`
		TemporalUI   int `json:"temporalUi"`
		API          int `json:"api"`
	} `json:"ports"`
	Components []commandSpec `json:"components"`
	Health     struct {
		Temporal struct {
			Component string   `json:"component"`
			Arguments []string `json:"arguments"`
		} `json:"temporal"`
		API struct {
			Path                 string `json:"path"`
			RequireWorkerHealthy bool   `json:"requireWorkerHealthy"`
			RequireWorkerPID     bool   `json:"requireWorkerPid"`
		} `json:"api"`
	} `json:"health"`
}

// This is the full v1 public envelope shape. Strict decoding means a launcher
// never makes a permissive map-shaped assumption about a signed artifact.
type distributionManifest struct {
	SchemaVersion   int    `json:"schemaVersion"`
	AppVersion      string `json:"appVersion"`
	BuildID         string `json:"buildId"`
	ReleaseChannel  string `json:"releaseChannel"`
	SourceDateEpoch int64  `json:"sourceDateEpoch"`
	Platform        struct {
		ID               string `json:"id"`
		OS               string `json:"os"`
		Arch             string `json:"arch"`
		MinimumOSVersion string `json:"minimumOsVersion"`
	} `json:"platform"`
	LauncherCompatibility struct {
		Minimum int `json:"minimum"`
		Maximum int `json:"maximum"`
	} `json:"launcherCompatibility"`
	Components []struct {
		ID             string `json:"id"`
		Classification string `json:"classification"`
		Version        string `json:"version"`
		Owner          string `json:"owner"`
		Source         string `json:"source"`
		License        string `json:"license"`
		Redistribution string `json:"redistribution"`
		Path           string `json:"path"`
		SHA256         string `json:"sha256"`
		SizeBytes      int64  `json:"sizeBytes"`
		Required       bool   `json:"required"`
	} `json:"components"`
	Capabilities []struct {
		ID             string   `json:"id"`
		DefaultEnabled bool     `json:"defaultEnabled"`
		ComponentIDs   []string `json:"componentIds"`
	} `json:"capabilities"`
	Files []struct {
		Type      string `json:"type"`
		Path      string `json:"path"`
		SHA256    string `json:"sha256,omitempty"`
		Target    string `json:"target,omitempty"`
		SizeBytes int64  `json:"sizeBytes"`
		Mode      string `json:"mode,omitempty"`
	} `json:"files"`
	Signing struct {
		ManifestAlgorithm string `json:"manifestAlgorithm"`
		ManifestKeyID     string `json:"manifestKeyId"`
		CodeSigning       string `json:"codeSigning"`
		Notarized         bool   `json:"notarized"`
	} `json:"signing"`
}

type manifestSignature struct {
	SchemaVersion     int     `json:"schemaVersion"`
	Status            string  `json:"status"`
	ManifestAlgorithm string  `json:"manifestAlgorithm"`
	ManifestKeyID     string  `json:"manifestKeyId"`
	Signature         *string `json:"signature"`
	Promotable        bool    `json:"promotable"`
}

type componentRecord struct {
	PID           int        `json:"pid"`
	PGID          int        `json:"pgid"`
	StartIdentity string     `json:"startIdentity"`
	Executable    string     `json:"executable"`
	StartedAt     time.Time  `json:"startedAt"`
	LogPath       string     `json:"logPath"`
	ExitedAt      *time.Time `json:"exitedAt,omitempty"`
	ExitError     string     `json:"exitError,omitempty"`
}

type instanceState struct {
	SchemaVersion     int                        `json:"schemaVersion"`
	InstanceID        string                     `json:"instanceId"`
	CanonicalStateDir string                     `json:"canonicalStateDir"`
	PayloadRoot       string                     `json:"payloadRoot"`
	BuildID           string                     `json:"buildId"`
	ManifestSHA256    string                     `json:"manifestSha256"`
	Ports             runtimePorts               `json:"ports"`
	StartedAt         time.Time                  `json:"startedAt"`
	StoppedAt         *time.Time                 `json:"stoppedAt,omitempty"`
	Supervisor        componentRecord            `json:"supervisor"`
	Components        map[string]componentRecord `json:"components"`
}

type runtimePorts struct {
	TemporalGRPC int `json:"temporalGrpc"`
	TemporalUI   int `json:"temporalUi"`
	API          int `json:"api"`
}

type instance struct {
	RuntimeHome string
	StateDir    string
	ID          string
	Dir         string
	LockPath    string
	ControlPath string
	StatePath   string
	LogDir      string
}
type launchContext struct {
	Executable   string
	PayloadRoot  string
	Manifest     runtimeManifest
	Distribution distributionManifest
	Instance     instance
	Environment  []string
}
type readyMessage struct {
	Error string `json:"error,omitempty"`
}
type processIdentityReader func(int) (string, error)
type groupSignaler func(int, syscall.Signal) error

var readProcessIdentity processIdentityReader = processStartIdentity
var readProcessExecutable processIdentityReader = processExecutable
var signalProcessGroup groupSignaler = func(pgid int, signal syscall.Signal) error { return syscall.Kill(-pgid, signal) }
var openBrowser = func(url string) error { return exec.Command("/usr/bin/open", url).Run() }
var temporalHealthProbe = probeTemporal

// Run is the only public CLI entrypoint. __supervise is reachable only through
// the re-exec made by `jobctrl start`.
func Run(executable string, args, inheritedEnv []string, stdout, stderr io.Writer) error {
	ctx, err := prepare(executable, inheritedEnv)
	if err != nil {
		return err
	}
	if len(args) > 0 && args[0] == "__supervise" {
		return supervise(ctx, readyWriterFromEnv(inheritedEnv))
	}
	if len(args) == 0 || args[0] == "--help" || args[0] == "help" {
		printHelp(stdout)
		return nil
	}
	switch args[0] {
	case "start":
		foreground, noOpen, err := parseStartArgs(args[1:])
		if err != nil {
			return err
		}
		if foreground {
			return supervise(ctx, nil)
		}
		if err := startDetached(ctx); err != nil {
			return err
		}
		if !noOpen {
			return openURL(ctx)
		}
		_, err = fmt.Fprintf(stdout, "JobCtrl is ready at http://127.0.0.1:%d\n", ctx.Manifest.Ports.API)
		return err
	case "stop":
		if len(args) != 1 {
			return errors.New("usage: jobctrl stop")
		}
		return stop(ctx)
	case "status":
		if len(args) == 2 && args[1] == "--pipeline" {
			return dispatchPython(ctx, []string{"pipeline-status"})
		}
		jsonOutput, err := parseStatusArgs(args[1:])
		if err != nil {
			return err
		}
		return status(ctx, stdout, jsonOutput)
	case "logs":
		return logs(ctx, args[1:], stdout)
	case "open":
		if len(args) != 1 {
			return errors.New("usage: jobctrl open")
		}
		return openURL(ctx)
	case "version":
		jsonOutput, err := parseVersionArgs(args[1:])
		if err != nil {
			return err
		}
		return version(ctx, stdout, jsonOutput)
	default:
		return dispatchPython(ctx, args)
	}
}

func ExitCode(err error) int {
	if err == nil {
		return 0
	}
	if errors.Is(err, ErrAlreadyRunning) || errors.Is(err, ErrLockHeld) {
		return 75
	}
	if errors.Is(err, ErrPortInUse) {
		return 69
	}
	return 1
}
func printHelp(out io.Writer) {
	fmt.Fprint(out, "JobCtrl bundled launcher\n\nUsage:\n  jobctrl start [--no-open] [--foreground]\n  jobctrl stop\n  jobctrl status [--pipeline] [--json]\n  jobctrl logs [temporal|worker|api]\n  jobctrl open\n  jobctrl version [--json]\n  jobctrl pipeline-status\n  jobctrl <Python domain command>\n")
}
func parseStartArgs(args []string) (foreground, noOpen bool, err error) {
	for _, arg := range args {
		switch arg {
		case "--foreground":
			foreground = true
		case "--no-open":
			noOpen = true
		default:
			return false, false, fmt.Errorf("unknown start option %q", arg)
		}
	}
	return
}
func parseStatusArgs(args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	if len(args) == 1 && args[0] == "--json" {
		return true, nil
	}
	return false, errors.New("usage: jobctrl status [--pipeline] [--json]")
}
func parseVersionArgs(args []string) (bool, error) {
	if len(args) == 0 {
		return false, nil
	}
	if len(args) == 1 && args[0] == "--json" {
		return true, nil
	}
	return false, errors.New("usage: jobctrl version [--json]")
}

func prepare(executable string, inheritedEnv []string) (launchContext, error) {
	payloadRoot, err := locatePayloadRoot(executable)
	if err != nil {
		return launchContext{}, err
	}
	distribution, err := loadAndVerifyDistributionManifest(payloadRoot)
	if err != nil {
		return launchContext{}, err
	}
	manifest, err := loadRuntimeManifest(filepath.Join(payloadRoot, "launcher", "runtime-manifest.json"))
	if err != nil {
		return launchContext{}, err
	}
	if distribution.LauncherCompatibility.Minimum > launcherProtocol || distribution.LauncherCompatibility.Maximum < launcherProtocol {
		return launchContext{}, fmt.Errorf("payload supports launcher protocol %d-%d, this launcher is protocol %d", distribution.LauncherCompatibility.Minimum, distribution.LauncherCompatibility.Maximum, launcherProtocol)
	}
	inst, err := resolveInstance(inheritedEnv)
	if err != nil {
		return launchContext{}, err
	}
	return launchContext{executable, payloadRoot, manifest, distribution, inst, childEnvironment(inheritedEnv, payloadRoot, inst.StateDir, manifest)}, nil
}
func locatePayloadRoot(executable string) (string, error) {
	path, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return "", fmt.Errorf("resolve launcher executable: %w", err)
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return "", err
	}
	if filepath.Base(path) != "jobctrl" || filepath.Base(filepath.Dir(path)) != "launcher" {
		return "", fmt.Errorf("launcher must be installed as <payload>/launcher/jobctrl, got %q", path)
	}
	return filepath.Dir(filepath.Dir(path)), nil
}
func decodeStrict(path string, destination any) error {
	file, err := os.Open(path)
	if err != nil {
		return err
	}
	defer file.Close()
	decoder := json.NewDecoder(file)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return fmt.Errorf("decode %s: %w", filepath.Base(path), err)
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("decode %s: trailing JSON value", filepath.Base(path))
	}
	return nil
}
func safeRelativePath(path string) bool {
	if !isPrintableASCII(path) || strings.Contains(path, "\\") || strings.HasPrefix(path, "/") {
		return false
	}
	clean := pathpkg.Clean(path)
	return clean == path && clean != "." && clean != ".." && !strings.HasPrefix(clean, "../")
}

func safeSymlinkTarget(target string) bool {
	return isPrintableASCII(target) && !strings.Contains(target, "\\") && !strings.HasPrefix(target, "/") && pathpkg.Clean(target) == target
}

func isPrintableASCII(value string) bool {
	if value == "" {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < 0x20 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func loadRuntimeManifest(path string) (runtimeManifest, error) {
	var manifest runtimeManifest
	if err := decodeStrict(path, &manifest); err != nil {
		return manifest, err
	}
	if manifest.SchemaVersion != 1 || manifest.LauncherProtocol != launcherProtocol {
		return manifest, errors.New("unsupported runtime manifest protocol")
	}
	if manifest.Ports.TemporalGRPC != 7233 || manifest.Ports.TemporalUI != 8233 || manifest.Ports.API != 8766 {
		return manifest, errors.New("runtime manifest must use JobCtrl fixed loopback ports 7233, 8233, and 8766")
	}
	if len(manifest.Components) != 3 {
		return manifest, errors.New("runtime manifest must define exactly temporal, worker, and api")
	}
	for i, expected := range []string{"temporal", "worker", "api"} {
		component := manifest.Components[i]
		if component.Name != expected || !safeRelativePath(component.Executable) {
			return manifest, fmt.Errorf("invalid runtime component %q", component.Name)
		}
	}
	if manifest.Health.Temporal.Component != "temporal" || manifest.Health.API.Path != "/v1/health" || !manifest.Health.API.RequireWorkerHealthy || !manifest.Health.API.RequireWorkerPID {
		return manifest, errors.New("runtime manifest health contract is invalid")
	}
	return manifest, nil
}

func decodeRawJSONObject(raw json.RawMessage, label string, keys ...string) (map[string]json.RawMessage, error) {
	var object map[string]json.RawMessage
	if err := json.Unmarshal(raw, &object); err != nil {
		return nil, fmt.Errorf("%s must be an object: %w", label, err)
	}
	if len(object) != len(keys) {
		return nil, fmt.Errorf("%s has missing or unknown fields", label)
	}
	for _, key := range keys {
		if _, exists := object[key]; !exists {
			return nil, fmt.Errorf("%s is missing required field %q", label, key)
		}
	}
	return object, nil
}

func decodeRawJSONArray(raw json.RawMessage, label string) ([]json.RawMessage, error) {
	var values []json.RawMessage
	if err := json.Unmarshal(raw, &values); err != nil {
		return nil, fmt.Errorf("%s must be an array: %w", label, err)
	}
	if len(values) == 0 {
		return nil, fmt.Errorf("%s must not be empty", label)
	}
	return values, nil
}

func rawBoolean(raw json.RawMessage) bool {
	return string(raw) == "true" || string(raw) == "false"
}

func rawNonNegativeInteger(raw json.RawMessage) bool {
	var value int64
	return string(raw) != "null" && json.Unmarshal(raw, &value) == nil && value >= 0
}

func pathOwnedBy(filePath, componentPath string) bool {
	return filePath == componentPath || strings.HasPrefix(filePath, componentPath+"/")
}

func validateDistributionManifestShape(raw []byte, manifest distributionManifest) error {
	var root json.RawMessage = raw
	object, err := decodeRawJSONObject(root, "distribution manifest", "schemaVersion", "appVersion", "buildId", "releaseChannel", "sourceDateEpoch", "platform", "launcherCompatibility", "components", "capabilities", "files", "signing")
	if err != nil {
		return err
	}
	if !rawNonNegativeInteger(object["sourceDateEpoch"]) || manifest.SchemaVersion != 1 || !semverPattern.MatchString(manifest.AppVersion) || !buildIDPattern.MatchString(manifest.BuildID) || manifest.SourceDateEpoch < 0 {
		return errors.New("invalid distribution manifest format")
	}
	if manifest.ReleaseChannel != "local" {
		return errors.New("this launcher accepts only local release manifests until release-signature verification is provisioned")
	}
	platform, err := decodeRawJSONObject(object["platform"], "distribution manifest platform", "id", "os", "arch", "minimumOsVersion")
	if err != nil {
		return err
	}
	if !isPrintableASCII(manifest.Platform.ID) || !isPrintableASCII(manifest.Platform.OS) || !isPrintableASCII(manifest.Platform.Arch) || !minimumOSPattern.MatchString(manifest.Platform.MinimumOSVersion) || manifest.Platform.ID != "darwin-arm64" || manifest.Platform.OS != "darwin" || manifest.Platform.Arch != "arm64" || string(platform["id"]) == "null" {
		return errors.New("distribution manifest platform must be the supported darwin-arm64 format")
	}
	compatibility, err := decodeRawJSONObject(object["launcherCompatibility"], "distribution manifest launcherCompatibility", "minimum", "maximum")
	if err != nil {
		return err
	}
	if !rawNonNegativeInteger(compatibility["minimum"]) || !rawNonNegativeInteger(compatibility["maximum"]) || manifest.LauncherCompatibility.Minimum < 1 || manifest.LauncherCompatibility.Maximum < manifest.LauncherCompatibility.Minimum {
		return errors.New("invalid distribution manifest launcher compatibility")
	}

	componentRaw, err := decodeRawJSONArray(object["components"], "distribution manifest components")
	if err != nil {
		return err
	}
	if len(componentRaw) != len(manifest.Components) {
		return errors.New("distribution manifest components do not decode consistently")
	}
	componentByID := make(map[string]int, len(manifest.Components))
	for index, component := range manifest.Components {
		fields, err := decodeRawJSONObject(componentRaw[index], "distribution manifest component", "id", "classification", "version", "owner", "source", "license", "redistribution", "path", "sha256", "sizeBytes", "required")
		if err != nil {
			return err
		}
		if !rawBoolean(fields["required"]) || !rawNonNegativeInteger(fields["sizeBytes"]) || !componentIDPattern.MatchString(component.ID) || !isPrintableASCII(component.Classification) || !isPrintableASCII(component.Version) || !isPrintableASCII(component.Owner) || !isPrintableASCII(component.Source) || !isPrintableASCII(component.License) || component.Source == "" || !strings.HasPrefix(component.Source, "https://") || component.Redistribution != "bundle" || !safeRelativePath(component.Path) || !sha256Pattern.MatchString(component.SHA256) || component.SizeBytes < 0 {
			return fmt.Errorf("invalid distribution component %q", component.ID)
		}
		if component.Classification != "core-runtime" && component.Classification != "optional-capability" && component.Classification != "provider-pack" {
			return fmt.Errorf("invalid distribution component classification for %q", component.ID)
		}
		if _, exists := componentByID[component.ID]; exists {
			return fmt.Errorf("distribution manifest repeats component %q", component.ID)
		}
		componentByID[component.ID] = index
		if index > 0 && manifest.Components[index-1].ID >= component.ID {
			return errors.New("distribution manifest components must be bytewise sorted")
		}
	}
	for _, required := range requiredComponentIDs {
		if _, exists := componentByID[required]; !exists {
			return fmt.Errorf("distribution manifest is missing runtime component %q", required)
		}
	}
	for left := range manifest.Components {
		for right := left + 1; right < len(manifest.Components); right++ {
			if pathOwnedBy(manifest.Components[left].Path, manifest.Components[right].Path) || pathOwnedBy(manifest.Components[right].Path, manifest.Components[left].Path) {
				return fmt.Errorf("distribution component roots overlap: %q and %q", manifest.Components[left].Path, manifest.Components[right].Path)
			}
		}
	}

	capabilityRaw, err := decodeRawJSONArray(object["capabilities"], "distribution manifest capabilities")
	if err != nil {
		return err
	}
	if len(capabilityRaw) != len(manifest.Capabilities) {
		return errors.New("distribution manifest capabilities do not decode consistently")
	}
	capabilities := make(map[string]bool, len(manifest.Capabilities))
	for index, capability := range manifest.Capabilities {
		fields, err := decodeRawJSONObject(capabilityRaw[index], "distribution manifest capability", "id", "defaultEnabled", "componentIds")
		if err != nil {
			return err
		}
		if !componentIDPattern.MatchString(capability.ID) || !rawBoolean(fields["defaultEnabled"]) || len(capability.ComponentIDs) == 0 {
			return fmt.Errorf("invalid distribution capability %q", capability.ID)
		}
		if capabilities[capability.ID] {
			return fmt.Errorf("distribution manifest repeats capability %q", capability.ID)
		}
		capabilities[capability.ID] = true
		if index > 0 && manifest.Capabilities[index-1].ID >= capability.ID {
			return errors.New("distribution manifest capabilities must be bytewise sorted")
		}
		seen := map[string]bool{}
		for componentIndex, componentID := range capability.ComponentIDs {
			if !componentIDPattern.MatchString(componentID) || seen[componentID] {
				return fmt.Errorf("invalid capability component reference %q", componentID)
			}
			if _, exists := componentByID[componentID]; !exists {
				return fmt.Errorf("capability %q references unknown component %q", capability.ID, componentID)
			}
			if componentIndex > 0 && capability.ComponentIDs[componentIndex-1] >= componentID {
				return fmt.Errorf("capability %q component ids must be bytewise sorted", capability.ID)
			}
			seen[componentID] = true
		}
	}

	fileRaw, err := decodeRawJSONArray(object["files"], "distribution manifest files")
	if err != nil {
		return err
	}
	if len(fileRaw) != len(manifest.Files) {
		return errors.New("distribution manifest files do not decode consistently")
	}
	filesByComponent := make([][]int, len(manifest.Components))
	seenFiles := make(map[string]bool, len(manifest.Files))
	for index, file := range manifest.Files {
		keys := []string{"type", "path", "target", "sizeBytes"}
		if file.Type == "file" {
			keys = []string{"type", "path", "sha256", "sizeBytes", "mode"}
		}
		fields, err := decodeRawJSONObject(fileRaw[index], "distribution manifest file", keys...)
		if err != nil {
			return err
		}
		if !rawNonNegativeInteger(fields["sizeBytes"]) || !safeRelativePath(file.Path) || seenFiles[file.Path] || file.SizeBytes < 0 {
			return fmt.Errorf("invalid distribution manifest file %q", file.Path)
		}
		if index > 0 && manifest.Files[index-1].Path >= file.Path {
			return errors.New("distribution manifest files must be bytewise sorted")
		}
		seenFiles[file.Path] = true
		if file.Type == "file" {
			if !sha256Pattern.MatchString(file.SHA256) || (file.Mode != "0644" && file.Mode != "0755") {
				return fmt.Errorf("invalid regular distribution file %q", file.Path)
			}
		} else if file.Type == "symlink" {
			if !safeSymlinkTarget(file.Target) || file.SizeBytes != int64(len(file.Target)) {
				return fmt.Errorf("invalid distribution symlink %q", file.Path)
			}
		} else {
			return fmt.Errorf("invalid distribution file type for %q", file.Path)
		}
		owner := -1
		for componentIndex, component := range manifest.Components {
			if pathOwnedBy(file.Path, component.Path) {
				if owner != -1 {
					return fmt.Errorf("distribution file %q has more than one component owner", file.Path)
				}
				owner = componentIndex
			}
		}
		if owner == -1 {
			return fmt.Errorf("distribution file %q has no component owner", file.Path)
		}
		filesByComponent[owner] = append(filesByComponent[owner], index)
	}
	for componentIndex, component := range manifest.Components {
		if len(filesByComponent[componentIndex]) == 0 {
			return fmt.Errorf("distribution component %q owns no files", component.ID)
		}
		canonical := strings.Builder{}
		var size int64
		for _, fileIndex := range filesByComponent[componentIndex] {
			file := manifest.Files[fileIndex]
			if file.Type == "symlink" {
				fmt.Fprintf(&canonical, "%s\x00symlink\x00%s\x00%d\n", file.Path, file.Target, file.SizeBytes)
			} else {
				fmt.Fprintf(&canonical, "%s\x00file\x00%s\x00%d\x00%s\n", file.Path, file.SHA256, file.SizeBytes, file.Mode)
			}
			size += file.SizeBytes
		}
		digest := sha256.Sum256([]byte(canonical.String()))
		if component.SizeBytes != size || component.SHA256 != hex.EncodeToString(digest[:]) {
			return fmt.Errorf("distribution component %q summary does not match its owned files", component.ID)
		}
	}

	fields, err := decodeRawJSONObject(object["signing"], "distribution manifest signing", "manifestAlgorithm", "manifestKeyId", "codeSigning", "notarized")
	if err != nil {
		return err
	}
	if !rawBoolean(fields["notarized"]) || manifest.Signing.ManifestAlgorithm != "ed25519" || manifest.Signing.ManifestKeyID != "local-development" || manifest.Signing.CodeSigning != "unsigned-local" || manifest.Signing.Notarized {
		return errors.New("invalid local distribution signing envelope")
	}
	return nil
}

func validateManifestSignatureShape(raw []byte, signature manifestSignature, manifest distributionManifest) error {
	fields, err := decodeRawJSONObject(raw, "distribution manifest signature", "schemaVersion", "status", "manifestAlgorithm", "manifestKeyId", "signature", "promotable")
	if err != nil {
		return err
	}
	if !rawNonNegativeInteger(fields["schemaVersion"]) || !rawBoolean(fields["promotable"]) || string(fields["signature"]) != "null" || signature.SchemaVersion != 1 || signature.Status != "unsigned-local" || signature.Signature != nil || signature.Promotable || signature.ManifestAlgorithm != manifest.Signing.ManifestAlgorithm || signature.ManifestKeyID != manifest.Signing.ManifestKeyID {
		return errors.New("invalid local distribution manifest signature binding")
	}
	return nil
}

func loadAndVerifyDistributionManifest(payloadRoot string) (distributionManifest, error) {
	var manifest distributionManifest
	manifestPath := filepath.Join(payloadRoot, "manifest.json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		return manifest, err
	}
	if err := decodeStrict(manifestPath, &manifest); err != nil {
		return manifest, err
	}
	if err := validateDistributionManifestShape(manifestBytes, manifest); err != nil {
		return manifest, err
	}
	if err := verifyPayloadTree(payloadRoot, manifest); err != nil {
		return manifest, err
	}
	var signature manifestSignature
	signaturePath := filepath.Join(payloadRoot, "manifest.sig")
	signatureBytes, err := os.ReadFile(signaturePath)
	if err != nil {
		return manifest, err
	}
	if err := decodeStrict(signaturePath, &signature); err != nil {
		return manifest, err
	}
	if err := validateManifestSignatureShape(signatureBytes, signature, manifest); err != nil {
		return manifest, err
	}
	// P6 replaces this seam with Ed25519 verification. P1's local artifact is
	// permitted only when every relevant envelope field says local/non-promotable.
	if signature.Status == "unsigned-local" && signature.Signature == nil && !signature.Promotable && manifest.ReleaseChannel == "local" && manifest.Signing.CodeSigning == "unsigned-local" && !manifest.Signing.Notarized && signature.ManifestAlgorithm == "ed25519" && signature.ManifestKeyID == "local-development" {
		return manifest, nil
	}
	return manifest, errors.New("release manifest signature verification is unavailable for this artifact; only P1 unsigned-local non-promotable artifacts are accepted")
}

// verifyPayloadTree is deliberately performed before any lifecycle action or
// Python dispatch. manifest.json and manifest.sig are the two documented
// envelope exclusions; every other regular file or symlink must match exactly.
func verifyPayloadTree(payloadRoot string, manifest distributionManifest) error {
	expected := make(map[string]struct {
		typeName string
		sha256   string
		target   string
		size     int64
		mode     string
	}, len(manifest.Files))
	for _, file := range manifest.Files {
		if _, exists := expected[file.Path]; exists {
			return fmt.Errorf("distribution manifest repeats file %q", file.Path)
		}
		expected[file.Path] = struct {
			typeName string
			sha256   string
			target   string
			size     int64
			mode     string
		}{file.Type, file.SHA256, file.Target, file.SizeBytes, file.Mode}
	}
	actual := make(map[string]bool, len(expected))
	err := filepath.WalkDir(payloadRoot, func(path string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == payloadRoot || entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(payloadRoot, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if relative == "manifest.json" || relative == "manifest.sig" {
			return nil
		}
		expectedFile, recorded := expected[relative]
		if !recorded {
			return fmt.Errorf("payload contains unrecorded file %q", relative)
		}
		if actual[relative] {
			return fmt.Errorf("payload contains duplicate file %q", relative)
		}
		actual[relative] = true
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if entry.Type()&os.ModeSymlink != 0 {
			if expectedFile.typeName != "symlink" {
				return fmt.Errorf("payload file type mismatch for %q", relative)
			}
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if target != expectedFile.target || int64(len(target)) != expectedFile.size {
				return fmt.Errorf("payload symlink does not match manifest for %q", relative)
			}
			return verifySafeSymlink(payloadRoot, relative, target)
		}
		if !info.Mode().IsRegular() || expectedFile.typeName != "file" {
			return fmt.Errorf("payload file type mismatch for %q", relative)
		}
		if info.Size() != expectedFile.size {
			return fmt.Errorf("payload size does not match manifest for %q", relative)
		}
		mode, err := strconv.ParseUint(expectedFile.mode, 8, 32)
		if err != nil || info.Mode().Perm() != os.FileMode(mode) {
			return fmt.Errorf("payload mode does not match manifest for %q", relative)
		}
		digest, err := sha256Path(path)
		if err != nil {
			return err
		}
		if digest != expectedFile.sha256 {
			return fmt.Errorf("payload sha256 does not match manifest for %q", relative)
		}
		return nil
	})
	if err != nil {
		return err
	}
	for relative := range expected {
		if !actual[relative] {
			return fmt.Errorf("payload is missing manifest file %q", relative)
		}
	}
	return nil
}

func sha256Path(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

func verifySafeSymlink(payloadRoot, relative, target string) error {
	if filepath.IsAbs(target) {
		return fmt.Errorf("payload symlink %q has absolute target", relative)
	}
	// A relative target may legitimately start with ../. The confinement test is
	// made after resolving it from its link parent, not by treating that spelling
	// as an escape in isolation.
	resolvedRelative := filepath.Clean(filepath.Join(filepath.Dir(relative), target))
	if resolvedRelative == "." || resolvedRelative == ".." || strings.HasPrefix(resolvedRelative, ".."+string(filepath.Separator)) {
		return fmt.Errorf("payload symlink %q escapes payload root", relative)
	}
	resolved, err := filepath.EvalSymlinks(filepath.Join(payloadRoot, relative))
	if err != nil {
		return fmt.Errorf("resolve payload symlink %q: %w", relative, err)
	}
	payloadCanonical, err := filepath.EvalSymlinks(payloadRoot)
	if err != nil {
		return err
	}
	if resolved != payloadCanonical && !strings.HasPrefix(resolved, payloadCanonical+string(filepath.Separator)) {
		return fmt.Errorf("payload symlink %q resolves outside payload root", relative)
	}
	return nil
}

func resolveInstance(env []string) (instance, error) {
	values := environmentMap(env)
	home := values["HOME"]
	if home == "" {
		return instance{}, errors.New("HOME is required")
	}
	stateDir := values["JOBCTRL_DIR"]
	if stateDir == "" {
		stateDir = filepath.Join(home, ".jobctrl")
	}
	var err error
	stateDir, err = filepath.Abs(stateDir)
	if err != nil {
		return instance{}, err
	}
	if err := os.MkdirAll(stateDir, 0o700); err != nil {
		return instance{}, fmt.Errorf("create JobCtrl state directory: %w", err)
	}
	canonical, err := filepath.EvalSymlinks(stateDir)
	if err != nil {
		return instance{}, fmt.Errorf("canonicalize JobCtrl state directory: %w", err)
	}
	runtimeHome := values["JOBCTRL_RUNTIME_HOME"]
	if runtimeHome == "" {
		runtimeHome = filepath.Join(home, "Library", "Application Support", "JobCtrl")
	}
	runtimeHome, err = filepath.Abs(runtimeHome)
	if err != nil {
		return instance{}, err
	}
	if err := os.MkdirAll(runtimeHome, 0o700); err != nil {
		return instance{}, fmt.Errorf("create JobCtrl runtime home: %w", err)
	}
	hash := sha256.Sum256([]byte(canonical))
	id := hex.EncodeToString(hash[:])
	dir := filepath.Join(runtimeHome, "instances", id)
	if err := os.MkdirAll(filepath.Join(dir, "logs"), 0o700); err != nil {
		return instance{}, fmt.Errorf("create JobCtrl runtime instance: %w", err)
	}
	return instance{runtimeHome, canonical, id, dir, filepath.Join(dir, "instance.lock"), filepath.Join(dir, "control.lock"), filepath.Join(dir, "state.json"), filepath.Join(dir, "logs")}, nil
}
func environmentMap(env []string) map[string]string {
	values := make(map[string]string, len(env))
	for _, pair := range env {
		key, value, found := strings.Cut(pair, "=")
		if found {
			values[key] = value
		}
	}
	return values
}
func childEnvironment(inherited []string, payloadRoot, stateDir string, manifest runtimeManifest) []string {
	blocked := map[string]bool{"VIRTUAL_ENV": true, "NODE_PATH": true, "NODE_OPTIONS": true, "PORT": true, "JOBCTRL_API_ALLOW_REMOTE_BIND": true, "JOBCTRL_API_HOST": true, "JOBCTRL_API_PORT": true, "JOBCTRL_WEB_PORT": true, "TEMPORAL_ADDRESS": true, "TEMPORAL_NAMESPACE": true, "JOBCTRL_TEMPORAL_DB": true, "PATH": true, "JOBCTRL_PAYLOAD_DIR": true, "JOBCTRL_RUNTIME_MODE": true, "JOBCTRL_WEB_ASSETS_DIR": true, "PLAYWRIGHT_BROWSERS_PATH": true, "JOBCTRL_PYTHON_EXECUTABLE": true}
	values := make(map[string]string, len(inherited))
	for _, pair := range inherited {
		key, value, ok := strings.Cut(pair, "=")
		if !ok || blocked[key] || strings.HasPrefix(key, "PYTHON") {
			continue
		}
		values[key] = value
	}
	values["JOBCTRL_DIR"] = stateDir
	values["JOBCTRL_PAYLOAD_DIR"] = payloadRoot
	values["JOBCTRL_RUNTIME_MODE"] = "bundled"
	values["JOBCTRL_WEB_ASSETS_DIR"] = filepath.Join(payloadRoot, "web")
	values["PLAYWRIGHT_BROWSERS_PATH"] = filepath.Join(payloadRoot, "chromium")
	values["JOBCTRL_PYTHON_EXECUTABLE"] = filepath.Join(payloadRoot, "python", "bin", "python3")
	values["TEMPORAL_ADDRESS"] = fmt.Sprintf("127.0.0.1:%d", manifest.Ports.TemporalGRPC)
	values["TEMPORAL_NAMESPACE"] = "default"
	values["JOBCTRL_API_HOST"] = "127.0.0.1"
	values["JOBCTRL_API_PORT"] = strconv.Itoa(manifest.Ports.API)
	values["JOBCTRL_TEMPORAL_DB"] = filepath.Join(stateDir, "temporal.db")
	values["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"
	values["PYTHONNOUSERSITE"] = "1"
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	result := make([]string, 0, len(keys))
	for _, key := range keys {
		result = append(result, key+"="+values[key])
	}
	return result
}
func substitute(argument string, ctx launchContext) string {
	return strings.NewReplacer("${PAYLOAD_ROOT}", ctx.PayloadRoot, "${TEMPORAL_GRPC_PORT}", strconv.Itoa(ctx.Manifest.Ports.TemporalGRPC), "${TEMPORAL_UI_PORT}", strconv.Itoa(ctx.Manifest.Ports.TemporalUI), "${TEMPORAL_DB}", filepath.Join(ctx.Instance.StateDir, "temporal.db")).Replace(argument)
}
func componentByName(manifest runtimeManifest, name string) (commandSpec, error) {
	for _, component := range manifest.Components {
		if component.Name == name {
			return component, nil
		}
	}
	return commandSpec{}, fmt.Errorf("runtime manifest has no %s component", name)
}
func acquireLock(path string, nonBlocking bool) (*os.File, error) {
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	flags := syscall.LOCK_EX
	if nonBlocking {
		flags |= syscall.LOCK_NB
	}
	if err := syscall.Flock(int(file.Fd()), flags); err != nil {
		file.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLockHeld
		}
		return nil, err
	}
	return file, nil
}
func releaseLock(file *os.File) {
	if file != nil {
		_ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		_ = file.Close()
	}
}
func writeState(path string, state instanceState) error {
	encoded, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	temporary := path + ".tmp-" + strconv.Itoa(os.Getpid())
	if err := os.WriteFile(temporary, append(encoded, '\n'), 0o600); err != nil {
		return err
	}
	if err := os.Chmod(temporary, 0o600); err != nil {
		_ = os.Remove(temporary)
		return err
	}
	return os.Rename(temporary, path)
}
func readState(path string) (instanceState, error) {
	var state instanceState
	if err := decodeStrict(path, &state); err != nil {
		return state, err
	}
	if state.SchemaVersion != stateSchemaVersion || state.InstanceID == "" || state.CanonicalStateDir == "" || state.PayloadRoot == "" || state.BuildID == "" || state.ManifestSHA256 == "" || state.Components == nil {
		return state, errors.New("invalid runtime registry state")
	}
	return state, nil
}

func manifestDigest(payloadRoot string) (string, error) {
	digest, err := sha256Path(filepath.Join(payloadRoot, "manifest.json"))
	if err != nil {
		return "", err
	}
	return digest, nil
}

func validateStateIdentity(ctx launchContext, state instanceState) error {
	if state.InstanceID != ctx.Instance.ID || state.CanonicalStateDir != ctx.Instance.StateDir {
		return errors.New("runtime registry does not belong to this canonical state directory")
	}
	return nil
}
func validateStateBinding(ctx launchContext, state instanceState) error {
	if err := validateStateIdentity(ctx, state); err != nil {
		return err
	}
	digest, err := manifestDigest(ctx.PayloadRoot)
	if err != nil {
		return err
	}
	if filepath.Clean(state.PayloadRoot) != filepath.Clean(ctx.PayloadRoot) || state.BuildID != ctx.Distribution.BuildID || state.ManifestSHA256 != digest || state.Ports != (runtimePorts{ctx.Manifest.Ports.TemporalGRPC, ctx.Manifest.Ports.TemporalUI, ctx.Manifest.Ports.API}) {
		return errors.New("runtime registry belongs to a different release")
	}
	return nil
}
func stateHasLiveProcesses(state instanceState) bool {
	if recordMatchesLiveProcess(state.Supervisor) {
		return true
	}
	for _, record := range state.Components {
		if recordMatchesLiveProcess(record) {
			return true
		}
	}
	return false
}

func validateStartState(ctx launchContext, state instanceState) error {
	if err := validateStateIdentity(ctx, state); err != nil {
		return err
	}
	if err := validateStateBinding(ctx, state); err != nil && stateHasLiveProcesses(state) {
		return fmt.Errorf("different JobCtrl release is still running for this state directory; run jobctrl status then jobctrl stop before starting this release")
	}
	if recordMatchesLiveProcess(state.Supervisor) {
		return ErrAlreadyRunning
	}
	for _, name := range []string{"temporal", "worker", "api"} {
		if record, exists := state.Components[name]; exists && recordMatchesLiveProcess(record) {
			return fmt.Errorf("%w: recorded %s component is still live; run jobctrl stop before starting", ErrAlreadyRunning, name)
		}
	}
	return nil
}
func recordForProcess(pid int, logPath, executable string) (componentRecord, error) {
	identity, err := readProcessIdentity(pid)
	if err != nil {
		return componentRecord{}, err
	}
	pgid, err := syscall.Getpgid(pid)
	if err != nil {
		return componentRecord{}, err
	}
	return componentRecord{PID: pid, PGID: pgid, StartIdentity: identity, Executable: executable, StartedAt: time.Now().UTC(), LogPath: logPath}, nil
}
func recordMatchesLiveProcess(record componentRecord) bool {
	if record.PID <= 0 || record.PGID <= 0 || record.StartIdentity == "" || record.Executable == "" {
		return false
	}
	identity, err := readProcessIdentity(record.PID)
	if err != nil || identity != record.StartIdentity {
		return false
	}
	executable, err := readProcessExecutable(record.PID)
	if err != nil || !sameExecutable(executable, record.Executable) {
		return false
	}
	pgid, err := syscall.Getpgid(record.PID)
	return err == nil && pgid == record.PGID
}

func sameExecutable(actual, expected string) bool {
	if actual == expected {
		return true
	}
	actualResolved, actualErr := filepath.EvalSymlinks(actual)
	expectedResolved, expectedErr := filepath.EvalSymlinks(expected)
	return actualErr == nil && expectedErr == nil && actualResolved == expectedResolved
}
func ensureFixedPortsAvailable(manifest runtimeManifest) error {
	for _, port := range []int{manifest.Ports.TemporalGRPC, manifest.Ports.TemporalUI, manifest.Ports.API} {
		listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(port)))
		if err != nil {
			return fmt.Errorf("%w: 127.0.0.1:%d (%v)", ErrPortInUse, port, err)
		}
		_ = listener.Close()
	}
	return nil
}

func processPIDAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func startDetached(ctx launchContext) error {
	if state, err := readState(ctx.Instance.StatePath); err == nil {
		if err := validateStartState(ctx, state); err != nil {
			return err
		}
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("read existing runtime registry: %w", err)
	}
	read, write, err := os.Pipe()
	if err != nil {
		return err
	}
	defer read.Close()
	command := exec.Command(ctx.Executable, "__supervise")
	command.Env = append(ctx.Environment, "JOBCTRL_READY_FD=3")
	command.ExtraFiles = []*os.File{write}
	devNull, err := os.OpenFile(os.DevNull, os.O_WRONLY, 0)
	if err != nil {
		write.Close()
		return err
	}
	defer devNull.Close()
	command.Stdout, command.Stderr = devNull, devNull
	command.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := command.Start(); err != nil {
		write.Close()
		return err
	}
	_ = write.Close()
	messages := make(chan readyMessage, 1)
	go func() {
		var message readyMessage
		if err := json.NewDecoder(read).Decode(&message); err != nil {
			message.Error = fmt.Sprintf("supervisor did not report readiness: %v", err)
		}
		messages <- message
	}()
	select {
	case message := <-messages:
		if message.Error != "" {
			_ = command.Wait()
			return errors.New(message.Error)
		}
		// The detached supervisor is intentionally not a child that this short
		// command waits on. Release its handle after the readiness handshake so
		// a successful `start` cannot leave a waitable child behind.
		_ = command.Process.Release()
		return nil
	case <-time.After(detachedStartupTimeout):
		_ = syscall.Kill(command.Process.Pid, syscall.SIGTERM)
		_ = command.Wait()
		return errors.New("timed out waiting for detached JobCtrl supervisor")
	}
}
func readyWriterFromEnv(env []string) io.Writer {
	fd, err := strconv.Atoi(environmentMap(env)["JOBCTRL_READY_FD"])
	if err != nil || fd < 3 {
		return nil
	}
	return os.NewFile(uintptr(fd), "jobctrl-ready")
}
func sendReady(writer io.Writer, err error) {
	if writer == nil {
		return
	}
	message := readyMessage{}
	if err != nil {
		message.Error = err.Error()
	}
	_ = json.NewEncoder(writer).Encode(message)
	if closer, ok := writer.(io.Closer); ok {
		_ = closer.Close()
	}
}

func supervise(ctx launchContext, ready io.Writer) (result error) {
	lock, err := acquireLock(ctx.Instance.LockPath, true)
	if err != nil {
		sendReady(ready, err)
		return err
	}
	defer releaseLock(lock)
	// startDetached validates before it forks. Repeat under the instance lock so
	// a supervisor killed between that check and this re-exec cannot have its
	// still-live component registry overwritten.
	if previous, readErr := readState(ctx.Instance.StatePath); readErr == nil {
		if validationErr := validateStartState(ctx, previous); validationErr != nil {
			sendReady(ready, validationErr)
			return validationErr
		}
	} else if !errors.Is(readErr, os.ErrNotExist) {
		err = fmt.Errorf("read existing runtime registry: %w", readErr)
		sendReady(ready, err)
		return err
	}
	supervisor, err := recordForProcess(os.Getpid(), "", ctx.Executable)
	if err != nil {
		sendReady(ready, err)
		return err
	}
	digest, err := manifestDigest(ctx.PayloadRoot)
	if err != nil {
		sendReady(ready, err)
		return err
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: ctx.Instance.ID, CanonicalStateDir: ctx.Instance.StateDir, PayloadRoot: ctx.PayloadRoot, BuildID: ctx.Distribution.BuildID, ManifestSHA256: digest, Ports: runtimePorts{TemporalGRPC: ctx.Manifest.Ports.TemporalGRPC, TemporalUI: ctx.Manifest.Ports.TemporalUI, API: ctx.Manifest.Ports.API}, StartedAt: time.Now().UTC(), Supervisor: supervisor, Components: map[string]componentRecord{}}
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		sendReady(ready, err)
		return err
	}
	signals := make(chan os.Signal, 2)
	signalNotify(signals)
	defer signalStop(signals)
	exits := make(chan componentExit, 3)
	children := map[string]*exec.Cmd{}
	defer func() {
		shutdownComponents(&state, children, ctx.Instance.StatePath)
		if allRecordedComponentsStopped(state) {
			now := time.Now().UTC()
			state.StoppedAt = &now
		} else {
			// Never convert a cleanup failure into a misleading stopped registry:
			// the remaining records must stay inspectable and `stop` must be able
			// to retry their identity-verified groups.
			state.StoppedAt = nil
		}
		_ = writeState(ctx.Instance.StatePath, state)
		if result != nil {
			sendReady(ready, result)
		}
	}()
	if err := ensureFixedPortsAvailable(ctx.Manifest); err != nil {
		return err
	}
	if children["temporal"], err = startComponent(ctx, state.Components, "temporal"); err != nil {
		return err
	}
	go waitComponent("temporal", children["temporal"], exits)
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		return err
	}
	if err := waitForTemporal(ctx, children["temporal"], exits, signals); err != nil {
		if errors.Is(err, errStartupInterrupted) {
			return nil
		}
		markStartupComponentExit(&state, err)
		return err
	}
	if children["worker"], err = startComponent(ctx, state.Components, "worker"); err != nil {
		return err
	}
	go waitComponent("worker", children["worker"], exits)
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		return err
	}
	if children["api"], err = startComponent(ctx, state.Components, "api"); err != nil {
		return err
	}
	go waitComponent("api", children["api"], exits)
	if err := writeState(ctx.Instance.StatePath, state); err != nil {
		return err
	}
	if err := waitForAPIWorker(ctx, children["api"], children["worker"], exits, signals); err != nil {
		if errors.Is(err, errStartupInterrupted) {
			return nil
		}
		markStartupComponentExit(&state, err)
		return err
	}
	sendReady(ready, nil)
	for {
		select {
		case <-signals:
			return nil
		case exit := <-exits:
			record := state.Components[exit.Name]
			now := time.Now().UTC()
			record.ExitedAt = &now
			if exit.Err != nil {
				record.ExitError = exit.Err.Error()
			}
			state.Components[exit.Name] = record
			// Keep ownership of the healthy siblings and lock after an unexpected
			// child exit. This makes lifecycle status accurately degraded and lets
			// `stop` perform a PID-safe recovery instead of erasing the evidence.
			_ = writeState(ctx.Instance.StatePath, state)
		}
	}
}

var signalNotify = func(channel chan<- os.Signal) { signal.Notify(channel, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP) }
var signalStop = func(channel chan<- os.Signal) { signal.Stop(channel) }

type componentExit struct {
	Name string
	Err  error
}

type startupComponentExitError struct{ componentExit }

func (err startupComponentExitError) Error() string {
	return fmt.Sprintf("%s exited before startup completed: %v", err.Name, err.Err)
}

func (err startupComponentExitError) Unwrap() error { return err.Err }

func markStartupComponentExit(state *instanceState, cause error) {
	var exited startupComponentExitError
	if !errors.As(cause, &exited) {
		return
	}
	record, found := state.Components[exited.Name]
	if !found {
		return
	}
	now := time.Now().UTC()
	record.ExitedAt = &now
	if exited.Err != nil {
		record.ExitError = exited.Err.Error()
	}
	state.Components[exited.Name] = record
}

func waitComponent(name string, command *exec.Cmd, exits chan<- componentExit) {
	exits <- componentExit{name, command.Wait()}
}
func startComponent(ctx launchContext, records map[string]componentRecord, name string) (*exec.Cmd, error) {
	spec, err := componentByName(ctx.Manifest, name)
	if err != nil {
		return nil, err
	}
	executable := filepath.Join(ctx.PayloadRoot, spec.Executable)
	if !safeRelativePath(spec.Executable) || !strings.HasPrefix(filepath.Clean(executable), filepath.Clean(ctx.PayloadRoot)+string(filepath.Separator)) {
		return nil, errors.New("unsafe component executable")
	}
	arguments := make([]string, len(spec.Arguments))
	for index, argument := range spec.Arguments {
		arguments[index] = substitute(argument, ctx)
	}
	logPath := filepath.Join(ctx.Instance.LogDir, name+".log")
	if info, err := os.Stat(logPath); err == nil && info.Size() > 0 {
		_ = os.Remove(logPath + ".1")
		if err := os.Rename(logPath, logPath+".1"); err != nil {
			return nil, fmt.Errorf("rotate %s log: %w", name, err)
		}
	}
	logFile, err := os.OpenFile(logPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o600)
	if err != nil {
		return nil, err
	}
	command := exec.Command(executable, arguments...)
	command.Env, command.Dir, command.Stdout, command.Stderr = ctx.Environment, ctx.Instance.StateDir, logFile, logFile
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := command.Start(); err != nil {
		logFile.Close()
		return nil, fmt.Errorf("start %s: %w", name, err)
	}
	_ = logFile.Close()
	record, err := recordForProcess(command.Process.Pid, logPath, executable)
	if err != nil {
		_ = signalProcessGroup(command.Process.Pid, syscall.SIGTERM)
		return nil, err
	}
	records[name] = record
	return command, nil
}
func waitForTemporal(ctx launchContext, temporal *exec.Cmd, exits <-chan componentExit, signals <-chan os.Signal) error {
	deadline := time.Now().Add(startupTimeout)
	var last error
	for time.Now().Before(deadline) {
		select {
		case <-signals:
			return errStartupInterrupted
		case exit := <-exits:
			return startupComponentExitError{exit}
		default:
		}
		if !processPIDAlive(temporal.Process.Pid) {
			return errors.New("Temporal exited before becoming healthy")
		}
		if err := temporalHealthProbe(ctx); err == nil {
			return nil
		} else {
			last = err
		}
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("embedded Temporal did not become healthy: %w", last)
}

func probeTemporal(ctx launchContext) error {
	spec, err := componentByName(ctx.Manifest, ctx.Manifest.Health.Temporal.Component)
	if err != nil {
		return err
	}
	executable := filepath.Join(ctx.PayloadRoot, spec.Executable)
	arguments := make([]string, len(ctx.Manifest.Health.Temporal.Arguments))
	for i, argument := range ctx.Manifest.Health.Temporal.Arguments {
		arguments[i] = substitute(argument, ctx)
	}
	probe := exec.Command(executable, arguments...)
	probe.Env, probe.Dir = ctx.Environment, ctx.Instance.StateDir
	if output, err := probe.CombinedOutput(); err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(output)))
	}
	return nil
}
func waitForAPIWorker(ctx launchContext, api, worker *exec.Cmd, exits <-chan componentExit, signals <-chan os.Signal) error {
	deadline := time.Now().Add(startupTimeout)
	var last error
	for time.Now().Before(deadline) {
		select {
		case <-signals:
			return errStartupInterrupted
		case exit := <-exits:
			return startupComponentExitError{exit}
		default:
		}
		if !processPIDAlive(api.Process.Pid) {
			return errors.New("API exited before becoming healthy")
		}
		if !processPIDAlive(worker.Process.Pid) {
			return errors.New("worker exited before becoming healthy")
		}
		err := probeAPIWorker(ctx, worker.Process.Pid)
		if err == nil {
			return nil
		}
		last = err
		time.Sleep(150 * time.Millisecond)
	}
	return fmt.Errorf("API and worker did not become healthy: %w", last)
}

func probeAPIWorker(ctx launchContext, expectedWorkerPID int) error {
	client := &http.Client{Timeout: 750 * time.Millisecond}
	url := fmt.Sprintf("http://127.0.0.1:%d%s", ctx.Manifest.Ports.API, ctx.Manifest.Health.API.Path)
	response, err := client.Get(url)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return fmt.Errorf("API health returned HTTP %d", response.StatusCode)
	}
	var health struct {
		Worker struct {
			Status    string `json:"status"`
			Heartbeat *struct {
				PID int `json:"pid"`
			} `json:"heartbeat"`
		} `json:"worker"`
	}
	if err := json.NewDecoder(response.Body).Decode(&health); err != nil {
		return err
	}
	if health.Worker.Status != "healthy" {
		return fmt.Errorf("worker health is %q", health.Worker.Status)
	}
	if health.Worker.Heartbeat == nil || health.Worker.Heartbeat.PID != expectedWorkerPID {
		return fmt.Errorf("worker heartbeat pid is not owned worker pid %d", expectedWorkerPID)
	}
	return nil
}
func waitForPIDExit(pid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !processPIDAlive(pid) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return !processPIDAlive(pid)
}

func processGroupAlive(pgid int) bool {
	if pgid <= 0 {
		return false
	}
	err := syscall.Kill(-pgid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}

func waitForProcessGroupExit(pgid int, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if !processGroupAlive(pgid) {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return !processGroupAlive(pgid)
}

func signalOwnedRecord(record componentRecord, signal syscall.Signal) error {
	if !recordMatchesLiveProcess(record) {
		return errors.New("record does not match a live owned process")
	}
	if err := signalProcessGroup(record.PGID, signal); err == nil {
		return nil
	} else {
		groupErr := err
		// sandbox-exec can reject a negative-PGID signal even when it permits a
		// signal to the exact child. Re-verify all ownership fields immediately
		// before that narrower fallback; never send it to a reused PID.
		if !recordMatchesLiveProcess(record) {
			return fmt.Errorf("signal process group: %w; direct PID fallback refused because ownership changed", groupErr)
		}
		if directErr := syscall.Kill(record.PID, signal); directErr != nil {
			return fmt.Errorf("signal process group: %w; direct PID fallback: %w", groupErr, directErr)
		}
		return nil
	}
}

func terminateRecord(record componentRecord) error {
	if err := signalOwnedRecord(record, syscall.SIGTERM); err != nil {
		return err
	}
	if waitForPIDExit(record.PID, shutdownTimeout) && waitForProcessGroupExit(record.PGID, shutdownTimeout) {
		return nil
	}
	// The leading process may have exited while a child still occupies its
	// original process group. Only a still-verified leader authorizes another
	// group signal; otherwise report the surviving group rather than risking a
	// reused PGID.
	if !recordMatchesLiveProcess(record) {
		return errors.New("component leader exited but its owned process group remains live")
	}
	if err := signalOwnedRecord(record, syscall.SIGKILL); err != nil {
		return err
	}
	if waitForPIDExit(record.PID, shutdownTimeout) && waitForProcessGroupExit(record.PGID, shutdownTimeout) {
		return nil
	}
	return errors.New("component process tree remained live after SIGTERM and SIGKILL")
}
func shutdownComponents(state *instanceState, children map[string]*exec.Cmd, statePath string) {
	for _, name := range []string{"api", "worker", "temporal"} {
		record, exists := state.Components[name]
		if !exists || record.ExitedAt != nil {
			continue
		}
		if err := terminateRecord(record); err == nil {
			now := time.Now().UTC()
			record.ExitedAt = &now
		} else {
			record.ExitError = "cleanup could not confirm this component exited: " + err.Error()
		}
		state.Components[name] = record
		_ = writeState(statePath, *state)
	}
}

func allRecordedComponentsStopped(state instanceState) bool {
	for _, record := range state.Components {
		// A still-existing PID might have been reused after identity verification
		// failed. Keep the registry in a recoverable non-stopped state rather
		// than claim that an unknown live process exited.
		if processPIDAlive(record.PID) {
			return false
		}
	}
	return true
}
func stop(ctx launchContext) error {
	control, err := acquireLock(ctx.Instance.ControlPath, false)
	if err != nil {
		return fmt.Errorf("acquire stop control lock: %w", err)
	}
	defer releaseLock(control)
	state, err := readState(ctx.Instance.StatePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err := validateStateIdentity(ctx, state); err != nil {
		return err
	}
	failed := make([]string, 0)
	for _, name := range []string{"api", "worker", "temporal"} {
		if record, exists := state.Components[name]; exists {
			if err := terminateRecord(record); err != nil && processPIDAlive(record.PID) {
				failed = append(failed, name+": "+err.Error())
			}
		}
	}
	if recordMatchesLiveProcess(state.Supervisor) {
		_ = syscall.Kill(state.Supervisor.PID, syscall.SIGTERM)
		deadline := time.Now().Add(shutdownTimeout)
		for time.Now().Before(deadline) {
			if !recordMatchesLiveProcess(state.Supervisor) {
				break
			}
			time.Sleep(100 * time.Millisecond)
		}
	}
	if len(failed) > 0 || !allRecordedComponentsStopped(state) {
		state.StoppedAt = nil
		if err := writeState(ctx.Instance.StatePath, state); err != nil {
			return err
		}
		if len(failed) > 0 {
			return fmt.Errorf("could not safely stop live component groups: %s", strings.Join(failed, ", "))
		}
		return errors.New("JobCtrl still has live recorded component PIDs after stop")
	}
	now := time.Now().UTC()
	state.StoppedAt = &now
	return writeState(ctx.Instance.StatePath, state)
}
func status(ctx launchContext, output io.Writer, jsonOutput bool) error {
	state, err := readState(ctx.Instance.StatePath)
	if errors.Is(err, os.ErrNotExist) {
		if jsonOutput {
			_, _ = io.WriteString(output, "{\"status\":\"stopped\",\"components\":{}}\n")
		} else {
			_, _ = io.WriteString(output, "JobCtrl is stopped.\n")
		}
		return nil
	}
	if err != nil {
		return err
	}
	if err := validateStateIdentity(ctx, state); err != nil {
		return err
	}
	differentRelease := validateStateBinding(ctx, state) != nil
	type componentStatus struct {
		State     string     `json:"state"`
		PID       int        `json:"pid"`
		Log       string     `json:"log"`
		ExitedAt  *time.Time `json:"exitedAt,omitempty"`
		ExitError string     `json:"exitError,omitempty"`
	}
	components := map[string]componentStatus{}
	allReady := true
	workerRecord := state.Components["worker"]
	apiRecord := state.Components["api"]
	apiWorkerHealth := errors.New("API is not running")
	if !differentRelease && recordMatchesLiveProcess(apiRecord) && recordMatchesLiveProcess(workerRecord) {
		apiWorkerHealth = probeAPIWorker(ctx, workerRecord.PID)
	}
	for _, name := range []string{"temporal", "worker", "api"} {
		record, found := state.Components[name]
		live := found && recordMatchesLiveProcess(record)
		stateName := "stopped"
		if live {
			stateName = "running"
			if !differentRelease && name == "temporal" && probeTemporal(ctx) != nil {
				stateName = "unhealthy"
				allReady = false
			}
			if !differentRelease && (name == "worker" || name == "api") && apiWorkerHealth != nil {
				stateName = "unhealthy"
				allReady = false
			}
		} else {
			allReady = false
			if found && record.ExitedAt == nil {
				stateName = "stale"
			}
		}
		components[name] = componentStatus{stateName, record.PID, record.LogPath, record.ExitedAt, record.ExitError}
	}
	supervisorLive := recordMatchesLiveProcess(state.Supervisor)
	overall := "stopped"
	if allReady && supervisorLive {
		overall = "running"
	} else if !allReady && supervisorLive {
		overall = "degraded"
	} else if allReady {
		overall = "orphaned"
	}
	if differentRelease {
		overall = "different-release"
	}
	if state.StoppedAt != nil && !stateHasLiveProcesses(state) {
		overall = "stopped"
	}
	if jsonOutput {
		return json.NewEncoder(output).Encode(struct {
			Status        string                     `json:"status"`
			InstanceID    string                     `json:"instanceId"`
			StateDir      string                     `json:"stateDir"`
			SupervisorPID int                        `json:"supervisorPid"`
			Components    map[string]componentStatus `json:"components"`
		}{overall, state.InstanceID, state.CanonicalStateDir, state.Supervisor.PID, components})
	}
	fmt.Fprintf(output, "JobCtrl: %s\n", overall)
	for _, name := range []string{"temporal", "worker", "api"} {
		item := components[name]
		fmt.Fprintf(output, "%-9s %-8s pid=%d\n", name, item.State, item.PID)
	}
	return nil
}
func logs(ctx launchContext, args []string, output io.Writer) error {
	if len(args) > 1 || (len(args) == 1 && args[0] == "--follow") {
		return errors.New("usage: jobctrl logs [temporal|worker|api]; logs are bounded to the last 200 lines")
	}
	if len(args) == 0 {
		for _, name := range []string{"temporal", "worker", "api"} {
			fmt.Fprintf(output, "== %s ==\n", name)
			if err := tailFile(filepath.Join(ctx.Instance.LogDir, name+".log"), logLineLimit, output); err != nil {
				return err
			}
		}
		return nil
	}
	name := args[0]
	if name != "temporal" && name != "worker" && name != "api" {
		return fmt.Errorf("unknown component %q", name)
	}
	return tailFile(filepath.Join(ctx.Instance.LogDir, name+".log"), logLineLimit, output)
}
func tailFile(path string, limit int, output io.Writer) error {
	file, err := os.Open(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer file.Close()
	lines := make([]string, 0, limit)
	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		if len(lines) == limit {
			copy(lines, lines[1:])
			lines[len(lines)-1] = scanner.Text()
		} else {
			lines = append(lines, scanner.Text())
		}
	}
	if err := scanner.Err(); err != nil {
		return err
	}
	for _, line := range lines {
		fmt.Fprintln(output, line)
	}
	return nil
}
func openURL(ctx launchContext) error {
	state, err := readState(ctx.Instance.StatePath)
	if err != nil {
		return errors.New("JobCtrl is not running")
	}
	if err := validateStateBinding(ctx, state); err != nil {
		return err
	}
	api, apiFound := state.Components["api"]
	worker, workerFound := state.Components["worker"]
	if !apiFound || !workerFound || !recordMatchesLiveProcess(api) || !recordMatchesLiveProcess(worker) || probeAPIWorker(ctx, worker.PID) != nil {
		return errors.New("JobCtrl API is not running")
	}
	return openBrowser(fmt.Sprintf("http://127.0.0.1:%d", ctx.Manifest.Ports.API))
}
func version(ctx launchContext, output io.Writer, jsonOutput bool) error {
	manifestBytes, err := os.ReadFile(filepath.Join(ctx.PayloadRoot, "manifest.json"))
	if err != nil {
		return err
	}
	digest := sha256.Sum256(manifestBytes)
	if jsonOutput {
		return json.NewEncoder(output).Encode(struct {
			Version          string `json:"version"`
			BuildID          string `json:"buildId"`
			ManifestSHA256   string `json:"manifestSha256"`
			LauncherProtocol int    `json:"launcherProtocol"`
		}{ctx.Distribution.AppVersion, ctx.Distribution.BuildID, hex.EncodeToString(digest[:]), launcherProtocol})
	}
	_, err = fmt.Fprintf(output, "JobCtrl %s (%s)\nmanifest sha256: %s\n", ctx.Distribution.AppVersion, ctx.Distribution.BuildID, hex.EncodeToString(digest[:]))
	return err
}
func dispatchPython(ctx launchContext, args []string) error {
	python := filepath.Join(ctx.PayloadRoot, "python", "bin", "python3")
	argv := append([]string{python, "-I", "-B", "-m", "jobctrl"}, args...)
	return syscall.Exec(python, argv, ctx.Environment)
}
