package installer

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/launcher"
)

func bridgeNetworkFixture(t *testing.T) (signedBridgeFixture, string, map[string][]byte) {
	t.Helper()
	f := newSignedBridgeFixture(t, 2, false)
	read := func(path string) []byte {
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		return data
	}
	roleURL := "https://releases.jobctrl.dev/v1/artifacts/bridge-build-0002/reviewed-role.json"
	var descriptor Descriptor
	descriptorRaw := read(f.input.DescriptorPath)
	if err := json.Unmarshal(descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	return f, roleURL, map[string][]byte{
		f.input.DescriptorURL:          descriptorRaw,
		f.input.DescriptorURL + ".sig": read(f.input.DescriptorSignaturePath),
		roleURL:                        read(f.input.AttestationPath),
		roleURL + ".sig":               read(f.input.AttestationSignaturePath),
		descriptor.Artifact.URL:        read(f.input.ArchivePath),
	}
}

func TestNetworkBridgeAuthenticatesAndHandsOff(t *testing.T) {
	f, roleURL, responses := bridgeNetworkFixture(t)
	var descriptor Descriptor
	if err := json.Unmarshal(responses[f.input.DescriptorURL], &descriptor); err != nil {
		t.Fatal(err)
	}
	f.options.HTTPClient, _ = channelPointerClient(responses)
	for _, name := range []string{"jobctrl.db", "jobctrl.db-wal", "temporal.db"} {
		if err := os.WriteFile(filepath.Join(f.options.Home, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	receipt, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL)
	if err != nil || receipt.BuildID != descriptor.BuildID {
		t.Fatalf("handoff: %+v %v", receipt, err)
	}
	active, err := f.store.ReadActive()
	if err != nil || active.Receipt.BuildID != descriptor.BuildID {
		t.Fatalf("selection: %+v %v", active, err)
	}
	for _, name := range []string{"jobctrl.db", "jobctrl.db-wal", "temporal.db"} {
		bytes, err := os.ReadFile(filepath.Join(f.options.Home, name))
		if err != nil || string(bytes) != name {
			t.Fatalf("changed %s: %s %v", name, bytes, err)
		}
	}
	var retries map[string]int
	f.options.HTTPClient, retries = channelPointerClient(nil)
	cache, unlock, err := bridgeDownloadCache(f.options.Home, receipt.DescriptorSHA256)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, stagedArchiveName), []byte("synthetic retained archive"), 0600); err != nil {
		t.Fatal(err)
	}
	unlock()
	again, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL)
	if err != nil || again != receipt {
		t.Fatalf("offline completed retry: %+v %v", again, err)
	}
	if len(retries) != 0 {
		t.Fatalf("completed retry used network: %v", retries)
	}
	if _, err := os.Lstat(cache); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("completed retry retained owned cache: %v", err)
	}
}

func TestNetworkBridgeRejectsUntrustedRoleBeforeArchive(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*signedBridgeFixture, map[string][]byte, string)
	}{
		{"forged", func(_ *signedBridgeFixture, responses map[string][]byte, role string) {
			responses[role+".sig"] = []byte("{}")
		}},
		{"wrong-source", func(f *signedBridgeFixture, responses map[string][]byte, role string) {
			claim := f.claim
			claim.PredecessorDescriptorSHA256 = claim.CandidateDescriptorSHA256
			raw, _ := json.Marshal(claim)
			sig, _ := json.Marshal(bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, signingMessage("jobctrl:bridge-attestation:v1\x00", raw)))})
			responses[role], responses[role+".sig"] = raw, sig
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			f, roleURL, responses := bridgeNetworkFixture(t)
			var descriptor Descriptor
			if err := json.Unmarshal(responses[f.input.DescriptorURL], &descriptor); err != nil {
				t.Fatal(err)
			}
			test.mutate(&f, responses, roleURL)
			var requests map[string]int
			f.options.HTTPClient, requests = channelPointerClient(responses)
			if _, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL); err == nil {
				t.Fatal("untrusted role accepted")
			}
			if requests[descriptor.Artifact.URL] != 0 {
				t.Fatal("archive fetched before role authentication")
			}
			active, err := f.store.ReadActive()
			if err != nil || active != f.source {
				t.Fatalf("changed active: %+v %v", active, err)
			}
		})
	}
}

