// Package retentionfs confines automatic release pruning to the directories
// captured when the release store was opened.
//go:build darwin || linux

package retentionfs

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path"
	"path/filepath"
	"syscall"
)

var ErrChanged = errors.New("release retention authority changed")

// beforeClaimRename is a narrow test seam for the boundary between the final
// entry check and the atomic rename. Production leaves it nil.
var beforeClaimRename func()
var beforeRemoveEntry func()
var beforeChildRename func(string)

type Root struct {
	homePath     string
	homeIdentity os.FileInfo
	releasesID   os.FileInfo
	home         *os.Root
	releases     *os.Root
	releasesFile *os.File
}

type Entry struct {
	Name     string
	Identity os.FileInfo
}

type Claim struct {
	root     *Root
	original string
	name     string
	identity os.FileInfo
}

func Open(homePath string, homeIdentity, releasesIdentity os.FileInfo) (*Root, error) {
	if homeIdentity == nil || releasesIdentity == nil {
		return nil, fmt.Errorf("%w: missing store identity", ErrChanged)
	}
	home, err := os.OpenRoot(homePath)
	if err != nil {
		return nil, err
	}
	r := &Root{homePath: homePath, homeIdentity: homeIdentity, releasesID: releasesIdentity, home: home}
	failed := true
	defer func() {
		if failed {
			r.Close()
		}
	}()
	if err := r.Validate(); err != nil {
		return nil, err
	}
	r.releases, err = home.OpenRoot("releases")
	if err != nil {
		return nil, err
	}
	r.releasesFile, err = home.OpenFile("releases", os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	rootInfo, err := r.releases.Stat(".")
	if err != nil {
		return nil, err
	}
	fileInfo, err := r.releasesFile.Stat()
	if err != nil {
		return nil, err
	}
	if !sameDirectory(releasesIdentity, rootInfo) || !sameDirectory(releasesIdentity, fileInfo) {
		return nil, fmt.Errorf("%w: release directory was replaced while opening", ErrChanged)
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	failed = false
	return r, nil
}

func sameDirectory(expected, actual os.FileInfo) bool {
	return expected != nil && actual != nil && actual.IsDir() && actual.Mode()&os.ModeSymlink == 0 && os.SameFile(expected, actual)
}

func (r *Root) Validate() error {
	homeInfo, err := os.Lstat(r.homePath)
	if err != nil || !sameDirectory(r.homeIdentity, homeInfo) {
		return fmt.Errorf("%w: release store home is missing, linked or replaced", ErrChanged)
	}
	openedHome, err := r.home.Stat(".")
	if err != nil || !sameDirectory(r.homeIdentity, openedHome) {
		return fmt.Errorf("%w: opened release store home differs", ErrChanged)
	}
	entry, err := r.home.Lstat("releases")
	if err != nil || !sameDirectory(r.releasesID, entry) {
		return fmt.Errorf("%w: releases directory is missing, linked or replaced", ErrChanged)
	}
	return nil
}

func (r *Root) Close() {
	if r.releases != nil {
		_ = r.releases.Close()
	}
	if r.releasesFile != nil {
		_ = r.releasesFile.Close()
	}
	if r.home != nil {
		_ = r.home.Close()
	}
}

func (r *Root) Entries() ([]os.DirEntry, error) {
	if err := r.Validate(); err != nil {
		return nil, err
	}
	file, err := r.releases.Open(".")
	if err != nil {
		return nil, err
	}
	defer file.Close()
	entries, err := file.ReadDir(-1)
	if err != nil {
		return nil, err
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	return entries, nil
}

func (r *Root) ReadReceipt(name string) ([]byte, Entry, error) {
	if !safeName(name) {
		return nil, Entry{}, errors.New("invalid release entry name")
	}
	before, err := r.releases.Lstat(name)
	if err != nil {
		return nil, Entry{}, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, Entry{}, fmt.Errorf("%w: release entry is not a directory", ErrChanged)
	}
	dir, err := r.releases.OpenRoot(name)
	if err != nil {
		return nil, Entry{}, err
	}
	defer dir.Close()
	opened, err := dir.Stat(".")
	if err != nil || !sameDirectory(before, opened) {
		return nil, Entry{}, fmt.Errorf("%w: release entry was replaced", ErrChanged)
	}
	fileInfo, err := dir.Lstat("receipt.json")
	if err != nil {
		return nil, Entry{}, err
	}
	if !fileInfo.Mode().IsRegular() || fileInfo.Mode()&os.ModeSymlink != 0 {
		return nil, Entry{}, fmt.Errorf("%w: release receipt is not a regular file", ErrChanged)
	}
	file, err := dir.OpenFile("receipt.json", os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, Entry{}, err
	}
	defer file.Close()
	openedReceipt, err := file.Stat()
	if err != nil || !openedReceipt.Mode().IsRegular() || !os.SameFile(fileInfo, openedReceipt) {
		return nil, Entry{}, fmt.Errorf("%w: release receipt was replaced", ErrChanged)
	}
	const maxReceiptBytes = 1 << 20
	raw, err := io.ReadAll(io.LimitReader(file, maxReceiptBytes+1))
	if err != nil {
		return nil, Entry{}, err
	}
	if len(raw) > maxReceiptBytes {
		return nil, Entry{}, errors.New("release receipt exceeds size limit")
	}
	after, err := r.releases.Lstat(name)
	if err != nil || !sameDirectory(before, after) {
		return nil, Entry{}, fmt.Errorf("%w: release entry changed while reading", ErrChanged)
	}
	afterReceipt, err := dir.Lstat("receipt.json")
	if err != nil || !afterReceipt.Mode().IsRegular() || !os.SameFile(fileInfo, afterReceipt) {
		return nil, Entry{}, fmt.Errorf("%w: release receipt changed while reading", ErrChanged)
	}
	if err := r.Validate(); err != nil {
		return nil, Entry{}, err
	}
	return raw, Entry{Name: name, Identity: before}, nil
}

func safeName(name string) bool {
	return name != "" && name != "." && name != ".." && filepath.Base(name) == name
}

// Claim atomically moves the exact observed entry to a private name. If a
// different entry won the race, it is restored without overwriting a successor
// and never deleted.
func (r *Root) Claim(entry Entry) (*Claim, error) {
	if !safeName(entry.Name) || entry.Identity == nil {
		return nil, errors.New("invalid release retention entry")
	}
	if err := r.Validate(); err != nil {
		return nil, err
	}
	before, err := r.releases.Lstat(entry.Name)
	if err != nil || !sameDirectory(entry.Identity, before) {
		return nil, fmt.Errorf("%w: release entry was replaced", ErrChanged)
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		return nil, err
	}
	name := ".retention-" + hex.EncodeToString(random[:])
	if beforeClaimRename != nil {
		beforeClaimRename()
	}
	if err := renameExclusive(r.releasesFile.Fd(), entry.Name, name); err != nil {
		return nil, fmt.Errorf("claim release entry: %w", err)
	}
	claim := &Claim{root: r, original: entry.Name, name: name, identity: entry.Identity}
	claimed, err := r.releases.Lstat(name)
	if err != nil || !sameDirectory(entry.Identity, claimed) {
		return nil, claim.restoreChanged(fmt.Errorf("%w: claimed release entry differs", ErrChanged), claimed)
	}
	if err := r.Validate(); err != nil {
		return nil, claim.restoreChanged(err, entry.Identity)
	}
	return claim, nil
}

func (c *Claim) restoreChanged(cause error, identity os.FileInfo) error {
	current, err := c.root.releases.Lstat(c.name)
	if err != nil || identity == nil || !os.SameFile(identity, current) {
		return fmt.Errorf("%w; claimed path %s changed and was retained for inspection", cause, c.name)
	}
	if err := renameExclusive(c.root.releasesFile.Fd(), c.name, c.original); err != nil {
		return fmt.Errorf("%w; retained entry %s could not be returned without overwriting another path: %v", cause, c.name, err)
	}
	return cause
}

func (c *Claim) Remove(inventory Inventory, validators ...func() error) error {
	validate := func() error {
		if err := c.root.Validate(); err != nil {
			return err
		}
		for _, check := range validators {
			if err := check(); err != nil {
				return err
			}
		}
		return nil
	}
	paths, err := inventory.expanded()
	if err != nil {
		return c.restoreChanged(err, c.identity)
	}
	if err := validate(); err != nil {
		return c.restoreChanged(err, c.identity)
	}
	info, err := c.root.releases.Lstat(c.name)
	if err != nil || !sameDirectory(c.identity, info) {
		return fmt.Errorf("%w: claimed release directory was replaced", ErrChanged)
	}
	dir, err := c.root.releases.OpenRoot(c.name)
	if err != nil {
		return err
	}
	defer dir.Close()
	opened, err := dir.Stat(".")
	if err != nil || !sameDirectory(c.identity, opened) {
		return fmt.Errorf("%w: claimed release directory changed while opening", ErrChanged)
	}
	if err := validate(); err != nil {
		return c.restoreChanged(err, c.identity)
	}
	if err := verifyInventory(dir, paths, validate); err != nil {
		return c.restoreChanged(err, c.identity)
	}
	if err := removeContents(dir, "", paths, validate); err != nil {
		return fmt.Errorf("remove claimed release contents: %w; retained %s for inspection", err, c.name)
	}
	if err := validate(); err != nil {
		return err
	}
	info, err = c.root.releases.Lstat(c.name)
	if err != nil || !sameDirectory(c.identity, info) {
		return fmt.Errorf("%w: claimed release directory changed during cleanup", ErrChanged)
	}
	if err := c.root.releases.Remove(c.name); err != nil {
		return err
	}
	return c.root.releasesFile.Sync()
}

// Each opened directory stays anchored to its descriptor. Remove never follows
// a final symlink; directories are checked before recursive traversal.
func removeContents(root *os.Root, prefix string, paths map[string]Item, validate func() error) error {
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
		if beforeRemoveEntry != nil {
			beforeRemoveEntry()
		}
		if err := validate(); err != nil {
			return err
		}
		info, err := root.Lstat(entry.Name())
		if err != nil {
			return err
		}
		name := path.Join(prefix, entry.Name())
		expected, ok := paths[name]
		if !ok {
			return fmt.Errorf("release contains unowned path %s", name)
		}
		if expected.Type == "directory" {
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return fmt.Errorf("release directory %s changed type", name)
			}
		} else if err := verifyLeaf(root, entry.Name(), info, expected); err != nil {
			return fmt.Errorf("release ownership path %s: %w", name, err)
		}
		claimed, parent, err := claimChild(root, entry.Name(), info, validate)
		if err != nil {
			return err
		}
		if expected.Type == "directory" {
			child, err := root.OpenRoot(claimed)
			if err != nil {
				parent.Close()
				return err
			}
			opened, statErr := child.Stat(".")
			if statErr != nil || !sameDirectory(info, opened) {
				child.Close()
				parent.Close()
				return fmt.Errorf("%w: nested release directory changed", ErrChanged)
			}
			err = removeContents(child, name, paths, validate)
			child.Close()
			if err != nil {
				parent.Close()
				return err
			}
			current, err := root.Lstat(claimed)
			if err != nil || !sameDirectory(info, current) {
				parent.Close()
				return fmt.Errorf("%w: nested release directory was replaced", ErrChanged)
			}
		} else {
			current, err := root.Lstat(claimed)
			if err != nil || !os.SameFile(info, current) {
				parent.Close()
				return fmt.Errorf("%w: claimed release file changed", ErrChanged)
			}
			if err := verifyLeaf(root, claimed, current, expected); err != nil {
				err = restoreChild(root, parent, claimed, entry.Name(), current, err)
				parent.Close()
				return err
			}
		}
		if err := validate(); err != nil {
			if expected.Type != "directory" {
				err = restoreChild(root, parent, claimed, entry.Name(), info, err)
			}
			parent.Close()
			return err
		}
		if err := root.Remove(claimed); err != nil {
			parent.Close()
			return err
		}
		parent.Close()
	}
	return nil
}

// claimChild moves one observed object without replacing a concurrent writer.
// If the name was substituted at the rename boundary, the observed object is
// returned without overwrite and is never deleted.
func claimChild(root *os.Root, name string, identity os.FileInfo, validate func() error) (string, *os.File, error) {
	parent, err := root.Open(".")
	if err != nil {
		return "", nil, err
	}
	var random [16]byte
	if _, err := rand.Read(random[:]); err != nil {
		parent.Close()
		return "", nil, err
	}
	claimed := ".retention-" + hex.EncodeToString(random[:])
	if beforeChildRename != nil {
		beforeChildRename(name)
	}
	if err := renameExclusive(parent.Fd(), name, claimed); err != nil {
		parent.Close()
		return "", nil, err
	}
	current, err := root.Lstat(claimed)
	if err != nil || !os.SameFile(identity, current) {
		restoreErr := renameExclusive(parent.Fd(), claimed, name)
		parent.Close()
		if restoreErr != nil {
			return "", nil, fmt.Errorf("%w: changed child retained as %s: %v", ErrChanged, claimed, restoreErr)
		}
		return "", nil, fmt.Errorf("%w: release child was replaced", ErrChanged)
	}
	if err := validate(); err != nil {
		restoreErr := renameExclusive(parent.Fd(), claimed, name)
		parent.Close()
		if restoreErr != nil {
			return "", nil, fmt.Errorf("%w: claimed child retained as %s: %v", err, claimed, restoreErr)
		}
		return "", nil, err
	}
	return claimed, parent, nil
}

func restoreChild(root *os.Root, parent *os.File, claimed, original string, identity os.FileInfo, cause error) error {
	current, err := root.Lstat(claimed)
	if err != nil || identity == nil || !os.SameFile(identity, current) {
		return fmt.Errorf("%w; claimed child %s changed and was retained for inspection", cause, claimed)
	}
	if err := renameExclusive(parent.Fd(), claimed, original); err != nil {
		return fmt.Errorf("%w; claimed child %s could not be returned without overwriting another path: %v", cause, claimed, err)
	}
	return cause
}
