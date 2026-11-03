package launcher

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

const syntheticSpendReceipt = "{\"version\":1,\"day\":\"2026-01-01\",\"lane\":\"scoring\",\"provider\":\"anthropic\",\"model\":\"synthetic\"}\n{\"day\":\"2026-01-01\",\"input_tokens\":11,\"output_tokens\":7}\n"

func writeSyntheticSpendReceipt(t *testing.T, state string) string {
	t.Helper()
	dir := filepath.Join(state, spendReceiptDirectory)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(dir, "synthetic.jsonl")
	if err := os.WriteFile(path, []byte(syntheticSpendReceipt), 0o600); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestSpendRecoveryDirectoryAdmission(t *testing.T) {
	for _, name := range []string{
		"missing", "empty", "lock-only", "abandoned receipt", "malformed receipt",
		"linked directory", "linked gate", "hardlinked gate", "unreadable directory",
		"unreadable gate", "busy gate", "new receipt during listing",
	} {
		t.Run(name, func(t *testing.T) {
			state := t.TempDir()
			dir := filepath.Join(state, spendReceiptDirectory)
			if name != "missing" && name != "linked directory" {
				if err := os.Mkdir(dir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			var retained string
			blocked := true
			switch name {
			case "missing", "empty":
				blocked = false
			case "lock-only":
				blocked = false
				retained = filepath.Join(dir, "lock")
				if err := os.WriteFile(retained, []byte{0}, 0o600); err != nil {
					t.Fatal(err)
				}
			case "abandoned receipt":
				retained = writeSyntheticSpendReceipt(t, state)
			case "malformed receipt":
				retained = filepath.Join(dir, "malformed.jsonl")
				if err := os.WriteFile(retained, []byte("{"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "linked directory":
				target := t.TempDir()
				retained = filepath.Join(target, "kept")
				if err := os.WriteFile(retained, []byte("owned fixture"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, dir); err != nil {
					t.Fatal(err)
				}
			case "linked gate", "hardlinked gate":
				retained = filepath.Join(t.TempDir(), "owned-gate")
				if err := os.WriteFile(retained, []byte{0}, 0o600); err != nil {
					t.Fatal(err)
				}
				var err error
				if name == "linked gate" {
					err = os.Symlink(retained, filepath.Join(dir, "lock"))
				} else {
					err = os.Link(retained, filepath.Join(dir, "lock"))
				}
				if err != nil {
					t.Fatal(err)
				}
			case "unreadable directory":
				if err := os.Chmod(dir, 0); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
			case "unreadable gate":
				retained = filepath.Join(dir, "lock")
				if err := os.WriteFile(retained, []byte{0}, 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Chmod(retained, 0); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(retained, 0o600) })
			case "busy gate":
				retained = filepath.Join(dir, "lock")
				file, err := os.OpenFile(retained, os.O_RDWR|os.O_CREATE|os.O_EXCL, 0o600)
				if err != nil {
					t.Fatal(err)
				}
				if err := syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = syscall.Flock(int(file.Fd()), syscall.LOCK_UN); _ = file.Close() })
			case "new receipt during listing":
				old := afterRetentionReferenceListing
				t.Cleanup(func() { afterRetentionReferenceListing = old })
				afterRetentionReferenceListing = func(label string) {
					if label == "spend receipts" {
						retained = writeSyntheticSpendReceipt(t, state)
						past := time.Now().Add(-time.Hour)
						if err := os.Chtimes(dir, past, past); err != nil {
							t.Fatal(err)
						}
					}
				}
			}
			var before []byte
			if retained != "" && name != "unreadable gate" {
				var err error
				before, err = os.ReadFile(retained)
				if err != nil {
					t.Fatal(err)
				}
			}
			err := refuseUnresolvedSpendRecovery(state)
			if blocked && !errors.Is(err, errSpendRecoveryUnresolved) {
				t.Fatalf("unsafe receipt authority was admitted: %v", err)
			}
			if !blocked && err != nil {
				t.Fatalf("clean receipt authority was refused: %v", err)
			}
			if retained != "" && name != "unreadable gate" && name != "new receipt during listing" {
				after, err := os.ReadFile(retained)
				if err != nil || !bytes.Equal(before, after) {
					t.Fatalf("retained authority changed: %v", err)
				}
			}
			if name == "new receipt during listing" {
				if got, err := os.ReadFile(retained); err != nil || string(got) != syntheticSpendReceipt {
					t.Fatalf("new receipt changed or disappeared: %v", err)
				}
			}
		})
	}
}

type spendLifecycleFixture struct {
	state, runtime, python string
	store                  *release.Store
	old, candidate         release.Receipt
	active                 release.Active
	pair                   databasePair
	ctx                    launchContext
}

// The pair is built from two closed, owned synthetic databases. The tests replace
// the stop/start callbacks; successful snapshotPair still needs the local test's
// narrowly scoped lsof seam (or the isolated hosted CI environment).
func newSpendLifecycleFixture(t *testing.T) spendLifecycleFixture {
	t.Helper()
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	runtime, state := t.TempDir(), t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	old := installLifecycleRelease(t, runtime, "spend-old-build-0001", 1, python)
	candidate := installLifecycleRelease(t, runtime, "spend-new-build-0002", 2, python)
	seedLifecycleSQLitePair(t, python, state, "old-")
	pair := databasePair{SchemaVersion: 1, ID: "pair-synthetic", ReleaseReceipt: old, CreatedAt: time.Now().UTC()}
	pairDir := filepath.Join(state, "backups", pair.ID)
	if err := os.MkdirAll(pairDir, 0o700); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"jobctrl.db", "temporal.db"} {
		if err := copyRegular(filepath.Join(state, name), filepath.Join(pairDir, name)); err != nil {
			t.Fatal(err)
		}
		version := int64(0)
		if name == "jobctrl.db" {
			version = 15
		}
		file, err := describeDatabase(filepath.Join(pairDir, name), name, version)
		if err != nil {
			t.Fatal(err)
		}
		pair.Files = append(pair.Files, file)
	}
	if err := writeJSONAtomic(filepath.Join(pairDir, "pair.json"), pair); err != nil {
		t.Fatal(err)
	}
	setLifecycleSQLitePair(t, python, state, "new-")
	active, err := store.WriteSelectedActive(candidate, 0, candidate.BuildID, "local-fixture")
	if err != nil {
		t.Fatal(err)
	}
	verified, err := verifyInstalledReleaseForExecution(store, candidate)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(runtime, verified); err != nil {
		t.Fatal(err)
	}
	return spendLifecycleFixture{
		state: state, runtime: runtime, python: python, store: store, old: old, candidate: candidate,
		active: active, pair: pair,
		ctx: launchContext{Instance: instance{RuntimeHome: runtime, StateDir: state, StatePath: filepath.Join(state, "missing-state.json"), LockPath: filepath.Join(state, "instance.lock"), ControlPath: filepath.Join(state, "control.lock")}, Environment: []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime, "JOBCTRL_DIR=" + state}},
	}
}

func preserveSpendLifecycleSeams(t *testing.T) {
	t.Helper()
	oldStop, oldStart, oldCheckpoint := stopForRecoveryCommand, startReleaseCommand, recoveryRestoringCheckpoint
	t.Cleanup(func() {
		stopForRecoveryCommand, startReleaseCommand, recoveryRestoringCheckpoint = oldStop, oldStart, oldCheckpoint
	})
}

// This models a separate reconciliation of an owned synthetic receipt. Moving
// it to a private test archive does not claim to reconcile a real ledger.
func archiveSyntheticSpendReceipt(t *testing.T, receipt string) {
	t.Helper()
	archived := filepath.Join(t.TempDir(), "reconciled-synthetic-receipt.jsonl")
	if err := os.Rename(receipt, archived); err != nil {
		t.Fatal(err)
	}
	if got, err := os.ReadFile(archived); err != nil || string(got) != syntheticSpendReceipt {
		t.Fatalf("synthetic receipt archive changed: %v", err)
	}
}

// Authenticate the real transition selector, then execute only the fixture's
// inert shell selector through the production startRelease entry point.
func startOwnedTransitionSelector(t *testing.T, fixture spendLifecycleFixture, expected release.Receipt, starts *int) func(launchContext, release.Receipt, string) error {
	t.Helper()
	return func(ctx launchContext, receipt release.Receipt, journalID string) error {
		if receipt != expected || journalID == "" {
			t.Fatalf("unexpected release or journal: %#v %q", receipt, journalID)
		}
		selector := filepath.Join(fixture.runtime, "bin", "jobctrl")
		if !selectorSupportsJournalStartup(fixture.store, selector) {
			t.Fatal("synthetic public selector does not support journal startup")
		}
		env := append(append([]string{}, ctx.Environment...), "JOBCTRL_TRANSITION_JOURNAL="+journalID, "JOBCTRL_TRANSITION_TARGET="+receipt.BuildID)
		payload, selected, err := transitionSelectorPayload(selector, env)
		canonicalRuntime, canonicalErr := filepath.EvalSymlinks(fixture.runtime)
		if err != nil || canonicalErr != nil || selected == nil || selected.BuildID != receipt.BuildID || payload != filepath.Join(canonicalRuntime, "releases", receipt.BuildID, "payload") {
			t.Fatalf("authenticated selector target: %s %#v %v", payload, selected, err)
		}
		(*starts)++
		return startRelease(ctx, receipt, journalID)
	}
}

func TestSpendReceiptCreatedDuringRollbackStopRefusesBeforeRestore(t *testing.T) {
	preserveSpendLifecycleSeams(t)
	fixture := newSpendLifecycleFixture(t)
	before := lifecycleDatabaseDigests(t, fixture.state)
	pairBefore := lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))
	stops, starts := 0, 0
	var receipt string
	stopForRecoveryCommand = func(launchContext) error {
		stops++
		receipt = writeSyntheticSpendReceipt(t, fixture.state)
		return nil
	}
	startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
	err := rollbackExisting(fixture.ctx, fixture.store, fixture.active, fixture.old.BuildID, io.Discard)
	if !errors.Is(err, errSpendRecoveryUnresolved) || !strings.Contains(err.Error(), "whether recovery can be retried depends on the transition state") || !strings.Contains(err.Error(), "may already have been replaced") {
		t.Fatalf("rollback did not report accounting refusal and retry guidance: %v", err)
	}
	if stops != 1 || starts != 0 {
		t.Fatalf("stop/start counts = %d/%d", stops, starts)
	}
	if got, err := os.ReadFile(receipt); err != nil || string(got) != syntheticSpendReceipt {
		t.Fatalf("receipt changed or disappeared: %v", err)
	}
	if !reflect.DeepEqual(before, lifecycleDatabaseDigests(t, fixture.state)) || !reflect.DeepEqual(pairBefore, lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))) {
		t.Fatal("refused rollback changed the live or backed-up database pair")
	}
	active, err := fixture.store.ReadActive()
	if err != nil || active.Receipt != fixture.candidate {
		t.Fatalf("refused rollback changed active release: %#v %v", active, err)
	}
}

