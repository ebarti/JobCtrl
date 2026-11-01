//go:build !darwin

package launcher

import (
	"errors"
	"os"
)

func verifyRetentionSourceAuthority(*retentionReferenceAuthority, *os.Root, string, string, instanceState) error {
	return errors.New("source runtime authority is unavailable on this platform")
}

// Native execution receipts cannot be authenticated on this platform. A
// copied runtime with any such authority must be preserved for inspection.
func verifyRetentionInstalledApplyAuthority(authority *retentionReferenceAuthority, instances *os.Root, name, _, _ string) error {
	instanceRoot, err := authority.openDirectory(instances, name)
	if err != nil {
		return err
	}
	authority.hold(instanceRoot)
	executions, err := authority.openDirectory(instanceRoot, "executions")
	if errors.Is(err, os.ErrNotExist) {
		authority.watchAbsent(instanceRoot, "executions")
		return nil
	}
	if err != nil {
		return err
	}
	authority.hold(executions)
	return errors.New("installed execution authority is unavailable on this platform")
}
