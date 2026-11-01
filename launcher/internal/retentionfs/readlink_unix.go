//go:build darwin || linux

package retentionfs

import (
	"errors"
	"os"
	"syscall"
	"unsafe"
)

// readlink reads a single entry relative to the already-open directory. Go
// 1.24's os.Root does not expose Readlink, so use the platform's readlinkat.
func readlink(root *os.Root, name string, expectedLength int) (string, error) {
	if !safeName(name) || expectedLength < 0 || expectedLength > 1<<20 {
		return "", errors.New("invalid release link")
	}
	dir, err := root.Open(".")
	if err != nil {
		return "", err
	}
	defer dir.Close()
	namePtr, err := syscall.BytePtrFromString(name)
	if err != nil {
		return "", err
	}
	buf := make([]byte, expectedLength+1)
	n, _, errno := syscall.Syscall6(readlinkatTrap, dir.Fd(), uintptr(unsafe.Pointer(namePtr)), uintptr(unsafe.Pointer(&buf[0])), uintptr(len(buf)), 0, 0)
	if errno != 0 {
		return "", errno
	}
	return string(buf[:n]), nil
}
