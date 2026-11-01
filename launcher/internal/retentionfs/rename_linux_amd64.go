//go:build linux && amd64

package retentionfs

// Linux renameat2 on amd64, with RENAME_NOREPLACE.
func renameExclusive(fd uintptr, oldName, newName string) error {
	return renameWithFlags(fd, oldName, newName, 316, 1)
}