func TestNetworkBridgeRejectsNoncanonicalRoleBeforeNetwork(t *testing.T) {
	for _, role := range []string{
		"https://attacker.example/v1/artifacts/bridge-build-0002/role.json",
		"https://releases.jobctrl.dev/v1/artifacts/other-build-0003/role.json",
		"https://releases.jobctrl.dev/v1/artifacts/bridge-build-0002/../role.json",
		"https://releases.jobctrl.dev/v1/artifacts/bridge-build-0002/role.json?x=1",
	} {
		f, _, _ := bridgeNetworkFixture(t)
		var requests map[string]int
		f.options.HTTPClient, requests = channelPointerClient(nil)
		if _, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, role); err == nil {
			t.Fatal("noncanonical role accepted")
		}
		if len(requests) != 0 {
			t.Fatalf("unexpected network requests: %v", requests)
		}
	}
}

func TestNetworkBridgeRecoversOfflineFromRetainedEvidence(t *testing.T) {
	f, roleURL, _ := bridgeNetworkFixture(t)
	store, evidence, err := prepareSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := errors.New("interrupted")
	if err := bridgeSelection(store, evidence, func(stage string) error {
		if stage == "active" {
			return interrupted
		}
		return nil
	}); !errors.Is(err, interrupted) {
		t.Fatalf("interruption: %v", err)
	}
	var requests map[string]int
	f.options.HTTPClient, requests = channelPointerClient(nil)
	cache, unlock, err := bridgeDownloadCache(f.options.Home, digestBytes(mustReadNetworkTest(t, f.input.DescriptorPath)))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, stagedArchiveName), []byte("synthetic retained archive"), 0600); err != nil {
		t.Fatal(err)
	}
	unlock()
	if _, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL); err != nil {
		t.Fatalf("offline recovery: %v", err)
	}
	if len(requests) != 0 {
		t.Fatalf("recovery used network: %v", requests)
	}
	if _, err := os.Lstat(cache); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("recovery retained owned cache: %v", err)
	}
}

func mustReadNetworkTest(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func TestNetworkBridgeRefusesDifferentPendingDescriptorOffline(t *testing.T) {
	f, _, _ := bridgeNetworkFixture(t)
	store, evidence, err := prepareSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := errors.New("interrupted")
	if err := bridgeSelection(store, evidence, func(stage string) error {
		if stage == "active" {
			return interrupted
		}
		return nil
	}); !errors.Is(err, interrupted) {
		t.Fatal(err)
	}
	var requests map[string]int
	f.options.HTTPClient, requests = channelPointerClient(nil)
	otherDescriptor := "https://releases.jobctrl.dev/v1/artifacts/other-build-0003/release-descriptor.json"
	otherRole := "https://releases.jobctrl.dev/v1/artifacts/other-build-0003/role.json"
	if _, err := InstallSignedNetworkBridge(f.options, otherDescriptor, otherRole); err == nil {
		t.Fatal("different pending bridge accepted")
	}
	if len(requests) != 0 {
		t.Fatalf("pending recovery used network: %v", requests)
	}
	if _, err := os.Lstat(filepath.Join(f.options.Home, bridgeIntentName)); err != nil {
		t.Fatalf("pending intent lost: %v", err)
	}
}

func TestNetworkBridgeResumesOwnedPartialAndPreservesUnknownFiles(t *testing.T) {
	f, roleURL, responses := bridgeNetworkFixture(t)
	var descriptor Descriptor
	if err := json.Unmarshal(responses[f.input.DescriptorURL], &descriptor); err != nil {
		t.Fatal(err)
	}
	cache, unlock, err := bridgeDownloadCache(f.options.Home, digestBytes(responses[f.input.DescriptorURL]))
	if err != nil {
		t.Fatal(err)
	}
	archive := responses[descriptor.Artifact.URL]
	half := len(archive) / 2
	if err := os.WriteFile(filepath.Join(cache, partialArchiveName), archive[:half], 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(cache, "unfamiliar"), []byte("preserve"), 0600); err != nil {
		t.Fatal(err)
	}
	unlock()
	var rangeSeen bool
	f.options.HTTPClient = &http.Client{Transport: channelPointerRoundTripper(func(req *http.Request) (*http.Response, error) {
		body, ok := responses[req.URL.String()]
		if !ok {
			return nil, fmt.Errorf("unexpected request %s", req.URL)
		}
		status := http.StatusOK
		header := http.Header{}
		if req.URL.String() == descriptor.Artifact.URL {
			if req.Header.Get("Range") != fmt.Sprintf("bytes=%d-", half) {
				return nil, errors.New("missing expected resume range")
			}
			rangeSeen = true
			status = http.StatusPartialContent
			header.Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", half, len(body)-1, len(body)))
			body = body[half:]
		}
		return &http.Response{StatusCode: status, Status: fmt.Sprintf("%d %s", status, http.StatusText(status)), Header: header, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Request: req}, nil
	})}
	if _, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL); err != nil {
		t.Fatal(err)
	}
	if !rangeSeen {
		t.Fatal("partial archive was not resumed")
	}
	if raw, err := os.ReadFile(filepath.Join(cache, "unfamiliar")); err != nil || string(raw) != "preserve" {
		t.Fatalf("unfamiliar file changed: %q %v", raw, err)
	}
}

