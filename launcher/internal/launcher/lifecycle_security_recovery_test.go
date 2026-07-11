package launcher

import (
	"bytes"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestPolicyFinalizationInterruptionRecoversCandidateBeforeHomebrewBootstrap(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Skip("python3 unavailable")
	}

	runtime, state := t.TempDir(), t.TempDir()
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	old := installLifecycleRelease(t, runtime, "local-old-build-0101", 1, python)
	candidate := installLifecycleRelease(t, runtime, "local-new-build-0102", 2, python)

	// A payload execution marker lets the test distinguish a rejected launch
	// authorization from executing the revoked old launcher. Rebuild the local
	// fixture's immutable manifest and receipt around that marker before
	// selecting it as the initial runtime.
	oldPayload := filepath.Join(runtime, "releases", old.BuildID, "payload")
	oldManifest, err := loadAndVerifyDistributionManifest(oldPayload)
	if err != nil {
		t.Fatal(err)
	}
	oldExecutionMarker := filepath.Join(t.TempDir(), "revoked-old-executed")
	if err := os.WriteFile(
		filepath.Join(oldPayload, "launcher", "jobctrl"),
		[]byte("#!/bin/sh\nprintf old-executed > "+oldExecutionMarker+"\nexit 0\n"),
		0o755,
	); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, oldPayload, &oldManifest)
	writeLocalEnvelope(t, oldPayload, oldManifest)
	old.ManifestSHA256, err = sha256Path(filepath.Join(oldPayload, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := writeJSONAtomic(
		filepath.Join(runtime, "releases", old.BuildID, "receipt.json"),
		selectorReceipt{
			SchemaVersion: old.SchemaVersion, BuildID: old.BuildID, Channel: old.Channel,
			Sequence: int64(old.Sequence), ArtifactSHA256: old.ArtifactSHA256,
			ManifestSHA256: old.ManifestSHA256, DescriptorSHA256: old.DescriptorSHA256,
			PolicySHA256: old.PolicySHA256, DescriptorURL: old.DescriptorURL, InstalledAt: old.InstalledAt,
		},
	); err != nil {
		t.Fatal(err)
	}

	// The authenticated candidate policy raises the safe floor and revokes the
	// predecessor. Promotion must prove candidate health before committing it,
	// then a crash at the durable policy boundary must never execute old code.
	policy := release.ChannelMetadata{
		Channel: candidate.Channel, Sequence: candidate.Sequence, Minimum: candidate.Sequence,
		BuildID: candidate.BuildID, DescriptorDigest: candidate.DescriptorSHA256,
		Revoked: []string{old.BuildID},
	}
	candidate.PolicySHA256 = writeLifecyclePolicy(t, filepath.Join(runtime, "releases", candidate.BuildID, "policy.json"), policy)
	if err := writeJSONAtomic(filepath.Join(runtime, "releases", candidate.BuildID, "receipt.json"), selectorReceipt{
		SchemaVersion: candidate.SchemaVersion, BuildID: candidate.BuildID, Channel: candidate.Channel,
		Sequence: int64(candidate.Sequence), ArtifactSHA256: candidate.ArtifactSHA256,
		ManifestSHA256: candidate.ManifestSHA256, DescriptorSHA256: candidate.DescriptorSHA256,
		PolicySHA256: candidate.PolicySHA256, DescriptorURL: candidate.DescriptorURL, InstalledAt: candidate.InstalledAt,
	}); err != nil {
		t.Fatal(err)
	}
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
	before := lifecycleDatabaseValues(t, python, state)
	environment := []string{
		"HOME=" + t.TempDir(),
		"JOBCTRL_RUNTIME_HOME=" + runtime,
		"JOBCTRL_DIR=" + state,
	}
	ctx := launchContext{
		Instance: instance{
			RuntimeHome: runtime, StateDir: state,
			StatePath:   filepath.Join(state, "missing-state.json"),
			ControlPath: filepath.Join(state, "control.lock"),
		},
		Environment: environment,
	}

	originalStart, originalFailure := startReleaseCommand, transitionFailure
	t.Cleanup(func() { startReleaseCommand, transitionFailure = originalStart, originalFailure })
	candidateStarts, oldStartChecks := 0, 0
	restoredBeforeRetry := false
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, journalID string) error {
		switch receipt.BuildID {
		case candidate.BuildID:
			candidateStarts++
			if journalID == "" {
				t.Fatal("security recovery started the candidate outside its durable journal")
			}
			if candidateStarts == 2 {
				restoredBeforeRetry = sameDatabaseDigests(lifecycleDatabaseValues(t, python, state), before)
			}
			setLifecycleSQLitePair(t, python, state, "candidate")
			return nil
		case old.BuildID:
			oldStartChecks++
			return errors.New("revoked predecessor must never be restarted")
		default:
			t.Fatalf("unexpected release start request: %s", receipt.BuildID)
			return nil
		}
	}
	transitionFailure = func(state release.State) error {
		if state == release.PolicyFinalized {
			return errTransitionInterrupted
		}
		return nil
	}

	err = promoteExisting(
		ctx, store,
		release.Active{
			SchemaVersion: 1, Generation: 1, Receipt: old,
			SelectorBuildID: old.BuildID, Acquisition: "local-fixture",
		},
		candidate.BuildID, "update", io.Discard,
	)
	if !errors.Is(err, errTransitionInterrupted) {
		t.Fatalf("policy-finalization interruption = %v", err)
	}
	transitionFailure = nil
	if candidateStarts != 1 || oldStartChecks != 0 {
		t.Fatalf("interrupted promotion starts candidate=%d old=%d, want 1/0", candidateStarts, oldStartChecks)
	}
	if _, err := os.Lstat(oldExecutionMarker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("revoked predecessor payload executed during recovery: %v", err)
	}
	if err := store.Permit(old); err == nil {
		t.Fatal("revoked predecessor remained permitted after candidate policy finalization")
	}
	journal, err := store.ReadJournal()
	if err != nil || journal.State != release.PolicyFinalized || !journal.Resumable() {
		t.Fatalf("policy-finalization interruption was not durably resumable: %#v, %v", journal, err)
	}
	if got := lifecycleDatabaseValues(t, python, state); got["jobctrl.db"] != "candidatejobctrl.db" || got["temporal.db"] != "candidatetemporal.db" {
		t.Fatalf("healthy candidate did not reach both SQLite databases before interruption: %v", got)
	}

	// Use an intentionally invalid Homebrew bootstrap record. Recovery must run
	// before that frontend is even parsed; the prior ordering would fail here.
	formulaRoot := t.TempDir()
	formulaExecutable := filepath.Join(formulaRoot, "jobctrl")
	if err := os.WriteFile(formulaExecutable, []byte("#!/bin/sh\nexit 0\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(formulaRoot, "homebrew-bootstrap.json"), []byte("not-json\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	// A safe retry is explicit: the public rollback command sees the resumable
	// revoked-predecessor journal, restores the durable pair, and resumes only
	// the still-permitted candidate.
	var output bytes.Buffer
	if err := Run(formulaExecutable, []string{"rollback"}, environment, &output, io.Discard); err != nil {
		t.Fatalf("explicit security recovery through jobctrl rollback: %v", err)
	}
	if !strings.Contains(output.String(), "Recovered the verified security-update candidate") {
		t.Fatalf("security recovery output = %q", output.String())
	}
	if candidateStarts != 2 {
		t.Fatalf("candidate starts = %d, want healthy attempt plus explicit safe recovery", candidateStarts)
	}
	if oldStartChecks != 0 {
		t.Fatalf("security recovery retried the revoked predecessor: checks=%d", oldStartChecks)
	}
	if !restoredBeforeRetry {
		t.Fatal("security recovery did not restore the exact paired database backup before restarting the candidate")
	}
	if _, err := os.Lstat(oldExecutionMarker); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("revoked predecessor payload executed during explicit recovery: %v", err)
	}
	active, err := store.ReadActive()
	if err != nil || active.Receipt != candidate {
		t.Fatalf("explicit security recovery active receipt = %#v, %v", active, err)
	}
	journal, err = store.ReadJournal()
	if err != nil || journal.State != release.Promoted {
		t.Fatalf("explicit security recovery did not close the promotion audit: %#v, %v", journal, err)
	}
	if got := lifecycleDatabaseValues(t, python, state); got["jobctrl.db"] != "candidatejobctrl.db" || got["temporal.db"] != "candidatetemporal.db" {
		t.Fatalf("explicit security recovery did not rerun the candidate against both restored databases: %v", got)
	}
}
