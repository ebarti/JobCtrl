package launcher

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
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// homebrewBootstrapConfig lives next to the formula-owned bootstrap binaries,
// never inside a signed payload tree. Formula installation writes only this
// prefix-owned directory; first invocation is the first time user state can be
// created.
type homebrewBootstrapConfig struct {
	SchemaVersion    int    `json:"schemaVersion"`
	DescriptorURL    string `json:"descriptorUrl"`
	Descriptor       string `json:"descriptor"`
	Signature        string `json:"signature"`
	Archive          string `json:"archive"`
	BuildID          string `json:"buildId"`
	DescriptorSHA256 string `json:"descriptorSha256"`
}

var homebrewInstallerCommand = func(path string, args []string, env []string) (string, error) {
	command := exec.Command(path, args...)
	command.Env = env
	output, err := command.CombinedOutput()
	return string(output), err
}
var execPublicSelector = func(selector string, args, env []string) error {
	return syscall.Exec(selector, append([]string{selector}, args...), env)
}

func maybeHomebrewBootstrap(executable string, args, inheritedEnv []string, stdout, stderr io.Writer) (bool, error) {
	path, err := filepath.EvalSymlinks(executable)
	if err != nil {
		return false, nil
	}
	path, err = filepath.Abs(path)
	if err != nil || filepath.Base(path) != "jobctrl" {
		return false, nil
	}
	root := filepath.Dir(path)
	configPath := filepath.Join(root, "homebrew-bootstrap.json")
	if _, err := os.Lstat(configPath); errors.Is(err, os.ErrNotExist) {
		return false, nil
	} else if err != nil {
		return true, err
	}
	var config homebrewBootstrapConfig
	if err := decodeBootstrapConfig(configPath, &config); err != nil {
		return true, err
	}
	if config.SchemaVersion != 1 || config.DescriptorURL == "" || !buildIDPattern.MatchString(config.BuildID) || !sha256Pattern.MatchString(config.DescriptorSHA256) || !safeRelativePath(config.Descriptor) || !safeRelativePath(config.Signature) || !safeRelativePath(config.Archive) {
		return true, errors.New("invalid Homebrew bootstrap configuration")
	}
	for _, name := range []string{config.Descriptor, config.Signature, config.Archive} {
		file := filepath.Join(root, name)
		info, err := os.Lstat(file)
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
			return true, fmt.Errorf("Homebrew bootstrap resource %q is not a regular file", name)
		}
	}
	// Config is prefix-owned, but bind its candidate identity to the exact
	// bundled descriptor bytes before using the idempotent fast path.
	descriptorRaw, err := os.ReadFile(filepath.Join(root, config.Descriptor))
	if err != nil {
		return true, err
	}
	digest := sha256.Sum256(descriptorRaw)
	if hex.EncodeToString(digest[:]) != config.DescriptorSHA256 {
		return true, errors.New("Homebrew bootstrap descriptor digest mismatch")
	}
	runtimeHome, err := runtimeHomeFromEnv(inheritedEnv)
	if err != nil {
		return true, err
	}
	store, err := release.Open(runtimeHome)
	if err != nil {
		return true, err
	}
	if len(args) > 0 && args[0] == "uninstall" {
		if _, activeErr := store.ReadActive(); activeErr == nil {
			if err := VerifyPublicSelectorForExecution(store.Home); err != nil {
				return true, err
			}
			env := append(append([]string{}, inheritedEnv...), "JOBCTRL_HOMEBREW_FRONTEND=1")
			return true, execPublicSelector(filepath.Join(store.Home, "bin", "jobctrl"), args, env)
		} else if errors.Is(activeErr, os.ErrNotExist) {
			instance, err := resolveInstance(inheritedEnv)
			if err != nil {
				return true, err
			}
			env := append(append([]string{}, inheritedEnv...), "JOBCTRL_HOMEBREW_FRONTEND=1")
			return true, uninstall(launchContext{Executable: executable, Instance: instance, Environment: env}, args[1:], stdout)
		} else {
			return true, activeErr
		}
	}
	if active, activeErr := store.ReadActive(); activeErr == nil && active.Receipt.Channel == "stable" && active.Receipt.BuildID == config.BuildID && active.Receipt.DescriptorSHA256 == config.DescriptorSHA256 && active.Receipt.DescriptorURL == config.DescriptorURL && VerifyPublicSelectorForExecution(store.Home) == nil {
		return true, bootstrapPromoteOrExec(executable, args, inheritedEnv, stdout, stderr, store, active.Receipt)
	}
	// A merely prepositioned release directory never qualifies for the fast
	// path. Authenticate via the formula cache before it can become selection.
	installer := filepath.Join(root, "jobctrl-installer")
	if info, err := os.Lstat(installer); err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return true, errors.New("Homebrew bootstrap installer is not a regular executable")
	}
	installerArgs := []string{
		"--source", "homebrew", "--stage-only", "--home", store.Home,
		"--descriptor-url", config.DescriptorURL,
		"--descriptor-file", filepath.Join(root, config.Descriptor),
		"--signature-file", filepath.Join(root, config.Signature),
		"--archive-file", filepath.Join(root, config.Archive),
	}
	if output, err := homebrewInstallerCommand(installer, installerArgs, inheritedEnv); err != nil {
		return true, fmt.Errorf("stage Homebrew release in user store: %w: %s", err, string(output))
	}
	candidate, err := readInstalledReceipt(store.Home, config.BuildID)
	if err != nil {
		return true, err
	}
	if candidate.Channel != "stable" || candidate.BuildID != config.BuildID || candidate.DescriptorSHA256 != config.DescriptorSHA256 {
		return true, errors.New("Homebrew installer did not stage the exact stable descriptor-bound candidate")
	}
	return true, bootstrapPromoteOrExec(executable, args, inheritedEnv, stdout, stderr, store, candidate)
}

