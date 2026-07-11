import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildFixturePayload } from "./distribution-build.mjs";
import {
  validateReleaseDescriptor,
  validateReleaseDescriptorSignature,
} from "./distribution-release.mjs";

function contractMap(raw) {
  return new Map(raw.trim().split("\n").map((line) => line.split(/=(.*)/s)));
}

test("local fixture release descriptor, signature, and curl contract bind one ZIP identity", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-release-contract-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const build = await buildFixturePayload({ outputDirectory: root, buildId: "fixture-build-0001", sourceDateEpoch: 0 });
  const [descriptorRaw, signatureRaw, contractRaw] = await Promise.all([
    readFile(build.release.descriptorPath, "utf8"),
    readFile(build.release.signaturePath, "utf8"),
    readFile(build.release.contractPath, "utf8"),
  ]);
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw), { requireLocalFileTransport: true });
  const signature = validateReleaseDescriptorSignature(JSON.parse(signatureRaw), { channel: descriptor.channel });
  assert.deepEqual(signature, {
    schemaVersion: 1,
    status: "unsigned-local",
    algorithm: "ed25519",
    keyId: "local-development",
    signature: null,
  });
  assert.deepEqual(descriptor, {
    schemaVersion: 1,
    channel: "local",
    sequence: 1,
    minimumSafeSequence: 0,
    revokedBuildIds: [],
    buildId: "fixture-build-0001",
    appVersion: "2.0.0",
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: {
      url: "file:///jobctrl-local-release/jobctrl-2.0.0-darwin-arm64.zip",
      sha256: build.archiveSha256,
      sizeBytes: build.compressedBytes,
      archiveType: "zip",
      manifestSha256: build.manifestSha256,
    },
  });
  const contract = contractMap(contractRaw);
  assert.deepEqual([...contract.keys()], [
    "MODE", "PLATFORM", "INSTALLER_URL", "INSTALLER_SHA256", "INSTALLER_VERSION", "DESCRIPTOR_FILE", "SIGNATURE_FILE", "ARCHIVE_FILE",
  ]);
  assert.equal(contract.get("MODE"), "local-fixture");
  assert.equal(contract.get("PLATFORM"), descriptor.platform.id);
  assert.equal(contract.get("INSTALLER_VERSION"), descriptor.appVersion);
  assert.equal(contract.get("DESCRIPTOR_FILE"), build.release.descriptorPath);
  assert.equal(contract.get("SIGNATURE_FILE"), build.release.signaturePath);
  assert.equal(contract.get("ARCHIVE_FILE"), build.archivePath);
  assert.match(contract.get("INSTALLER_URL"), /^file:\/\//);
  assert.equal(build.release.artifactSha256, descriptor.artifact.sha256);
  assert.equal(build.release.manifestSha256, descriptor.artifact.manifestSha256);
});

test("local descriptor rejects network transport and signed channels reject an unsigned envelope", () => {
  const descriptor = {
    schemaVersion: 1,
    channel: "local",
    sequence: 1,
    minimumSafeSequence: 0,
    revokedBuildIds: [],
    buildId: "fixture-build-0001",
    appVersion: "2.0.0",
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: { url: "https://releases.example.test/jobctrl.zip", sha256: "a".repeat(64), sizeBytes: 1, archiveType: "zip", manifestSha256: "b".repeat(64) },
  };
  assert.throws(() => validateReleaseDescriptor(descriptor), /file:\/\//);
  assert.throws(() => validateReleaseDescriptor({ ...descriptor, minimumSafeSequence: 2 }), /minimumSafeSequence/);
  assert.throws(() => validateReleaseDescriptor({ ...descriptor, revokedBuildIds: ["fixture-build-0002", "fixture-build-0002"] }), /sorted and unique/);
  assert.throws(
    () => validateReleaseDescriptorSignature({ schemaVersion: 1, status: "unsigned-local", algorithm: "ed25519", keyId: "local-development", signature: null }, { channel: "stable" }),
    /network release descriptor requires a release signature/,
  );
});

test("descriptor bounds and local file URLs match the native installer contract", () => {
  const descriptor = {
    schemaVersion: 1,
    channel: "local",
    sequence: 1,
    minimumSafeSequence: 0,
    revokedBuildIds: [],
    buildId: "fixture-build-0001",
    appVersion: "2.0.0",
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: { url: "file:///jobctrl-local-release/fixture.zip", sha256: "a".repeat(64), sizeBytes: 1, archiveType: "zip", manifestSha256: "b".repeat(64) },
  };
  assert.doesNotThrow(() => validateReleaseDescriptor(descriptor));
  assert.throws(() => validateReleaseDescriptor({ ...descriptor, artifact: { ...descriptor.artifact, url: "file://attacker.example/fixture.zip" } }), /canonical absolute file/);
  assert.throws(() => validateReleaseDescriptor({ ...descriptor, sequence: Number.MAX_SAFE_INTEGER + 1 }), /positive integer/);
  assert.throws(() => validateReleaseDescriptor({ ...descriptor, artifact: { ...descriptor.artifact, sizeBytes: 4 * 1024 * 1024 * 1024 + 1 } }), /sizeBytes/);
});