func TestSpendRecoveryAllowsCleanRollback(t *testing.T) {
	for _, kind := range []string{"missing", "empty", "lock-only"} {
		t.Run(kind, func(t *testing.T) {
			preserveSpendLifecycleSeams(t)
			fixture := newSpendLifecycleFixture(t)
			if kind != "missing" {
				dir := filepath.Join(fixture.state, spendReceiptDirectory)
				if err := os.Mkdir(dir, 0o700); err != nil {
					t.Fatal(err)
				}
				if kind == "lock-only" {
					if err := os.WriteFile(filepath.Join(dir, "lock"), []byte{0}, 0o600); err != nil {
						t.Fatal(err)
					}
				}
			}
			stops, starts := 0, 0
			stopForRecoveryCommand = func(launchContext) error { stops++; return nil }
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
				if receipt != fixture.old {
					t.Fatalf("unexpected target %s", receipt.BuildID)
				}
				starts++
				return nil
			}
			if err := rollbackExisting(fixture.ctx, fixture.store, fixture.active, fixture.old.BuildID, io.Discard); err != nil {
				t.Fatalf("clean rollback refused: %v", err)
			}
			if stops != 1 || starts != 1 {
				t.Fatalf("stop/start counts = %d/%d", stops, starts)
			}
			if got := lifecycleDatabaseValues(t, fixture.python, fixture.state); got["jobctrl.db"] != "old-jobctrl.db" || got["temporal.db"] != "old-temporal.db" {
				t.Fatalf("rollback did not restore target pair: %v", got)
			}
		})
	}
}

