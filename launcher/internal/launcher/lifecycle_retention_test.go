package launcher

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// Exercise the actual stable-promotion and explicit-rollback paths with real
// paired SQLite snapshots, but no running services or personal workspace.
func TestRetentionProtectsWorkspacePairAcrossStablePromotions(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	oldStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = oldStart })

	for _, scenario := range []struct {
		name   string
		custom bool
		rename bool
	}{
		{name: "default workspace"},
		{name: "custom JOBCTRL_DIR", custom: true},
		{name: "custom JOBCTRL_DIR with renamed pair", custom: true, rename: true},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			home := t.TempDir()
			env := []string{"HOME=" + home}
			if scenario.custom {
				env = append(env, "JOBCTRL_DIR="+filepath.Join(home, "custom-workspace"))
			}
			inst, err := resolveInstance(env)
			if err != nil {
				t.Fatal(err)
			}
			if inst.StateDir == inst.RuntimeHome || inst.Dir == inst.StateDir {
				t.Fatal("fixture did not resolve independent runtime and workspace roots")
			}
			store, err := release.Open(inst.RuntimeHome)
			if err != nil {
				t.Fatal(err)
			}
			ctx := launchContext{Instance: inst, Environment: env}
			fixtures := make([]homebrewBootstrapFixture, 4)
			for i := range fixtures {
				fixtures[i] = newSignedHomebrewBootstrapFixture(t, private, fmt.Sprintf("retention-stable-%04d", i+1), uint64(i+1), 1, python)
				// Bind the permissive rollback floor into the signed descriptor,
				// saved policy, and immutable receipt rather than fabricating policy.
				allowOldRetentionRollback(t, &fixtures[i], private)
				if err := verifyHomebrewFixtureDescriptor(public, fixtures[i]); err != nil {
					t.Fatalf("authenticate fixture descriptor: %v", err)
				}
			}
			if err := stageHomebrewFixture(inst.RuntimeHome, fixtures[0], public); err != nil {
				t.Fatal(err)
			}
			if _, err := store.WriteSelectedActive(fixtures[0].receipt, 0, fixtures[0].buildID, "homebrew"); err != nil {
				t.Fatal(err)
			}
			initial := fixtures[0].receipt
			if _, err := store.RecordMetadata("stable", initial.Sequence, 1, initial.BuildID, initial.DescriptorSHA256, nil); err != nil {
				t.Fatal(err)
			}
			verified, err := verifyInstalledReleaseForExecution(store, fixtures[0].receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(inst.RuntimeHome, verified); err != nil {
				t.Fatal(err)
			}
			seedLifecycleSQLitePair(t, python, inst.StateDir, "original-")
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
				if receipt != fixtures[0].receipt {
					setLifecycleSQLitePair(t, python, inst.StateDir, receipt.BuildID+"-")
				}
				return nil
			}
			var targetPair databasePair
			var targetDigests, targetValues map[string]string
			for i := 1; i < len(fixtures); i++ {
				if err := stageHomebrewFixture(inst.RuntimeHome, fixtures[i], public); err != nil {
					t.Fatal(err)
				}
				active, err := store.ReadActive()
				if err != nil {
					t.Fatal(err)
				}
				if err := promoteExisting(ctx, store, active, fixtures[i].buildID, "update", io.Discard); err != nil {
					t.Fatalf("promotion %d: %v", i, err)
				}
				if i == 2 {
					unreferencedPair, err := retainedPairForReceipt(inst.StateDir, fixtures[1].receipt)
					if err != nil {
						t.Fatal(err)
					}
					// This fixture owns the pair. Removing it makes the second
					// release an unreferenced control for the next promotion.
					if err := os.RemoveAll(filepath.Join(inst.StateDir, "backups", unreferencedPair.ID)); err != nil {
						t.Fatal(err)
					}
				}
				if i == 1 {
					targetPair, err = retainedPairForReceipt(inst.StateDir, fixtures[0].receipt)
					if err != nil {
						t.Fatal(err)
					}
					pairDir := filepath.Join(inst.StateDir, "backups", targetPair.ID)
					if scenario.rename {
						targetPair.ID = "renamed-rollback"
						renamed := filepath.Join(inst.StateDir, "backups", targetPair.ID)
						if err := os.Rename(pairDir, renamed); err != nil {
							t.Fatal(err)
						}
						pairDir = renamed
						if err := writeJSONAtomic(filepath.Join(pairDir, "pair.json"), targetPair); err != nil {
							t.Fatal(err)
						}
					}
					targetDigests = lifecycleDatabaseDigests(t, pairDir)
					targetValues = lifecycleDatabaseValues(t, python, pairDir)
				}
			}
			policy, err := store.ReadChannelState("stable")
			if err != nil || policy.SequenceBuildIDs["1"] != fixtures[0].buildID || policy.SequenceDescriptors["1"] != fixtures[0].receipt.DescriptorSHA256 {
				t.Fatalf("oldest sequence not recorded: %#v, %v", policy, err)
			}
			if _, err := os.Lstat(filepath.Join(store.Home, "releases", fixtures[1].buildID)); !os.IsNotExist(err) {
				t.Fatalf("unreferenced older signed release was not pruned: %v", err)
			}
			if err := store.Permit(fixtures[0].receipt); err != nil {
				t.Fatalf("oldest rollback target unexpectedly ineligible: %v", err)
			}
			installed, err := readInstalledReceipt(store.Home, fixtures[0].buildID)
			if err != nil || installed != fixtures[0].receipt {
				t.Fatalf("oldest backup's release was not retained: %#v, %v", installed, err)
			}
			pair, err := retainedPairForReceipt(inst.StateDir, fixtures[0].receipt)
			if err != nil || !reflect.DeepEqual(pair, targetPair) {
				t.Fatalf("rollback pair identity changed: %#v, %v", pair, err)
			}
			var output bytes.Buffer
			if err := Run(filepath.Join(inst.RuntimeHome, "bin", "jobctrl"), []string{"rollback", "--to", fixtures[0].buildID}, env, &output, io.Discard); err != nil {
				t.Fatalf("explicit rollback to retained pair: %v", err)
			}
			if !strings.Contains(output.String(), "rolled back to "+fixtures[0].buildID) {
				t.Fatalf("rollback did not report its selected release: %q", output.String())
			}
			active, err := store.ReadActive()
			if err != nil || active.Receipt != fixtures[0].receipt {
				t.Fatalf("rollback selected wrong release: %#v, %v", active, err)
			}
			journal, err := store.ReadJournal()
			if err != nil || journal.TargetBackupID != targetPair.ID {
				t.Fatalf("rollback selected wrong pair: %#v, %v", journal, err)
			}
			if got := lifecycleDatabaseDigests(t, inst.StateDir); !reflect.DeepEqual(got, targetDigests) {
				t.Fatalf("rollback did not restore exact backup bytes: got %v want %v", got, targetDigests)
			}
			if got := lifecycleDatabaseValues(t, python, inst.StateDir); !reflect.DeepEqual(got, targetValues) {
				t.Fatalf("rollback restored wrong pair contents: got %v want %v", got, targetValues)
			}
		})
	}
}

