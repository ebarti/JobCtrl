package launcher

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// writePolicyBoundLifecycleReceipt rewrites the release-local, immutable
// policy evidence together.  Tests that subsequently alter policy.json leave
// this receipt untouched, which is the hostile-disk condition a launcher must
// reject before it can start or promote that release.
func writePolicyBoundLifecycleReceipt(t *testing.T, runtime string, receipt *release.Receipt, policy release.ChannelMetadata) {
	t.Helper()
	receipt.SchemaVersion = 2
	receipt.PolicySHA256 = writeLifecyclePolicy(t, filepath.Join(runtime, "releases", receipt.BuildID, "policy.json"), policy)
	if err := writeJSONAtomic(filepath.Join(runtime, "releases", receipt.BuildID, "receipt.json"), selectorReceipt{
		SchemaVersion: receipt.SchemaVersion, BuildID: receipt.BuildID, Channel: receipt.Channel,
		Sequence: int64(receipt.Sequence), ArtifactSHA256: receipt.ArtifactSHA256,
		ManifestSHA256: receipt.ManifestSHA256, DescriptorSHA256: receipt.DescriptorSHA256,
		PolicySHA256: receipt.PolicySHA256, DescriptorURL: receipt.DescriptorURL, InstalledAt: receipt.InstalledAt,
	}); err != nil {
		t.Fatal(err)
	}
}

func TestP5PolicyTamperingFailsBeforePromotion(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}

	for _, mutation := range []struct {
		name   string
		mutate func(release.ChannelMetadata) release.ChannelMetadata
	}{
		{
			name: "lowered minimum safe sequence",
			mutate: func(policy release.ChannelMetadata) release.ChannelMetadata {
				policy.Minimum = 0
				return policy
			},
		},
		{
			name: "removed predecessor revocation",
			mutate: func(policy release.ChannelMetadata) release.ChannelMetadata {
				policy.Revoked = nil
				return policy
			},
		},
	} {
		t.Run(mutation.name, func(t *testing.T) {
			runtime, state := t.TempDir(), t.TempDir()
			store, err := release.Open(runtime)
			if err != nil {
				t.Fatal(err)
			}
			old := installLifecycleRelease(t, runtime, "local-policy-old-0001", 1, python)
			candidate := installLifecycleRelease(t, runtime, "local-policy-new-0002", 2, python)
			policy := release.ChannelMetadata{
				Channel: candidate.Channel, Sequence: candidate.Sequence, Minimum: candidate.Sequence,
				BuildID: candidate.BuildID, DescriptorDigest: candidate.DescriptorSHA256,
				Revoked: []string{old.BuildID},
			}
			writePolicyBoundLifecycleReceipt(t, runtime, &candidate, policy)
			if _, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture"); err != nil {
				t.Fatal(err)
			}
			verifiedOld, err := verifyInstalledReleaseForExecution(store, old)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(runtime, verifiedOld); err != nil {
				t.Fatal(err)
			}
			if _, err := verifyInstalledReleaseForExecution(store, candidate); err != nil {
				t.Fatalf("receipt-bound policy was not initially executable: %v", err)
			}

			// This write changes only policy.json.  An attacker who can modify the
			// install directory must not be able to lower the floor or discard a
			// revocation without also changing the receipt-bound digest.
			if err := writeJSONAtomic(filepath.Join(runtime, "releases", candidate.BuildID, "policy.json"), mutation.mutate(policy)); err != nil {
				t.Fatal(err)
			}
			if _, err := verifyInstalledReleaseForExecution(store, candidate); err == nil || !strings.Contains(err.Error(), "policy") {
				t.Fatalf("tampered policy passed immediate candidate execution verification: %v", err)
			}

			oldStart, oldFailure := startReleaseCommand, transitionFailure
			t.Cleanup(func() { startReleaseCommand, transitionFailure = oldStart, oldFailure })
			starts := 0
			startReleaseCommand = func(_ launchContext, _ release.Receipt, _ string) error {
				starts++
				return nil
			}
			ctx := launchContext{Instance: instance{
				RuntimeHome: runtime, StateDir: state, StatePath: filepath.Join(state, "state.json"), ControlPath: filepath.Join(state, "control.lock"),
			}, Environment: []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime, "JOBCTRL_DIR=" + state}}
			err = promoteExisting(ctx, store, release.Active{SchemaVersion: 1, Generation: 1, Receipt: old, SelectorBuildID: old.BuildID, Acquisition: "local-fixture"}, candidate.BuildID, "update", io.Discard)
			if err == nil || !strings.Contains(err.Error(), "candidate is not safe to promote") {
				t.Fatalf("tampered policy reached promotion: %v", err)
			}
			if starts != 0 {
				t.Fatalf("tampered policy started a release before promotion was rejected: starts=%d", starts)
			}
			if active, activeErr := store.ReadActive(); activeErr != nil || active.Receipt != old {
				t.Fatalf("tampered policy changed active release before promotion: %#v, %v", active, activeErr)
			}
			if _, journalErr := store.ReadJournal(); !errors.Is(journalErr, os.ErrNotExist) {
				t.Fatalf("tampered policy created a transition journal before rejection: %v", journalErr)
			}
			if err := store.Permit(old); err != nil {
				t.Fatalf("uncommitted tampered candidate policy changed predecessor permission: %v", err)
			}
		})
	}
}

