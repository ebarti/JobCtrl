package installer

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type bridgeRouteFixture struct {
	bridge                     signedBridgeFixture
	role                       string
	responses                  map[string][]byte
	target                     CachedBridgeInput
	catalog                    bridgeRouteCatalog
	catalogPath, signaturePath string
}

func signedRouteFiles(t *testing.T, f signedBridgeFixture, catalog bridgeRouteCatalog) (string, string) {
	t.Helper()
	raw, err := json.Marshal(catalog)
	if err != nil {
		t.Fatal(err)
	}
	sig, err := json.Marshal(bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.private, signingMessage(bridgeRouteDomain, raw)))})
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	return writeBridgeInputFile(t, dir, "routes.json", raw), writeBridgeInputFile(t, dir, "routes.sig", sig)
}

func newBridgeRouteFixture(t *testing.T) bridgeRouteFixture {
	t.Helper()
	f, role, responses := bridgeNetworkFixture(t)
	target := plannedTarget(t, f, nil)
	responses[target.TargetDescriptorURL] = mustReadNetworkTest(t, target.TargetDescriptorPath)
	responses[target.TargetDescriptorURL+".sig"] = mustReadNetworkTest(t, target.TargetSignaturePath)
	catalog := bridgeRouteCatalog{SchemaVersion: 1, Channel: "stable", Platform: "darwin-arm64", Routes: []bridgeRoute{{SourceDescriptorSHA256: f.source.Receipt.DescriptorSHA256, TargetDescriptorSHA256: digestBytes(responses[target.TargetDescriptorURL]), BridgeDescriptorSHA256: digestBytes(responses[f.input.DescriptorURL]), BridgeDescriptorURL: f.input.DescriptorURL, BridgeRoleURL: role}}}
	catalogPath, sigPath := signedRouteFiles(t, f, catalog)
	return bridgeRouteFixture{f, role, responses, target, catalog, catalogPath, sigPath}
}

func (f bridgeRouteFixture) run(options Options) (Receipt, error) {
	return InstallSignedCatalogBridge(options, f.catalogPath, f.signaturePath, f.target.TargetDescriptorURL, f.target.TargetDescriptorPath, f.target.TargetSignaturePath)
}

func TestSignedCatalogBridgeRoutesCurlAndHomebrew(t *testing.T) {
	for _, source := range []string{"curl", "homebrew"} {
		t.Run(source, func(t *testing.T) {
			f := newBridgeRouteFixture(t)
			options := f.bridge.options
			options.AcquisitionSource = source
			options.HTTPClient, _ = channelPointerClient(f.responses)
			for _, name := range []string{"jobctrl.db", "jobctrl.db-wal", "temporal.db", "temporal.db-wal"} {
				if err := os.WriteFile(filepath.Join(options.Home, name), []byte("owned "+name), 0600); err != nil {
					t.Fatal(err)
				}
			}
			receipt, err := f.run(options)
			if err != nil || receipt.BuildID != "bridge-build-0002" {
				t.Fatalf("route: %+v %v", receipt, err)
			}
			for _, name := range []string{"jobctrl.db", "jobctrl.db-wal", "temporal.db", "temporal.db-wal"} {
				raw, err := os.ReadFile(filepath.Join(options.Home, name))
				if err != nil || string(raw) != "owned "+name {
					t.Fatalf("changed %s: %q %v", name, raw, err)
				}
			}
			// Repeating the same catalog handoff recognizes the retained source
			// and completes without fetching mutable route or artifact data.
			var catalogRetryCalls map[string]int
			options.HTTPClient, catalogRetryCalls = channelPointerClient(nil)
			againWithCatalog, err := f.run(options)
			if err != nil || againWithCatalog != receipt {
				t.Fatalf("completed catalog retry: %+v %v", againWithCatalog, err)
			}
			if len(catalogRetryCalls) != 0 {
				t.Fatalf("catalog retry used network: %v", catalogRetryCalls)
			}
			// Explicit recovery uses the retained signed evidence, not the catalog,
			// input files or network, after the successful handoff.
			for _, name := range []string{f.catalogPath, f.signaturePath, f.target.TargetDescriptorPath, f.target.TargetSignaturePath} {
				if err := os.Remove(name); err != nil {
					t.Fatal(err)
				}
			}
			var calls map[string]int
			options.HTTPClient, calls = channelPointerClient(nil)
			again, err := InstallSignedCachedBridge(options, CachedBridgeInput{})
			if err != nil || again != receipt {
				t.Fatalf("offline recovery: %+v %v", again, err)
			}
			if len(calls) != 0 {
				t.Fatalf("offline recovery used network: %v", calls)
			}
		})
	}
}