func TestSpendReceiptBlocksInterruptedPairRecoveryBeforeMutation(t *testing.T) {
	preserveSpendLifecycleSeams(t)
	fixture := newSpendLifecycleFixture(t)
	journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	journal.BackupID = fixture.pair.ID
	if err := fixture.store.Advance(&journal, release.MetadataVerified, nil); err != nil {
		t.Fatal(err)
	}
	beforeJournal, err := fixture.store.ReadJournal()
	if err != nil {
		t.Fatal(err)
	}
	candidatePath := v15CandidatePath(fixture.state, journal.ID)
	if err := os.WriteFile(candidatePath, []byte("owned migration candidate"), 0o600); err != nil {
		t.Fatal(err)
	}
	before := lifecycleDatabaseDigests(t, fixture.state)
	pairBefore := lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))
	stops, starts := 0, 0
	var receipt string
	stopForRecoveryCommand = func(launchContext) error {
		stops++
		receipt = writeSyntheticSpendReceipt(t, fixture.state)
		return nil
	}
	startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
	recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store)
	if recovered || !errors.Is(err, errSpendRecoveryUnresolved) {
		t.Fatalf("interrupted recovery = %v, %v", recovered, err)
	}
	if stops != 1 || starts != 0 {
		t.Fatalf("stop/start counts = %d/%d", stops, starts)
	}
	for path, want := range map[string]string{receipt: syntheticSpendReceipt, candidatePath: "owned migration candidate"} {
		if got, err := os.ReadFile(path); err != nil || string(got) != want {
			t.Fatalf("recovery changed retained synthetic file %s: %v", filepath.Base(path), err)
		}
	}
	if !reflect.DeepEqual(before, lifecycleDatabaseDigests(t, fixture.state)) || !reflect.DeepEqual(pairBefore, lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))) {
		t.Fatal("refused recovery changed the live or backed-up database pair")
	}
	if got, err := fixture.store.ReadJournal(); err != nil || !reflect.DeepEqual(got, beforeJournal) {
		t.Fatalf("blocked recovery changed its retryable journal: %#v %v", got, err)
	}
	archiveSyntheticSpendReceipt(t, receipt)
	stopForRecoveryCommand = func(launchContext) error { stops++; return nil }
	startReleaseCommand = startOwnedTransitionSelector(t, fixture, fixture.old, &starts)
	if recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store); !recovered || err != nil {
		t.Fatalf("reconciled synthetic recovery = %v, %v", recovered, err)
	}
	if stops != 2 || starts != 1 {
		t.Fatalf("retry stop/start counts = %d/%d", stops, starts)
	}
	if got := lifecycleDatabaseValues(t, fixture.python, fixture.state); got["jobctrl.db"] != "old-jobctrl.db" || got["temporal.db"] != "old-temporal.db" {
		t.Fatalf("retry did not restore the target pair: %v", got)
	}
}

