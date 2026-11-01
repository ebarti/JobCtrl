package launcher

import (
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
	"github.com/ebarti/jobctrl/launcher/internal/retentionfs"
)

func TestRetentionPreservesForeignContentsOfSignedRelease(t *testing.T) {
	for _, tc := range []struct {
		name, relative string
		directory      bool
		link           bool
	}{
		{"extra top-level file", "foreign-user-data", false, false},
		{"extra top-level directory", "foreign-empty", true, false},
		{"extra payload file", "payload/launcher/foreign-user-data", false, false},
		{"extra payload directory", "payload/launcher/foreign-empty", true, false},
		{"extra payload link", "payload/launcher/foreign-link", false, true},
		{"changed signed file", "payload/launcher/jobctrl", false, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			public, private, python := retentionSigningKey(t)
			releaseDir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
			if err := os.RemoveAll(releaseDir); err != nil {
				t.Fatal(err)
			}
			fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
			stageSignedRetentionPrior(t, fixture, public, private, python)
			clean := stageSignedRetentionRelease(t, fixture.store.Home, "retention-clean-0007", 7, public, private, python)
			marker := filepath.Join(releaseDir, tc.relative)
			foreignTarget := filepath.Join(t.TempDir(), "foreign-target")
			if tc.directory {
				if err := os.Mkdir(marker, 0o700); err != nil {
					t.Fatal(err)
				}
			} else if tc.link {
				if err := os.WriteFile(foreignTarget, []byte("preserve synthetic data"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(foreignTarget, marker); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(marker, []byte("preserve synthetic data"), 0o600); err != nil {
				t.Fatal(err)
			}
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
				t.Fatal(err)
			}
			if tc.directory {
				if info, err := os.Lstat(marker); err != nil || !info.IsDir() {
					t.Fatalf("foreign directory was removed: %v", err)
				}
			} else if raw, err := os.ReadFile(marker); err != nil || string(raw) != "preserve synthetic data" {
				t.Fatalf("foreign or modified file was removed: %q, %v", raw, err)
			}
			if tc.link {
				if info, err := os.Lstat(marker); err != nil || info.Mode()&os.ModeSymlink == 0 {
					t.Fatalf("foreign link was not preserved: %v", err)
				}
				if raw, err := os.ReadFile(foreignTarget); err != nil || string(raw) != "preserve synthetic data" {
					t.Fatalf("foreign link target was modified: %q, %v", raw, err)
				}
			}
			if _, err := os.Stat(filepath.Join(releaseDir, "receipt.json")); err != nil {
				t.Fatalf("modified release was not preserved: %v", err)
			}
			if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", clean.BuildID)); !os.IsNotExist(err) {
				t.Fatalf("clean unreferenced signed release was not pruned: %v", err)
			}
		})
	}
}

