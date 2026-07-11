package release

import (
	"errors"
	"testing"
	"time"
)

func receipt(build string, sequence uint64, descriptor string) Receipt {
	return Receipt{SchemaVersion: 1, BuildID: build, Channel: "stable", Sequence: sequence, ArtifactSHA256: "a" + descriptor[1:], ManifestSHA256: "b" + descriptor[1:], DescriptorSHA256: descriptor, DescriptorURL: "https://releases.example.test/stable.json", InstalledAt: time.Now().UTC().Format(time.RFC3339Nano)}
}

func TestSharedSelectionBlocksExclusiveTransitionUntilReadinessReleases(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	reader, err := store.SelectionLock(false)
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		writer, err := store.SelectionLock(true)
		if err == nil {
			err = writer.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("exclusive selection acquired before readiness released: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := reader.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("exclusive selection did not acquire after readiness release")
	}
}

func TestActiveRecordIsOneAtomicSelectionObject(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := receipt("stable-build-0000001", 1, "c"+string(make([]byte, 63)))
	// Fill the synthetic digest without weakening the production validator.
	r.ArtifactSHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	r.ManifestSHA256 = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	r.DescriptorSHA256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
	active, err := store.WriteActive(r, 0)
	if err != nil {
		t.Fatal(err)
	}
	if active.Generation != 1 || active.Receipt.BuildID != r.BuildID {
		t.Fatalf("active = %#v", active)
	}
	loaded, err := store.ReadActive()
	if err != nil || loaded != active {
		t.Fatalf("read active = %#v, %v", loaded, err)
	}
}

func TestActiveRejectsUnknownAcquisitionOwnership(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	r := receipt("stable-build-0000001", 1, "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc")
	if _, err := store.WriteSelectedActive(r, 0, r.BuildID, "unknown-adapter"); err == nil {
		t.Fatal("unknown acquisition adapter was accepted")
	}
}

func TestChannelEvidenceRejectsRollbackRevocationAndIdentityDrift(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	d1 := "1111111111111111111111111111111111111111111111111111111111111111"
	if _, err := store.RecordMetadata("stable", 7, 5, "stable-build-0000007", d1, []string{"stable-build-0000004"}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecordMetadata("stable", 6, 5, "stable-build-0000006", "2222222222222222222222222222222222222222222222222222222222222222", nil); err == nil {
		t.Fatal("accepted sequence downgrade")
	}
	if _, err := store.RecordMetadata("stable", 7, 5, "stable-build-other0007", d1, nil); err == nil {
		t.Fatal("accepted same sequence different build")
	}
	if _, err := store.RecordMetadata("stable", 7, 5, "stable-build-0000007", "3333333333333333333333333333333333333333333333333333333333333333", nil); err == nil {
		t.Fatal("accepted same sequence descriptor drift")
	}
	if _, err := store.RecordMetadata("stable", 8, 4, "stable-build-0000008", "4444444444444444444444444444444444444444444444444444444444444444", nil); err == nil {
		t.Fatal("accepted lower minimum-safe sequence")
	}
	revoked := receipt("stable-build-0000004", 5, "5555555555555555555555555555555555555555555555555555555555555555")
	if err := store.Permit(revoked); err == nil {
		t.Fatal("permitted revoked build")
	}
	below := receipt("stable-build-0000003", 3, "6666666666666666666666666666666666666666666666666666666666666666")
	if err := store.Permit(below); err == nil {
		t.Fatal("permitted below minimum-safe sequence")
	}
}

func TestPolicyValidationDoesNotRevokeActiveUntilJournaledFinalization(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	old := receipt("stable-build-0000001", 1, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if _, err := store.RecordMetadata(old.Channel, old.Sequence, 1, old.BuildID, old.DescriptorSHA256, nil); err != nil {
		t.Fatal(err)
	}
	// This is the exact candidate-committed/policy-pending crash window: the
	// authenticated policy is validated but must not yet make old unrunnable.
	pending, err := store.ValidateMetadata(ChannelMetadata{Channel: "stable", Sequence: 2, Minimum: 2, BuildID: "stable-build-0000002", DescriptorDigest: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", Revoked: []string{old.BuildID}})
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Permit(old); err != nil {
		t.Fatalf("old release was blocked before policy finalization: %v", err)
	}
	if err := store.CommitMetadata(pending); err != nil {
		t.Fatal(err)
	}
	if err := store.Permit(old); err == nil {
		t.Fatal("old release remained permitted after policy finalization")
	}
}

func TestTransitionLockSerializesInstallerAndUninstallBoundary(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	first, err := store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		second, err := store.TransitionLock()
		if err == nil {
			err = second.Close()
		}
		done <- err
	}()
	select {
	case err := <-done:
		t.Fatalf("second lifecycle owner acquired transition lock early: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	if err := first.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("second lifecycle owner did not acquire transition lock")
	}
}

func TestJournalPersistsFailureForSafeRecovery(t *testing.T) {
	store, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	j, err := store.Begin("update", nil, nil, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Advance(&j, CandidateStarting, errors.New("injected")); err != nil {
		t.Fatal(err)
	}
	loaded, err := store.ReadJournal()
	if err != nil || loaded.State != CandidateStarting || !loaded.Resumable() || loaded.Error != "injected" {
		t.Fatalf("journal = %#v, %v", loaded, err)
	}
	if err := store.Advance(&loaded, RolledBack, nil); err != nil {
		t.Fatal(err)
	}
	if loaded.Resumable() {
		t.Fatal("rolled back journal remained resumable")
	}
}