func allowOldRetentionRollback(t *testing.T, fixture *homebrewBootstrapFixture, private ed25519.PrivateKey) {
	t.Helper()
	var descriptor map[string]any
	if err := json.Unmarshal(fixture.descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	descriptor["minimumSafeSequence"] = 1
	raw, err := json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(raw)
	fixture.descriptorRaw = raw
	fixture.descriptorSHA256 = hex.EncodeToString(digest[:])
	fixture.receipt.DescriptorSHA256 = fixture.descriptorSHA256
	fixture.policy.Minimum = 1
	fixture.policy.DescriptorDigest = fixture.descriptorSHA256
	fixture.receipt.PolicySHA256 = lifecyclePolicyDigest(t, fixture.policy)
	signature := homebrewFixtureSignature{SchemaVersion: 1, Status: "signed", Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:release-descriptor:v1\x00", raw)))}
	fixture.signatureRaw, err = json.Marshal(signature)
	if err != nil {
		t.Fatal(err)
	}
}

type retentionFixture struct {
	instance instance
	store    *release.Store
	active   release.Receipt
	prior    release.Receipt
	prunable release.Receipt
}

func newRetentionFixture(t *testing.T) retentionFixture {
	t.Helper()
	return newRetentionFixtureAt(t, t.TempDir())
}

func newRetentionFixtureAt(t *testing.T, home string) retentionFixture {
	t.Helper()
	inst, err := resolveInstance([]string{"HOME=" + home})
	if err != nil {
		t.Fatal(err)
	}
	store, err := release.Open(inst.RuntimeHome)
	if err != nil {
		t.Fatal(err)
	}
	fixture := retentionFixture{
		instance: inst,
		store:    store,
		active:   stableRetentionReceipt("retention-active-0021", 21),
		prior:    stableRetentionReceipt("retention-prior-0019", 19),
		prunable: stableRetentionReceipt("retention-prune-0006", 6),
	}
	for _, receipt := range []release.Receipt{fixture.active, fixture.prior, fixture.prunable} {
		writeRetentionRelease(t, store.Home, receipt.BuildID, receipt)
	}
	if _, err := store.WriteSelectedActive(fixture.active, 0, fixture.active.BuildID, "homebrew"); err != nil {
		t.Fatal(err)
	}
	return fixture
}

func stableRetentionReceipt(build string, sequence uint64) release.Receipt {
	receipt := lifecycleReceipt(build, "homebrew", sequence)
	receipt.Channel = "stable"
	return receipt
}

func retentionSigningKey(t *testing.T) (ed25519.PublicKey, ed25519.PrivateKey, string) {
	t.Helper()
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	setSignedHomebrewTrust(t, public)
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	return public, private, python
}

func stageSignedRetentionRelease(t *testing.T, home, build string, sequence uint64, public ed25519.PublicKey, private ed25519.PrivateKey, python string) release.Receipt {
	t.Helper()
	fixture := newSignedHomebrewBootstrapFixture(t, private, build, sequence, 1, python)
	allowOldRetentionRollback(t, &fixture, private)
	if err := verifyHomebrewFixtureDescriptor(public, fixture); err != nil {
		t.Fatal(err)
	}
	if err := stageHomebrewFixture(home, fixture, public); err != nil {
		t.Fatal(err)
	}
	store, err := release.Open(home)
	if err != nil {
		t.Fatal(err)
	}
	state, err := store.ReadChannelState("stable")
	if err != nil {
		t.Fatal(err)
	}
	key := fmt.Sprintf("%d", fixture.receipt.Sequence)
	state.SequenceBuildIDs[key] = fixture.receipt.BuildID
	state.SequenceDescriptors[key] = fixture.receipt.DescriptorSHA256
	if state.MaxSequence < fixture.receipt.Sequence {
		state.MaxSequence = fixture.receipt.Sequence
	}
	if err := store.CommitMetadata(state); err != nil {
		t.Fatal(err)
	}
	return fixture.receipt
}

func stageSignedRetentionPrior(t *testing.T, fixture retentionFixture, public ed25519.PublicKey, private ed25519.PrivateKey, python string) {
	t.Helper()
	if err := os.RemoveAll(filepath.Join(fixture.store.Home, "releases", fixture.prior.BuildID)); err != nil {
		t.Fatal(err)
	}
	stageSignedRetentionRelease(t, fixture.store.Home, fixture.prior.BuildID, fixture.prior.Sequence, public, private, python)
}

func writeRetentionRelease(t *testing.T, home, directory string, receipt release.Receipt) {
	t.Helper()
	path := filepath.Join(home, "releases", directory)
	if err := os.MkdirAll(path, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(path, "receipt.json"), selectorReceipt{SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel, Sequence: int64(receipt.Sequence), ArtifactSHA256: receipt.ArtifactSHA256, ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256, PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt}); err != nil {
		t.Fatal(err)
	}
}

func writeRetentionPair(t *testing.T, stateDir, id string, receipt release.Receipt) string {
	t.Helper()
	directory := filepath.Join(stateDir, "backups", id)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	pair := databasePair{SchemaVersion: 1, ID: id, ReleaseReceipt: receipt, CreatedAt: time.Now().UTC(), Files: []databaseFile{
		{Name: "jobctrl.db", SHA256: strings.Repeat("a", 64), SizeBytes: 1},
		{Name: "temporal.db", SHA256: strings.Repeat("b", 64), SizeBytes: 1},
	}}
	if err := writeJSONAtomic(filepath.Join(directory, "pair.json"), pair); err != nil {
		t.Fatal(err)
	}
	return directory
}

func otherRetentionInstance(t *testing.T, fixture retentionFixture, build string) instance {
	t.Helper()
	inst, err := resolveInstance([]string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + fixture.instance.RuntimeHome, "JOBCTRL_DIR=" + filepath.Join(t.TempDir(), "other-workspace")})
	if err != nil {
		t.Fatal(err)
	}
	state := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: inst.ID, CanonicalStateDir: inst.StateDir, PayloadRoot: filepath.Join(fixture.store.Home, "releases", build, "payload"), BuildID: build, ManifestSHA256: strings.Repeat("b", 64), Components: map[string]componentRecord{}, Supervisor: componentRecord{PID: os.Getpid(), PGID: os.Getpid(), StartIdentity: "synthetic", Executable: "/synthetic"}}
	if err := writeState(inst.StatePath, state); err != nil {
		t.Fatal(err)
	}
	return inst
}

