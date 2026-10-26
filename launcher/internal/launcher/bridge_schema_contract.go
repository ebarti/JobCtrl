package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

const bridgeSchemaContractPath = "launcher/schema-transition.json"
const bridgeSchemaContractMaxBytes = 4096

// The candidate's signed inventory binds this exact statement. Protocol
// compatibility alone does not identify the schema a candidate will start.
type bridgeSchemaContract struct {
	SchemaVersion     int   `json:"schemaVersion"`
	SourceUserVersion int64 `json:"sourceUserVersion"`
	TargetUserVersion int64 `json:"targetUserVersion"`
}

// loadVerifiedBridgeSchemaContract must be called while the transition and
// selection locks are held, before creating a journal or changing data. It
// authenticates the installed receipt, signed manifest and complete payload,
// then rechecks the contract bytes against that authenticated inventory.
// Other payload files must still be reverified at their actual use boundary.
func loadVerifiedBridgeSchemaContract(store *release.Store, receipt release.Receipt, sourceVersion int64) (verifiedRelease, bridgeSchemaContract, error) {
	var contract bridgeSchemaContract
	if receipt.Channel == "local" {
		return verifiedRelease{}, contract, errors.New("bridge transition requires an authenticated signed release")
	}
	verified, err := verifyInstalledReleaseForExecution(store, receipt)
	if err != nil {
		return verifiedRelease{}, contract, fmt.Errorf("verify bridge transition candidate: %w", err)
	}
	contract, err = readBridgeSchemaContract(verified, sourceVersion)
	if err != nil {
		return verifiedRelease{}, bridgeSchemaContract{}, err
	}
	return verified, contract, nil
}

// readBridgeSchemaContract accepts only a release already verified by
// verifyInstalledReleaseForExecution. It consumes bytes from one no-follow
// descriptor, rather than hashing a pathname and reopening it for parsing.
func readBridgeSchemaContract(verified verifiedRelease, sourceVersion int64) (bridgeSchemaContract, error) {
	var contract bridgeSchemaContract
	var digest string
	var size int64
	count := 0
	for _, file := range verified.distribution.Files {
		if file.Path != bridgeSchemaContractPath {
			continue
		}
		count++
		if file.Type != "file" || file.Mode != "0644" || file.SizeBytes <= 0 || file.SizeBytes > bridgeSchemaContractMaxBytes || !validSHA256(file.SHA256) {
			return contract, errors.New("signed schema transition contract is not a bounded regular file")
		}
		digest, size = file.SHA256, file.SizeBytes
	}
	if count != 1 {
		return contract, errors.New("signed release must declare exactly one schema transition contract")
	}

	dir := filepath.Join(verified.payloadRoot, "launcher")
	dirInfo, err := os.Lstat(dir)
	if err != nil || !dirInfo.IsDir() || dirInfo.Mode()&os.ModeSymlink != 0 {
		return contract, errors.New("schema transition directory is not a regular directory")
	}
	root, err := os.OpenRoot(dir)
	if err != nil {
		return contract, fmt.Errorf("open schema transition directory: %w", err)
	}
	defer root.Close()
	openedDir, err := root.Open(".")
	if err != nil {
		return contract, fmt.Errorf("inspect schema transition directory: %w", err)
	}
	openedInfo, statErr := openedDir.Stat()
	_ = openedDir.Close()
	if statErr != nil || !os.SameFile(dirInfo, openedInfo) {
		return contract, errors.New("schema transition directory changed during admission")
	}
	file, err := root.OpenFile("schema-transition.json", os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return contract, fmt.Errorf("open signed schema transition contract: %w", err)
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o644 || info.Size() != size {
		return contract, errors.New("schema transition contract no longer matches its signed file metadata")
	}
	raw, err := io.ReadAll(io.LimitReader(file, bridgeSchemaContractMaxBytes+1))
	if err != nil || int64(len(raw)) != size {
		return contract, errors.New("cannot read complete signed schema transition contract")
	}
	sum := sha256.Sum256(raw)
	if hex.EncodeToString(sum[:]) != digest {
		return contract, errors.New("schema transition contract differs from signed inventory")
	}
	contract, err = decodeBridgeSchemaContract(raw)
	if err != nil {
		return bridgeSchemaContract{}, err
	}
	if sourceVersion != 14 || contract.SourceUserVersion != sourceVersion || contract.TargetUserVersion != 15 {
		return bridgeSchemaContract{}, errors.New("signed schema transition does not authorize this v14 to v15 migration")
	}
	return contract, nil
}

// A token-level decoder rejects duplicate and case-variant keys as well as
// unknown fields; encoding/json's ordinary struct decoder accepts duplicates.
func decodeBridgeSchemaContract(raw []byte) (bridgeSchemaContract, error) {
	var result bridgeSchemaContract
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return result, errors.New("schema transition contract must be a JSON object")
	}
	seen := map[string]bool{}
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok || seen[key] {
			return result, errors.New("schema transition contract has an invalid or duplicate field")
		}
		seen[key] = true
		switch key {
		case "schemaVersion":
			err = decoder.Decode(&result.SchemaVersion)
		case "sourceUserVersion":
			err = decoder.Decode(&result.SourceUserVersion)
		case "targetUserVersion":
			err = decoder.Decode(&result.TargetUserVersion)
		default:
			return result, fmt.Errorf("unknown schema transition contract field %q", key)
		}
		if err != nil {
			return result, errors.New("schema transition contract field has invalid type")
		}
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') {
		return result, errors.New("schema transition contract object is incomplete")
	}
	if _, err = decoder.Token(); err != io.EOF || len(seen) != 3 || result.SchemaVersion != 1 {
		return result, errors.New("schema transition contract shape or version is invalid")
	}
	return result, nil
}
