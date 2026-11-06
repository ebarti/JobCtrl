package launcher

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

const profileTransferReceiptName = "profile-transfer-receipt.json"
const profileTransferSelectionName = ".jobctrl-profile-transfer-native-selection"

type profileTransferReceipt struct {
	Schema              string `json:"schema"`
	Status              string `json:"status"`
	SourcePreserved     bool   `json:"sourcePreserved"`
	Target              string `json:"target"`
	ProfileBundleSHA256 string `json:"profileBundleSha256"`
	Reset               string `json:"reset"`
	Selected            *bool  `json:"selected"`
}

// Only the first native selection may initialize history after an explicit
// Profile transfer. This exception never applies to updates or paired rollback.
func admitInitialProfileTransfer(ctx launchContext, verified verifiedRelease) (bool, error) {
	authority := &retentionReferenceAuthority{}
	defer authority.close()
	workspace, err := authority.open(ctx.Instance.StateDir)
	if err != nil {
		return false, err
	}
	app, err := workspace.Lstat("jobctrl.db")
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	if _, err := workspace.Lstat("temporal.db"); err == nil {
		return false, nil // An existing pair retains ordinary lifecycle admission.
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	private := func(info os.FileInfo, directory bool) bool {
		owner, ok := info.Sys().(*syscall.Stat_t)
		return ok && int(owner.Uid) == os.Getuid() && info.Mode()&os.ModeSymlink == 0 &&
			((directory && info.IsDir() && info.Mode().Perm() == 0o700) ||
				(!directory && info.Mode().IsRegular() && info.Mode().Perm() == 0o600 && owner.Nlink == 1))
	}
	info, err := workspace.Stat(".")
	if err != nil || !private(info, true) {
		return false, errors.New("fresh Profile transfer workspace is not a private owned directory")
	}
	for _, name := range []string{profileTransferSelectionName, "temporal", "temporal.db", "temporal.db-wal", "temporal.db-shm", "temporal.db-journal"} {
		if _, err := workspace.Lstat(name); !errors.Is(err, os.ErrNotExist) {
			return false, errors.New("Profile transfer native selection authority is already consumed or history exists; preserve the target and inspect it, or explicitly transfer the unchanged source into a different nonexistent target")
		}
		authority.watchAbsent(workspace, name)
	}
	raw, receiptInfo, err := readReferenceJSON(workspace, profileTransferReceiptName)
	if err != nil || !private(receiptInfo, false) || receiptInfo.Size() > 4096 {
		return false, errors.New("incomplete database pair requires a private completed explicit Profile transfer receipt before first selection")
	}
	var receipt profileTransferReceipt
	if err := decodeRetentionJSON(raw, &receipt); err != nil || receipt.Schema != "jobctrl.profile-cutover.v1" || receipt.Status != "complete" ||
		!receipt.SourcePreserved || receipt.Selected == nil || *receipt.Selected || receipt.Reset != "all-non-profile-application-data" ||
		receipt.Target != ctx.Instance.StateDir || !validSHA256(receipt.ProfileBundleSHA256) || strings.ToLower(receipt.ProfileBundleSHA256) != receipt.ProfileBundleSHA256 {
		return false, errors.New("explicit Profile transfer receipt is incomplete or does not bind this fresh target")
	}
	authority.watch(workspace, profileTransferReceiptName, receiptInfo)
	registry, err := authority.open(ctx.Instance.Dir)
	if err != nil {
		return false, err
	}
	entries, err := authority.entries(registry, "fresh Profile transfer registration")
	if err != nil {
		return false, err
	}
	for _, entry := range entries {
		if entry.Name() != "logs" {
			return false, errors.New("incomplete database pair belongs to an existing native registration; preserve it for recovery")
		}
		logs, err := authority.openDirectory(registry, "logs")
		if err != nil {
			return false, err
		}
		defer logs.Close()
		logged, err := authority.entries(logs, "fresh Profile transfer logs")
		if err != nil || len(logged) != 0 {
			return false, errors.New("incomplete database pair has prior native execution logs; preserve it for recovery")
		}
	}
	authority.watch(workspace, "jobctrl.db", app)
	if err := admitPythonApplicationLifecycle(ctx, verified); err != nil {
		return false, err
	}
	if err := refuseOpenWorkspaceDatabases(filepath.Join(ctx.Instance.StateDir, "jobctrl.db"), filepath.Join(ctx.Instance.StateDir, "temporal.db")); err != nil {
		return false, fmt.Errorf("first selection of Profile transfer target: %w", err)
	}
	if err := authority.validate(); err != nil {
		return false, err
	}
	// Consume before publication: a crash fails closed, and a stale receipt can
	// never authorize resetting missing history under another runtime home.
	marker, err := workspace.OpenFile(profileTransferSelectionName, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o600)
	if err != nil {
		return false, fmt.Errorf("consume Profile transfer native selection authority: %w", err)
	}
	_, writeErr := marker.WriteString("jobctrl-profile-transfer-native-selection-v1\n")
	syncErr := marker.Sync()
	closeErr := marker.Close()
	directory, openErr := workspace.Open(".")
	if openErr != nil {
		return false, openErr
	}
	defer directory.Close()
	if err := errors.Join(writeErr, syncErr, closeErr, directory.Sync()); err != nil {
		return false, fmt.Errorf("sync consumed Profile transfer native selection authority: %w", err)
	}
	return true, nil
}
