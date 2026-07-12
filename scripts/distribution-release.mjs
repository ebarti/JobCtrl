#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign as signEd25519,
  verify as verifyEd25519,
} from "node:crypto";
import { spawn } from "node:child_process";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import os from "node:os";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  buildRealPayload,
  createDeterministicZip,
  createReleaseManifest,
  loadBuildContracts,
  verifyExactPayloadTree,
} from "./distribution-build.mjs";
import {
  buildFileInventory,
  validateDistributionManifest,
} from "./distribution-manifest.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const BUILD_ID_PATTERN = /^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const CHANNELS = new Set(["local", "prerelease", "stable"]);
const MAX_ARCHIVE_BYTES = 4 * 1024 * 1024 * 1024;
export const CANONICAL_RELEASE_BASE_URL = "https://releases.jobctrl.dev/v1";
export const CHROMIUM_ENTITLEMENTS = Object.freeze({
  headlessShell: path.join(REPO_ROOT, "packaging", "distribution", "chromium-headless-shell.entitlements.plist"),
});
export const REQUIRED_VENDOR_NODE_PATHS = Object.freeze([
  "node/bin/node",
  "playwright-python/site-packages/playwright/driver/node",
]);

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
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
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
  invariant(descriptor !== null && typeof descriptor === "object" && !Array.isArray(descriptor), "release descriptor must be an object");
  const descriptorKeys = ["schemaVersion", "channel", "sequence", "minimumSafeSequence", "revokedBuildIds", "buildId", "appVersion", "platform", "artifact"];
  // Network descriptors are the signed provenance record consumed by all
  // promotion lanes. Local fixtures intentionally remain path-independent and
  // unsigned, so they do not claim a source Git commit.
  if (descriptor.channel !== "local") descriptorKeys.push("sourceCommit");
  assertExactKeys(descriptor, descriptorKeys, "release descriptor");
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
  if (descriptor.channel !== "local") invariant(typeof descriptor.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(descriptor.sourceCommit), "network release descriptor sourceCommit must be a full Git SHA");
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
    sourceCommit: descriptor.sourceCommit,
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

const MANIFEST_SIGNING_DOMAIN = "jobctrl:manifest:v1\0";
const DESCRIPTOR_SIGNING_DOMAIN = "jobctrl:release-descriptor:v1\0";
const FINAL_RELEASE_ASSETS = [
  "install.sh",
  "jobctrl-installer",
  "channel-pointer.json",
  "release-descriptor.json",
  "release-descriptor.json.sig",
  "manifest.json",
  "manifest.sig",
  "release-keys.json",
  "SHA256SUMS",
  "release-metadata.json",
  "audit/notarization.json",
  "audit/notary-log.json",
  "audit/publication-status.json",
  "audit/pre-sign-comparison.json",
  "audit/size-report.json",
];

function domainMessage(domain, raw) {
  invariant(typeof domain === "string" && domain.endsWith("\0"), "signature domain must end in NUL");
  return Buffer.concat([Buffer.from(domain, "utf8"), Buffer.from(raw, "utf8")]);
}

function publicKeyFromRaw(raw) {
  invariant(Buffer.isBuffer(raw) && raw.length === 32, "Ed25519 public key must be 32 raw bytes");
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

function rawPublicKey(publicKey) {
  const der = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  invariant(der.length === 44 && der.subarray(0, 12).equals(Buffer.from("302a300506032b6570032100", "hex")), "not an Ed25519 SPKI public key");
  return der.subarray(12);
}

export function privateKeyFromBase64(encoded) {
  invariant(typeof encoded === "string" && encoded.length > 0 && !/\s/.test(encoded), "release signing key must be non-empty base64 PKCS#8 DER");
  const der = Buffer.from(encoded, "base64");
  invariant(der.toString("base64") === encoded, "release signing key must be canonical base64 PKCS#8 DER");
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: der, format: "der", type: "pkcs8" });
  } catch {
    throw new Error("release signing key must be an Ed25519 PKCS#8 DER key");
  }
  invariant(privateKey.asymmetricKeyType === "ed25519", "release signing key must be Ed25519");
  return privateKey;
}

export function releasePublicKeyBase64(privateKey) {
  invariant(privateKey?.asymmetricKeyType === "ed25519", "release signing key must be Ed25519");
  return rawPublicKey(createPublicKey(privateKey)).toString("base64");
}

export function signReleaseBytes({ domain, raw, privateKey, keyId, kind }) {
  invariant(typeof raw === "string", "signed release bytes must be a UTF-8 string");
  invariant(typeof keyId === "string" && /^[A-Za-z0-9._-]+$/.test(keyId), "release signing key id is invalid");
  invariant(kind === "manifest" || kind === "descriptor", "release signature kind is invalid");
  invariant(privateKey?.asymmetricKeyType === "ed25519", "release signing key must be Ed25519");
  const signature = signEd25519(null, domainMessage(domain, raw), privateKey).toString("base64");
  if (kind === "manifest") {
    return {
      schemaVersion: 1,
      status: "signed",
      manifestAlgorithm: "ed25519",
      manifestKeyId: keyId,
      signature,
      promotable: true,
    };
  }
  return {
    schemaVersion: 1,
    status: "signed",
    algorithm: "ed25519",
    keyId,
    signature,
  };
}

export function verifyReleaseBytes({ domain, raw, signature, publicKey, keyId, kind }) {
  invariant(publicKey?.asymmetricKeyType === "ed25519", "release verification key must be Ed25519");
  invariant(kind === "manifest" || kind === "descriptor", "release signature kind is invalid");
  const encoded = kind === "manifest" ? signature?.signature : signature?.signature;
  const actualKeyId = kind === "manifest" ? signature?.manifestKeyId : signature?.keyId;
  invariant(actualKeyId === keyId && typeof encoded === "string", "release signature envelope does not bind the expected key id");
  const bytes = Buffer.from(encoded, "base64");
  invariant(bytes.length === 64 && bytes.toString("base64") === encoded, "release signature must be canonical base64 Ed25519 bytes");
  invariant(verifyEd25519(null, domainMessage(domain, raw), publicKey, bytes), "release Ed25519 signature verification failed");
  return true;
}

export function provisionedReleasePolicy(trackedPolicy) {
  invariant(trackedPolicy?.stableReleaseStatus === "blocked-awaiting-credentials", "tracked signing policy must remain externally blocked");
  invariant(trackedPolicy.manifestSigning?.publicKeyStatus === "unprovisioned", "tracked manifest key policy must remain unprovisioned");
  invariant(trackedPolicy.appleSigning?.teamIdStatus === "unprovisioned", "tracked Apple signing policy must remain unprovisioned");
  const policy = structuredClone(trackedPolicy);
  policy.stableReleaseStatus = "ready";
  policy.manifestSigning.publicKeyStatus = "provisioned";
  policy.appleSigning.teamIdStatus = "provisioned";
  return policy;
}

export function assertProtectedReleaseInputs({ signingKeyBase64, appleIdentity, notaryProfile, channel }) {
  invariant(channel === "stable" || channel === "prerelease", "network release channel must be stable or prerelease");
  privateKeyFromBase64(signingKeyBase64);
  invariant(typeof appleIdentity === "string" && appleIdentity.startsWith("Developer ID Application:"), "a protected Developer ID Application identity is required");
  invariant(typeof notaryProfile === "string" && /^[A-Za-z0-9._-]+$/.test(notaryProfile), "a protected notary keychain profile is required");
  return true;
}

export async function defaultCommandRunner(command, args, { cwd = REPO_ROOT, env = process.env } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
  });
}

async function walkPayload(root, relative = "") {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const results = [];
  for (const entry of entries.sort((left, right) => bytewiseCompare(left.name, right.name))) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    const absolute = path.join(root, child);
    const entryStat = await lstat(absolute);
    if (entryStat.isSymbolicLink()) continue;
    if (entryStat.isDirectory()) {
      results.push({ type: "directory", relative: child, absolute });
      results.push(...await walkPayload(root, child));
    } else if (entryStat.isFile()) {
      results.push({ type: "file", relative: child, absolute });
    }
  }
  return results;
}

function pathDepth(value) {
  return value.split(path.sep).length;
}

export async function discoverAppleCodeTargets({ payloadRoot, runner = defaultCommandRunner }) {
  invariant(path.isAbsolute(payloadRoot), "payload root must be absolute");
  const entries = await walkPayload(payloadRoot);
  const appBundles = entries
    .filter((entry) => entry.type === "directory" && entry.relative.endsWith(".app"))
    .map((entry) => entry.absolute)
    .sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare(left, right));
  const codeBundles = entries
    .filter((entry) => entry.type === "directory" && /\.(?:app|framework|xpc|appex)$/.test(entry.relative))
    .map((entry) => entry.absolute)
    .sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare(left, right));
  const machO = [];
  const standaloneExecutables = [];
  for (const entry of entries.filter((candidate) => candidate.type === "file")) {
    const probe = await runner("/usr/bin/file", ["-b", entry.absolute]);
    if (/Mach-O/i.test(probe.stdout)) {
      machO.push(entry.absolute);
      if (/executable/i.test(probe.stdout) && !appBundles.some((bundle) => containsPath(bundle, entry.absolute))) standaloneExecutables.push(entry.absolute);
    }
  }
  machO.sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare(left, right));
  standaloneExecutables.sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare(left, right));
  invariant(machO.length > 0, "release payload contains no Mach-O executables to sign");
  return { payloadRoot, machO, appBundles, codeBundles, standaloneExecutables };
}