func TestSpendRecoveryAllowsCleanInterruptedRecovery(t *testing.T) {
	preserveSpendLifecycleSeams(t)
	fixture := newSpendLifecycleFixture(t)
	journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	journal.BackupID = fixture.pair.ID
	if err := fixture.store.Advance(&journal, release.MetadataVerified, nil); err != nil {
		t.Fatal(err)
	}
	stops, starts := 0, 0
	stopForRecoveryCommand = func(launchContext) error { stops++; return nil }
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != fixture.old {
			t.Fatalf("unexpected target %s", receipt.BuildID)
		}
		starts++
		return nil
	}
	if recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store); !recovered || err != nil {
		t.Fatalf("clean interrupted recovery = %v, %v", recovered, err)
	}
	if stops != 1 || starts != 1 {
		t.Fatalf("stop/start counts = %d/%d", stops, starts)
	}
	if got := lifecycleDatabaseValues(t, fixture.python, fixture.state); got["jobctrl.db"] != "old-jobctrl.db" || got["temporal.db"] != "old-temporal.db" {
		t.Fatalf("recovery did not restore target pair: %v", got)
	}
}

func TestSpendRecoveryRefusesUnsafeRollbackAuthorities(t *testing.T) {
	for _, kind := range []string{"abandoned", "malformed", "linked directory", "unreadable directory"} {
		t.Run(kind, func(t *testing.T) {
			preserveSpendLifecycleSeams(t)
			fixture := newSpendLifecycleFixture(t)
			dir := filepath.Join(fixture.state, spendReceiptDirectory)
			var evidence string
			switch kind {
			case "abandoned":
				evidence = writeSyntheticSpendReceipt(t, fixture.state)
			case "malformed":
				if err := os.Mkdir(dir, 0o700); err != nil {
					t.Fatal(err)
				}
				evidence = filepath.Join(dir, "malformed.jsonl")
				if err := os.WriteFile(evidence, []byte("{"), 0o600); err != nil {
					t.Fatal(err)
				}
			case "linked directory":
				target := t.TempDir()
				evidence = filepath.Join(target, "kept")
				if err := os.WriteFile(evidence, []byte("owned synthetic file"), 0o600); err != nil {
					t.Fatal(err)
				}
				if err := os.Symlink(target, dir); err != nil {
					t.Fatal(err)
				}
			case "unreadable directory":
				if err := os.Mkdir(dir, 0o700); err != nil {
					t.Fatal(err)
				}
				evidence = filepath.Join(dir, "retained")
				if err := os.WriteFile(evidence, []byte("owned synthetic file"), 0o600); err != nil {
					t.Fatal(err)
				}
			}
			beforeEvidence, err := os.ReadFile(evidence)
			if err != nil {
				t.Fatal(err)
			}
			if kind == "unreadable directory" {
				if err := os.Chmod(dir, 0); err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() { _ = os.Chmod(dir, 0o700) })
			}
			before := lifecycleDatabaseDigests(t, fixture.state)
			backupBefore := lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))
			stops, starts := 0, 0
			stopForRecoveryCommand = func(launchContext) error { stops++; return nil }
			startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
			err = rollbackExisting(fixture.ctx, fixture.store, fixture.active, fixture.old.BuildID, io.Discard)
			if !errors.Is(err, errSpendRecoveryUnresolved) || stops != 1 || starts != 0 {
				t.Fatalf("unsafe rollback = %v (stops=%d starts=%d)", err, stops, starts)
			}
			if kind == "unreadable directory" {
				if err := os.Chmod(dir, 0o700); err != nil {
					t.Fatal(err)
				}
			}
			if after, err := os.ReadFile(evidence); err != nil || !bytes.Equal(beforeEvidence, after) {
				t.Fatalf("receipt authority changed or disappeared: %v", err)
			}
			if !reflect.DeepEqual(before, lifecycleDatabaseDigests(t, fixture.state)) || !reflect.DeepEqual(backupBefore, lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))) {
				t.Fatal("refused rollback changed the live or backed-up database pair")
			}
		})
	}
}

