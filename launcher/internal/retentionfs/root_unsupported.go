//go:build !darwin && !linux

// Package retentionfs refuses pruning where descriptor-anchored, exclusive
// release claims are not implemented.
package retentionfs

import (
	"errors"
	"os"
)

var ErrChanged = errors.New("release retention authority changed")
var errUnsupported = errors.New("race-safe release retention is unavailable on this platform")

type Root struct{}
type Entry struct {
	Name     string
	Identity os.FileInfo
}
type Claim struct{}
type Item struct {
	Type      string
	SHA256    string
	SizeBytes int64
	Mode      os.FileMode
	CheckMode bool
	Target    string
}
type Inventory map[string]Item

func Open(string, os.FileInfo, os.FileInfo) (*Root, error)  { return nil, errUnsupported }
func (*Root) Validate() error                               { return errUnsupported }
func (*Root) Close()                                        {}
func (*Root) Entries() ([]os.DirEntry, error)               { return nil, errUnsupported }
func (*Root) ReadReceipt(string) ([]byte, Entry, error)     { return nil, Entry{}, errUnsupported }
func (*Root) ReadFile(Entry, string, int64) ([]byte, error) { return nil, errUnsupported }
func (*Root) VerifyEntry(Entry, Inventory) error            { return errUnsupported }
func (*Root) Claim(Entry) (*Claim, error)                   { return nil, errUnsupported }
func (*Claim) Remove(Inventory, ...func() error) error      { return errUnsupported }
