//go:build darwin

package retentionfs

// readlinkat is available on all supported Darwin versions. The syscall
// number matches the Darwin SDK's sys/syscall.h.
const readlinkatTrap = 473
