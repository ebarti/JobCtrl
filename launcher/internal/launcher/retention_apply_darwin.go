//go:build darwin

package launcher

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// An independent Apply receipt does not record the selected build. While it
// remains unresolved no installed release can safely be identified as unused.
// This is a read-only retention check; it never cleans up or signals a scope.
func verifyRetentionInstalledApplyAuthority(authority *retentionReferenceAuthority, instances *os.Root, name, runtimeHome, stateDir string) error {
	instanceRoot, err := authority.openDirectory(instances, name)
	if err != nil {
		return err
	}
	authority.hold(instanceRoot)
	executions, err := openRetentionExecutionDirectory(authority, instanceRoot, "executions")
	if errors.Is(err, os.ErrNotExist) {
		authority.watchAbsent(instanceRoot, "executions")
		return nil
	}
	if err != nil {
		return err
	}
	entries, err := authority.entries(executions, "installed execution receipts")
	if err != nil {
		return err
	}
	if len(entries) > 10000 {
		return errors.New("execution receipt bound exceeded")
	}
	ctx := launchContext{Instance: instance{
		RuntimeHome: runtimeHome, StateDir: stateDir, ID: name,
		Dir: filepath.Join(runtimeHome, "instances", name), StatePath: filepath.Join(runtimeHome, "instances", name, "state.json"),
	}}
	var completed *os.Root
	var boot string
	for _, entry := range entries {
		if executionReceiptTemporaryName(entry.Name()) {
			continue // Unpublished receipts cannot authorize execution.
		}
		id := strings.TrimSuffix(entry.Name(), ".json")
		if entry.Name() != id+".json" || !executionIDValid(id) {
			return errors.New("unfamiliar execution receipt")
		}
		raw, err := readRetentionExecutionEvidence(authority, executions, entry.Name(), 16384)
		if err != nil {
			return err
		}
		var scope executionScope
		if err := decodeExecutionReceipt(raw, &scope); err != nil || validateExecutionScope(ctx, scope) != nil || scope.ID != id {
			return errors.New("execution receipt does not bind this workspace")
		}
		if scope.Purpose != "apply" {
			continue // Ordinary runtime retention remains governed by its registry.
		}
		if boot == "" {
			boot, err = executionBootSession()
			if err != nil {
				return errors.New("Apply execution boot identity is unavailable")
			}
		}
		if completed == nil {
			completed, err = openRetentionExecutionDirectory(authority, instanceRoot, "completed-executions")
			if err != nil {
				return fmt.Errorf("Apply completion is unavailable: %w", err)
			}
		}
		proofRaw, err := readRetentionExecutionEvidence(authority, completed, id+".json", 32768)
		if err != nil {
			return fmt.Errorf("Apply completion is unavailable: %w", err)
		}
		var proof executionCompletion
		if err := decodeExecutionCompletion(proofRaw, &proof); err != nil || validateExecutionCompletion(ctx, proof) != nil {
			return errors.New("Apply completion is invalid")
		}
		digest := sha256.Sum256(raw)
		if proof.Scope != scope || proof.ReceiptSHA256 != hex.EncodeToString(digest[:]) {
			return errors.New("Apply completion does not match the exact receipt")
		}
		if scope.BootSession == boot {
			if proof.VerificationBootSession != boot {
				return errors.New("Apply completion has an inconsistent verification boot")
			}
			count, err := readCoalitionActiveTaskCount(scope.CoalitionIDs[0])
			if (err != nil && !errors.Is(err, syscall.ESRCH)) || (err == nil && count != 0) {
				return errors.New("Apply execution authority may still be active")
			}
		}
	}
	return nil
}
