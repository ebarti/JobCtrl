//go:build darwin

package launcher

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// Source registries do not identify an installed release. Accept them only
// when their exact source execution and checkout binding can be verified.
func verifyRetentionSourceAuthority(authority *retentionReferenceAuthority, instances *os.Root, name, runtimeHome string, state instanceState) error {
	if !executionIDValid(state.ExecutionScopeID) || !sha256Pattern.MatchString(state.ManifestSHA256) ||
		!filepath.IsAbs(state.PayloadRoot) || filepath.Clean(state.PayloadRoot) != state.PayloadRoot ||
		pathsOverlap(state.PayloadRoot, filepath.Join(runtimeHome, "releases")) {
		return errors.New("invalid source runtime identity")
	}
	canonical, err := filepath.EvalSymlinks(state.PayloadRoot)
	if err != nil || canonical != state.PayloadRoot {
		return errors.New("source checkout identity cannot be verified")
	}
	checkout, err := authority.open(state.PayloadRoot)
	if err != nil {
		return err
	}
	scripts, err := authority.openDirectory(checkout, "scripts")
	if err != nil {
		return err
	}
	authority.hold(scripts)
	script, scriptInfo, err := readReferenceJSON(scripts, "dev")
	if err != nil {
		return err
	}
	authority.watch(scripts, "dev", scriptInfo)
	digest := sha256.Sum256(script)
	if hex.EncodeToString(digest[:]) != state.ManifestSHA256 {
		return errors.New("source launcher changed since the registry was written")
	}

	instanceRoot, err := authority.openDirectory(instances, name)
	if err != nil {
		return err
	}
	authority.hold(instanceRoot)
	ctx := launchContext{Instance: instance{
		RuntimeHome: runtimeHome, StateDir: state.CanonicalStateDir, ID: name,
		Dir:       filepath.Join(runtimeHome, "instances", name),
		StatePath: filepath.Join(runtimeHome, "instances", name, "state.json"),
	}}
	var active *executionScope
	var prior []executionScope
	executions, err := openRetentionExecutionDirectory(authority, instanceRoot, "executions")
	if errors.Is(err, os.ErrNotExist) {
		authority.watchAbsent(instanceRoot, "executions")
	} else if err != nil {
		return err
	} else {
		entries, err := authority.entries(executions, "source execution receipts")
		if err != nil {
			return err
		}
		if len(entries) > 10000 {
			return errors.New("source execution receipt bound exceeded")
		}
		for _, entry := range entries {
			if executionReceiptTemporaryName(entry.Name()) {
				continue // An unpublished receipt cannot authorize execution.
			}
			id := strings.TrimSuffix(entry.Name(), ".json")
			if entry.Name() != id+".json" || !executionIDValid(id) {
				return errors.New("unfamiliar source execution receipt")
			}
			raw, err := readRetentionExecutionEvidence(authority, executions, entry.Name(), 16384)
			if err != nil {
				return err
			}
			var scope executionScope
			if err := decodeExecutionReceipt(raw, &scope); err != nil {
				return err
			}
			if err := validateExecutionScope(ctx, scope); err != nil || scope.ID != id {
				return errors.New("source execution receipt does not bind this workspace")
			}
			if scope.ID == state.ExecutionScopeID {
				if scope.Purpose != "source" {
					return errors.New("source execution receipt has a different purpose")
				}
				active = &scope
			} else {
				prior = append(prior, scope)
			}
		}
	}
	var completed *os.Root
	readCompletion := func(id string) (executionCompletion, error) {
		var completion executionCompletion
		if completed == nil {
			var err error
			completed, err = openRetentionExecutionDirectory(authority, instanceRoot, "completed-executions")
			if err != nil {
				return completion, fmt.Errorf("source completion is unavailable: %w", err)
			}
		}
		raw, err := readRetentionExecutionEvidence(authority, completed, id+".json", 32768)
		if err != nil {
			return completion, err
		}
		if err := decodeExecutionCompletion(raw, &completion); err != nil {
			return completion, err
		}
		if err := validateExecutionCompletion(ctx, completion); err != nil || completion.Scope.ID != id {
			return completion, errors.New("execution completion does not bind its receipt")
		}
		receipt, err := json.Marshal(completion.Scope)
		if err != nil {
			return completion, err
		}
		receiptDigest := sha256.Sum256(append(receipt, '\n'))
		if hex.EncodeToString(receiptDigest[:]) != completion.ReceiptSHA256 {
			return completion, errors.New("execution completion receipt digest is invalid")
		}
		return completion, nil
	}
	if len(prior) > 0 {
		boot, err := executionBootSession()
		if err != nil {
			return errors.New("source execution boot identity is unavailable")
		}
		for _, scope := range prior {
			completion, err := readCompletion(scope.ID)
			if err != nil || completion.Scope != scope {
				return errors.New("additional execution authority is not completed")
			}
			if scope.BootSession == boot {
				if completion.VerificationBootSession != boot {
					return errors.New("additional execution completion has an inconsistent verification boot")
				}
				count, err := readCoalitionActiveTaskCount(scope.CoalitionIDs[0])
				if (err != nil && !errors.Is(err, syscall.ESRCH)) || (err == nil && count != 0) {
					return errors.New("additional execution authority may still be active")
				}
			}
		}
	}
	if state.OwnershipVerified && state.StoppedAt != nil {
		completion, err := readCompletion(state.ExecutionScopeID)
		if err != nil || completion.Scope.Purpose != "source" ||
			(active != nil && *active != completion.Scope) {
			return errors.New("source completion does not bind the stopped registry")
		}
		boot, err := executionBootSession()
		if err != nil {
			return errors.New("source execution boot identity is unavailable")
		}
		if completion.Scope.BootSession == boot {
			if completion.VerificationBootSession != boot {
				return errors.New("source completion has an inconsistent verification boot")
			}
			count, err := readCoalitionActiveTaskCount(completion.Scope.CoalitionIDs[0])
			if (err != nil && !errors.Is(err, syscall.ESRCH)) || (err == nil && count != 0) {
				return errors.New("stopped source execution may still be active")
			}
		}
		return nil
	}
	if state.StoppedAt != nil || active == nil || !recordMatchesLiveProcess(state.Supervisor) {
		return errors.New("source runtime liveness cannot be verified")
	}
	boot, err := executionBootSession()
	if err != nil || boot != active.BootSession {
		return errors.New("source execution boot identity changed")
	}
	rootIdentity, err := processStartIdentity(active.RootPID)
	if err != nil || rootIdentity != active.RootIdentity {
		return errors.New("source execution helper identity changed")
	}
	rootIDs, err := processCoalitionIDs(active.RootPID)
	if err != nil || rootIDs != active.CoalitionIDs {
		return errors.New("source execution helper scope changed")
	}
	supervisorIDs, err := processCoalitionIDs(state.Supervisor.PID)
	if err != nil || supervisorIDs != active.CoalitionIDs {
		return errors.New("source supervisor is outside its recorded execution scope")
	}
	if identity, err := processStartIdentity(active.RootPID); err != nil || identity != active.RootIdentity {
		return errors.New("source execution helper changed during verification")
	}
	if identity, err := processStartIdentity(state.Supervisor.PID); err != nil || identity != state.Supervisor.StartIdentity {
		return errors.New("source supervisor changed during verification")
	}
	return nil
}

func openRetentionExecutionDirectory(authority *retentionReferenceAuthority, parent *os.Root, name string) (*os.Root, error) {
	root, err := authority.openDirectory(parent, name)
	if err != nil {
		return nil, err
	}
	info, err := root.Stat(".")
	stat, ok := infoSysStat(info)
	if err != nil || !ok || info.Mode().Perm() != 0o700 || int(stat.Uid) != os.Getuid() {
		root.Close()
		return nil, errors.New("unsafe execution authority directory")
	}
	authority.hold(root)
	return root, nil
}

func readRetentionExecutionEvidence(authority *retentionReferenceAuthority, root *os.Root, name string, limit int64) ([]byte, error) {
	raw, info, err := readReferenceJSON(root, name)
	if err != nil {
		return nil, err
	}
	stat, ok := infoSysStat(info)
	if !ok || info.Mode().Perm() != 0o600 || info.Size() > limit || int(stat.Uid) != os.Getuid() || stat.Nlink != 1 {
		return nil, errors.New("unsafe execution evidence")
	}
	authority.watch(root, name, info)
	return raw, nil
}

func infoSysStat(info os.FileInfo) (*syscall.Stat_t, bool) {
	if info == nil {
		return nil, false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return stat, ok && stat != nil
}
