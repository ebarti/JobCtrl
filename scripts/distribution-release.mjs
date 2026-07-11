#!/usr/bin/env node

import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const CHANNELS = new Set(["local", "prerelease", "stable"]);
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function bytewiseCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function assertExactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  const actual = Object.keys(value).sort(bytewiseCompare);
  const expected = [...keys].sort(bytewiseCompare);
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `${label} fields must be exactly [${expected.join(", ")}]`);
  return value;
}

function sha256Bytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

export async function sha256File(filePath) {
  return sha256Bytes(await readFile(filePath));
}

function validateBuildPlatform(platform) {
  invariant(platform !== null && typeof platform === "object" && !Array.isArray(platform), "release platform must be an object");
  invariant(platform.id === "darwin-arm64" && platform.os === "darwin" && platform.arch === "arm64", "release platform must be darwin-arm64");
  invariant(/^\d+\.\d+(?:\.\d+)?$/.test(platform.minimumOsVersion), "release platform minimumOsVersion is invalid");
  return platform;
}

function validateDescriptorPlatform(platform) {
  assertExactKeys(platform, ["id", "os", "arch"], "release descriptor platform");
  invariant(platform.id === "darwin-arm64" && platform.os === "darwin" && platform.arch === "arm64", "release descriptor platform must be darwin-arm64");
  return platform;
}

export function validateReleaseDescriptor(descriptor, { requireLocalFileTransport = false } = {}) {
  assertExactKeys(descriptor, ["schemaVersion", "channel", "sequence", "minimumSafeSequence", "revokedBuildIds", "buildId", "appVersion", "platform", "artifact"], "release descriptor");
  invariant(descriptor.schemaVersion === 1, "release descriptor schemaVersion must be 1");
  invariant(CHANNELS.has(descriptor.channel), "release descriptor channel is invalid");
  invariant(Number.isSafeInteger(descriptor.sequence) && descriptor.sequence > 0, "release descriptor sequence must be a positive integer");
  invariant(Number.isSafeInteger(descriptor.minimumSafeSequence) && descriptor.minimumSafeSequence >= 0 && descriptor.minimumSafeSequence <= descriptor.sequence, "release descriptor minimumSafeSequence is invalid");
  invariant(Array.isArray(descriptor.revokedBuildIds), "release descriptor revokedBuildIds must be an array");
  const sortedRevocations = [...descriptor.revokedBuildIds].sort(bytewiseCompare);
  invariant(JSON.stringify(sortedRevocations) === JSON.stringify(descriptor.revokedBuildIds) && new Set(descriptor.revokedBuildIds).size === descriptor.revokedBuildIds.length, "release descriptor revokedBuildIds must be bytewise sorted and unique");
  for (const buildId of descriptor.revokedBuildIds) invariant(typeof buildId === "string" && BUILD_ID_PATTERN.test(buildId), "release descriptor revoked buildId is invalid");
  if (descriptor.channel !== "local") invariant(descriptor.minimumSafeSequence > 0, "network release descriptor minimumSafeSequence must be positive");
  invariant(BUILD_ID_PATTERN.test(descriptor.buildId), "release descriptor buildId is invalid");
  invariant(VERSION_PATTERN.test(descriptor.appVersion), "release descriptor appVersion is invalid");
  validateDescriptorPlatform(descriptor.platform);
  assertExactKeys(descriptor.artifact, ["url", "sha256", "sizeBytes", "archiveType", "manifestSha256"], "release artifact");
  invariant(descriptor.artifact.archiveType === "zip", "release artifact must be a ZIP");
  invariant(SHA256_PATTERN.test(descriptor.artifact.sha256), "release artifact SHA-256 is invalid");
  invariant(SHA256_PATTERN.test(descriptor.artifact.manifestSha256), "release artifact manifest SHA-256 is invalid");
  invariant(Number.isSafeInteger(descriptor.artifact.sizeBytes) && descriptor.artifact.sizeBytes > 0 && descriptor.artifact.sizeBytes <= MAX_ARCHIVE_BYTES, "release artifact sizeBytes is invalid");
  let artifactUrl;
  try {
    artifactUrl = new URL(descriptor.artifact.url);
  } catch {
    throw new Error("release artifact URL is invalid");
  }
  if (descriptor.channel === "local") {
    invariant(artifactUrl.protocol === "file:" && artifactUrl.host === "" && artifactUrl.username === "" && artifactUrl.password === "" && artifactUrl.hash === "" && artifactUrl.search === "" && artifactUrl.pathname.startsWith("/"), "local release descriptor requires a canonical absolute file:// artifact URL");
  } else {
    invariant(artifactUrl.protocol === "https:", "network release descriptor requires an HTTPS artifact URL");
  }
  if (requireLocalFileTransport) invariant(descriptor.channel === "local" && artifactUrl.protocol === "file:", "unsigned-local fixtures require file-only transport");
  return descriptor;
}