func TestSpendReceiptBlocksRevokedInterruptedRecoveryBeforeRestore(t *testing.T) {
	preserveSpendLifecycleSeams(t)
	fixture := newSpendLifecycleFixture(t)
	if _, err := fixture.store.RecordMetadata("local", 3, 0, "policy-control-0003", strings.Repeat("e", 64), []string{fixture.old.BuildID}); err != nil {
		t.Fatal(err)
	}
	journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	journal.BackupID = fixture.pair.ID
	if err := fixture.store.Advance(&journal, release.MetadataVerified, nil); err != nil {
		t.Fatal(err)
	}
	beforeJournal, err := fixture.store.ReadJournal()
	if err != nil {
		t.Fatal(err)
	}
	before := lifecycleDatabaseDigests(t, fixture.state)
	backupBefore := lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))
	stops, starts := 0, 0
	var receipt string
	stopForRecoveryCommand = func(launchContext) error {
		stops++
		receipt = writeSyntheticSpendReceipt(t, fixture.state)
		return nil
	}
	startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
	handled, err := recoverRevokedTransitionBeforePrepare(fixture.ctx.Environment, io.Discard)
	if !handled || !errors.Is(err, errSpendRecoveryUnresolved) || stops != 1 || starts != 0 {
		t.Fatalf("revoked recovery = %v, %v (stops=%d starts=%d)", handled, err, stops, starts)
	}
	if got, err := os.ReadFile(receipt); err != nil || string(got) != syntheticSpendReceipt {
		t.Fatalf("receipt changed or disappeared: %v", err)
	}
	if !reflect.DeepEqual(before, lifecycleDatabaseDigests(t, fixture.state)) || !reflect.DeepEqual(backupBefore, lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))) {
		t.Fatal("refused security recovery changed the live or backed-up pair")
	}
	if got, err := fixture.store.ReadJournal(); err != nil || !reflect.DeepEqual(got, beforeJournal) {
		t.Fatalf("blocked security recovery changed its retryable journal: %#v %v", got, err)
	}
	archiveSyntheticSpendReceipt(t, receipt)
	stopForRecoveryCommand = func(launchContext) error { stops++; return nil }
	startReleaseCommand = startOwnedTransitionSelector(t, fixture, fixture.candidate, &starts)
	if handled, err := recoverRevokedTransitionBeforePrepare(fixture.ctx.Environment, io.Discard); !handled || err != nil {
		t.Fatalf("reconciled synthetic security recovery = %v, %v", handled, err)
	}
	if stops != 2 || starts != 1 {
		t.Fatalf("retry stop/start counts = %d/%d", stops, starts)
	}
	if got := lifecycleDatabaseValues(t, fixture.python, fixture.state); got["jobctrl.db"] != "old-jobctrl.db" || got["temporal.db"] != "old-temporal.db" {
		t.Fatalf("security retry did not restore the target pair: %v", got)
	}
}