func TestRetentionRechecksAnchoredManifestSignature(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	releaseDir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
	if err := os.RemoveAll(releaseDir); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	homeID, releasesID := fixture.store.RetentionIdentities()
	root, err := retentionfs.Open(fixture.store.Home, homeID, releasesID)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	raw, entry, err := root.ReadReceipt(fixture.prunable.BuildID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := retentionReleaseInventory(root, entry, fixture.prunable, raw); err != nil {
		t.Fatalf("valid signed evidence was not accepted: %v", err)
	}
	marker := filepath.Join(releaseDir, "payload", "manifest.sig")
	if err := os.WriteFile(marker, []byte(`{"foreign":"user data"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := retentionReleaseInventory(root, entry, fixture.prunable, raw); err == nil {
		t.Fatal("changed signature was accepted as release-owned evidence")
	}
	if got, err := os.ReadFile(marker); err != nil || string(got) != `{"foreign":"user data"}` {
		t.Fatalf("changed signature was not preserved: %q, %v", got, err)
	}
}

func TestRetentionForeignReceiptCannotDisplaceSignedPrior(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	for _, receipt := range []release.Receipt{fixture.prior, fixture.prunable} {
		if err := os.RemoveAll(filepath.Join(fixture.store.Home, "releases", receipt.BuildID)); err != nil {
			t.Fatal(err)
		}
		stageSignedRetentionRelease(t, fixture.store.Home, receipt.BuildID, receipt.Sequence, public, private, python)
	}
	decoy := stableRetentionReceipt("retention-foreign-decoy-0020", 20)
	writeRetentionRelease(t, fixture.store.Home, decoy.BuildID, decoy)
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
		t.Fatal(err)
	}
	for _, build := range []string{fixture.prior.BuildID, decoy.BuildID} {
		if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", build)); err != nil {
			t.Errorf("retention removed signed prior or foreign decoy %s: %v", build, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)); !os.IsNotExist(err) {
		t.Errorf("unreferenced older signed release was not pruned: %v", err)
	}
}

func TestRetentionRejectsInconsistentLiveReleaseAuthority(t *testing.T) {
	for _, scenario := range []string{"different build", "different manifest", "external payload"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			public, private, python := retentionSigningKey(t)
			dir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
			if err := os.RemoveAll(dir); err != nil {
				t.Fatal(err)
			}
			fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
			stageSignedRetentionPrior(t, fixture, public, private, python)
			other := otherRetentionInstance(t, fixture, fixture.prunable.BuildID)
			state, err := readState(other.StatePath)
			if err != nil {
				t.Fatal(err)
			}
			state.ManifestSHA256 = fixture.prunable.ManifestSHA256
			switch scenario {
			case "different build":
				state.BuildID = fixture.active.BuildID
			case "different manifest":
				state.ManifestSHA256 = strings.Repeat("f", 64)
			case "external payload":
				state.PayloadRoot = filepath.Join(t.TempDir(), "payload")
			}
			if err := writeState(other.StatePath, state); err != nil {
				t.Fatal(err)
			}
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
				t.Fatal("inconsistent live release authority was accepted")
			}
			if _, err := os.Stat(filepath.Join(dir, "receipt.json")); err != nil {
				t.Fatalf("signed live payload was removed: %v", err)
			}
		})
	}
}

func TestRetentionRefusesUncertainPairBeforePruningSignedRelease(t *testing.T) {
	for _, kind := range []string{"native", "renamed"} {
		for _, scenario := range []string{"malformed", "unreadable", "linked"} {
			t.Run(kind+"/"+scenario, func(t *testing.T) {
				fixture := newRetentionFixture(t)
				public, private, python := retentionSigningKey(t)
				prunableDir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
				if err := os.RemoveAll(prunableDir); err != nil {
					t.Fatal(err)
				}
				fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
				stageSignedRetentionPrior(t, fixture, public, private, python)
				prior, err := readInstalledReceipt(fixture.store.Home, fixture.prior.BuildID)
				if err != nil {
					t.Fatal(err)
				}
				seedLifecycleSQLitePair(t, python, fixture.instance.StateDir, "owned-")
				pair, err := snapshotPair(launchContext{
					Instance:    fixture.instance,
					PayloadRoot: filepath.Join(prunableDir, "payload"),
				}, prior)
				if err != nil {
					t.Fatal(err)
				}
				pairDir := filepath.Join(fixture.instance.StateDir, "backups", pair.ID)
				if kind == "renamed" {
					pair.ID = "renamed-backup"
					renamed := filepath.Join(fixture.instance.StateDir, "backups", pair.ID)
					if err := os.Rename(pairDir, renamed); err != nil {
						t.Fatal(err)
					}
					pairDir = renamed
					if err := writeJSONAtomic(filepath.Join(pairDir, "pair.json"), pair); err != nil {
						t.Fatal(err)
					}
				}
				pairPath := filepath.Join(pairDir, "pair.json")
				pairJSON, err := os.ReadFile(pairPath)
				if err != nil {
					t.Fatal(err)
				}
				pairDigests := lifecycleDatabaseDigests(t, pairDir)
				manifestPath := filepath.Join(prunableDir, "payload", "manifest.json")
				manifest, err := os.ReadFile(manifestPath)
				if err != nil {
					t.Fatal(err)
				}
				switch scenario {
				case "malformed":
					if err := os.WriteFile(pairPath, []byte("{"), 0o600); err != nil {
						t.Fatal(err)
					}
				case "unreadable":
					if err := os.Chmod(pairPath, 0); err != nil {
						t.Fatal(err)
					}
					t.Cleanup(func() { _ = os.Chmod(pairPath, 0o600) })
					if file, err := os.Open(pairPath); err == nil {
						file.Close()
						t.Skip("current user can read mode-000 files")
					}
				case "linked":
					if err := os.Rename(pairPath, pairPath+"-saved"); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(pairPath+"-saved", pairPath); err != nil {
						t.Fatal(err)
					}
				}
				if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
					t.Fatal("uncertain pair authority silently permitted retention")
				}
				if got, err := os.ReadFile(manifestPath); err != nil || !reflect.DeepEqual(got, manifest) {
					t.Fatalf("refused retention changed the signed candidate: %v", err)
				}
				if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
					t.Fatalf("refused retention changed paired backup bytes: got %v want %v", got, pairDigests)
				}
				switch scenario {
				case "malformed":
					if err := os.WriteFile(pairPath, pairJSON, 0o600); err != nil {
						t.Fatal(err)
					}
				case "unreadable":
					if err := os.Chmod(pairPath, 0o600); err != nil {
						t.Fatal(err)
					}
				case "linked":
					if err := os.Remove(pairPath); err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(pairPath+"-saved", pairPath); err != nil {
						t.Fatal(err)
					}
				}
				if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
					t.Fatalf("retention after repairing the pair authority: %v", err)
				}
				if _, err := os.Lstat(prunableDir); !os.IsNotExist(err) {
					t.Fatalf("otherwise eligible unreferenced release was not pruned: %v", err)
				}
				if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
					t.Fatalf("successful retention changed paired backup bytes: got %v want %v", got, pairDigests)
				}
				if got, err := retainedPairForReceipt(fixture.instance.StateDir, prior); err != nil || !reflect.DeepEqual(got, pair) {
					t.Fatalf("successful retention changed paired backup identity: %#v, %v", got, err)
				}
			})
		}
	}
}

func TestRetentionProtectsNonPrefixedRollbackPair(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		alias  bool
		nested bool
	}{
		{name: "renamed pair"},
		{name: "metadata in another directory", alias: true},
		{name: "metadata points to a nested pair", alias: true, nested: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			public, private, python := retentionSigningKey(t)
			prunableDir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
			if err := os.RemoveAll(prunableDir); err != nil {
				t.Fatal(err)
			}
			fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
			stageSignedRetentionPrior(t, fixture, public, private, python)
			unreferenced := stageSignedRetentionRelease(t, fixture.store.Home, "retention-clean-0007", 7, public, private, python)
			if _, err := verifyInstalledReleaseForExecution(fixture.store, fixture.prunable); err != nil {
				t.Fatalf("rollback target was not authenticated and permitted: %v", err)
			}
			seedLifecycleSQLitePair(t, python, fixture.instance.StateDir, "original-")
			ctx := launchContext{Instance: fixture.instance, PayloadRoot: filepath.Join(prunableDir, "payload")}
			pair, err := snapshotPair(ctx, fixture.prunable)
			if err != nil {
				t.Fatal(err)
			}
			backupRoot := filepath.Join(fixture.instance.StateDir, "backups")
			pairDir := filepath.Join(backupRoot, pair.ID)
			pair.ID = "legacy-databases"
			if scenario.nested {
				pair.ID = filepath.Join("container", pair.ID)
				if err := os.Mkdir(filepath.Join(backupRoot, "container"), 0o700); err != nil {
					t.Fatal(err)
				}
			}
			renamed := filepath.Join(backupRoot, pair.ID)
			if err := os.Rename(pairDir, renamed); err != nil {
				t.Fatal(err)
			}
			pairDir = renamed
			if err := os.Remove(filepath.Join(pairDir, "pair.json")); err != nil {
				t.Fatal(err)
			}
			metadataDir := pairDir
			if scenario.alias {
				metadataDir = filepath.Join(backupRoot, "legacy-index")
				if err := os.Mkdir(metadataDir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if err := writeJSONAtomic(filepath.Join(metadataDir, "pair.json"), pair); err != nil {
				t.Fatal(err)
			}
			foreign := filepath.Join(backupRoot, "other-tool")
			if err := os.Mkdir(foreign, 0o700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(foreign, "sentinel")
			if err := os.WriteFile(marker, []byte("foreign backup"), 0o600); err != nil {
				t.Fatal(err)
			}
			pairDigests := lifecycleDatabaseDigests(t, pairDir)
			pairValues := lifecycleDatabaseValues(t, python, pairDir)
			found, err := retainedPairForReceipt(fixture.instance.StateDir, fixture.prunable)
			if err != nil || !reflect.DeepEqual(found, pair) {
				t.Fatalf("rollback reader did not select the non-prefixed pair: %#v, %v", found, err)
			}
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
				t.Fatalf("retain rollback pair: %v", err)
			}
			if _, err := os.Stat(filepath.Join(prunableDir, "receipt.json")); err != nil {
				t.Fatalf("non-prefixed pair's release was pruned: %v", err)
			}
			if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", unreferenced.BuildID)); !os.IsNotExist(err) {
				t.Fatalf("separate unreferenced signed release was not pruned: %v", err)
			}
			if raw, err := os.ReadFile(marker); err != nil || string(raw) != "foreign backup" {
				t.Fatalf("unrelated backup directory changed: %q, %v", raw, err)
			}
			if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
				t.Fatalf("retention changed the backup pair: got %v want %v", got, pairDigests)
			}
			setLifecycleSQLitePair(t, python, fixture.instance.StateDir, "newer-")
			if err := restorePair(ctx, found); err != nil {
				t.Fatalf("restore using the rollback reader's pair ID: %v", err)
			}
			if got := lifecycleDatabaseDigests(t, fixture.instance.StateDir); !reflect.DeepEqual(got, pairDigests) {
				t.Fatalf("restored bytes differ: got %v want %v", got, pairDigests)
			}
			if got := lifecycleDatabaseValues(t, python, fixture.instance.StateDir); !reflect.DeepEqual(got, pairValues) {
				t.Fatalf("restored values differ: got %v want %v", got, pairValues)
			}
		})
	}
}

func TestRetentionRefusesPairCreatedInForeignDirectoryAfterCollection(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	prunableDir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
	if err := os.RemoveAll(prunableDir); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	stageSignedRetentionPrior(t, fixture, public, private, python)
	foreign := filepath.Join(fixture.instance.StateDir, "backups", "other-tool")
	if err := os.MkdirAll(foreign, 0o700); err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(foreign, "sentinel")
	if err := os.WriteFile(marker, []byte("foreign backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	afterRetentionReferenceCollection = func() {
		afterRetentionReferenceCollection = nil
		writeRetentionPair(t, fixture.instance.StateDir, "other-tool", fixture.prunable)
	}
	t.Cleanup(func() { afterRetentionReferenceCollection = nil })
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
		t.Fatal("a pair created in a previously unrelated directory was ignored")
	}
	if _, err := os.Stat(filepath.Join(prunableDir, "receipt.json")); err != nil {
		t.Fatalf("newly referenced release was removed: %v", err)
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "foreign backup" {
		t.Fatalf("unrelated backup data changed: %q, %v", raw, err)
	}
}

func TestRetentionRefusesChangedAliasedPairTarget(t *testing.T) {
	for _, scenario := range []string{"linked target", "replaced after collection"} {
		t.Run(scenario, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			public, private, python := retentionSigningKey(t)
			prunableDir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
			if err := os.RemoveAll(prunableDir); err != nil {
				t.Fatal(err)
			}
			fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
			stageSignedRetentionPrior(t, fixture, public, private, python)
			metadataDir := writeRetentionPair(t, fixture.instance.StateDir, "legacy-index", fixture.active)
			metadataPath := filepath.Join(metadataDir, "pair.json")
			var pair databasePair
			if err := decodeStrictRegular(metadataPath, &pair); err != nil {
				t.Fatal(err)
			}
			pair.ID = "alias-target"
			if err := writeJSONAtomic(metadataPath, pair); err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(fixture.instance.StateDir, "backups", pair.ID)
			foreign := filepath.Join(t.TempDir(), "foreign")
			if err := os.Mkdir(foreign, 0o700); err != nil {
				t.Fatal(err)
			}
			marker := filepath.Join(foreign, "sentinel")
			if err := os.WriteFile(marker, []byte("foreign backup"), 0o600); err != nil {
				t.Fatal(err)
			}
			if scenario == "linked target" {
				if err := os.Symlink(foreign, target); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := os.Mkdir(target, 0o700); err != nil {
					t.Fatal(err)
				}
				afterRetentionReferenceCollection = func() {
					afterRetentionReferenceCollection = nil
					if err := os.Rename(target, target+"-saved"); err != nil {
						t.Fatal(err)
					}
					if err := os.Symlink(foreign, target); err != nil {
						t.Fatal(err)
					}
				}
				t.Cleanup(func() { afterRetentionReferenceCollection = nil })
			}
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
				t.Fatal("unverifiable aliased pair target permitted cleanup")
			}
			if _, err := os.Stat(filepath.Join(prunableDir, "receipt.json")); err != nil {
				t.Fatalf("uncertain target removed an unreferenced release: %v", err)
			}
			if raw, err := os.ReadFile(marker); err != nil || string(raw) != "foreign backup" {
				t.Fatalf("foreign target changed: %q, %v", raw, err)
			}
		})
	}
}

func TestRetentionRefusesChangedBackupDirectoryAuthority(t *testing.T) {
	for _, when := range []string{"after listing", "after collection", "metadata rewrite"} {
		t.Run(when, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			public, private, python := retentionSigningKey(t)
			dir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
			if err := os.RemoveAll(dir); err != nil {
				t.Fatal(err)
			}
			fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
			stageSignedRetentionPrior(t, fixture, public, private, python)
			seedLifecycleSQLitePair(t, python, fixture.instance.StateDir, "synthetic-")
			ctx := launchContext{Instance: fixture.instance, PayloadRoot: filepath.Join(dir, "payload")}
			pair, err := snapshotPair(ctx, fixture.prunable)
			if err != nil {
				t.Fatal(err)
			}
			pairDir := filepath.Join(fixture.instance.StateDir, "backups", pair.ID)
			saved := filepath.Join(t.TempDir(), "saved-pair")
			before := lifecycleDatabaseDigests(t, pairDir)
			metadataPath := filepath.Join(pairDir, "pair.json")
			metadata, err := os.ReadFile(metadataPath)
			if err != nil {
				t.Fatal(err)
			}
			swap := func() {
				if err := os.Rename(pairDir, saved); err != nil {
					t.Fatal(err)
				}
				writeRetentionPair(t, fixture.instance.StateDir, pair.ID, fixture.active)
			}
			if when == "after listing" {
				afterRetentionReferenceListing = func(label string) {
					if label == "backups" {
						afterRetentionReferenceListing = nil
						swap()
					}
				}
			} else if when == "after collection" {
				afterRetentionReferenceCollection = func() {
					afterRetentionReferenceCollection = nil
					swap()
					if err := os.RemoveAll(pairDir); err != nil {
						t.Fatal(err)
					}
					if err := os.Rename(saved, pairDir); err != nil {
						t.Fatal(err)
					}
				}
			} else {
				afterRetentionReferenceCollection = func() {
					afterRetentionReferenceCollection = nil
					changed := append([]byte{}, metadata...)
					changed[0] = ' '
					if err := os.WriteFile(metadataPath, changed, 0o600); err != nil {
						t.Fatal(err)
					}
					if err := os.WriteFile(metadataPath, metadata, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			t.Cleanup(func() { afterRetentionReferenceListing, afterRetentionReferenceCollection = nil, nil })
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
				t.Fatal("changed reference authority was accepted")
			}
			if when == "after listing" {
				if err := os.RemoveAll(pairDir); err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(saved, pairDir); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := os.Stat(filepath.Join(dir, "receipt.json")); err != nil {
				t.Fatalf("backup's signed release was removed: %v", err)
			}
			after := lifecycleDatabaseDigests(t, pairDir)
			if !reflect.DeepEqual(before, after) {
				t.Fatalf("backup pair changed: before %v, after %v", before, after)
			}
			var restored databasePair
			if err := decodeStrictRegular(filepath.Join(pairDir, "pair.json"), &restored); err != nil || restored.ReleaseReceipt != fixture.prunable {
				t.Fatalf("backup release binding changed: %#v, %v", restored.ReleaseReceipt, err)
			}
		})
	}
}

func TestRetentionRefusesBackupRootCreatedAfterCollection(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	dir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	stageSignedRetentionPrior(t, fixture, public, private, python)
	afterRetentionReferenceCollection = func() {
		afterRetentionReferenceCollection = nil
		writeRetentionPair(t, fixture.instance.StateDir, "pair-new-reference", fixture.prunable)
	}
	t.Cleanup(func() { afterRetentionReferenceCollection = nil })
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
		t.Fatal("new backup authority was ignored")
	}
	if _, err := os.Stat(filepath.Join(dir, "receipt.json")); err != nil {
		t.Fatalf("newly referenced release was removed: %v", err)
	}
}

func TestRetentionRefusesChangedRuntimeReference(t *testing.T) {
	for _, name := range []string{release.ActiveFile, release.JournalFile, "channel-stable.json"} {
		t.Run(name, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			public, private, python := retentionSigningKey(t)
			dir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
			if err := os.RemoveAll(dir); err != nil {
				t.Fatal(err)
			}
			fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
			stageSignedRetentionPrior(t, fixture, public, private, python)
			path := filepath.Join(fixture.store.Home, name)
			raw, err := os.ReadFile(path)
			if err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if len(raw) == 0 {
				raw = []byte(`{}`)
			}
			afterRetentionReferenceCollection = func() {
				afterRetentionReferenceCollection = nil
				if err := os.WriteFile(path, raw, 0o600); err != nil {
					t.Fatal(err)
				}
			}
			t.Cleanup(func() { afterRetentionReferenceCollection = nil })
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
				t.Fatal("changed runtime authority was accepted")
			}
			if _, err := os.Stat(filepath.Join(dir, "receipt.json")); err != nil {
				t.Fatalf("release was removed after authority change: %v", err)
			}
		})
	}
}

func TestRetentionRefusesChangedInstanceDirectoryAuthority(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	dir := filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)
	if err := os.RemoveAll(dir); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	stageSignedRetentionPrior(t, fixture, public, private, python)
	other := otherRetentionInstance(t, fixture, fixture.prunable.BuildID)
	state, err := readState(other.StatePath)
	if err != nil {
		t.Fatal(err)
	}
	state.ManifestSHA256 = fixture.prunable.ManifestSHA256
	if err := writeState(other.StatePath, state); err != nil {
		t.Fatal(err)
	}
	saved := filepath.Join(t.TempDir(), "saved-instance")
	afterRetentionReferenceListing = func(label string) {
		if label != "instances" {
			return
		}
		afterRetentionReferenceListing = nil
		if err := os.Rename(other.Dir, saved); err != nil {
			t.Fatal(err)
		}
		if err := os.Mkdir(other.Dir, 0o700); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() { afterRetentionReferenceListing = nil })
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
		t.Fatal("changed instance authority was accepted")
	}
	if err := os.Remove(other.Dir); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(saved, other.Dir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dir, "receipt.json")); err != nil {
		t.Fatalf("live instance release was removed: %v", err)
	}
}

func TestRetentionUnrecordedSequenceCannotDisplaceSignedPrior(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	for _, receipt := range []release.Receipt{fixture.prior, fixture.prunable} {
		if err := os.RemoveAll(filepath.Join(fixture.store.Home, "releases", receipt.BuildID)); err != nil {
			t.Fatal(err)
		}
		stageSignedRetentionRelease(t, fixture.store.Home, receipt.BuildID, receipt.Sequence, public, private, python)
	}
	clean := stageSignedRetentionRelease(t, fixture.store.Home, "retention-clean-0005", 5, public, private, python)
	for _, receipt := range []release.Receipt{fixture.prior, fixture.prunable, clean} {
		installed, err := readInstalledReceipt(fixture.store.Home, receipt.BuildID)
		if err != nil {
			t.Fatal(err)
		}
		policy, err := fixture.store.ReadChannelState("stable")
		if err != nil {
			t.Fatal(err)
		}
		key := strconv.FormatUint(installed.Sequence, 10)
		policy.SequenceBuildIDs[key] = installed.BuildID
		policy.SequenceDescriptors[key] = installed.DescriptorSHA256
		if policy.MaxSequence < installed.Sequence {
			policy.MaxSequence = installed.Sequence
		}
		if err := fixture.store.CommitMetadata(policy); err != nil {
			t.Fatal(err)
		}
	}
	altered, err := readInstalledReceipt(fixture.store.Home, fixture.prunable.BuildID)
	if err != nil {
		t.Fatal(err)
	}
	policy, err := readInstalledPolicy(fixture.store.Home, altered)
	if err != nil {
		t.Fatal(err)
	}
	altered.Sequence = 20
	policy.Sequence = 20
	altered.PolicySHA256 = lifecyclePolicyDigest(t, policy)
	if err := writeJSONAtomic(filepath.Join(fixture.store.Home, "releases", altered.BuildID, "policy.json"), policy); err != nil {
		t.Fatal(err)
	}
	writeRetentionRelease(t, fixture.store.Home, altered.BuildID, altered)
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
		t.Fatal(err)
	}
	for _, build := range []string{fixture.prior.BuildID, altered.BuildID} {
		if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", build)); err != nil {
			t.Errorf("retention removed signed prior or unrecorded release %s: %v", build, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", clean.BuildID)); !os.IsNotExist(err) {
		t.Errorf("recorded older unreferenced release was not pruned: %v", err)
	}
}

func TestRetentionPreservesSignedReleaseWithoutRecordedSequence(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	for _, receipt := range []release.Receipt{fixture.prior, fixture.prunable} {
		if err := os.RemoveAll(filepath.Join(fixture.store.Home, "releases", receipt.BuildID)); err != nil {
			t.Fatal(err)
		}
		stageSignedRetentionRelease(t, fixture.store.Home, receipt.BuildID, receipt.Sequence, public, private, python)
	}
	clean := stageSignedRetentionRelease(t, fixture.store.Home, "retention-clean-0005", 5, public, private, python)
	policy, err := fixture.store.ReadChannelState("stable")
	if err != nil {
		t.Fatal(err)
	}
	delete(policy.SequenceBuildIDs, fmt.Sprintf("%d", fixture.prunable.Sequence))
	delete(policy.SequenceDescriptors, fmt.Sprintf("%d", fixture.prunable.Sequence))
	if err := fixture.store.CommitMetadata(policy); err != nil {
		t.Fatal(err)
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID, "receipt.json")); err != nil {
		t.Fatalf("release without recorded sequence was removed: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", clean.BuildID)); !os.IsNotExist(err) {
		t.Fatalf("recorded unreferenced release was not pruned: %v", err)
	}
}