type promotionBoundaryFixture struct {
	runtime   string
	state     string
	store     *release.Store
	old       release.Receipt
	candidate release.Receipt
	ctx       launchContext
	env       []string
}

func newPromotionBoundaryFixture(t *testing.T, python string) promotionBoundaryFixture {
	t.Helper()
	runtime, state := t.TempDir(), t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	old := installLifecycleRelease(t, runtime, "local-boundary-old-0001", 1, python)
	candidate := installLifecycleRelease(t, runtime, "local-boundary-new-0002", 2, python)
	writePolicyBoundLifecycleReceipt(t, runtime, &candidate, release.ChannelMetadata{
		Channel: candidate.Channel, Sequence: candidate.Sequence, Minimum: candidate.Sequence,
		BuildID: candidate.BuildID, DescriptorDigest: candidate.DescriptorSHA256,
		Revoked: []string{old.BuildID},
	})
	if _, err := store.WriteSelectedActive(old, 0, old.BuildID, "local-fixture"); err != nil {
		t.Fatal(err)
	}
	verifiedOld, err := verifyInstalledReleaseForExecution(store, old)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(runtime, verifiedOld); err != nil {
		t.Fatal(err)
	}
	seedLifecycleSQLitePair(t, python, state, "old")
	env := []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime, "JOBCTRL_DIR=" + state}
	return promotionBoundaryFixture{
		runtime: runtime, state: state, store: store, old: old, candidate: candidate, env: env,
		ctx: launchContext{Instance: instance{RuntimeHome: runtime, StateDir: state, StatePath: filepath.Join(state, "missing-state.json"), ControlPath: filepath.Join(state, "control.lock")}, Environment: env},
	}
}

func snapshotPromotionBoundaryFiles(t *testing.T, fixture promotionBoundaryFixture) map[string]string {
	t.Helper()
	result := make(map[string]string)
	record := func(path string) error {
		digest, err := sha256Path(path)
		if err != nil {
			return err
		}
		result[path] = digest
		return nil
	}
	if err := filepath.WalkDir(fixture.state, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			return record(path)
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(fixture.runtime, release.ActiveFile), filepath.Join(fixture.runtime, release.JournalFile), filepath.Join(fixture.runtime, "bin", "jobctrl")} {
		if err := record(path); err != nil {
			t.Fatal(err)
		}
	}
	return result
}

