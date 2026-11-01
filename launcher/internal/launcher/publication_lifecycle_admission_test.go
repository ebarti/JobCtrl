package launcher

import (
	"bytes"
	"errors"
	"io"
	"os"
	"path/filepath"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestNativeLifecycleRefusesUnresolvedPublicationWithoutMutation(t *testing.T) {
	fixture := newV6ActivationFixture(t)
	pair, err := snapshotPair(fixture.ctx, fixture.old)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := fixture.store.Begin("update", &fixture.old, &fixture.candidate, fixture.candidate.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	journal.BackupID = pair.ID
	if err := fixture.store.Advance(&journal, release.PairBackedUp, nil); err != nil {
		t.Fatal(err)
	}
	live := filepath.Join(fixture.state, "jobctrl.db")
	stage := filepath.Join(fixture.state, ".jobctrl-init-synthetic")
	if err := os.Mkdir(stage, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(live, filepath.Join(stage, "candidate.db")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(live+"-wal", []byte("unfamiliar companion"), 0600); err != nil {
		t.Fatal(err)
	}
	beforeDB, err := os.ReadFile(live)
	if err != nil {
		t.Fatal(err)
	}
	beforeJournal, err := fixture.store.ReadJournal()
	if err != nil {
		t.Fatal(err)
	}
	starts := 0
	oldStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = oldStart })
	startReleaseCommand = func(launchContext, release.Receipt, string) error { starts++; return nil }
	if recovered, err := recoverInterruptedTransition(fixture.ctx, fixture.store); recovered || !errors.Is(err, errUnresolvedDatabasePublication) {
		t.Fatalf("recovery = %v, %v", recovered, err)
	}
	afterJournal, err := fixture.store.ReadJournal()
	if err != nil || afterJournal.State != beforeJournal.State || afterJournal.ID != beforeJournal.ID {
		t.Fatalf("journal changed: before=%+v after=%+v err=%v", beforeJournal, afterJournal, err)
	}
	for name, call := range map[string]func() error{
		"start":          func() error { return executeStart(fixture.ctx, []string{"--no-open"}, io.Discard) },
		"update":         func() error { return update(fixture.ctx, []string{"--to", fixture.candidate.BuildID}, io.Discard) },
		"rollback":       func() error { return rollback(fixture.ctx, []string{"--to", fixture.old.BuildID}, io.Discard) },
		"backup":         func() error { return backup(fixture.ctx, nil, io.Discard) },
		"restore":        func() error { return restorePair(fixture.ctx, pair) },
		"selected start": func() error { return startSelectedRelease(fixture.ctx) },
		"direct promotion": func() error {
			return promoteExisting(fixture.ctx, fixture.store, fixture.active, fixture.candidate.BuildID, "update", io.Discard)
		},
		"direct rollback": func() error {
			return rollbackExisting(fixture.ctx, fixture.store, fixture.active, fixture.old.BuildID, io.Discard)
		},
	} {
		if err := call(); !errors.Is(err, errUnresolvedDatabasePublication) {
			t.Errorf("%s did not fail closed: %v", name, err)
		}
	}
	if starts != 0 {
		t.Errorf("started an older runtime %d times", starts)
	}
	afterDB, err := os.ReadFile(live)
	if err != nil || !bytes.Equal(beforeDB, afterDB) {
		t.Errorf("live DB changed: %v", err)
	}
	if got, err := os.ReadFile(live + "-wal"); err != nil || string(got) != "unfamiliar companion" {
		t.Errorf("WAL changed: %q %v", got, err)
	}
}