func TestSpendReceiptAppearingAtRollbackMilestonesStopsOlderStartup(t *testing.T) {
	for _, stage := range []release.State{release.PairBackedUp, release.CandidateStarting} {
		t.Run(string(stage), func(t *testing.T) {
			preserveSpendLifecycleSeams(t)
			oldFailure := transitionFailure
			t.Cleanup(func() { transitionFailure = oldFailure })
			fixture := newSpendLifecycleFixture(t)
			before := lifecycleDatabaseDigests(t, fixture.state)
			beforeValues := lifecycleDatabaseValues(t, fixture.python, fixture.state)
			backupBefore := lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))
			stops, starts := 0, 0
			var receipt string
			stopForRecoveryCommand = func(launchContext) error { stops++; return nil }
			startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
			transitionFailure = func(state release.State) error {
				if state == stage {
					receipt = writeSyntheticSpendReceipt(t, fixture.state)
				}
				return nil
			}
			err := rollbackExisting(fixture.ctx, fixture.store, fixture.active, fixture.old.BuildID, io.Discard)
			if !errors.Is(err, errSpendRecoveryUnresolved) || stops != 1 || starts != 0 {
				t.Fatalf("rollback = %v (stops=%d starts=%d)", err, stops, starts)
			}
			if got, err := os.ReadFile(receipt); err != nil || string(got) != syntheticSpendReceipt {
				t.Fatalf("receipt changed or disappeared: %v", err)
			}
			if !reflect.DeepEqual(backupBefore, lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))) {
				t.Fatal("target pair changed")
			}
			journal, err := fixture.store.ReadJournal()
			if err != nil || !journal.PreserveLiveOnFailure || journal.BackupID == "" {
				t.Fatalf("missing preserved current backup: %#v, %v", journal, err)
			}
			if got := lifecycleDatabaseValues(t, fixture.python, filepath.Join(fixture.state, "backups", journal.BackupID)); !reflect.DeepEqual(beforeValues, got) {
				t.Fatal("current pair was not retained")
			}
			if stage == release.PairBackedUp && !reflect.DeepEqual(before, lifecycleDatabaseDigests(t, fixture.state)) {
				t.Fatal("receipt present before restore did not protect live databases")
			}
		})
	}
}

