#!/usr/bin/env node

import { createHash, createPublicKey, verify as verifySignature } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertCandidateIdentity, candidateIdentityFromDescriptor, releasePublicationInputs, validateReleaseDescriptor, validateReleaseDescriptorSignature } from "./distribution-release.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");
export const FORMULA_TEMPLATE_PATH = path.join(REPO_ROOT, "packaging", "homebrew", "Formula", "jobctrl.rb.tmpl");
export const RELEASE_TRUST_PATH = path.join(REPO_ROOT, "packaging", "distribution", "release-keys.json");
const RELEASE_ORIGIN = "https://releases.jobctrl.dev";

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertExactKeys(value, keys, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  invariant(JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), `${label} fields must be exact`);
  return value;
}

function requireCanonicalReleaseUrl(value, label) {
  invariant(typeof value === "string" && value.length > 0 && !/[\x00-\x20"'\\]/.test(value), `${label} must not contain whitespace, quotes, or backslashes`);
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute HTTPS URL`);
  }
  invariant(parsed.protocol === "https:" && parsed.username === "" && parsed.password === "" && parsed.hash === "", `${label} must be an absolute HTTPS URL without credentials or fragments`);
  invariant(parsed.origin === RELEASE_ORIGIN && parsed.port === "", `${label} must use the canonical ${RELEASE_ORIGIN} origin`);
  invariant(parsed.href === value, `${label} must be canonical before it can be rendered into Ruby`);
  return parsed;
}

function requireImmutableReleaseUrl(value, label, expectedPath) {
  const parsed = requireCanonicalReleaseUrl(value, label);
  invariant(parsed.pathname === expectedPath && parsed.search === "" && parsed.href === value, `${label} must select the exact immutable build path`);
  return parsed;
}

function signingMessage(raw) {
  return Buffer.concat([Buffer.from("jobctrl:release-descriptor:v1\0", "utf8"), Buffer.from(raw, "utf8")]);
}

function publicKeyFromBase64(encoded, keyId) {
  invariant(typeof encoded === "string", `release trust key ${keyId} must be base64`);
  const raw = Buffer.from(encoded, "base64");
  invariant(raw.length === 32 && raw.toString("base64") === encoded, `release trust key ${keyId} must be a raw Ed25519 public key`);
  return createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), raw]),
    format: "der",
    type: "spki",
  });
}

export async function loadHomebrewReleaseTrust(trustPath = RELEASE_TRUST_PATH) {
  const trust = JSON.parse(await readFile(trustPath, "utf8"));
  assertExactKeys(trust, ["schemaVersion", "keys"], "Homebrew release trust registry");
  invariant(trust.schemaVersion === 1 && trust.keys !== null && typeof trust.keys === "object" && !Array.isArray(trust.keys), "Homebrew release trust registry is invalid");
  const keys = new Map();
  for (const [keyId, encoded] of Object.entries(trust.keys).sort(([left], [right]) => left.localeCompare(right))) {
    invariant(/^[A-Za-z0-9._-]+$/.test(keyId), "Homebrew release trust key id is invalid");
    keys.set(keyId, publicKeyFromBase64(encoded, keyId));
  }
  return keys;
}

export function verifyReleaseDescriptorSignature({ descriptorRaw, signatureRaw, trust }) {
  const descriptor = JSON.parse(descriptorRaw);
  const signature = JSON.parse(signatureRaw);
  validateReleaseDescriptor(descriptor);
  validateReleaseDescriptorSignature(signature, { channel: descriptor.channel });
  invariant(descriptor.channel === "stable", "Homebrew formula rendering requires a stable descriptor");
  invariant(trust instanceof Map, "Homebrew release trust must be loaded before signature verification");
  const key = trust.get(signature.keyId);
  invariant(key, `no Homebrew release trust key is provisioned for ${signature.keyId}`);
  const encoded = Buffer.from(signature.signature, "base64");
  invariant(verifySignature(null, signingMessage(descriptorRaw), key, encoded), "Homebrew release descriptor Ed25519 signature verification failed");
  return descriptor;
}

function templateValues({ descriptor, descriptorRaw, signatureRaw, descriptorUrl }) {
  validateReleaseDescriptor(descriptor);
  invariant(descriptor.channel === "stable", "Homebrew formula rendering requires a stable descriptor");
  const immutableBase = `/v1/artifacts/${descriptor.buildId}`;
  const descriptorOrigin = requireImmutableReleaseUrl(descriptorUrl, "Homebrew descriptor URL", `${immutableBase}/release-descriptor.json`);
  const artifactOrigin = requireImmutableReleaseUrl(descriptor.artifact.url, "Homebrew artifact URL", `${immutableBase}/jobctrl-${descriptor.appVersion}-darwin-arm64.zip`);
  invariant(descriptorOrigin.origin === artifactOrigin.origin, "Homebrew descriptor and artifact must share one release origin");
  return {
    ARTIFACT_URL: descriptor.artifact.url,
    ARTIFACT_SHA256: descriptor.artifact.sha256,
    APP_VERSION: descriptor.appVersion,
    BUILD_ID: descriptor.buildId,
    MANIFEST_SHA256: descriptor.artifact.manifestSha256,
    DESCRIPTOR_URL: descriptorUrl,
    DESCRIPTOR_SHA256: sha256(descriptorRaw),
    SIGNATURE_SHA256: sha256(signatureRaw ?? ""),
  };
}

export async function renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust }) {
  const descriptor = verifyReleaseDescriptorSignature({ descriptorRaw, signatureRaw, trust });
  const values = templateValues({ descriptor, descriptorRaw, signatureRaw, descriptorUrl });
  let formula = await readFile(FORMULA_TEMPLATE_PATH, "utf8");
  for (const [token, value] of Object.entries(values)) formula = formula.replaceAll(`{{${token}}}`, value);
  invariant(!/{{[A-Z_]+}}/.test(formula), "Homebrew formula template has an unresolved token");
  validateRenderedHomebrewFormula({ formula, descriptor, descriptorRaw, signatureRaw, descriptorUrl });
  return { formula, descriptor, descriptorSha256: values.DESCRIPTOR_SHA256, publicationInputs: releasePublicationInputs({ descriptorRaw, descriptorUrl }) };
}

export function homebrewPublicationInputs({ descriptorRaw, descriptorUrl }) {
  return releasePublicationInputs({ descriptorRaw, descriptorUrl });
}

export function validateRenderedHomebrewFormula({ formula, descriptor, descriptorRaw, signatureRaw = "", descriptorUrl }) {
  validateReleaseDescriptor(descriptor);
  const values = templateValues({ descriptor, descriptorRaw, signatureRaw, descriptorUrl });
  const required = [
    `url "${values.ARTIFACT_URL}"`,
    `sha256 "${values.ARTIFACT_SHA256}"`,
    `version "${values.APP_VERSION}"`,
    `JOBCTRL_BUILD_ID = "${values.BUILD_ID}"`,
    `JOBCTRL_MANIFEST_SHA256 = "${values.MANIFEST_SHA256}"`,
    `JOBCTRL_DESCRIPTOR_URL = "${values.DESCRIPTOR_URL}"`,
    `JOBCTRL_DESCRIPTOR_SHA256 = "${values.DESCRIPTOR_SHA256}"`,
    `JOBCTRL_SIGNATURE_SHA256 = "${values.SIGNATURE_SHA256}"`,
    'require "open3"',
    'if !gatekeeper_status.success? || gatekeeper_output.exclude?("source=Notarized Developer ID")',
    "verify_notarized_executable!(buildpath/\"launcher/jobctrl\")",
    "verify_notarized_executable!(buildpath/\"launcher/jobctrl-installer\")",
    "managed_headless_shell",
    "verify_notarized_executable!(managed_headless_shell)",
    'resource "jobctrl-release-descriptor"',
    'resource "jobctrl-release-descriptor-signature"',
    'bootstrap.install "release-descriptor.json" => "homebrew-release.json"',
    'bootstrap.install "release-descriptor.json.sig" => "homebrew-release.json.sig"',
    'bootstrap.install cached_download => "jobctrl-release.zip"',
    'bootstrap/"homebrew-bootstrap.json"',
    'bin.install_symlink bootstrap/"jobctrl"',
  ];
  for (const marker of required) invariant(formula.includes(marker), `rendered Homebrew formula is missing ${marker}`);
  const requiredCalls = [
    /Open3\.capture2e\(\s*"\/usr\/bin\/codesign",\s*"--verify",\s*"--deep",\s*"--strict",\s*"--check-notarization",\s*"-R=notarized",\s*"--verbose=2",\s*bundle\.to_s,?\s*\)/,
    /Open3\.capture2e\(\s*"\/usr\/bin\/codesign",\s*"--verify",\s*"--strict",\s*"--check-notarization",\s*"-R=notarized",\s*"--verbose=2",\s*executable\.to_s,?\s*\)/,
    /Open3\.capture2e\(\s*"\/usr\/sbin\/spctl",\s*"--assess",\s*"--type",\s*"execute",\s*"--verbose=4",\s*bundle\.to_s,?\s*\)/,
  ];
  for (const pattern of requiredCalls) invariant(pattern.test(formula), `rendered Homebrew formula is missing security call ${pattern}`);
  invariant(formula.includes("Formula installation remains entirely prefix-owned"), "rendered Homebrew formula must use first-invocation bootstrap");
  invariant(!formula.includes('verify_notarized_app!(buildpath/"launcher/jobctrl")'), "rendered Homebrew formula must not Gatekeeper-assess raw launcher executables");
  invariant(!formula.includes('Pathname.new(Dir.home)'), "rendered Homebrew formula must not write the user home during install");
  invariant(!/\bhead\s+/.test(formula), "rendered Homebrew formula must not have a HEAD/source path");
  invariant(!/depends_on\s+/.test(formula), "rendered Homebrew formula must not install a developer-toolchain dependency");
  for (const forbidden of ["corepack", "git", "node", "uv", "temporal", "poppler", "chrome"]) {
    invariant(!new RegExp(`depends_on\\s+\"${forbidden}\"`).test(formula), `rendered Homebrew formula must not depend on ${forbidden}`);
  }
  return true;
}

export async function verifyHomebrewPromotionEvidence({ descriptorRaw, signatureRaw, descriptorUrl, formulaRaw, evidenceRaw, trust }) {
  const canonicalRender = await renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl, trust });
  const { descriptor } = canonicalRender;
  invariant(
    formulaRaw === canonicalRender.formula,
    "Homebrew promotion formula must match the canonical checked-in template render byte-for-byte",
  );
  const evidence = JSON.parse(evidenceRaw);
  assertExactKeys(evidence, ["schemaVersion", "status", "signatureVerified", "publishedArtifactSmoke", "descriptorSha256", "formulaSha256", "artifact", "publishedCandidate"], "Homebrew promotion evidence");
  invariant(evidence.schemaVersion === 1 && evidence.status === "verified" && evidence.signatureVerified === true && evidence.publishedArtifactSmoke === "passed", "Homebrew promotion evidence is not verified after signed artifact smoke");
  const descriptorSha256 = sha256(descriptorRaw);
  const canonicalFormulaSha256 = sha256(canonicalRender.formula);
  invariant(evidence.descriptorSha256 === descriptorSha256 && evidence.formulaSha256 === canonicalFormulaSha256, "Homebrew promotion evidence digest mismatch");
  assertExactKeys(evidence.artifact, ["url", "sha256", "manifestSha256", "buildId", "appVersion"], "Homebrew promotion artifact evidence");
  invariant(
    evidence.artifact.url === descriptor.artifact.url
      && evidence.artifact.sha256 === descriptor.artifact.sha256
      && evidence.artifact.manifestSha256 === descriptor.artifact.manifestSha256
      && evidence.artifact.buildId === descriptor.buildId
      && evidence.artifact.appVersion === descriptor.appVersion,
    "Homebrew promotion evidence does not match the descriptor artifact identity",
  );
  assertCandidateIdentity(candidateIdentityFromDescriptor(descriptorRaw), evidence.publishedCandidate);
  return { descriptorSha256, formulaSha256: canonicalFormulaSha256, artifact: evidence.artifact };
}

