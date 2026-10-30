//go:build darwin || (linux && (amd64 || arm64))

package retentionfs

import (
	"runtime"
	"syscall"
	"unsafe"
)

func renameWithFlags(fd uintptr, oldName, newName string, trap, flags uintptr) error {
	old, err := syscall.BytePtrFromString(oldName)
	if err != nil {
		return err
	}
	newPath, err := syscall.BytePtrFromString(newName)
	if err != nil {
		return err
	}
	_, _, errno := syscall.Syscall6(trap, fd, uintptr(unsafe.Pointer(old)), fd, uintptr(unsafe.Pointer(newPath)), flags, 0)
	runtime.KeepAlive(old)
	runtime.KeepAlive(newPath)
	if errno != 0 {
		return errno
	}
	return nil
}
