#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, readlink, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(SCRIPT_DIR, "..");

const CLASSIFICATIONS = new Set([
  "core-runtime",
  "optional-capability",
  "provider-pack",
  "developer-only",
]);
const REDISTRIBUTION_MODES = new Set(["bundle", "official-download", "exclude"]);
const MANIFEST_CLASSIFICATIONS = new Set([
  "core-runtime",
  "optional-capability",
  "provider-pack",
]);
const RELEASE_CHANNELS = new Set(["local", "prerelease", "stable"]);
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const PLATFORM_ID_PATTERN = /^[a-z0-9]+-[a-z0-9_]+$/;
const OS_VERSION_PATTERN = /^[0-9]+(?:\.[0-9]+){1,2}$/;
const SAFE_FILE_MODES = new Set(["0644", "0755"]);
const EXPECTED_LOCK_INPUTS = new Map([
  ["node-runtime-archive", "node-runtime"],
  ["python-runtime-archive", "python-runtime"],
  ["temporal-runtime-archive", "temporal-runtime"],
  ["chromium-core-browser-archive", "chromium-core"],
  ["chromium-core-headless-archive", "chromium-core"],
  ["playwright-mcp-archive", "playwright-mcp"],
]);
const EXPECTED_CAPABILITY_POLICY = new Map([
  ["core-browser", { defaultEnabled: true, componentIds: ["chromium-core", "playwright-python"] }],
  ["auto-apply-browser", { defaultEnabled: false, componentIds: ["jobctrl-worker", "playwright-mcp"] }],
  ["authenticated-linkedin-browser", { defaultEnabled: false, componentIds: ["jobctrl-worker"] }],
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function assertObject(value, label) {
  invariant(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value;
}

function assertString(value, label) {
  invariant(typeof value === "string" && value.trim().length > 0, `${label} must be a non-empty string`);
  return value;
}

function assertBoolean(value, label) {
  invariant(typeof value === "boolean", `${label} must be a boolean`);
  return value;
}

function assertInteger(value, label, minimum = 0) {
  invariant(Number.isInteger(value) && value >= minimum, `${label} must be an integer >= ${minimum}`);
  return value;
}

function assertUnique(values, label) {
  invariant(new Set(values).size === values.length, `${label} must be unique`);
}

function bytewiseCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertExactKeys(value, allowedKeys, label) {
  const object = assertObject(value, label);
  const actual = Object.keys(object).sort(bytewiseCompare);
  const expected = [...allowedKeys].sort(bytewiseCompare);
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} fields must be exactly [${expected.join(", ")}]; received [${actual.join(", ")}]`,
  );
  return object;
}

function assertAllowedKeys(value, allowedKeys, label) {
  const object = assertObject(value, label);
  const unexpected = Object.keys(object).filter((key) => !allowedKeys.includes(key)).sort(bytewiseCompare);
  invariant(unexpected.length === 0, `${label} contains unexpected fields: ${unexpected.join(", ")}`);
  return object;
}

export function assertSafeRelativePath(value, label = "path") {
  assertString(value, label);
  invariant(!value.includes("\0"), `${label} must not contain NUL`);
  invariant(!/[\u0000-\u001f\u007f]/.test(value), `${label} must not contain control characters`);
  invariant(/^[\x20-\x7e]+$/.test(value), `${label} must contain printable ASCII only`);
  invariant(!value.includes("\\"), `${label} must use POSIX separators`);
  invariant(!path.posix.isAbsolute(value), `${label} must be relative`);
  const normalized = path.posix.normalize(value);
  invariant(normalized === value, `${label} must be normalized`);
  invariant(value !== "." && value !== ".." && !value.startsWith("../"), `${label} escapes the payload root`);
  return value;
}

export function resolveSafeSymlinkTarget(targetValue, linkPathValue) {
  const target = assertString(targetValue, "symlink target");
  const linkPath = assertSafeRelativePath(linkPathValue, "symlink path");
  invariant(!target.includes("\\"), `${linkPath}: symlink target must use POSIX separators`);
  invariant(!/[\u0000-\u001f\u007f]/.test(target), `${linkPath}: symlink target must not contain control characters`);
  invariant(/^[\x20-\x7e]+$/.test(target), `${linkPath}: symlink target must contain printable ASCII only`);
  invariant(!path.posix.isAbsolute(target), `${linkPath}: symlink target must be relative`);
  invariant(path.posix.normalize(target) === target, `${linkPath}: symlink target must be normalized`);
  invariant(target !== "." && target.length > 0, `${linkPath}: symlink target is invalid`);
  const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(linkPath), target));
  assertSafeRelativePath(resolved, `${linkPath}: resolved symlink target`);
  return resolved;
}

async function loadJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export async function loadDistributionContracts(root = REPO_ROOT) {
  const distributionDir = path.join(root, "packaging", "distribution");
  const [schema, inventory, platforms, componentLocks, capabilityPolicy, sourceBaseline, signingPolicy] = await Promise.all([
    loadJson(path.join(distributionDir, "manifest.schema.json")),
    loadJson(path.join(distributionDir, "component-inventory.json")),
    loadJson(path.join(distributionDir, "platforms.json")),
    loadJson(path.join(distributionDir, "components.lock.json")),
    loadJson(path.join(distributionDir, "capability-policy.json")),
    loadJson(path.join(distributionDir, "source-baseline.json")),
    loadJson(path.join(distributionDir, "signing-policy.json")),
  ]);
  return { schema, inventory, platforms, componentLocks, capabilityPolicy, sourceBaseline, signingPolicy };
}

export function compileManifestSchema(schema) {
  assertObject(schema, "manifest schema");
  invariant(schema.$schema === "https://json-schema.org/draft/2020-12/schema", "manifest schema must use JSON Schema 2020-12");
  invariant(schema.type === "object" && schema.additionalProperties === false, "manifest schema must be a closed object");
  invariant(Array.isArray(schema.required), "manifest schema.required must be an array");
  for (const key of [
    "schemaVersion",
    "appVersion",
    "buildId",
    "releaseChannel",
    "sourceDateEpoch",
    "platform",
    "launcherCompatibility",
    "components",
    "capabilities",
    "files",
    "signing",
  ]) {
    invariant(schema.required.includes(key), `manifest schema is missing required field ${key}`);
  }
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  return ajv.compile(schema);
}

function schemaErrors(validator) {
  return (validator.errors ?? [])
    .map((error) => `${error.instancePath || "/"} ${error.message}`)
    .join("; ");
}

export function validateComponentInventory(inventory) {
  assertExactKeys(inventory, ["schemaVersion", "components"], "component inventory");
  invariant(inventory.schemaVersion === 1, "component inventory schemaVersion must be 1");
  invariant(Array.isArray(inventory.components) && inventory.components.length > 0, "component inventory must not be empty");
  const ids = inventory.components.map((component) => component.id);
  assertUnique(ids, "component inventory ids");

  for (const componentValue of inventory.components) {
    const component = assertAllowedKeys(
      componentValue,
      ["id", "classification", "owner", "version", "versionSource", "source", "license", "redistribution", "requiredInCore", "embeddedIn", "notes"],
      "component inventory entry",
    );
    const id = assertString(component.id, "component id");
    invariant(ID_PATTERN.test(id), `component id is invalid: ${id}`);
    invariant(CLASSIFICATIONS.has(component.classification), `${id}: unknown classification ${component.classification}`);
    assertString(component.owner, `${id}.owner`);
    assertString(component.source, `${id}.source`);
    invariant(component.source.startsWith("https://"), `${id}.source must use HTTPS`);
    assertString(component.license, `${id}.license`);
    invariant(REDISTRIBUTION_MODES.has(component.redistribution), `${id}: unknown redistribution mode ${component.redistribution}`);
    assertBoolean(component.requiredInCore, `${id}.requiredInCore`);
    const versionFields = [component.version, component.versionSource].filter(
      (value) => typeof value === "string" && value.length > 0,
    );
    invariant(versionFields.length === 1, `${id}: define exactly one of version or versionSource`);
    if (component.notes !== undefined) assertString(component.notes, `${id}.notes`);

    if (component.requiredInCore) {
      invariant(component.classification === "core-runtime", `${id}: required core component must be core-runtime`);
      invariant(component.redistribution === "bundle", `${id}: required core component must be approved for bundling`);
    }
    if (component.classification === "developer-only") {
      invariant(component.redistribution === "exclude", `${id}: developer-only component must be excluded`);
      invariant(component.requiredInCore === false, `${id}: developer-only component cannot be required`);
    }
    if (component.redistribution === "official-download") {
      invariant(component.requiredInCore === false, `${id}: official-download component cannot be required in the core artifact`);
    }
  }
  const inventoryById = new Map(inventory.components.map((component) => [component.id, component]));
  for (const component of inventory.components) {
    if (component.embeddedIn === undefined) continue;
    const parentId = assertString(component.embeddedIn, `${component.id}.embeddedIn`);
    const parent = inventoryById.get(parentId);
    invariant(parent, `${component.id}: embeddedIn references unknown component ${parentId}`);
    invariant(parentId !== component.id, `${component.id}: component cannot embed itself`);
    invariant(component.redistribution === "bundle", `${component.id}: embedded component must be approved for bundling`);
    invariant(parent.redistribution === "bundle", `${component.id}: embeddedIn target must be approved for bundling`);
    invariant(parent.classification !== "developer-only", `${component.id}: embeddedIn target cannot be developer-only`);
    invariant(parent.embeddedIn === undefined, `${component.id}: embedded component chains are not supported`);
    invariant(component.requiredInCore === false, `${component.id}: embedded component cannot be a top-level required component`);
  }

  return inventoryById;
}

export function validateCapabilityPolicy(policyValue, inventoryById) {
  const policy = assertExactKeys(policyValue, ["schemaVersion", "capabilities"], "capability policy");
  invariant(policy.schemaVersion === 1, "capability policy schemaVersion must be 1");
  invariant(Array.isArray(policy.capabilities), "capability policy capabilities must be an array");
  const ids = policy.capabilities.map((capability) => capability.id);
  assertUnique(ids, "capability policy ids");
  invariant(ids.length === EXPECTED_CAPABILITY_POLICY.size, "capability policy must contain the complete required capability set");

  const capabilitiesById = new Map();
  for (const capabilityValue of policy.capabilities) {
    const capability = assertExactKeys(
      capabilityValue,
      ["id", "defaultEnabled", "componentIds"],
      "capability policy entry",
    );
    const id = assertString(capability.id, "capability policy id");
    invariant(ID_PATTERN.test(id), `invalid capability policy id ${id}`);
    const expected = EXPECTED_CAPABILITY_POLICY.get(id);
    invariant(expected, `capability policy contains unknown capability ${id}`);
    assertBoolean(capability.defaultEnabled, `${id}.defaultEnabled`);
    invariant(capability.defaultEnabled === expected.defaultEnabled, `${id}: unsafe defaultEnabled value`);
    invariant(Array.isArray(capability.componentIds) && capability.componentIds.length > 0, `${id}.componentIds must not be empty`);
    assertUnique(capability.componentIds, `${id}.componentIds`);
    const componentIds = [...capability.componentIds].sort(bytewiseCompare);
    const expectedIds = [...expected.componentIds].sort(bytewiseCompare);
    invariant(JSON.stringify(componentIds) === JSON.stringify(expectedIds), `${id}: component closure does not match the required policy`);
    for (const componentId of componentIds) {
      const component = inventoryById.get(componentId);
      invariant(component, `${id}: unknown component ${componentId}`);
      invariant(component.redistribution === "bundle", `${id}: ${componentId} is not approved for bundling`);
      invariant(component.embeddedIn === undefined, `${id}: embedded component ${componentId} cannot be a capability root`);
    }
    capabilitiesById.set(id, { ...capability, componentIds });
  }
  return capabilitiesById;
}

export function validatePlatforms(platformsValue, inventoryById) {
  const platforms = assertExactKeys(platformsValue, ["schemaVersion", "platforms"], "platform contract");
  invariant(platforms.schemaVersion === 1, "platform contract schemaVersion must be 1");
  invariant(Array.isArray(platforms.platforms) && platforms.platforms.length > 0, "platform list must not be empty");
  const ids = platforms.platforms.map((platform) => platform.id);
  assertUnique(ids, "platform ids");

  for (const platformValue of platforms.platforms) {
    const platform = assertExactKeys(
      platformValue,
      ["id", "os", "arch", "minimumOsVersion", "status", "launcherCompatibility", "signing", "minimumOsEvidence", "requiredComponents"],
      "platform",
    );
    invariant(PLATFORM_ID_PATTERN.test(assertString(platform.id, "platform.id")), `invalid platform id ${platform.id}`);
    invariant(["darwin", "linux", "windows"].includes(platform.os), `${platform.id}: unsupported os ${platform.os}`);
    invariant(["arm64", "amd64"].includes(platform.arch), `${platform.id}: unsupported arch ${platform.arch}`);
    invariant(OS_VERSION_PATTERN.test(platform.minimumOsVersion), `${platform.id}: invalid minimumOsVersion`);
    assertString(platform.status, `${platform.id}.status`);
    const compatibility = assertExactKeys(
      platform.launcherCompatibility,
      ["minimum", "maximum"],
      `${platform.id}.launcherCompatibility`,
    );
    assertInteger(compatibility.minimum, `${platform.id}.launcherCompatibility.minimum`, 1);
    assertInteger(compatibility.maximum, `${platform.id}.launcherCompatibility.maximum`, 1);
    invariant(compatibility.maximum >= compatibility.minimum, `${platform.id}: launcher compatibility range is inverted`);
    const signing = assertExactKeys(platform.signing, ["identity", "notarization"], `${platform.id}.signing`);
    assertString(signing.identity, `${platform.id}.signing.identity`);
    assertString(signing.notarization, `${platform.id}.signing.notarization`);
    invariant(Array.isArray(platform.minimumOsEvidence) && platform.minimumOsEvidence.length > 0, `${platform.id}: minimumOsEvidence must not be empty`);
    let highestObservedMinimum = "0.0";
    for (const evidenceValue of platform.minimumOsEvidence) {
      const evidence = assertExactKeys(
        evidenceValue,
        ["componentId", "observedMinimum", "observedPath", "method"],
        `${platform.id}.minimumOsEvidence`,
      );
      invariant(inventoryById.has(evidence.componentId), `${platform.id}: minimum-OS evidence references unknown component ${evidence.componentId}`);
      invariant(OS_VERSION_PATTERN.test(evidence.observedMinimum), `${platform.id}: invalid observedMinimum`);
      assertSafeRelativePath(evidence.observedPath, `${platform.id}.minimumOsEvidence.observedPath`);
      assertString(evidence.method, `${platform.id}.minimumOsEvidence.method`);
      const current = evidence.observedMinimum.split(".").map(Number);
      const highest = highestObservedMinimum.split(".").map(Number);
      if (current[0] > highest[0] || (current[0] === highest[0] && current[1] > highest[1])) {
        highestObservedMinimum = evidence.observedMinimum;
      }
    }
    const declared = platform.minimumOsVersion.split(".").map(Number);
    const highest = highestObservedMinimum.split(".").map(Number);
    invariant(
      declared[0] > highest[0] || (declared[0] === highest[0] && declared[1] >= highest[1]),
      `${platform.id}: minimumOsVersion is lower than observed Mach-O evidence ${highestObservedMinimum}`,
    );
    invariant(Array.isArray(platform.requiredComponents) && platform.requiredComponents.length > 0, `${platform.id}: requiredComponents must not be empty`);
    assertUnique(platform.requiredComponents, `${platform.id}.requiredComponents`);
    for (const componentId of platform.requiredComponents) {
      const component = inventoryById.get(componentId);
      invariant(component, `${platform.id}: unknown required component ${componentId}`);
      invariant(component.requiredInCore === true, `${platform.id}: ${componentId} is not marked requiredInCore`);
      invariant(component.redistribution === "bundle", `${platform.id}: ${componentId} is not approved for bundling`);
      invariant(component.embeddedIn === undefined, `${platform.id}: embedded component ${componentId} cannot be a top-level required component`);
    }
    const expectedRequired = [...inventoryById.values()]
      .filter((component) => component.requiredInCore && component.embeddedIn === undefined)
      .map((component) => component.id)
      .sort(bytewiseCompare);
    const actualRequired = [...platform.requiredComponents].sort(bytewiseCompare);
    invariant(
      JSON.stringify(actualRequired) === JSON.stringify(expectedRequired),
      `${platform.id}: requiredComponents does not equal the classified core closure`,
    );
  }

  return new Map(platforms.platforms.map((platform) => [platform.id, platform]));
}

export function validateComponentLocks(lockValue, inventoryById) {
  const locks = assertExactKeys(lockValue, ["schemaVersion", "platform", "inputs"], "component lock");
  invariant(locks.schemaVersion === 1, "component lock schemaVersion must be 1");
  invariant(PLATFORM_ID_PATTERN.test(assertString(locks.platform, "component lock platform")), "component lock platform is invalid");
  invariant(Array.isArray(locks.inputs) && locks.inputs.length > 0, "component lock inputs must not be empty");
  const lockIds = locks.inputs.map((input) => input.id);
  assertUnique(lockIds, "component lock ids");
  invariant(
    JSON.stringify([...lockIds].sort(bytewiseCompare)) === JSON.stringify([...EXPECTED_LOCK_INPUTS.keys()].sort(bytewiseCompare)),
    "component lock does not contain the exact required external input set",
  );
  for (const inputValue of locks.inputs) {
    const input = assertExactKeys(
      inputValue,
      ["id", "componentId", "version", "url", "sha256", "archiveType", "license"],
      "component lock input",
    );
    const id = assertString(input.id, "component lock id");
    invariant(ID_PATTERN.test(id), `${id}: invalid component lock id`);
    invariant(input.componentId === EXPECTED_LOCK_INPUTS.get(id), `${id}: componentId does not match the required external input contract`);
    const component = inventoryById.get(assertString(input.componentId, `${id}.componentId`));
    invariant(component, `${id}: unknown component ${input.componentId}`);
    invariant(component.redistribution === "bundle", `${id}: locked input is not approved for bundling`);
    assertString(input.version, `${id}.version`);
    assertString(input.url, `${id}.url`);
    invariant(input.url.startsWith("https://"), `${id}.url must use HTTPS`);
    invariant(SHA256_PATTERN.test(input.sha256), `${id}.sha256 must be lowercase SHA-256`);
    invariant(["tar.gz", "zip"].includes(input.archiveType), `${id}: unsupported archiveType`);
    assertString(input.license, `${id}.license`);
    invariant(input.license === component.license, `${id}: license does not match component inventory`);
  }
  return locks;
}

export function validateSigningPolicy(policyValue) {
  const policy = assertExactKeys(
    policyValue,
    ["schemaVersion", "stableReleaseStatus", "manifestSigning", "appleSigning", "channelRequirements", "promotionRequirements"],
    "signing policy",
  );
  invariant(policy.schemaVersion === 1, "signing policy schemaVersion must be 1");
  invariant(["blocked-awaiting-credentials", "ready"].includes(policy.stableReleaseStatus), "invalid stable release signing status");
  const manifestSigning = assertExactKeys(
    policy.manifestSigning,
    ["algorithm", "keyId", "publicKeyStatus", "privateKeySecret"],
    "manifest signing policy",
  );
  invariant(manifestSigning.algorithm === "ed25519", "manifest signing must use Ed25519");
  assertString(manifestSigning.keyId, "manifest signing keyId");
  invariant(["unprovisioned", "provisioned"].includes(manifestSigning.publicKeyStatus), "invalid manifest public-key status");
  invariant(
    /^JOBCTRL_[A-Z0-9_]+$/.test(assertString(manifestSigning.privateKeySecret, "manifest private-key secret name")),
    "manifest private-key secret name is invalid",
  );
  const appleSigning = assertExactKeys(
    policy.appleSigning,
    ["identityType", "teamIdStatus", "certificateSecret", "certificatePasswordSecret", "notaryProfileSecret"],
    "Apple signing policy",
  );
  invariant(appleSigning.identityType === "Developer ID Application", "Apple signing identity must be Developer ID Application");
  invariant(["unprovisioned", "provisioned"].includes(appleSigning.teamIdStatus), "invalid Apple team-id status");
  for (const secretName of [
    appleSigning.certificateSecret,
    appleSigning.certificatePasswordSecret,
    appleSigning.notaryProfileSecret,
  ]) {
    invariant(/^JOBCTRL_[A-Z0-9_]+$/.test(assertString(secretName, "signing secret name")), "signing policy contains an invalid secret name");
  }
  const channelRequirements = assertExactKeys(
    policy.channelRequirements,
    ["local", "prerelease", "stable"],
    "signing channel requirements",
  );
  for (const channel of ["local", "prerelease", "stable"]) {
    const requirements = assertExactKeys(
      channelRequirements[channel],
      ["manifestKey", "codeSigning", "notarized"],
      `${channel} signing requirements`,
    );
    invariant(["local-development", "release"].includes(requirements.manifestKey), `${channel}: invalid manifest key policy`);
    invariant(["unsigned-local", "developer-id"].includes(requirements.codeSigning), `${channel}: invalid code-signing policy`);
    assertBoolean(requirements.notarized, `${channel}.notarized`);
  }
  invariant(channelRequirements.local.manifestKey === "local-development", "local manifests must use the local-development key id");
  invariant(channelRequirements.local.codeSigning === "unsigned-local" && channelRequirements.local.notarized === false, "local artifacts must remain explicitly unsigned and unnotarized");
  for (const channel of ["prerelease", "stable"]) {
    invariant(channelRequirements[channel].manifestKey === "release", `${channel} manifests must use the configured release key`);
    invariant(channelRequirements[channel].codeSigning === "developer-id", `${channel} artifacts must use Developer ID signing`);
    invariant(channelRequirements[channel].notarized === true, `${channel} artifacts must be notarized`);
  }
  invariant(Array.isArray(policy.promotionRequirements) && policy.promotionRequirements.length > 0, "signing promotion requirements must not be empty");
  for (const requirement of policy.promotionRequirements) assertString(requirement, "signing promotion requirement");
  if (policy.stableReleaseStatus === "ready") {
    invariant(manifestSigning.publicKeyStatus === "provisioned", "stable signing cannot be ready without a provisioned manifest public key");
    invariant(appleSigning.teamIdStatus === "provisioned", "stable signing cannot be ready without a provisioned Apple team id");
  }
  return policy;
}

function parseVersionSource(source, root) {
  const separator = source.indexOf("#");
  invariant(separator > 0, `versionSource must contain a # selector: ${source}`);
  const relativePath = source.slice(0, separator);
  const selector = source.slice(separator + 1);
  assertSafeRelativePath(relativePath, "versionSource path");
  return { filePath: path.join(root, relativePath), selector };
}

async function resolveJsonSelector(filePath, selector) {
  let value = await loadJson(filePath);
  for (const segment of selector.split(".")) value = value?.[segment];
  return assertString(value, `${path.relative(REPO_ROOT, filePath)}#${selector}`);
}

async function resolveTomlProjectVersion(filePath) {
  const contents = await readFile(filePath, "utf8");
  const projectBlock = contents.match(/\[project\]([\s\S]*?)(?:\n\[|$)/);
  invariant(projectBlock, `${filePath}: missing [project] block`);
  const version = projectBlock[1].match(/^\s*version\s*=\s*"([^"]+)"/m);
  invariant(version, `${filePath}: missing project.version`);
  return version[1];
}

async function resolveUvLockVersion(filePath, packageName) {
  const contents = await readFile(filePath, "utf8");
  for (const block of contents.split(/\n(?=\[\[package\]\])/)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    if (name !== packageName) continue;
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    invariant(version, `${filePath}: ${packageName} has no version`);
    return version;
  }
  throw new Error(`${filePath}: package ${packageName} not found`);
}

async function resolvePnpmLockVersion(filePath, packageName) {
  const contents = await readFile(filePath, "utf8");
  const escapedName = packageName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = contents.match(new RegExp(`^  ['\"]?${escapedName}@([^:'\"(]+)(?:\\([^\\n]+\\))?['\"]?:$`, "m"));
  invariant(match, `${filePath}: package ${packageName} not found`);
  return match[1];
}

export async function resolveInventoryVersions(inventory, root = REPO_ROOT) {
  const resolved = {};
  for (const component of inventory.components) {
    if (component.version) {
      resolved[component.id] = component.version;
      continue;
    }
    const { filePath, selector } = parseVersionSource(component.versionSource, root);
    if (filePath.endsWith(".json")) {
      resolved[component.id] = await resolveJsonSelector(filePath, selector);
    } else if (filePath.endsWith("pyproject.toml") && selector === "project.version") {
      resolved[component.id] = await resolveTomlProjectVersion(filePath);
    } else if (filePath.endsWith("uv.lock")) {
      resolved[component.id] = await resolveUvLockVersion(filePath, selector);
    } else if (filePath.endsWith("pnpm-lock.yaml")) {
      resolved[component.id] = await resolvePnpmLockVersion(filePath, selector);
    } else {
      throw new Error(`${component.id}: unsupported versionSource ${component.versionSource}`);
    }
  }
  return resolved;
}

export function validateLicenseReview(licenseReview, inventoryById) {
  assertString(licenseReview, "license review");
  const reviewedComponents = [...licenseReview.matchAll(/^\| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \| `([^`]+)` \|/gm)]
    .map((match) => ({ id: match[1], classification: match[2], license: match[3], redistribution: match[4] }));
  const reviewedComponentIds = reviewedComponents.map((component) => component.id).sort(bytewiseCompare);
  const inventoryComponentIds = [...inventoryById.keys()].sort(bytewiseCompare);
  invariant(
    JSON.stringify(reviewedComponentIds) === JSON.stringify(inventoryComponentIds),
    "license review component set does not match component-inventory.json",
  );
  for (const reviewed of reviewedComponents) {
    const component = inventoryById.get(reviewed.id);
    invariant(reviewed.classification === component.classification, `${reviewed.id}: license review classification does not match inventory`);
    invariant(reviewed.license === component.license, `${reviewed.id}: license review license does not match inventory`);
    invariant(reviewed.redistribution === component.redistribution, `${reviewed.id}: license review decision does not match inventory`);
  }
  return reviewedComponents;
}

export async function auditDistributionContracts(root = REPO_ROOT) {
  const { schema, inventory, platforms, componentLocks, capabilityPolicy, sourceBaseline, signingPolicy } = await loadDistributionContracts(root);
  compileManifestSchema(schema);
  const inventoryById = validateComponentInventory(inventory);
  const platformsById = validatePlatforms(platforms, inventoryById);
  const locks = validateComponentLocks(componentLocks, inventoryById);
  const capabilitiesById = validateCapabilityPolicy(capabilityPolicy, inventoryById);
  const versions = await resolveInventoryVersions(inventory, root);
  invariant(platformsById.has(locks.platform), `component locks target unsupported platform ${locks.platform}`);
  for (const input of locks.inputs) {
    invariant(
      input.version === versions[input.componentId],
      `${input.id}: locked version ${input.version} does not match inventory version ${versions[input.componentId]}`,
    );
  }
  const licenseReview = await readFile(path.join(root, "packaging", "distribution", "LICENSE-REVIEW.md"), "utf8");
  validateLicenseReview(licenseReview, inventoryById);
  assertExactKeys(
    sourceBaseline,
    ["schemaVersion", "reproducibleCounts", "referenceFootprint"],
    "source baseline",
  );
  invariant(sourceBaseline.schemaVersion === 1, "source baseline schemaVersion must be 1");
  const referenceFootprint = assertExactKeys(
    sourceBaseline.referenceFootprint,
    ["status", "measurementContext", "logicalBytes", "observations", "notes"],
    "source baseline referenceFootprint",
  );
  invariant(referenceFootprint.status === "observational", "source footprint must be explicitly observational");
  assertExactKeys(
    referenceFootprint.measurementContext,
    ["referenceCommit", "recordedOn", "platform", "scope", "interpretation"],
    "source baseline measurementContext",
  );
  for (const [key, value] of Object.entries(referenceFootprint.measurementContext)) {
    assertString(value, `source baseline measurementContext.${key}`);
  }
  invariant(
    /^[a-f0-9]{40}$/.test(referenceFootprint.measurementContext.referenceCommit),
    "source footprint referenceCommit must be a full commit SHA",
  );
  assertExactKeys(referenceFootprint.logicalBytes, ["nodeModules", "pythonEnvironment"], "source baseline logicalBytes");
  assertInteger(referenceFootprint.logicalBytes.nodeModules, "source baseline nodeModules bytes");
  assertInteger(referenceFootprint.logicalBytes.pythonEnvironment, "source baseline Python environment bytes");
  invariant(Array.isArray(referenceFootprint.observations) && referenceFootprint.observations.length > 0, "source baseline observations must not be empty");
  const observationIds = [];
  for (const observationValue of referenceFootprint.observations) {
    const observation = assertAllowedKeys(
      observationValue,
      ["id", "value", "unit", "qualifier", "optional", "note"],
      "source baseline observation",
    );
    const id = assertString(observation.id, "source baseline observation id");
    observationIds.push(id);
    invariant(typeof observation.value === "number" && Number.isFinite(observation.value) && observation.value >= 0, `${id}.value must be a non-negative number`);
    assertString(observation.unit, `${id}.unit`);
    assertString(observation.qualifier, `${id}.qualifier`);
    if (observation.optional !== undefined) assertBoolean(observation.optional, `${id}.optional`);
    assertString(observation.note, `${id}.note`);
  }
  assertUnique(observationIds, "source baseline observation ids");
  invariant(Array.isArray(referenceFootprint.notes) && referenceFootprint.notes.length > 0, "source baseline notes must not be empty");
  for (const note of referenceFootprint.notes) assertString(note, "source baseline note");
  const [javascript, python, lockCounts] = await Promise.all([
    workspaceDependencyCounts(root),
    pythonDependencyCounts(root),
    lockRecordCounts(root),
  ]);
  const expectedCounts = {
    javascriptPackageFiles: javascript.packageFiles,
    javascriptUniqueDirect: javascript.uniqueDirect,
    javascriptUniqueRuntimeDirect: javascript.uniqueRuntimeDirect,
    javascriptUniqueDevelopmentDirect: javascript.uniqueDevelopmentDirect,
    pnpmPackageRecords: lockCounts.pnpmPackageRecords,
    pythonRuntimeDirect: python.runtimeDirect,
    pythonDevelopmentDirect: python.developmentDirect,
    uvPackageRecords: lockCounts.uvPackageRecords,
  };
  assertExactKeys(sourceBaseline.reproducibleCounts, Object.keys(expectedCounts), "source baseline reproducibleCounts");
  invariant(
    JSON.stringify(sourceBaseline.reproducibleCounts) === JSON.stringify(expectedCounts),
    "source dependency counts drifted; run distribution:measure and update source-baseline.json intentionally",
  );
  validateSigningPolicy(signingPolicy);
  return {
    schemaVersion: 1,
    componentCount: inventory.components.length,
    bundledComponentCount: inventory.components.filter((component) => component.redistribution === "bundle").length,
    providerPackCount: inventory.components.filter((component) => component.classification === "provider-pack").length,
    developerOnlyCount: inventory.components.filter((component) => component.classification === "developer-only").length,
    lockedInputCount: locks.inputs.length,
    capabilityCount: capabilitiesById.size,
    footprintReferenceCommit: referenceFootprint.measurementContext.referenceCommit,
    stableReleaseStatus: signingPolicy.stableReleaseStatus,
    platforms: [...platformsById.keys()],
    versions,
  };
}

function validateManifestComponent(componentValue, contracts) {
  const component = assertExactKeys(
    componentValue,
    ["id", "classification", "version", "owner", "source", "license", "redistribution", "path", "sha256", "sizeBytes", "required"],
    "manifest component",
  );
  const id = assertString(component.id, "manifest component id");
  invariant(ID_PATTERN.test(id), `invalid manifest component id ${id}`);
  invariant(MANIFEST_CLASSIFICATIONS.has(component.classification), `${id}: invalid manifest classification`);
  const inventory = contracts.inventoryById.get(id);
  invariant(inventory, `${id}: component is not classified in component-inventory.json`);
  invariant(inventory.classification !== "developer-only", `${id}: developer-only component cannot enter a payload`);
  invariant(inventory.redistribution === "bundle", `${id}: component is not approved for bundling`);
  invariant(inventory.embeddedIn === undefined, `${id}: embedded component cannot own an overlapping manifest root`);
  invariant(component.classification === inventory.classification, `${id}: classification does not match inventory`);
  invariant(assertString(component.version, `${id}.version`) === contracts.versions[id], `${id}: version does not match resolved inventory version`);
  invariant(assertString(component.owner, `${id}.owner`) === inventory.owner, `${id}: owner does not match component inventory`);
  invariant(assertString(component.source, `${id}.source`) === inventory.source, `${id}: source does not match component inventory`);
  invariant(assertString(component.license, `${id}.license`) === inventory.license, `${id}: license does not match component inventory`);
  invariant(component.redistribution === "bundle", `${id}: manifest redistribution must be bundle`);
  assertSafeRelativePath(component.path, `${id}.path`);
  invariant(SHA256_PATTERN.test(component.sha256), `${id}.sha256 must be lowercase SHA-256`);
  assertInteger(component.sizeBytes, `${id}.sizeBytes`);
  assertBoolean(component.required, `${id}.required`);
  invariant(component.required === inventory.requiredInCore, `${id}.required does not match component inventory`);
  return component;
}

function pathIsWithinRoot(filePath, componentPath) {
  return filePath === componentPath || filePath.startsWith(`${componentPath}/`);
}

export function summarizeComponentFiles(componentPath, files) {
  assertSafeRelativePath(componentPath, "component summary path");
  const ownedFiles = files
    .filter((file) => pathIsWithinRoot(file.path, componentPath))
    .sort((left, right) => bytewiseCompare(left.path, right.path));
  invariant(ownedFiles.length > 0, `no files are rooted at ${componentPath}`);
  const canonical = ownedFiles
    .map((file) => file.type === "symlink"
      ? `${file.path}\0symlink\0${file.target}\0${file.sizeBytes}\n`
      : `${file.path}\0file\0${file.sha256}\0${file.sizeBytes}\0${file.mode}\n`)
    .join("");
  return {
    sha256: createHash("sha256").update(canonical).digest("hex"),
    sizeBytes: ownedFiles.reduce((total, file) => total + file.sizeBytes, 0),
    fileCount: ownedFiles.length,
  };
}

function resolveManifestPathThroughSymlinks(candidatePath, symlinkByPath) {
  let current = candidatePath;
  const seen = new Set();
  const links = [...symlinkByPath.keys()].sort((left, right) => right.length - left.length || bytewiseCompare(left, right));
  for (let step = 0; step <= links.length; step += 1) {
    invariant(!seen.has(current), `${candidatePath}: symlink cycle detected`);
    seen.add(current);
    const linkPath = links.find((entry) => current === entry || current.startsWith(`${entry}/`));
    if (!linkPath) return current;
    const link = symlinkByPath.get(linkPath);
    const resolvedTarget = resolveSafeSymlinkTarget(link.target, link.path);
    const suffix = current.slice(linkPath.length);
    current = path.posix.normalize(`${resolvedTarget}${suffix}`);
    assertSafeRelativePath(current, `${candidatePath}: resolved symlink path`);
  }
  throw new Error(`${candidatePath}: symlink resolution exceeded the manifest link count`);
}

export function validateDistributionManifest(manifestValue, contracts, { stable = false } = {}) {
  invariant(contracts.schemaValidator(manifestValue), `manifest schema validation failed: ${schemaErrors(contracts.schemaValidator)}`);
  const manifest = assertExactKeys(
    manifestValue,
    ["schemaVersion", "appVersion", "buildId", "releaseChannel", "sourceDateEpoch", "platform", "launcherCompatibility", "components", "capabilities", "files", "signing"],
    "distribution manifest",
  );
  invariant(manifest.schemaVersion === 1, "manifest schemaVersion must be 1");
  invariant(VERSION_PATTERN.test(assertString(manifest.appVersion, "appVersion")), "appVersion must be semver");
  invariant(manifest.appVersion === contracts.versions["jobctrl-launcher"], "appVersion does not match the resolved JobCtrl version");
  invariant(/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/.test(assertString(manifest.buildId, "buildId")), "buildId is invalid");
  invariant(RELEASE_CHANNELS.has(manifest.releaseChannel), "releaseChannel is invalid");
  assertInteger(manifest.sourceDateEpoch, "sourceDateEpoch");
  if (stable) invariant(manifest.releaseChannel === "stable", "stable validation requires the stable release channel");

  const platformValue = assertExactKeys(manifest.platform, ["id", "os", "arch", "minimumOsVersion"], "manifest.platform");
  const platform = contracts.platformsById.get(platformValue.id);
  invariant(platform, `manifest references unsupported platform ${platformValue.id}`);
  invariant(platformValue.os === platform.os, "manifest platform.os does not match platform contract");
  invariant(platformValue.arch === platform.arch, "manifest platform.arch does not match platform contract");
  invariant(platformValue.minimumOsVersion === platform.minimumOsVersion, "manifest minimum OS does not match platform contract");

  const compatibility = assertExactKeys(manifest.launcherCompatibility, ["minimum", "maximum"], "launcherCompatibility");
  assertInteger(compatibility.minimum, "launcherCompatibility.minimum", 1);
  assertInteger(compatibility.maximum, "launcherCompatibility.maximum", 1);
  invariant(compatibility.maximum >= compatibility.minimum, "launcherCompatibility range is inverted");
  invariant(compatibility.minimum === platform.launcherCompatibility.minimum, "launcherCompatibility.minimum does not match platform contract");
  invariant(compatibility.maximum === platform.launcherCompatibility.maximum, "launcherCompatibility.maximum does not match platform contract");

  invariant(Array.isArray(manifest.components) && manifest.components.length > 0, "manifest.components must not be empty");
  const components = manifest.components.map((component) => validateManifestComponent(component, contracts));
  const componentIds = components.map((component) => component.id);
  assertUnique(componentIds, "manifest component ids");
  invariant(
    JSON.stringify(componentIds) === JSON.stringify([...componentIds].sort(bytewiseCompare)),
    "manifest components must be bytewise sorted by id",
  );
  for (let leftIndex = 0; leftIndex < components.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < components.length; rightIndex += 1) {
      const left = components[leftIndex];
      const right = components[rightIndex];
      invariant(
        !pathIsWithinRoot(left.path, right.path) && !pathIsWithinRoot(right.path, left.path),
        `manifest component roots overlap: ${left.id} (${left.path}) and ${right.id} (${right.path})`,
      );
    }
  }
  for (const requiredId of platform.requiredComponents) {
    invariant(componentIds.includes(requiredId), `manifest is missing required component ${requiredId}`);
  }

  invariant(Array.isArray(manifest.capabilities) && manifest.capabilities.length > 0, "manifest.capabilities must not be empty");
  const capabilityIds = [];
  for (const capabilityValue of manifest.capabilities) {
    const capability = assertExactKeys(capabilityValue, ["id", "defaultEnabled", "componentIds"], "capability");
    const id = assertString(capability.id, "capability.id");
    invariant(ID_PATTERN.test(id), `invalid capability id ${id}`);
    const policy = contracts.capabilitiesById.get(id);
    invariant(policy, `manifest contains unknown capability ${id}`);
    capabilityIds.push(id);
    assertBoolean(capability.defaultEnabled, `${id}.defaultEnabled`);
    invariant(capability.defaultEnabled === policy.defaultEnabled, `${id}: defaultEnabled does not match capability policy`);
    invariant(Array.isArray(capability.componentIds) && capability.componentIds.length > 0, `${id}.componentIds must not be empty`);
    assertUnique(capability.componentIds, `${id}.componentIds`);
    invariant(
      JSON.stringify(capability.componentIds) === JSON.stringify([...capability.componentIds].sort(bytewiseCompare)),
      `${id}.componentIds must be bytewise sorted`,
    );
    invariant(JSON.stringify(capability.componentIds) === JSON.stringify(policy.componentIds), `${id}: componentIds do not match capability policy`);
    for (const componentId of capability.componentIds) {
      invariant(componentIds.includes(componentId), `${id}: unknown component ${componentId}`);
    }
  }
  assertUnique(capabilityIds, "capability ids");
  invariant(
    JSON.stringify(capabilityIds) === JSON.stringify([...capabilityIds].sort(bytewiseCompare)),
    "manifest capabilities must be bytewise sorted by id",
  );
  invariant(capabilityIds.length === contracts.capabilitiesById.size, "manifest does not contain the complete capability policy");

  invariant(Array.isArray(manifest.files) && manifest.files.length > 0, "manifest.files must not be empty");
  const filePaths = [];
  const files = [];
  for (const fileValue of manifest.files) {
    const fileObject = assertObject(fileValue, "manifest file");
    invariant(["file", "symlink"].includes(fileObject.type), "manifest file type must be file or symlink");
    const file = fileObject.type === "symlink"
      ? assertExactKeys(fileObject, ["type", "path", "target", "sizeBytes"], "manifest symlink")
      : assertExactKeys(fileObject, ["type", "path", "sha256", "sizeBytes", "mode"], "manifest file");
    const filePath = assertSafeRelativePath(file.path, "manifest file path");
    filePaths.push(filePath);
    if (file.type === "symlink") {
      resolveSafeSymlinkTarget(file.target, filePath);
      invariant(file.sizeBytes === Buffer.byteLength(file.target, "utf8"), `${filePath}: symlink size must equal its UTF-8 target length`);
    } else {
      invariant(SHA256_PATTERN.test(file.sha256), `${filePath}: invalid SHA-256`);
      assertInteger(file.sizeBytes, `${filePath}.sizeBytes`);
      invariant(SAFE_FILE_MODES.has(file.mode), `${filePath}: unsafe mode ${file.mode}; only 0644 and 0755 are allowed`);
    }
    const owners = components.filter((component) => pathIsWithinRoot(filePath, component.path));
    invariant(owners.length === 1, `${filePath}: manifest file must have exactly one component owner; found ${owners.length}`);
    files.push(file);
  }
  assertUnique(filePaths, "manifest file paths");
  invariant(
    JSON.stringify(filePaths) === JSON.stringify([...filePaths].sort(bytewiseCompare)),
    "manifest files must be bytewise sorted by path",
  );
  const symlinkByPath = new Map(files.filter((file) => file.type === "symlink").map((file) => [file.path, file]));
  for (const link of symlinkByPath.values()) {
    const directTarget = resolveSafeSymlinkTarget(link.target, link.path);
    invariant(directTarget !== link.path, `${link.path}: symlink cannot target itself`);
    const resolvedTarget = resolveManifestPathThroughSymlinks(directTarget, symlinkByPath);
    const targetExists = files.some((file) => file.path === resolvedTarget || file.path.startsWith(`${resolvedTarget}/`));
    invariant(targetExists, `${link.path}: symlink target is not represented by the manifest`);
    const linkOwner = components.find((component) => pathIsWithinRoot(link.path, component.path));
    const targetOwner = components.find((component) => pathIsWithinRoot(resolvedTarget, component.path));
    invariant(targetOwner?.id === linkOwner?.id, `${link.path}: symlink target crosses component ownership`);
  }
  for (const component of components) {
    const summary = summarizeComponentFiles(component.path, files);
    invariant(component.sha256 === summary.sha256, `${component.id}: component SHA-256 does not match its file inventory`);
    invariant(component.sizeBytes === summary.sizeBytes, `${component.id}: component size does not match its file inventory`);
  }

  const signing = assertExactKeys(manifest.signing, ["manifestAlgorithm", "manifestKeyId", "codeSigning", "notarized"], "manifest.signing");
  invariant(signing.manifestAlgorithm === contracts.signingPolicy.manifestSigning.algorithm, "manifest signing algorithm does not match signing policy");
  const channelPolicy = contracts.signingPolicy.channelRequirements[manifest.releaseChannel];
  invariant(channelPolicy, `signing policy has no requirements for ${manifest.releaseChannel}`);
  const expectedKeyId = channelPolicy.manifestKey === "release"
    ? contracts.signingPolicy.manifestSigning.keyId
    : channelPolicy.manifestKey;
  invariant(signing.manifestKeyId === expectedKeyId, `manifest key id does not match ${manifest.releaseChannel} signing policy`);
  invariant(signing.codeSigning === channelPolicy.codeSigning, `manifest code signing does not match ${manifest.releaseChannel} signing policy`);
  assertBoolean(signing.notarized, "manifest.signing.notarized");
  invariant(signing.notarized === channelPolicy.notarized, `manifest notarization does not match ${manifest.releaseChannel} signing policy`);
  if (manifest.releaseChannel === "stable") {
    invariant(contracts.signingPolicy.stableReleaseStatus === "ready", "stable manifest promotion is blocked until signing credentials are provisioned");
  }
  return manifest;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export async function buildFileInventory(root) {
  const rootStat = await stat(root);
  invariant(rootStat.isDirectory(), `artifact root is not a directory: ${root}`);
  const files = [];

  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      assertSafeRelativePath(relativePath, "artifact file path");
      const absolutePath = path.join(directory, entry.name);
      const fileStat = await lstat(absolutePath);
      if (fileStat.isSymbolicLink()) {
        const target = await readlink(absolutePath);
        resolveSafeSymlinkTarget(target, relativePath);
        files.push({
          type: "symlink",
          path: relativePath,
          target,
          sizeBytes: Buffer.byteLength(target, "utf8"),
        });
        continue;
      }
      if (fileStat.isDirectory()) {
        await visit(absolutePath, relativePath);
        continue;
      }
      invariant(fileStat.isFile(), `artifact contains an unsupported file type: ${relativePath}`);
      const mode = (fileStat.mode & 0o7777).toString(8).padStart(4, "0");
      invariant(SAFE_FILE_MODES.has(mode), `${relativePath}: unsafe mode ${mode}; normalize artifact files to 0644 or 0755`);
      files.push({
        type: "file",
        path: relativePath,
        sha256: await sha256File(absolutePath),
        sizeBytes: fileStat.size,
        mode,
      });
    }
  }

  await visit(root);
  files.sort((left, right) => bytewiseCompare(left.path, right.path));
  const realRoot = await realpath(root);
  for (const file of files) {
    if (file.type !== "symlink") continue;
    const resolvedTarget = resolveSafeSymlinkTarget(file.target, file.path);
    let realTarget;
    try {
      realTarget = await realpath(path.join(root, resolvedTarget));
    } catch (error) {
      if (error?.code === "ELOOP") throw new Error(`${file.path}: symlink cycle detected`);
      throw new Error(`${file.path}: symlink target does not resolve inside the artifact`);
    }
    invariant(
      realTarget === realRoot || realTarget.startsWith(`${realRoot}${path.sep}`),
      `${file.path}: symlink target escapes the artifact root`,
    );
  }
  return files;
}

async function directorySize(root) {
  try {
    let total = 0;
    async function visit(directory) {
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        const absolutePath = path.join(directory, entry.name);
        const fileStat = await lstat(absolutePath);
        if (fileStat.isSymbolicLink()) continue;
        if (fileStat.isDirectory()) {
          await visit(absolutePath);
        } else if (fileStat.isFile()) {
          total += fileStat.size;
        }
      }
    }
    await visit(root);
    return total;
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function workspaceDependencyCounts(root) {
  const packageFiles = [path.join(root, "package.json")];
  for (const parent of ["apps", "packages"]) {
    const directory = path.join(root, parent);
    let entries = [];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) packageFiles.push(path.join(directory, entry.name, "package.json"));
    }
  }

  const direct = new Set();
  const runtime = new Set();
  const development = new Set();
  let readPackageFiles = 0;
  for (const packageFile of packageFiles) {
    let packageJson;
    try {
      packageJson = await loadJson(packageFile);
      readPackageFiles += 1;
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    for (const name of Object.keys(packageJson.dependencies ?? {})) {
      direct.add(name);
      runtime.add(name);
    }
    for (const name of Object.keys(packageJson.optionalDependencies ?? {})) {
      direct.add(name);
      runtime.add(name);
    }
    for (const name of Object.keys(packageJson.devDependencies ?? {})) {
      direct.add(name);
      development.add(name);
    }
  }
  return {
    packageFiles: readPackageFiles,
    uniqueDirect: direct.size,
    uniqueRuntimeDirect: runtime.size,
    uniqueDevelopmentDirect: development.size,
  };
}

async function pythonDependencyCounts(root) {
  const contents = await readFile(path.join(root, "workers", "automation", "pyproject.toml"), "utf8");
  const runtimeBlock = contents.match(/^dependencies\s*=\s*\[([\s\S]*?)^\]/m)?.[1] ?? "";
  const runtime = [...runtimeBlock.matchAll(/^\s*"([^"]+)"/gm)].map((match) => match[1]);
  const devLine = contents.match(/^dev\s*=\s*\[([^\]]*)\]/m)?.[1] ?? "";
  const development = [...devLine.matchAll(/"([^"]+)"/g)].map((match) => match[1]);
  return { runtimeDirect: runtime.length, developmentDirect: development.length };
}

async function lockRecordCounts(root) {
  const [pnpmLock, uvLock] = await Promise.all([
    readFile(path.join(root, "pnpm-lock.yaml"), "utf8"),
    readFile(path.join(root, "workers", "automation", "uv.lock"), "utf8"),
  ]);
  const packageSection = pnpmLock.match(/\npackages:\n([\s\S]*?)\nsnapshots:\n/)?.[1] ?? "";
  const pnpmPackageRecords = [...packageSection.matchAll(/^  [^\s].*:\s*$/gm)].length;
  const uvPackageRecords = [...uvLock.matchAll(/^\[\[package\]\]$/gm)].length;
  return { pnpmPackageRecords, uvPackageRecords };
}

export async function measureDistribution({ root = REPO_ROOT, artifact = null } = {}) {
  const [javascript, python, locks, nodeModulesBytes, pythonEnvironmentBytes] = await Promise.all([
    workspaceDependencyCounts(root),
    pythonDependencyCounts(root),
    lockRecordCounts(root),
    directorySize(path.join(root, "node_modules")),
    directorySize(path.join(root, "workers", "automation", ".venv")),
  ]);
  const report = {
    schemaVersion: 1,
    source: {
      javascript,
      python,
      locks,
      environmentPresence: {
        nodeModules: nodeModulesBytes === null ? "absent" : "present",
        pythonEnvironment: pythonEnvironmentBytes === null ? "absent" : "present",
      },
      logicalBytes: {
        nodeModules: nodeModulesBytes,
        pythonEnvironment: pythonEnvironmentBytes,
      },
    },
  };
  if (artifact) {
    const files = await buildFileInventory(artifact);
    report.artifact = {
      root: path.resolve(artifact),
      fileCount: files.length,
      logicalBytes: files.reduce((total, file) => total + file.sizeBytes, 0),
      files,
    };
  }
  return report;
}

export async function loadManifestValidationContracts(root = REPO_ROOT) {
  const { schema, inventory, platforms, capabilityPolicy, signingPolicy } = await loadDistributionContracts(root);
  const schemaValidator = compileManifestSchema(schema);
  const inventoryById = validateComponentInventory(inventory);
  const platformsById = validatePlatforms(platforms, inventoryById);
  const capabilitiesById = validateCapabilityPolicy(capabilityPolicy, inventoryById);
  const versions = await resolveInventoryVersions(inventory, root);
  validateSigningPolicy(signingPolicy);
  return { schema, schemaValidator, inventoryById, platformsById, capabilitiesById, versions, signingPolicy };
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "audit";
  if (command === "audit") {
    process.stdout.write(`${JSON.stringify(await auditDistributionContracts(), null, 2)}\n`);
    return;
  }
  if (command === "measure") {
    let artifact = null;
    let root = REPO_ROOT;
    for (let index = 1; index < argv.length; index += 1) {
      if (argv[index] === "--artifact") {
        artifact = argv[index + 1];
        invariant(artifact, "--artifact requires a directory");
      } else if (argv[index] === "--root") {
        root = path.resolve(argv[index + 1] ?? "");
        invariant(argv[index + 1], "--root requires a checkout directory");
      } else {
        throw new Error(`unknown measure option: ${argv[index]}`);
      }
      index += 1;
    }
    process.stdout.write(`${JSON.stringify(await measureDistribution({ root, artifact }), null, 2)}\n`);
    return;
  }
  throw new Error(`unknown distribution command: ${command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    process.stderr.write(`distribution: ${error.message}\n`);
    process.exitCode = 1;
  });
}
