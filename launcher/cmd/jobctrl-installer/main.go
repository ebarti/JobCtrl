// jobctrl-installer is the small native acquisition boundary used by curl and
// Homebrew. It deliberately has no source-checkout or toolchain fallback.
package main

import (
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"runtime"

	"github.com/ebarti/jobctrl/launcher/internal/installer"
	"github.com/ebarti/jobctrl/launcher/internal/launcher"
	"github.com/ebarti/jobctrl/launcher/internal/release"
)

func main() {
	var releaseURL, home, descriptorURL, descriptorFile, signatureFile, archiveFile, source string
	var bridgeRoleFile, bridgeRoleSignatureFile string
	var bridgeDescriptorURL, bridgeRoleURL string
	var allowUnsignedLocal, stageOnly, jsonOutput, bridgeRecover bool
	flag.StringVar(&releaseURL, "release-url", "", "signed release channel-pointer URL (default: compiled channel)")
	flag.StringVar(&home, "home", "", "JobCtrl runtime home (default: ~/Library/Application Support/JobCtrl)")
	flag.StringVar(&descriptorURL, "descriptor-url", "", "canonical HTTPS URL for a signed cached descriptor")
	flag.BoolVar(&allowUnsignedLocal, "allow-unsigned-local", false, "allow checked-in/local fixture files only")
	flag.StringVar(&descriptorFile, "descriptor-file", "", "local fixture descriptor JSON")
	flag.StringVar(&signatureFile, "signature-file", "", "local fixture descriptor signature JSON")
	flag.StringVar(&archiveFile, "archive-file", "", "local fixture ZIP archive")
	flag.StringVar(&source, "source", "curl", "acquisition adapter: curl or homebrew")
	flag.BoolVar(&stageOnly, "stage-only", false, "commit an authenticated immutable release without promoting it")
	flag.BoolVar(&jsonOutput, "json", false, "write the exact immutable install receipt as JSON")
	flag.StringVar(&bridgeRoleFile, "bridge-role-file", "", "signed schema-14 bridge declaration")
	flag.StringVar(&bridgeRoleSignatureFile, "bridge-role-signature-file", "", "signature for the bridge declaration")
	flag.BoolVar(&bridgeRecover, "bridge-recover", false, "complete a previously interrupted authenticated bridge handoff")
	flag.StringVar(&bridgeDescriptorURL, "bridge-descriptor-url", "", "canonical immutable signed bridge descriptor URL")
	flag.StringVar(&bridgeRoleURL, "bridge-role-url", "", "canonical signed bridge role URL in the same immutable build")
	flag.Parse()
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		fail("only darwin-arm64 is supported")
	}
	trust := launcher.EmbeddedReleaseTrust()
	policy, policyErr := launcher.AcquisitionBuildPolicy()
	if policyErr != nil {
		fail(policyErr.Error())
	}
	if source != "curl" && source != "homebrew" {
		fail("--source must be curl or homebrew")
	}
	bridgeNetwork := bridgeDescriptorURL != "" || bridgeRoleURL != ""
	bridge := bridgeRecover || bridgeRoleFile != "" || bridgeRoleSignatureFile != "" || bridgeNetwork
	if source == "homebrew" && !bridgeRecover && (allowUnsignedLocal || descriptorURL == "" || descriptorFile == "" || signatureFile == "" || archiveFile == "") {
		fail("--source homebrew requires the complete signed cached formula descriptor, signature, and archive mode")
	}
	if source == "curl" && descriptorURL != "" && !bridge {
		fail("signed cached release inputs are reserved for the Homebrew acquisition adapter")
	}
	options := installer.Options{Home: home, ReleaseURL: releaseURL, Trust: trust, Policy: policy, AllowUnsignedLocal: allowUnsignedLocal, AcquisitionSource: source, StageOnly: stageOnly}
	var receipt installer.Receipt
	var err error
	if bridge {
		if allowUnsignedLocal || stageOnly || releaseURL != "" {
			fail("bridge handoff requires signed cached inputs and cannot use stage-only or release-url")
		}
		if bridgeNetwork {
			if source != "curl" || bridgeRecover || descriptorURL != "" || descriptorFile != "" || signatureFile != "" || archiveFile != "" || bridgeRoleFile != "" || bridgeRoleSignatureFile != "" || bridgeDescriptorURL == "" || bridgeRoleURL == "" {
				fail("network bridge requires both bridge URLs and cannot mix cached inputs or recovery flags")
			}
			receipt, err = installer.InstallSignedNetworkBridge(options, bridgeDescriptorURL, bridgeRoleURL)
		} else if bridgeRecover {
			if descriptorURL != "" || descriptorFile != "" || signatureFile != "" || archiveFile != "" || bridgeRoleFile != "" || bridgeRoleSignatureFile != "" {
				fail("bridge recovery uses only retained signed evidence; do not pass acquisition files")
			}
			receipt, err = installer.InstallSignedCachedBridge(options, installer.CachedBridgeInput{})
		} else {
			if descriptorURL == "" || descriptorFile == "" || signatureFile == "" || archiveFile == "" || bridgeRoleFile == "" || bridgeRoleSignatureFile == "" {
				fail("bridge handoff requires the complete signed descriptor, archive and bridge declaration")
			}
			receipt, err = installer.InstallSignedCachedBridge(options, installer.CachedBridgeInput{DescriptorURL: descriptorURL, DescriptorPath: descriptorFile, DescriptorSignaturePath: signatureFile, ArchivePath: archiveFile, AttestationPath: bridgeRoleFile, AttestationSignaturePath: bridgeRoleSignatureFile})
		}
	} else if allowUnsignedLocal {
		if !policy.AllowUnsignedLocal {
			fail("unsigned-local fixtures are unavailable in this signed installer build")
		}
		if releaseURL != "" || descriptorURL != "" {
			fail("unsigned-local mode cannot use network release options")
		}
		receipt, err = installer.InstallFromLocalFiles(options, descriptorFile, signatureFile, archiveFile)
	} else if descriptorFile != "" || signatureFile != "" || archiveFile != "" || descriptorURL != "" {
		if descriptorURL == "" || descriptorFile == "" || signatureFile == "" || archiveFile == "" {
			fail("signed cached mode requires --descriptor-url, --descriptor-file, --signature-file, and --archive-file")
		}
		receipt, err = installer.InstallFromCachedFiles(options, descriptorURL, descriptorFile, signatureFile, archiveFile)
	} else {
		receipt, err = installer.InstallFromNetwork(options)
	}
	if err != nil {
		fail(err.Error())
	}
	if !stageOnly && !bridge {
		if err := promoteStagedIfNeeded(home, source, receipt); err != nil {
			fail(err.Error())
		}
	}
	if jsonOutput {
		if err := writeReceipt(os.Stdout, receipt, true); err != nil {
			fail(err.Error())
		}
		return
	}
	if err := writeReceipt(os.Stdout, receipt, false); err != nil {
		fail(err.Error())
	}
}

func writeReceipt(output io.Writer, receipt installer.Receipt, jsonOutput bool) error {
	if jsonOutput {
		return json.NewEncoder(output).Encode(receipt)
	}
	_, err := fmt.Fprintf(output, "Installed JobCtrl %s (%s, manifest %s)\n", receipt.BuildID, receipt.ArtifactSHA256, receipt.ManifestSHA256)
	return err
}

// A different already-installed build is only an acquisition result. The
// newly authenticated controller performs health-gated promotion, which keeps
// migration decisions independent of immutable older launchers. First install
// was activated inside the installer because no predecessor existed.
func promoteStagedIfNeeded(home, source string, candidate installer.Receipt) error {
	runtimeHome, err := installer.RuntimeHome(home)
	if err != nil {
		return err
	}
	store, err := release.Open(runtimeHome)
	if err != nil {
		return err
	}
	active, err := store.ReadActive()
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read active release before staged promotion: %w", err)
	}
	if active.Receipt.BuildID == candidate.BuildID {
		return nil
	}
	return launcher.PromoteStagedRelease(runtimeHome, candidate.BuildID, source, os.Environ(), io.Discard)
}

func fail(message string) { fmt.Fprintln(os.Stderr, "jobctrl-installer:", message); os.Exit(1) }