func TestSignedCatalogBridgeRejectsInvalidRoutesBeforeNetwork(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(*bridgeRouteFixture)
	}{
		{"signature", func(f *bridgeRouteFixture) { _ = os.WriteFile(f.signaturePath, []byte("{}"), 0600) }},
		{"missing source", func(f *bridgeRouteFixture) {
			f.catalog.Routes[0].SourceDescriptorSHA256 = strings.Repeat("a", 64)
			f.catalogPath, f.signaturePath = signedRouteFiles(t, f.bridge, f.catalog)
		}},
		{"duplicate pair", func(f *bridgeRouteFixture) {
			f.catalog.Routes = append(f.catalog.Routes, f.catalog.Routes[0])
			f.catalogPath, f.signaturePath = signedRouteFiles(t, f.bridge, f.catalog)
		}},
		{"wrong channel", func(f *bridgeRouteFixture) {
			f.catalog.Channel = "prerelease"
			f.catalogPath, f.signaturePath = signedRouteFiles(t, f.bridge, f.catalog)
		}},
		{"foreign role URL", func(f *bridgeRouteFixture) {
			f.catalog.Routes[0].BridgeRoleURL = "https://attacker.example/role"
			f.catalogPath, f.signaturePath = signedRouteFiles(t, f.bridge, f.catalog)
		}},
		{"bad target signature", func(f *bridgeRouteFixture) { _ = os.WriteFile(f.target.TargetSignaturePath, []byte("{}"), 0600) }},
	} {
		t.Run(test.name, func(t *testing.T) {
			f := newBridgeRouteFixture(t)
			test.mutate(&f)
			var calls map[string]int
			f.bridge.options.HTTPClient, calls = channelPointerClient(f.responses)
			if _, err := f.run(f.bridge.options); err == nil {
				t.Fatal("untrusted or missing route accepted")
			}
			if len(calls) != 0 {
				t.Fatalf("network used before route validation: %v", calls)
			}
			active, err := f.bridge.store.ReadActive()
			if err != nil || active != f.bridge.source {
				t.Fatalf("active changed: %+v %v", active, err)
			}
		})
	}
}

func TestSignedCatalogRejectsAmbiguousAuthenticatedJSON(t *testing.T) {
	f := newBridgeRouteFixture(t)
	raw, err := json.Marshal(f.catalog)
	if err != nil {
		t.Fatal(err)
	}
	// A valid signature cannot make duplicate JSON object fields canonical.
	raw = []byte(strings.Replace(string(raw), `"schemaVersion":1`, `"schemaVersion":1,"schemaVersion":1`, 1))
	sig, err := json.Marshal(bridgeAttestationSignature{SchemaVersion: 1, Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(f.bridge.private, signingMessage(bridgeRouteDomain, raw)))})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := verifyBridgeRouteCatalog(raw, sig, f.bridge.options.Trust, "stable"); err == nil {
		t.Fatal("ambiguous signed JSON accepted")
	}
}

func TestSignedCatalogRechecksFetchedDescriptorIdentity(t *testing.T) {
	for _, changed := range []string{"bridge", "target"} {
		t.Run(changed, func(t *testing.T) {
			f := newBridgeRouteFixture(t)
			url := f.bridge.input.DescriptorURL
			if changed == "target" {
				url = f.target.TargetDescriptorURL
			}
			// A previously trusted descriptor URL can serve different valid signed
			// bytes; the signed route must pin the originally reviewed digest.
			var descriptor Descriptor
			if err := json.Unmarshal(f.responses[url], &descriptor); err != nil {
				t.Fatal(err)
			}
			descriptor.Sequence++
			raw, err := json.Marshal(descriptor)
			if err != nil {
				t.Fatal(err)
			}
			sig, err := json.Marshal(signedDescriptorSignature(f.bridge.private, raw))
			if err != nil {
				t.Fatal(err)
			}
			f.responses[url], f.responses[url+".sig"] = raw, sig
			var calls map[string]int
			f.bridge.options.HTTPClient, calls = channelPointerClient(f.responses)
			if _, err := f.run(f.bridge.options); err == nil {
				t.Fatal("substituted descriptor accepted")
			}
			var bridge Descriptor
			if err := json.Unmarshal(f.responses[f.bridge.input.DescriptorURL], &bridge); err != nil {
				t.Fatal(err)
			}
			if calls[bridge.Artifact.URL] != 0 {
				t.Fatal("archive fetched before route identity check")
			}
			active, err := f.bridge.store.ReadActive()
			if err != nil || active != f.bridge.source {
				t.Fatalf("active changed: %+v %v", active, err)
			}
		})
	}
}

