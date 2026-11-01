package launcher

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
)

// A retention scan holds the runtime and workspace directories open, and
// records the identities and metadata it used. Native backup writers sharing
// this runtime are serialized by the transition lock; these checks also reject
// ordinary directory or metadata replacements outside that lock.
type retentionReferenceAuthority struct {
	roots    []*retentionReferenceRoot
	children []*os.Root
	checks   []retentionReferenceCheck
}

type retentionReferenceRoot struct {
	path string
	root *os.Root
	info os.FileInfo
}

type retentionReferenceCheck struct {
	root   *os.Root
	name   string
	info   os.FileInfo
	absent bool
}

// Test seam: production leaves it nil.
var afterRetentionReferenceListing func(string)
var afterRetentionReferenceCollection func()

func (a *retentionReferenceAuthority) open(pathname string) (*os.Root, error) {
	info, err := os.Lstat(pathname)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%s is not a regular directory", filepath.Base(pathname))
	}
	root, err := os.OpenRoot(pathname)
	if err != nil {
		return nil, err
	}
	opened, err := root.Stat(".")
	if err != nil || !sameRetentionInfo(info, opened) {
		root.Close()
		return nil, errors.New("reference directory changed while opening")
	}
	a.roots = append(a.roots, &retentionReferenceRoot{pathname, root, info})
	return root, nil
}

func (a *retentionReferenceAuthority) close() {
	for _, root := range a.children {
		_ = root.Close()
	}
	for _, root := range a.roots {
		_ = root.root.Close()
	}
}

func (a *retentionReferenceAuthority) hold(root *os.Root) {
	a.children = append(a.children, root)
}

func sameRetentionInfo(before, after os.FileInfo) bool {
	return before != nil && after != nil && os.SameFile(before, after) && before.Mode() == after.Mode() && before.Size() == after.Size() && before.ModTime() == after.ModTime()
}

func (a *retentionReferenceAuthority) watch(root *os.Root, name string, info os.FileInfo) {
	a.checks = append(a.checks, retentionReferenceCheck{root: root, name: name, info: info})
}

func (a *retentionReferenceAuthority) watchAbsent(root *os.Root, name string) {
	a.checks = append(a.checks, retentionReferenceCheck{root: root, name: name, absent: true})
}

func (a *retentionReferenceAuthority) validate() error {
	for _, item := range a.roots {
		info, err := os.Lstat(item.path)
		if err != nil || !info.IsDir() || !os.SameFile(item.info, info) {
			return errors.New("reference root was replaced")
		}
	}
	for _, item := range a.checks {
		info, err := item.root.Lstat(item.name)
		if item.absent {
			if !errors.Is(err, os.ErrNotExist) {
				return errors.New("reference authority appeared during retention")
			}
		} else if err != nil || !sameRetentionInfo(item.info, info) {
			return errors.New("reference authority changed during retention")
		}
	}
	return nil
}

// openDirectory anchors a checked, non-symlink child and records its identity
// and modification time so subsequent replacements or new entries fail closed.
func (a *retentionReferenceAuthority) openDirectory(root *os.Root, name string) (*os.Root, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, fmt.Errorf("%s is not a regular directory", path.Base(name))
	}
	child, err := root.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	opened, err := child.Stat(".")
	if err != nil || !sameRetentionInfo(info, opened) {
		child.Close()
		return nil, errors.New("reference directory changed while opening")
	}
	a.watch(root, name, info)
	return child, nil
}

// watchDirectoryPath checks each component of a local rollback pair.ID
// relative to the anchored backup root. It refuses missing or linked targets
// before authorizing any release deletion.
func (a *retentionReferenceAuthority) watchDirectoryPath(root *os.Root, name string) error {
	if !filepath.IsLocal(name) {
		return errors.New("backup pair target is not a local path")
	}
	current := ""
	for _, component := range strings.Split(filepath.Clean(name), string(filepath.Separator)) {
		current = filepath.Join(current, component)
		info, err := root.Lstat(current)
		if err != nil {
			return err
		}
		if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
			return errors.New("backup pair target is not a regular directory")
		}
		a.watch(root, current, info)
	}
	return nil
}

func (a *retentionReferenceAuthority) entries(root *os.Root, label string) ([]os.DirEntry, error) {
	info, err := root.Stat(".")
	if err != nil {
		return nil, err
	}
	file, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	entries, readErr := file.ReadDir(-1)
	closeErr := file.Close()
	if readErr != nil {
		return nil, readErr
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if afterRetentionReferenceListing != nil {
		afterRetentionReferenceListing(label)
	}
	after, err := root.Stat(".")
	if err != nil || !sameRetentionInfo(info, after) {
		return nil, errors.New("reference directory changed while listing")
	}
	return entries, nil
}

func readReferenceJSON(root *os.Root, name string) ([]byte, os.FileInfo, error) {
	info, err := root.Lstat(name)
	if err != nil {
		return nil, nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, nil, fmt.Errorf("%s is not a regular file", name)
	}
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !sameRetentionInfo(info, opened) {
		return nil, nil, errors.New("reference file changed while opening")
	}
	const maxRetentionJSONBytes = 1 << 20
	raw, err := io.ReadAll(io.LimitReader(file, maxRetentionJSONBytes+1))
	if err != nil {
		return nil, nil, err
	}
	if len(raw) > maxRetentionJSONBytes {
		return nil, nil, errors.New("reference metadata exceeds size limit")
	}
	after, err := root.Lstat(name)
	if err != nil || !sameRetentionInfo(info, after) {
		return nil, nil, errors.New("reference file changed while reading")
	}
	return raw, info, nil
}

func (a *retentionReferenceAuthority) readRootJSON(root *os.Root, name string, destination any) error {
	raw, info, err := readReferenceJSON(root, name)
	if errors.Is(err, os.ErrNotExist) {
		a.watchAbsent(root, name)
		return err
	}
	if err != nil {
		return err
	}
	a.watch(root, name, info)
	return decodeRetentionJSON(raw, destination)
}

// readJSON opens the leaf relative to the anchored child directory, then keeps
// a parent-relative identity check alive through the destructive phase.
func (a *retentionReferenceAuthority) readJSON(parent *os.Root, childName, fileName string, destination any) error {
	child, err := a.openDirectory(parent, childName)
	if err != nil {
		return err
	}
	defer child.Close()
	raw, info, err := readReferenceJSON(child, fileName)
	if errors.Is(err, os.ErrNotExist) {
		a.watchAbsent(parent, path.Join(childName, fileName))
		return err
	}
	if err != nil {
		return err
	}
	a.watch(parent, path.Join(childName, fileName), info)
	return decodeRetentionJSON(raw, destination)
}
