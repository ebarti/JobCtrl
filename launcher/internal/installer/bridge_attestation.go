package installer

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// bridgeAttestation is signed separately from distribution descriptors and binds
// one reviewed controller and both exact payload inventories to one transition.
type bridgeAttestation struct {
	SchemaVersion               int    `json:"schemaVersion"`
	Role                        string `json:"role"`
	DatabaseSchema              int    `json:"databaseSchema"`
	LauncherProtocol            int    `json:"launcherProtocol"`
	Channel                     string `json:"channel"`
	Platform                    string `json:"platform"`
	PredecessorDescriptorSHA256 string `json:"predecessorDescriptorSha256"`
	PredecessorManifestSHA256   string `json:"predecessorManifestSha256"`
	CandidateDescriptorSHA256   string `json:"candidateDescriptorSha256"`
	CandidateManifestSHA256     string `json:"candidateManifestSha256"`
	PredecessorInventorySHA256  string `json:"predecessorInventorySha256"`
	CandidateInventorySHA256    string `json:"candidateInventorySha256"`
	ControllerSHA256            string `json:"controllerSha256"`
}

type bridgeAttestationSignature struct {
	SchemaVersion int    `json:"schemaVersion"`
	Algorithm     string `json:"algorithm"`
	KeyID         string `json:"keyId"`
	Signature     string `json:"signature"`
}

type bridgeInventoryEntry struct {
	Kind  string `json:"kind"`
	Mode  uint32 `json:"mode"`
	Value string `json:"value,omitempty"`
}

// decodeVerifiedBridgeAttestation authenticates the bounded role declaration;
// it does not establish predecessor, inventory, or controller authority.
func decodeVerifiedBridgeAttestation(raw, signatureRaw []byte, trust map[string]ed25519.PublicKey) (bridgeAttestation, error) {
	var claim bridgeAttestation
	var signature bridgeAttestationSignature
	if len(raw) > maxDescriptorBytes || len(signatureRaw) > maxSignatureBytes {
		return claim, errors.New("bridge attestation exceeds size limit")
	}
	if err := decodeStrict(signatureRaw, "bridge attestation signature", &signature); err != nil {
		return claim, err
	}
	key := trust[signature.KeyID]
	decoded, err := base64.StdEncoding.DecodeString(signature.Signature)
	message := signingMessage("jobctrl:bridge-attestation:v1\x00", raw)
	if signature.SchemaVersion != 1 || signature.Algorithm != "ed25519" || signature.KeyID == "" || len(key) != ed25519.PublicKeySize || err != nil || len(decoded) != ed25519.SignatureSize || message == nil || !ed25519.Verify(key, message, decoded) {
		return claim, errors.New("bridge attestation signature invalid")
	}
	if err := decodeStrict(raw, "bridge attestation", &claim); err != nil {
		return claim, err
	}
	return claim, nil
}

// verifyBridgeAttestation must run under the transition and selection locks,
// after normal distribution verification of both payloads and channel policy
// admission. The caller must independently prevent payload substitution until
// selector installation. A pathname-based inventory alone cannot provide that
// guarantee against an independent same-user writer.
func verifyBridgeAttestation(raw, signatureRaw []byte, trust map[string]ed25519.PublicKey, old, candidate release.Receipt, oldRoot, candidateRoot string) (bridgeAttestation, error) {
	claim, err := decodeVerifiedBridgeAttestation(raw, signatureRaw, trust)
	if err != nil {
		return claim, err
	}
	if !old.Valid() || !candidate.Valid() || old.Channel != candidate.Channel || claim.SchemaVersion != 1 || claim.Role != "schema14-bridge" || claim.DatabaseSchema != 14 || claim.LauncherProtocol != 2 || claim.Channel != old.Channel || claim.Channel == "local" || claim.Platform != "darwin-arm64" || claim.PredecessorDescriptorSHA256 != old.DescriptorSHA256 || claim.PredecessorManifestSHA256 != old.ManifestSHA256 || claim.CandidateDescriptorSHA256 != candidate.DescriptorSHA256 || claim.CandidateManifestSHA256 != candidate.ManifestSHA256 || old.DescriptorSHA256 == candidate.DescriptorSHA256 {
		return claim, errors.New("bridge attestation identity invalid")
	}
	for _, value := range []string{claim.PredecessorInventorySHA256, claim.CandidateInventorySHA256, claim.ControllerSHA256} {
		if !sha256Pattern.MatchString(value) {
			return claim, errors.New("bridge attestation digest invalid")
		}
	}
	oldInventory, err := bridgeInventory(oldRoot)
	if err != nil {
		return claim, fmt.Errorf("predecessor inventory: %w", err)
	}
	candidateInventory, err := bridgeInventory(candidateRoot)
	if err != nil {
		return claim, fmt.Errorf("candidate inventory: %w", err)
	}
	oldBytes, err := json.Marshal(oldInventory)
	if err != nil {
		return claim, err
	}
	candidateBytes, err := json.Marshal(candidateInventory)
	if err != nil {
		return claim, err
	}
	if digestBytes(oldBytes) != claim.PredecessorInventorySHA256 || digestBytes(candidateBytes) != claim.CandidateInventorySHA256 {
		return claim, errors.New("bridge inventory digest mismatch")
	}
	if err := compareBridgeInventories(oldInventory, candidateInventory); err != nil {
		return claim, err
	}
	if candidateInventory["launcher/jobctrl"].Value != claim.ControllerSHA256 {
		return claim, errors.New("bridge controller digest mismatch")
	}
	if oldInventory["manifest.json"].Value != old.ManifestSHA256 || candidateInventory["manifest.json"].Value != candidate.ManifestSHA256 {
		return claim, errors.New("bridge manifest digest mismatch")
	}
	if err := compareBridgeRuntimeManifest(oldRoot, candidateRoot); err != nil {
		return claim, err
	}
	return claim, nil
}

