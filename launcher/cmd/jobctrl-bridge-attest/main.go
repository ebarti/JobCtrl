// jobctrl-bridge-attest signs a bridge declaration for two authenticated
// release archives. It does not build, notarize, publish, or install a bridge.
package main

import (
	"bytes"
	"crypto/ed25519"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"

	"github.com/ebarti/jobctrl/launcher/internal/installer"
)

const (
	maxDescriptorSize = 1 << 20
	maxSignatureSize  = 16 << 10
	maxTrustSize      = 64 << 10
	maxSigningKeySize = 4096
)

type archiveFlags struct {
	url, descriptor, signature, archive string
}

type generatorFunc func(installer.BridgeArchiveInput, installer.BridgeArchiveInput, map[string]ed25519.PublicKey, string, ed25519.PrivateKey) ([]byte, []byte, error)

func main() {
	if err := run(os.Args[1:], os.Getenv("JOBCTRL_BRIDGE_SIGNING_KEY_BASE64"), installer.GenerateSignedBridgeAttestation); err != nil {
		fmt.Fprintln(os.Stderr, "bridge attestation:", err)
		os.Exit(1)
	}
}

func run(args []string, encodedPrivate string, generate generatorFunc) error {
	flags := flag.NewFlagSet("jobctrl-bridge-attest", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	var old, next archiveFlags
	bind := func(prefix string, target *archiveFlags) {
		flags.StringVar(&target.url, prefix+"-descriptor-url", "", "canonical immutable descriptor URL")
		flags.StringVar(&target.descriptor, prefix+"-descriptor-file", "", "signed descriptor")
		flags.StringVar(&target.signature, prefix+"-signature-file", "", "descriptor signature")
		flags.StringVar(&target.archive, prefix+"-archive-file", "", "signed release archive")
	}
	bind("predecessor", &old)
	bind("candidate", &next)
	var trustPath, keyID, output string
	flags.StringVar(&trustPath, "trust-keys-file", "", "JSON map of key identifiers to base64 Ed25519 public keys")
	flags.StringVar(&keyID, "key-id", "", "trusted signing key identifier")
	flags.StringVar(&output, "output-dir", "", "new output directory")
	if err := flags.Parse(args); err != nil {
		return errors.New("invalid command arguments")
	}
	if flags.NArg() != 0 || old.url == "" || old.descriptor == "" || old.signature == "" || old.archive == "" || next.url == "" || next.descriptor == "" || next.signature == "" || next.archive == "" || trustPath == "" || keyID == "" || !filepath.IsAbs(output) {
		return errors.New("both signed archives, trust keys, key ID, and an absolute new output directory are required")
	}
	trustRaw, err := readRegular(trustPath, maxTrustSize)
	if err != nil {
		return fmt.Errorf("read trust keys: %w", err)
	}
	trust, err := parseTrust(trustRaw)
	if err != nil {
		return err
	}
	private, err := parsePrivate(encodedPrivate)
	if err != nil {
		return err
	}
	defer clear(private)
	public, ok := trust[keyID]
	if !ok || !private.Public().(ed25519.PublicKey).Equal(public) {
		return errors.New("signing key does not match the trusted key ID")
	}
	readArchive := func(in archiveFlags) (installer.BridgeArchiveInput, error) {
		descriptor, err := readRegular(in.descriptor, maxDescriptorSize)
		if err != nil {
			return installer.BridgeArchiveInput{}, fmt.Errorf("read descriptor: %w", err)
		}
		signature, err := readRegular(in.signature, maxSignatureSize)
		if err != nil {
			return installer.BridgeArchiveInput{}, fmt.Errorf("read descriptor signature: %w", err)
		}
		st, err := os.Lstat(in.archive)
		if err != nil || !st.Mode().IsRegular() || st.Mode()&os.ModeSymlink != 0 {
			return installer.BridgeArchiveInput{}, errors.New("archive must be a regular non-symlink file")
		}
		return installer.BridgeArchiveInput{DescriptorURL: in.url, DescriptorRaw: descriptor, SignatureRaw: signature, ArchivePath: in.archive}, nil
	}
	predecessor, err := readArchive(old)
	if err != nil {
		return err
	}
	candidate, err := readArchive(next)
	if err != nil {
		return err
	}
	claim, signature, err := generate(predecessor, candidate, trust, keyID, private)
	if err != nil {
		return fmt.Errorf("verify signed archives and generate declaration: %w", err)
	}
	if err := writeNewOutput(output, claim, signature); err != nil {
		return fmt.Errorf("write declaration: %w", err)
	}
	return nil
}

func readRegular(path string, max int64) ([]byte, error) {
	before, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !before.Mode().IsRegular() || before.Mode()&os.ModeSymlink != 0 || before.Size() > max {
		return nil, errors.New("input must be a bounded regular non-symlink file")
	}
	fd, err := syscall.Open(path, syscall.O_RDONLY|syscall.O_NOFOLLOW, 0)
	if err != nil {
		return nil, err
	}
	f := os.NewFile(uintptr(fd), path)
	defer f.Close()
	actual, err := f.Stat()
	if err != nil || !actual.Mode().IsRegular() || !os.SameFile(before, actual) {
		return nil, errors.New("input changed while opening")
	}
	raw, err := io.ReadAll(io.LimitReader(f, max+1))
	if err != nil || int64(len(raw)) > max {
		return nil, errors.New("input exceeds size limit or could not be read")
	}
	return raw, nil
}

func parseTrust(raw []byte) (map[string]ed25519.PublicKey, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	token, err := dec.Token()
	if err != nil || token != json.Delim('{') {
		return nil, errors.New("trust keys must be a JSON object")
	}
	keys := make(map[string]ed25519.PublicKey)
	for dec.More() {
		token, err = dec.Token()
		id, ok := token.(string)
		if err != nil || !ok || id == "" || len(id) > 256 || len(keys) >= 64 {
			return nil, errors.New("invalid trust key identifier")
		}
		if _, duplicate := keys[id]; duplicate {
			return nil, errors.New("duplicate trust key identifier")
		}
		var value string
		if err = dec.Decode(&value); err != nil {
			return nil, errors.New("invalid trust key")
		}
		key, err := base64.StdEncoding.Strict().DecodeString(value)
		if err != nil || len(key) != ed25519.PublicKeySize || base64.StdEncoding.EncodeToString(key) != value {
			return nil, errors.New("invalid trust public key")
		}
		keys[id] = ed25519.PublicKey(key)
	}
	if token, err = dec.Token(); err != nil || token != json.Delim('}') || len(keys) == 0 {
		return nil, errors.New("invalid trust keys")
	}
	if _, err = dec.Token(); err != io.EOF {
		return nil, errors.New("trailing trust key data")
	}
	return keys, nil
}

func parsePrivate(encoded string) (ed25519.PrivateKey, error) {
	if encoded == "" || len(encoded) > maxSigningKeySize {
		return nil, errors.New("signing key is missing or invalid")
	}
	der, err := base64.StdEncoding.Strict().DecodeString(encoded)
	if err != nil || base64.StdEncoding.EncodeToString(der) != encoded {
		return nil, errors.New("signing key is missing or invalid")
	}
	defer clear(der)
	parsed, err := x509.ParsePKCS8PrivateKey(der)
	if err != nil {
		return nil, errors.New("signing key is missing or invalid")
	}
	key, ok := parsed.(ed25519.PrivateKey)
	if !ok || len(key) != ed25519.PrivateKeySize {
		return nil, errors.New("signing key is missing or invalid")
	}
	return key, nil
}

func writeNewOutput(output string, claim, signature []byte) (err error) {
	if err = os.Mkdir(output, 0700); err != nil {
		return err
	}
	// Only remove exact files created by this invocation, then remove the empty
	// directory. Never recursively remove a caller-supplied path.
	created := []string{}
	defer func() {
		if err != nil {
			for _, file := range created {
				_ = os.Remove(file)
			}
			_ = os.Remove(output)
		}
	}()
	for _, file := range []struct {
		name  string
		value []byte
	}{{"bridge-attestation.json", claim}, {"bridge-attestation.json.sig", signature}} {
		path := filepath.Join(output, file.name)
		f, openErr := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if openErr != nil {
			return openErr
		}
		created = append(created, path)
		_, writeErr := f.Write(file.value)
		if writeErr == nil {
			writeErr = f.Sync()
		}
		closeErr := f.Close()
		if writeErr != nil {
			return writeErr
		}
		if closeErr != nil {
			return closeErr
		}
	}
	dir, err := os.Open(output)
	if err != nil {
		return err
	}
	err = dir.Sync()
	closeErr := dir.Close()
	if err != nil {
		return err
	}
	return closeErr
}