function containsPath(root, candidate) {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function outermostAppBundles(appBundles) {
  return appBundles.filter((bundle) => !appBundles.some((other) => other !== bundle && containsPath(other, bundle)));
}

export async function classifyAppleSigningTargets({ payloadRoot = null, machO, appBundles, standaloneExecutables = [], runner = defaultCommandRunner }) {
  const preservedApps = [];
  for (const bundle of outermostAppBundles(appBundles)) {
    try {
      const details = await runner("/usr/bin/codesign", ["-dv", "--verbose=4", bundle]);
      await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=4", bundle]);
      const gatekeeper = await runner("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", bundle]);
      const signatureDetails = `${details.stdout}\n${details.stderr}`;
      const gatekeeperDetails = `${gatekeeper.stdout}\n${gatekeeper.stderr}`;
      // Ad-hoc signatures prove only local integrity. Preserve an app only
      // when it carries a real vendor Developer ID signature and a notarized
      // Gatekeeper assessment; this keeps Node/other vendor entitlements.
      if (signatureDetails.includes("Authority=Developer ID Application:") && gatekeeperDetails.includes("source=Notarized Developer ID")) preservedApps.push(bundle);
    } catch {
      // Ad-hoc, unsigned, or non-notarized bundles are signed explicitly.
    }
  }
  const preservedStandalone = [];
  const exactVendorNodes = payloadRoot === null
    ? null
    : new Set(REQUIRED_VENDOR_NODE_PATHS.map((relative) => path.join(payloadRoot, ...relative.split("/"))));
  for (const target of machO.filter((candidate) => !appBundles.some((bundle) => containsPath(bundle, candidate)))) {
    const normalized = target.split(path.sep).join("/");
    const isBundledNode = exactVendorNodes === null
      ? normalized.endsWith("/node/bin/node") || normalized.endsWith("/playwright-python/site-packages/playwright/driver/node")
      : exactVendorNodes.has(target);
    if (!isBundledNode) continue;
    try {
      const details = await runner("/usr/bin/codesign", ["-dv", "--verbose=4", target]);
      const signatureDetails = `${details.stdout}\n${details.stderr}`;
      const expectedNode = signatureDetails.includes("Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)")
        && signatureDetails.includes("TeamIdentifier=HX7739G8FX");
      invariant(expectedNode, `bundled Node executable must retain the Node.js Foundation Developer ID signature: ${normalized}`);
      // Node is a signed executable rather than an app bundle; spctl treats
      // that shape as non-app even when it is valid. Its designated
      // requirement, exact vendor path/team, and notarization check are the
      // preservation contract instead.
      await runner("/usr/bin/codesign", ["--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=4", target]);
      preservedStandalone.push(target);
    } catch (error) {
      // Node's JIT entitlement is vendor-owned. Re-signing an exact bundled
      // Node path can strip it, so a failed vendor/notarization check must
      // stop the release rather than quietly falling back to our identity.
      throw new Error(`bundled Node executable is not preservably signed: ${normalized}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const signingMachO = machO.filter((target) => !preservedApps.some((bundle) => containsPath(bundle, target)));
  const signingApps = appBundles.filter((bundle) => !preservedApps.some((preserved) => containsPath(preserved, bundle)));
  return {
    machO: [...machO],
    appBundles: [...appBundles],
    preservedApps,
    preservedStandalone,
    standaloneExecutables: [...standaloneExecutables],
    signingMachO: signingMachO.filter((target) => !preservedStandalone.includes(target)),
    signingApps,
  };
}

export function chromiumEntitlementsForTarget(target, entitlements = CHROMIUM_ENTITLEMENTS) {
  const normalized = target.split(path.sep).join("/");
  if (/chromium_headless_shell-1208\/chrome-headless-shell-mac-arm64\/chrome-headless-shell$/.test(normalized)) return entitlements.headlessShell;
  // The core payload contains no full Chrome-for-Testing app/framework tree.
  // Libraries and every optional host-browser path remain unentitled here.
  return null;
}

export function createAppleSigningPlan({ machO, appBundles = [], codeBundles = appBundles, identity, chromiumEntitlements = CHROMIUM_ENTITLEMENTS }) {
  invariant(Array.isArray(machO) && machO.length > 0, "Apple signing plan requires Mach-O targets");
  invariant(Array.isArray(codeBundles), "Apple signing plan requires code bundle targets");
  invariant(typeof identity === "string" && identity.startsWith("Developer ID Application:"), "Apple signing plan requires a Developer ID Application identity");
  const ordered = [
    ...[...new Set(machO)].sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare(left, right)),
    ...[...new Set(codeBundles)].sort((left, right) => pathDepth(right) - pathDepth(left) || bytewiseCompare(left, right)),
  ];
  const commands = ordered.map((target) => {
    const args = ["--force", "--sign", identity, "--options", "runtime", "--timestamp"];
    const entitlementPath = chromiumEntitlementsForTarget(target, chromiumEntitlements);
    if (entitlementPath) args.push("--entitlements", entitlementPath);
    args.push(target);
    return { command: "/usr/bin/codesign", args, target };
  });
  invariant(commands.every(({ args }) => !args.includes("--deep")), "codesign --deep must never be used while signing");
  return commands;
}

export async function signApplePayload({ payloadRoot, identity, runner = defaultCommandRunner }) {
  const discovered = await discoverAppleCodeTargets({ payloadRoot, runner });
  const targets = await classifyAppleSigningTargets({ ...discovered, runner });
  const requiredVendorNodes = REQUIRED_VENDOR_NODE_PATHS.map((relative) => path.join(payloadRoot, ...relative.split("/")));
  for (const target of requiredVendorNodes) {
    invariant(discovered.machO.includes(target), `required bundled Node executable is missing or is not Mach-O: ${path.relative(payloadRoot, target)}`);
    invariant(discovered.standaloneExecutables.includes(target), `required bundled Node path is not a standalone executable: ${path.relative(payloadRoot, target)}`);
    invariant(targets.preservedStandalone.includes(target), `required bundled Node executable was not preserved with vendor notarization: ${path.relative(payloadRoot, target)}`);
    invariant(!targets.signingMachO.includes(target), `required bundled Node executable would be re-signed: ${path.relative(payloadRoot, target)}`);
  }
  invariant(targets.preservedStandalone.length === requiredVendorNodes.length, "only the two exact bundled Node executables may be preserved as standalone vendor code");
  const signingBundles = discovered.codeBundles.filter((bundle) => !targets.preservedApps.some((preserved) => containsPath(preserved, bundle)));
  const commands = createAppleSigningPlan({ machO: targets.signingMachO, appBundles: targets.signingApps, codeBundles: signingBundles, identity });
  for (const command of commands) await runner(command.command, command.args);
  return { ...targets, signingBundles, commands };
}

function parseAcceptedNotarySubmission(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("notarytool submission must be JSON");
  }
  invariant(value?.status === "Accepted" && typeof value.id === "string" && value.id.length > 0, "notarytool submission must report Accepted with an id");
  invariant(!Array.isArray(value.issues) || value.issues.length === 0, "notarytool submission contains notarization warnings or errors");
  return value;
}

function parseAcceptedNotaryLog(raw, submissionID) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("notarytool log must be JSON");
  }
  invariant(value?.jobId === submissionID, "notarytool log jobId does not match the submission id");
  invariant(value.status === "Accepted", "notarytool log does not report Accepted");
  invariant(!Array.isArray(value.issues) || value.issues.length === 0, "notarytool log contains notarization warnings or errors");
  return value;
}

export async function notarizeAndStaplePayload({ payloadRoot, archivePath, appBundles, preservedApps = [], notaryProfile, runner = defaultCommandRunner }) {
  invariant(typeof notaryProfile === "string" && notaryProfile.length > 0, "notary profile is required");
  const submitted = parseAcceptedNotarySubmission(
    (await runner("/usr/bin/xcrun", ["notarytool", "submit", archivePath, "--keychain-profile", notaryProfile, "--wait", "--output-format", "json"])).stdout,
  );
  const logPath = `${archivePath}.notary-log.json`;
  await runner("/usr/bin/xcrun", ["notarytool", "log", submitted.id, "--keychain-profile", notaryProfile, logPath]);
  const logRaw = await readFile(logPath, "utf8");
  const log = parseAcceptedNotaryLog(logRaw, submitted.id);
  const stapleTargets = outermostAppBundles(appBundles);
  for (const bundle of stapleTargets) {
    await runner("/usr/bin/xcrun", ["stapler", "staple", bundle]);
    await runner("/usr/bin/xcrun", ["stapler", "validate", bundle]);
  }
  return { submittedArchive: archivePath, submission: submitted, log, logRaw, stapledBundles: stapleTargets, preservedVendorBundles: [...preservedApps] };
}

async function requiredEntitlementKeys(entitlementsPath) {
  const source = await readFile(entitlementsPath, "utf8");
  const keys = [...source.matchAll(/<key>([^<]+)<\/key>/g)].map((match) => match[1]);
  invariant(keys.length > 0, `entitlement policy has no keys: ${entitlementsPath}`);
  return keys;
}

export async function verifyApplePayload({ machO, appBundles, codeBundles = [], standaloneExecutables = [], runner = defaultCommandRunner }) {
  for (const target of machO) {
    await runner("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", target]);
  }
  for (const bundle of codeBundles) await runner("/usr/bin/codesign", ["--verify", "--strict", "--verbose=4", bundle]);
  for (const target of standaloneExecutables) {
    // `--check-notarization` alone accepts an ad-hoc executable on current
    // macOS. The designated requirement is the fail-closed proof that this
    // non-app Mach-O has a notarization ticket; `spctl` remains app-only.
    await runner("/usr/bin/codesign", ["--verify", "--strict", "--check-notarization", "-R=notarized", "--verbose=4", target]);
  }
  for (const bundle of outermostAppBundles(appBundles)) {
    // `--deep` is verification-only here: nested code was signed explicitly
    // from the leaves outward in createAppleSigningPlan().
    await runner("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--check-notarization", "-R=notarized", "--verbose=4", bundle]);
    const gatekeeper = await runner("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", bundle]);
    invariant(`${gatekeeper.stdout}\n${gatekeeper.stderr}`.includes("source=Notarized Developer ID"), `Gatekeeper did not report Notarized Developer ID for ${bundle}`);
  }
  const entitlementTargets = [...new Set([...machO, ...codeBundles].filter((target) => chromiumEntitlementsForTarget(target)))];
  for (const target of entitlementTargets) {
    const entitlementPath = chromiumEntitlementsForTarget(target);
    const result = await runner("/usr/bin/codesign", ["-d", "--entitlements", ":-", target]);
    const detail = `${result.stdout}\n${result.stderr}`;
    for (const key of await requiredEntitlementKeys(entitlementPath)) invariant(detail.includes(key), `final signed ${target} is missing required entitlement ${key}`);
  }
  return { machOVerified: machO.length, codeBundlesVerified: codeBundles.length, notarizationVerifiedStandaloneExecutables: standaloneExecutables.length, gatekeeperVerifiedBundles: outermostAppBundles(appBundles).length, entitlementVerifiedTargets: entitlementTargets.length };
}

function requireNetworkReleasePublicKey(publicKeyBase64, label = "prepared release") {
  invariant(typeof publicKeyBase64 === "string", `${label} public key must be a string`);
  const decoded = Buffer.from(publicKeyBase64, "base64");
  invariant(decoded.length === 32 && decoded.toString("base64") === publicKeyBase64, `${label} requires a canonical raw Ed25519 public key`);
  return publicKeyBase64;
}

function preparedCandidatePaths(preparedDirectory, contracts) {
  const root = path.resolve(preparedDirectory);
  const archiveFileName = `jobctrl-${contracts.versions["jobctrl-launcher"]}-${contracts.platform.id}.zip`;
  return {
    preparedDirectory: root,
    buildResultPath: path.join(root, "build-result.json"),
    payloadRoot: path.join(root, "payload"),
    manifestPath: path.join(root, "payload", "manifest.json"),
    archivePath: path.join(root, archiveFileName),
    archiveFileName,
  };
}

async function filesAreBytewiseEqual(firstPath, secondPath) {
  const [firstStat, secondStat] = await Promise.all([stat(firstPath), stat(secondPath)]);
  if (!firstStat.isFile() || !secondStat.isFile() || firstStat.size !== secondStat.size) return false;
  const [first, second] = await Promise.all([open(firstPath, "r"), open(secondPath, "r")]);
  try {
    const firstBuffer = Buffer.allocUnsafe(64 * 1024);
    const secondBuffer = Buffer.allocUnsafe(64 * 1024);
    for (let offset = 0; offset < firstStat.size;) {
      const [left, right] = await Promise.all([
        first.read(firstBuffer, 0, firstBuffer.length, offset),
        second.read(secondBuffer, 0, secondBuffer.length, offset),
      ]);
      if (left.bytesRead === 0 || left.bytesRead !== right.bytesRead || !firstBuffer.subarray(0, left.bytesRead).equals(secondBuffer.subarray(0, right.bytesRead))) return false;
      offset += left.bytesRead;
    }
    return true;
  } finally {
    await Promise.all([first.close(), second.close()]);
  }
}

export async function verifyPreparedCandidate({ preparedDirectory, channel, publicKeyBase64, root = REPO_ROOT, runner = defaultCommandRunner }) {
  invariant(channel === "stable" || channel === "prerelease", "prepared candidate requires a network channel");
  requireNetworkReleasePublicKey(publicKeyBase64, "prepared candidate");
  const contracts = await loadBuildContracts(root);
  const paths = preparedCandidatePaths(preparedDirectory, contracts);
  const [preparedEntry, payloadEntry, buildResultEntry, manifestEntry, archiveEntry] = await Promise.all([
    lstat(paths.preparedDirectory),
    lstat(paths.payloadRoot),
    lstat(paths.buildResultPath),
    lstat(paths.manifestPath),
    lstat(paths.archivePath),
  ]);
  invariant(!preparedEntry.isSymbolicLink() && preparedEntry.isDirectory(), "prepared candidate root must be a real directory, not a symlink");
  invariant(!payloadEntry.isSymbolicLink() && payloadEntry.isDirectory(), "prepared candidate payload must be a real directory, not a symlink");
  invariant(!buildResultEntry.isSymbolicLink() && buildResultEntry.isFile(), "prepared candidate build-result.json must be a regular file, not a symlink");
  invariant(!manifestEntry.isSymbolicLink() && manifestEntry.isFile(), "prepared candidate manifest.json must be a regular file, not a symlink");
  invariant(!archiveEntry.isSymbolicLink() && archiveEntry.isFile(), "prepared candidate archive must be a regular file, not a symlink");
  const [buildResultRaw, manifestRaw] = await Promise.all([
    readFile(paths.buildResultPath, "utf8"),
    readFile(paths.manifestPath, "utf8"),
  ]);
  let prepared;
  let manifest;
  try {
    prepared = JSON.parse(buildResultRaw);
    manifest = JSON.parse(manifestRaw);
  } catch (error) {
    throw new Error(`prepared candidate JSON is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  invariant(prepared?.mode === "real" && prepared?.releaseChannel === "local" && prepared?.archiveType === "zip", "prepared candidate is not an unsigned-local real build");
  invariant(prepared.nativeLauncherReleaseChannel === channel, "prepared native binaries target the wrong release channel");
  invariant(prepared.nativeLauncherReleaseTrustKeyBase64 === publicKeyBase64, "prepared native build record does not bind the expected release public key");
  invariant(prepared.nativeLauncherReleaseTrustKeySha256 === sha256Bytes(Buffer.from(publicKeyBase64, "utf8")), "prepared native build record has an invalid release public-key digest");
  validateDistributionManifest(manifest, contracts);
  invariant(manifest.releaseChannel === "local" && manifest.signing.codeSigning === "unsigned-local" && manifest.signing.notarized === false, "prepared manifest is not the required unsigned-local pre-sign envelope");
  invariant(prepared.buildId === manifest.buildId, "prepared build result does not match the checkout-rooted manifest build ID");
  const manifestSha256 = sha256Bytes(Buffer.from(manifestRaw, "utf8"));
  invariant(prepared.manifestSha256 === manifestSha256, "prepared manifest raw SHA-256 does not match build-result.json");
  await verifyExactPayloadTree(paths.payloadRoot, manifest);
  const installedBytes = (await buildFileInventory(paths.payloadRoot)).reduce((total, file) => total + file.sizeBytes, 0);
  invariant(prepared.installedBytes === installedBytes, "prepared installed byte count does not match the checkout-rooted payload");
  const archiveSha256 = await sha256File(paths.archivePath);
  invariant(prepared.archiveSha256 === archiveSha256, "prepared archive SHA-256 does not match the checkout-rooted archive");
  invariant(prepared.compressedBytes === archiveEntry.size, "prepared archive byte count does not match the checkout-rooted archive");
  const scratchDirectory = await mkdtemp(path.join(os.tmpdir(), "jobctrl-prepared-verify-"));
  try {
    const rebuiltArchivePath = path.join(scratchDirectory, paths.archiveFileName);
    const rebuilt = await createDeterministicZip(paths.payloadRoot, rebuiltArchivePath, manifest.sourceDateEpoch);
    invariant(rebuilt.sha256 === archiveSha256 && rebuilt.compressedBytes === archiveEntry.size, "checkout-rooted deterministic archive does not match the prepared archive identity");
    invariant(await filesAreBytewiseEqual(paths.archivePath, rebuiltArchivePath), "checkout-rooted deterministic archive bytes do not match the prepared archive");
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
  const nativeBinding = await verifyPreparedNativeBinding({ preparedDirectory: paths.preparedDirectory, channel, publicKeyBase64, runner });
  return {
    schemaVersion: 1,
    status: "verified-unsigned-pre-sign-candidate",
    buildId: manifest.buildId,
    appVersion: manifest.appVersion,
    sourceDateEpoch: manifest.sourceDateEpoch,
    archiveSha256,
    manifestSha256,
    compressedBytes: archiveEntry.size,
    installedBytes,
    nativeLauncherReleaseChannel: channel,
    nativeLauncherReleaseTrustKeySha256: prepared.nativeLauncherReleaseTrustKeySha256,
    nativeBinding,
  };
}

export async function comparePreparedBuilds(firstDirectory, secondDirectory, { channel, publicKeyBase64, root = REPO_ROOT, runner = defaultCommandRunner } = {}) {
  const [first, second] = await Promise.all([
    verifyPreparedCandidate({ preparedDirectory: firstDirectory, channel, publicKeyBase64, root, runner }),
    verifyPreparedCandidate({ preparedDirectory: secondDirectory, channel, publicKeyBase64, root, runner }),
  ]);
  const fields = [
    "buildId",
    "appVersion",
    "sourceDateEpoch",
    "archiveSha256",
    "manifestSha256",
    "compressedBytes",
    "installedBytes",
    "nativeLauncherReleaseChannel",
    "nativeLauncherReleaseTrustKeySha256",
  ];
  const mismatches = fields.filter((field) => first[field] !== second[field]);
  invariant(mismatches.length === 0, `unsigned pre-sign builds differ: ${mismatches.join(", ")}`);
  return {
    schemaVersion: 1,
    status: "identical-unsigned-pre-sign-builds",
    comparedFields: fields,
    buildId: first.buildId,
    appVersion: first.appVersion,
    sourceDateEpoch: first.sourceDateEpoch,
    archiveSha256: first.archiveSha256,
    manifestSha256: first.manifestSha256,
    compressedBytes: first.compressedBytes,
    installedBytes: first.installedBytes,
    nativeLauncherReleaseChannel: first.nativeLauncherReleaseChannel,
    nativeLauncherReleaseTrustKeySha256: first.nativeLauncherReleaseTrustKeySha256,
    note: "Signed and stapled ZIP bytes are intentionally not compared for deterministic equality.",
  };
}

export async function verifyPreparedNativeBinding({ preparedDirectory, channel, publicKeyBase64, runner = defaultCommandRunner }) {
  invariant(channel === "stable" || channel === "prerelease", "prepared native binding requires a network channel");
  requireNetworkReleasePublicKey(publicKeyBase64, "prepared native binding");
  const prepared = JSON.parse(await readFile(path.join(preparedDirectory, "build-result.json"), "utf8"));
  invariant(prepared.nativeLauncherReleaseChannel === channel, "prepared native binaries target the wrong release channel");
  invariant(prepared.nativeLauncherReleaseTrustKeyBase64 === publicKeyBase64, "prepared native build record does not bind the derived release public key");
  invariant(prepared.nativeLauncherReleaseTrustKeySha256 === sha256Bytes(Buffer.from(publicKeyBase64, "utf8")), "prepared native build record has an invalid release public-key digest");
  const payloadRoot = path.join(preparedDirectory, "payload");
  const binaries = [path.join(payloadRoot, "launcher", "jobctrl"), path.join(payloadRoot, "launcher", "jobctrl-installer")];
  for (const binary of binaries) {
    const binaryEntry = await lstat(binary);
    invariant(!binaryEntry.isSymbolicLink() && binaryEntry.isFile(), `compiled ${path.basename(binary)} must be a regular file, not a symlink`);
    invariant((binaryEntry.mode & 0o7777) === 0o755, `compiled ${path.basename(binary)} must have mode 0755`);
    const output = await runner("/usr/bin/strings", [binary]);
    invariant(output.stdout.includes(publicKeyBase64), `compiled ${path.basename(binary)} does not embed the derived release public key`);
    invariant(output.stdout.includes(channel), `compiled ${path.basename(binary)} does not embed the intended release channel`);
  }
  return { binaries, channel, publicKeySha256: prepared.nativeLauncherReleaseTrustKeySha256 };
}

export function assertPreSignComparisonMatches(prepared, comparison) {
  invariant(comparison?.status === "identical-unsigned-pre-sign-builds", "a passing unsigned pre-sign build comparison is required before signing");
  const fields = [
    "buildId",
    "archiveSha256",
    "manifestSha256",
    "compressedBytes",
    "installedBytes",
    "nativeLauncherReleaseChannel",
    "nativeLauncherReleaseTrustKeySha256",
  ];
  for (const field of fields) invariant(comparison[field] === prepared[field], `pre-sign comparison does not bind prepared ${field}`);
  return true;
}

function networkDescriptor({ channel, sequence, minimumSafeSequence, revokedBuildIds = [], buildId, appVersion, sourceCommit, archiveUrl, archiveSha256, archiveSizeBytes, manifestSha256 }) {
  const descriptor = {
    schemaVersion: 1,
    channel,
    sequence,
    minimumSafeSequence,
    revokedBuildIds,
    buildId,
    appVersion,
    sourceCommit,
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: {
      url: archiveUrl,
      sha256: archiveSha256,
      sizeBytes: archiveSizeBytes,
      archiveType: "zip",
      manifestSha256,
    },
  };
  validateReleaseDescriptor(descriptor);
  return descriptor;
}

export function canonicalReleaseUrls(channel, archiveFileName, buildId) {
  invariant(channel === "stable" || channel === "prerelease", "canonical network release channel is invalid");
  invariant(typeof archiveFileName === "string" && /^jobctrl-[0-9A-Za-z._-]+-darwin-arm64\.zip$/.test(archiveFileName), "canonical release archive name is invalid");
  invariant(typeof buildId === "string" && BUILD_ID_PATTERN.test(buildId), "canonical release build id is invalid");
  const base = `${CANONICAL_RELEASE_BASE_URL}/${channel}`;
  const immutableBase = `${CANONICAL_RELEASE_BASE_URL}/artifacts/${buildId}`;
  return {
    descriptorUrl: `${base}/darwin-arm64.json`,
    descriptorSignatureUrl: `${base}/darwin-arm64.json.sig`,
    // The mutable channel descriptor is promoted only after the candidate's
    // immutable descriptor has been fetched and exercised.  Promotion lanes
    // (including Homebrew and PyPI) bind this build-scoped URL, not the
    // channel pointer that a later release may replace.
    immutableDescriptorUrl: `${immutableBase}/release-descriptor.json`,
    immutableDescriptorSignatureUrl: `${immutableBase}/release-descriptor.json.sig`,
    immutableChannelPointerUrl: `${immutableBase}/channel-pointer.json`,
    artifactUrl: `${immutableBase}/${archiveFileName}`,
    installerUrl: `${immutableBase}/jobctrl-installer`,
    installScriptUrl: `${immutableBase}/install.sh`,
    immutableBase,
  };
}

// A channel pointer is the one mutable network object.  It contains the
// complete, hashed descriptor/signature pair so the publication origin can
// compare-and-swap one object without ever exposing a descriptor from one
// release with a signature from another.  The native installer still verifies
// the fetched descriptor signature with its compiled public key; this pointer
// is an atomic transport selector, not a replacement trust anchor.
export function validateReleaseChannelPointer(pointer) {
  assertExactKeys(pointer, ["schemaVersion", "channel", "platform", "sourceCommit", "buildId", "sequence", "descriptor", "signature"], "release channel pointer");
  invariant(pointer.schemaVersion === 1 && (pointer.channel === "stable" || pointer.channel === "prerelease"), "release channel pointer identity is invalid");
  validateDescriptorPlatform(pointer.platform);
  invariant(typeof pointer.sourceCommit === "string" && /^[a-f0-9]{40}$/.test(pointer.sourceCommit), "release channel pointer source commit is invalid");
  invariant(typeof pointer.buildId === "string" && BUILD_ID_PATTERN.test(pointer.buildId), "release channel pointer build ID is invalid");
  invariant(Number.isSafeInteger(pointer.sequence) && pointer.sequence > 0, "release channel pointer sequence is invalid");
  for (const [label, value] of [["descriptor", pointer.descriptor], ["signature", pointer.signature]]) {
    assertExactKeys(value, ["url", "sha256"], `release channel pointer ${label}`);
    invariant(typeof value.url === "string", `release channel pointer ${label} URL is invalid`);
    invariant(SHA256_PATTERN.test(value.sha256), `release channel pointer ${label} SHA-256 is invalid`);
  }
  const canonicalOrigin = new URL(CANONICAL_RELEASE_BASE_URL).origin;
  const assertImmutableUrl = (value, expectedPath, label) => {
    let parsed;
    try { parsed = new URL(value); } catch { throw new Error(`release channel pointer ${label} URL is invalid`); }
    invariant(parsed.protocol === "https:" && parsed.origin === canonicalOrigin && parsed.username === "" && parsed.password === "" && parsed.search === "" && parsed.hash === "", `release channel pointer ${label} URL is not canonical HTTPS`);
    invariant(parsed.pathname === expectedPath && parsed.href === value, `release channel pointer ${label} URL is not the selected immutable build path`);
  };
  const immutablePath = `/v1/artifacts/${pointer.buildId}/release-descriptor.json`;
  assertImmutableUrl(pointer.descriptor.url, immutablePath, "descriptor");
  assertImmutableUrl(pointer.signature.url, `${immutablePath}.sig`, "signature");
  return pointer;
}

export function createReleaseChannelPointer({ descriptorRaw, signatureRaw, descriptorUrl, signatureUrl }) {
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  const signature = validateReleaseDescriptorSignature(JSON.parse(signatureRaw), { channel: descriptor.channel });
  invariant(signature.status === "signed", "release channel pointer requires a signed descriptor");
  const urls = canonicalReleaseUrls(descriptor.channel, path.basename(new URL(descriptor.artifact.url).pathname), descriptor.buildId);
  invariant(descriptor.artifact.url === urls.artifactUrl && descriptorUrl === urls.immutableDescriptorUrl && signatureUrl === urls.immutableDescriptorSignatureUrl, "release channel pointer must select the descriptor's immutable canonical build URLs");
  return validateReleaseChannelPointer({
    schemaVersion: 1,
    channel: descriptor.channel,
    platform: descriptor.platform,
    sourceCommit: descriptor.sourceCommit,
    buildId: descriptor.buildId,
    sequence: descriptor.sequence,
    descriptor: { url: descriptorUrl, sha256: sha256Bytes(Buffer.from(descriptorRaw, "utf8")) },
    signature: { url: signatureUrl, sha256: sha256Bytes(Buffer.from(signatureRaw, "utf8")) },
  });
}

export function renderPinnedInstallScript({ templateRaw, installerUrl, installerSha256, installerVersion }) {
  invariant(typeof templateRaw === "string" && templateRaw.startsWith("#!/usr/bin/env bash\n"), "install script template is invalid");
  invariant(typeof installerUrl === "string" && installerUrl.startsWith("https://"), "published installer URL must use HTTPS");
  invariant(SHA256_PATTERN.test(installerSha256), "published installer SHA-256 is invalid");
  invariant(VERSION_PATTERN.test(installerVersion), "published installer version is invalid");
  const rendered = templateRaw
    .replace(/^INSTALLER_URL=""$/m, `INSTALLER_URL="${installerUrl}"`)
    .replace(/^INSTALLER_SHA256=""$/m, `INSTALLER_SHA256="${installerSha256}"`)
    .replace(/^INSTALLER_VERSION=""$/m, `INSTALLER_VERSION="${installerVersion}"`);
  invariant(!/^INSTALLER_(?:URL|SHA256|VERSION)=""$/m.test(rendered), "published install script has an unresolved release pin");
  invariant(rendered.includes("no signed native installer is published yet; P6 release signing is still blocked"), "published install script lost its fail-closed fallback");
  return rendered;
}

async function copyReleaseMetadata(payloadRoot, auditRoot) {
  const releaseRoot = path.join(payloadRoot, "release");
  const releaseStat = await lstat(releaseRoot);
  invariant(releaseStat.isDirectory() && !releaseStat.isSymbolicLink(), "payload release metadata directory is missing");
  await cp(releaseRoot, path.join(auditRoot, "release-metadata"), {
    recursive: true,
    dereference: false,
    force: true,
    errorOnExist: false,
  });
}

export function expectedReleaseAssetPaths({ archiveFileName }) {
  invariant(typeof archiveFileName === "string" && archiveFileName.endsWith(".zip"), "release archive file name is invalid");
  return [...FINAL_RELEASE_ASSETS, archiveFileName].sort(bytewiseCompare);
}

async function writeChecksumFile(releaseDirectory, files) {
  const records = [];
  for (const file of [...files].sort(bytewiseCompare)) records.push(`${await sha256File(path.join(releaseDirectory, file))}  ${file}`);
  await writeFile(path.join(releaseDirectory, "SHA256SUMS"), `${records.join("\n")}\n`, { mode: 0o644 });
  return records;
}

export async function assertReleaseAssetInventory(releaseDirectory, { archiveFileName }) {
  const expected = expectedReleaseAssetPaths({ archiveFileName });
  const found = [];
  async function visit(relative = "") {
    for (const entry of await readdir(path.join(releaseDirectory, relative), { withFileTypes: true })) {
      const child = relative ? path.posix.join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) await visit(child);
      else if (entry.isFile()) found.push(child);
      else throw new Error(`release asset inventory contains unsupported entry ${child}`);
    }
  }
  await visit();
  // The audit metadata tree deliberately contains a variable but non-empty
  // set of copied license, SBOM, provenance, and attribution evidence.
  const required = new Set(expected);
  for (const item of expected) invariant(found.includes(item), `release asset inventory is missing ${item}`);
  invariant(found.some((item) => item.startsWith("audit/release-metadata/licenses/")), "release asset inventory lacks copied license attribution");
  invariant(found.some((item) => item.endsWith("sbom.cdx.json")), "release asset inventory lacks an SBOM");
  invariant(found.some((item) => item.endsWith("provenance.json")), "release asset inventory lacks provenance evidence");
  invariant(found.some((item) => item.endsWith("size-report.json")), "release asset inventory lacks size/dependency delta evidence");
  return { expected: [...required].sort(bytewiseCompare), found: found.sort(bytewiseCompare) };
}

async function releaseRegularFiles(releaseDirectory, relative = "") {
  const files = [];
  for (const entry of await readdir(path.join(releaseDirectory, relative), { withFileTypes: true })) {
    const child = relative ? path.posix.join(relative, entry.name) : entry.name;
    if (entry.isDirectory()) files.push(...await releaseRegularFiles(releaseDirectory, child));
    else if (entry.isFile()) files.push(child);
    else throw new Error(`release directory has unsupported entry ${child}`);
  }
  return files.sort(bytewiseCompare);
}

export async function finalizeNetworkRelease({
  preparedDirectory,
  releaseDirectory,
  channel,
  sequence,
  minimumSafeSequence,
  revokedBuildIds = [],
  signingKeyBase64,
  appleIdentity,
  notaryProfile,
  sourceDateEpoch,
  sourceCommit,
  preSignComparison,
  runner = defaultCommandRunner,
  root = REPO_ROOT,
}) {
  assertProtectedReleaseInputs({ signingKeyBase64, appleIdentity, notaryProfile, channel });
  invariant(typeof sourceCommit === "string" && /^[a-f0-9]{40}$/.test(sourceCommit), "final release requires an immutable source commit SHA");
  invariant(Number.isInteger(sequence) && sequence > 0 && Number.isInteger(minimumSafeSequence) && minimumSafeSequence > 0 && minimumSafeSequence <= sequence, "network release sequence is invalid");
  const privateKey = privateKeyFromBase64(signingKeyBase64);
  const publicKeyBase64 = releasePublicKeyBase64(privateKey);
  const verifiedPrepared = await verifyPreparedCandidate({
    preparedDirectory,
    channel,
    publicKeyBase64,
    root,
    runner,
  });
  const prepared = JSON.parse(await readFile(path.join(preparedDirectory, "build-result.json"), "utf8"));
  invariant(prepared.releaseChannel === "local" && prepared.nativeLauncherReleaseChannel === channel, "prepared build is not a matching unsigned pre-sign network build");
  assertPreSignComparisonMatches(verifiedPrepared, preSignComparison);
  const nativeBinding = verifiedPrepared.nativeBinding;
  const payloadRoot = path.join(preparedDirectory, "payload");
  const preparedManifest = JSON.parse(await readFile(path.join(payloadRoot, "manifest.json"), "utf8"));
  invariant(preparedManifest.sourceDateEpoch === sourceDateEpoch, "finalization SOURCE_DATE_EPOCH must match the compared pre-sign build");
  const archiveFileName = `jobctrl-${preparedManifest.appVersion}-darwin-arm64.zip`;
  const urls = canonicalReleaseUrls(channel, archiveFileName, prepared.buildId);
  const notaryArchive = path.join(preparedDirectory, `notary-${archiveFileName}`);
  const contracts = await loadBuildContracts(root, { signingPolicyOverride: provisionedReleasePolicy((await loadBuildContracts(root)).signingPolicy) });
  await rm(path.join(payloadRoot, "manifest.sig"), { force: true });
  const signed = await signApplePayload({ payloadRoot, identity: appleIdentity, runner });
  await createDeterministicZip(payloadRoot, notaryArchive, sourceDateEpoch);
  const notarization = await notarizeAndStaplePayload({ payloadRoot, archivePath: notaryArchive, appBundles: signed.appBundles, preservedApps: signed.preservedApps, notaryProfile, runner });
  const verification = await verifyApplePayload({ ...signed, codeBundles: signed.signingBundles, runner });
  const manifest = await createReleaseManifest(payloadRoot, contracts, {
    buildId: prepared.buildId,
    sourceDateEpoch,
    releaseChannel: channel,
  });
  const manifestRaw = canonicalJson(manifest);
  const manifestSignature = signReleaseBytes({ domain: MANIFEST_SIGNING_DOMAIN, raw: manifestRaw, privateKey, keyId: contracts.signingPolicy.manifestSigning.keyId, kind: "manifest" });
  await writeFile(path.join(payloadRoot, "manifest.json"), manifestRaw, { mode: 0o644 });
  await writeFile(path.join(payloadRoot, "manifest.sig"), canonicalJson(manifestSignature), { mode: 0o644 });
  await verifyExactPayloadTree(payloadRoot, manifest);

  await rm(releaseDirectory, { recursive: true, force: true });
  await mkdir(path.join(releaseDirectory, "audit"), { recursive: true, mode: 0o755 });
  const finalArchivePath = path.join(releaseDirectory, archiveFileName);
  const finalZip = await createDeterministicZip(payloadRoot, finalArchivePath, sourceDateEpoch);
  const descriptor = networkDescriptor({
    channel,
    sequence,
    minimumSafeSequence,
    revokedBuildIds,
    buildId: manifest.buildId,
    appVersion: manifest.appVersion,
    sourceCommit,
    archiveUrl: urls.artifactUrl,
    archiveSha256: finalZip.sha256,
    archiveSizeBytes: finalZip.compressedBytes,
    manifestSha256: sha256Bytes(Buffer.from(manifestRaw, "utf8")),
  });
  const descriptorRaw = canonicalJson(descriptor);
  const descriptorSignature = signReleaseBytes({ domain: DESCRIPTOR_SIGNING_DOMAIN, raw: descriptorRaw, privateKey, keyId: contracts.signingPolicy.manifestSigning.keyId, kind: "descriptor" });
  const publicKey = publicKeyFromRaw(Buffer.from(publicKeyBase64, "base64"));
  verifyReleaseBytes({ domain: MANIFEST_SIGNING_DOMAIN, raw: manifestRaw, signature: manifestSignature, publicKey, keyId: contracts.signingPolicy.manifestSigning.keyId, kind: "manifest" });
  verifyReleaseBytes({ domain: DESCRIPTOR_SIGNING_DOMAIN, raw: descriptorRaw, signature: descriptorSignature, publicKey, keyId: contracts.signingPolicy.manifestSigning.keyId, kind: "descriptor" });
  const releaseKeys = { schemaVersion: 1, keys: { [contracts.signingPolicy.manifestSigning.keyId]: publicKeyBase64 } };
  const publicNotarization = {
    submittedArchive: path.basename(notarization.submittedArchive),
    submission: notarization.submission,
    log: notarization.log,
    stapledBundles: notarization.stapledBundles.map((bundle) => path.relative(payloadRoot, bundle).split(path.sep).join("/")),
    preservedVendorBundles: notarization.preservedVendorBundles.map((bundle) => path.relative(payloadRoot, bundle).split(path.sep).join("/")),
    preservedVendorStandaloneExecutables: signed.preservedStandalone.map((target) => path.relative(payloadRoot, target).split(path.sep).join("/")),
  };
  const publicNativeBinding = {
    ...nativeBinding,
    binaries: nativeBinding.binaries.map((binary) => path.relative(payloadRoot, binary).split(path.sep).join("/")),
  };
  const notarizationEvidenceRaw = canonicalJson({ schemaVersion: 1, status: "accepted-and-stapled", notarization: publicNotarization, verification });
  invariant(!notarizationEvidenceRaw.includes(payloadRoot) && !notarizationEvidenceRaw.includes(preparedDirectory), "public notarization evidence must not contain an absolute workspace path");
  const descriptorSignatureRaw = canonicalJson(descriptorSignature);
  await Promise.all([
    copyFile(path.join(payloadRoot, "launcher", "jobctrl-installer"), path.join(releaseDirectory, "jobctrl-installer")),
    writeFile(path.join(releaseDirectory, "release-descriptor.json"), descriptorRaw, { mode: 0o644 }),
    writeFile(path.join(releaseDirectory, "release-descriptor.json.sig"), descriptorSignatureRaw, { mode: 0o644 }),
    writeFile(path.join(releaseDirectory, "manifest.json"), manifestRaw, { mode: 0o644 }),
    writeFile(path.join(releaseDirectory, "manifest.sig"), canonicalJson(manifestSignature), { mode: 0o644 }),
    writeFile(path.join(releaseDirectory, "release-keys.json"), canonicalJson(releaseKeys), { mode: 0o644 }),
    copyFile(path.join(preparedDirectory, "size-report.json"), path.join(releaseDirectory, "audit", "size-report.json")),
    writeFile(path.join(releaseDirectory, "audit", "notarization.json"), notarizationEvidenceRaw, { mode: 0o644 }),
    writeFile(path.join(releaseDirectory, "audit", "notary-log.json"), notarization.logRaw, { mode: 0o644 }),
    writeFile(path.join(releaseDirectory, "audit", "pre-sign-comparison.json"), canonicalJson(preSignComparison), { mode: 0o644 }),
  ]);
  await copyReleaseMetadata(payloadRoot, path.join(releaseDirectory, "audit"));
  const channelPointer = createReleaseChannelPointer({
    descriptorRaw,
    signatureRaw: descriptorSignatureRaw,
    descriptorUrl: urls.immutableDescriptorUrl,
    signatureUrl: urls.immutableDescriptorSignatureUrl,
  });
  const channelPointerRaw = canonicalJson(channelPointer);
  await writeFile(path.join(releaseDirectory, "channel-pointer.json"), channelPointerRaw, { mode: 0o644 });
  const metadata = {
    schemaVersion: 1,
    status: "signed-notarized-release-candidate",
    publicationStatus: "blocked-until-published-candidate-smoke",
    // A signed/notarized candidate still has not been fetched from the real
    // HTTPS origin. Only the separate post-publication native smoke may
    // authorize PyPI/Homebrew promotion.
    pypiPublicationAuthorized: false,
    channel,
    buildId: manifest.buildId,
    appVersion: manifest.appVersion,
    // This copy is convenience metadata only. The authoritative provenance is
    // the same value inside the signed network descriptor below.
    sourceCommit,
    archive: { file: archiveFileName, sha256: finalZip.sha256, sizeBytes: finalZip.compressedBytes, url: urls.artifactUrl },
    installer: { file: "jobctrl-installer", sha256: await sha256File(path.join(releaseDirectory, "jobctrl-installer")), url: urls.installerUrl },
    publicationUrls: urls,
    manifest: { sha256: sha256Bytes(Buffer.from(manifestRaw, "utf8")), keyId: contracts.signingPolicy.manifestSigning.keyId },
    descriptor: { sha256: sha256Bytes(Buffer.from(descriptorRaw, "utf8")), keyId: contracts.signingPolicy.manifestSigning.keyId },
    channelPointer: { sha256: sha256Bytes(Buffer.from(channelPointerRaw, "utf8")), url: urls.immutableChannelPointerUrl },
    signing: { codeSigning: "Developer ID Application", notarization: "nested-apps-stapled", unsignedBuildComparisonRequired: true, nativeBinding: publicNativeBinding },
  };
  const installScript = renderPinnedInstallScript({
    templateRaw: await readFile(path.join(root, "scripts", "get"), "utf8"),
    installerUrl: urls.installerUrl,
    installerSha256: metadata.installer.sha256,
    installerVersion: manifest.appVersion,
  });
  await writeFile(path.join(releaseDirectory, "install.sh"), installScript, { mode: 0o755 });
  await writeFile(path.join(releaseDirectory, "audit", "publication-status.json"), canonicalJson({
    schemaVersion: 1,
    status: "blocked",
    publicationStatus: "blocked-until-protected-signing-notarization-and-published-candidate-smoke",
    evidencePath: "audit/publication-status.json",
    workflowContract: ".github/workflows/release-distribution.yml",
    externalRequirements: [
      "protected Developer ID Application identity",
      "protected Ed25519 release signing key",
      "protected notarization keychain profile",
      "production releases.jobctrl.dev TLS origin",
      "GitHub Actions billing-enabled macOS runner",
    ],
  }), { mode: 0o644 });
  await writeFile(path.join(releaseDirectory, "release-metadata.json"), canonicalJson(metadata), { mode: 0o644 });
  invariant(!(await readFile(path.join(releaseDirectory, "release-metadata.json"), "utf8")).includes(payloadRoot), "public release metadata must not contain an absolute payload path");
  await chmod(path.join(releaseDirectory, "jobctrl-installer"), 0o755);
  await writeChecksumFile(releaseDirectory, (await releaseRegularFiles(releaseDirectory)).filter((file) => file !== "SHA256SUMS"));
  const inventory = await assertReleaseAssetInventory(releaseDirectory, { archiveFileName });
  return { archivePath: finalArchivePath, archiveFileName, descriptorRaw, descriptorSignature, channelPointer, manifestRaw, manifestSignature, releaseKeys, metadata, inventory };
}

export async function writePreSignComparison({ firstDirectory, secondDirectory, releaseDirectory, channel, publicKeyBase64, root = REPO_ROOT, runner = defaultCommandRunner }) {
  const comparison = await comparePreparedBuilds(firstDirectory, secondDirectory, { channel, publicKeyBase64, root, runner });
  await mkdir(path.join(releaseDirectory, "audit"), { recursive: true, mode: 0o755 });
  await writeFile(path.join(releaseDirectory, "audit", "pre-sign-comparison.json"), canonicalJson(comparison), { mode: 0o644 });
  return comparison;
}

export function publishedCandidateSmokePlan({ descriptorUrl, installerPath, outputHome }) {
  invariant(typeof descriptorUrl === "string" && descriptorUrl.startsWith("https://"), "published smoke requires an HTTPS descriptor URL");
  invariant(path.isAbsolute(installerPath) && path.isAbsolute(outputHome), "published smoke paths must be absolute");
  const signatureUrl = `${descriptorUrl}.sig`;
  return [
    { command: "/usr/bin/curl", args: ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", descriptorUrl, "-o", path.join(outputHome, "release-descriptor.json")] },
    { command: "/usr/bin/curl", args: ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", signatureUrl, "-o", path.join(outputHome, "release-descriptor.json.sig")] },
    { command: installerPath, args: ["--source", "curl", "--release-url", descriptorUrl, "--home", outputHome] },
    { command: path.join(outputHome, "bin", "jobctrl"), args: ["start", "--no-open"] },
    { command: path.join(outputHome, "bin", "jobctrl"), args: ["status", "--json"] },
    { command: path.join(outputHome, "bin", "jobctrl"), args: ["version", "--json"] },
    { command: path.join(outputHome, "bin", "jobctrl"), args: ["stop"] },
    { command: path.join(outputHome, "bin", "jobctrl"), args: ["status", "--json"] },
  ];
}

function parseCommandJson(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error(`${label} did not produce JSON`);
  }
}

export function assertRunningStatus(status) {
  invariant(status?.status === "running", "published smoke status must be running");
  for (const component of ["temporal", "worker", "api"]) invariant(status.components?.[component]?.state === "running", `published smoke ${component} is not running`);
  return true;
}

export function assertStoppedStatus(status) {
  invariant(status?.status === "stopped", "published smoke post-stop status must be stopped");
  for (const component of Object.values(status.components ?? {})) invariant(component?.state !== "running", "published smoke leaves a live component after stop");
  return true;
}

export function assertPublishedVersion(version, candidate) {
  invariant(version?.buildId === candidate?.buildId, "published smoke version buildId does not match the downloaded descriptor");
  invariant(version?.manifestSha256 === candidate?.manifestSha256, "published smoke version manifest SHA-256 does not match the downloaded descriptor");
  return true;
}

export function candidateIdentityFromDescriptor(descriptorRaw) {
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  invariant(descriptor.channel === "stable" || descriptor.channel === "prerelease", "published smoke descriptor must be a signed network channel");
  return {
    descriptorSha256: sha256Bytes(Buffer.from(descriptorRaw, "utf8")),
    buildId: descriptor.buildId,
    appVersion: descriptor.appVersion,
    artifactSha256: descriptor.artifact.sha256,
    artifactSizeBytes: descriptor.artifact.sizeBytes,
    manifestSha256: descriptor.artifact.manifestSha256,
  };
}

export function assertCandidateIdentity(expected, actual) {
  const keys = ["descriptorSha256", "buildId", "appVersion", "artifactSha256", "artifactSizeBytes", "manifestSha256"];
  for (const key of keys) invariant(expected?.[key] === actual?.[key], `published smoke candidate identity mismatch for ${key}`);
  return true;
}

export async function runPublishedCandidateSmoke({
  descriptorUrl,
  channelPointerUrl = null,
  installerUrl,
  installerSha256,
  expectedCandidate,
  runtimeHome = null,
  runner = defaultCommandRunner,
}) {
  invariant(typeof installerUrl === "string" && installerUrl.startsWith("https://"), "published smoke requires an HTTPS installer URL");
  invariant(SHA256_PATTERN.test(installerSha256), "published smoke requires an installer SHA-256");
  invariant(expectedCandidate && typeof expectedCandidate === "object", "published smoke requires the exact expected candidate identity");
  const root = runtimeHome ?? await mkdtemp(path.join(os.tmpdir(), "jobctrl-published-smoke-"));
  const isolatedHome = path.join(root, "home");
  const isolatedRuntimeHome = path.join(root, "runtime");
  const installerPath = path.join(root, "downloaded-jobctrl-installer");
  const environment = { ...process.env, HOME: isolatedHome, JOBCTRL_RUNTIME_HOME: isolatedRuntimeHome, JOBCTRL_DIR: path.join(isolatedRuntimeHome, "state") };
  let started = false;
  let runningStatus;
  let version;
  let stoppedStatus;
  try {
    await mkdir(isolatedHome, { recursive: true, mode: 0o700 });
    await mkdir(isolatedRuntimeHome, { recursive: true, mode: 0o700 });
    await runner("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", installerUrl, "-o", installerPath], { env: environment });
    invariant(await sha256File(installerPath) === installerSha256, "published smoke downloaded installer SHA-256 mismatch");
    await chmod(installerPath, 0o700);
    let releaseUrl = descriptorUrl;
    if (channelPointerUrl !== null) {
      invariant(typeof channelPointerUrl === "string" && channelPointerUrl.startsWith("https://"), "published smoke pointer URL must use HTTPS");
      await runner("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", channelPointerUrl, "-o", path.join(isolatedRuntimeHome, "channel-pointer.json")], { env: environment });
      const pointer = validateReleaseChannelPointer(JSON.parse(await readFile(path.join(isolatedRuntimeHome, "channel-pointer.json"), "utf8")));
      await runner("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", pointer.descriptor.url, "-o", path.join(isolatedRuntimeHome, "release-descriptor.json")], { env: environment });
      await runner("/usr/bin/curl", ["--fail", "--silent", "--show-error", "--proto", "=https", "--tlsv1.2", pointer.signature.url, "-o", path.join(isolatedRuntimeHome, "release-descriptor.json.sig")], { env: environment });
      invariant(await sha256File(path.join(isolatedRuntimeHome, "release-descriptor.json")) === pointer.descriptor.sha256 && await sha256File(path.join(isolatedRuntimeHome, "release-descriptor.json.sig")) === pointer.signature.sha256, "published smoke immutable pointer digest mismatch");
      const pointedDescriptor = validateReleaseDescriptor(JSON.parse(await readFile(path.join(isolatedRuntimeHome, "release-descriptor.json"), "utf8")));
      invariant(pointer.channel === pointedDescriptor.channel && pointer.platform.id === pointedDescriptor.platform.id && pointer.platform.os === pointedDescriptor.platform.os && pointer.platform.arch === pointedDescriptor.platform.arch && pointer.sourceCommit === pointedDescriptor.sourceCommit && pointer.buildId === pointedDescriptor.buildId && pointer.sequence === pointedDescriptor.sequence, "published smoke pointer identity does not match the signed descriptor");
      releaseUrl = channelPointerUrl;
    }
    const plan = publishedCandidateSmokePlan({ descriptorUrl: releaseUrl, installerPath, outputHome: isolatedRuntimeHome });
    for (const command of channelPointerUrl === null ? plan.slice(0, 2) : []) await runner(command.command, command.args, { env: environment });
    const observedCandidate = candidateIdentityFromDescriptor(await readFile(path.join(isolatedRuntimeHome, "release-descriptor.json"), "utf8"));
    assertCandidateIdentity(expectedCandidate, observedCandidate);
    for (const command of plan.slice(2)) {
      const result = await runner(command.command, command.args, { env: environment });
      if (command.args[0] === "start") started = true;
      if (command.args[0] === "status" && !started) stoppedStatus = parseCommandJson(result, "post-stop native status");
      else if (command.args[0] === "status") runningStatus = parseCommandJson(result, "native status");
      if (command.args[0] === "version") version = parseCommandJson(result, "native version");
      if (command.args[0] === "stop") started = false;
    }
    assertRunningStatus(runningStatus);
    assertPublishedVersion(version, observedCandidate);
    assertStoppedStatus(stoppedStatus);
    return {
      schemaVersion: 1,
      status: "passed",
      publicationStatus: "published-candidate-verified",
      descriptorUrl,
      ...(channelPointerUrl === null ? {} : { channelPointerUrl }),
      installerUrl,
      installerSha256,
      candidate: observedCandidate,
      pypiPublicationAuthorized: true,
      checks: ["https-descriptor", "https-descriptor-signature", ...(channelPointerUrl === null ? [] : ["https-immutable-channel-pointer", "channel-pointer-identity"]), "https-artifact-via-native-installer", "native-start", "native-status-running", "native-version-identity", "native-stop", "native-status-stopped"],
    };
  } finally {
    if (started) {
      try {
        await runner(path.join(isolatedRuntimeHome, "bin", "jobctrl"), ["stop"], { env: environment });
      } catch {
        // Best-effort cleanup cannot hide the original smoke failure.
      }
    }
    if (runtimeHome === null) await rm(root, { recursive: true, force: true });
  }
}

export async function recordPublishedCandidateSmoke({ releaseDirectory, smoke }) {
  invariant(smoke?.status === "passed" && smoke.publicationStatus === "published-candidate-verified" && smoke.pypiPublicationAuthorized === true, "only a successful published native lifecycle smoke may authorize promotion");
  const metadata = JSON.parse(await readFile(path.join(releaseDirectory, "release-metadata.json"), "utf8"));
  invariant(metadata?.pypiPublicationAuthorized === false, "candidate metadata may not self-authorize promotion");
  invariant(smoke.descriptorUrl === metadata.publicationUrls?.immutableDescriptorUrl && smoke.channelPointerUrl === metadata.publicationUrls?.immutableChannelPointerUrl && smoke.installerUrl === metadata.publicationUrls?.installerUrl && smoke.installerSha256 === metadata.installer?.sha256, "published smoke does not bind this immutable release candidate");
  assertCandidateIdentity({
    descriptorSha256: metadata.descriptor?.sha256,
    buildId: metadata.buildId,
    appVersion: metadata.appVersion,
    artifactSha256: metadata.archive?.sha256,
    artifactSizeBytes: metadata.archive?.sizeBytes,
    manifestSha256: metadata.manifest?.sha256,
  }, smoke.candidate);
  await writeFile(path.join(releaseDirectory, "published-candidate-smoke.json"), canonicalJson(smoke), { mode: 0o644 });
  // The candidate checksum closure was already published before the network
  // smoke existed. Do not rewrite it afterward: this report is separately
  // authenticated CI evidence, not a mutable member of that closure.
  return { status: "recorded", smokePath: path.join(releaseDirectory, "published-candidate-smoke.json"), checksumClosure: "unchanged-pre-publication-candidate" };
}

export async function verifyPyPIReleaseGate({ releaseDirectory, expectedTag, sourceCommit, expectedPublicKeyBase64, expectedKeyId }) {
  invariant(typeof expectedTag === "string" && /^v[0-9]+\.[0-9]+\.[0-9]+$/.test(expectedTag), "PyPI release gate requires a stable v<semver> tag");
  invariant(typeof sourceCommit === "string" && /^[a-f0-9]{40}$/.test(sourceCommit), "PyPI release gate requires the checked-out audited commit SHA");
  invariant(typeof expectedKeyId === "string" && /^[A-Za-z0-9._-]+$/.test(expectedKeyId), "PyPI release gate requires a protected expected release key id");
  invariant(typeof expectedPublicKeyBase64 === "string" && Buffer.from(expectedPublicKeyBase64, "base64").length === 32 && Buffer.from(expectedPublicKeyBase64, "base64").toString("base64") === expectedPublicKeyBase64, "PyPI release gate requires a protected canonical raw Ed25519 public key");
  const metadata = JSON.parse(await readFile(path.join(releaseDirectory, "release-metadata.json"), "utf8"));
  invariant(metadata?.status === "signed-notarized-release-candidate" && metadata.channel === "stable", "PyPI release gate requires a signed stable P6 candidate");
  invariant(metadata.pypiPublicationAuthorized === false, "pre-publication metadata must not self-authorize PyPI");
  invariant(metadata.appVersion === expectedTag.slice(1), "PyPI release tag does not match the signed candidate version");
  invariant(metadata.sourceCommit === sourceCommit, "PyPI checkout commit does not match the signed candidate provenance");
  const urls = canonicalReleaseUrls("stable", metadata.archive?.file, metadata.buildId);
  invariant(metadata.publicationUrls?.descriptorUrl === urls.descriptorUrl && metadata.publicationUrls?.immutableDescriptorUrl === urls.immutableDescriptorUrl && metadata.publicationUrls?.artifactUrl === urls.artifactUrl && metadata.publicationUrls?.installerUrl === urls.installerUrl, "PyPI release gate requires canonical published P6 URLs");
  const [descriptorRaw, descriptorSignatureRaw, channelPointerRaw, manifestRaw, manifestSignatureRaw, trustRaw, smokeRaw, checksumsRaw] = await Promise.all([
    readFile(path.join(releaseDirectory, "release-descriptor.json"), "utf8"),
    readFile(path.join(releaseDirectory, "release-descriptor.json.sig"), "utf8"),
    readFile(path.join(releaseDirectory, "channel-pointer.json"), "utf8"),
    readFile(path.join(releaseDirectory, "manifest.json"), "utf8"),
    readFile(path.join(releaseDirectory, "manifest.sig"), "utf8"),
    readFile(path.join(releaseDirectory, "release-keys.json"), "utf8"),
    readFile(path.join(releaseDirectory, "published-candidate-smoke.json"), "utf8"),
    readFile(path.join(releaseDirectory, "SHA256SUMS"), "utf8"),
  ]);
  const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
  const channelPointer = validateReleaseChannelPointer(JSON.parse(channelPointerRaw));
  const descriptorSignature = JSON.parse(descriptorSignatureRaw);
  const manifestSignature = JSON.parse(manifestSignatureRaw);
  const trust = JSON.parse(trustRaw);
  assertExactKeys(trust, ["schemaVersion", "keys"], "release trust registry");
  invariant(trust.schemaVersion === 1 && trust.keys !== null && typeof trust.keys === "object" && !Array.isArray(trust.keys), "release trust registry is invalid");
  const keyId = descriptorSignature.keyId;
  invariant(typeof keyId === "string" && keyId === manifestSignature.manifestKeyId && typeof trust.keys[keyId] === "string", "release signatures do not share a provisioned trust key");
  // The downloaded release registry is an audit copy, never PyPI's trust
  // anchor. A compromised draft-asset set must not be able to replace both a
  // descriptor and its verifying key.
  invariant(keyId === expectedKeyId && trust.keys[keyId] === expectedPublicKeyBase64, "release candidate does not bind the protected expected release trust");
  const publicKey = publicKeyFromRaw(Buffer.from(expectedPublicKeyBase64, "base64"));
  validateReleaseDescriptorSignature(descriptorSignature, { channel: "stable" });
  verifyReleaseBytes({ domain: DESCRIPTOR_SIGNING_DOMAIN, raw: descriptorRaw, signature: descriptorSignature, publicKey, keyId, kind: "descriptor" });
  verifyReleaseBytes({ domain: MANIFEST_SIGNING_DOMAIN, raw: manifestRaw, signature: manifestSignature, publicKey, keyId, kind: "manifest" });
  invariant(descriptor.sourceCommit === sourceCommit && descriptor.sourceCommit === metadata.sourceCommit, "signed descriptor source commit does not match the checked-out audited tag");
  invariant(descriptor.buildId === metadata.buildId && descriptor.appVersion === metadata.appVersion && descriptor.artifact.sha256 === metadata.archive.sha256, "descriptor does not bind the P6 release metadata");
  invariant(metadata.channelPointer?.url === urls.immutableChannelPointerUrl && metadata.channelPointer?.sha256 === sha256Bytes(Buffer.from(channelPointerRaw, "utf8")), "release metadata does not bind the immutable channel pointer");
  invariant(channelPointer.channel === descriptor.channel && channelPointer.platform.id === descriptor.platform.id && channelPointer.platform.os === descriptor.platform.os && channelPointer.platform.arch === descriptor.platform.arch && channelPointer.sourceCommit === descriptor.sourceCommit && channelPointer.buildId === descriptor.buildId && channelPointer.sequence === descriptor.sequence && channelPointer.descriptor.url === urls.immutableDescriptorUrl && channelPointer.descriptor.sha256 === sha256Bytes(Buffer.from(descriptorRaw, "utf8")) && channelPointer.signature.url === urls.immutableDescriptorSignatureUrl && channelPointer.signature.sha256 === sha256Bytes(Buffer.from(descriptorSignatureRaw, "utf8")), "immutable channel pointer does not bind the signed descriptor pair");
  invariant(sha256Bytes(Buffer.from(descriptorRaw, "utf8")) === metadata.descriptor?.sha256, "release metadata descriptor digest does not match the signed descriptor bytes");
  invariant(sha256Bytes(Buffer.from(manifestRaw, "utf8")) === descriptor.artifact.manifestSha256 && sha256Bytes(Buffer.from(manifestRaw, "utf8")) === metadata.manifest?.sha256, "descriptor or release metadata manifest digest does not match the released manifest bytes");
  const archivePath = path.join(releaseDirectory, metadata.archive.file);
  invariant(await sha256File(archivePath) === descriptor.artifact.sha256 && (await stat(archivePath)).size === descriptor.artifact.sizeBytes, "descriptor artifact digest or size does not match the released ZIP bytes");
  const smoke = JSON.parse(smokeRaw);
  invariant(smoke?.status === "passed" && smoke.publicationStatus === "published-candidate-verified" && smoke.pypiPublicationAuthorized === true, "PyPI release gate requires a passing published native lifecycle smoke");
  invariant(smoke.descriptorUrl === urls.immutableDescriptorUrl && smoke.channelPointerUrl === urls.immutableChannelPointerUrl && smoke.installerUrl === urls.installerUrl && smoke.installerSha256 === metadata.installer.sha256, "PyPI release smoke does not bind the immutable downloaded installer and descriptor");
  assertCandidateIdentity({
    descriptorSha256: metadata.descriptor?.sha256,
    buildId: metadata.buildId,
    appVersion: metadata.appVersion,
    artifactSha256: metadata.archive?.sha256,
    artifactSizeBytes: metadata.archive?.sizeBytes,
    manifestSha256: metadata.manifest?.sha256,
  }, smoke.candidate);
  const checksumRecords = new Map();
  for (const line of checksumsRaw.trim().split("\n")) {
    const match = line.match(/^([a-f0-9]{64})  (.+)$/);
    invariant(match, "SHA256SUMS has an invalid record");
    invariant(!checksumRecords.has(match[2]), "SHA256SUMS has duplicate paths");
    checksumRecords.set(match[2], match[1]);
  }
  const files = (await releaseRegularFiles(releaseDirectory)).filter((file) => file !== "SHA256SUMS" && file !== "published-candidate-smoke.json");
  invariant(JSON.stringify([...checksumRecords.keys()].sort(bytewiseCompare)) === JSON.stringify(files), "SHA256SUMS does not bind every release asset");
  for (const file of files) invariant(await sha256File(path.join(releaseDirectory, file)) === checksumRecords.get(file), `SHA256SUMS digest mismatch for ${file}`);
  return { status: "pass", buildId: metadata.buildId, appVersion: metadata.appVersion, descriptorSha256: sha256Bytes(descriptorRaw) };
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    invariant(option.startsWith("--"), `unknown argument ${option}`);
    const key = option.slice(2);
    const value = argv[index + 1];
    invariant(value !== undefined && !value.startsWith("--") && options[key] === undefined, `${option} requires one value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function requireOptions(options, names, command, optional = []) {
  const allowed = new Set([...names, ...optional]);
  const unexpected = Object.keys(options).filter((key) => !allowed.has(key));
  invariant(unexpected.length === 0, `${command} has unsupported options: ${unexpected.join(", ")}`);
  for (const name of names) invariant(options[name] !== undefined, `${command} requires --${name}`);
}

function parseCanonicalIntegerOption(value, name, { minimum = 0 } = {}) {
  invariant(/^(?:0|[1-9][0-9]*)$/.test(value), `--${name} must be a canonical integer`);
  const parsed = Number(value);
  invariant(Number.isSafeInteger(parsed) && parsed >= minimum, `--${name} must be a safe integer greater than or equal to ${minimum}`);
  return parsed;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command === "inspect") {
    invariant(rest.length === 2, "usage: distribution-release.mjs inspect <descriptor.json> <descriptor.json.sig>");
    const [descriptorRaw, signatureRaw] = await Promise.all(rest.map((value) => readFile(path.resolve(value), "utf8")));
    const descriptor = validateReleaseDescriptor(JSON.parse(descriptorRaw));
    validateReleaseDescriptorSignature(JSON.parse(signatureRaw), { channel: descriptor.channel });
    process.stdout.write(canonicalJson({ channel: descriptor.channel, buildId: descriptor.buildId, descriptorSha256: sha256Bytes(descriptorRaw), artifact: descriptor.artifact }));
    return;
  }
  if (command === "validate-pointer") {
    invariant(rest.length === 1, "usage: distribution-release.mjs validate-pointer <channel-pointer.json>");
    const pointer = validateReleaseChannelPointer(JSON.parse(await readFile(path.resolve(rest[0]), "utf8")));
    process.stdout.write(canonicalJson(pointer));
    return;
  }
  const options = parseOptions(rest);
  if (command === "prepare") {
    requireOptions(options, ["output", "channel", "build-id", "source-date-epoch"], command);
    const configuredPublicKey = process.env.JOBCTRL_RELEASE_PUBLIC_KEY;
    const publicKey = configuredPublicKey ?? releasePublicKeyBase64(privateKeyFromBase64(process.env.JOBCTRL_RELEASE_SIGNING_KEY ?? ""));
    invariant(Buffer.from(publicKey, "base64").length === 32 && Buffer.from(publicKey, "base64").toString("base64") === publicKey, "prepared release requires a canonical raw Ed25519 public key");
    const result = await buildRealPayload({
      outputDirectory: path.resolve(options.output),
      buildId: options["build-id"],
      sourceDateEpoch: parseCanonicalIntegerOption(options["source-date-epoch"], "source-date-epoch"),
      releaseChannel: options.channel,
      releaseTrustKeyBase64: publicKey,
    });
    process.stdout.write(canonicalJson({ status: "prepared", buildId: result.buildId, archiveSha256: result.archiveSha256, manifestSha256: result.manifestSha256, nativeLauncherReleaseChannel: result.nativeLauncherReleaseChannel, nativeLauncherReleaseTrustKeySha256: result.nativeLauncherReleaseTrustKeySha256 }));
    return;
  }
  if (command === "compare") {
    requireOptions(options, ["first", "second", "channel", "public-key", "output"], command);
    const comparison = await comparePreparedBuilds(path.resolve(options.first), path.resolve(options.second), {
      channel: options.channel,
      publicKeyBase64: options["public-key"],
    });
    await writeFile(path.resolve(options.output), canonicalJson(comparison), { mode: 0o644 });
    process.stdout.write(canonicalJson(comparison));
    return;
  }
  if (command === "verify-prepared") {
    requireOptions(options, ["prepared", "channel", "public-key"], command);
    const verification = await verifyPreparedCandidate({
      preparedDirectory: path.resolve(options.prepared),
      channel: options.channel,
      publicKeyBase64: options["public-key"],
    });
    process.stdout.write(canonicalJson(verification));
    return;
  }
  if (command === "finalize") {
    requireOptions(options, ["prepared", "comparison", "output", "channel", "sequence", "minimum-safe-sequence", "revoked-build-ids", "source-date-epoch", "source-commit"], command);
    const comparison = JSON.parse(await readFile(path.resolve(options.comparison), "utf8"));
    const result = await finalizeNetworkRelease({
      preparedDirectory: path.resolve(options.prepared),
      releaseDirectory: path.resolve(options.output),
      channel: options.channel,
      sequence: parseCanonicalIntegerOption(options.sequence, "sequence", { minimum: 1 }),
      minimumSafeSequence: parseCanonicalIntegerOption(options["minimum-safe-sequence"], "minimum-safe-sequence", { minimum: 1 }),
      revokedBuildIds: JSON.parse(options["revoked-build-ids"]),
      sourceDateEpoch: parseCanonicalIntegerOption(options["source-date-epoch"], "source-date-epoch"),
      sourceCommit: options["source-commit"],
      preSignComparison: comparison,
      signingKeyBase64: process.env.JOBCTRL_RELEASE_SIGNING_KEY ?? "",
      appleIdentity: process.env.JOBCTRL_APPLE_SIGNING_IDENTITY ?? "",
      notaryProfile: process.env.JOBCTRL_APPLE_NOTARY_PROFILE ?? "",
    });
    process.stdout.write(canonicalJson({ status: "finalized", archivePath: result.archivePath, archiveFileName: result.archiveFileName, publicationUrls: result.metadata.publicationUrls }));
    return;
  }
  if (command === "smoke") {
    requireOptions(options, ["descriptor-url", "installer-url", "installer-sha256", "release-dir", "output"], command, ["pointer-url"]);
    const metadata = JSON.parse(await readFile(path.join(path.resolve(options["release-dir"]), "release-metadata.json"), "utf8"));
    const smoke = await runPublishedCandidateSmoke({
      descriptorUrl: options["descriptor-url"],
      channelPointerUrl: options["pointer-url"] ?? null,
      installerUrl: options["installer-url"],
      installerSha256: options["installer-sha256"],
      expectedCandidate: {
        descriptorSha256: metadata.descriptor?.sha256,
        buildId: metadata.buildId,
        appVersion: metadata.appVersion,
        artifactSha256: metadata.archive?.sha256,
        artifactSizeBytes: metadata.archive?.sizeBytes,
        manifestSha256: metadata.manifest?.sha256,
      },
    });
    await writeFile(path.resolve(options.output), canonicalJson(smoke), { mode: 0o644 });
    process.stdout.write(canonicalJson(smoke));
    return;
  }
  if (command === "record-smoke") {
    requireOptions(options, ["release-dir", "smoke"], command);
    const result = await recordPublishedCandidateSmoke({ releaseDirectory: path.resolve(options["release-dir"]), smoke: JSON.parse(await readFile(path.resolve(options.smoke), "utf8")) });
    process.stdout.write(canonicalJson(result));
    return;
  }
  if (command === "pointer") {
    requireOptions(options, ["descriptor", "signature", "descriptor-url", "signature-url", "output"], command);
    const [descriptorRaw, signatureRaw] = await Promise.all([readFile(path.resolve(options.descriptor), "utf8"), readFile(path.resolve(options.signature), "utf8")]);
    const pointer = createReleaseChannelPointer({ descriptorRaw, signatureRaw, descriptorUrl: options["descriptor-url"], signatureUrl: options["signature-url"] });
    await writeFile(path.resolve(options.output), canonicalJson(pointer), { mode: 0o644 });
    process.stdout.write(canonicalJson(pointer));
    return;
  }
  if (command === "verify-pypi-gate") {
    requireOptions(options, ["release-dir", "tag", "source-commit"], command);
    process.stdout.write(canonicalJson(await verifyPyPIReleaseGate({
      releaseDirectory: path.resolve(options["release-dir"]),
      expectedTag: options.tag,
      sourceCommit: options["source-commit"],
      expectedPublicKeyBase64: process.env.JOBCTRL_RELEASE_PUBLIC_KEY ?? "",
      expectedKeyId: process.env.JOBCTRL_RELEASE_KEY_ID ?? "",
    })));
    return;
  }
  throw new Error("usage: distribution-release.mjs inspect|validate-pointer|prepare|compare|verify-prepared|finalize|smoke|record-smoke|pointer|verify-pypi-gate");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath && path.basename(process.argv[1] ?? "") === "distribution-release.mjs") {
  main().catch((error) => {
    process.stderr.write(`distribution release: ${error.message}\n`);
    process.exitCode = 1;
  });
}
