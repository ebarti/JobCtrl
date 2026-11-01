//go:build linux && arm64

package retentionfs

// Linux renameat2 on arm64, with RENAME_NOREPLACE.
func renameExclusive(fd uintptr, oldName, newName string) error {
	return renameWithFlags(fd, oldName, newName, 276, 1)
}