func duplicateRetentionField(t *testing.T, path, key string) {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	needle := []byte(`"` + key + `":`)
	replacement := []byte(`"` + key + `":0,"` + key + `":`)
	modified := bytes.Replace(raw, needle, replacement, 1)
	if bytes.Equal(raw, modified) {
		t.Fatalf("field %s was not present in fixture", key)
	}
	if err := os.WriteFile(path, modified, 0o600); err != nil {
		t.Fatal(err)
	}
}

func TestRetentionCollectsAllOwnedReferencesBeforePruning(t *testing.T) {
	fixture := newRetentionFixture(t)
	public, private, python := retentionSigningKey(t)
	if err := os.RemoveAll(filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)); err != nil {
		t.Fatal(err)
	}
	fixture.prunable = stageSignedRetentionRelease(t, fixture.store.Home, fixture.prunable.BuildID, fixture.prunable.Sequence, public, private, python)
	stageSignedRetentionPrior(t, fixture, public, private, python)
	controller := stableRetentionReceipt("retention-controller-0001", 1)
	old := stableRetentionReceipt("retention-journal-old-0002", 2)
	candidate := stableRetentionReceipt("retention-journal-new-0003", 3)
	referenced := stageSignedRetentionRelease(t, fixture.store.Home, "retention-other-pair-0004", 4, public, private, python)
	live := stableRetentionReceipt("retention-live-0005", 5)
	local := lifecycleReceipt("retention-local-0007", "local", 7)
	pre := lifecycleReceipt("retention-prerelease-0008", "local", 8)
	pre.Channel = "prerelease"
	for _, receipt := range []release.Receipt{controller, old, candidate, live, local, pre} {
		writeRetentionRelease(t, fixture.store.Home, receipt.BuildID, receipt)
	}
	if _, err := fixture.store.WriteSelectedActive(fixture.active, 1, controller.BuildID, "homebrew"); err != nil {
		t.Fatal(err)
	}
	journal, err := fixture.store.Begin("update", &old, &candidate, candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := fixture.store.Advance(&journal, release.Promoted, nil); err != nil {
		t.Fatal(err)
	}
	other := otherRetentionInstance(t, fixture, live.BuildID)
	seedLifecycleSQLitePair(t, python, other.StateDir, "other-workspace-")
	pair, err := snapshotPair(launchContext{
		Instance:    other,
		PayloadRoot: filepath.Join(fixture.store.Home, "releases", referenced.BuildID, "payload"),
	}, referenced)
	if err != nil {
		t.Fatal(err)
	}
	pairDir := filepath.Join(other.StateDir, "backups", pair.ID)
	pairDigests := lifecycleDatabaseDigests(t, pairDir)
	policy, err := fixture.store.ReadChannelState("stable")
	if err != nil || policy.SequenceBuildIDs["4"] != referenced.BuildID || policy.SequenceDescriptors["4"] != referenced.DescriptorSHA256 {
		t.Fatalf("other workspace's release is not recorded in channel state: %#v, %v", policy, err)
	}
	if _, err := verifyInstalledReleaseForExecution(fixture.store, referenced); err != nil {
		t.Fatalf("other workspace's release is not authenticated: %v", err)
	}
	foreignDir := filepath.Join(fixture.store.Home, "releases", "foreign-release-0020")
	foreignReceipt := stableRetentionReceipt("foreign-claimed-0020", 20)
	writeRetentionRelease(t, fixture.store.Home, filepath.Base(foreignDir), foreignReceipt)
	foreignState := filepath.Join(fixture.store.Home, "instances", "foreign-instance")
	if err := os.MkdirAll(foreignState, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreignState, "state.json"), []byte("foreign"), 0o600); err != nil {
		t.Fatal(err)
	}
	foreignBackup := filepath.Join(other.StateDir, "backups", "other-tool")
	if err := os.MkdirAll(foreignBackup, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(foreignBackup, "sentinel"), []byte("foreign backup"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
		t.Fatal(err)
	}
	for _, receipt := range []release.Receipt{fixture.active, fixture.prior, controller, old, candidate, referenced, live, local, pre} {
		if _, err := os.Stat(filepath.Join(fixture.store.Home, "releases", receipt.BuildID)); err != nil {
			t.Errorf("protected release %s was removed: %v", receipt.BuildID, err)
		}
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", fixture.prunable.BuildID)); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("unreferenced stable release was not pruned: %v", err)
	}
	retained, err := retainedPairForReceipt(other.StateDir, referenced)
	if err != nil || !reflect.DeepEqual(retained, pair) {
		t.Fatalf("other workspace's paired backup changed: %#v, %v", retained, err)
	}
	if got := lifecycleDatabaseDigests(t, pairDir); !reflect.DeepEqual(got, pairDigests) {
		t.Fatalf("other workspace's pair bytes changed: got %v want %v", got, pairDigests)
	}
	for _, path := range []string{foreignDir, foreignState, foreignBackup, pairDir} {
		if _, err := os.Stat(path); err != nil {
			t.Errorf("foreign or backup state was removed: %s: %v", path, err)
		}
	}
	// The paired backup is the only remaining reference to this signed release.
	// Remove this test-owned pair to prove it was the reason for preservation.
	if err := os.RemoveAll(pairDir); err != nil {
		t.Fatal(err)
	}
	if err := retainReleases(fixture.store, fixture.instance.StateDir); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", referenced.BuildID)); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("release remained after its only backup reference was removed: %v", err)
	}
}

