package installer

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/ebarti/jobctrl/launcher/internal/release"
)

// A route catalog is a signed locator, not authority to activate a release.
// The selected descriptor, source-bound bridge role, payload inventories, and
// final-target policy are all verified independently under lifecycle locks.
type bridgeRouteCatalog struct {
	SchemaVersion int           `json:"schemaVersion"`
	Channel       string        `json:"channel"`
	Platform      string        `json:"platform"`
	Routes        []bridgeRoute `json:"routes"`
}

type bridgeRoute struct {
	SourceDescriptorSHA256 string `json:"sourceDescriptorSha256"`
	TargetDescriptorSHA256 string `json:"targetDescriptorSha256"`
	BridgeDescriptorSHA256 string `json:"bridgeDescriptorSha256"`
	BridgeDescriptorURL    string `json:"bridgeDescriptorUrl"`
	BridgeRoleURL          string `json:"bridgeRoleUrl"`
}

const bridgeRouteDomain = "jobctrl:bridge-route-catalog:v1\x00"
const maxBridgeRoutes = 256

func verifyBridgeRouteCatalog(raw, signatureRaw []byte, trust map[string]ed25519.PublicKey, channel string) (bridgeRouteCatalog, error) {
	var catalog bridgeRouteCatalog
	var signature bridgeAttestationSignature
	if len(raw) == 0 || len(raw) > maxDescriptorBytes || len(signatureRaw) == 0 || len(signatureRaw) > maxSignatureBytes {
		return catalog, errors.New("bridge route catalog or signature missing or oversized")
	}
	if err := decodeStrict(signatureRaw, "bridge route signature", &signature); err != nil {
		return catalog, err
	}
	canonicalSignature, err := json.Marshal(signature)
	if err != nil || !bytes.Equal(signatureRaw, canonicalSignature) {
		return catalog, errors.New("bridge route signature is not canonical")
	}
	key := trust[signature.KeyID]
	decoded, err := base64.StdEncoding.Strict().DecodeString(signature.Signature)
	if signature.SchemaVersion != 1 || signature.Algorithm != "ed25519" || signature.KeyID == "" || len(key) != ed25519.PublicKeySize || err != nil || len(decoded) != ed25519.SignatureSize || !ed25519.Verify(key, signingMessage(bridgeRouteDomain, raw), decoded) {
		return catalog, errors.New("bridge route catalog signature invalid")
	}
	if err := decodeStrict(raw, "bridge route catalog", &catalog); err != nil {
		return catalog, err
	}
	// Require one canonical byte representation. This rejects duplicate keys,
	// case-folded field aliases and omitted fields before selection.
	canonical, err := json.Marshal(catalog)
	if err != nil || !bytes.Equal(raw, canonical) {
		return catalog, errors.New("bridge route catalog is not canonical")
	}
	if catalog.SchemaVersion != 1 || (channel != "stable" && channel != "prerelease") || catalog.Channel != channel || catalog.Platform != "darwin-arm64" || len(catalog.Routes) == 0 || len(catalog.Routes) > maxBridgeRoutes {
		return catalog, errors.New("invalid bridge route catalog identity or route count")
	}
	seen := make(map[string]bool, len(catalog.Routes))
	for _, route := range catalog.Routes {
		if !sha256Pattern.MatchString(route.SourceDescriptorSHA256) || !sha256Pattern.MatchString(route.TargetDescriptorSHA256) || !sha256Pattern.MatchString(route.BridgeDescriptorSHA256) || route.SourceDescriptorSHA256 == route.TargetDescriptorSHA256 || route.BridgeDescriptorSHA256 == route.SourceDescriptorSHA256 || route.BridgeDescriptorSHA256 == route.TargetDescriptorSHA256 {
			return catalog, errors.New("invalid bridge route descriptor identity")
		}
		_, build, err := validateImmutableDescriptorURL(route.BridgeDescriptorURL)
		if err != nil {
			return catalog, fmt.Errorf("bridge route descriptor URL: %w", err)
		}
		role, err := parseCanonicalReleaseURL(route.BridgeRoleURL)
		if err != nil {
			return catalog, fmt.Errorf("bridge route role URL: %w", err)
		}
		parent := "/v1/artifacts/" + build + "/"
		name := strings.TrimPrefix(role.Path, parent)
		if !strings.HasPrefix(role.Path, parent) || name == "" || name == "." || name == ".." || strings.Contains(name, "/") || name == "release-descriptor.json" || strings.HasSuffix(name, ".sig") {
			return catalog, errors.New("bridge route role must identify a separate file in the same immutable build")
		}
		pair := route.SourceDescriptorSHA256 + ":" + route.TargetDescriptorSHA256
		if seen[pair] {
			return catalog, errors.New("duplicate source and target bridge route")
		}
		seen[pair] = true
	}
	return catalog, nil
}

