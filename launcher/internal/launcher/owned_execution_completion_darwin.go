//go:build darwin

package launcher

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

// A completion preserves the exact retired scope identity. A later native
// execution can use it as read-only evidence for crashed Apply custody; a
// missing active receipt, a PID, or an environment variable is never that proof.
type executionCompletion struct {
	SchemaVersion           int            `json:"schemaVersion"`
	Scope                   executionScope `json:"scope"`
	ReceiptSHA256           string         `json:"receiptSha256"`
	VerificationBootSession string         `json:"verificationBootSession"`
	CompletedAt             time.Time      `json:"completedAt"`
}

func executionCompletionDirectory(ctx launchContext, create bool) (string, error) {
	dir := filepath.Join(filepath.Dir(ctx.Instance.StatePath), "completed-executions")
	if create {
		if err := os.Mkdir(dir, 0700); err != nil && !errors.Is(err, os.ErrExist) {
			return "", err
		}
	}
	info, err := os.Lstat(dir)
	if err != nil {
		return "", err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 || info.Mode().Perm() != 0700 || !ok || int(stat.Uid) != os.Getuid() {
		return "", errors.New("unsafe execution completion directory")
	}
	return dir, nil
}

func decodeExecutionCompletion(raw []byte, completion *executionCompletion) error {
	allowed := map[string]bool{"schemaVersion": true, "scope": true, "receiptSha256": true, "verificationBootSession": true, "completedAt": true}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || token != json.Delim('{') {
		return errors.New("invalid execution completion object")
	}
	values := make(map[string]json.RawMessage, len(allowed))
	for decoder.More() {
		token, err := decoder.Token()
		key, ok := token.(string)
		if err != nil || !ok || !allowed[key] || values[key] != nil {
			return errors.New("unfamiliar or repeated execution completion key")
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		values[key] = value
	}
	if token, err = decoder.Token(); err != nil || token != json.Delim('}') || len(values) != len(allowed) {
		return errors.New("incomplete execution completion")
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return errors.New("trailing execution completion")
	}
	if err := json.Unmarshal(raw, completion); err != nil {
		return err
	}
	// The nested scope has the same exact-key and duplicate rejection as an
	// active receipt, rather than encoding/json's case-insensitive aliases.
	return decodeExecutionReceipt(values["scope"], &completion.Scope)
}

func validateExecutionCompletion(ctx launchContext, completion executionCompletion) error {
	if completion.SchemaVersion != 1 || !validExecutionBootSession(completion.VerificationBootSession) || completion.CompletedAt.IsZero() || len(completion.ReceiptSHA256) != 64 {
		return errors.New("invalid execution completion")
	}
	digest, err := hex.DecodeString(completion.ReceiptSHA256)
	if err != nil || hex.EncodeToString(digest) != completion.ReceiptSHA256 {
		return errors.New("invalid execution completion receipt digest")
	}
	return validateExecutionScope(ctx, completion.Scope)
}

func readExecutionCompletion(ctx launchContext, id string) (executionCompletion, error) {
	var completion executionCompletion
	if !executionIDValid(id) {
		return completion, errors.New("invalid execution completion identity")
	}
	dir, err := executionCompletionDirectory(ctx, false)
	if err != nil {
		return completion, err
	}
	file, err := os.OpenFile(filepath.Join(dir, id+".json"), os.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return completion, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return completion, err
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !info.Mode().IsRegular() || info.Mode().Perm() != 0600 || info.Size() > 32768 || !ok || int(stat.Uid) != os.Getuid() || stat.Nlink != 1 {
		return completion, errors.New("unsafe execution completion")
	}
	raw, err := io.ReadAll(io.LimitReader(file, 32769))
	if err != nil {
		return completion, err
	}
	if len(raw) > 32768 {
		return completion, errors.New("oversized execution completion")
	}
	if err := decodeExecutionCompletion(raw, &completion); err != nil {
		return completion, err
	}
	if completion.Scope.ID != id {
		return completion, errors.New("execution completion filename mismatch")
	}
	return completion, validateExecutionCompletion(ctx, completion)
}

// The lifecycle control lock serializes ordinary native publishers. An original
// probe controller may preserve its joined/zero proof while Stop holds that lock;
// concurrent publishers can only attest the same exact scope and receipt digest.
// Reuse the synced temporary-and-rename protocol: interrupted publication cannot
// leave a partially written proof, and a different scope/digest is refused.
func publishExecutionCompletion(ctx launchContext, completion executionCompletion) error {
	dir, err := executionCompletionDirectory(ctx, true)
	if err != nil {
		return err
	}
	if err := validateExecutionCompletion(ctx, completion); err != nil {
		return err
	}
	final := filepath.Join(dir, completion.Scope.ID+".json")
	previous, err := readExecutionCompletion(ctx, completion.Scope.ID)
	if err == nil {
		if previous.Scope != completion.Scope || previous.ReceiptSHA256 != completion.ReceiptSHA256 {
			return errors.New("execution completion does not match its retired receipt")
		}
		return nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return writeJSONAtomic(final, completion)
}

func executionCompletionForReceipt(scope executionScope, raw []byte, boot string) executionCompletion {
	digest := sha256.Sum256(raw)
	return executionCompletion{1, scope, hex.EncodeToString(digest[:]), boot, time.Now().UTC()}
}