function parseOptions(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    invariant(option.startsWith("--"), `unknown argument ${option}`);
    const key = option.slice(2);
    const value = argv[index + 1];
    invariant(value && !value.startsWith("--") && options[key] === undefined, `${option} requires one value`);
    options[key] = value;
    index += 1;
  }
  return options;
}

function assertOptionKeys(options, allowed, command) {
  const unknown = Object.keys(options).filter((key) => !allowed.includes(key)).sort();
  invariant(unknown.length === 0, `${command} contains unsupported options: ${unknown.join(", ")}`);
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  const options = parseOptions(argv.slice(1));
  const required = (name) => {
    invariant(options[name], `--${name} is required`);
    return path.resolve(options[name]);
  };
  if (command === "render") {
    assertOptionKeys(options, ["descriptor", "signature", "descriptor-url", "output", "trust"], command);
    const [descriptorRaw, signatureRaw] = await Promise.all([readFile(required("descriptor"), "utf8"), readFile(required("signature"), "utf8")]);
    const trust = await loadHomebrewReleaseTrust(options.trust ? path.resolve(options.trust) : RELEASE_TRUST_PATH);
    const result = await renderHomebrewFormula({ descriptorRaw, signatureRaw, descriptorUrl: options["descriptor-url"], trust });
    const output = required("output");
    await mkdir(path.dirname(output), { recursive: true, mode: 0o755 });
    await writeFile(output, result.formula, { mode: 0o644 });
    process.stdout.write(canonicalJson({ output, descriptorSha256: result.descriptorSha256, formulaSha256: sha256(result.formula), buildId: result.descriptor.buildId }));
    return;
  }
  if (command === "verify-promotion") {
    assertOptionKeys(options, ["descriptor", "signature", "descriptor-url", "formula", "evidence", "trust"], command);
    const [descriptorRaw, signatureRaw, formulaRaw, evidenceRaw] = await Promise.all([
      readFile(required("descriptor"), "utf8"),
      readFile(required("signature"), "utf8"),
      readFile(required("formula"), "utf8"),
      readFile(required("evidence"), "utf8"),
    ]);
    const trust = await loadHomebrewReleaseTrust(options.trust ? path.resolve(options.trust) : RELEASE_TRUST_PATH);
    const result = await verifyHomebrewPromotionEvidence({ descriptorRaw, signatureRaw, formulaRaw, evidenceRaw, descriptorUrl: options["descriptor-url"], trust });
    process.stdout.write(canonicalJson({ status: "pass", ...result }));
    return;
  }
  throw new Error("usage: distribution-homebrew.mjs render|verify-promotion --descriptor <path> --signature <path> --descriptor-url <https-url> [--output <path>|--formula <path> --evidence <path>]");
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath && path.basename(process.argv[1] ?? "") === "distribution-homebrew.mjs") {
  main().catch((error) => {
    process.stderr.write(`distribution homebrew: ${error.message}\n`);
    process.exitCode = 1;
  });
}
