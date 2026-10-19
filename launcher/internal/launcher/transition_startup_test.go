package launcher

import (
	"bytes"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestRunAuthenticatesTransitionStartupBeforeDispatch(t *testing.T) {
	python, err := exec.LookPath("python3")
	if err != nil {
		t.Fatal(err)
	}
	public, private, err := ed25519.GenerateKey(rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	previousChannel, previousKey, previousStart := releaseChannel, releaseTrustKeyBase64, startCommand
	t.Cleanup(func() {
		releaseChannel, releaseTrustKeyBase64, startCommand = previousChannel, previousKey, previousStart
	})
	releaseChannel, releaseTrustKeyBase64 = "stable", base64.StdEncoding.EncodeToString(public)
	sentinel := errors.New("authenticated transition reached start")
	for _, scenario := range []struct {
		name     string
		state    release.State
		args     []string
		journal  string
		selector bool
		old      bool
		tampered bool
		revoked  bool
		allow    bool
	}{
		{name: "candidate", state: release.CandidateStarting, args: []string{"start", "--no-open"}, allow: true},
		{name: "rollback predecessor", state: release.RollbackRestoring, args: []string{"start", "--no-open"}, old: true, allow: true},
		{name: "public selector", state: release.CandidateStarting, args: []string{"start", "--no-open"}, selector: true},
		{name: "wrong journal", state: release.CandidateStarting, args: []string{"start", "--no-open"}, journal: "wrong"},
		{name: "environment flag alone", state: release.CandidateStarting, args: []string{"start", "--no-open"}, journal: "missing"},
		{name: "wrong executable state", state: release.CandidateHealthy, args: []string{"start", "--no-open"}},
		{name: "wrong release", state: release.CandidateStarting, args: []string{"start", "--no-open"}, old: true},
		{name: "wrong manifest receipt", state: release.CandidateStarting, args: []string{"start", "--no-open"}, tampered: true},
		{name: "revoked rollback predecessor", state: release.RollbackRestoring, args: []string{"start", "--no-open"}, old: true, revoked: true},
		{name: "other command", state: release.CandidateStarting, args: []string{"version"}},
		{name: "other start arguments", state: release.CandidateStarting, args: []string{"start", "--foreground"}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			home, state := t.TempDir(), t.TempDir()
			old := newSignedHomebrewBootstrapFixture(t, private, "signed-transition-old-0001", 1, 1, python)
			candidate := newSignedHomebrewBootstrapFixture(t, private, "signed-transition-new-0002", 2, 1, python)
			for _, fixture := range []homebrewBootstrapFixture{old, candidate} {
				if err := stageHomebrewFixture(home, fixture, public); err != nil {
					t.Fatal(err)
				}
			}
			store, err := release.Open(home)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := store.WriteSelectedActive(old.receipt, 0, old.buildID, "homebrew"); err != nil {
				t.Fatal(err)
			}
			verified, err := verifyInstalledReleaseForExecution(store, old.receipt)
			if err != nil {
				t.Fatal(err)
			}
			if err := handoffPublicSelector(home, verified); err != nil {
				t.Fatal(err)
			}
			journal, err := store.Begin("update", &old.receipt, &candidate.receipt, candidate.receipt.DescriptorSHA256)
			if err != nil {
				t.Fatal(err)
			}
			if scenario.tampered {
				journal.Candidate.ManifestSHA256 = strings.Repeat("0", 64)
			}
			if err := store.Advance(&journal, scenario.state, nil); err != nil {
				t.Fatal(err)
			}
			if scenario.revoked {
				if _, err := store.RecordMetadata("stable", 2, 1, candidate.buildID, candidate.receipt.DescriptorSHA256, []string{old.buildID}); err != nil {
					t.Fatal(err)
				}
			}
			journalID := journal.ID
			if scenario.journal == "wrong" {
				journalID = "forged-journal"
			} else if scenario.journal == "missing" {
				journalID = ""
			}
			build := candidate.buildID
			if scenario.old {
				build = old.buildID
			}
			executable := filepath.Join(home, "releases", build, "payload", "launcher", "jobctrl")
			if scenario.selector {
				executable = filepath.Join(home, "bin", "jobctrl")
			}
			calls := 0
			startCommand = func(ctx launchContext, _ []string, _ io.Writer) error {
				calls++
				if ctx.Distribution.BuildID != build {
					t.Fatalf("started %q, wanted %q", ctx.Distribution.BuildID, build)
				}
				return sentinel
			}
			env := []string{"HOME=" + home, "JOBCTRL_RUNTIME_HOME=" + home, "JOBCTRL_DIR=" + state,
				"JOBCTRL_TRANSITION_CANDIDATE=1", "JOBCTRL_TRANSITION_JOURNAL=" + journalID}
			var output bytes.Buffer
			err = Run(executable, scenario.args, env, &output, &output)
			if scenario.allow {
				if !errors.Is(err, sentinel) || calls != 1 {
					t.Fatalf("authorized startup was blocked: calls=%d, err=%v", calls, err)
				}
			} else if err == nil || errors.Is(err, sentinel) || calls != 0 {
				t.Fatalf("unauthorized startup reached dispatch: calls=%d, err=%v", calls, err)
			}
		})
	}
}
