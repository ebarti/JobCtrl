//go:build darwin

package retentionfs

// XNU's renameatx_np (syscall 488) with RENAME_EXCL refuses to overwrite.
func renameExclusive(fd uintptr, oldName, newName string) error {
	return renameWithFlags(fd, oldName, newName, 488, 0x4)
}