func TestSignedCatalogFailsClosedForMissingActiveAndStageOnly(t *testing.T) {
	f := newBridgeRouteFixture(t)
	f.bridge.options.StageOnly = true
	if _, err := f.run(f.bridge.options); err == nil {
		t.Fatal("stage-only bridge accepted")
	}
	f.bridge.options.StageOnly = false
	if err := os.Remove(filepath.Join(f.bridge.options.Home, "active.json")); err != nil && !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
	if _, err := f.run(f.bridge.options); err == nil {
		t.Fatal("orphaned active record accepted")
	}
}

func TestCatalogRouteRecoversInterruptedSelectionWithoutNetwork(t *testing.T) {
	for _, interruptedStage := range []string{"intent", "active", "policy", "selector"} {
		t.Run(interruptedStage, func(t *testing.T) {
			f := newBridgeRouteFixture(t)
			store, evidence, err := prepareSignedCachedBridge(f.bridge.options, f.target)
			if err != nil {
				t.Fatal(err)
			}
			interrupted := errors.New("synthetic interruption")
			if err := bridgeSelection(store, evidence, func(stage string) error {
				if stage == interruptedStage {
					return interrupted
				}
				return nil
			}); !errors.Is(err, interrupted) {
				t.Fatalf("interruption: %v", err)
			}
			var calls map[string]int
			f.bridge.options.HTTPClient, calls = channelPointerClient(nil)
			if _, err := f.run(f.bridge.options); err != nil {
				t.Fatalf("offline routed recovery: %v", err)
			}
			if len(calls) != 0 {
				t.Fatalf("recovery used network: %v", calls)
			}
		})
	}
}

func TestCatalogRouteRechecksSourceUnderHandoffLock(t *testing.T) {
	f := newBridgeRouteFixture(t)
	var calls map[string]int
	f.bridge.options.HTTPClient, calls = channelPointerClient(f.responses)
	if _, err := installSignedNetworkBridge(f.bridge.options, f.bridge.input.DescriptorURL, f.role, f.target.TargetDescriptorURL, strings.Repeat("a", 64), f.catalog.Routes[0].BridgeDescriptorSHA256, f.catalog.Routes[0].TargetDescriptorSHA256); err == nil {
		t.Fatal("changed predecessor accepted")
	}
	// Bridge and role metadata may have been fetched, but no archive is staged.
	var descriptor Descriptor
	if err := json.Unmarshal(f.responses[f.bridge.input.DescriptorURL], &descriptor); err != nil {
		t.Fatal(err)
	}
	if calls[descriptor.Artifact.URL] != 0 {
		t.Fatal("archive fetched after source identity drift")
	}
	active, err := f.bridge.store.ReadActive()
	if err != nil || active != f.bridge.source {
		t.Fatalf("active changed: %+v %v", active, err)
	}
}

func TestCatalogRouteReachesRealInstallerEntryForCurlAndHomebrew(t *testing.T) {
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		t.Skip("installer entry supports darwin-arm64 only")
	}
	f := newBridgeRouteFixture(t)
	// A signed catalog with no matching source fails before network or mutation.
	f.catalog.Routes[0].SourceDescriptorSHA256 = strings.Repeat("a", 64)
	f.catalogPath, f.signaturePath = signedRouteFiles(t, f.bridge, f.catalog)
	dir := t.TempDir()
	goExe, err := exec.LookPath("go")
	if err != nil {
		t.Fatal(err)
	}
	binary := filepath.Join(dir, "jobctrl-installer")
	cache := os.Getenv("GOCACHE")
	if cache == "" {
		cache = filepath.Join(dir, "gocache")
	}
	baseEnv := []string{"PATH=" + os.Getenv("PATH"), "HOME=" + dir, "TMPDIR=" + dir, "GOCACHE=" + cache, "GOTOOLCHAIN=local", "GOPROXY=off"}
	ldflags := "-X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseChannel=stable -X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseTrustKeyBase64=" + base64.StdEncoding.EncodeToString(f.bridge.options.Trust["jobctrl-release-v1"])
	build := exec.Command(goExe, "build", "-ldflags", ldflags, "-o", binary, "./cmd/jobctrl-installer")
	build.Dir, build.Env = filepath.Join("..", ".."), baseEnv
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build installer: %v: %s", err, out)
	}
	for _, source := range []string{"curl", "homebrew"} {
		t.Run(source, func(t *testing.T) {
			args := []string{"--source", source, "--home", f.bridge.options.Home, "--bridge-route-file", f.catalogPath, "--bridge-route-signature-file", f.signaturePath, "--bridge-target-descriptor-url", f.target.TargetDescriptorURL, "--bridge-target-descriptor-file", f.target.TargetDescriptorPath, "--bridge-target-signature-file", f.target.TargetSignaturePath}
			cmd := exec.Command(binary, args...)
			cmd.Env = baseEnv
			out, err := cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(out), "no authenticated bridge route") {
				t.Fatalf("expected missing route refusal, got %v: %s", err, out)
			}
			cmd = exec.Command(binary, append(args, "--stage-only")...)
			cmd.Env = baseEnv
			out, err = cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(out), "cannot use stage-only") {
				t.Fatalf("stage-only should refuse: %v: %s", err, out)
			}
			cmd = exec.Command(binary, append(args, "--bridge-role-url", f.role)...)
			cmd.Env = baseEnv
			out, err = cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(out), "without other acquisition") {
				t.Fatalf("mixed bridge modes should refuse: %v: %s", err, out)
			}
			incomplete := []string{"--source", source, "--home", f.bridge.options.Home, "--bridge-route-file", f.catalogPath, "--bridge-target-descriptor-url", f.target.TargetDescriptorURL, "--bridge-target-descriptor-file", f.target.TargetDescriptorPath, "--bridge-target-signature-file", f.target.TargetSignaturePath}
			cmd = exec.Command(binary, incomplete...)
			cmd.Env = baseEnv
			out, err = cmd.CombinedOutput()
			if err == nil || !strings.Contains(string(out), "complete signed target inputs") {
				t.Fatalf("incomplete route inputs should refuse: %v: %s", err, out)
			}
			active, err := f.bridge.store.ReadActive()
			if err != nil || active != f.bridge.source {
				t.Fatalf("active changed: %+v %v", active, err)
			}
		})
	}
}

