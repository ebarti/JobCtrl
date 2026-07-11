package main

import (
	"bytes"
	"encoding/json"
	"io"
	"testing"

	"github.com/ebarti/jobctrl/launcher/internal/installer"
)

func TestWriteReceiptJSONIsMachineReadableAndExact(t *testing.T) {
	receipt := installer.Receipt{
		SchemaVersion:    2,
		BuildID:          "fixture-build-0001",
		Channel:          "stable",
		Sequence:         7,
		ArtifactSHA256:   "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
		ManifestSHA256:   "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		DescriptorSHA256: "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		PolicySHA256:     "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
		DescriptorURL:    "https://releases.example.test/v1/stable/darwin-arm64.json",
		InstalledAt:      "2026-07-11T12:00:00Z",
	}
	var output bytes.Buffer
	if err := writeReceipt(&output, receipt, true); err != nil {
		t.Fatal(err)
	}
	var decoded installer.Receipt
	decoder := json.NewDecoder(&output)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&decoded); err != nil || decoded != receipt {
		t.Fatalf("JSON receipt = %#v, %v", decoded, err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("JSON receipt contained a second value: %v", err)
	}
}

func TestWriteReceiptHumanOutputRemainsHumanReadable(t *testing.T) {
	var output bytes.Buffer
	if err := writeReceipt(&output, installer.Receipt{BuildID: "fixture-build-0001", ArtifactSHA256: "artifact", ManifestSHA256: "manifest"}, false); err != nil {
		t.Fatal(err)
	}
	if got, want := output.String(), "Installed JobCtrl fixture-build-0001 (artifact, manifest manifest)\n"; got != want {
		t.Fatalf("human receipt = %q, want %q", got, want)
	}
}