func TestSpendRecoveryInterruptionAroundRestoringMilestone(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		for _, checkpoint := range []string{"before", "after"} {
			name := "ordinary/" + checkpoint
			if revoked {
				name = "revoked/" + checkpoint
			}
			t.Run(name, func(t *testing.T) {
				preserveSpendLifecycleSeams(t)
				fixture := newSpendLifecycleFixture(t)
				if revoked {
					if _, err := fixture.store.RecordMetadata("local", 3, 0, "policy-control-0003", strings.Repeat("e", 64), []string{fixture.old.BuildID}); err != nil {
						t.Fatal(err)
					}
				}
				journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
				if err != nil {
					t.Fatal(err)
				}
				journal.BackupID = fixture.pair.ID
				if err := fixture.store.Advance(&journal, release.MetadataVerified, nil); err != nil {
					t.Fatal(err)
				}
				beforeJournal, err := fixture.store.ReadJournal()
				if err != nil {
					t.Fatal(err)
				}
				before := lifecycleDatabaseDigests(t, fixture.state)
				backupBefore := lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))
				stops, starts := 0, 0
				stopForRecoveryCommand = func(launchContext) error { stops++; return nil }
				startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
				recoveryRestoringCheckpoint = func(stage string) error {
					if stage == checkpoint {
						return errTransitionInterrupted
					}
					return nil
				}
				invoke := func() (bool, error) {
					if revoked {
						return recoverRevokedTransitionBeforePrepare(fixture.ctx.Environment, io.Discard)
					}
					return recoverInterruptedTransition(fixture.ctx, fixture.store)
				}
				_, err = invoke()
				if !errors.Is(err, errTransitionInterrupted) || stops != 1 || starts != 0 {
					t.Fatalf("interruption = %v (stops=%d starts=%d)", err, stops, starts)
				}
				gotJournal, err := fixture.store.ReadJournal()
				if err != nil || gotJournal.ID != beforeJournal.ID || gotJournal.BackupID != beforeJournal.BackupID {
					t.Fatalf("interrupted journal lost its identity: %#v %v", gotJournal, err)
				}
				if checkpoint == "before" && !reflect.DeepEqual(gotJournal, beforeJournal) {
					t.Fatalf("before-checkpoint changed journal: %#v", gotJournal)
				}
				if checkpoint == "after" && gotJournal.State != release.RollbackRestoring {
					t.Fatalf("after-checkpoint did not retain the durable milestone: %#v", gotJournal)
				}
				if !reflect.DeepEqual(before, lifecycleDatabaseDigests(t, fixture.state)) || !reflect.DeepEqual(backupBefore, lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))) {
					t.Fatal("interruption changed the live or backed-up database pair")
				}
				selector := filepath.Join(fixture.runtime, "bin", "jobctrl")
				env := append(append([]string{}, fixture.ctx.Environment...), "JOBCTRL_TRANSITION_JOURNAL="+journal.ID, "JOBCTRL_TRANSITION_TARGET="+fixture.old.BuildID)
				_, selected, gateErr := transitionSelectorPayload(selector, env)
				if checkpoint == "before" || revoked {
					if gateErr == nil {
						t.Fatal("selector admitted the predecessor before authorization or despite revocation")
					}
				} else if gateErr != nil || selected == nil || selected.BuildID != fixture.old.BuildID {
					t.Fatalf("durable milestone did not bind the predecessor: %#v %v", selected, gateErr)
				}
				// Selector authorization alone does not prove the pair was restored;
				// no payload executes until the normal recovery reaches its startup.
				recoveryRestoringCheckpoint = nil
				if checkpoint == "after" {
					_, err := invoke()
					if err == nil || !strings.Contains(err.Error(), "automatic recovery is unavailable") || stops != 1 || starts != 0 {
						t.Fatalf("uncertain retry = %v (stops=%d starts=%d)", err, stops, starts)
					}
					if !reflect.DeepEqual(before, lifecycleDatabaseDigests(t, fixture.state)) {
						t.Fatal("uncertain retry changed the live pair")
					}
					return
				}
				target := fixture.old
				if revoked {
					target = fixture.candidate
				}
				startReleaseCommand = startOwnedTransitionSelector(t, fixture, target, &starts)
				recovered, err := invoke()
				if !recovered || err != nil || stops != 2 || starts != 1 {
					t.Fatalf("pre-milestone retry = %v, %v (stops=%d starts=%d)", recovered, err, stops, starts)
				}
				if got := lifecycleDatabaseValues(t, fixture.python, fixture.state); got["jobctrl.db"] != "old-jobctrl.db" || got["temporal.db"] != "old-temporal.db" {
					t.Fatalf("retry did not restore the target pair: %v", got)
				}
			})
		}
	}
}

