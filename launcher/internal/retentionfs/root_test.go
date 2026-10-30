//go:build darwin || linux

package retentionfs

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func testRoot(t *testing.T) (*Root, string, string) {
	t.Helper()
	home := t.TempDir()
	releases := filepath.Join(home, "releases")
	if err := os.Mkdir(releases, 0700); err != nil {
		t.Fatal(err)
	}
	entry := filepath.Join(releases, "stable-owned-0001")
	if err := os.Mkdir(entry, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(entry, "receipt.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(entry, "owned"), []byte("owned bytes"), 0600); err != nil {
		t.Fatal(err)
	}
	homeInfo, err := os.Lstat(home)
	if err != nil {
		t.Fatal(err)
	}
	releaseInfo, err := os.Lstat(releases)
	if err != nil {
		t.Fatal(err)
	}
	root, err := Open(home, homeInfo, releaseInfo)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(root.Close)
	return root, home, releases
}

func testItem(value string) Item {
	digest := sha256.Sum256([]byte(value))
	return Item{Type: "file", SHA256: hex.EncodeToString(digest[:]), SizeBytes: int64(len(value))}
}

func testInventory() Inventory {
	return Inventory{"receipt.json": testItem("{}"), "owned": testItem("owned bytes")}
}

func testEntry(t *testing.T, root *Root) Entry {
	t.Helper()
	_, entry, err := root.ReadReceipt("stable-owned-0001")
	if err != nil {
		t.Fatal(err)
	}
	return entry
}

func assertBytes(t *testing.T, path, want string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil || string(raw) != want {
		t.Fatalf("%s = %q, %v; want %q", path, raw, err, want)
	}
}

func TestOpenRejectsReplacementAfterStoreIdentity(t *testing.T) {
	for _, kind := range []string{"linked", "directory"} {
		t.Run(kind, func(t *testing.T) {
			home := t.TempDir()
			releases := filepath.Join(home, "releases")
			if err := os.Mkdir(releases, 0700); err != nil {
				t.Fatal(err)
			}
			homeInfo, _ := os.Lstat(home)
			releaseInfo, _ := os.Lstat(releases)
			foreign := filepath.Join(t.TempDir(), "foreign")
			if err := os.Mkdir(foreign, 0700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(foreign, "sentinel")
			if err := os.WriteFile(marker, []byte("foreign"), 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.Rename(releases, filepath.Join(home, "original")); err != nil {
				t.Fatal(err)
			}
			if kind == "linked" {
				if err := os.Symlink(foreign, releases); err != nil {
					t.Fatal(err)
				}
			} else if err := os.Rename(foreign, releases); err != nil {
				t.Fatal(err)
			}
			root, err := Open(home, homeInfo, releaseInfo)
			if root != nil {
				root.Close()
			}
			if !errors.Is(err, ErrChanged) {
				t.Fatalf("replacement was accepted: %v", err)
			}
			if kind == "directory" {
				marker = filepath.Join(releases, "sentinel")
			}
			assertBytes(t, marker, "foreign")
		})
	}
}

func TestClaimRestoresEntryReplacedAtRenameBoundary(t *testing.T) {
	for _, kind := range []string{"directory", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			root, home, releases := testRoot(t)
			entry := testEntry(t, root)
			foreign := filepath.Join(t.TempDir(), "foreign")
			if err := os.Mkdir(foreign, 0700); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(foreign, "marker"), []byte("foreign"), 0600); err != nil {
				t.Fatal(err)
			}
			beforeClaimRename = func() {
				beforeClaimRename = nil
				if err := os.Rename(filepath.Join(releases, entry.Name), filepath.Join(home, "original")); err != nil {
					t.Fatal(err)
				}
				if kind == "directory" {
					if err := os.Rename(foreign, filepath.Join(releases, entry.Name)); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Symlink(foreign, filepath.Join(releases, entry.Name)); err != nil {
					t.Fatal(err)
				}
			}
			t.Cleanup(func() { beforeClaimRename = nil })
			claim, err := root.Claim(entry)
			if claim != nil || !errors.Is(err, ErrChanged) {
				t.Fatalf("changed entry accepted: %#v %v", claim, err)
			}
			if kind == "directory" {
				foreign = filepath.Join(releases, entry.Name)
			}
			assertBytes(t, filepath.Join(foreign, "marker"), "foreign")
			assertBytes(t, filepath.Join(home, "original", "owned"), "owned bytes")
			if kind == "symlink" {
				if info, err := os.Lstat(filepath.Join(releases, entry.Name)); err != nil || info.Mode()&os.ModeSymlink == 0 {
					t.Fatalf("foreign link not restored: %v", err)
				}
			}
		})
	}
}

func TestClaimRestoresAfterRootReplacementAtRenameBoundary(t *testing.T) {
	root, _, releases := testRoot(t)
	entry := testEntry(t, root)
	foreign := filepath.Join(t.TempDir(), "moved-releases")
	beforeClaimRename = func() {
		beforeClaimRename = nil
		if err := os.Rename(releases, foreign); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(foreign, releases); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(foreign, entry.Name, "marker"), []byte("foreign"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { beforeClaimRename = nil })
	claim, err := root.Claim(entry)
	if claim != nil || !errors.Is(err, ErrChanged) {
		t.Fatalf("changed root accepted: %#v %v", claim, err)
	}
	assertBytes(t, filepath.Join(foreign, entry.Name, "marker"), "foreign")
	assertBytes(t, filepath.Join(foreign, entry.Name, "owned"), "owned bytes")
}

func TestRemoveRestoresClaimAfterRootReplacement(t *testing.T) {
	root, _, releases := testRoot(t)
	entry := testEntry(t, root)
	claim, err := root.Claim(entry)
	if err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(t.TempDir(), "moved-releases")
	if err := os.Rename(releases, foreign); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreign, releases); err != nil {
		t.Fatal(err)
	}
	if err := claim.Remove(testInventory()); !errors.Is(err, ErrChanged) {
		t.Fatalf("changed root accepted: %v", err)
	}
	assertBytes(t, filepath.Join(foreign, entry.Name, "owned"), "owned bytes")
}

func TestRestoreDoesNotOverwriteNewEntry(t *testing.T) {
	root, _, releases := testRoot(t)
	entry := testEntry(t, root)
	claim, err := root.Claim(entry)
	if err != nil {
		t.Fatal(err)
	}
	replacement := filepath.Join(releases, entry.Name)
	if err := os.Mkdir(replacement, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(replacement, "marker"), []byte("foreign"), 0600); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(t.TempDir(), "moved-releases")
	if err := os.Rename(releases, foreign); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreign, releases); err != nil {
		t.Fatal(err)
	}
	if err := claim.Remove(testInventory()); !errors.Is(err, ErrChanged) {
		t.Fatalf("changed root accepted: %v", err)
	}
	assertBytes(t, filepath.Join(foreign, entry.Name, "marker"), "foreign")
	assertBytes(t, filepath.Join(foreign, claim.name, "owned"), "owned bytes")
}