func decodeBootstrapConfig(path string, destination any) error {
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("Homebrew bootstrap configuration is not a regular file")
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	if decoder.Decode(&struct{}{}) != io.EOF {
		return errors.New("Homebrew bootstrap configuration has trailing data")
	}
	return nil
}

func runtimeHomeFromEnv(env []string) (string, error) {
	values := environmentMap(env)
	if home := values["JOBCTRL_RUNTIME_HOME"]; home != "" {
		return filepath.Abs(home)
	}
	if values["HOME"] == "" {
		return "", errors.New("HOME is required for Homebrew bootstrap")
	}
	return filepath.Join(values["HOME"], "Library", "Application Support", "JobCtrl"), nil
}

func bootstrapPromoteOrExec(executable string, args, inheritedEnv []string, stdout, stderr io.Writer, store *release.Store, candidate release.Receipt) error {
	promoted := false
	var promotedContext launchContext
	active, err := store.ReadActive()
	if errors.Is(err, os.ErrNotExist) {
		if err := bootstrapFirstInstall(store, candidate); err != nil {
			return err
		}
	} else if err != nil {
		return err
	} else if active.Receipt.BuildID != candidate.BuildID {
		ctx, err := transitionContextForReceipt(inheritedEnv, store, candidate)
		if err != nil {
			return err
		}
		ctx.Environment = append(ctx.Environment, "JOBCTRL_ACQUISITION_SOURCE=homebrew")
		if err := promoteExisting(ctx, store, active, candidate.BuildID, "update", stdout); err != nil {
			return err
		}
		promoted, promotedContext = true, ctx
	} else {
		// The selector verifier below takes a shared selection lock. Keep this
		// exact-candidate check scoped so its exclusive locks are released
		// before we verify and exec the public selector.
		if err := func() error {
			transition, lockErr := store.TransitionLock()
			if lockErr != nil {
				return lockErr
			}
			defer transition.Close()
			selection, lockErr := store.SelectionLock(true)
			if lockErr != nil {
				return lockErr
			}
			defer selection.Close()
			active, lockErr = store.ReadActive()
			if lockErr != nil {
				return lockErr
			}
			if active.Receipt.BuildID != candidate.BuildID || active.Receipt.DescriptorSHA256 != candidate.DescriptorSHA256 {
				return errors.New("Homebrew active release changed while acquiring selection; retry through the authenticated selector")
			}
			// A Homebrew-owned selection that already matches the authenticated
			// formula candidate is the invocation fast path. Do not rewrite the
			// active record (and advance its generation) for every command. A
			// matching curl/migration selection still records its acquisition
			// adoption once so later `jobctrl update` routes through Homebrew.
			if active.Acquisition != "homebrew" {
				if _, lockErr = store.WriteSelectedActive(active.Receipt, active.Generation, active.SelectorBuildID, "homebrew"); lockErr != nil {
					return lockErr
				}
			}
			return nil
		}(); err != nil {
			return err
		}
	}
	if promoted && len(args) > 0 && args[0] == "start" {
		foreground, noOpen, err := parseStartArgs(args[1:])
		if err != nil {
			return err
		}
		if foreground {
			return errors.New("Homebrew upgrade already started the healthy candidate; rerun `jobctrl status` instead of requesting foreground supervision")
		}
		if !noOpen {
			return openURL(promotedContext)
		}
		_, err = fmt.Fprintf(stdout, "JobCtrl is ready at http://127.0.0.1:%d\n", promotedContext.Manifest.Ports.API)
		return err
	}
	selector := filepath.Join(store.Home, "bin", "jobctrl")
	if err := VerifyPublicSelectorForExecution(store.Home); err != nil {
		return fmt.Errorf("verify Homebrew public selector before execution: %w", err)
	}
	return execPublicSelector(selector, args, inheritedEnv)
}

func bootstrapFirstInstall(store *release.Store, candidate release.Receipt) error {
	transition, err := store.TransitionLock()
	if err != nil {
		return err
	}
	defer transition.Close()
	selection, err := store.SelectionLock(true)
	if err != nil {
		return err
	}
	defer selection.Close()
	if _, err := store.ReadActive(); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	verified, err := verifyInstalledReleaseForExecution(store, candidate)
	if err != nil {
		return err
	}
	policy, err := readInstalledPolicy(store.Home, candidate)
	if err != nil {
		return err
	}
	journal, err := store.Begin("install", nil, &candidate, candidate.DescriptorSHA256)
	if err != nil {
		return err
	}
	if err := advance(store, &journal, release.ReleaseCommitted); err != nil {
		return err
	}
	journal.PendingPolicy = &policy
	if err := advance(store, &journal, release.PolicyPending); err != nil {
		return err
	}
	state, err := store.ValidateMetadata(policy)
	if err != nil {
		return err
	}
	if err := store.CommitMetadata(state); err != nil {
		return err
	}
	if err := advance(store, &journal, release.PolicyFinalized); err != nil {
		return err
	}
	if err := handoffPublicSelector(store.Home, verified); err != nil {
		return err
	}
	if _, err := store.WriteSelectedActive(candidate, 0, candidate.BuildID, "homebrew"); err != nil {
		return err
	}
	if err := writeLegacyCurrent(store.Home, candidate); err != nil {
		return err
	}
	return advance(store, &journal, release.Promoted)
}