func TestSpendReceiptAppearingAfterRecoveryMilestoneRefusesRestore(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		name := "ordinary"
		if revoked {
			name = "revoked"
		}
		t.Run(name, func(t *testing.T) {
			preserveSpendLifecycleSeams(t)
			fixture := newSpendLifecycleFixture(t)
			if revoked {
				if _, err := fixture.store.RecordMetadata("local", 3, 0, "policy-control-0003", strings.Repeat("e", 64), []string{fixture.old.BuildID}); err != nil {
					t.Fatal(err)
				}
			}
			journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			journal.BackupID = fixture.pair.ID
			if err := fixture.store.Advance(&journal, release.MetadataVerified, nil); err != nil {
				t.Fatal(err)
			}
			before := lifecycleDatabaseDigests(t, fixture.state)
			backupBefore := lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))
			starts := 0
			var receipt string
			stopForRecoveryCommand = func(launchContext) error { return nil }
			startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
			recoveryRestoringCheckpoint = func(stage string) error {
				if stage == "after" {
					receipt = writeSyntheticSpendReceipt(t, fixture.state)
				}
				return nil
			}
			if revoked {
				_, err = recoverRevokedTransitionBeforePrepare(fixture.ctx.Environment, io.Discard)
			} else {
				_, err = recoverInterruptedTransition(fixture.ctx, fixture.store)
			}
			if !errors.Is(err, errSpendRecoveryUnresolved) || starts != 0 {
				t.Fatalf("late receipt = %v (starts=%d)", err, starts)
			}
			if got, err := os.ReadFile(receipt); err != nil || string(got) != syntheticSpendReceipt {
				t.Fatalf("late receipt changed or disappeared: %v", err)
			}
			if !reflect.DeepEqual(before, lifecycleDatabaseDigests(t, fixture.state)) || !reflect.DeepEqual(backupBefore, lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))) {
				t.Fatal("post-milestone refusal changed a database pair")
			}
			got, err := fixture.store.ReadJournal()
			if err != nil || got.State != release.RollbackRestoring || got.BackupID != fixture.pair.ID {
				t.Fatalf("post-milestone journal = %#v %v", got, err)
			}
		})
	}
}

func TestSpendReceiptAppearingAfterPairRestoreReportsUncertainState(t *testing.T) {
	for _, revoked := range []bool{false, true} {
		name := "ordinary"
		if revoked {
			name = "revoked"
		}
		t.Run(name, func(t *testing.T) {
			preserveSpendLifecycleSeams(t)
			oldRemove := removeSQLiteSidecar
			t.Cleanup(func() { removeSQLiteSidecar = oldRemove })
			fixture := newSpendLifecycleFixture(t)
			if revoked {
				if _, err := fixture.store.RecordMetadata("local", 3, 0, "policy-control-0003", strings.Repeat("e", 64), []string{fixture.old.BuildID}); err != nil {
					t.Fatal(err)
				}
			}
			journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			journal.BackupID = fixture.pair.ID
			if err := fixture.store.Advance(&journal, release.MetadataVerified, nil); err != nil {
				t.Fatal(err)
			}
			backupBefore := lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))
			starts := 0
			var receipt string
			stopForRecoveryCommand = func(launchContext) error { return nil }
			startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
			removeSQLiteSidecar = func(path string) error {
				stateInfo, stateErr := os.Stat(fixture.state)
				parentInfo, parentErr := os.Stat(filepath.Dir(path))
				if stateErr != nil || parentErr != nil || !os.SameFile(stateInfo, parentInfo) {
					t.Fatalf("refusing a non-fixture sidecar path: %s", path)
				}
				if receipt == "" {
					receipt = writeSyntheticSpendReceipt(t, fixture.state)
				}
				return oldRemove(path)
			}
			if revoked {
				_, err = recoverRevokedTransitionBeforePrepare(fixture.ctx.Environment, io.Discard)
			} else {
				_, err = recoverInterruptedTransition(fixture.ctx, fixture.store)
			}
			if !errors.Is(err, errSpendRecoveryUnresolved) || !strings.Contains(err.Error(), "current database pair may already have been replaced") || !strings.Contains(err.Error(), "recovery can be retried depends on the transition state") || starts != 0 {
				t.Fatalf("late recovery refusal = %v (starts=%d)", err, starts)
			}
			if got := lifecycleDatabaseValues(t, fixture.python, fixture.state); got["jobctrl.db"] != "old-jobctrl.db" || got["temporal.db"] != "old-temporal.db" {
				t.Fatalf("fixture did not reach the post-restore boundary: %v", got)
			}
			if !reflect.DeepEqual(backupBefore, lifecycleDatabaseDigests(t, filepath.Join(fixture.state, "backups", fixture.pair.ID))) {
				t.Fatal("late refusal changed the paired backup")
			}
			if got, err := os.ReadFile(receipt); err != nil || string(got) != syntheticSpendReceipt {
				t.Fatalf("late receipt changed or disappeared: %v", err)
			}
			if got, err := fixture.store.ReadJournal(); err != nil || got.BackupID != fixture.pair.ID || !got.Resumable() {
				t.Fatalf("late refusal lost its recovery journal: %#v %v", got, err)
			}
		})
	}
}
