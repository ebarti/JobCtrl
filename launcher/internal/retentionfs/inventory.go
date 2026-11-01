//go:build darwin || linux

package retentionfs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"syscall"
)

// Item describes one file or link authorized by the authenticated release
// envelope. Directories are derived from these paths and are never inferred
// from unrecorded contents.
type Item struct {
	Type      string
	SHA256    string
	SizeBytes int64 // -1 permits any length, but still requires the digest.
	Mode      os.FileMode
	CheckMode bool
	Target    string
}

type Inventory map[string]Item

// ReadFile reads a bounded regular file through the captured entry. It refuses
// a changed entry or root and never follows the final path component.
func (r *Root) ReadFile(entry Entry, name string, limit int64) ([]byte, error) {
	if limit <= 0 || name == "." || name == ".." || path.IsAbs(name) || path.Clean(name) != name || strings.HasPrefix(name, "../") || strings.Contains(name, "\\") {
		return nil, errors.New("invalid release evidence path")
	}
	dir, err := r.openEntry(entry.Name, entry.Identity)
	if err != nil {
		return nil, err
	}
	defer dir.Close()
	info, err := dir.Lstat(name)
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("release evidence is not a regular file")
	}
	file, err := dir.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return nil, fmt.Errorf("%w: release evidence changed while opening", ErrChanged)
	}
	raw, err := io.ReadAll(io.LimitReader(file, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(raw)) > limit {
		return nil, errors.New("release evidence exceeds size limit")
	}
	current, err := dir.Lstat(name)
	if err != nil || !os.SameFile(info, current) || info.Size() != current.Size() || info.ModTime() != current.ModTime() {
		return nil, fmt.Errorf("%w: release evidence changed while reading", ErrChanged)
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	currentEntry, err := r.releases.Lstat(entry.Name)
	if err != nil || !sameDirectory(entry.Identity, currentEntry) {
		return nil, fmt.Errorf("%w: release entry changed while reading evidence", ErrChanged)
	}
	return raw, nil
}

func (inventory Inventory) expanded() (map[string]Item, error) {
	if len(inventory) == 0 {
		return nil, errors.New("release ownership inventory is empty")
	}
	paths := make(map[string]Item, len(inventory))
	for name, item := range inventory {
		if name == "" || path.IsAbs(name) || path.Clean(name) != name || name == "." || name == ".." || strings.HasPrefix(name, "../") || strings.Contains(name, "\\") {
			return nil, errors.New("release ownership inventory contains an unsafe path")
		}
		if item.Type != "file" && item.Type != "symlink" {
			return nil, errors.New("release ownership inventory contains an invalid file type")
		}
		paths[name] = item
	}
	for name := range inventory {
		for parent := path.Dir(name); parent != "."; parent = path.Dir(parent) {
			if existing, ok := paths[parent]; ok && existing.Type != "directory" {
				return nil, errors.New("release ownership inventory overlaps a parent file")
			}
			paths[parent] = Item{Type: "directory"}
		}
	}
	return paths, nil
}

// VerifyEntry checks every existing file and directory against authenticated
// ownership. Extra files, links, and even empty directories are not owned.
func (r *Root) VerifyEntry(entry Entry, inventory Inventory) error {
	paths, err := inventory.expanded()
	if err != nil {
		return err
	}
	dir, err := r.openEntry(entry.Name, entry.Identity)
	if err != nil {
		return err
	}
	defer dir.Close()
	return verifyInventory(dir, paths, r.Validate)
}

func (r *Root) openEntry(name string, identity os.FileInfo) (*os.Root, error) {
	if !safeName(name) || identity == nil {
		return nil, errors.New("invalid release retention entry")
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	before, err := r.releases.Lstat(name)
	if err != nil || !sameDirectory(identity, before) {
		return nil, fmt.Errorf("%w: release entry changed", ErrChanged)
	}
	dir, err := r.releases.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	opened, err := dir.Stat(".")
	if err != nil || !sameDirectory(identity, opened) {
		dir.Close()
		return nil, fmt.Errorf("%w: release entry changed while opening", ErrChanged)
	}
	return dir, nil
}

func verifyInventory(root *os.Root, paths map[string]Item, validate func() error) error {
	seen := make(map[string]bool, len(paths))
	if err := walkInventory(root, "", paths, seen, validate); err != nil {
		return err
	}
	for name := range paths {
		if !seen[name] {
			return fmt.Errorf("release ownership path %s is missing", name)
		}
	}
	return nil
}

func walkInventory(root *os.Root, prefix string, paths map[string]Item, seen map[string]bool, validate func() error) error {
	if err := validate(); err != nil {
		return err
	}
	file, err := root.Open(".")
	if err != nil {
		return err
	}
	entries, readErr := file.ReadDir(-1)
	closeErr := file.Close()
	if readErr != nil {
		return readErr
	}
	if closeErr != nil {
		return closeErr
	}
	for _, entry := range entries {
		name := path.Join(prefix, entry.Name())
		expected, ok := paths[name]
		if !ok {
			return fmt.Errorf("release contains unowned path %s", name)
		}
		info, err := root.Lstat(entry.Name())
		if err != nil {
			return err
		}
		if expected.Type == "directory" {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("release directory %s changed type", name)
			}
			child, err := root.OpenRoot(entry.Name())
			if err != nil {
				return err
			}
			opened, statErr := child.Stat(".")
			if statErr != nil || !sameDirectory(info, opened) {
				child.Close()
				return fmt.Errorf("%w: release directory changed", ErrChanged)
			}
			err = walkInventory(child, name, paths, seen, validate)
			child.Close()
			if err != nil {
				return err
			}
		} else if err := verifyLeaf(root, entry.Name(), info, expected); err != nil {
			return fmt.Errorf("release ownership path %s: %w", name, err)
		}
		current, err := root.Lstat(entry.Name())
		if err != nil || !os.SameFile(info, current) {
			return fmt.Errorf("%w: release path changed", ErrChanged)
		}
		seen[name] = true
	}
	return validate()
}

func verifyLeaf(root *os.Root, name string, info os.FileInfo, item Item) error {
	if item.Type == "symlink" {
		if info.Mode()&os.ModeSymlink == 0 {
			return errors.New("expected owned symlink")
		}
		target, err := readlink(root, name, len(item.Target))
		if err != nil {
			return err
		}
		if target != item.Target {
			return errors.New("symlink target changed")
		}
		return nil
	}
	if item.Type != "file" || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("expected owned regular file")
	}
	if item.SizeBytes >= 0 && info.Size() != item.SizeBytes {
		return errors.New("file size changed")
	}
	if item.CheckMode && info.Mode().Perm() != item.Mode {
		return errors.New("file mode changed")
	}
	file, err := root.OpenFile(name, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return err
	}
	defer file.Close()
	opened, err := file.Stat()
	if err != nil || !opened.Mode().IsRegular() || !os.SameFile(info, opened) {
		return fmt.Errorf("%w: owned file changed", ErrChanged)
	}
	digest := sha256.New()
	if _, err := io.Copy(digest, file); err != nil {
		return err
	}
	if hex.EncodeToString(digest.Sum(nil)) != item.SHA256 {
		return errors.New("file digest changed")
	}
	current, err := file.Stat()
	if err != nil || !os.SameFile(info, current) || info.Size() != current.Size() || info.ModTime() != current.ModTime() {
		return fmt.Errorf("%w: owned file changed during verification", ErrChanged)
	}
	return nil
}