func waitForCatalogRouteLock(t *testing.T) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		raw := make([]byte, 1<<20)
		n := runtime.Stack(raw, true)
		for _, stack := range strings.Split(string(raw[:n]), "\n\n") {
			if strings.Contains(stack, "installSignedNetworkBridge(") && strings.Contains(stack, "syscall.Flock(") {
				return
			}
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("route did not reach held transition lock")
}

func TestCatalogQueuedSourceDrift(t *testing.T) {
	f := newBridgeRouteFixture(t)
	var calls map[string]int
	f.bridge.options.HTTPClient, calls = channelPointerClient(f.responses)
	transition, err := f.bridge.store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	collected := false
	defer func() {
		_ = transition.Close()
		if !collected {
			<-done
		}
	}()
	go func() { _, err := f.run(f.bridge.options); done <- err }()
	waitForCatalogRouteLock(t)
	selected, err := f.bridge.store.SelectionLock(true)
	if err != nil {
		t.Fatal(err)
	}
	// Model a cooperating mutator changing the exact selected receipt while
	// this route is queued behind its transition lock. No host processes exist.
	changed := f.bridge.source.Receipt
	changed.DescriptorSHA256 = strings.Repeat("a", 64)
	active, err := f.bridge.store.WriteSelectedActive(changed, f.bridge.source.Generation, changed.BuildID, "curl")
	selected.Close()
	if err != nil {
		t.Fatal(err)
	}
	transition.Close()
	select {
	case err := <-done:
		collected = true
		if err == nil || !strings.Contains(err.Error(), "predecessor differs") {
			t.Fatalf("source drift: %v", err)
		}
		t.Logf("observed refusal: %v", err)
	case <-time.After(5 * time.Second):
		t.Fatal("route failed to return after release")
	}
	got, err := f.bridge.store.ReadActive()
	if err != nil || got != active {
		t.Fatalf("route changed competing active: %+v %v", got, err)
	}
	var d Descriptor
	if err := json.Unmarshal(f.responses[f.bridge.input.DescriptorURL], &d); err != nil {
		t.Fatal(err)
	}
	if calls[d.Artifact.URL] != 0 {
		t.Fatal("archive downloaded after source drift")
	}
}

func TestCatalogQueuedCompletedHandoff(t *testing.T) {
	f := newBridgeRouteFixture(t)
	store, evidence, err := prepareSignedCachedBridge(f.bridge.options, f.target)
	if err != nil {
		t.Fatal(err)
	}
	transition, err := store.TransitionLock()
	if err != nil {
		t.Fatal(err)
	}
	var calls map[string]int
	f.bridge.options.HTTPClient, calls = channelPointerClient(nil)
	done := make(chan error, 1)
	collected := false
	defer func() {
		_ = transition.Close()
		if !collected {
			<-done
		}
	}()
	go func() { _, err := f.run(f.bridge.options); done <- err }()
	waitForCatalogRouteLock(t)
	if err := bridgeSelectionWithTransition(store, evidence, nil); err != nil {
		t.Fatal(err)
	}
	transition.Close()
	select {
	case err := <-done:
		collected = true
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queued catalog recovery timed out")
	}
	if len(calls) != 0 {
		t.Fatalf("completed race used network: %v", calls)
	}
	got, err := store.ReadActive()
	if err != nil || got.Receipt.BuildID != "bridge-build-0002" || got.Generation != f.bridge.source.Generation+1 {
		t.Fatalf("active: %+v %v", got, err)
	}
}
