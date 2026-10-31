//go:build darwin

package launcher

import (
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// Exercise the actual installed selector and a separate workspace's production
// promotion. Only the synthetic Apply module and release-start ports are faked.
// The controller is never signalled; its retained process is joined on every
// normal path. Failure evidence stays in the task-owned temporary root.
func TestPromotionRetainsInstalledApplyScopeAfterSelectionUnlock(t *testing.T) {
	for _, completed := range []bool{false, true} {
		t.Run(fmt.Sprintf("completed=%t", completed), func(t *testing.T) {
			runApplyRetentionPromotion(t, completed)
		})
	}
}

func runApplyRetentionPromotion(t *testing.T, completed bool) {
	t.Helper()
	root, err := os.MkdirTemp("", "jobctrl-owned-apply-retention-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("retained owned integration root: %s", root)
	public, private, python := retentionSigningKey(t)
	binary := filepath.Join(root, "selector-build")
	ldflags := fmt.Sprintf("-X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseTrustKeyBase64=%s -X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseChannel=stable", base64.StdEncoding.EncodeToString(public))
	build := exec.Command("go", "build", "-ldflags", ldflags, "-o", binary, "./cmd/jobctrl")
	build.Dir = filepath.Join("..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build owned selector: %v %s", err, output)
	}

	adapterSource, adapter := filepath.Join(root, "adapter.go"), filepath.Join(root, "adapter")
	const adapterCode = `package main
import("crypto/sha256";"encoding/hex";"encoding/json";"os";"path/filepath";"time")
func main(){
 a:=os.Args[1:];if len(a)!=4||a[0]!="-I"||a[1]!="-B"||a[2]!="-m"||a[3]!="jobctrl.apply.execution"{os.Exit(111)}
 state:=os.Getenv("JOBCTRL_DIR");runtime:=os.Getenv("JOBCTRL_RUNTIME_HOME");id:=os.Getenv("JOBCTRL_APPLY_EXECUTION_SCOPE")
 if id==""||id!=os.Getenv("JOBCTRL_EXECUTION_SCOPE"){os.Exit(112)}
 hash:=sha256.Sum256([]byte(state));instance:=filepath.Join(runtime,"instances",hex.EncodeToString(hash[:]))
 receipt,err:=os.ReadFile(filepath.Join(instance,"executions",id+".json"));if err!=nil{os.Exit(113)}
 var v map[string]any;if json.Unmarshal(receipt,&v)!=nil||v["purpose"]!="apply"{os.Exit(114)}
 if os.WriteFile(os.Getenv("RETENTION_QA_RECEIPT"),receipt,0600)!=nil{os.Exit(115)}
 if os.WriteFile(os.Getenv("RETENTION_QA_READY"),[]byte("ready"),0600)!=nil{os.Exit(116)}
 deadline:=time.Now().Add(20*time.Second)
 for {if _,err=os.Stat(os.Getenv("RETENTION_QA_RELEASE"));err==nil{break};if time.Now().After(deadline){os.Exit(117)};time.Sleep(10*time.Millisecond)}
 if os.Getenv("RETENTION_QA_WITHOUT_PROOF")=="1" {dir:=filepath.Join(instance,"completed-executions");if os.MkdirAll(dir,0700)!=nil||os.Chmod(dir,0500)!=nil{os.Exit(118)}}
}`
	if err := os.WriteFile(adapterSource, []byte(adapterCode), 0600); err != nil {
		t.Fatal(err)
	}
	build = exec.Command("go", "build", "-o", adapter, adapterSource)
	build.Dir = filepath.Join("..", "..")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build synthetic Apply module: %v %s", err, output)
	}

	home, stateA, stateB := filepath.Join(root, "home"), filepath.Join(root, "workspace-a"), filepath.Join(root, "workspace-b")
	runtime := filepath.Join(root, "runtime")
	for _, dir := range []string{home, stateA, stateB} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	envA := []string{"HOME=" + home, "PATH=/usr/bin:/bin", "JOBCTRL_DIR=" + stateA, "JOBCTRL_RUNTIME_HOME=" + runtime,
		executionQASandboxVariable + "=" + executionQASandboxSelector}
	instA, err := resolveInstance(envA)
	if err != nil {
		t.Fatal(err)
	}
	envB := []string{"HOME=" + home, "PATH=/usr/bin:/bin", "JOBCTRL_DIR=" + stateB, "JOBCTRL_RUNTIME_HOME=" + runtime,
		executionQASandboxVariable + "=" + executionQASandboxSelector}
	instB, err := resolveInstance(envB)
	if err != nil {
		t.Fatal(err)
	}
	store, err := release.Open(runtime)
	if err != nil {
		t.Fatal(err)
	}
	old := newSignedHomebrewBootstrapFixture(t, private, "apply-retention-old-0001", 1, 2, python)
	for name, source := range map[string]string{"launcher/jobctrl": binary, "python/bin/python3": adapter} {
		raw, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(old.payloadRoot, name), raw, 0755); err != nil {
			t.Fatal(err)
		}
	}
	resignApplyRetentionFixture(t, &old, private)
	allowOldRetentionRollback(t, &old, private)
	// Protocol-2 forward updates do not call retention. Exercise the supported
	// protocol-1-compatible promotion lane that does invoke retainReleases.
	mid := newSignedHomebrewBootstrapFixture(t, private, "apply-retention-mid-0019", 19, 1, python)
	next := newSignedHomebrewBootstrapFixture(t, private, "apply-retention-new-0021", 21, 1, python)
	allowOldRetentionRollback(t, &mid, private)
	allowOldRetentionRollback(t, &next, private)
	for _, fixture := range []homebrewBootstrapFixture{old, mid, next} {
		if err := verifyHomebrewFixtureDescriptor(public, fixture); err != nil {
			t.Fatal(err)
		}
		if err := stageHomebrewFixture(runtime, fixture, public); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := store.RecordMetadata("stable", old.receipt.Sequence, 1, old.receipt.BuildID, old.receipt.DescriptorSHA256, nil); err != nil {
		t.Fatal(err)
	}
	active, err := store.WriteSelectedActive(old.receipt, 0, old.receipt.BuildID, "homebrew")
	if err != nil {
		t.Fatal(err)
	}
	verified, err := verifyInstalledReleaseForExecution(store, old.receipt)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(runtime, verified); err != nil {
		t.Fatal(err)
	}
	oldState := instanceState{SchemaVersion: stateSchemaVersion, InstanceID: instA.ID, CanonicalStateDir: instA.StateDir,
		PayloadRoot: filepath.Join(runtime, "releases", old.buildID, "payload"), BuildID: old.buildID,
		ManifestSHA256: old.receipt.ManifestSHA256, Components: map[string]componentRecord{}}
	if err := writeState(instA.StatePath, oldState); err != nil {
		t.Fatal(err)
	}
	seedLifecycleSQLitePair(t, python, instB.StateDir, "synthetic-promotion-")

	ready, releaseFile, receiptFile := filepath.Join(root, "apply-ready"), filepath.Join(root, "apply-release"), filepath.Join(root, "apply-receipt")
	mode := "1"
	if completed {
		mode = "0"
	}
	selector := filepath.Join(runtime, "bin", "jobctrl")
	child := exec.Command(selector, applyExecutionArgument)
	child.Env = append(append([]string{}, envA...), "RETENTION_QA_READY="+ready, "RETENTION_QA_RELEASE="+releaseFile,
		"RETENTION_QA_RECEIPT="+receiptFile, "RETENTION_QA_WITHOUT_PROOF="+mode)
	outputPath := filepath.Join(root, "selector.log")
	output, err := os.OpenFile(outputPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer output.Close()
	child.Stdout, child.Stderr = output, output
	if err := child.Start(); err != nil {
		t.Fatal(err)
	}
	readOutput := func() string {
		data, err := os.ReadFile(outputPath)
		if err != nil {
			return "cannot read retained selector output: " + err.Error()
		}
		return string(data)
	}
	done := make(chan error, 1)
	go func() { done <- child.Wait() }()
	waited := false
	defer func() {
		if !waited {
			_ = os.WriteFile(releaseFile, []byte("release"), 0600)
			select {
			case <-done:
				waited = true
			case <-time.After(30 * time.Second):
				t.Errorf("owned Apply controller cleanup unverified; retained %s", root)
			}
		}
	}()
	for deadline := time.Now().Add(20 * time.Second); ; {
		if _, err := os.Stat(ready); err == nil {
			break
		}
		select {
		case err := <-done:
			waited = true
			t.Fatalf("selector exited before real Apply entry: %v %s", err, readOutput())
		default:
		}
		if time.Now().After(deadline) {
			t.Fatalf("selector did not enter owned Apply; retained %s", root)
		}
		time.Sleep(10 * time.Millisecond)
	}
	assertSelectionFlock(t, runtime, false)
	raw, err := os.ReadFile(receiptFile)
	if err != nil {
		t.Fatal(err)
	}
	var scope executionScope
	if err := decodeExecutionReceipt(raw, &scope); err != nil || scope.Purpose != "apply" || scope.InstanceID != instA.ID {
		t.Fatalf("real Apply receipt invalid: %v", err)
	}
	if err := os.WriteFile(releaseFile, []byte("release"), 0600); err != nil {
		t.Fatal(err)
	}
	select {
	case err = <-done:
		waited = true
	case <-time.After(30 * time.Second):
		t.Fatalf("owned selector did not exit; retained %s", root)
	}
	if completed && err != nil {
		t.Fatalf("normal Apply completion failed: %v %s", err, readOutput())
	}
	if !completed && (err == nil || !strings.Contains(readOutput(), "unsafe execution completion directory")) {
		t.Fatalf("unsafe completion boundary was not reached: %v %s", err, readOutput())
	}
	if exited, err := waitExecutionRoot(scope.RootPID, scope.RootIdentity, 10*time.Second); err != nil || !exited {
		t.Fatalf("owned Apply helper exit could not be established: exited=%t error=%v; retained %s", exited, err, root)
	}
	assertSelectionFlock(t, runtime, true)

	executionDir := filepath.Join(instA.Dir, "executions")
	completionDir := filepath.Join(instA.Dir, "completed-executions")
	if err := os.Chmod(completionDir, 0700); err != nil {
		t.Fatal(err)
	}
	ctxA := launchContext{Instance: instA}
	if completed {
		proof, err := readExecutionCompletion(ctxA, scope.ID)
		expected := executionCompletionForReceipt(scope, raw, scope.BootSession)
		if err != nil || proof.Scope != scope || proof.ReceiptSHA256 != expected.ReceiptSHA256 || proof.VerificationBootSession != scope.BootSession {
			t.Fatalf("exact native completion missing or mismatched: %v", err)
		}
		// Recreate the exact native receipt to model interruption after the
		// durable completion and before retirement; the proof is not fabricated.
		if err := os.WriteFile(filepath.Join(executionDir, scope.ID+".json"), raw, 0600); err != nil {
			t.Fatal(err)
		}
	} else {
		scopes, err := readOwnedExecutionScopes(ctxA)
		if err != nil || len(scopes) != 1 || scopes[0] != scope {
			t.Fatalf("unresolved real receipt missing: %v", err)
		}
		if _, err := readExecutionCompletion(ctxA, scope.ID); !errors.Is(err, os.ErrNotExist) {
			t.Fatalf("unexpected completion: %v", err)
		}
	}

	// Move the public selection to an intermediate signed release, then use
	// the production promotion entry from another workspace. The original is
	// neither active, previous, nor referenced by the second workspace's backup.
	if _, err := store.RecordMetadata("stable", mid.receipt.Sequence, 1, mid.buildID, mid.receipt.DescriptorSHA256, nil); err != nil {
		t.Fatal(err)
	}
	verifiedMid, err := verifyInstalledReleaseForExecution(store, mid.receipt)
	if err != nil {
		t.Fatal(err)
	}
	selection, err := store.SelectionLock(true)
	if err != nil {
		t.Fatal(err)
	}
	if err := handoffPublicSelector(runtime, verifiedMid); err != nil {
		selection.Close()
		t.Fatal(err)
	}
	active, err = store.WriteSelectedActive(mid.receipt, active.Generation, mid.buildID, "homebrew")
	if err != nil {
		selection.Close()
		t.Fatal(err)
	}
	if err := selection.Close(); err != nil {
		t.Fatal(err)
	}
	ctxB := launchContext{Instance: instB, Environment: envB}
	previousStart := startReleaseCommand
	t.Cleanup(func() { startReleaseCommand = previousStart })
	startReleaseCommand = func(_ launchContext, receipt release.Receipt, _ string) error {
		if receipt != next.receipt {
			return errors.New("unexpected synthetic release start")
		}
		return nil
	}
	promotionErr := promoteExisting(ctxB, store, active, next.buildID, "update", io.Discard)
	selected, readErr := store.ReadActive()
	if readErr != nil || selected.Receipt != next.receipt {
		t.Fatalf("promotion did not reach retention: %v %v", promotionErr, readErr)
	}
	oldPath := filepath.Join(runtime, "releases", old.buildID)
	_, statErr := os.Stat(oldPath)
	if completed {
		if promotionErr != nil || !errors.Is(statErr, os.ErrNotExist) {
			t.Fatalf("verified completion unnecessarily blocked ordinary retention: %v %v", promotionErr, statErr)
		}
	} else {
		if promotionErr == nil || !strings.Contains(promotionErr.Error(), "retention") || statErr != nil {
			t.Fatalf("unresolved real Apply receipt failed to preserve its potentially referenced release: promotion=%v release=%v", promotionErr, statErr)
		}
	}
}

func assertSelectionFlock(t *testing.T, runtime string, wantAvailable bool) {
	t.Helper()
	file, err := os.OpenFile(filepath.Join(runtime, "selection.lock"), os.O_RDWR|syscall.O_NOFOLLOW, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer file.Close()
	err = syscall.Flock(int(file.Fd()), syscall.LOCK_EX|syscall.LOCK_NB)
	if err == nil {
		defer syscall.Flock(int(file.Fd()), syscall.LOCK_UN)
	}
	if wantAvailable && err != nil {
		t.Fatalf("selection still held after all Apply processes exited: %v", err)
	}
	if !wantAvailable && !errors.Is(err, syscall.EWOULDBLOCK) && !errors.Is(err, syscall.EAGAIN) {
		t.Fatalf("live Apply did not hold selection: %v", err)
	}
}

func resignApplyRetentionFixture(t *testing.T, fixture *homebrewBootstrapFixture, private ed25519.PrivateKey) {
	t.Helper()
	var manifest distributionManifest
	if err := decodeStrict(filepath.Join(fixture.payloadRoot, "manifest.json"), &manifest); err != nil {
		t.Fatal(err)
	}
	refreshFixtureManifest(t, fixture.payloadRoot, &manifest)
	raw, err := json.Marshal(manifest)
	if err != nil {
		t.Fatal(err)
	}
	signature := base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:manifest:v1\x00", raw)))
	encoded, err := json.Marshal(manifestSignature{SchemaVersion: 1, Status: "signed", ManifestAlgorithm: "ed25519", ManifestKeyID: "jobctrl-release-v1", Signature: &signature, Promotable: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.payloadRoot, "manifest.json"), raw, 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(fixture.payloadRoot, "manifest.sig"), encoded, 0644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(raw)
	fixture.receipt.ManifestSHA256 = hex.EncodeToString(sum[:])
	var descriptor map[string]any
	if err := json.Unmarshal(fixture.descriptorRaw, &descriptor); err != nil {
		t.Fatal(err)
	}
	artifact, ok := descriptor["artifact"].(map[string]any)
	if !ok {
		t.Fatal("fixture artifact missing")
	}
	artifact["manifestSha256"] = fixture.receipt.ManifestSHA256
	fixture.descriptorRaw, err = json.Marshal(descriptor)
	if err != nil {
		t.Fatal(err)
	}
	sum = sha256.Sum256(fixture.descriptorRaw)
	fixture.descriptorSHA256 = hex.EncodeToString(sum[:])
	fixture.receipt.DescriptorSHA256 = fixture.descriptorSHA256
	fixture.policy.DescriptorDigest = fixture.descriptorSHA256
	fixture.receipt.PolicySHA256 = lifecyclePolicyDigest(t, fixture.policy)
	fixture.signatureRaw, err = json.Marshal(homebrewFixtureSignature{SchemaVersion: 1, Status: "signed", Algorithm: "ed25519", KeyID: "jobctrl-release-v1", Signature: base64.StdEncoding.EncodeToString(ed25519.Sign(private, signedMessage("jobctrl:release-descriptor:v1\x00", fixture.descriptorRaw)))})
	if err != nil {
		t.Fatal(err)
	}
}
