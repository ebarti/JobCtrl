package release

import (
	"syscall"
	"testing"
)

func TestSelectionLockExecHandoffRestoresDescriptorFlags(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	lock, err := store.SelectionLock(false)
	if err != nil {
		t.Fatal(err)
	}
	defer lock.Close()
	fd := lock.file.Fd()
	flags, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFD, 0)
	if errno != 0 || flags&syscall.FD_CLOEXEC == 0 {
		t.Fatalf("new lock does not start close-on-exec: flags=%d errno=%v", flags, errno)
	}
	restore, err := lock.InheritOnExec()
	if err != nil {
		t.Fatal(err)
	}
	inherited, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFD, 0)
	if errno != 0 || inherited&syscall.FD_CLOEXEC != 0 {
		t.Fatalf("handoff left close-on-exec set: flags=%d errno=%v", inherited, errno)
	}
	restore()
	restored, _, errno := syscall.Syscall(syscall.SYS_FCNTL, fd, syscall.F_GETFD, 0)
	if errno != 0 || restored != flags {
		t.Fatalf("failed exec did not restore descriptor flags: got=%d want=%d errno=%v", restored, flags, errno)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := lock.InheritOnExec(); err == nil {
		t.Fatal("closed lock accepted for exec handoff")
	}
}