type networkKillRequest struct {
	Home      string            `json:"home"`
	Input     CachedBridgeInput `json:"input"`
	RoleURL   string            `json:"roleUrl"`
	PublicKey []byte            `json:"publicKey"`
}

type killDuringDownload struct {
	data []byte
	sent bool
}

func (r *killDuringDownload) Read(p []byte) (int, error) {
	if r.sent {
		_ = syscall.Kill(os.Getpid(), syscall.SIGKILL)
		return 0, io.EOF
	}
	r.sent = true
	return copy(p, r.data[:len(r.data)/2]), nil
}

func TestNetworkBridgeInterruptedDownloadHelper(t *testing.T) {
	requestPath := os.Getenv("JOBCTRL_NETWORK_BRIDGE_KILL_REQUEST")
	if requestPath == "" {
		t.Skip("owned subprocess helper")
	}
	raw, err := os.ReadFile(requestPath)
	if err != nil {
		t.Fatal(err)
	}
	var request networkKillRequest
	if err := json.Unmarshal(raw, &request); err != nil {
		t.Fatal(err)
	}
	read := func(path string) []byte {
		b, e := os.ReadFile(path)
		if e != nil {
			t.Fatal(e)
		}
		return b
	}
	descriptorRaw := read(request.Input.DescriptorPath)
	var descriptor Descriptor
	if err := json.Unmarshal(descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	responses := map[string][]byte{
		request.Input.DescriptorURL:          descriptorRaw,
		request.Input.DescriptorURL + ".sig": read(request.Input.DescriptorSignaturePath),
		request.RoleURL:                      read(request.Input.AttestationPath),
		request.RoleURL + ".sig":             read(request.Input.AttestationSignaturePath),
		descriptor.Artifact.URL:              read(request.Input.ArchivePath),
	}
	client := &http.Client{Transport: channelPointerRoundTripper(func(req *http.Request) (*http.Response, error) {
		body, ok := responses[req.URL.String()]
		if !ok {
			return nil, fmt.Errorf("unexpected request %s", req.URL)
		}
		var reader io.Reader = bytes.NewReader(body)
		if req.URL.String() == descriptor.Artifact.URL {
			reader = &killDuringDownload{data: body}
		}
		return &http.Response{StatusCode: 200, Status: "200 OK", Header: http.Header{}, Body: io.NopCloser(reader), ContentLength: int64(len(body)), Request: req}, nil
	})}
	options := Options{Home: request.Home, Trust: map[string]ed25519.PublicKey{"jobctrl-release-v1": ed25519.PublicKey(request.PublicKey)}, Policy: launcher.AcquisitionPolicy{ExpectedChannel: "stable", AllowNetwork: true}, AcquisitionSource: "curl", HTTPClient: client, RunCommand: func(string, ...string) (string, error) { return "", nil }}
	_, _ = InstallSignedNetworkBridge(options, request.Input.DescriptorURL, request.RoleURL)
	t.Fatal("download helper unexpectedly returned")
}

func TestNetworkBridgeRecoversAfterDownloadProcessKilled(t *testing.T) {
	f, roleURL, responses := bridgeNetworkFixture(t)
	request := networkKillRequest{Home: f.options.Home, Input: f.input, RoleURL: roleURL, PublicKey: f.options.Trust["jobctrl-release-v1"]}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(t.TempDir(), "request.json")
	if err := os.WriteFile(requestPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestNetworkBridgeInterruptedDownloadHelper$")
	child.Env = append(os.Environ(), "JOBCTRL_NETWORK_BRIDGE_KILL_REQUEST="+requestPath)
	if err := child.Run(); err == nil {
		t.Fatal("download process was not terminated")
	}
	digest := digestBytes(responses[f.input.DescriptorURL])
	partial := filepath.Join(f.options.Home, "staging", "bridge-downloads", digest, partialArchiveName)
	if info, err := os.Stat(partial); err != nil || info.Size() == 0 {
		t.Fatalf("no resumable owned partial: %v %v", info, err)
	}
	active, err := f.store.ReadActive()
	if err != nil || active != f.source {
		t.Fatalf("interruption changed selection: %+v %v", active, err)
	}
	f.options.HTTPClient, _ = channelPointerClient(responses)
	if _, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL); err != nil {
		t.Fatalf("retry after killed download: %v", err)
	}
	if _, err := os.Lstat(partial); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("successful retry retained partial: %v", err)
	}
}