func bridgeInventory(root string) (map[string]bridgeInventoryEntry, error) {
	rootInfo, err := os.Lstat(root)
	if err != nil {
		return nil, err
	}
	if !rootInfo.IsDir() || rootInfo.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("payload root is not a directory")
	}
	result := make(map[string]bridgeInventoryEntry)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, visitErr error) error {
		if visitErr != nil {
			return visitErr
		}
		if path == root {
			return nil
		}
		rel, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		info, err := os.Lstat(path)
		if err != nil {
			return err
		}
		item := bridgeInventoryEntry{Mode: uint32(info.Mode().Perm())}
		switch {
		case info.IsDir():
			item.Kind = "directory"
		case info.Mode().IsRegular():
			item.Kind = "file"
			fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
			if err != nil {
				return err
			}
			file := os.NewFile(uintptr(fd), path)
			actual, statErr := file.Stat()
			if statErr != nil || !os.SameFile(info, actual) || !actual.Mode().IsRegular() {
				file.Close()
				return fmt.Errorf("inventory file changed: %s", rel)
			}
			hash := sha256.New()
			_, copyErr := io.Copy(hash, file)
			closeErr := file.Close()
			if copyErr != nil {
				return copyErr
			}
			if closeErr != nil {
				return closeErr
			}
			item.Value = hex.EncodeToString(hash.Sum(nil))
		case info.Mode()&os.ModeSymlink != 0:
			item.Kind = "symlink"
			target, err := os.Readlink(path)
			if err != nil {
				return err
			}
			if target == "" || filepath.IsAbs(target) {
				return fmt.Errorf("unsafe symlink %s", rel)
			}
			resolved := filepath.Clean(filepath.Join(filepath.Dir(rel), target))
			if resolved == ".." || strings.HasPrefix(resolved, ".."+string(filepath.Separator)) {
				return fmt.Errorf("escaping symlink %s", rel)
			}
			item.Value = target
		default:
			return fmt.Errorf("unsupported payload entry %s", rel)
		}
		result[rel] = item
		return nil
	})
	return result, err
}

func compareBridgeInventories(old, candidate map[string]bridgeInventoryEntry) error {
	if len(old) != len(candidate) {
		return errors.New("bridge inventory membership differs")
	}
	for path, before := range old {
		after, exists := candidate[path]
		if !exists {
			return fmt.Errorf("bridge inventory missing %s", path)
		}
		switch path {
		case "launcher/jobctrl", "launcher/runtime-manifest.json", "manifest.json", "manifest.sig":
			if before.Kind != "file" || after.Kind != "file" || before.Mode != after.Mode {
				return fmt.Errorf("bridge envelope entry invalid: %s", path)
			}
		default:
			if before != after {
				return fmt.Errorf("bridge runtime entry differs: %s", path)
			}
		}
	}
	for _, required := range []string{"launcher/jobctrl", "launcher/runtime-manifest.json", "manifest.json", "manifest.sig"} {
		if old[required].Kind != "file" || candidate[required].Kind != "file" {
			return fmt.Errorf("bridge envelope entry missing: %s", required)
		}
	}
	return nil
}

func compareBridgeRuntimeManifest(oldRoot, candidateRoot string) error {
	read := func(root string) (map[string]any, error) {
		raw, err := readBoundedFile(filepath.Join(root, "launcher", "runtime-manifest.json"), maxDescriptorBytes)
		if err != nil {
			return nil, err
		}
		var value map[string]any
		decoder := json.NewDecoder(bytes.NewReader(raw))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}
		if decoder.Decode(&struct{}{}) != io.EOF {
			return nil, errors.New("trailing runtime manifest value")
		}
		return value, nil
	}
	old, err := read(oldRoot)
	if err != nil {
		return err
	}
	next, err := read(candidateRoot)
	if err != nil {
		return err
	}
	if old == nil || next == nil {
		return errors.New("bridge runtime manifest is not an object")
	}
	if old["launcherProtocol"] != json.Number("1") || next["launcherProtocol"] != json.Number("2") {
		return errors.New("bridge runtime protocol invalid")
	}
	old["launcherProtocol"] = json.Number("2")
	if !reflect.DeepEqual(old, next) {
		return errors.New("bridge runtime manifest differs beyond protocol")
	}
	return nil
}
