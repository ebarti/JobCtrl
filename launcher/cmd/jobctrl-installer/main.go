// jobctrl-installer is the small native acquisition boundary used by curl and
// Homebrew. It deliberately has no source-checkout or toolchain fallback.
package main

import (
	"flag"
	"fmt"
	"os"
	"runtime"

	"github.com/ebarti/jobctrl/launcher/internal/installer"
	"github.com/ebarti/jobctrl/launcher/internal/launcher"
)

func main() {
	var releaseURL, home, descriptorURL, descriptorFile, signatureFile, archiveFile string
	var allowUnsignedLocal bool
	flag.StringVar(&releaseURL, "release-url", installer.DefaultReleaseURL, "signed stable release descriptor URL")
	flag.StringVar(&home, "home", "", "JobCtrl runtime home (default: ~/Library/Application Support/JobCtrl)")
	flag.StringVar(&descriptorURL, "descriptor-url", "", "canonical HTTPS URL for a signed cached descriptor")
	flag.BoolVar(&allowUnsignedLocal, "allow-unsigned-local", false, "allow checked-in/local fixture files only")
	flag.StringVar(&descriptorFile, "descriptor-file", "", "local fixture descriptor JSON")
	flag.StringVar(&signatureFile, "signature-file", "", "local fixture descriptor signature JSON")
	flag.StringVar(&archiveFile, "archive-file", "", "local fixture ZIP archive")
	flag.Parse()
	if runtime.GOOS != "darwin" || runtime.GOARCH != "arm64" {
		fail("only darwin-arm64 is supported")
	}
	trust := launcher.EmbeddedReleaseTrust()
	policy, policyErr := launcher.AcquisitionBuildPolicy()
	if policyErr != nil {
		fail(policyErr.Error())
	}
	options := installer.Options{Home: home, ReleaseURL: releaseURL, Trust: trust, Policy: policy, AllowUnsignedLocal: allowUnsignedLocal}
	var receipt installer.Receipt
	var err error
	if allowUnsignedLocal {
		if !policy.AllowUnsignedLocal {
			fail("unsigned-local fixtures are unavailable in this signed installer build")
		}
		if releaseURL != installer.DefaultReleaseURL || descriptorURL != "" {
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
	fmt.Printf("Installed JobCtrl %s (%s, manifest %s)\n", receipt.BuildID, receipt.ArtifactSHA256, receipt.ManifestSHA256)
}

func fail(message string) { fmt.Fprintln(os.Stderr, "jobctrl-installer:", message); os.Exit(1) }