// A previously released uninstaller takes transition before removing staging.
// Exercise that same lock and exact managed paths without invoking a host runtime.
func TestNetworkBridgeWaitsForPriorUninstallBeforeAnyStaging(t *testing.T) {
	f, roleURL, responses := bridgeNetworkFixture(t)
	var requests map[string]int
	f.options.HTTPClient, requests = channelPointerClient(responses)
	lock, err := f.store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() {
		_, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL)
		done <- err
	}()
	// The lock forces acquisition to recheck after the synthetic uninstall.
	if err := os.Remove(filepath.Join(f.options.Home, "active.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(f.options.Home, "staging")); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("acquisition resumed after uninstall")
	}
	if len(requests) != 0 {
		t.Fatalf("network used after uninstall: %v", requests)
	}
	if _, err := os.Lstat(filepath.Join(f.options.Home, "staging")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uninstall staging was recreated: %v", err)
	}
}

func TestNetworkBridgeHoldsTransitionDuringDownloadAndHandoff(t *testing.T) {
	f, roleURL, responses := bridgeNetworkFixture(t)
	var descriptor Descriptor
	if err := json.Unmarshal(responses[f.input.DescriptorURL], &descriptor); err != nil {
		t.Fatal(err)
	}
	started, resume := make(chan struct{}), make(chan struct{})
	f.options.HTTPClient = &http.Client{Transport: channelPointerRoundTripper(func(req *http.Request) (*http.Response, error) {
		body, ok := responses[req.URL.String()]
		if !ok {
			return nil, fmt.Errorf("unexpected request %s", req.URL)
		}
		if req.URL.String() == descriptor.Artifact.URL {
			close(started)
			<-resume
		}
		return &http.Response{StatusCode: 200, Status: "200 OK", Header: http.Header{}, Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Request: req}, nil
	})}
	bridgeDone := make(chan error, 1)
	go func() {
		_, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL)
		bridgeDone <- err
	}()
	<-started
	probe, err := os.OpenFile(filepath.Join(f.options.Home, "transition.lock"), os.O_RDWR, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer probe.Close()
	if err := syscall.Flock(int(probe.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
		if err == nil {
			_ = syscall.Flock(int(probe.Fd()), syscall.LOCK_UN)
		}
		t.Fatalf("bridge did not own transition lock during download: %v", err)
	}
	uninstallStarted, uninstallDone := make(chan struct{}), make(chan error, 1)
	go func() {
		close(uninstallStarted)
		lock, err := f.store.TransitionLock()
		if err != nil {
			uninstallDone <- err
			return
		}
		defer lock.Close()
		uninstallDone <- os.RemoveAll(filepath.Join(f.options.Home, "staging"))
	}()
	<-uninstallStarted
	select {
	case err := <-uninstallDone:
		t.Fatalf("uninstall crossed active bridge download: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	close(resume)
	if err := <-bridgeDone; err != nil {
		t.Fatalf("bridge handoff: %v", err)
	}
	if err := <-uninstallDone; err != nil {
		t.Fatalf("uninstall staging removal: %v", err)
	}
	if _, err := os.Lstat(filepath.Join(f.options.Home, "staging", "bridge-downloads")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uninstall retained bridge downloads: %v", err)
	}
}

func TestBridgeCacheRefusesSymlinkedStagingBeforeCreatingFiles(t *testing.T) {
	home, outside := t.TempDir(), t.TempDir()
	if err := os.Symlink(outside, filepath.Join(home, "staging")); err != nil {
		t.Fatal(err)
	}
	_, _, err := bridgeDownloadCache(home, strings.Repeat("a", 64))
	if err == nil {
		t.Fatal("symlinked staging accepted")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatalf("outside changed: %v %v", entries, err)
	}
}

func TestCachedBridgeWaitsForPriorUninstallBeforeAnyStaging(t *testing.T) {
	f, _, _ := bridgeNetworkFixture(t)
	lock, err := f.store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := InstallSignedCachedBridge(f.options, f.input); done <- err }()
	if err := os.Remove(filepath.Join(f.options.Home, "active.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(f.options.Home, "staging")); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("cached acquisition resumed after uninstall")
	}
	if _, err := os.Lstat(filepath.Join(f.options.Home, "staging")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uninstall staging was recreated: %v", err)
	}
}

func TestNetworkBridgeRecoveryWaitsForPriorUninstall(t *testing.T) {
	f, roleURL, responses := bridgeNetworkFixture(t)
	store, evidence, err := prepareSignedCachedBridge(f.options, f.input)
	if err != nil {
		t.Fatal(err)
	}
	interrupted := errors.New("interrupt")
	if err := bridgeSelection(store, evidence, func(stage string) error {
		if stage == "active" {
			return interrupted
		}
		return nil
	}); !errors.Is(err, interrupted) {
		t.Fatalf("setup: %v", err)
	}
	var requests map[string]int
	f.options.HTTPClient, requests = channelPointerClient(responses)
	lock, err := f.store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { _, err := InstallSignedNetworkBridge(f.options, f.input.DescriptorURL, roleURL); done <- err }()
	if err := os.Remove(filepath.Join(f.options.Home, "active.json")); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(f.options.Home, "staging")); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err == nil {
		t.Fatal("recovery resumed after uninstall")
	}
	if len(requests) != 0 {
		t.Fatalf("network used after uninstall: %v", requests)
	}
	if _, err := os.Lstat(filepath.Join(f.options.Home, "staging")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("uninstall staging was recreated: %v", err)
	}
}

func TestInterruptedNetworkBridgeCacheIsInsideLegacyUninstallStaging(t *testing.T) {
	f, roleURL, responses := bridgeNetworkFixture(t)
	request := networkKillRequest{Home: f.options.Home, Input: f.input, RoleURL: roleURL, PublicKey: f.options.Trust["jobctrl-release-v1"]}
	raw, err := json.Marshal(request)
	if err != nil {
		t.Fatal(err)
	}
	requestPath := filepath.Join(t.TempDir(), "request.json")
	if err := os.WriteFile(requestPath, raw, 0600); err != nil {
		t.Fatal(err)
	}
	child := exec.Command(os.Args[0], "-test.run=^TestNetworkBridgeInterruptedDownloadHelper$")
	child.Env = append(os.Environ(), "JOBCTRL_NETWORK_BRIDGE_KILL_REQUEST="+requestPath)
	if err := child.Run(); err == nil {
		t.Fatal("download process was not terminated")
	}
	digest := digestBytes(responses[f.input.DescriptorURL])
	partial := filepath.Join(f.options.Home, "staging", "bridge-downloads", digest, partialArchiveName)
	if info, err := os.Lstat(partial); err != nil || info.Size() == 0 {
		t.Fatalf("owned partial missing: %v %v", info, err)
	}
	// This uses the same transition lock and staging path as the released
	// uninstaller. No user runtime or real uninstall is involved.
	lock, err := f.store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(f.options.Home, "staging")); err != nil {
		t.Fatal(err)
	}
	if err := lock.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Lstat(partial); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("partial survived staging removal: %v", err)
	}
}