// InstallSignedCatalogBridge executes only the bridge handoff, never target
// promotion. All paths are caller-supplied signed files. Missing/ambiguous
// routes fail closed. During interrupted recovery use --bridge-recover, which
// depends only on retained signed handoff evidence and needs no catalog files.
func InstallSignedCatalogBridge(options Options, catalogPath, signaturePath, targetURL, targetPath, targetSignaturePath string) (Receipt, error) {
	if !options.Policy.AllowNetwork || options.AllowUnsignedLocal || options.StageOnly || options.ReleaseURL != "" || len(options.Trust) == 0 {
		return Receipt{}, errors.New("catalog bridge requires signed non-stage-only acquisition")
	}
	catalogRaw, err := readBridgeRegular(catalogPath, maxDescriptorBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("read bridge route catalog: %w", err)
	}
	sig, err := readBridgeRegular(signaturePath, maxSignatureBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("read bridge route signature: %w", err)
	}
	catalog, err := verifyBridgeRouteCatalog(catalogRaw, sig, options.Trust, options.Policy.ExpectedChannel)
	if err != nil {
		return Receipt{}, err
	}
	targetRaw, err := readBridgeRegular(targetPath, maxDescriptorBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("read final target descriptor: %w", err)
	}
	targetSig, err := readBridgeRegular(targetSignaturePath, maxSignatureBytes)
	if err != nil {
		return Receipt{}, fmt.Errorf("read final target signature: %w", err)
	}
	parsed, build, err := validateImmutableDescriptorURL(targetURL)
	if err != nil {
		return Receipt{}, fmt.Errorf("final target descriptor URL: %w", err)
	}
	target, err := verifyDescriptor(targetRaw, targetSig, options.Trust, false, parsed, false)
	if err != nil {
		return Receipt{}, err
	}
	if target.BuildID != build || target.Channel != catalog.Channel {
		return Receipt{}, errors.New("final target differs from catalog channel or URL")
	}
	if err := validateCanonicalArtifactURL(target, parsed); err != nil {
		return Receipt{}, err
	}
	home, err := RuntimeHome(options.Home)
	if err != nil {
		return Receipt{}, err
	}
	info, err := os.Lstat(home)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return Receipt{}, errors.New("bridge runtime home is not a regular directory")
	}
	store := &release.Store{Home: home}
	// This unlocked read is only a lookup hint. The network handoff rechecks
	// both signed route identities under its transition and selection locks.
	active, err := store.ReadActive()
	if err != nil {
		return Receipt{}, fmt.Errorf("read bridge route predecessor: %w", err)
	}
	source := active.Receipt
	intentRaw, intentErr := readBridgeRegular(filepath.Join(home, bridgeIntentName), maxBridgeIntentBytes)
	if intentErr == nil {
		var intent bridgeHandoffIntent
		if err := decodeStrict(intentRaw, "bridge handoff intent", &intent); err != nil {
			return Receipt{}, err
		}
		source = intent.Source.Receipt
	} else if !errors.Is(intentErr, os.ErrNotExist) {
		return Receipt{}, intentErr
	}
	if !source.Valid() || source.Channel != catalog.Channel {
		return Receipt{}, errors.New("bridge route predecessor identity invalid")
	}
	targetDigest := digestBytes(targetRaw)
	find := func(sourceDigest string) (bridgeRoute, bool) {
		for _, route := range catalog.Routes {
			if route.SourceDescriptorSHA256 == sourceDigest && route.TargetDescriptorSHA256 == targetDigest {
				return route, true
			}
		}
		return bridgeRoute{}, false
	}
	route, found := find(source.DescriptorSHA256)
	if !found && errors.Is(intentErr, os.ErrNotExist) {
		// Retrying an already completed handoff is keyed by its recorded source.
		// The handoff verifies this completion against retained signed evidence.
		completed, completionErr := findCompletedBridge(home, "")
		if completionErr == nil {
			route, found = find(completed.Source.Receipt.DescriptorSHA256)
			source = completed.Source.Receipt
		} else if !errors.Is(completionErr, os.ErrNotExist) {
			return Receipt{}, completionErr
		}
	}
	if !found {
		return Receipt{}, errors.New("no authenticated bridge route for this predecessor and target")
	}
	return installSignedNetworkBridge(options, route.BridgeDescriptorURL, route.BridgeRoleURL, targetURL, source.DescriptorSHA256, route.BridgeDescriptorSHA256, targetDigest)
}
