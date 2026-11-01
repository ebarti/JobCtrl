package launcher

import (
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func TestHomebrewBootstrapNotarizationPrecedesInstallerExecution(t *testing.T) {
	for _, failure := range []string{"jobctrl", "jobctrl-installer", ""} {
		t.Run("reject-"+failure, func(t *testing.T) {
			public, private, err := ed25519.GenerateKey(rand.Reader)
			if err != nil {
				t.Fatal(err)
			}
			setSignedHomebrewTrust(t, public)
			fixture := newSignedHomebrewBootstrapFixture(t, private, "notarization-boundary-0001", 3, 1, "/usr/bin/python3")
			root, home := t.TempDir(), t.TempDir()
			root, err = filepath.EvalSymlinks(root)
			if err != nil {
				t.Fatal(err)
			}
			executable := writeHomebrewBootstrapFormula(t, root, fixture)
			previousSign, previousInstaller := homebrewCodeSignCommand, homebrewInstallerCommand
			t.Cleanup(func() { homebrewCodeSignCommand, homebrewInstallerCommand = previousSign, previousInstaller })
			var events []string
			homebrewCodeSignCommand = func(command string, args ...string) (string, error) {
				if command != "/usr/bin/codesign" || len(args) != 6 || !reflect.DeepEqual(args[:5], []string{"--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=2"}) {
					t.Fatalf("missing strict notarized requirement: %s %q", command, args)
				}
				name := filepath.Base(args[5])
				if args[5] != filepath.Join(root, name) {
					t.Fatal("verified a different bootstrap path")
				}
				events = append(events, name)
				if name == failure {
					return "not notarized", errors.New("rejected by Apple policy")
				}
				return "", nil
			}
			boundary := errors.New("verified installer boundary reached")
			homebrewInstallerCommand = func(_ string, _ []string, _ []string) (string, error) {
				events = append(events, "execute-installer")
				return "", boundary
			}
			handled, err := maybeHomebrewBootstrap(executable, []string{"version"}, []string{"HOME=" + t.TempDir(), "JOBCTRL_RUNTIME_HOME=" + home}, io.Discard, io.Discard)
			if !handled || err == nil {
				t.Fatalf("bootstrap = %v, %v", handled, err)
			}
			want := []string{"jobctrl", "jobctrl-installer", "execute-installer"}
			if failure != "" {
				if !strings.Contains(err.Error(), "notarization verification failed for "+failure) {
					t.Fatalf("untrusted bootstrap reached installer: %v (events %v)", err, events)
				}
				want = want[:2]
				if failure == "jobctrl" {
					want = want[:1]
				}
			} else if !errors.Is(err, boundary) {
				t.Fatalf("verified bootstrap did not reach installer: %v", err)
			}
			if !reflect.DeepEqual(events, want) {
				t.Fatalf("trust boundary order = %v, want %v", events, want)
			}
			store, _ := release.Open(home)
			if _, err := store.ReadActive(); !errors.Is(err, os.ErrNotExist) {
				t.Fatalf("bootstrap selected unverified payload: %v", err)
			}
		})
	}
}