func TestRemoveRejectsReplacedClaim(t *testing.T) {
	root, home, releases := testRoot(t)
	entry := testEntry(t, root)
	claim, err := root.Claim(entry)
	if err != nil {
		t.Fatal(err)
	}
	owned := filepath.Join(home, "original-claim")
	if err := os.Rename(filepath.Join(releases, claim.name), owned); err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(releases, claim.name)
	if err := os.Mkdir(foreign, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreign, "marker"), []byte("foreign"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := claim.Remove(testInventory()); !errors.Is(err, ErrChanged) {
		t.Fatalf("replacement claim accepted: %v", err)
	}
	assertBytes(t, filepath.Join(foreign, "marker"), "foreign")
	assertBytes(t, filepath.Join(owned, "owned"), "owned bytes")
}

func TestRootReplacementBeforeRecursiveDeletionPreservesClaim(t *testing.T) {
	root, _, releases := testRoot(t)
	entry := testEntry(t, root)
	claim, err := root.Claim(entry)
	if err != nil {
		t.Fatal(err)
	}
	foreign := filepath.Join(t.TempDir(), "moved-releases")
	beforeRemoveEntry = func() {
		beforeRemoveEntry = nil
		if err := os.Rename(releases, foreign); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(foreign, releases); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(foreign, claim.name, "marker"), []byte("foreign"), 0600); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { beforeRemoveEntry = nil })
	if err := claim.Remove(testInventory()); !errors.Is(err, ErrChanged) {
		t.Fatalf("root replacement did not stop deletion: %v", err)
	}
	assertBytes(t, filepath.Join(foreign, claim.name, "marker"), "foreign")
	assertBytes(t, filepath.Join(foreign, claim.name, "owned"), "owned bytes")
}