// This exercises the actual promotion transaction at each durable activation
// milestone—not just advance's journal write. Before the paired backup,
// recovery may restart the predecessor. Once the backup is durable, a later
// independent writer makes automatic restoration unsafe, even after revocation.
func TestP5PromotionRecoveryRespectsEveryActivationBoundary(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	cases := []struct {
		state      release.State
		postPolicy bool
		terminal   bool
	}{
		{state: release.MetadataVerified},
		{state: release.ReleaseCommitted},
		{state: release.SelectorHandoffPending},
		{state: release.SelectorReplaced},
		{state: release.Quiescing},
		{state: release.PairBackedUp},
		{state: release.PolicyPending},
		{state: release.CandidateStarting},
		{state: release.CandidateHealthy},
		{state: release.PolicyFinalized, postPolicy: true},
		{state: release.Promoted, postPolicy: true, terminal: true},
	}
	for _, testCase := range cases {
		t.Run(string(testCase.state), func(t *testing.T) {
			fixture := newPromotionBoundaryFixture(t, python)
			oldStart, oldFailure := startReleaseCommand, transitionFailure
			t.Cleanup(func() { startReleaseCommand, transitionFailure = oldStart, oldFailure })
			oldStarts, candidateStarts := 0, 0
			startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
				if journalID == "" {
					t.Fatal("promotion/recovery execution was not bound to a durable journal")
				}
				switch receipt.BuildID {
				case fixture.old.BuildID:
					oldStarts++
				case fixture.candidate.BuildID:
					candidateStarts++
					setLifecycleSQLitePair(t, python, fixture.state, "candidate")
				default:
					t.Fatalf("unexpected release execution %q", receipt.BuildID)
				}
				return nil
			}
			transitionFailure = func(state release.State) error {
				if state == testCase.state {
					return errTransitionInterrupted
				}
				return nil
			}

			err := promoteExisting(fixture.ctx, fixture.store, release.Active{
				SchemaVersion: 1, Generation: 1, Receipt: fixture.old,
				SelectorBuildID: fixture.old.BuildID, Acquisition: "local-fixture",
			}, fixture.candidate.BuildID, "update", io.Discard)
			if !errors.Is(err, errTransitionInterrupted) {
				t.Fatalf("promotion interruption at %s = %v", testCase.state, err)
			}
			transitionFailure = nil
			journal, err := fixture.store.ReadJournal()
			if err != nil {
				t.Fatalf("read durable boundary %s: %v", testCase.state, err)
			}
			if journal.State != testCase.state {
				t.Fatalf("durable boundary %s was not retained: %#v", testCase.state, journal)
			}
			if !testCase.terminal && journal.BackupID != "" {
				if !journal.PreserveLiveOnFailure || !journal.Resumable() {
					t.Fatalf("boundary %s did not retain a resumable preservation fence: %#v", testCase.state, journal)
				}
				pairPath := filepath.Join(fixture.state, "backups", journal.BackupID)
				var pair databasePair
				if err := decodeStrictRegular(filepath.Join(pairPath, "pair.json"), &pair); err != nil || pair.ReleaseReceipt != fixture.old {
					t.Fatalf("boundary %s lost the verified predecessor pair: %#v, %v", testCase.state, pair, err)
				}
				if got := lifecycleDatabaseValues(t, python, pairPath); got["jobctrl.db"] != "oldjobctrl.db" || got["temporal.db"] != "oldtemporal.db" {
					t.Fatalf("boundary %s changed the paired backup: %v", testCase.state, got)
				}
				// An independent writer commits after the backup. Both commits and
				// every owned artifact must survive repeated refusal.
				setLifecycleSQLitePair(t, python, fixture.state, "later")
				if got := lifecycleDatabaseValues(t, python, fixture.state); got["jobctrl.db"] != "laterjobctrl.db" || got["temporal.db"] != "latertemporal.db" {
					t.Fatalf("independent writes not committed: %v", got)
				}
				before := snapshotPromotionBoundaryFiles(t, fixture)
				previousCandidateStarts := candidateStarts
				for attempt := 0; attempt < 2; attempt++ {
					var handled bool
					var recoverErr error
					if testCase.postPolicy {
						handled, recoverErr = recoverRevokedTransitionBeforePrepare(fixture.env, io.Discard)
						if !handled {
							t.Fatalf("revoked recovery was not handled at %s", testCase.state)
						}
					} else {
						handled, recoverErr = recoverInterruptedTransition(fixture.ctx, fixture.store)
						if handled {
							t.Fatalf("unsafe recovery reported success at %s", testCase.state)
						}
					}
					if recoverErr == nil || !strings.Contains(recoverErr.Error(), "retain the live databases") || !strings.Contains(recoverErr.Error(), "automatic recovery is unavailable") {
						t.Fatalf("boundary %s recovery attempt %d = %v", testCase.state, attempt, recoverErr)
					}
					if after := snapshotPromotionBoundaryFiles(t, fixture); !reflect.DeepEqual(before, after) {
						t.Fatalf("boundary %s recovery changed the live pair, companions, backup, journal or release selection", testCase.state)
					}
				}
				if oldStarts != 0 || candidateStarts != previousCandidateStarts {
					t.Fatalf("boundary %s recovery started a release: old=%d candidate=%d", testCase.state, oldStarts, candidateStarts)
				}
				return
			}

			if !testCase.postPolicy {
				if err := fixture.store.Permit(fixture.old); err != nil {
					t.Fatalf("pre-policy boundary %s revoked predecessor: %v", testCase.state, err)
				}

				recovered, recoverErr := recoverInterruptedTransition(fixture.ctx, fixture.store)
				if !recovered || recoverErr != nil {
					t.Fatalf("pre-policy recovery at %s = recovered:%v err:%v", testCase.state, recovered, recoverErr)
				}
				active, activeErr := fixture.store.ReadActive()
				if activeErr != nil || active.Receipt != fixture.old {
					t.Fatalf("pre-policy recovery at %s did not restore prior release: %#v, %v", testCase.state, active, activeErr)
				}
				if oldStarts != 1 {
					t.Fatalf("pre-policy recovery at %s did not make predecessor runnable exactly once: old starts=%d", testCase.state, oldStarts)
				}
				if _, err := verifyInstalledReleaseForExecution(fixture.store, fixture.old); err != nil {
					t.Fatalf("pre-policy recovery at %s left predecessor unverifiable: %v", testCase.state, err)
				}
				return
			}

			if err := fixture.store.Permit(fixture.old); err == nil {
				t.Fatalf("post-policy boundary %s left revoked predecessor permitted", testCase.state)
			}
			if _, err := verifyInstalledReleaseForExecution(fixture.store, fixture.candidate); err != nil {
				t.Fatalf("post-policy boundary %s did not retain authenticated candidate: %v", testCase.state, err)
			}
			if testCase.terminal {
				if journal.Resumable() {
					t.Fatalf("terminal post-policy boundary %s remained resumable", testCase.state)
				}
				active, activeErr := fixture.store.ReadActive()
				if activeErr != nil || active.Receipt != fixture.candidate {
					t.Fatalf("terminal post-policy boundary did not select candidate: %#v, %v", active, activeErr)
				}
				if oldStarts != 0 || candidateStarts != 1 {
					t.Fatalf("terminal post-policy boundary executed wrong releases: old=%d candidate=%d", oldStarts, candidateStarts)
				}
				return
			}

			t.Fatalf("unhandled post-policy boundary %s", testCase.state)
		})
	}
}

