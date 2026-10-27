//go:build darwin

package launcher

import (
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"syscall"
	"unsafe"
)

// CurrentProcessExecutable returns the kernel-recorded executable path for the
// running launcher. Unlike argv[0], PATH, and os.Executable on some Darwin
// launch paths, PROC_PIDPATHINFO is bound to the current process identity.
func CurrentProcessExecutable() (string, error) {
	return processExecutable(os.Getpid())
}

// These are the Darwin kernel proc_info ABI values from
// <sys/proc_info.h>. Calling SYS_PROC_INFO directly keeps lifecycle identity
// checks inside the native launcher: sandbox-exec may deny /bin/ps even under
// `(allow default)`, while this syscall neither executes a helper nor needs
// network access.
const (
	procInfoCallPIDInfo = 2
	procPIDTBSDInfo     = 3
	procPIDPathInfo     = 11
	procBSDInfoSize     = 136
	procPathInfoSize    = 4096

	procBSDPIDOffset        = 12
	procBSDStartSeconds     = 120
	procBSDStartMicrosecond = 128
)

func processStartIdentity(pid int) (string, error) {
	info, err := procInfo(pid, procPIDTBSDInfo, procBSDInfoSize)
	if err != nil {
		return "", err
	}
	if len(info) != procBSDInfoSize {
		return "", fmt.Errorf("Darwin proc_bsdinfo size is %d, expected %d", len(info), procBSDInfoSize)
	}
	if int(binary.LittleEndian.Uint32(info[procBSDPIDOffset:])) != pid {
		return "", errors.New("process identity PID mismatch")
	}
	seconds := binary.LittleEndian.Uint64(info[procBSDStartSeconds:])
	microseconds := binary.LittleEndian.Uint64(info[procBSDStartMicrosecond:])
	if seconds == 0 && microseconds == 0 {
		return "", errors.New("process has no start identity")
	}
	return fmt.Sprintf("%d:%d:%d", pid, seconds, microseconds), nil
}

func processExecutable(pid int) (string, error) {
	path, err := procInfo(pid, procPIDPathInfo, procPathInfoSize)
	if err != nil {
		return "", err
	}
	terminator := 0
	for terminator < len(path) && path[terminator] != 0 {
		terminator++
	}
	if terminator == 0 {
		return "", errors.New("process has no executable path")
	}
	// PROC_PIDPATHINFO promises a NUL-terminated path. Its unused buffer tail
	// is not a stable part of that path, so never TrimRight and retain it: doing
	// so can make the same live child fail identity comparison on the next read.
	return string(path[:terminator]), nil
}

func procInfo(pid, flavor, size int) ([]byte, error) {
	if pid <= 0 {
		return nil, errors.New("invalid pid")
	}
	buffer := make([]byte, size)
	returned, _, errno := syscall.Syscall6(
		syscall.SYS_PROC_INFO,
		procInfoCallPIDInfo,
		uintptr(pid),
		uintptr(flavor),
		0,
		uintptr(unsafe.Pointer(&buffer[0])),
		uintptr(len(buffer)),
	)
	if errno != 0 {
		return nil, errno
	}
	// PROC_PIDPATHINFO returns 0 on success on current Darwin releases but
	// fills its fixed-size output buffer. PROC_PIDTBSDINFO returns its struct
	// size. The actual non-NUL path/struct validation lives in the callers.
	if flavor == procPIDTBSDInfo && returned != procBSDInfoSize {
		return nil, fmt.Errorf("Darwin proc_bsdinfo returned %d bytes", returned)
	}
	return buffer, nil
}