func TestRetentionRefusesUncertainAuthoritiesBeforeDeletingAnything(t *testing.T) {
	for _, scenario := range []struct {
		name  string
		setup func(*testing.T, retentionFixture)
	}{
		{name: "unreadable pair", setup: func(t *testing.T, f retentionFixture) {
			path := filepath.Join(writeRetentionPair(t, f.instance.StateDir, "pair-unreadable", f.prunable), "pair.json")
			if err := os.Chmod(path, 0); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(path, 0o600) })
			if file, err := os.Open(path); err == nil {
				file.Close()
				t.Skip("current user can read mode-000 files")
			}
		}},
		{name: "malformed pair JSON", setup: func(t *testing.T, f retentionFixture) {
			path := filepath.Join(writeRetentionPair(t, f.instance.StateDir, "pair-malformed", f.prunable), "pair.json")
			if err := os.WriteFile(path, []byte("{"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "duplicate pair field", setup: func(t *testing.T, f retentionFixture) {
			path := filepath.Join(writeRetentionPair(t, f.instance.StateDir, "pair-duplicate", f.prunable), "pair.json")
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			raw = bytes.Replace(raw, []byte(`"schemaVersion":1`), []byte(`"schemaVersion":1,"schemaVersion":1`), 1)
			if err := os.WriteFile(path, raw, 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "incorrect pair identity", setup: func(t *testing.T, f retentionFixture) {
			dir := writeRetentionPair(t, f.instance.StateDir, "pair-identity", f.prunable)
			var pair databasePair
			if err := decodeStrictRegular(filepath.Join(dir, "pair.json"), &pair); err != nil {
				t.Fatal(err)
			}
			pair.ID = "pair-different"
			if err := writeJSONAtomic(filepath.Join(dir, "pair.json"), pair); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "invalid pair receipt", setup: func(t *testing.T, f retentionFixture) {
			receipt := f.prunable
			receipt.BuildID = ""
			writeRetentionPair(t, f.instance.StateDir, "pair-invalid", receipt)
		}},
		{name: "incomplete pair manifest", setup: func(t *testing.T, f retentionFixture) {
			dir := writeRetentionPair(t, f.instance.StateDir, "pair-incomplete", f.prunable)
			var pair databasePair
			if err := decodeStrictRegular(filepath.Join(dir, "pair.json"), &pair); err != nil {
				t.Fatal(err)
			}
			pair.Files[1].Name = pair.Files[0].Name
			if err := writeJSONAtomic(filepath.Join(dir, "pair.json"), pair); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "missing pair metadata", setup: func(t *testing.T, f retentionFixture) {
			path := filepath.Join(writeRetentionPair(t, f.instance.StateDir, "pair-missing", f.prunable), "pair.json")
			if err := os.Remove(path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "linked pair metadata", setup: func(t *testing.T, f retentionFixture) {
			path := filepath.Join(writeRetentionPair(t, f.instance.StateDir, "pair-linked", f.prunable), "pair.json")
			if err := os.Rename(path, path+"-target"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(path+"-target", path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "linked backup root", setup: func(t *testing.T, f retentionFixture) {
			path := filepath.Join(f.instance.StateDir, "backups")
			if err := os.Symlink(t.TempDir(), path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "missing instance root", setup: func(t *testing.T, f retentionFixture) {
			if err := os.RemoveAll(filepath.Join(f.store.Home, "instances")); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "linked instance root", setup: func(t *testing.T, f retentionFixture) {
			path := filepath.Join(f.store.Home, "instances")
			if err := os.RemoveAll(path); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(t.TempDir(), path); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "missing current instance", setup: func(t *testing.T, f retentionFixture) {
			if err := os.RemoveAll(f.instance.Dir); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "missing other instance authority", setup: func(t *testing.T, f retentionFixture) {
			other := otherRetentionInstance(t, f, f.prunable.BuildID)
			if err := os.Remove(other.StatePath); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "malformed other instance authority", setup: func(t *testing.T, f retentionFixture) {
			other := otherRetentionInstance(t, f, f.prunable.BuildID)
			if err := os.WriteFile(other.StatePath, []byte("{}"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "duplicate other instance field", setup: func(t *testing.T, f retentionFixture) {
			other := otherRetentionInstance(t, f, f.prunable.BuildID)
			duplicateRetentionField(t, other.StatePath, "schemaVersion")
		}},
		{name: "linked other instance authority", setup: func(t *testing.T, f retentionFixture) {
			other := otherRetentionInstance(t, f, f.prunable.BuildID)
			if err := os.Rename(other.StatePath, other.StatePath+"-target"); err != nil {
				t.Fatal(err)
			}
			if err := os.Symlink(other.StatePath+"-target", other.StatePath); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "unreadable other instance authority", setup: func(t *testing.T, f retentionFixture) {
			other := otherRetentionInstance(t, f, f.prunable.BuildID)
			if err := os.Chmod(other.StatePath, 0); err != nil {
				t.Fatal(err)
			}
			t.Cleanup(func() { _ = os.Chmod(other.StatePath, 0o600) })
			if file, err := os.Open(other.StatePath); err == nil {
				file.Close()
				t.Skip("current user can read mode-000 files")
			}
		}},
		{name: "foreign other instance identity", setup: func(t *testing.T, f retentionFixture) {
			other := otherRetentionInstance(t, f, f.prunable.BuildID)
			state, err := readState(other.StatePath)
			if err != nil {
				t.Fatal(err)
			}
			state.InstanceID = f.instance.ID
			if err := writeState(other.StatePath, state); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "missing other workspace", setup: func(t *testing.T, f retentionFixture) {
			other := otherRetentionInstance(t, f, f.prunable.BuildID)
			if err := os.Remove(other.StateDir); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "malformed journal", setup: func(t *testing.T, f retentionFixture) {
			if err := os.WriteFile(filepath.Join(f.store.Home, release.JournalFile), []byte("{"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
		{name: "duplicate active field", setup: func(t *testing.T, f retentionFixture) {
			duplicateRetentionField(t, filepath.Join(f.store.Home, release.ActiveFile), "schemaVersion")
		}},
		{name: "duplicate journal field", setup: func(t *testing.T, f retentionFixture) {
			if _, err := f.store.Begin("update", &f.prior, &f.active, f.active.DescriptorSHA256); err != nil {
				t.Fatal(err)
			}
			duplicateRetentionField(t, filepath.Join(f.store.Home, release.JournalFile), "schemaVersion")
		}},
		{name: "duplicate channel policy field", setup: func(t *testing.T, f retentionFixture) {
			if _, err := f.store.RecordMetadata("stable", f.active.Sequence, 1, f.active.BuildID, f.active.DescriptorSHA256, nil); err != nil {
				t.Fatal(err)
			}
			duplicateRetentionField(t, filepath.Join(f.store.Home, "channel-stable.json"), "schemaVersion")
		}},
		{name: "malformed channel policy", setup: func(t *testing.T, f retentionFixture) {
			if err := os.WriteFile(filepath.Join(f.store.Home, "channel-stable.json"), []byte("{"), 0o600); err != nil {
				t.Fatal(err)
			}
		}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			fixture := newRetentionFixture(t)
			scenario.setup(t, fixture)
			if err := retainReleases(fixture.store, fixture.instance.StateDir); err == nil {
				t.Fatal("unverifiable authority silently permitted pruning")
			}
			for _, receipt := range []release.Receipt{fixture.active, fixture.prior, fixture.prunable} {
				if _, err := os.Lstat(filepath.Join(fixture.store.Home, "releases", receipt.BuildID)); err != nil {
					t.Errorf("failure removed release %s: %v", receipt.BuildID, err)
				}
			}
		})
	}
}

func TestPromotionReportsActivatedReleaseWhenRetentionCannotBeProven(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	inst, err := resolveInstance([]string{"HOME=" + t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	store, err := release.Open(inst.RuntimeHome)
	if err != nil {
		t.Fatal(err)
	}
	old := installLifecycleRelease(t, store.Home, "retention-promote-old-0001", 1, python)
	candidate := installLifecycleRelease(t, store.Home, "retention-promote-new-0002", 2, python)
	prunable := stableRetentionReceipt("retention-prune-spare-0001", 1)
	writeRetentionRelease(t, store.Home, prunable.BuildID, prunable)
	if _, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture"); err != nil {
		t.Fatal(err)
	}
	verified, err := verifyInstalledReleaseForExecution(store, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(store.Home, verified); err != nil {
		t.Fatal(err)
	}
	seedLifecycleSQLitePair(t, python, inst.StateDir, "old-")
	dir := writeRetentionPair(t, inst.StateDir, "pair-malformed-existing", prunable)
	if err := os.WriteFile(filepath.Join(dir, "pair.json"), []byte("{"), 0o600); err != nil {
		t.Fatal(err)
	}
	previousStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previousStart })
	startReleaseCommand = func(_ launchContext, _ release.Receipt, _ string) error { return nil }
	active, err := store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: inst, Environment: []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + inst.RuntimeHome, "JOBCTRL_DIR=" + inst.StateDir}}
	err = promoteExisting(ctx, store, active, candidate.BuildID, "update", io.Discard)
	if err == nil || !strings.Contains(err.Error(), candidate.BuildID+" is active") || !strings.Contains(err.Error(), "retention did not complete") {
		t.Fatalf("promotion result concealed the active selection or retention error: %v", err)
	}
	active, err = store.ReadActive()
	if err != nil || active.Receipt != candidate {
		t.Fatalf("candidate was not actually activated: %#v, %v", active, err)
	}
	if _, err := os.Stat(filepath.Join(store.Home, "releases", prunable.BuildID)); err != nil {
		t.Fatalf("uncertain retention removed stable release: %v", err)
	}
}

func TestPromotionRefusesReleaseRootReplacedAfterStoreOpen(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	home := t.TempDir()
	inst, err := resolveInstance([]string{"HOME=" + home})
	if err != nil {
		t.Fatal(err)
	}
	store, err := release.Open(inst.RuntimeHome)
	if err != nil {
		t.Fatal(err)
	}
	old := installLifecycleRelease(t, store.Home, "retention-promote-old-0001", 1, python)
	candidate := installLifecycleRelease(t, store.Home, "retention-promote-new-0002", 2, python)
	prunable := stableRetentionReceipt("retention-prune-spare-0001", 1)
	writeRetentionRelease(t, store.Home, prunable.BuildID, prunable)
	if _, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture"); err != nil {
		t.Fatal(err)
	}
	verified, err := verifyInstalledReleaseForExecution(store, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(inst.RuntimeHome, verified); err != nil {
		t.Fatal(err)
	}
	seedLifecycleSQLitePair(t, python, inst.StateDir, "old-")
	root := filepath.Join(store.Home, "releases")
	foreign := filepath.Join(t.TempDir(), "moved-releases")
	marker := filepath.Join(foreign, prunable.BuildID, "synthetic-user-data")
	previousStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previousStart })
	startReleaseCommand = func(_ launchContext, _ release.Receipt, _ string) error {
		if err := os.Rename(root, foreign); err != nil {
			return err
		}
		if err := os.Symlink(foreign, root); err != nil {
			return err
		}
		return os.WriteFile(marker, []byte("preserve synthetic data"), 0600)
	}
	active, err := store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	ctx := launchContext{Instance: inst, Environment: []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + inst.RuntimeHome, "JOBCTRL_DIR=" + inst.StateDir}}
	err = promoteExisting(ctx, store, active, candidate.BuildID, "update", io.Discard)
	if err == nil || !strings.Contains(err.Error(), candidate.BuildID+" is active") || !strings.Contains(err.Error(), "retention did not complete") {
		t.Fatalf("promotion did not report the refused retention: %v", err)
	}
	active, err = store.ReadActive()
	if err != nil || active.Receipt != candidate {
		t.Fatalf("candidate activation changed: %#v, %v", active, err)
	}
	if raw, err := os.ReadFile(marker); err != nil || string(raw) != "preserve synthetic data" {
		t.Fatalf("foreign marker was changed: %q, %v", raw, err)
	}
}