func TestPruneDoesNotFollowNestedLink(t *testing.T) {
	root, _, releases := testRoot(t)
	foreign := t.TempDir()
	if err := os.WriteFile(filepath.Join(foreign, "marker"), []byte("foreign"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(foreign, filepath.Join(releases, "stable-owned-0001", "link")); err != nil {
		t.Fatal(err)
	}
	entry := testEntry(t, root)
	claim, err := root.Claim(entry)
	if err != nil {
		t.Fatal(err)
	}
	inventory := testInventory()
	inventory["link"] = Item{Type: "symlink", Target: foreign}
	if err := claim.Remove(inventory); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(releases, entry.Name)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("owned release retained: %v", err)
	}
	assertBytes(t, filepath.Join(foreign, "marker"), "foreign")
}

func TestInventoryRefusesUnownedContentsBeforeAnyDeletion(t *testing.T) {
	for _, directory := range []bool{false, true} {
		t.Run(map[bool]string{false: "file", true: "empty-directory"}[directory], func(t *testing.T) {
			root, _, releases := testRoot(t)
			entry := testEntry(t, root)
			marker := filepath.Join(releases, entry.Name, "foreign")
			if directory {
				if err := os.Mkdir(marker, 0o700); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(marker, []byte("foreign"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := root.VerifyEntry(entry, testInventory()); err == nil {
				t.Fatal("unowned content accepted")
			}
			claim, err := root.Claim(entry)
			if err != nil {
				t.Fatal(err)
			}
			if err := claim.Remove(testInventory()); err == nil {
				t.Fatal("unowned content removed")
			}
			assertBytes(t, filepath.Join(releases, entry.Name, "owned"), "owned bytes")
			assertBytes(t, filepath.Join(releases, entry.Name, "receipt.json"), "{}")
			if directory {
				if info, err := os.Lstat(marker); err != nil || !info.IsDir() {
					t.Fatalf("foreign directory was not restored: %v", err)
				}
			} else {
				assertBytes(t, marker, "foreign")
			}
		})
	}
}

func TestChildReplacementAtClaimPreservesForeignContents(t *testing.T) {
	for _, kind := range []string{"file", "symlink"} {
		t.Run(kind, func(t *testing.T) {
			root, home, releases := testRoot(t)
			entry := testEntry(t, root)
			claim, err := root.Claim(entry)
			if err != nil {
				t.Fatal(err)
			}
			claimedDir := filepath.Join(releases, claim.name)
			original := filepath.Join(home, "saved-owned")
			foreign := filepath.Join(t.TempDir(), "foreign")
			if err := os.WriteFile(foreign, []byte("foreign"), 0o600); err != nil {
				t.Fatal(err)
			}
			beforeChildRename = func(name string) {
				if name != "owned" {
					return
				}
				beforeChildRename = nil
				if err := os.Rename(filepath.Join(claimedDir, name), original); err != nil {
					t.Fatal(err)
				}
				if kind == "file" {
					if err := os.Rename(foreign, filepath.Join(claimedDir, name)); err != nil {
						t.Fatal(err)
					}
				} else if err := os.Symlink(foreign, filepath.Join(claimedDir, name)); err != nil {
					t.Fatal(err)
				}
			}
			t.Cleanup(func() { beforeChildRename = nil })
			if err := claim.Remove(testInventory()); !errors.Is(err, ErrChanged) {
				t.Fatalf("changed child was accepted: %v", err)
			}
			assertBytes(t, original, "owned bytes")
			if kind == "file" {
				foreign = filepath.Join(claimedDir, "owned")
			}
			assertBytes(t, foreign, "foreign")
		})
	}
}

func TestForeignFileAddedDuringRemovalIsPreserved(t *testing.T) {
	root, _, releases := testRoot(t)
	entry := testEntry(t, root)
	claim, err := root.Claim(entry)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(releases, claim.name, "foreign")
	beforeRemoveEntry = func() {
		beforeRemoveEntry = nil
		if err := os.WriteFile(marker, []byte("foreign"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { beforeRemoveEntry = nil })
	if err := claim.Remove(testInventory()); err == nil {
		t.Fatal("new foreign file was accepted")
	}
	assertBytes(t, marker, "foreign")
}

func TestRemoveRestoresClaimWhenReferenceAuthorityChanges(t *testing.T) {
	root, _, releases := testRoot(t)
	entry := testEntry(t, root)
	claim, err := root.Claim(entry)
	if err != nil {
		t.Fatal(err)
	}
	referenceErr := errors.New("reference authority changed")
	if err := claim.Remove(testInventory(), func() error { return referenceErr }); !errors.Is(err, referenceErr) {
		t.Fatalf("changed authority did not stop cleanup: %v", err)
	}
	assertBytes(t, filepath.Join(releases, entry.Name, "owned"), "owned bytes")
	assertBytes(t, filepath.Join(releases, entry.Name, "receipt.json"), "{}")
}