export function validateReleaseDescriptorSignature(signature, { channel }) {
  assertExactKeys(signature, ["schemaVersion", "status", "algorithm", "keyId", "signature"], "release descriptor signature");
  invariant(signature.schemaVersion === 1 && signature.algorithm === "ed25519", "release descriptor signature envelope is invalid");
  invariant(typeof signature.keyId === "string" && signature.keyId.length > 0, "release descriptor signature keyId is invalid");
  if (channel === "local") {
    invariant(
      signature.status === "unsigned-local" && signature.keyId === "local-development" && signature.signature === null,
      "local descriptor signature must be the unsigned-local envelope",
    );
    return signature;
  }
  invariant(signature.status === "signed" && /^[A-Za-z0-9._-]+$/.test(signature.keyId) && typeof signature.signature === "string", "network release descriptor requires a release signature");
  let decoded;
  try {
    decoded = Buffer.from(signature.signature, "base64");
  } catch {
    throw new Error("release descriptor signature must be base64 Ed25519 bytes");
  }
  invariant(decoded.length === 64 && decoded.toString("base64") === signature.signature, "release descriptor signature must be base64 Ed25519 bytes");
  return signature;
}

// This is the immutable identity consumed by the curl bootstrap's native
// installer and by the rendered Homebrew formula. Keeping it as one exact
// record prevents either transport from quietly selecting another ZIP.
export function releasePublicationInputs({ descriptorRaw, descriptorUrl }) {
  invariant(typeof descriptorRaw === "string", "release descriptor bytes must be a string");
  invariant(typeof descriptorUrl === "string" && /^https:\/\//.test(descriptorUrl), "network release descriptor URL must use HTTPS");
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  invariant(descriptor.channel === "stable" || descriptor.channel === "prerelease", "network publication inputs require a signed release channel");
  const descriptorLocation = new URL(descriptorUrl);
  const artifactLocation = new URL(descriptor.artifact.url);
  invariant(descriptorLocation.origin === artifactLocation.origin, "network descriptor and artifact must share one release origin");
  return {
    artifactUrl: descriptor.artifact.url,
    appVersion: descriptor.appVersion,
    artifactSha256: descriptor.artifact.sha256,
    manifestSha256: descriptor.artifact.manifestSha256,
    buildId: descriptor.buildId,
    descriptorSha256: sha256Bytes(descriptorRaw),
  };
}

function localFixtureContract(values) {
  const expected = [
    "MODE",
    "PLATFORM",
    "INSTALLER_URL",
    "INSTALLER_SHA256",
    "INSTALLER_VERSION",
    "DESCRIPTOR_FILE",
    "SIGNATURE_FILE",
    "ARCHIVE_FILE",
  ];
  assertExactKeys(values, expected, "local fixture contract");
  for (const key of expected) invariant(typeof values[key] === "string" && values[key].length > 0 && !/[\r\n]/.test(values[key]), `local fixture contract ${key} is invalid`);
  invariant(values.MODE === "local-fixture" && values.PLATFORM === "darwin-arm64", "local fixture contract identity is invalid");
  invariant(/^file:\/\//.test(values.INSTALLER_URL), "local fixture installer URL must be file://");
  invariant(SHA256_PATTERN.test(values.INSTALLER_SHA256), "local fixture installer SHA-256 is invalid");
  return `${expected.map((key) => `${key}=${values[key]}`).join("\n")}\n`;
}

async function requireRegularFile(filePath, label) {
  const file = await lstat(filePath);
  invariant(file.isFile() && !file.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  return file;
}

// writeLocalReleaseBundle creates the only unsigned release shape accepted by
// the native installer: local descriptor/signature/files, all bound to a
// concrete ZIP and never eligible for network promotion.
export async function writeLocalReleaseBundle({ outputDirectory, archivePath, manifestPath, installerPath, buildId, appVersion, platform, sequence = 1 }) {
  invariant(path.isAbsolute(outputDirectory) && path.isAbsolute(archivePath) && path.isAbsolute(manifestPath) && path.isAbsolute(installerPath), "local release paths must be absolute");
  invariant(BUILD_ID_PATTERN.test(buildId), "local release buildId is invalid");
  invariant(VERSION_PATTERN.test(appVersion), "local release appVersion is invalid");
  validateBuildPlatform(platform);
  const [archiveInfo, installerInfo, manifestBytes] = await Promise.all([
    requireRegularFile(archivePath, "local release ZIP"),
    requireRegularFile(installerPath, "local release installer"),
    readFile(manifestPath),
  ]);
  invariant(archiveInfo.size > 0 && installerInfo.size > 0, "local release artifact and installer must be non-empty");
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  invariant(manifest.buildId === buildId && manifest.appVersion === appVersion && manifest.releaseChannel === "local", "local release manifest identity does not match build metadata");
  invariant(manifest.platform?.id === platform.id && manifest.platform?.os === platform.os && manifest.platform?.arch === platform.arch, "local release manifest platform does not match build metadata");
  const artifactFileName = path.basename(archivePath);
  invariant(/^jobctrl-[0-9A-Za-z._-]+-darwin-arm64\.zip$/.test(artifactFileName), "local release ZIP filename is invalid");
  // The native installer receives the actual local file path separately. Keep
  // descriptor bytes path-independent so two deterministic fixture builds in
  // different temporary directories have identical release evidence.
  const descriptorArtifactUrl = `file:///jobctrl-local-release/${artifactFileName}`;
  const descriptor = {
    schemaVersion: 1,
    channel: "local",
    sequence,
    minimumSafeSequence: 0,
    revokedBuildIds: [],
    buildId,
    appVersion,
    platform: { id: platform.id, os: platform.os, arch: platform.arch },
    artifact: {
      url: descriptorArtifactUrl,
      sha256: await sha256File(archivePath),
      sizeBytes: archiveInfo.size,
      archiveType: "zip",
      manifestSha256: sha256Bytes(manifestBytes),
    },
  };
  // The Go descriptor intentionally has no minimumOsVersion field.
  validateReleaseDescriptor(descriptor, { requireLocalFileTransport: true });
  const signature = {
    schemaVersion: 1,
    status: "unsigned-local",
    algorithm: "ed25519",
    keyId: "local-development",
    signature: null,
  };
  validateReleaseDescriptorSignature(signature, { channel: descriptor.channel });
  await mkdir(outputDirectory, { recursive: true, mode: 0o755 });
  const descriptorPath = path.join(outputDirectory, "release-descriptor.json");
  const signaturePath = path.join(outputDirectory, "release-descriptor.json.sig");
  const contractPath = path.join(outputDirectory, "local-fixture.contract");
  await Promise.all([
    writeFile(descriptorPath, canonicalJson(descriptor), { mode: 0o644 }),
    writeFile(signaturePath, canonicalJson(signature), { mode: 0o644 }),
  ]);
  const contract = localFixtureContract({
    MODE: "local-fixture",
    PLATFORM: platform.id,
    INSTALLER_URL: pathToFileURL(installerPath).href,
    INSTALLER_SHA256: await sha256File(installerPath),
    INSTALLER_VERSION: appVersion,
    DESCRIPTOR_FILE: descriptorPath,
    SIGNATURE_FILE: signaturePath,
    ARCHIVE_FILE: archivePath,
  });
  await writeFile(contractPath, contract, { mode: 0o600 });
  return {
    descriptorPath,
    signaturePath,
    contractPath,
    descriptorSha256: await sha256File(descriptorPath),
    artifactUrl: descriptor.artifact.url,
    artifactSha256: descriptor.artifact.sha256,
    manifestSha256: descriptor.artifact.manifestSha256,
    installerSha256: await sha256File(installerPath),
    sequence,
  };
}

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command !== "inspect" || rest.length !== 2) throw new Error("usage: distribution-release.mjs inspect <descriptor.json> <descriptor.json.sig>");
  const [descriptorRaw, signatureRaw] = await Promise.all(rest.map((value) => readFile(path.resolve(value), "utf8")));
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  validateReleaseDescriptorSignature(JSON.parse(signatureRaw), { channel: descriptor.channel });
  process.stdout.write(canonicalJson({ channel: descriptor.channel, buildId: descriptor.buildId, descriptorSha256: sha256Bytes(descriptorRaw), artifact: descriptor.artifact }));
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`distribution release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