func TestP5RevokedActiveCanUninstallWithoutPayloadExecution(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	runtime, state := t.TempDir(), t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	active := installLifecycleRelease(t, runtime, "local-revoked-active-0001", 1, python)

	// Keep the release self-consistent while making an accidental payload exec
	// observable.  The fail-closed uninstall path must never create this marker.
	payload := filepath.Join(runtime, "releases", active.BuildID, "payload")
	manifest, err := loadAndVerifyDistributionManifest(payload)
	if err != nil {
		t.Fatal(err)
	}
	marker := filepath.Join(t.TempDir(), "payload-executed")
	if err := os.WriteFile(filepath.Join(payload, "launcher", "jobctrl"), []byte("#!/bin/sh\nprintf executed > "+marker+"\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, payload, &manifest)
	writeLocalEnvelope(t, payload, manifest)
	active.ManifestSHA256, err = sha256Path(filepath.Join(payload, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(filepath.Join(runtime, "releases", active.BuildID, "receipt.json"), selectorReceipt{
		SchemaVersion: active.SchemaVersion, BuildID: active.BuildID, Channel: active.Channel,
		Sequence: int64(active.Sequence), ArtifactSHA256: active.ArtifactSHA256,
		ManifestSHA256: active.ManifestSHA256, DescriptorSHA256: active.DescriptorSHA256,
		PolicySHA256: active.PolicySHA256, DescriptorURL: active.DescriptorURL, InstalledAt: active.InstalledAt,
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := store.WriteSelectedActive(active, 0, active.BuildID, "local-fixture"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.RecordMetadata(active.Channel, 2, 0, "local-safe-build-0002", strings.Repeat("e", 64), []string{active.BuildID}); err != nil {
		t.Fatal(err)
	}
	if err := store.Permit(active); err == nil {
		t.Fatal("fixture did not revoke active release")
	}
	profile := filepath.Join(state, "profile.json")
	if err := os.WriteFile(profile, []byte("private local data"), 0o600); err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime, "JOBCTRL_DIR=" + state}
	var output bytes.Buffer
	if err := Run(filepath.Join(runtime, "bin", "jobctrl"), []string{"uninstall"}, env, &output, io.Discard); err != nil {
		t.Fatalf("revoked active uninstall = %v", err)
	}
	if _, err := os.Lstat(marker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uninstall executed revoked payload: %v", err)
	}
	if raw, err := os.ReadFile(profile); err != nil || string(raw) != "private local data" {
		t.Fatalf("default revoked-release uninstall changed user data: %q, %v", raw, err)
	}
	if _, err := os.Lstat(filepath.Join(runtime, "releases")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uninstall did not remove revoked runtime releases: %v", err)
	}
	if !strings.Contains(output.String(), "local data and capability profiles were preserved") {
		t.Fatalf("uninstall did not report default data preservation: %q", output.String())
	}
}

func TestP5OrdinaryHomebrewRollbackRecoversBeforeFormulaBootstrap(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	fixture := newPromotionBoundaryFixture(t, python)
	selected, err := fixture.store.ReadActive()
	if err != nil {
		t.Fatal(err)
	}
	selected, err = fixture.store.WriteSelectedActive(fixture.old, selected.Generation, fixture.old.BuildID, "homebrew")
	if err != nil {
		t.Fatal(err)
	}
	oldStart, oldFailure := startReleaseCommand, transitionFailure
	t.Cleanup(func() { startReleaseCommand, transitionFailure = oldStart, oldFailure })
	oldStarts := 0
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
		if receipt != fixture.old || journalID == "" {
			t.Fatalf("ordinary recovery executed unexpected release %#v journal=%q", receipt, journalID)
		}
		oldStarts++
		return nil
	}
	transitionFailure = func(state release.State) error {
		if state == release.MetadataVerified {
			return errTransitionInterrupted
		}
		return nil
	}
	err = promoteExisting(fixture.ctx, fixture.store, selected, fixture.candidate.BuildID, "update", io.Discard)
	if !errors.Is(err, errTransitionInterrupted) {
		t.Fatalf("ordinary Homebrew interruption = %v", err)
	}
	transitionFailure = nil

	// If formula bootstrap runs first it will reject this intentionally invalid
	// configuration. The durable ordinary journal must take precedence.
	formulaRoot := t.TempDir()
	formulaExecutable := filepath.Join(formulaRoot, "jobctrl")
	if err := os.WriteFile(formulaExecutable, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(formulaRoot, "homebrew-bootstrap.json"), []byte("not-json\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	var output bytes.Buffer
	if err := Run(formulaExecutable, []string{"rollback"}, fixture.env, &output, io.Discard); err != nil {
		t.Fatalf("ordinary Homebrew rollback through public Run: %v", err)
	}
	if oldStarts != 1 || !strings.Contains(output.String(), "restored to its previous release") {
		t.Fatalf("ordinary Homebrew recovery oldStarts=%d output=%q", oldStarts, output.String())
	}
	active, err := fixture.store.ReadActive()
	if err != nil || active.Receipt != fixture.old || active.Acquisition != "homebrew" {
		t.Fatalf("ordinary Homebrew recovery active=%#v err=%v", active, err)
	}
	journal, err := fixture.store.ReadJournal()
	if err != nil || journal.State != release.RolledBack || journal.Resumable() {
		t.Fatalf("ordinary Homebrew recovery journal=%#v err=%v", journal, err)
	}
}

func TestPendingBridgeRefusesFailClosedUninstallAtPublicEntry(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}
	runtime, state := t.TempDir(), t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	active := installLifecycleRelease(t, runtime, "local-bridge-source-0001", 1, python)
	if _, err := store.WriteSelectedActive(active, 0, active.BuildID, "local-fixture"); err != nil {
		t.Fatal(err)
	}
	// Missing selector routes the public command through fail-closed uninstall.
	if err := os.WriteFile(filepath.Join(runtime, "bridge-handoff.json"), []byte("synthetic pending handoff"), 0o600); err != nil {
		t.Fatal(err)
	}
	profile := filepath.Join(state, "profile.json")
	if err := os.WriteFile(profile, []byte("synthetic profile"), 0o600); err != nil {
		t.Fatal(err)
	}
	activePath := filepath.Join(runtime, release.ActiveFile)
	before, err := os.ReadFile(activePath)
	if err != nil {
		t.Fatal(err)
	}
	env := []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + runtime, "JOBCTRL_DIR=" + state}
	var output bytes.Buffer
	if err := Run(filepath.Join(runtime, "bin", "jobctrl"), []string{"uninstall"}, env, &output, io.Discard); err == nil || !strings.Contains(err.Error(), "bridge handoff") {
		t.Fatalf("public uninstall did not refuse: %v", err)
	}
	if after, err := os.ReadFile(activePath); err != nil || !bytes.Equal(after, before) {
		t.Fatalf("active changed: %v", err)
	}
	if after, err := os.ReadFile(profile); err != nil || string(after) != "synthetic profile" {
		t.Fatalf("profile changed: %q %v", after, err)
	}
	if _, err := os.Stat(filepath.Join(runtime, "releases", active.BuildID, "payload")); err != nil {
		t.Fatalf("release removed: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(runtime, "bridge-handoff.json")); err != nil {
		t.Fatalf("handoff removed: %v", err)
	}
}
