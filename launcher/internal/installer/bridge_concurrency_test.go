package installer

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// The child calls the actual supported local acquisition path, while the bridge
// handoff owns both release locks. It creates only task-owned synthetic files.
func TestBridgeSelectionQueuesActualInstallerProcess(t *testing.T) {
	f := newBridgeSelectionFixture(t)
	inputRoot := t.TempDir()
	archive, descriptor, signature := localFixture(t, inputRoot)
	entered := make(chan struct{})
	resume := make(chan struct{})
	var resumeOnce sync.Once
	releaseBridge := func() { resumeOnce.Do(func() { close(resume) }) }
	defer releaseBridge()
	finished := make(chan error, 1)
	bridgeCollected := false
	f.evidence.Verify = func() error { close(entered); <-resume; return nil }
	go func() { finished <- bridgeSelection(f.store, f.evidence, nil) }()
	defer func() {
		releaseBridge()
		if !bridgeCollected {
			<-finished
		}
	}()
	<-entered
	child := exec.Command(os.Args[0], "-test.run=^TestBridgeConcurrentInstallerHelper$")
	var childOutput bytes.Buffer
	child.Stdout, child.Stderr = &childOutput, &childOutput
	ready := filepath.Join(inputRoot, "started")
	child.Env = append(os.Environ(), "JOBCTRL_BRIDGE_CONCURRENT_HOME="+f.store.Home,
		"JOBCTRL_BRIDGE_CONCURRENT_READY="+ready,
		"JOBCTRL_BRIDGE_CONCURRENT_DESCRIPTOR="+descriptor,
		"JOBCTRL_BRIDGE_CONCURRENT_SIGNATURE="+signature,
		"JOBCTRL_BRIDGE_CONCURRENT_ARCHIVE="+archive)
	if err := child.Start(); err != nil {
		releaseBridge()
		t.Fatal(err)
	}
	childDone := make(chan error, 1)
	go func() { childDone <- child.Wait() }()
	childCollected := false
	defer func() {
		if !childCollected {
			_ = child.Process.Kill()
			<-childDone
		}
	}()
	deadline := time.Now().Add(10 * time.Second)
	for {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		if time.Now().After(deadline) {
			releaseBridge()
			_ = child.Process.Kill()
			<-childDone
			childCollected = true
			t.Fatal("installer child did not enter")
		}
		time.Sleep(10 * time.Millisecond)
	}
	select {
	case err := <-childDone:
		childCollected = true
		releaseBridge()
		t.Fatalf("installer exited while bridge held locks: %v %s", err, childOutput.String())
	case <-time.After(250 * time.Millisecond):
	}
	f.assertSource(t)
	entries, err := os.ReadDir(filepath.Join(f.store.Home, "staging"))
	if err != nil || len(entries) != 0 {
		releaseBridge()
		_ = child.Process.Kill()
		<-childDone
		childCollected = true
		t.Fatalf("installer entered staging while transition was locked: %v %v", entries, err)
	}
	releaseBridge()
	err = <-finished
	bridgeCollected = true
	if err != nil {
		_ = child.Process.Kill()
		<-childDone
		childCollected = true
		t.Fatalf("bridge failed: %v", err)
	}
	select {
	case err := <-childDone:
		childCollected = true
		if err != nil {
			t.Fatalf("installer child did not safely resolve: %v %s", err, childOutput.String())
		}
	case <-time.After(10 * time.Second):
		_ = child.Process.Kill()
		<-childDone
		childCollected = true
		t.Fatal("installer did not unblock after handoff")
	}
	active, err := f.store.ReadActive()
	if err != nil || active.Receipt != f.evidence.Intent.Target {
		t.Fatalf("target selection changed: %+v %v", active, err)
	}
	selected, err := os.ReadFile(f.selector)
	if err != nil || !bytes.Equal(selected, f.evidence.Controller) {
		t.Fatalf("target selector changed: %q %v", selected, err)
	}
	f.assertSentinels(t)
}

