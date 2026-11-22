package launcher

import (
	"errors"
	"fmt"
	"os"
	"syscall"
)

const spendReceiptDirectory = ".jobctrl.db.llm-spend-pending"

var errSpendRecoveryUnresolved = errors.New("LLM spend accounting is pending, unresolved, or cannot be verified")

// An older payload cannot interpret the receipt authority. After managed
// processes stop, refuse to replace a database or start that payload unless
// the authority is absent, empty, or contains only its safe gate file. Never
// open or interpret receipt contents, and never create, remove, or replay them.
func refuseUnresolvedSpendRecovery(stateDir string) error {
	if err := verifySettledSpendDirectory(stateDir); err != nil {
		return fmt.Errorf("%w; the current database pair may already have been replaced; preserve it, the pre-rollback and other paired backups, the transition journal and %s directory; inspect and reconcile accounting with the ledger and provider records; whether recovery can be retried depends on the transition state: %v", errSpendRecoveryUnresolved, spendReceiptDirectory, err)
	}
	return nil
}

func verifySettledSpendDirectory(stateDir string) error {
	authority := &retentionReferenceAuthority{}
	defer authority.close()
	workspace, err := authority.open(stateDir)
	if err != nil {
		return err
	}
	_, err = workspace.Lstat(spendReceiptDirectory)
	if errors.Is(err, os.ErrNotExist) {
		authority.watchAbsent(workspace, spendReceiptDirectory)
		return authority.validate()
	}
	if err != nil {
		return err
	}
	directory, err := authority.openDirectory(workspace, spendReceiptDirectory)
	if err != nil {
		return err
	}
	authority.hold(directory)
	info, err := directory.Stat(".")
	if err != nil {
		return err
	}
	owner, ok := info.Sys().(*syscall.Stat_t)
	if !ok || owner == nil || int(owner.Uid) != os.Getuid() || info.Mode().Perm()&0o077 != 0 || info.Mode().Perm()&0o500 != 0o500 {
		return errors.New("spend receipt directory is not private and readable by its owner")
	}
	lockInfo, err := directory.Lstat("lock")
	if errors.Is(err, os.ErrNotExist) {
		authority.watchAbsent(directory, "lock")
	} else if err != nil {
		return err
	} else {
		lockOwner, ok := lockInfo.Sys().(*syscall.Stat_t)
		if !lockInfo.Mode().IsRegular() || !ok || lockOwner == nil || int(lockOwner.Uid) != os.Getuid() || lockOwner.Nlink != 1 || lockInfo.Mode().Perm()&0o600 != 0o600 {
			return errors.New("spend receipt gate is not a readable, writable regular file")
		}
		file, err := directory.OpenFile("lock", os.O_RDWR|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
		if err != nil {
			return err
		}
		defer file.Close()
		opened, statErr := file.Stat()
		if statErr != nil || !sameRetentionInfo(lockInfo, opened) {
			return errors.New("spend receipt gate changed while opening")
		}
		if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
			return errors.New("spend receipt gate is busy or unavailable")
		}
		defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
		authority.watch(directory, "lock", lockInfo)
	}
	entries, err := authority.entries(directory, "spend receipts")
	if err != nil {
		return err
	}
	for _, entry := range entries {
		if entry.Name() != "lock" {
			return errors.New("a spend receipt or unfamiliar authority remains")
		}
	}
	return authority.validate()
}
