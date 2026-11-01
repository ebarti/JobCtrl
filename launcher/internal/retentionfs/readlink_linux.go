//go:build linux

package retentionfs

import "syscall"

const readlinkatTrap = syscall.SYS_READLINKAT