func TestBridgeConcurrentInstallerHelper(t *testing.T) {
	home := os.Getenv("JOBCTRL_BRIDGE_CONCURRENT_HOME")
	if home == "" {
		t.Skip("child-process helper")
	}
	if err := os.WriteFile(os.Getenv("JOBCTRL_BRIDGE_CONCURRENT_READY"), []byte("ready"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err := InstallFromLocalFiles(Options{Home: home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true, StageOnly: true}, os.Getenv("JOBCTRL_BRIDGE_CONCURRENT_DESCRIPTOR"), os.Getenv("JOBCTRL_BRIDGE_CONCURRENT_SIGNATURE"), os.Getenv("JOBCTRL_BRIDGE_CONCURRENT_ARCHIVE"))
	if err == nil || !strings.Contains(err.Error(), "below recorded maximum") {
		t.Fatalf("stale acquisition was not refused after bridge: %v", err)
	}
}

// This uses the actual store mutation while respecting the production lock
// order; it isolates generation drift without invoking process supervision.
func TestBridgeSelectionRejectsCooperativePriorMutation(t *testing.T) {
	f := newBridgeSelectionFixture(t)
	trans, err := f.store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	selection, err := f.store.SelectionLock(true)
	if err != nil {
		trans.Close()
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- bridgeSelection(f.store, f.evidence, nil) }()
	other := f.evidence.Intent.Source.Receipt
	other.BuildID = "cooperative-build-0003"
	other.Sequence = 3
	other.DescriptorSHA256 = fmt.Sprintf("%064x", 31)
	if _, err := f.store.WriteSelectedActive(other, f.evidence.Intent.Source.Generation, other.BuildID, "local-fixture"); err != nil {
		selection.Close()
		trans.Close()
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(f.store.Home, release.ActiveFile))
	if err != nil {
		selection.Close()
		trans.Close()
		t.Fatal(err)
	}
	if err := selection.Close(); err != nil {
		trans.Close()
		t.Fatal(err)
	}
	if err := trans.Close(); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil || !strings.Contains(err.Error(), "source selection changed") {
			t.Fatalf("stale source was not refused: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("bridge did not unblock")
	}
	after, err := os.ReadFile(filepath.Join(f.store.Home, release.ActiveFile))
	if err != nil || !bytes.Equal(before, after) {
		t.Fatalf("new selection changed: %v", err)
	}
	selector, err := os.ReadFile(f.selector)
	if err != nil || string(selector) != "old executable" {
		t.Fatalf("selector changed: %q %v", selector, err)
	}
	f.assertSentinels(t)
}

func TestBridgePendingIntentRefusesActualInstaller(t *testing.T) {
	f := newBridgeSelectionFixture(t)
	inputRoot := t.TempDir()
	archive, descriptor, signature := localFixture(t, inputRoot)
	interrupted := errors.New("interrupt after active")
	if err := bridgeSelection(f.store, f.evidence, func(stage string) error {
		if stage == "active" {
			return interrupted
		}
		return nil
	}); !errors.Is(err, interrupted) {
		t.Fatalf("bridge interruption: %v", err)
	}
	paths := []string{filepath.Join(f.store.Home, release.ActiveFile), f.selector, filepath.Join(f.store.Home, bridgeIntentName)}
	before := make(map[string][]byte, len(paths))
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		before[path] = raw
	}
	stagedBefore, err := os.ReadDir(filepath.Join(f.store.Home, "staging"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = InstallFromLocalFiles(Options{Home: f.store.Home, Policy: localAcquisitionPolicy(), AllowUnsignedLocal: true, StageOnly: true}, descriptor, signature, archive)
	if err == nil || !strings.Contains(strings.ToLower(err.Error()), "bridge") {
		t.Fatalf("ordinary installer did not refuse pending bridge: %v", err)
	}
	for _, path := range paths {
		raw, err := os.ReadFile(path)
		if err != nil || !bytes.Equal(before[path], raw) {
			t.Fatalf("refusal changed %s: %v", path, err)
		}
	}
	stagedAfter, err := os.ReadDir(filepath.Join(f.store.Home, "staging"))
	if err != nil || len(stagedAfter) != len(stagedBefore) {
		t.Fatalf("refusal changed staging: %v %v", stagedAfter, err)
	}
	f.assertSentinels(t)
	if err := bridgeSelection(f.store, f.evidence, nil); err != nil {
		t.Fatalf("bridge recovery after installer refusal: %v", err)
	}
	f.assertSentinels(t)
}
