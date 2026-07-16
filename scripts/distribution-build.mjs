#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { Readable } from "node:stream";
import { finished, pipeline } from "node:stream/promises";
import { createDeflateRaw, createGzip } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  REPO_ROOT,
  assertSafeRelativePath,
  buildFileInventory,
  loadManifestValidationContracts,
  summarizeComponentFiles,
  validateDistributionManifest,
} from "./distribution-manifest.mjs";
import {
  assertSymlinksPreserved,
  extractVerifiedArchive,
  sha256File,
  verifyLockedArchive,
} from "./distribution-archive.mjs";
import { writeLocalReleaseBundle } from "./distribution-release.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DISTRIBUTION_DIR = path.join(REPO_ROOT, "packaging", "distribution");
const ENVELOPE_FILES = new Set(["manifest.json", "manifest.sig"]);
const RELEASE_CHANNELS = new Set(["local", "prerelease", "stable"]);
const ZIP_UINT32_MAX = 0xffffffff;
const ZIP_EPOCH_FLOOR = 315532800;
const GO_TOOLCHAIN_VERSION = "go1.26.4";
const GO_TOOLCHAIN_LICENSE_SHA256 = "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad";
const GO_TOOLCHAIN_ARCHIVE_URL = "https://go.dev/dl/go1.26.4.darwin-arm64.tar.gz";
const GO_TOOLCHAIN_ARCHIVE_SHA256 = "b62ad2b6d7d2464f12a5bcad7ff47f19d08325773b5efd21610e445a05a9bf53";
const GO_TOOLCHAIN_ARCHIVE_SIZE_BYTES = 64723756;
const GO_TOOLCHAIN_OFFICIAL_METADATA_URL = "https://go.dev/dl/?mode=json&include=all";
const SAFE_MODES = new Set(["0644", "0755"]);
const FORBIDDEN_PROVIDER_PATTERNS = [
  /(^|[/_.-])claude[-_]agent[-_]sdk([/_.-]|$)/i,
  /(^|[/_.-])openai[-_]codex([/_.-]|$)/i,
  /(^|[/_.-])openai[-_]codex[-_]cli[-_]bin([/_.-]|$)/i,
  /(^|[/_.-])google[-_]antigravity([/_.-]|$)/i,
];
const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".github",
  ".bin",
  ".pnpm",
  ".playwright-mcp",
  ".pytest_cache",
  ".ruff_cache",
  "__pycache__",
  "coverage",
  "docs",
  "e2e",
  "storybook-static",
  "spikes",
  "test",
  "tests",
]);
const FORBIDDEN_TOOL_NAMES = new Set([
  "corepack",
  "git",
  "go",
  "npm",
  "npx",
  "pip",
  "pip3",
  "pnpm",
  "pytest",
  "ruff",
  "storybook",
  "2to3",
  "tsc",
  "tsx",
  "uv",
  "vite",
  "vitest",
]);
const FORBIDDEN_TOOL_INVOCATION_NEEDLES = [
  "node_modules/.bin/",
  "/bin/corepack",
  "/bin/npm",
  "/bin/npx",
  "/bin/pip",
  "/bin/pip3",
  "/bin/pnpm",
  "/bin/uv",
];
const FORBIDDEN_BROWSER_REDISTRIBUTION_NEEDLES = ["WidevineCdm", "libwidevinecdm"];
const FORBIDDEN_PLAYWRIGHT_MCP_RUNTIME_PATHS = [
  "playwright-mcp/node_modules/playwright",
  "playwright-mcp/node_modules/playwright-core/lib/vite",
  "playwright-mcp/node_modules/playwright-core/lib/tools/cli-client/skill",
  "playwright-mcp/node_modules/playwright-core/lib/tools/trace/SKILL.md",
  "playwright-mcp/node_modules/@playwright/mcp/README.md",
  "playwright-mcp/node_modules/playwright-core/README.md",
  "playwright-mcp/node_modules/playwright-core/bin",
];
const TEMPORAL_BRIDGE_BUILD_SOURCE_PATHS = [
  "temporalio/bridge/sdk-core",
  "temporalio/bridge/src",
  "temporalio/bridge/Cargo.toml",
  "temporalio/bridge/Cargo.lock",
];
const PYTHON_RUNTIME_NON_RUNTIME_PATHS = new Set([
  "email/architecture.rst",
  "google/protobuf/testdata",
  "numpy/ma/README.rst",
  "numpy/random/_examples",
  "opentelemetry/sdk/_configuration/README.md",
  "opentelemetry/sdk/metrics/_internal/exponential_histogram/mapping/ieee_754.md",
  "playwright/driver/README.md",
  "playwright/driver/package/README.md",
]);

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

function bytewiseCompare(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalPackageName(value) {
  return value.toLowerCase().replace(/[_.]+/g, "-");
}

function canonicalJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function isTemporalBridgeBuildSourcePath(relativePath) {
  return TEMPORAL_BRIDGE_BUILD_SOURCE_PATHS.some((sourcePath) => relativePath === sourcePath || relativePath.startsWith(`${sourcePath}/`));
}

function isKnownPythonNonRuntimePath(relativePath) {
  return [...PYTHON_RUNTIME_NON_RUNTIME_PATHS].some(
    (nonRuntimePath) => relativePath === nonRuntimePath || relativePath.startsWith(`${nonRuntimePath}/`),
  ) || /^temporalio\/contrib\/.+\/README\.md$/.test(relativePath);
}

function pythonRuntimeRelativePath(payloadPath) {
  return payloadPath
    .replace(/^(?:worker|playwright-python)\/site-packages\//, "")
    .replace(/^python\/lib\/python3\.12\//, "");
}

function isGitMetadataBasename(basename) {
  return basename.toLowerCase().startsWith(".git");
}

function isAllowedRuntimeDocumentationPath(relativePath) {
  const lowerPath = relativePath.toLowerCase();
  const segments = lowerPath.split("/");
  const basename = path.posix.basename(lowerPath);
  return lowerPath.startsWith("release/licenses/")
    || segments.includes("licenses")
    || basename === "license.md"
    || lowerPath.endsWith("numpy/random/license.md")
    || /(?:^|\/)publicsuffix[^/]*\.dist-info\/authors\.rst$/.test(lowerPath);
}

async function writeJson(filePath, value, mode = 0o644) {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  await writeFile(filePath, canonicalJson(value), { mode });
  await chmod(filePath, mode);
}

async function exists(filePath) {
  try {
    await lstat(filePath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function requireFile(filePath, label) {
  let fileStat;
  try {
    fileStat = await lstat(filePath);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  }
  invariant(fileStat.isFile() && !fileStat.isSymbolicLink(), `${label} must be a regular file: ${filePath}`);
  return filePath;
}

async function requireDirectory(directory, label) {
  let directoryStat;
  try {
    directoryStat = await stat(directory);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${directory}`);
    throw error;
  }
  invariant(directoryStat.isDirectory(), `${label} must be a directory: ${directory}`);
  return directory;
}

async function requireResolvedFileWithin(filePath, root, label) {
  const resolved = await realpath(filePath).catch((error) => {
    if (error?.code === "ENOENT") throw new Error(`${label} is missing: ${filePath}`);
    throw error;
  });
  const resolvedRoot = await realpath(root);
  invariant(resolved === resolvedRoot || resolved.startsWith(`${resolvedRoot}${path.sep}`), `${label} resolves outside its component root`);
  invariant((await stat(resolved)).isFile(), `${label} must resolve to a regular file`);
  return filePath;
}

export function validatePayloadLayout(layout, contracts, platformId = "darwin-arm64") {
  invariant(layout?.schemaVersion === 1, "payload layout schemaVersion must be 1");
  invariant(layout.platform === platformId, `payload layout targets ${layout.platform}, not ${platformId}`);
  invariant(Array.isArray(layout.components), "payload layout components must be an array");
  const platform = contracts.platformsById.get(platformId);
  invariant(platform, `unknown payload platform ${platformId}`);
  const ids = layout.components.map((component) => component.id);
  invariant(new Set(ids).size === ids.length, "payload layout component ids must be unique");
  const paths = layout.components.map((component) => assertSafeRelativePath(component.path, `${component.id}.path`));
  invariant(new Set(paths).size === paths.length, "payload layout component paths must be unique");
  for (let left = 0; left < paths.length; left += 1) {
    for (let right = left + 1; right < paths.length; right += 1) {
      invariant(
        !paths[left].startsWith(`${paths[right]}/`) && !paths[right].startsWith(`${paths[left]}/`),
        `payload layout component roots overlap: ${paths[left]} and ${paths[right]}`,
      );
    }
  }
  const expected = [...platform.requiredComponents].sort(bytewiseCompare);
  invariant(JSON.stringify([...ids].sort(bytewiseCompare)) === JSON.stringify(expected), "payload layout must contain the exact platform core closure");
  invariant(layout.standardInputs && typeof layout.standardInputs === "object", "payload layout standardInputs are missing");
  invariant(
    JSON.stringify(layout.envelopeExclusions) === JSON.stringify([...ENVELOPE_FILES].sort(bytewiseCompare)),
    "payload layout envelope exclusions must be exactly manifest.json and manifest.sig",
  );
  return new Map(layout.components.map((component) => [component.id, component.path]));
}

export function validateEmbeddedComponentLayout(layout, contracts) {
  invariant(Array.isArray(layout.embeddedComponents), "payload layout embeddedComponents must be an array");
  const expected = [...contracts.inventoryById.values()]
    .filter((component) => component.redistribution === "bundle" && component.embeddedIn !== undefined)
    .map((component) => component.id)
    .sort(bytewiseCompare);
  const actual = layout.embeddedComponents.map((component) => component.id).sort(bytewiseCompare);
  invariant(JSON.stringify(actual) === JSON.stringify(expected), "payload layout must size-account for the exact embedded component closure");
  const specs = new Map();
  for (const component of layout.embeddedComponents) {
    invariant(
      JSON.stringify(Object.keys(component).sort(bytewiseCompare))
        === JSON.stringify(["id", "includedIn", ...(component.paths === undefined ? [] : ["paths"]), ...(component.prefixes === undefined ? [] : ["prefixes"])].sort(bytewiseCompare)),
      `${component.id}: embedded size contract has unknown fields`,
    );
    const inventory = contracts.inventoryById.get(component.id);
    invariant(inventory?.embeddedIn === component.includedIn, `${component.id}: embedded size parent does not match component inventory`);
    const paths = component.paths ?? [];
    const prefixes = component.prefixes ?? [];
    invariant(Array.isArray(paths) && Array.isArray(prefixes) && paths.length + prefixes.length > 0, `${component.id}: embedded size contract has no selectors`);
    for (const selectedPath of [...paths, ...prefixes]) assertSafeRelativePath(selectedPath, `${component.id}: embedded size selector`);
    invariant(new Set([...paths, ...prefixes]).size === paths.length + prefixes.length, `${component.id}: embedded size selectors must be unique`);
    specs.set(component.id, { id: component.id, includedIn: component.includedIn, paths, prefixes });
  }
  return specs;
}

export function validateSharedComponentLayout(layout, contracts) {
  invariant(Array.isArray(layout.sharedComponentFiles), "payload layout sharedComponentFiles must be an array");
  const specs = new Map();
  for (const component of layout.sharedComponentFiles) {
    invariant(!specs.has(component.id), `${component.id}: shared size contract is duplicated`);
    invariant(
      JSON.stringify(Object.keys(component).sort(bytewiseCompare))
        === JSON.stringify(["id", "includedIn", ...(component.paths === undefined ? [] : ["paths"]), ...(component.prefixes === undefined ? [] : ["prefixes"])].sort(bytewiseCompare)),
      `${component.id}: shared size contract has unknown fields`,
    );
    const inventory = contracts.inventoryById.get(component.id);
    const parent = contracts.inventoryById.get(component.includedIn);
    invariant(inventory?.redistribution === "bundle" && inventory.embeddedIn === undefined, `${component.id}: shared size component must be a top-level bundled component`);
    invariant(parent?.redistribution === "bundle" && parent.embeddedIn === undefined, `${component.id}: shared size parent must be a top-level bundled component`);
    const paths = component.paths ?? [];
    const prefixes = component.prefixes ?? [];
    invariant(Array.isArray(paths) && Array.isArray(prefixes) && paths.length + prefixes.length > 0, `${component.id}: shared size contract has no selectors`);
    for (const selectedPath of [...paths, ...prefixes]) assertSafeRelativePath(selectedPath, `${component.id}: shared size selector`);
    specs.set(component.id, { id: component.id, includedIn: component.includedIn, paths, prefixes });
  }
  return specs;
}

export async function loadNativeLauncherToolchain(root = REPO_ROOT) {
  const toolchain = JSON.parse(await readFile(path.join(root, "launcher", "toolchain.json"), "utf8"));
  invariant(
    JSON.stringify(Object.keys(toolchain).sort(bytewiseCompare)) === JSON.stringify(["archive", "goVersion", "license", "licenseSha256", "licenseSource", "moduleClosure", "schemaVersion"]),
    "native launcher toolchain contract has unknown fields",
  );
  invariant(toolchain.archive && typeof toolchain.archive === "object", "native launcher toolchain archive is missing");
  invariant(
    JSON.stringify(Object.keys(toolchain.archive).sort(bytewiseCompare)) === JSON.stringify(["officialMetadataUrl", "sha256", "sizeBytes", "type", "url"]),
    "native launcher toolchain archive has unknown fields",
  );
  invariant(
    toolchain.schemaVersion === 1
      && toolchain.goVersion === GO_TOOLCHAIN_VERSION
      && toolchain.moduleClosure === "standard-library-only"
      && toolchain.license === "BSD-3-Clause"
      && toolchain.licenseSource === "https://go.dev/LICENSE"
      && toolchain.licenseSha256 === GO_TOOLCHAIN_LICENSE_SHA256
      && toolchain.archive.type === "tar.gz"
      && toolchain.archive.url === GO_TOOLCHAIN_ARCHIVE_URL
      && toolchain.archive.sha256 === GO_TOOLCHAIN_ARCHIVE_SHA256
      && toolchain.archive.sizeBytes === GO_TOOLCHAIN_ARCHIVE_SIZE_BYTES
      && toolchain.archive.officialMetadataUrl === GO_TOOLCHAIN_OFFICIAL_METADATA_URL,
    "native launcher toolchain contract is invalid",
  );
  invariant(await sha256File(path.join(root, "launcher", "GO-LICENSE")) === toolchain.licenseSha256, "native launcher Go license does not match the pinned Go toolchain license");
  return toolchain;
}

function nativeGoArchiveLock(toolchain) {
  return {
    id: "go-toolchain-darwin-arm64",
    componentId: "jobctrl-launcher",
    version: toolchain.goVersion,
    archiveType: toolchain.archive.type,
    url: toolchain.archive.url,
    sha256: toolchain.archive.sha256,
    sizeBytes: toolchain.archive.sizeBytes,
  };
}

export async function loadBuildContracts(root = REPO_ROOT, { signingPolicyOverride = null } = {}) {
  const [contracts, layout, locks, providerPackLocks, licenseEvidenceLocks, nodeLicenseEvidenceLocks, launcherToolchain] = await Promise.all([
    loadManifestValidationContracts(root),
    readFile(path.join(root, "packaging", "distribution", "payload-layout.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "packaging", "distribution", "components.lock.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "packaging", "distribution", "provider-packs.lock.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "packaging", "distribution", "license-evidence.lock.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "packaging", "distribution", "node-license-evidence.lock.json"), "utf8").then(JSON.parse),
    loadNativeLauncherToolchain(root),
  ]);
  const componentPaths = validatePayloadLayout(layout, contracts, locks.platform);
  const embeddedComponentSpecs = validateEmbeddedComponentLayout(layout, contracts);
  const sharedComponentSpecs = validateSharedComponentLayout(layout, contracts);
  invariant(licenseEvidenceLocks.schemaVersion === 1 && Array.isArray(licenseEvidenceLocks.inputs), "license evidence lock is invalid");
  invariant(nodeLicenseEvidenceLocks.schemaVersion === 1 && Array.isArray(nodeLicenseEvidenceLocks.inputs), "Node license evidence lock is invalid");
  return {
    ...contracts,
    // `signing-policy.json` is intentionally tracked in a blocked state. A
    // protected P6 runner may supply an in-memory provisioned policy after it
    // has checked its protected secrets; it never alters the checkout.
    signingPolicy: signingPolicyOverride ?? contracts.signingPolicy,
    layout,
    locks,
    providerPackLocks,
    licenseEvidenceLocks,
    nodeLicenseEvidenceLocks,
    launcherToolchain,
    componentPaths,
    embeddedComponentSpecs,
    sharedComponentSpecs,
    platform: contracts.platformsById.get(locks.platform),
  };
}

async function copyTree(source, destination, { exclude = () => false } = {}) {
  const sourceRoot = await realpath(source);
  await mkdir(destination, { recursive: true, mode: 0o755 });
  async function visit(sourceDirectory, destinationDirectory, relativeDirectory = "") {
    const entries = await readdir(sourceDirectory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      assertSafeRelativePath(relativePath, "copied input path");
      if (exclude(relativePath, entry)) continue;
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      const entryStat = await lstat(sourcePath);
      if (entryStat.isDirectory()) {
        await mkdir(destinationPath, { recursive: true, mode: 0o755 });
        await visit(sourcePath, destinationPath, relativePath);
      } else if (entryStat.isSymbolicLink()) {
        const target = await readlink(sourcePath);
        invariant(!path.isAbsolute(target), `${relativePath}: absolute input symlink is forbidden`);
        const resolved = await realpath(path.resolve(path.dirname(sourcePath), target));
        invariant(resolved === sourceRoot || resolved.startsWith(`${sourceRoot}${path.sep}`), `${relativePath}: input symlink escapes its source tree`);
        await symlink(target, destinationPath);
      } else {
        invariant(entryStat.isFile(), `${relativePath}: unsupported input file type`);
        const mode = (entryStat.mode & 0o111) === 0 ? 0o644 : 0o755;
        await copyFile(sourcePath, destinationPath);
        await chmod(destinationPath, mode);
      }
    }
  }
  await visit(source, destination);
}

async function run(command, args, { cwd = REPO_ROOT, env = process.env, stdin = null } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, stdio: [stdin === null ? "ignore" : "pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`));
    });
    if (stdin !== null) child.stdin.end(stdin);
  });
}

async function downloadLockedArchive(lock, cacheDirectory) {
  await mkdir(cacheDirectory, { recursive: true, mode: 0o755 });
  const suffix = lock.archiveType === "zip" ? ".zip" : ".tar.gz";
  const cached = path.join(cacheDirectory, `${lock.id}-${lock.sha256}${suffix}`);
  if (await exists(cached)) {
    await verifyLockedArchive(cached, lock);
    if (lock.sizeBytes !== undefined) invariant((await stat(cached)).size === lock.sizeBytes, `${lock.id}: archive size mismatch`);
    return cached;
  }
  const partial = `${cached}.partial-${process.pid}`;
  await rm(partial, { force: true });
  const response = await fetch(lock.url, { redirect: "follow" });
  invariant(response.ok && response.body, `${lock.id}: download failed with HTTP ${response.status}`);
  try {
    await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o644, flags: "wx" }));
    await verifyLockedArchive(partial, lock);
    if (lock.sizeBytes !== undefined) invariant((await stat(partial)).size === lock.sizeBytes, `${lock.id}: archive size mismatch`);
    await rename(partial, cached);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
  return cached;
}

async function downloadLockedLicenseEvidence(lock, cacheDirectory) {
  invariant(/^https:\/\//.test(lock.url) && /^[a-f0-9]{64}$/.test(lock.sha256), `${lock.package}: invalid license evidence lock`);
  await mkdir(cacheDirectory, { recursive: true, mode: 0o755 });
  const cached = path.join(cacheDirectory, `license-${lock.sha256}.evidence`);
  if (!(await exists(cached))) {
    const partial = `${cached}.partial-${process.pid}`;
    const response = await fetch(lock.url, { redirect: "follow" });
    invariant(response.ok && response.body, `${lock.package}: license evidence download failed with HTTP ${response.status}`);
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(partial, { mode: 0o644, flags: "wx" }));
      invariant((await sha256File(partial)) === lock.sha256, `${lock.package}: license evidence SHA-256 mismatch`);
      invariant((await stat(partial)).size === lock.sizeBytes, `${lock.package}: license evidence size mismatch`);
      await rename(partial, cached);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    }
  }
  invariant((await sha256File(cached)) === lock.sha256, `${lock.package}: cached license evidence SHA-256 mismatch`);
  invariant((await stat(cached)).size === lock.sizeBytes, `${lock.package}: cached license evidence size mismatch`);
  return cached;
}

function componentRoot(payloadRoot, contracts, componentId) {
  const relativePath = contracts.componentPaths.get(componentId);
  invariant(relativePath, `payload layout has no component root for ${componentId}`);
  return path.join(payloadRoot, relativePath);
}

async function writeFixtureComponents(payloadRoot, contracts) {
  for (const [componentId, relativeRoot] of contracts.componentPaths) {
    const root = path.join(payloadRoot, relativeRoot);
    await mkdir(root, { recursive: true, mode: 0o755 });
    if (componentId === "jobctrl-launcher") {
      for (const name of ["jobctrl", "jobctrl-installer"]) {
        await writeFile(path.join(root, name), `#!/bin/sh\necho fixture:${name}:${contracts.versions[componentId]}\n`, { mode: 0o755 });
        await chmod(path.join(root, name), 0o755);
      }
      continue;
    }
    const executable = ["jobctrl-launcher", "node-runtime", "python-runtime", "temporal-runtime", "playwright-mcp"].includes(componentId);
    const filename = executable ? "bin" : "payload";
    await writeFile(path.join(root, filename), `fixture:${componentId}:${contracts.versions[componentId]}\n`, { mode: executable ? 0o755 : 0o644 });
    await chmod(path.join(root, filename), executable ? 0o755 : 0o644);
  }
}

function shouldExcludeSourcePath(relativePath) {
  const segments = relativePath.split("/");
  return segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))
    || segments.some((segment) => segment === ".DS_Store" || segment.endsWith(".pyc"))
    || relativePath.includes("node_modules/.cache/");
}

async function prunePlaywrightDevelopmentMetadata(root) {
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (isGitMetadataBasename(entry.name)) await rm(entryPath, { recursive: true, force: true });
      else if (entry.isDirectory()) await visit(entryPath);
      else if (entry.name.endsWith(".d.ts") || entry.name === "api.json") await rm(entryPath, { force: true });
    }
  }
  await visit(root);
}

async function prunePlaywrightMcpRuntime(mcpRoot) {
  for (const relativePath of FORBIDDEN_PLAYWRIGHT_MCP_RUNTIME_PATHS) {
    const source = relativePath.replace(/^playwright-mcp\//, "");
    await rm(path.join(mcpRoot, ...source.split("/")), { recursive: true, force: true });
  }
  const forbidden = FORBIDDEN_PLAYWRIGHT_MCP_RUNTIME_PATHS.map((relativePath) => relativePath.replace(/^playwright-mcp\//, ""));
  const markdown = (await buildFileInventory(mcpRoot))
    .filter((file) => file.type === "file" && file.path.toLowerCase().endsWith(".md"));
  for (const file of markdown) await rm(path.join(mcpRoot, ...file.path.split("/")), { force: true });
  const inventory = await buildFileInventory(mcpRoot);
  for (const file of inventory) {
    invariant(
      !forbidden.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`)),
      `${file.path}: Playwright MCP development closure survived pruning`,
    );
    invariant(!file.path.toLowerCase().endsWith(".md"), `${file.path}: Playwright MCP documentation survived pruning`);
  }
}

async function pruneTlsClientForDarwinArm64(workerSite) {
  const dependencies = path.join(workerSite, "tls_client", "dependencies");
  const retained = new Set(["__init__.py", "tls-client-arm64.dylib"]);
  for (const entry of await readdir(dependencies)) {
    if (!retained.has(entry)) await rm(path.join(dependencies, entry), { recursive: true, force: true });
  }
  const actual = (await readdir(dependencies)).sort(bytewiseCompare);
  invariant(
    JSON.stringify(actual) === JSON.stringify([...retained].sort(bytewiseCompare)),
    `tls-client target prune produced an unexpected dependency closure: ${actual.join(", ")}`,
  );
}

export async function pruneUnusedPythonRuntime(pythonRoot) {
  const libraryRoot = path.join(pythonRoot, "lib");
  const dynamicModules = path.join(libraryRoot, "python3.12", "lib-dynload");
  const removedPaths = [];
  for (const entry of await readdir(libraryRoot, { withFileTypes: true })) {
    if (
      (entry.isDirectory() && /^(?:tcl|tk|itcl|thread)[0-9]/.test(entry.name))
      || (entry.isFile() && /^lib(?:tcl|tk)[0-9].*\.dylib$/.test(entry.name))
    ) {
      await rm(path.join(libraryRoot, entry.name), { recursive: true, force: true });
      removedPaths.push(path.posix.join("lib", entry.name));
    }
  }
  for (const entry of await readdir(dynamicModules, { withFileTypes: true })) {
    if (entry.isFile() && /^_tkinter\..*\.so$/.test(entry.name)) {
      await rm(path.join(dynamicModules, entry.name), { force: true });
      removedPaths.push(path.posix.join("lib", "python3.12", "lib-dynload", entry.name));
    }
  }
  const standardLibraryRoot = path.join(libraryRoot, "python3.12");
  for (const directory of ["idlelib", "tkinter", "turtledemo"]) {
    const optionalGuiRoot = path.join(standardLibraryRoot, directory);
    if (await exists(optionalGuiRoot)) {
      await rm(optionalGuiRoot, { recursive: true, force: true });
      removedPaths.push(path.posix.join("lib", "python3.12", directory));
    }
  }
  const turtlePath = path.join(standardLibraryRoot, "turtle.py");
  if (await exists(turtlePath)) {
    await rm(turtlePath, { force: true });
    removedPaths.push(path.posix.join("lib", "python3.12", "turtle.py"));
  }
  removedPaths.sort(bytewiseCompare);
  invariant(removedPaths.length >= 8, `unused Tcl/Tk closure was incomplete: ${removedPaths.join(", ")}`);
  return { id: "python-tcl-tk-unused", status: "pruned", removedPaths };
}

function pythonRecordPath(line) {
  if (line.startsWith('"')) {
    let value = "";
    for (let index = 1; index < line.length; index += 1) {
      if (line[index] !== '"') {
        value += line[index];
        continue;
      }
      if (line[index + 1] === '"') {
        value += '"';
        index += 1;
        continue;
      }
      invariant(line[index + 1] === ",", "invalid Python RECORD quoted path");
      return value;
    }
    throw new Error("unterminated Python RECORD quoted path");
  }
  const separator = line.indexOf(",");
  invariant(separator > 0, "invalid Python RECORD row");
  return line.slice(0, separator);
}

export async function normalizeInstalledPythonMetadata(sitePackagesRoots) {
  for (const sitePackages of sitePackagesRoots) {
    const distInfoDirectories = (await readdir(sitePackages, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(".dist-info"))
      .sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const distInfo of distInfoDirectories) {
      const distInfoRoot = path.join(sitePackages, distInfo.name);
      await rm(path.join(distInfoRoot, "uv_cache.json"), { force: true });
      const recordPath = path.join(distInfoRoot, "RECORD");
      if (!(await exists(recordPath))) continue;
      const rows = (await readFile(recordPath, "utf8")).split(/\r?\n/).filter(Boolean);
      const canonicalRows = rows.filter((row) => {
        const installedPath = pythonRecordPath(row);
        return !installedPath.startsWith("bin/")
          && !installedPath.endsWith("/direct_url.json")
          && !installedPath.endsWith("/uv_cache.json");
      });
      await writeFile(recordPath, `${canonicalRows.join("\n")}\n`, { mode: 0o644 });
      await chmod(recordPath, 0o644);
    }
  }
}

export async function writePlaywrightRevisionMarkers(revisionRoot) {
  for (const marker of ["DEPENDENCIES_VALIDATED", "INSTALLATION_COMPLETE"]) {
    await writeFile(path.join(revisionRoot, marker), "", { mode: 0o644 });
    await chmod(path.join(revisionRoot, marker), 0o644);
  }
}

async function prepareApiInputs(root, standardInputs, externalInputs) {
  const apiOutput = path.join(root, "dist", "api");
  await rm(apiOutput, { recursive: true, force: true });
  await mkdir(apiOutput, { recursive: true, mode: 0o755 });
  await run("corepack", [
    "pnpm", "exec", "esbuild", "apps/api/src/production.ts",
    "--bundle",
    "--platform=node",
    "--format=esm",
    "--target=node22",
    "--external:better-sqlite3",
    "--banner:js=import { createRequire as __jobctrlCreateRequire } from 'node:module'; const require = __jobctrlCreateRequire(import.meta.url);",
    `--outfile=${standardInputs.apiBundle}`,
    `--metafile=${path.join(apiOutput, "metafile.json")}`,
    "--log-level=warning",
  ], { cwd: root, env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "0" } });

  const nativeRuntime = path.join(root, standardInputs.apiNativeRuntime);
  await rm(path.join(nativeRuntime, "node_modules"), { recursive: true, force: true });
  await run("corepack", [
    "pnpm", "--dir", nativeRuntime, "install", "--frozen-lockfile", "--prod", "--ignore-workspace", "--ignore-scripts",
  ], {
    cwd: root,
    env: {
      ...process.env,
      CI: "true",
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1",
    },
  });
  const nativeNodeModules = path.join(root, standardInputs.apiNativeModules, "node_modules");
  await mkdir(nativeNodeModules, { recursive: true, mode: 0o755 });
  const runtimeAllowlist = {
    "better-sqlite3": ["LICENSE", "package.json", "lib", "build"],
    bindings: ["LICENSE.md", "bindings.js", "package.json"],
    "file-uri-to-path": ["LICENSE", "index.js", "package.json"],
  };
  let betterSqliteSource = await realpath(path.join(nativeRuntime, "node_modules", "better-sqlite3"));
  const packageSources = new Map([["better-sqlite3", betterSqliteSource]]);
  const bindingsSource = await realpath(path.join(path.dirname(betterSqliteSource), "bindings"));
  packageSources.set("bindings", bindingsSource);
  packageSources.set("file-uri-to-path", await realpath(path.join(path.dirname(bindingsSource), "file-uri-to-path")));
  for (const packageName of ["better-sqlite3", "bindings", "file-uri-to-path"]) {
    const source = packageSources.get(packageName);
    const allowed = runtimeAllowlist[packageName];
    await copyTree(source, path.join(nativeNodeModules, packageName), {
      exclude: (relativePath) => shouldExcludeSourcePath(relativePath)
        || !allowed.some((prefix) => relativePath === prefix || relativePath.startsWith(`${prefix}/`)),
    });
  }
  const nativeDestination = path.join(nativeNodeModules, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  await mkdir(path.dirname(nativeDestination), { recursive: true, mode: 0o755 });
  await copyFile(path.join(externalInputs.betterSqlitePrebuildRoot, "build", "Release", "better_sqlite3.node"), nativeDestination);
  await chmod(nativeDestination, 0o755);
  await requireFile(path.join(root, standardInputs.apiBundle), "production API bundle");
  await requireFile(path.join(apiOutput, "metafile.json"), "production API esbuild metafile");
  const nativeModule = path.join(nativeNodeModules, "better-sqlite3", "build", "Release", "better_sqlite3.node");
  await requireFile(nativeModule, "better-sqlite3 native module");
}

export function webContributionBuildInvocation() {
  return {
    command: "corepack",
    args: ["pnpm", "--filter", "@jobctrl/web", "exec", "vite", "build", "--sourcemap", "hidden"],
  };
}

async function prepareWebInputs(root, standardInputs) {
  const invocation = webContributionBuildInvocation();
  await run(invocation.command, invocation.args, {
    cwd: root,
    env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "0" },
  });
  await requireDirectory(path.join(root, standardInputs.webAssets), "production web assets");
  await requireFile(path.join(root, standardInputs.webAssets, "index.html"), "production web index");
}

async function prepareStandardProductionInputs(root, contracts, externalInputs) {
  await Promise.all([
    prepareApiInputs(root, contracts.layout.standardInputs, externalInputs),
    prepareWebInputs(root, contracts.layout.standardInputs),
  ]);
}

async function copyPreparedApplicationInputs(payloadRoot, root, contracts) {
  const inputs = contracts.layout.standardInputs;
  const apiRoot = componentRoot(payloadRoot, contracts, "jobctrl-api");
  await mkdir(apiRoot, { recursive: true, mode: 0o755 });
  await copyFile(path.join(root, inputs.apiBundle), path.join(apiRoot, "server.mjs"));
  await chmod(path.join(apiRoot, "server.mjs"), 0o644);
  await copyTree(
    path.join(root, inputs.apiNativeModules, "node_modules"),
    path.join(apiRoot, "node_modules"),
    { exclude: shouldExcludeSourcePath },
  );
  const webSource = path.join(root, inputs.webAssets);
  const webPayload = componentRoot(payloadRoot, contracts, "jobctrl-web");
  const excludeWebBuildInput = (relativePath) => shouldExcludeSourcePath(relativePath)
    || relativePath.endsWith(".map")
    || path.posix.basename(relativePath) === "mockServiceWorker.js"
    || relativePath.includes("spikes.table-filters");
  await copyTree(webSource, webPayload, { exclude: excludeWebBuildInput });
  await assertCopiedWebRuntimeBytes(webSource, webPayload, excludeWebBuildInput);
}

async function assertCopiedWebRuntimeBytes(sourceRoot, payloadRoot, exclude) {
  const source = (await buildFileInventory(sourceRoot))
    .filter((file) => !exclude(file.path))
    .map((file) => ({ path: file.path, type: file.type, mode: file.mode, sizeBytes: file.sizeBytes, sha256: file.sha256, target: file.target ?? null }));
  const payload = (await buildFileInventory(payloadRoot))
    .map((file) => ({ path: file.path, type: file.type, mode: file.mode, sizeBytes: file.sizeBytes, sha256: file.sha256, target: file.target ?? null }));
  invariant(
    JSON.stringify(payload) === JSON.stringify(source),
    "web payload runtime bytes differ from the prepared production build outside the explicit packaging exclusions",
  );
  return { status: "exact-runtime-byte-copy", fileCount: payload.length };
}

async function assembleExternalRuntimes(payloadRoot, contracts, cacheDirectory, scratchDirectory) {
  const lockById = new Map(contracts.locks.inputs.map((lock) => [lock.id, lock]));
  const archiveById = new Map();
  for (const lock of contracts.locks.inputs) archiveById.set(lock.id, await downloadLockedArchive(lock, cacheDirectory));

  const betterSqlitePrebuildRoot = path.join(scratchDirectory, "better-sqlite3-node22");
  await extractVerifiedArchive({
    archivePath: archiveById.get("better-sqlite3-node22-prebuild"),
    lock: lockById.get("better-sqlite3-node22-prebuild"),
    destination: betterSqlitePrebuildRoot,
    stripComponents: 0,
    include: (entryPath, entry) => entry.type === "file" && entryPath === "build/Release/better_sqlite3.node",
  });

  const extractedNode = path.join(scratchDirectory, "node");
  const nodeEntries = await extractVerifiedArchive({
    archivePath: archiveById.get("node-runtime-archive"),
    lock: lockById.get("node-runtime-archive"),
    destination: extractedNode,
    stripComponents: 1,
    include: (entryPath, entry) => entry.type === "file"
      && (entryPath === "bin/node" || /^(LICENSE|LICENSE\.md|LICENSE\.txt)$/.test(entryPath)),
  });
  await assertSymlinksPreserved(extractedNode, nodeEntries);
  const nodeRoot = componentRoot(payloadRoot, contracts, "node-runtime");
  await mkdir(path.join(nodeRoot, "bin"), { recursive: true, mode: 0o755 });
  await copyFile(path.join(extractedNode, "bin", "node"), path.join(nodeRoot, "bin", "node"));
  await chmod(path.join(nodeRoot, "bin", "node"), 0o755);
  for (const licenseName of ["LICENSE", "LICENSE.md", "LICENSE.txt"]) {
    if (await exists(path.join(extractedNode, licenseName))) {
      await copyFile(path.join(extractedNode, licenseName), path.join(nodeRoot, licenseName));
      await chmod(path.join(nodeRoot, licenseName), 0o644);
    }
  }

  const pythonRoot = componentRoot(payloadRoot, contracts, "python-runtime");
  const pythonEntries = await extractVerifiedArchive({
    archivePath: archiveById.get("python-runtime-archive"),
    lock: lockById.get("python-runtime-archive"),
    destination: pythonRoot,
    stripComponents: 1,
  });
  await assertSymlinksPreserved(pythonRoot, pythonEntries);
  await prunePythonRuntime(pythonRoot);
  await requireResolvedFileWithin(path.join(pythonRoot, "bin", "python3"), pythonRoot, "bundled Python executable");

  const temporalRoot = componentRoot(payloadRoot, contracts, "temporal-runtime");
  const temporalEntries = await extractVerifiedArchive({
    archivePath: archiveById.get("temporal-runtime-archive"),
    lock: lockById.get("temporal-runtime-archive"),
    destination: temporalRoot,
    stripComponents: 0,
  });
  await assertSymlinksPreserved(temporalRoot, temporalEntries);
  await requireFile(path.join(temporalRoot, "temporal"), "bundled Temporal executable");
  await chmod(path.join(temporalRoot, "temporal"), 0o755);

  const chromiumRoot = componentRoot(payloadRoot, contracts, "chromium-core");
  const headlessRevisionRoot = path.join(chromiumRoot, "chromium_headless_shell-1208");
  const headlessEntries = await extractVerifiedArchive({
    archivePath: archiveById.get("chromium-core-headless-archive"),
    lock: lockById.get("chromium-core-headless-archive"),
    destination: headlessRevisionRoot,
    stripComponents: 0,
  });
  await assertSymlinksPreserved(headlessRevisionRoot, headlessEntries);
  await writePlaywrightRevisionMarkers(headlessRevisionRoot);

  return { lockById, archiveById, betterSqlitePrebuildRoot };
}

async function prunePythonRuntime(pythonRoot) {
  const originalExecutable = await realpath(path.join(pythonRoot, "bin", "python3"));
  const stagedExecutable = path.join(pythonRoot, ".python3-runtime");
  await copyFile(originalExecutable, stagedExecutable);
  await chmod(stagedExecutable, 0o755);
  await rm(path.join(pythonRoot, "bin"), { recursive: true, force: true });
  await mkdir(path.join(pythonRoot, "bin"), { recursive: true, mode: 0o755 });
  await rename(stagedExecutable, path.join(pythonRoot, "bin", "python3"));

  for (const removable of [
    "include",
    "share",
    "lib/pkgconfig",
    "lib/python3.12/ensurepip",
    "lib/python3.12/idlelib",
    "lib/python3.12/lib2to3",
    "lib/python3.12/pydoc.py",
    "lib/python3.12/pydoc_data",
    "lib/python3.12/site-packages",
    "lib/python3.12/test",
    "lib/python3.12/tkinter",
    "lib/python3.12/turtledemo",
    "lib/python3.12/venv",
  ]) {
    await rm(path.join(pythonRoot, ...removable.split("/")), { recursive: true, force: true });
  }
  const stdlibRoot = path.join(pythonRoot, "lib", "python3.12");
  for (const entry of await readdir(stdlibRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && (/^config-/.test(entry.name) || entry.name === "__pycache__")) {
      await rm(path.join(stdlibRoot, entry.name), { recursive: true, force: true });
    }
  }
  await pruneInstalledPythonTree(stdlibRoot);
  const binEntries = await readdir(path.join(pythonRoot, "bin"));
  invariant(JSON.stringify(binEntries) === JSON.stringify(["python3"]), "pruned Python runtime must expose only bin/python3");
  const forbiddenNames = ["2to3", "ensurepip", "idle", "pip", "pip3", "pydoc", "setuptools", "wheel"];
  const inventory = await buildFileInventory(pythonRoot);
  for (const file of inventory) {
    const basename = path.posix.basename(file.path).toLowerCase();
    invariant(!forbiddenNames.some((name) => basename === name || basename.startsWith(`${name}-`) || basename.startsWith(`${name}.`)), `${file.path}: pruned Python runtime still contains ${basename}`);
  }
  const pythonExecutable = path.join(pythonRoot, "bin", "python3");
  await run(pythonExecutable, ["-I", "-B", "-c", "import ctypes, hashlib, json, multiprocessing, sqlite3, ssl, urllib.request"], {
    cwd: pythonRoot,
    env: { HOME: pythonRoot, PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
  });
}

async function assemblePlaywrightMcp(payloadRoot, root, contracts, externalInputs) {
  const runtimeSource = path.join(root, contracts.layout.standardInputs.playwrightMcpRuntime);
  await run("corepack", [
    "pnpm", "--dir", runtimeSource, "install", "--frozen-lockfile", "--prod", "--no-optional", "--ignore-workspace", "--ignore-scripts",
  ], { cwd: root, env: { ...process.env, CI: "true", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" } });
  const mcpRoot = componentRoot(payloadRoot, contracts, "playwright-mcp");
  const mcpPackageRoot = path.join(mcpRoot, "node_modules", "@playwright", "mcp");
  const mcpEntries = await extractVerifiedArchive({
    archivePath: externalInputs.archiveById.get("playwright-mcp-archive"),
    lock: externalInputs.lockById.get("playwright-mcp-archive"),
    destination: mcpPackageRoot,
    stripComponents: 1,
  });
  await assertSymlinksPreserved(mcpPackageRoot, mcpEntries);

  const installedNodeModules = path.join(runtimeSource, "node_modules");
  const installedMcpPackage = await realpath(path.join(installedNodeModules, "@playwright", "mcp"));
  const mcpVirtualNodeModules = path.resolve(installedMcpPackage, "..", "..");
  const coreSource = await realpath(path.join(mcpVirtualNodeModules, "playwright-core"));
  await copyTree(coreSource, path.join(mcpRoot, "node_modules", "playwright-core"), { exclude: shouldExcludeSourcePath });
  const [mcpPackage, corePackage] = await Promise.all([
    readFile(path.join(mcpPackageRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(mcpRoot, "node_modules", "playwright-core", "package.json"), "utf8").then(JSON.parse),
  ]);
  invariant(mcpPackage.version === contracts.versions["playwright-mcp"], "Playwright MCP package version does not match inventory");
  invariant(corePackage.version === mcpPackage.dependencies["playwright-core"], "Playwright MCP resolved playwright-core version drifted");
  await prunePlaywrightDevelopmentMetadata(mcpRoot);
  await prunePlaywrightMcpRuntime(mcpRoot);
  await mkdir(path.join(mcpRoot, "bin"), { recursive: true, mode: 0o755 });
  await writeFile(
    path.join(mcpRoot, "bin", "playwright-mcp"),
    "#!/bin/sh\nexec \"$JOBCTRL_PAYLOAD_DIR/node/bin/node\" \"$JOBCTRL_PAYLOAD_DIR/playwright-mcp/node_modules/@playwright/mcp/cli.js\" \"$@\"\n",
    { mode: 0o755 },
  );
  await chmod(path.join(mcpRoot, "bin", "playwright-mcp"), 0o755);
}

async function findWorkerWheel(root, version) {
  const wheelDirectory = path.join(root, "dist");
  await mkdir(wheelDirectory, { recursive: true, mode: 0o755 });
  await run("uv", ["build", "--wheel", "--out-dir", wheelDirectory, path.join(root, "workers", "automation")], {
    cwd: root,
    env: { ...process.env, SOURCE_DATE_EPOCH: process.env.SOURCE_DATE_EPOCH ?? "0" },
  });
  const wheels = (await readdir(wheelDirectory)).filter((name) => name === `jobctrl-${version}-py3-none-any.whl`).sort(bytewiseCompare);
  invariant(wheels.length === 1, `expected exactly one JobCtrl ${version} wheel in ${wheelDirectory}`);
  return path.join(wheelDirectory, wheels[0]);
}

async function preparePythonWorker(payloadRoot, root, contracts, scratchDirectory) {
  const workerRoot = componentRoot(payloadRoot, contracts, "jobctrl-worker");
  const workerSite = path.join(workerRoot, "site-packages");
  const playwrightRoot = componentRoot(payloadRoot, contracts, "playwright-python");
  const playwrightSite = path.join(playwrightRoot, "site-packages");
  await Promise.all([
    mkdir(workerSite, { recursive: true, mode: 0o755 }),
    mkdir(playwrightSite, { recursive: true, mode: 0o755 }),
  ]);
  const requirements = path.join(scratchDirectory, "python-core-requirements.txt");
  const pythonSbom = path.join(scratchDirectory, "python-core.sbom.cdx.json");
  const exportBase = [
    "export", "--project", path.join(root, "workers", "automation"), "--frozen", "--no-dev",
    "--no-default-groups", "--no-emit-project", "--python", "3.12",
  ];
  await run("uv", [...exportBase, "--output-file", requirements], { cwd: root });
  await run("uv", [...exportBase, "--format", "cyclonedx1.5", "--output-file", pythonSbom], { cwd: root });
  const pythonExecutable = path.join(componentRoot(payloadRoot, contracts, "python-runtime"), "bin", "python3");
  await run("uv", [
    "pip", "install", "--python", pythonExecutable, "--target", workerSite,
    "--requirements", requirements, "--require-hashes", "--no-build", "--no-deps", "--link-mode", "copy",
  ], { cwd: root, env: { ...process.env, UV_NO_PROGRESS: "1" } });
  const wheel = await findWorkerWheel(root, contracts.versions["jobctrl-worker"]);
  await run("uv", [
    "pip", "install", "--python", pythonExecutable, "--target", workerSite,
    "--no-deps", "--link-mode", "copy", wheel,
  ], { cwd: root, env: { ...process.env, UV_NO_PROGRESS: "1" } });

  const entries = await readdir(workerSite, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "playwright" || /^playwright-[^-]+\.dist-info$/.test(entry.name)) {
      await rename(path.join(workerSite, entry.name), path.join(playwrightSite, entry.name));
    }
  }
  for (const removable of [path.join(workerRoot, "bin"), path.join(workerSite, "bin")]) await rm(removable, { recursive: true, force: true });
  async function removeDirectUrls(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) await removeDirectUrls(entryPath);
      else if (entry.name === "direct_url.json" || entry.name === ".lock" || entry.name.endsWith(".pyc")) await rm(entryPath, { force: true });
    }
  }
  await Promise.all([removeDirectUrls(workerSite), removeDirectUrls(playwrightSite)]);
  await prunePlaywrightDevelopmentMetadata(playwrightSite);
  await pruneTlsClientForDarwinArm64(workerSite);
  await Promise.all([pruneInstalledPythonTree(workerSite), pruneInstalledPythonTree(playwrightSite)]);
  await normalizeInstalledPythonMetadata([workerSite, playwrightSite]);

  const systemSitePackages = path.join(componentRoot(payloadRoot, contracts, "python-runtime"), "lib", "python3.12", "site-packages");
  await mkdir(systemSitePackages, { recursive: true, mode: 0o755 });
  await writeFile(
    path.join(systemSitePackages, "jobctrl-payload.pth"),
    "../../../../worker/site-packages\n../../../../playwright-python/site-packages\n",
    { mode: 0o644 },
  );

  await run(pythonExecutable, ["-I", "-B", "-m", "jobctrl", "--help"], {
    cwd: payloadRoot,
    env: {
      HOME: path.join(scratchDirectory, "isolated-home"),
      JOBCTRL_DIR: path.join(scratchDirectory, "jobctrl-state"),
      JOBCTRL_PAYLOAD_DIR: payloadRoot,
      JOBCTRL_RUNTIME_MODE: "bundled",
      PLAYWRIGHT_BROWSERS_PATH: componentRoot(payloadRoot, contracts, "chromium-core"),
    },
  });
  await run(pythonExecutable, [
    "-I", "-B", "-c",
    "import tls_client\nfrom tls_client.cffi import library\nassert library is not None",
  ], {
    cwd: payloadRoot,
    env: {
      HOME: path.join(scratchDirectory, "isolated-home"),
      JOBCTRL_DIR: path.join(scratchDirectory, "jobctrl-state"),
      JOBCTRL_PAYLOAD_DIR: payloadRoot,
      JOBCTRL_RUNTIME_MODE: "bundled",
      PLAYWRIGHT_BROWSERS_PATH: componentRoot(payloadRoot, contracts, "chromium-core"),
    },
  });
  return pythonSbom;
}

async function measureProviderPackInstalledTrees(payloadRoot, root, contracts, scratchDirectory) {
  const pythonExecutable = path.join(componentRoot(payloadRoot, contracts, "python-runtime"), "bin", "python3");
  const lockPath = path.join(root, "packaging", "distribution", "provider-packs.lock.json");
  const measurementState = path.join(scratchDirectory, "provider-pack-size-state");
  const script = [
    "import json",
    "from pathlib import Path",
    "from jobctrl.provider_packs import install_provider_pack, load_provider_pack_spec, provider_tree_stats",
    `lock_path = Path(${JSON.stringify(lockPath)})`,
    `state_root = Path(${JSON.stringify(measurementState)})`,
    "payload = json.loads(lock_path.read_text(encoding='utf-8'))",
    "packs = []",
    "for raw in sorted(payload['packs'], key=lambda value: value['id'].encode('utf-8')):",
    "    spec = load_provider_pack_spec(lock_path, pack_id=raw['id'])",
    "    installed = install_provider_pack(spec, app_dir=state_root)",
    "    stats = provider_tree_stats(installed / 'site-packages')",
    "    packs.append({'id': spec.pack_id, 'version': spec.version, 'installedBytes': stats.installed_bytes, 'fileCount': stats.file_count, 'treeSha256': stats.tree_sha256})",
    "print(json.dumps({'schemaVersion': 1, 'measurementStatus': 'exact-locked-wheel-extraction', 'packs': packs}, sort_keys=True))",
  ].join("\n");
  const result = await run(pythonExecutable, ["-I", "-B", "-c", script], {
    cwd: payloadRoot,
    env: {
      HOME: path.join(scratchDirectory, "provider-pack-measurement-home"),
      JOBCTRL_DIR: measurementState,
      JOBCTRL_PAYLOAD_DIR: payloadRoot,
      JOBCTRL_RUNTIME_MODE: "bundled",
      PLAYWRIGHT_BROWSERS_PATH: componentRoot(payloadRoot, contracts, "chromium-core"),
    },
  });
  const measurement = JSON.parse(result.stdout.trim());
  invariant(measurement?.schemaVersion === 1 && measurement.measurementStatus === "exact-locked-wheel-extraction", "provider-pack installed-tree measurement is invalid");
  invariant(Array.isArray(measurement.packs), "provider-pack installed-tree measurement has no packs");
  const expected = contracts.providerPackLocks.packs.map((pack) => `${pack.id}@${pack.version}`).sort(bytewiseCompare);
  const actual = measurement.packs.map((pack) => {
    invariant(
      typeof pack?.id === "string"
        && typeof pack.version === "string"
        && Number.isInteger(pack.installedBytes)
        && pack.installedBytes >= 0
        && Number.isInteger(pack.fileCount)
        && pack.fileCount >= 0
        && /^[a-f0-9]{64}$/.test(pack.treeSha256),
      "provider-pack installed-tree measurement entry is invalid",
    );
    return `${pack.id}@${pack.version}`;
  }).sort(bytewiseCompare);
  invariant(JSON.stringify(actual) === JSON.stringify(expected), `provider-pack installed-tree measurement closure drifted: ${actual.join(", ")}`);
  return measurement;
}

function validateReleaseBuildBinding(releaseChannel, releaseTrustKeyBase64) {
  invariant(RELEASE_CHANNELS.has(releaseChannel), "native release channel is invalid");
  invariant(typeof releaseTrustKeyBase64 === "string", "native release trust key must be a string");
  if (releaseChannel === "local") {
    invariant(releaseTrustKeyBase64 === "", "local native builds must not embed a release trust key");
    return;
  }
  let decoded;
  try {
    decoded = Buffer.from(releaseTrustKeyBase64, "base64");
  } catch {
    throw new Error("signed native builds require a base64 Ed25519 release trust key");
  }
  invariant(decoded.length === 32 && decoded.toString("base64") === releaseTrustKeyBase64, "signed native builds require a base64 Ed25519 release trust key");
}

export function createNativeLauncherBuildPlan({
  payloadRoot,
  root,
  platform,
  sourceDateEpoch,
  goExecutable,
  goRoot,
  binary = "jobctrl",
  releaseChannel = "local",
  releaseTrustKeyBase64 = "",
}) {
  invariant(platform?.os === "darwin" && platform?.arch === "arm64", "native launcher build target must be darwin-arm64");
  invariant(Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0, "native launcher SOURCE_DATE_EPOCH must be non-negative");
  invariant(typeof goExecutable === "string" && path.isAbsolute(goExecutable), "native launcher compiler executable must be an absolute verified path");
  invariant(typeof goRoot === "string" && path.isAbsolute(goRoot), "native launcher GOROOT must be an absolute verified path");
  invariant(["jobctrl", "jobctrl-installer"].includes(binary), "native binary must be jobctrl or jobctrl-installer");
  validateReleaseBuildBinding(releaseChannel, releaseTrustKeyBase64);
  const ldflags = [
    "-s",
    "-w",
    "-buildid=",
    `-X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseChannel=${releaseChannel}`,
  ];
  if (releaseTrustKeyBase64) {
    ldflags.push(`-X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseTrustKeyBase64=${releaseTrustKeyBase64}`);
  }
  return {
    command: goExecutable,
    args: ["build", "-buildvcs=false", "-trimpath", `-ldflags=${ldflags.join(" ")}`, "-o", path.join(payloadRoot, "launcher", binary), `./cmd/${binary}`],
    cwd: path.join(root, "launcher"),
    environment: {
      CGO_ENABLED: "0",
      GOOS: "darwin",
      GOARCH: "arm64",
      // The extracted, checksum-verified official archive is the only GOROOT
      // accepted by the release builder. This blocks ambient Go installations,
      // user configuration, experiments, and architecture tuning from changing
      // launcher bytes.
      GOROOT: goRoot,
      GOENV: "off",
      GOFLAGS: "",
      GOWORK: "off",
      GOTOOLCHAIN: "local",
      GOEXPERIMENT: "",
      GOARM64: "v8.0",
      SOURCE_DATE_EPOCH: String(sourceDateEpoch),
    },
  };
}

async function prepareNativeGoToolchain(root, cacheDirectory, scratchDirectory, toolchain) {
  const lock = nativeGoArchiveLock(toolchain);
  const archivePath = await downloadLockedArchive(lock, cacheDirectory);
  const goRoot = path.join(scratchDirectory, "go-toolchain");
  const entries = await extractVerifiedArchive({
    archivePath,
    lock,
    destination: goRoot,
    stripComponents: 1,
    // The official Go archive's `go/test` corpus is not needed to compile the
    // launcher. It contains upstream regression fixtures with non-ASCII names
    // that intentionally violate the portable payload path policy, so discard
    // only that fixed top-level test subtree before extraction.
    skipEntry: (rawPath) => rawPath.startsWith("go/test/"),
  });
  await assertSymlinksPreserved(goRoot, entries);
  const goExecutable = await requireFile(path.join(goRoot, "bin", "go"), "pinned Go compiler executable");
  await chmod(goExecutable, 0o755);
  const licensePath = await requireFile(path.join(goRoot, "LICENSE"), "pinned Go compiler license");
  invariant(await sha256File(licensePath) === toolchain.licenseSha256, "pinned Go compiler license does not match the toolchain contract");
  const environment = {
    ...process.env,
    GOROOT: goRoot,
    GOENV: "off",
    GOFLAGS: "",
    GOWORK: "off",
    GOTOOLCHAIN: "local",
    GOEXPERIMENT: "",
    GOARM64: "v8.0",
  };
  const version = (await run(goExecutable, ["version"], { cwd: root, env: environment })).stdout.trim();
  invariant(version === `go version ${toolchain.goVersion} darwin/arm64`, `pinned Go compiler version is ${version}, expected ${toolchain.goVersion} darwin/arm64`);
  return { archivePath, lock, goExecutable, goRoot, version };
}

async function writeGeneratedComponents(payloadRoot, root, contracts, sourceDateEpoch, nativeGoToolchain, releaseBuild = {}) {
  const launcherRoot = componentRoot(payloadRoot, contracts, "jobctrl-launcher");
  await mkdir(launcherRoot, { recursive: true, mode: 0o755 });
  invariant(nativeGoToolchain?.lock?.sha256 === contracts.launcherToolchain.archive.sha256, "native launcher compiler does not match the locked toolchain contract");
  for (const binary of ["jobctrl", "jobctrl-installer"]) {
    const plan = createNativeLauncherBuildPlan({
      payloadRoot,
      root,
      platform: contracts.platform,
      sourceDateEpoch,
      goExecutable: nativeGoToolchain.goExecutable,
      goRoot: nativeGoToolchain.goRoot,
      binary,
      ...releaseBuild,
    });
    await run(plan.command, plan.args, { cwd: plan.cwd, env: { ...process.env, ...plan.environment } });
  }
  await chmod(path.join(launcherRoot, "jobctrl"), 0o755);
  await chmod(path.join(launcherRoot, "jobctrl-installer"), 0o755);
  await copyFile(path.join(root, "launcher", "runtime-manifest.json"), path.join(launcherRoot, "runtime-manifest.json"));
  await chmod(path.join(launcherRoot, "runtime-manifest.json"), 0o644);

  const pdfjsRoot = componentRoot(payloadRoot, contracts, "pdfjs-renderer");
  await mkdir(pdfjsRoot, { recursive: true, mode: 0o755 });
  await writeJson(path.join(pdfjsRoot, "renderer.json"), {
    schemaVersion: 1,
    implementation: "pdfjs-dist",
    version: contracts.versions["pdfjs-renderer"],
    embeddedIn: contracts.componentPaths.get("jobctrl-web"),
    popplerRequired: false,
  });
}

async function findLicenseFiles(packageRoot) {
  const candidates = [];
  async function visit(directory, depth) {
    if (depth > 2) return;
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => bytewiseCompare(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && /^(licenses?|legal)$/i.test(entry.name)) await visit(entryPath, depth + 1);
      else if (entry.isFile() && /^(licen[cs]e|copying|notice|thirdpartynotices)([-.].*)?$/i.test(entry.name)) candidates.push(entryPath);
    }
  }
  await visit(packageRoot, 0);
  return candidates;
}

function npmPackageKey(name, version) {
  invariant(typeof name === "string" && name.length > 0, "npm package name is required");
  invariant(typeof version === "string" && version.length > 0, `${name}: npm package version is required`);
  return `${name}@${version}`;
}

function safeRelativePath(root, target, label) {
  const relative = path.relative(root, target);
  invariant(relative && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative), `${label} escapes its root`);
  return relative.split(path.sep).join("/");
}

async function loadNpmPackageIdentity(packageRoot, contribution) {
  const packageJsonPath = path.join(packageRoot, "package.json");
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  const name = packageJson.name;
  const version = packageJson.version;
  invariant(typeof name === "string" && typeof version === "string", `${packageRoot}: package.json has no name/version`);
  invariant(typeof packageJson.license === "string" && !/unknown|unlicensed|noassertion/i.test(packageJson.license), `${name}@${version}: unresolved npm runtime license`);
  return {
    key: npmPackageKey(name, version),
    name,
    version,
    license: packageJson.license,
    attribution: typeof packageJson.author === "string" ? packageJson.author : packageJson.author?.name ?? "See package source",
    source: typeof packageJson.homepage === "string" && packageJson.homepage ? packageJson.homepage : "See package.json",
    packageRoot,
    contribution,
  };
}

export async function npmIdentityForContributingSource(root, sourcePath, contribution) {
  const candidate = path.resolve(root, sourcePath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) return null;
  const segments = relative.split(path.sep);
  const nodeModulesIndex = segments.lastIndexOf("node_modules");
  if (nodeModulesIndex === -1 || nodeModulesIndex === segments.length - 1) return null;
  try {
    await stat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const firstPackageSegment = segments[nodeModulesIndex + 1];
  const packageSegmentCount = firstPackageSegment.startsWith("@") ? 2 : 1;
  invariant(
    nodeModulesIndex + packageSegmentCount < segments.length || !firstPackageSegment.startsWith("@"),
    `${sourcePath}: incomplete scoped npm package path`,
  );
  const packageRoot = path.join(root, ...segments.slice(0, nodeModulesIndex + 1 + packageSegmentCount));
  if (!(await exists(path.join(packageRoot, "package.json")))) return null;
  return loadNpmPackageIdentity(packageRoot, contribution);
}

function mergeNpmContributors(contributors) {
  const merged = new Map();
  for (const contributor of contributors.filter(Boolean)) {
    const previous = merged.get(contributor.key);
    if (!previous) {
      merged.set(contributor.key, {
        ...contributor,
        packageRoots: new Set([contributor.packageRoot]),
        contributions: new Map([[JSON.stringify(contributor.contribution), { ...contributor.contribution, sourceCount: 1 }]]),
      });
      continue;
    }
    invariant(previous.license === contributor.license, `${contributor.key}: contributing package roots disagree on license`);
    previous.packageRoots.add(contributor.packageRoot);
    const contributionKey = JSON.stringify(contributor.contribution);
    const existing = previous.contributions.get(contributionKey);
    if (existing) existing.sourceCount += 1;
    else previous.contributions.set(contributionKey, { ...contributor.contribution, sourceCount: 1 });
  }
  return [...merged.values()].sort((left, right) => bytewiseCompare(left.key, right.key));
}

async function collectApiBundleContributors(root, apiBundle) {
  const metafilePath = path.join(path.dirname(apiBundle), "metafile.json");
  const metafile = JSON.parse(await readFile(metafilePath, "utf8"));
  const contributors = [];
  for (const sourcePath of Object.keys(metafile.inputs ?? {}).sort(bytewiseCompare)) {
    const contributor = await npmIdentityForContributingSource(root, sourcePath, {
      kind: "api-esbuild-metafile",
      artifactPath: "api/server.mjs",
    });
    if (contributor) contributors.push(contributor);
  }
  return contributors;
}

async function collectWebBundleContributors(root, webAssets) {
  const maps = (await buildFileInventory(webAssets))
    .filter((file) => file.type === "file" && file.path.endsWith(".map"))
    .sort((left, right) => bytewiseCompare(left.path, right.path));
  invariant(maps.length > 0, "production web build did not emit hidden source maps for contribution evidence");
  const contributors = [];
  try {
    for (const map of maps) {
      const mapPath = path.join(webAssets, ...map.path.split("/"));
      const sourceMap = JSON.parse(await readFile(mapPath, "utf8"));
      invariant(Array.isArray(sourceMap.sources), `${map.path}: web source map has no sources`);
      invariant(sourceMap.sourceRoot === undefined || typeof sourceMap.sourceRoot === "string", `${map.path}: web source map has an invalid sourceRoot`);
      for (const sourcePath of sourceMap.sources) {
        if (typeof sourcePath !== "string" || sourcePath.startsWith("\u0000")) continue;
        const resolved = path.resolve(path.dirname(mapPath), sourceMap.sourceRoot ?? "", sourcePath);
        const contributor = await npmIdentityForContributingSource(root, resolved, {
          kind: "web-hidden-sourcemap",
          artifactPath: "web",
        });
        if (contributor) contributors.push(contributor);
      }
    }
  } finally {
    for (const map of maps) await rm(path.join(webAssets, ...map.path.split("/")), { force: true });
  }
  invariant(!(await buildFileInventory(webAssets)).some((file) => file.path.endsWith(".map")), "web contribution source maps survived build evidence collection");
  return contributors;
}

export async function collectPayloadNpmContributors(payloadRoot, nodeModules, { expectedKeys = null } = {}) {
  const contributors = [];
  const visitedNodeModules = new Set();
  async function visitPackage(packageRoot) {
    const relativePath = safeRelativePath(payloadRoot, packageRoot, "payload npm package");
    contributors.push(await loadNpmPackageIdentity(packageRoot, {
      kind: "payload-npm-tree",
      artifactPath: relativePath,
    }));
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        invariant(entry.name !== ".pnpm", `${safeRelativePath(payloadRoot, directory, "payload npm package")}: pnpm virtual-store content is forbidden in the payload`);
        const entryPath = path.join(directory, entry.name);
        if (entry.name === "node_modules") await visitNodeModules(entryPath);
        else await visit(entryPath);
      }
    }
    await visit(packageRoot);
  }
  async function visitNodeModules(directory) {
    const resolved = await realpath(directory);
    if (visitedNodeModules.has(resolved)) return;
    visitedNodeModules.add(resolved);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      invariant(entry.name !== ".pnpm", `${safeRelativePath(payloadRoot, directory, "payload npm node_modules")}: pnpm virtual-store content is forbidden in the payload`);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(path.join(directory, entry.name), { withFileTypes: true })) {
          if (scoped.isDirectory() && !scoped.isSymbolicLink()) await visitPackage(path.join(directory, entry.name, scoped.name));
        }
      } else {
        await visitPackage(path.join(directory, entry.name));
      }
    }
  }
  await visitNodeModules(nodeModules);
  const merged = mergeNpmContributors(contributors);
  if (expectedKeys !== null) {
    invariant(
      JSON.stringify(merged.map((entry) => entry.key)) === JSON.stringify([...expectedKeys].sort(bytewiseCompare)),
      `payload npm package closure drifted: ${merged.map((entry) => entry.key).join(", ")}`,
    );
  }
  return merged;
}

async function collectMcpNodeContributors(payloadRoot, contracts) {
  const mcpRoot = componentRoot(payloadRoot, contracts, "playwright-mcp");
  return collectPayloadNpmContributors(payloadRoot, path.join(mcpRoot, "node_modules"), {
    expectedKeys: new Set([
      `@playwright/mcp@${contracts.versions["playwright-mcp"]}`,
      "playwright-core@1.62.0-alpha-2026-06-29",
    ]),
  });
}

async function collectNodeContributors(payloadRoot, root, contracts) {
  const inputs = contracts.layout.standardInputs;
  const [apiBundle, webBundle, apiPayload, mcpPayload] = await Promise.all([
    collectApiBundleContributors(root, path.join(root, inputs.apiBundle)),
    collectWebBundleContributors(root, path.join(root, inputs.webAssets)),
    collectPayloadNpmContributors(payloadRoot, path.join(componentRoot(payloadRoot, contracts, "jobctrl-api"), "node_modules")),
    collectMcpNodeContributors(payloadRoot, contracts),
  ]);
  return mergeNpmContributors([...apiBundle, ...webBundle, ...apiPayload, ...mcpPayload]);
}

export function assertNodeAttributionClosure(contributors, nodeInventory) {
  const contributorKeys = new Set(contributors.map((entry) => entry.key ?? npmPackageKey(entry.name, entry.version)));
  const attributedKeys = new Set();
  for (const entry of nodeInventory.packages ?? []) {
    invariant(Array.isArray(entry.versions) && entry.versions.length === 1, `${entry.name}: Node SBOM package entry must have exactly one version`);
    invariant(Array.isArray(entry.contributions) && entry.contributions.length > 0, `${entry.name}@${entry.versions[0]}: Node SBOM package lacks a concrete contribution reference`);
    attributedKeys.add(npmPackageKey(entry.name, entry.versions[0]));
  }
  const missing = [...contributorKeys].filter((key) => !attributedKeys.has(key)).sort(bytewiseCompare);
  const extra = [...attributedKeys].filter((key) => !contributorKeys.has(key)).sort(bytewiseCompare);
  invariant(missing.length === 0 && extra.length === 0, `Node SBOM/license closure mismatch; missing=${missing.join(",")}; extra=${extra.join(",")}`);
  return true;
}

async function localMitMetadataEvidence(contributor) {
  if (contributor.license !== "MIT") return null;
  const metadataPaths = [...contributor.packageRoots]
    .map((packageRoot) => path.join(packageRoot, "package.json"))
    .sort(bytewiseCompare);
  for (const metadataPath of metadataPaths) {
    const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
    if (metadata.name === contributor.name && metadata.version === contributor.version && metadata.license === "MIT") {
      return [metadataPath, path.join(DISTRIBUTION_DIR, "licenses", "MIT.txt")];
    }
  }
  return null;
}

export async function collectNodeLicenseInventory(contracts, cacheDirectory, contributors) {
  const packages = [];
  const licenseSources = [];
  for (const contributor of contributors) {
    let evidence = [];
    for (const packageRoot of contributor.packageRoots) evidence.push(...await findLicenseFiles(packageRoot));
    if (evidence.length === 0) {
      const localMitEvidence = await localMitMetadataEvidence(contributor);
      if (localMitEvidence) evidence = localMitEvidence;
    }
    if (evidence.length === 0) {
      const lockedEvidence = contracts.nodeLicenseEvidenceLocks.inputs.find((input) => input.package === contributor.name && input.version === contributor.version);
      invariant(lockedEvidence, `${contributor.key}: Node runtime package has no package license/notice or locked evidence`);
      invariant(lockedEvidence.license === contributor.license, `${contributor.key}: Node locked license evidence expression does not match package metadata`);
      evidence = [await downloadLockedLicenseEvidence(lockedEvidence, cacheDirectory)];
      if (lockedEvidence.evidenceKind === "package-metadata-plus-canonical-text") evidence.push(path.join(DISTRIBUTION_DIR, "licenses", "MIT.txt"));
      else invariant(lockedEvidence.evidenceKind === "license-text", `${contributor.key}: unsupported Node license evidence kind`);
    }
    const contributions = [...contributor.contributions.values()]
      .sort((left, right) => bytewiseCompare(JSON.stringify(left), JSON.stringify(right)));
    packages.push({
      name: contributor.name,
      versions: [contributor.version],
      license: contributor.license,
      attribution: contributor.attribution,
      source: contributor.source,
      contributions,
    });
    for (const source of [...new Set(evidence)].sort(bytewiseCompare)) licenseSources.push({ subject: `npm:${contributor.key}`, source });
  }
  packages.sort((left, right) => bytewiseCompare(`${left.name}@${left.versions[0]}`, `${right.name}@${right.versions[0]}`));
  const inventory = { schemaVersion: 1, status: "complete", packages };
  assertNodeAttributionClosure(contributors, inventory);
  return { inventory, licenseSources };
}

async function collectPythonLicenseEvidence(payloadRoot, contracts, cacheDirectory) {
  const roots = [
    path.join(componentRoot(payloadRoot, contracts, "jobctrl-worker"), "site-packages"),
    path.join(componentRoot(payloadRoot, contracts, "playwright-python"), "site-packages"),
  ];
  const packages = [];
  const licenseSources = [];
  for (const sitePackages of roots) {
    for (const entry of (await readdir(sitePackages, { withFileTypes: true })).sort((left, right) => bytewiseCompare(left.name, right.name))) {
      if (!entry.isDirectory() || !entry.name.endsWith(".dist-info")) continue;
      const metadataPath = path.join(sitePackages, entry.name, "METADATA");
      const metadata = await readFile(metadataPath, "utf8");
      const name = metadata.match(/^Name: (.+)$/m)?.[1];
      const version = metadata.match(/^Version: (.+)$/m)?.[1];
      invariant(name && version, `${entry.name}: Python METADATA is missing Name or Version`);
      let evidence = await findLicenseFiles(path.join(sitePackages, entry.name));
      if (canonicalPackageName(name) === "jobctrl" && evidence.length === 0) evidence = [path.join(REPO_ROOT, "LICENSE")];
      const license = await resolvePythonLicense(metadata, evidence);
      invariant(license && !/unknown|noassertion/i.test(license), `${name}: Python package has unresolved license metadata`);
      if (evidence.length === 0) {
        const lockedEvidence = contracts.licenseEvidenceLocks.inputs.find((input) => input.package === canonicalPackageName(name) && input.version === version);
        invariant(lockedEvidence, `${name}: Python production dependency has no wheel license/notice file or locked fallback`);
        invariant(lockedEvidence.license === license, `${name}: locked license evidence expression does not match package metadata`);
        evidence = [await downloadLockedLicenseEvidence(lockedEvidence, cacheDirectory)];
      }
      packages.push({ name, version, license });
      for (const source of evidence) licenseSources.push({ subject: `pypi:${name}`, source });
    }
  }
  invariant(packages.length > 0, "Python production closure contains no dist-info metadata");
  packages.sort((left, right) => bytewiseCompare(left.name, right.name));
  return { packages, licenseSources };
}

async function resolvePythonLicense(metadata, evidence) {
  const expression = metadata.match(/^License-Expression: (.+)$/m)?.[1]?.trim();
  if (expression && !/unknown|noassertion/i.test(expression)) return normalizeSpdxExpression(expression);
  const declared = metadata.match(/^License: (.+)$/m)?.[1]?.trim();
  if (declared && !/unknown|noassertion/i.test(declared)) return normalizeSpdxExpression(declared);
  const classifiers = [...metadata.matchAll(/^Classifier: License :: OSI Approved :: (.+)$/gm)].map((match) => match[1]);
  const classifierMap = new Map([
    ["MIT License", "MIT"],
    ["Apache Software License", "Apache-2.0"],
    ["Mozilla Public License 2.0 (MPL 2.0)", "MPL-2.0"],
    ["Python Software Foundation License", "PSF-2.0"],
    ["ISC License (ISCL)", "ISC"],
  ]);
  for (const classifier of classifiers) if (classifierMap.has(classifier)) return classifierMap.get(classifier);
  const combined = (await Promise.all(evidence.map((file) => readFile(file, "utf8")))).join("\n").slice(0, 20000);
  if (/Permission is hereby granted, free of charge, to any person obtaining a copy/i.test(combined)) return "MIT";
  if (/Licensed under the Apache License, Version 2\.0/i.test(combined)) return "Apache-2.0";
  if (/Redistribution and use in source and binary forms.*Neither the name/is.test(combined)) return "BSD-3-Clause";
  if (/Redistribution and use in source and binary forms/is.test(combined)) return "BSD-2-Clause";
  return null;
}

function normalizeSpdxExpression(value) {
  const legacy = new Map([
    ["MIT License", "MIT"],
    ["Apache 2.0", "Apache-2.0"],
    ["Apache Software License", "Apache-2.0"],
    ["BSD 3-Clause License", "BSD-3-Clause"],
    ["3-Clause BSD License", "BSD-3-Clause"],
    ["ISC License", "ISC"],
    ["Dual License", "Apache-2.0 OR BSD-3-Clause"],
    ["Copyright (c) 2005-2023, NumPy Developers.", "BSD-3-Clause"],
  ]);
  if (legacy.has(value)) return legacy.get(value);
  const normalized = value
    .replace(/\s+and\s+/gi, " AND ")
    .replace(/\s+or\s+/gi, " OR ")
    .replace(/\s+with\s+/gi, " WITH ")
    .trim();
  invariant(
    /^[A-Za-z0-9.+-]+(?:\s+(?:AND|OR|WITH)\s+[A-Za-z0-9.+-]+)*$/.test(normalized),
    `invalid SPDX license expression ${JSON.stringify(value)}`,
  );
  return normalized;
}

export async function reconcilePythonSbom(pythonSbomPath, installedPackages, { sourceDateEpoch }) {
  invariant(Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0, "Python SBOM sourceDateEpoch must be a non-negative integer");
  const sbom = JSON.parse(await readFile(pythonSbomPath, "utf8"));
  const sbomByKey = new Map();
  for (const component of sbom.components ?? []) {
    const key = `${canonicalPackageName(component.name)}@${component.version}`;
    invariant(!sbomByKey.has(key), `Python SBOM has duplicate component ${key}`);
    sbomByKey.set(key, component);
  }
  const installedByKey = new Map(installedPackages.map((entry) => [
    `${canonicalPackageName(entry.name)}@${entry.version}`,
    entry,
  ]));
  const expectedKeys = [...installedByKey.keys()].filter((key) => !key.startsWith("jobctrl@")).sort(bytewiseCompare);
  const missing = expectedKeys.filter((key) => !sbomByKey.has(key));
  invariant(missing.length === 0, `Python SBOM is missing installed core packages: ${missing.join(", ")}`);
  sbom.components = (sbom.components ?? []).filter((component) => installedByKey.has(`${canonicalPackageName(component.name)}@${component.version}`));
  const actualKeys = sbom.components.map((component) => `${canonicalPackageName(component.name)}@${component.version}`).sort(bytewiseCompare);
  invariant(
    JSON.stringify(actualKeys) === JSON.stringify(expectedKeys),
    `target-filtered Python SBOM does not equal installed core closure (expected ${expectedKeys.length}, received ${actualKeys.length})`,
  );
  for (const component of sbom.components) {
    const key = `${canonicalPackageName(component.name)}@${component.version}`;
    const installed = installedByKey.get(key);
    component.licenses = [{ expression: installed.license }];
  }
  sbom.metadata ??= {};
  const serialSeed = `jobctrl:python-core:darwin-arm64:${sourceDateEpoch}:${actualKeys.join(",")}`;
  sbom.serialNumber = `urn:uuid:${createHash("sha256").update(serialSeed).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5")}`;
  sbom.metadata.timestamp = new Date(sourceDateEpoch * 1000).toISOString();
  sbom.metadata.properties = [...(sbom.metadata.properties ?? []), {
    name: "jobctrl:target-filter",
    value: "darwin-arm64-cpython-3.12-installed-core-closure",
  }];
  sbom.components.sort((left, right) => bytewiseCompare(left.name, right.name));
  await writeJson(pythonSbomPath, sbom);
  return sbom;
}

async function firstExisting(paths, label) {
  for (const candidate of paths) if (await exists(candidate)) return candidate;
  throw new Error(`${label}: required license evidence is missing`);
}

async function collectTopLevelLicenseEvidence(payloadRoot, root, contracts) {
  const mcpRoot = componentRoot(payloadRoot, contracts, "playwright-mcp");
  const pythonRoot = componentRoot(payloadRoot, contracts, "python-runtime");
  const nodeRoot = componentRoot(payloadRoot, contracts, "node-runtime");
  const temporalRoot = componentRoot(payloadRoot, contracts, "temporal-runtime");
  const sources = [];
  const add = async (subject, candidates) => sources.push({ subject, source: await firstExisting(candidates, subject) });
  await add("jobctrl", [path.join(root, "LICENSE")]);
  await add("jobctrl-notice", [path.join(root, "NOTICE")]);
  await add("go-standard-library", [path.join(root, "launcher", "GO-LICENSE")]);
  await add("node-runtime", [path.join(nodeRoot, "LICENSE"), path.join(nodeRoot, "LICENSE.md"), path.join(nodeRoot, "LICENSE.txt")]);
  await add("python-runtime", [
    path.join(pythonRoot, "LICENSE.txt"),
    path.join(pythonRoot, "LICENSE"),
    path.join(pythonRoot, "lib", "python3.12", "LICENSE.txt"),
  ]);
  await add("temporal-runtime", [path.join(temporalRoot, "LICENSE"), path.join(temporalRoot, "LICENSE.txt")]);
  await add("pdfjs-renderer", [
    path.join(root, "apps", "web", "node_modules", "pdfjs-dist", "LICENSE"),
    path.join(root, "node_modules", "pdfjs-dist", "LICENSE"),
  ]);
  await add("font-jetbrains-mono", [
    path.join(root, "apps", "web", "node_modules", "@fontsource-variable", "jetbrains-mono", "LICENSE"),
    path.join(root, "node_modules", "@fontsource-variable", "jetbrains-mono", "LICENSE"),
  ]);
  await add("font-geist", [
    path.join(root, "apps", "web", "node_modules", "@fontsource-variable", "geist", "LICENSE"),
    path.join(root, "node_modules", "@fontsource-variable", "geist", "LICENSE"),
  ]);
  await add("playwright-mcp", [path.join(mcpRoot, "node_modules", "@playwright", "mcp", "LICENSE")]);
  await add("playwright-core-node", [path.join(mcpRoot, "node_modules", "playwright-core", "LICENSE")]);
  await add("chromium-core", [path.join(root, "packaging", "distribution", "licenses", "Chromium-BSD-3-Clause.txt")]);
  return sources;
}

async function browserCreditsEvidence(payloadRoot, contracts) {
  const chromiumRoot = componentRoot(payloadRoot, contracts, "chromium-core");
  const inventory = await buildFileInventory(chromiumRoot);
  const credits = inventory.filter((file) => file.type === "file" && /(^|\/)(LICENSE\.headless_shell|credits|(?:headless_)?resources\.pak|third.?party)/i.test(file.path));
  invariant(credits.length > 0, "Chromium headless-shell payload contains no license/notice resource");
  return credits.map((file) => ({
    subject: "chromium-core",
    payloadPath: path.posix.join(contracts.componentPaths.get("chromium-core"), file.path),
    sha256: file.sha256,
    note: "The bundled Chromium headless shell ships this signed license/notice resource verbatim.",
  }));
}

async function captureChromiumCredits(payloadRoot, contracts, scratchDirectory) {
  const source = path.join(
    componentRoot(payloadRoot, contracts, "chromium-core"),
    "chromium_headless_shell-1208",
    "chrome-headless-shell-mac-arm64",
    "LICENSE.headless_shell",
  );
  await requireFile(source, "bundled Chromium headless-shell license/notice evidence");
  invariant((await stat(source)).size > 100_000, "bundled Chromium headless-shell license/notice evidence is unexpectedly small");
  return source;
}

async function materializeLicenseSources(releaseRoot, sources) {
  const records = [];
  const copied = new Map();
  for (const entry of sources.sort((left, right) => bytewiseCompare(`${left.subject}:${left.source}`, `${right.subject}:${right.source}`))) {
    const digest = await sha256File(entry.source);
    const extension = path.extname(entry.source).toLowerCase();
    const filename = `${digest}${extension && extension.length <= 8 ? extension : ".txt"}`;
    if (!copied.has(digest)) {
      const destination = path.join(releaseRoot, "licenses", "texts", filename);
      await mkdir(path.dirname(destination), { recursive: true, mode: 0o755 });
      await copyFile(entry.source, destination);
      await chmod(destination, 0o644);
      copied.set(digest, path.posix.join("licenses", "texts", filename));
    }
    records.push({ subject: entry.subject, sha256: digest, path: copied.get(digest) });
  }
  return records;
}

async function pruneTemporalBridgeBuildSources(sitePackages) {
  const bridgeRoot = path.join(sitePackages, "temporalio", "bridge");
  if (!(await exists(bridgeRoot))) return { status: "temporal-bridge-not-installed", removedPaths: [] };
  const removedPaths = [];
  for (const relativePath of TEMPORAL_BRIDGE_BUILD_SOURCE_PATHS) {
    const candidate = path.join(sitePackages, ...relativePath.split("/"));
    if (await exists(candidate)) removedPaths.push(relativePath);
  }
  if (removedPaths.length === 0) return { status: "temporal-bridge-build-sources-absent", removedPaths };
  const bridgeEntries = await readdir(bridgeRoot, { withFileTypes: true });
  const nativeBridge = bridgeEntries.find((entry) => entry.isFile() && /^temporal_sdk_bridge(?:\.[A-Za-z0-9_+-]+)?\.so$/.test(entry.name));
  invariant(nativeBridge, "Temporal bridge build sources cannot be pruned without the compiled temporal_sdk_bridge extension");
  await Promise.all(removedPaths.map((relativePath) => rm(path.join(sitePackages, ...relativePath.split("/")), { recursive: true, force: true })));
  for (const relativePath of TEMPORAL_BRIDGE_BUILD_SOURCE_PATHS) {
    invariant(!(await exists(path.join(sitePackages, ...relativePath.split("/")))), `Temporal bridge build source survived pruning: ${relativePath}`);
  }
  return { status: "temporal-bridge-build-sources-pruned", removedPaths };
}

function shouldPruneInstalledPythonPath(relativePath, entry) {
  if (isGitMetadataBasename(entry.name) || entry.name.endsWith(".egg-info") || entry.name.endsWith(".pyc")) return true;
  return isTemporalBridgeBuildSourcePath(relativePath) || isKnownPythonNonRuntimePath(relativePath);
}

export async function pruneInstalledPythonTree(root) {
  const temporalBridge = await pruneTemporalBridgeBuildSources(root);
  async function visit(directory, relativeDirectory = "") {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      const relativePath = relativeDirectory ? path.posix.join(relativeDirectory, entry.name) : entry.name;
      if (FORBIDDEN_SEGMENTS.has(entry.name.toLowerCase()) || shouldPruneInstalledPythonPath(relativePath, entry)) {
        await rm(entryPath, { recursive: true, force: true });
      } else if (entry.isDirectory()) {
        await visit(entryPath, relativePath);
      }
    }
  }
  await visit(root);
  return { temporalBridge };
}

function isMachOMagic(bytes) {
  if (bytes.length < 4) return false;
  const magic = bytes.readUInt32BE(0);
  return new Set([0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe, 0xbebafeca]).has(magic);
}

async function binaryContainsNeedle(filePath, needleValues) {
  const needles = needleValues.filter(Boolean).map((value) => Buffer.from(value));
  const carryLength = Math.max(0, ...needles.map((needle) => needle.length - 1));
  let carry = Buffer.alloc(0);
  for await (const chunk of createReadStream(filePath, { highWaterMark: 1024 * 1024 })) {
    const window = Buffer.concat([carry, chunk]);
    for (const needle of needles) if (window.indexOf(needle) !== -1) return needle.toString();
    carry = window.subarray(Math.max(0, window.length - carryLength));
  }
  return null;
}

export function parseOtoolDependencies(stdout, { dylib = false } = {}) {
  const dependencies = [];
  let firstDependencyInSlice = true;
  for (const line of stdout.split("\n")) {
    if (/^\S.*:$/.test(line)) {
      firstDependencyInSlice = true;
      continue;
    }
    const match = line.match(/^\s+(\S+) \(compatibility version /);
    if (!match) continue;
    if (!(dylib && firstDependencyInSlice)) dependencies.push(match[1]);
    firstDependencyInSlice = false;
  }
  return dependencies;
}

export function parseMachOMinimumVersions(stdout) {
  const versions = [];
  let command = null;
  for (const rawLine of stdout.split("\n")) {
    const line = rawLine.trim();
    if (line.startsWith("Load command ")) {
      command = null;
    } else if (line === "cmd LC_BUILD_VERSION" || line === "cmd LC_VERSION_MIN_MACOSX") {
      command = line.slice(4);
    } else if (command === "LC_BUILD_VERSION" && line.startsWith("minos ")) {
      versions.push(line.slice("minos ".length).trim());
      command = null;
    } else if (command === "LC_VERSION_MIN_MACOSX" && line.startsWith("version ")) {
      versions.push(line.slice("version ".length).trim());
      command = null;
    }
  }
  return versions;
}

function macOsVersionParts(value) {
  invariant(/^\d+(?:\.\d+){0,2}$/.test(value), `invalid Mach-O minimum macOS version ${value}`);
  return value.split(".").map(Number);
}

export function compareMacOsVersions(left, right) {
  const leftParts = macOsVersionParts(left);
  const rightParts = macOsVersionParts(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

async function scanMachODependencies(payloadRoot, {
  forbiddenStrings = [],
  declaredMinimumOsVersion = "15.0",
} = {}) {
  const files = await buildFileInventory(payloadRoot);
  let machOCount = 0;
  let dependencyCount = 0;
  let minimumOsCheckCount = 0;
  const architectureCounts = new Map();
  const minimumOsVersionCounts = new Map();
  let maximumObservedMinimumOsVersion = "0";
  for (const file of files) {
    if (file.type !== "file") continue;
    const absolutePath = path.join(payloadRoot, ...file.path.split("/"));
    const handle = await open(absolutePath, "r");
    const magic = Buffer.alloc(4);
    try {
      await handle.read(magic, 0, 4, 0);
    } finally {
      await handle.close();
    }
    if (!isMachOMagic(magic)) continue;
    machOCount += 1;
    const leaked = await binaryContainsNeedle(absolutePath, [
      ...forbiddenStrings,
      "/opt/homebrew/",
      "/usr/local/bin/",
      ...FORBIDDEN_TOOL_INVOCATION_NEEDLES,
    ]);
    invariant(!leaked, `${file.path}: native binary contains forbidden build/runtime string ${leaked}`);
    let auditPath = absolutePath;
    let temporaryAuditPath = null;
    if (absolutePath.includes("(")) {
      temporaryAuditPath = path.join(os.tmpdir(), `jobctrl-otool-${process.pid}-${machOCount}`);
      await copyFile(absolutePath, temporaryAuditPath);
      auditPath = temporaryAuditPath;
    }
    let dependencyOutput;
    let headerOutput;
    let architectureOutput;
    let loadCommandOutput;
    try {
      ({ stdout: dependencyOutput } = await run("/usr/bin/otool", ["-L", auditPath], { cwd: payloadRoot }));
      ({ stdout: headerOutput } = await run("/usr/bin/otool", ["-hv", auditPath], { cwd: payloadRoot }));
      ({ stdout: architectureOutput } = await run("/usr/bin/lipo", ["-archs", auditPath], { cwd: payloadRoot }));
      ({ stdout: loadCommandOutput } = await run("/usr/bin/otool", ["-arch", "arm64", "-l", auditPath], { cwd: payloadRoot }));
    } finally {
      if (temporaryAuditPath) await rm(temporaryAuditPath, { force: true });
    }

    const architectures = architectureOutput.trim().split(/\s+/).filter(Boolean).sort(bytewiseCompare);
    invariant(architectures.includes("arm64"), `${file.path}: Mach-O does not contain an arm64 slice (${architectures.join(", ")})`);
    const architectureKey = architectures.join(",");
    architectureCounts.set(architectureKey, (architectureCounts.get(architectureKey) ?? 0) + 1);

    const minimumOsVersions = parseMachOMinimumVersions(loadCommandOutput);
    invariant(minimumOsVersions.length > 0, `${file.path}: arm64 Mach-O has no minimum macOS load command`);
    for (const minimumOsVersion of minimumOsVersions) {
      invariant(
        compareMacOsVersions(minimumOsVersion, declaredMinimumOsVersion) <= 0,
        `${file.path}: arm64 Mach-O requires macOS ${minimumOsVersion}, later than declared ${declaredMinimumOsVersion}`,
      );
      minimumOsCheckCount += 1;
      minimumOsVersionCounts.set(minimumOsVersion, (minimumOsVersionCounts.get(minimumOsVersion) ?? 0) + 1);
      if (compareMacOsVersions(minimumOsVersion, maximumObservedMinimumOsVersion) > 0) {
        maximumObservedMinimumOsVersion = minimumOsVersion;
      }
    }

    const dependencies = parseOtoolDependencies(dependencyOutput, { dylib: /\bDYLIB\b/.test(headerOutput) });
    dependencyCount += dependencies.length;
    for (const dependency of dependencies) {
      invariant(
        dependency.startsWith("@rpath/")
          || dependency.startsWith("@loader_path/")
          || dependency.startsWith("@executable_path/")
          || dependency.startsWith("/usr/lib/")
          || dependency.startsWith("/System/Library/"),
        `${file.path}: non-relocatable Mach-O dependency ${dependency}`,
      );
    }
  }
  invariant(machOCount > 0, "real payload contains no Mach-O binaries");
  return {
    status: "clean",
    machOCount,
    arm64MachOCount: machOCount,
    dependencyCount,
    minimumOsCheckCount,
    declaredMinimumOsVersion,
    maximumObservedMinimumOsVersion,
    architectures: Object.fromEntries([...architectureCounts].sort(([left], [right]) => bytewiseCompare(left, right))),
    minimumOsVersions: Object.fromEntries([...minimumOsVersionCounts].sort(([left], [right]) => compareMacOsVersions(left, right))),
  };
}

async function reserveLoopbackPort() {
  const { createServer } = await import("node:net");
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  invariant(address && typeof address === "object", "failed to reserve API smoke port");
  const port = address.port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

export function createExtractedRuntimeStackPlan({ payloadRoot, stateRoot, temporalPort, apiPort, contracts }) {
  invariant(path.isAbsolute(payloadRoot) && path.isAbsolute(stateRoot), "extracted runtime stack paths must be absolute");
  invariant(Number.isInteger(temporalPort) && temporalPort > 0, "Temporal smoke port must be positive");
  invariant(Number.isInteger(apiPort) && apiPort > 0, "API smoke port must be positive");
  const temporalAddress = `127.0.0.1:${temporalPort}`;
  const pythonExecutable = path.join(payloadRoot, contracts.componentPaths.get("python-runtime"), "bin", "python3");
  const nodeExecutable = path.join(payloadRoot, contracts.componentPaths.get("node-runtime"), "bin", "node");
  const temporalExecutable = path.join(payloadRoot, contracts.componentPaths.get("temporal-runtime"), "temporal");
  const environment = {
    HOME: path.join(stateRoot, "home"),
    JOBCTRL_DIR: path.join(stateRoot, "home", ".jobctrl"),
    JOBCTRL_PAYLOAD_DIR: payloadRoot,
    JOBCTRL_RUNTIME_MODE: "bundled",
    JOBCTRL_WEB_ASSETS_DIR: path.join(payloadRoot, contracts.componentPaths.get("jobctrl-web")),
    JOBCTRL_PYTHON_EXECUTABLE: pythonExecutable,
    PLAYWRIGHT_BROWSERS_PATH: path.join(payloadRoot, contracts.componentPaths.get("chromium-core")),
    TEMPORAL_ADDRESS: temporalAddress,
    TEMPORAL_NAMESPACE: "default",
    JOBCTRL_API_PORT: String(apiPort),
    JOBCTRL_API_HOST: "127.0.0.1",
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  return {
    environment,
    temporalAddress,
    temporalDbPath: path.join(environment.JOBCTRL_DIR, "temporal-smoke.db"),
    temporal: {
      command: temporalExecutable,
      args: [
        "server", "start-dev",
        "--ip", "127.0.0.1",
        "--port", String(temporalPort),
        "--db-filename", path.join(environment.JOBCTRL_DIR, "temporal-smoke.db"),
        "--headless",
        "--log-level", "error",
        "--disable-config-file",
        "--disable-config-env",
      ],
    },
    temporalHealth: {
      command: temporalExecutable,
      args: [
        "operator", "cluster", "health",
        "--address", temporalAddress,
        "--command-timeout", "2s",
        "--output", "json",
        "--disable-config-file",
        "--disable-config-env",
      ],
    },
    worker: { command: pythonExecutable, args: ["-I", "-B", "-m", "jobctrl", "worker"] },
    api: { command: nodeExecutable, args: [path.join(payloadRoot, "api", "server.mjs")] },
    apiOrigin: `http://127.0.0.1:${apiPort}`,
  };
}

const LOOPBACK_ONLY_SANDBOX_PROFILE = `(version 1)
(allow default)
(deny network-outbound (remote ip))
(allow network-outbound (remote ip "localhost:*"))`;

async function runLoopbackSandboxed(command, args, options) {
  return run("/usr/bin/sandbox-exec", ["-p", LOOPBACK_ONLY_SANDBOX_PROFILE, command, ...args], options);
}

function spawnLoopbackSandboxed(command, args, { cwd, env }) {
  const child = spawn("/usr/bin/sandbox-exec", ["-p", LOOPBACK_ONLY_SANDBOX_PROFILE, command, ...args], {
    cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });
  child.capturedOutput = () => output;
  return child;
}

function assertSmokeProcessRunning(child, label) {
  invariant(
    child.exitCode === null && child.signalCode === null,
    `${label} exited during startup: ${child.capturedOutput().slice(-4000)}`,
  );
}

async function waitForTemporalHealth(plan, temporal) {
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    assertSmokeProcessRunning(temporal, "embedded Temporal server");
    try {
      const health = await runLoopbackSandboxed(plan.temporalHealth.command, plan.temporalHealth.args, {
        cwd: plan.environment.JOBCTRL_DIR,
        env: plan.environment,
      });
      return { status: "healthy", output: health.stdout.trim() };
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`embedded Temporal health did not become ready: ${lastError?.message ?? "unknown error"}\n${temporal.capturedOutput().slice(-4000)}`);
}

async function waitForApiWorkerHealth(plan, api, worker) {
  let lastError = null;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    assertSmokeProcessRunning(api, "extracted API");
    assertSmokeProcessRunning(worker, "extracted Temporal worker");
    try {
      const response = await fetch(`${plan.apiOrigin}/v1/health`);
      if (response.ok) {
        const health = await response.json();
        if (health?.worker?.status === "healthy" && health.worker.heartbeat?.pid === worker.pid) return health;
        lastError = new Error(`worker health is ${health?.worker?.status ?? "missing"} for pid ${health?.worker?.heartbeat?.pid ?? "missing"}`);
      } else {
        lastError = new Error(`API health returned HTTP ${response.status}`);
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`extracted runtime stack did not become ready: ${lastError?.message ?? "unknown error"}\nAPI: ${api.capturedOutput().slice(-3000)}\nWorker: ${worker.capturedOutput().slice(-3000)}`);
}

async function startExtractedRuntimeStack(plan) {
  await mkdir(plan.environment.JOBCTRL_DIR, { recursive: true, mode: 0o700 });
  const temporal = spawnLoopbackSandboxed(plan.temporal.command, plan.temporal.args, {
    cwd: plan.environment.JOBCTRL_DIR,
    env: plan.environment,
  });
  let worker = null;
  let api = null;
  try {
    const temporalHealth = await waitForTemporalHealth(plan, temporal);
    worker = spawnLoopbackSandboxed(plan.worker.command, plan.worker.args, {
      cwd: plan.environment.JOBCTRL_DIR,
      env: plan.environment,
    });
    api = spawnLoopbackSandboxed(plan.api.command, plan.api.args, {
      cwd: plan.environment.JOBCTRL_DIR,
      env: plan.environment,
    });
    const apiHealth = await waitForApiWorkerHealth(plan, api, worker);
    return { temporal, worker, api, temporalHealth, apiHealth };
  } catch (error) {
    if (api) await terminateChildProcess(api).catch(() => null);
    if (worker) await terminateChildProcess(worker).catch(() => null);
    await terminateChildProcess(temporal).catch(() => null);
    throw error;
  }
}

async function terminateExtractedRuntimeStack(stack) {
  return {
    api: await terminateChildProcess(stack.api),
    worker: await terminateChildProcess(stack.worker),
    temporal: await terminateChildProcess(stack.temporal, { timeoutMs: 5000 }),
  };
}

async function smokeNativeLauncherLifecycle({ payloadRoot, extractedRoot, stockEnvironment }) {
  const launcher = path.join(payloadRoot, "launcher", "jobctrl");
  await requireFile(launcher, "native JobCtrl launcher");
  const environment = {
    ...stockEnvironment,
    JOBCTRL_RUNTIME_HOME: path.join(extractedRoot, "runtime"),
  };
  const statusJson = async () => JSON.parse((await runLoopbackSandboxed(launcher, ["status", "--json"], { cwd: extractedRoot, env: environment })).stdout);
  const waitForStatus = async (expected, label) => {
    let observed = null;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      observed = await statusJson();
      if (expected.includes(observed.status)) return observed;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${label}: lifecycle status remained ${observed?.status}`);
  };
  const start = async () => runLoopbackSandboxed(launcher, ["start", "--no-open"], { cwd: extractedRoot, env: environment });
  const stop = async () => runLoopbackSandboxed(launcher, ["stop"], { cwd: extractedRoot, env: environment });
  let lifecycleStarted = false;
  try {
    const firstStart = await start();
    lifecycleStarted = true;
    invariant(firstStart.stdout.includes("http://127.0.0.1:8766"), "native launcher did not report fixed API URL");
    let health = null;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        const response = await fetch("http://127.0.0.1:8766/v1/health");
        if (response.ok) {
          health = await response.json();
          if (health?.worker?.status === "healthy") break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    invariant(health?.worker?.status === "healthy", "native launcher API health was not healthy");
    let status = await statusJson();
    invariant(status.status === "running", `native launcher status is ${status.status}`);
    for (const component of ["temporal", "worker", "api"]) invariant(status.components?.[component]?.state === "running", `native launcher ${component} status is not running`);
    const logs = await runLoopbackSandboxed(launcher, ["logs"], { cwd: extractedRoot, env: environment });
    invariant(logs.stdout.includes("== temporal ==") && logs.stdout.includes("== worker ==") && logs.stdout.includes("== api =="), "native launcher logs did not route all bounded component logs");
    const version = JSON.parse((await runLoopbackSandboxed(launcher, ["version", "--json"], { cwd: extractedRoot, env: environment })).stdout);
    invariant(typeof version.buildId === "string" && /^[a-f0-9]{64}$/.test(version.manifestSha256), "native launcher version JSON is incomplete");
    await runLoopbackSandboxed(launcher, ["doctor"], { cwd: extractedRoot, env: environment });
    const digest = await runLoopbackSandboxed(launcher, ["digest", "--json"], { cwd: extractedRoot, env: environment });
    invariant(digest.stdout.trim().startsWith("{"), "native launcher did not transparently dispatch JSON Python CLI command");
    await runLoopbackSandboxed(launcher, ["pipeline-status"], { cwd: extractedRoot, env: environment });
    await runLoopbackSandboxed(launcher, ["status", "--pipeline"], { cwd: extractedRoot, env: environment });
    // A killed owned worker leaves a degraded registry rather than a misleading
    // healthy status. stop then obtains a clean restart from that evidence.
    process.kill(status.components.worker.pid, "SIGKILL");
    const degraded = await waitForStatus(["degraded"], "worker-kill recovery");
    invariant(degraded.components.worker.state !== "running", "killed worker remained reported as running");
    await stop();
    await waitForStatus(["stopped"], "worker-kill stop");
    await start();
    status = await waitForStatus(["running"], "worker-kill restart");
    // SIGKILL of the supervisor cannot run its cleanup handler. Status must
    // report the still-owned component trees as orphaned, and stop must clean
    // only the identity-matching recorded groups before restart.
    invariant(Number.isInteger(status.supervisorPid) && status.supervisorPid > 0, "native status omitted supervisor PID");
    process.kill(status.supervisorPid, "SIGKILL");
    const orphaned = await waitForStatus(["orphaned"], "supervisor-kill recovery");
    invariant(orphaned.components.api.state === "running", "orphaned API ownership was not reported");
    await stop();
    await waitForStatus(["stopped"], "supervisor-kill stop");
    await start();
    status = await waitForStatus(["running"], "supervisor-kill restart");
    await stop();
    const stopped = await waitForStatus(["stopped"], "final stop");
    return { startUrl: "http://127.0.0.1:8766", components: Object.keys(status.components).sort(bytewiseCompare), manifestSha256: version.manifestSha256, pipelineStatusCompatibility: "passed", pythonDispatch: ["doctor", "digest --json"], recovery: { workerKill: "degraded-stop-restart", supervisorKill: "orphaned-stop-restart" } };
  } finally {
    if (lifecycleStarted) await stop().catch(() => null);
  }
}

async function cleanupNativeLauncherRuntime(extractedRoot) {
  const canonicalRoot = await realpath(extractedRoot).catch(() => null);
  if (!canonicalRoot) return { status: "not-created" };
  const launcher = path.join(canonicalRoot, "payload", "launcher", "jobctrl");
  if (!(await exists(launcher))) return { status: "launcher-not-created" };
  const environment = {
    HOME: path.join(canonicalRoot, "home"),
    JOBCTRL_DIR: path.join(canonicalRoot, "home", ".jobctrl"),
    JOBCTRL_RUNTIME_HOME: path.join(canonicalRoot, "runtime"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  try {
    await runLoopbackSandboxed(launcher, ["stop"], { cwd: canonicalRoot, env: environment });
    return { status: "stopped" };
  } catch (error) {
    return { status: "stop-failed", error: error.message };
  }
}

// A network-channel pre-sign candidate intentionally carries the same
// unsigned-local manifest envelope as a developer build.  Its launcher is
// already compiled for that network channel, but it cannot yet pass the native
// lifecycle's signature/manifest admission checks until finalization has
// signed, notarized, stapled, and re-manifested the immutable bytes.  Keep the
// boundary explicit: every direct payload smoke still runs, while only that
// unavailable lifecycle is deferred to the published native-install smoke.
export function nativeLauncherLifecycleSmokeRequirement(nativeLauncherReleaseChannel = "local") {
  invariant(RELEASE_CHANNELS.has(nativeLauncherReleaseChannel), "native launcher lifecycle smoke release channel is invalid");
  if (nativeLauncherReleaseChannel === "local") return { status: "required" };
  return {
    status: "skipped",
    reason: "pre-sign-unavailable",
    releaseChannel: nativeLauncherReleaseChannel,
  };
}

async function requireJsonResponse(url, options, label) {
  const response = await fetch(url, options);
  const text = await response.text();
  invariant(response.ok, `${label} failed with HTTP ${response.status}: ${text.slice(0, 1000)}`);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} did not return JSON: ${error.message}`);
  }
}

export function extensionCaptureSmokeHeaders(token) {
  invariant(typeof token === "string" && token.length >= 32, "extension smoke token is invalid");
  return {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sec-fetch-site": "cross-site",
  };
}

async function submitExtensionCaptureFixture(plan, { captureId, jobUrl, captureHtml }) {
  const pairing = await requireJsonResponse(
    `${plan.apiOrigin}/v1/extension/pairing-token`,
    { method: "GET" },
    "extension pairing-token smoke",
  );
  invariant(typeof pairing?.token === "string" && pairing.token.length >= 32, "extension pairing-token smoke returned no token");
  const result = await requireJsonResponse(
    `${plan.apiOrigin}/v1/extension/captures`,
    {
      method: "POST",
      headers: extensionCaptureSmokeHeaders(pairing.token),
      body: JSON.stringify({
        captureId,
        originatingUrl: jobUrl,
        captureMode: "saved_html",
        capturedUrl: jobUrl,
        contentText: captureHtml,
        futureManualActionRequired: false,
        captureClient: "browser_extension",
        extensionVersion: "distribution-smoke",
      }),
    },
    "extension saved-HTML capture smoke",
  );
  invariant(result?.ok === true && result.jobKey === jobUrl, "extension capture smoke did not return the imported fixture job");
  return { itemId: result.itemId, jobKey: result.jobKey, importedAt: result.importedAt };
}

async function waitForApiWorkflow(plan, workflowType) {
  let last = null;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    last = await requireJsonResponse(
      `${plan.apiOrigin}/v1/workflow-runs?page=1&pageSize=50&status=all`,
      { method: "GET" },
      "workflow projection smoke",
    );
    const run = (last.items ?? []).find((item) => item.workflowType === workflowType);
    if (run?.status === "succeeded") return run;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${workflowType} did not reach a succeeded API projection: ${JSON.stringify(last).slice(-2000)}`);
}

async function requirePersistedJob(plan, jobUrl) {
  const jobs = await requireJsonResponse(`${plan.apiOrigin}/v1/jobs`, { method: "GET" }, "persisted jobs smoke");
  invariant(JSON.stringify(jobs).includes(jobUrl), "extracted API did not return the workflow-imported offline fixture job");
  return true;
}

async function describeTemporalWorkflow(plan, workflowId) {
  const probe = await runLoopbackSandboxed(plan.worker.command, [
    "-I", "-B", "-c",
    `import asyncio
import json
import os
from temporalio.client import Client

async def main():
    client = await Client.connect(os.environ["TEMPORAL_ADDRESS"], namespace=os.environ.get("TEMPORAL_NAMESPACE", "default"))
    description = await client.get_workflow_handle(os.environ["JOBCTRL_SMOKE_WORKFLOW_ID"]).describe()
    print(json.dumps({"runId": description.run_id, "status": description.status.name}, sort_keys=True))

asyncio.run(main())`,
  ], {
    cwd: plan.environment.JOBCTRL_DIR,
    env: { ...plan.environment, JOBCTRL_SMOKE_WORKFLOW_ID: workflowId },
  });
  const description = JSON.parse(probe.stdout.trim());
  invariant(/completed/i.test(description.status), `Temporal workflow ${workflowId} is not completed: ${description.status}`);
  return description;
}

export async function terminateChildProcess(child, { timeoutMs = 3000 } = {}) {
  invariant(Number.isInteger(timeoutMs) && timeoutMs >= 0, "child termination timeout must be non-negative");
  if (child.exitCode !== null || child.signalCode !== null) {
    return { status: "exited", exitCode: child.exitCode, signalCode: child.signalCode, forced: false };
  }
  const exitPromise = once(child, "exit").then(([exitCode, signalCode]) => ({ exitCode, signalCode }));
  child.kill("SIGTERM");
  let timeout;
  const timeoutPromise = new Promise((resolve) => {
    timeout = setTimeout(() => resolve(null), timeoutMs);
  });
  let exit = await Promise.race([exitPromise, timeoutPromise]);
  clearTimeout(timeout);
  let forced = false;
  if (exit === null) {
    forced = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    exit = await exitPromise;
  }
  invariant(exit.exitCode !== null || exit.signalCode !== null, "child exited without an exit code or signal");
  return { status: "exited", ...exit, forced };
}

async function smokePlaywrightMcpProtocol(command, args, { cwd, env }) {
  const child = spawn("/usr/bin/sandbox-exec", ["-p", LOOPBACK_ONLY_SANDBOX_PROFILE, command, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let stderr = "";
  let pending = "";
  let nextId = 0;
  const responses = new Map();
  const waiters = new Map();
  const fail = (error) => {
    for (const waiter of waiters.values()) {
      clearTimeout(waiter.timeout);
      waiter.reject(error);
    }
    waiters.clear();
  };
  child.on("error", fail);
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdout.on("data", (chunk) => {
    output += chunk;
    pending += chunk;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) break;
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line) continue;
      let response;
      try {
        response = JSON.parse(line);
      } catch {
        continue;
      }
      if (response.id === undefined) continue;
      if (waiters.has(response.id)) {
        const waiter = waiters.get(response.id);
        waiters.delete(response.id);
        clearTimeout(waiter.timeout);
        waiter.resolve(response);
      } else {
        responses.set(response.id, response);
      }
    }
  });
  child.on("exit", (exitCode, signalCode) => {
    fail(new Error(`Playwright MCP protocol smoke exited early (${exitCode ?? signalCode}): ${(stderr || output).slice(-4000)}`));
  });
  const request = async (method, params) => {
    const id = ++nextId;
    const response = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        waiters.delete(id);
        reject(new Error(`Playwright MCP ${method} response timed out: ${(stderr || output).slice(-4000)}`));
      }, 30_000);
      if (responses.has(id)) {
        const message = responses.get(id);
        responses.delete(id);
        clearTimeout(timeout);
        resolve(message);
      } else {
        waiters.set(id, { resolve, reject, timeout });
      }
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return response;
  };
  try {
    const initialize = await request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "jobctrl-distribution-smoke", version: "1.0.0" },
    });
    invariant(initialize.result?.serverInfo?.name === "Playwright", "bundled Playwright MCP initialize returned an unexpected server");
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    const tools = await request("tools/list", {});
    const toolNames = (tools.result?.tools ?? []).map((tool) => tool.name).sort(bytewiseCompare);
    for (const required of ["browser_navigate", "browser_snapshot"]) {
      invariant(toolNames.includes(required), `bundled Playwright MCP did not advertise ${required}`);
    }
    const marker = "jobctrl-mcp-local-browser-smoke";
    const navigation = await request("tools/call", {
      name: "browser_navigate",
      arguments: { url: `data:text/html,<title>${marker}</title><main>${marker}</main>` },
    });
    invariant(navigation.isError !== true, `bundled Playwright MCP navigation failed: ${JSON.stringify(navigation).slice(-2000)}`);
    const snapshot = await request("tools/call", { name: "browser_snapshot", arguments: {} });
    invariant(snapshot.isError !== true, `bundled Playwright MCP snapshot failed: ${JSON.stringify(snapshot).slice(-2000)}`);
    invariant(JSON.stringify(snapshot).includes(marker), "bundled Playwright MCP snapshot did not observe the managed local browser page");
    return {
      protocolVersion: initialize.result.protocolVersion,
      server: initialize.result.serverInfo,
      toolCount: toolNames.length,
      requiredTools: ["browser_navigate", "browser_snapshot"],
      localManagedChromiumNavigation: "passed",
    };
  } finally {
    child.stdin.end();
    await terminateChildProcess(child, { timeoutMs: 3_000 }).catch(() => {});
  }
}

async function managedMcpChromiumExecutable(payloadRoot, contracts) {
  invariant(contracts.platform.id === "darwin-arm64", `unsupported MCP Chromium smoke platform: ${contracts.platform.id}`);
  const executable = path.join(
    componentRoot(payloadRoot, contracts, "chromium-core"),
    "chromium_headless_shell-1208",
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell",
  );
  return requireFile(executable, "managed Chromium executable for Playwright MCP smoke");
}

export async function assertHeadlessChromiumPayload(payloadRoot, contracts) {
  const chromiumRoot = componentRoot(payloadRoot, contracts, "chromium-core");
  const files = await buildFileInventory(chromiumRoot);
  const required = "chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell";
  const executable = files.filter((file) => file.type === "file" && file.path === required);
  invariant(executable.length === 1, "core Chromium payload must contain exactly one managed headless-shell executable");
  const topLevel = [...new Set(files.map((file) => file.path.split("/")[0]))].sort(bytewiseCompare);
  invariant(JSON.stringify(topLevel) === JSON.stringify(["chromium_headless_shell-1208"]), `core Chromium payload has unexpected browser revisions: ${topLevel.join(", ")}`);
  invariant(files.filter((file) => file.type === "file" && path.posix.basename(file.path) === "chrome-headless-shell").length === 1, "core Chromium payload must not contain an extra headless-shell revision");
  const forbidden = files.filter((file) => file.path.startsWith("chromium-") || file.path.includes(".app/") || file.path.includes("Google Chrome for Testing"));
  invariant(forbidden.length === 0, `core Chromium payload must exclude the full browser topology: ${forbidden.map((file) => file.path).join(", ")}`);
  return { executable: path.join(chromiumRoot, ...required.split("/")), fileCount: files.length };
}

export async function prepareExtractedSmokeLayout({ archivePath, outputRoot }) {
  const extractedRoot = path.join(outputRoot, "clean-extraction");
  await rm(extractedRoot, { recursive: true, force: true });
  const extractionPayloadRoot = path.join(extractedRoot, "payload");
  await mkdir(extractionPayloadRoot, { recursive: true, mode: 0o755 });
  // This uses the stock platform ZIP extractor rather than the builder's own
  // parser, exercising the same transport shape an installed release uses.
  await run("/usr/bin/unzip", ["-q", archivePath, "-d", extractionPayloadRoot], { cwd: outputRoot });
  // Python resolves the state directory before writing its heartbeat while
  // Node's path.resolve does not collapse macOS /tmp -> /private/tmp. Anchor
  // the payload and its sibling state root to canonical identities before
  // either child starts so the API correctly accepts its worker heartbeat.
  const canonicalExtractedRoot = await realpath(extractedRoot);
  const payloadRoot = await realpath(path.join(canonicalExtractedRoot, "payload"));
  const homeRoot = path.join(canonicalExtractedRoot, "home");
  await mkdir(homeRoot, { recursive: true, mode: 0o700 });
  const canonicalHomeRoot = await realpath(homeRoot);
  const stateRoot = path.join(canonicalHomeRoot, ".jobctrl");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const canonicalStateRoot = await realpath(stateRoot);
  invariant(
    canonicalHomeRoot !== payloadRoot
      && !canonicalHomeRoot.startsWith(`${payloadRoot}${path.sep}`)
      && !payloadRoot.startsWith(`${canonicalHomeRoot}${path.sep}`)
      && canonicalStateRoot !== payloadRoot
      && !canonicalStateRoot.startsWith(`${payloadRoot}${path.sep}`)
      && !payloadRoot.startsWith(`${canonicalStateRoot}${path.sep}`),
    "distribution smoke HOME/state must be a sibling of the immutable payload root",
  );
  return {
    extractedRoot,
    canonicalExtractedRoot,
    payloadRoot,
    homeRoot: canonicalHomeRoot,
    stateRoot: canonicalStateRoot,
  };
}

async function smokeExtractedPayload(archivePath, outputRoot, contracts, {
  nativeLauncherReleaseChannel = "local",
} = {}) {
  const {
    canonicalExtractedRoot,
    payloadRoot,
    homeRoot,
    stateRoot,
  } = await prepareExtractedSmokeLayout({ archivePath, outputRoot });
  const manifest = JSON.parse(await readFile(path.join(payloadRoot, "manifest.json"), "utf8"));
  validateDistributionManifest(manifest, contracts);
  await verifyExactPayloadTree(payloadRoot, manifest);
  await assertHeadlessChromiumPayload(payloadRoot, contracts);
  const extractionForbiddenAudit = await scanForbiddenPayload(payloadRoot, { forbiddenAbsolutePaths: [REPO_ROOT, outputRoot] });

  const stockEnvironment = {
    HOME: homeRoot,
    JOBCTRL_DIR: stateRoot,
    JOBCTRL_PAYLOAD_DIR: payloadRoot,
    JOBCTRL_RUNTIME_MODE: "bundled",
    JOBCTRL_WEB_ASSETS_DIR: path.join(payloadRoot, contracts.componentPaths.get("jobctrl-web")),
    JOBCTRL_PYTHON_EXECUTABLE: path.join(payloadRoot, contracts.componentPaths.get("python-runtime"), "bin", "python3"),
    PLAYWRIGHT_BROWSERS_PATH: path.join(payloadRoot, contracts.componentPaths.get("chromium-core")),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  await mkdir(stockEnvironment.JOBCTRL_DIR, { recursive: true, mode: 0o700 });
  const nodeExecutable = path.join(payloadRoot, contracts.componentPaths.get("node-runtime"), "bin", "node");
  const networkProbe = await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
    "-I", "-B", "-c",
    `import json
import socket

sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect(("1.1.1.1", 443))
except PermissionError as error:
    assert error.errno == 1, error
    print(json.dumps({"status": "blocked", "error": "EPERM", "target": "1.1.1.1:443"}, sort_keys=True))
else:
    raise SystemExit("non-loopback network unexpectedly allowed")
finally:
    sock.close()`,
  ], { cwd: payloadRoot, env: stockEnvironment });
  const networkIsolation = {
    mechanism: "macos-sandbox-exec",
    policy: "loopback-only-outbound-ip",
    profileSha256: createHash("sha256").update(LOOPBACK_ONLY_SANDBOX_PROFILE).digest("hex"),
    nonLoopbackProbe: JSON.parse(networkProbe.stdout.trim()),
  };
  const nodeVersion = (await runLoopbackSandboxed(nodeExecutable, ["--version"], { cwd: payloadRoot, env: stockEnvironment })).stdout.trim();
  invariant(nodeVersion === `v${contracts.versions["node-runtime"]}`, `embedded Node version mismatch: ${nodeVersion}`);
  const mcpProtocol = await smokePlaywrightMcpProtocol(
    path.join(payloadRoot, contracts.componentPaths.get("playwright-mcp"), "bin", "playwright-mcp"),
    [
      "--headless",
      "--isolated",
      "--output-dir", path.join(canonicalExtractedRoot, "playwright-mcp-smoke-output"),
      "--executable-path", await managedMcpChromiumExecutable(payloadRoot, contracts),
      "--output-mode", "stdout",
      "--codegen", "none",
    ],
    { cwd: payloadRoot, env: stockEnvironment },
  );
  await runLoopbackSandboxed(nodeExecutable, [
    "-e",
    `const Database=require(${JSON.stringify(path.join(payloadRoot, "api", "node_modules", "better-sqlite3"))});const db=new Database(':memory:');db.exec('create table smoke(value integer);insert into smoke values (1)');if(db.prepare('select value from smoke').get().value!==1)process.exit(2);db.close();`,
  ], { cwd: payloadRoot, env: stockEnvironment });
  await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, ["-I", "-B", "-m", "jobctrl", "--help"], { cwd: payloadRoot, env: stockEnvironment });
  await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
    "-I", "-B", "-c",
    "import ctypes, hashlib, importlib.util, json, multiprocessing, sqlite3, ssl, urllib.request\nfor name in ('_tkinter', 'tkinter', 'idlelib', 'turtledemo', 'turtle'):\n    assert importlib.util.find_spec(name) is None, name",
  ], { cwd: payloadRoot, env: stockEnvironment });
  await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
    "-I", "-B", "-c",
    "import tls_client\nfrom tls_client.cffi import library\nassert library is not None",
  ], { cwd: payloadRoot, env: stockEnvironment });
  const offlineFixtureUrl = "https://offline.fixture.invalid/jobs/distribution-smoke";
  const fixtureDescription = ("Build local-first job search infrastructure with Python, TypeScript, observability, "
    + "reliable workflow automation, product strategy, and privacy-preserving systems. ").repeat(6);
  const fixtureJsonLd = {
    "@context": "https://schema.org",
    "@type": "JobPosting",
    title: "Distribution Smoke Engineer",
    description: fixtureDescription,
    directApply: true,
    url: offlineFixtureUrl,
    validThrough: "2999-01-01T00:00:00+00:00",
    hiringOrganization: { "@type": "Organization", name: "Offline Fixture" },
    jobLocation: {
      "@type": "Place",
      address: { "@type": "PostalAddress", addressLocality: "Barcelona", addressCountry: "Spain" },
    },
  };
  const fixtureCaptureHtml = `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(fixtureJsonLd)}</script></head><body><h1>Distribution Smoke Engineer</h1><p>${fixtureDescription}</p></body></html>`;
  const fixtureSetup = await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
    "-I", "-B", "-c",
    `import json
import os
from pathlib import Path

from jobctrl.infrastructure.materials.html_resume_pdf import render_resume_html_to_pdf

pdf_path = Path(os.environ["JOBCTRL_DIR"]) / "distribution-smoke.pdf"
resume_html = """<!doctype html><html><head><meta charset='utf-8'><style>@page { size: A4; margin: 18mm; } body { font-family: sans-serif; color: #111; } h1 { font-size: 24px; }</style></head><body><h1>Distribution Smoke Resume</h1><p>Production HTML to PDF rendering from the bundled Python worker and Chromium runtime.</p></body></html>"""
render_resume_html_to_pdf(resume_html, str(pdf_path))
pdf_bytes = pdf_path.read_bytes()
assert pdf_bytes.startswith(b"%PDF-"), pdf_bytes[:16]
assert len(pdf_bytes) > 1000, len(pdf_bytes)
print(json.dumps({"pdfPath": str(pdf_path), "pdfBytes": len(pdf_bytes)}, sort_keys=True))`,
  ], { cwd: payloadRoot, env: stockEnvironment });
  const fixtureEvidence = JSON.parse(fixtureSetup.stdout.trim());
  invariant(fixtureEvidence.pdfBytes > 1000, "production PDF renderer produced an empty PDF");

  const webAssetsRoot = path.join(payloadRoot, contracts.componentPaths.get("jobctrl-web"), "assets");
  const webAssetNames = await readdir(webAssetsRoot);
  const pdfModuleNames = webAssetNames.filter((name) => /^pdf-[A-Za-z0-9_-]+\.js$/.test(name));
  const pdfWorkerNames = webAssetNames.filter((name) => /^pdf\.worker-[A-Za-z0-9_-]+\.mjs$/.test(name));
  invariant(pdfModuleNames.length === 1, `expected one bundled PDF.js module, found ${pdfModuleNames.join(", ")}`);
  invariant(pdfWorkerNames.length === 1, `expected one bundled PDF.js worker module, found ${pdfWorkerNames.join(", ")}`);

  const apiPort = await reserveLoopbackPort();
  const temporalPort = await reserveLoopbackPort();
  const runtimePlan = createExtractedRuntimeStackPlan({
    payloadRoot,
    stateRoot: canonicalExtractedRoot,
    temporalPort,
    apiPort,
    contracts,
  });
  const firstStack = await startExtractedRuntimeStack(runtimePlan);
  let pdfPreviewEvidence = null;
  let captureEvidence = null;
  let workflowEvidence = null;
  let workflowDetailEvidence = null;
  let firstTemporalDescription = null;
  let firstTermination = null;
  try {
    captureEvidence = await submitExtensionCaptureFixture(runtimePlan, {
      captureId: "distribution-smoke-capture",
      jobUrl: offlineFixtureUrl,
      captureHtml: fixtureCaptureHtml,
    });
    workflowEvidence = await waitForApiWorkflow(runtimePlan, "ManualCaptureImportWorkflow");
    workflowDetailEvidence = await requireJsonResponse(
      `${runtimePlan.apiOrigin}/v1/workflow-runs/${encodeURIComponent(workflowEvidence.workflowId)}`,
      { method: "GET" },
      "manual-capture workflow history smoke",
    );
    const workflowEventTypes = new Set((workflowDetailEvidence.events ?? []).map((event) => event.eventType));
    invariant(workflowEventTypes.has("WorkflowStarted") && workflowEventTypes.has("WorkflowCompleted"), "manual-capture workflow history is missing started/completed events");
    await requirePersistedJob(runtimePlan, offlineFixtureUrl);
    firstTemporalDescription = await describeTemporalWorkflow(runtimePlan, workflowEvidence.workflowId);
    invariant(
      workflowDetailEvidence.temporalRunId === firstTemporalDescription.runId,
      "manual-capture workflow projection does not identify the completed Temporal run",
    );
    const webResponse = await fetch(`${runtimePlan.apiOrigin}/`);
    invariant(webResponse.ok && (await webResponse.text()).includes("<html"), "extracted API did not serve the bundled web app");

    const browserSmoke = await runLoopbackSandboxed(stockEnvironment.JOBCTRL_PYTHON_EXECUTABLE, [
      "-I", "-B", "-c",
      `import base64
import json
import os
from pathlib import Path

from playwright.sync_api import sync_playwright

origin = os.environ["JOBCTRL_SMOKE_ORIGIN"]
pdf_bytes = Path(os.environ["JOBCTRL_SMOKE_PDF_PATH"]).read_bytes()
evaluation_input = {
    "pdfBase64": base64.b64encode(pdf_bytes).decode("ascii"),
    "pdfModuleUrl": origin + "/assets/" + os.environ["JOBCTRL_SMOKE_PDF_MODULE"],
    "pdfWorkerUrl": origin + "/assets/" + os.environ["JOBCTRL_SMOKE_PDF_WORKER"],
}
render_script = """async (input) => {
  const pdfjs = await import(input.pdfModuleUrl);
  const worker = await import(input.pdfWorkerUrl);
  if (typeof pdfjs.getDocument !== "function") throw new Error("bundled PDF.js module does not export getDocument");
  globalThis.pdfjsWorker = worker;
  pdfjs.GlobalWorkerOptions.workerSrc = input.pdfWorkerUrl;
  const bytes = Uint8Array.from(atob(input.pdfBase64), (character) => character.charCodeAt(0));
  const loadingTask = pdfjs.getDocument({ data: bytes });
  const document = await loadingTask.promise;
  const firstPage = await document.getPage(1);
  const textContent = await firstPage.getTextContent();
  const text = textContent.items.map((item) => item.str ?? "").join(" ");
  const viewport = firstPage.getViewport({ scale: 1 });
  const canvas = window.document.createElement("canvas");
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("canvas 2D context unavailable");
  await firstPage.render({ canvas, canvasContext: context, viewport }).promise;
  let nonZeroPixelBytes = 0;
  let readbackAttempts = 0;
  for (; readbackAttempts < 5 && nonZeroPixelBytes === 0; readbackAttempts += 1) {
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    for (const value of pixels) if (value !== 0) nonZeroPixelBytes += 1;
    if (nonZeroPixelBytes === 0) await new Promise((resolve) => requestAnimationFrame(() => resolve()));
  }
  await document.destroy();
  return { width: canvas.width, height: canvas.height, nonZeroPixelBytes, readbackAttempts, text };
}"""

def preview_attempt(playwright):
    browser = playwright.chromium.launch(headless=True)
    try:
        page = browser.new_page()
        response = page.goto(origin, wait_until="domcontentloaded")
        assert response is not None and response.ok, response
        smoke_document_url = origin + "/__jobctrl_distribution_pdf_smoke"
        page.route(
            smoke_document_url,
            lambda route: route.fulfill(
                status=200,
                content_type="text/html",
                body="<!doctype html><html><body>JobCtrl PDF preview smoke</body></html>",
            ),
        )
        smoke_response = page.goto(smoke_document_url, wait_until="domcontentloaded")
        assert smoke_response is not None and smoke_response.ok, smoke_response
        return page.evaluate(render_script, evaluation_input)
    finally:
        browser.close()

with sync_playwright() as playwright:
    from pathlib import Path
    import os
    browser_root = Path(os.environ["PLAYWRIGHT_BROWSERS_PATH"])
    required_headless = browser_root / "chromium_headless_shell-1208" / "chrome-headless-shell-mac-arm64" / "chrome-headless-shell"
    assert required_headless.is_file(), required_headless
    assert not any(browser_root.glob("chromium-*")), list(browser_root.glob("chromium-*"))
    assert not any(browser_root.rglob("*.app")), "full browser app bundle entered the core payload"
    assert not any("Google Chrome for Testing" in str(candidate) for candidate in browser_root.rglob("*")), "full Chrome-for-Testing entered the core payload"
    browser_attempts = []
    result = None
    for browser_attempt in range(1, 4):
        result = preview_attempt(playwright)
        assert result["width"] > 0 and result["height"] > 0, result
        assert "Distribution Smoke Resume" in result["text"], result
        browser_attempts.append({
            "browserAttempt": browser_attempt,
            "nonZeroPixelBytes": result["nonZeroPixelBytes"],
            "readbackAttempts": result["readbackAttempts"],
        })
        if result["nonZeroPixelBytes"] > 0:
            break
    assert result is not None and result["nonZeroPixelBytes"] > 0, {"attempts": browser_attempts, "lastResult": result}
    print(json.dumps({
        "browserExecutable": str(required_headless),
        "browserLaunchAttempts": browser_attempts,
        "rootNavigation": True,
        "isolatedSameOriginDocument": True,
        **result,
    }, sort_keys=True))`,
    ], {
      cwd: payloadRoot,
      env: {
        ...runtimePlan.environment,
        JOBCTRL_SMOKE_ORIGIN: runtimePlan.apiOrigin,
        JOBCTRL_SMOKE_PDF_PATH: fixtureEvidence.pdfPath,
        JOBCTRL_SMOKE_PDF_MODULE: pdfModuleNames[0],
        JOBCTRL_SMOKE_PDF_WORKER: pdfWorkerNames[0],
      },
    });
    pdfPreviewEvidence = JSON.parse(browserSmoke.stdout.trim());
    invariant(
      pdfPreviewEvidence.rootNavigation === true && pdfPreviewEvidence.isolatedSameOriginDocument === true,
      "bundled PDF.js smoke did not prove the real root plus isolated same-origin harness boundary",
    );
    invariant(pdfPreviewEvidence.width > 0 && pdfPreviewEvidence.height > 0 && pdfPreviewEvidence.nonZeroPixelBytes > 0, "bundled PDF.js page preview smoke failed");
  } finally {
    firstTermination = await terminateExtractedRuntimeStack(firstStack);
  }
  invariant(firstTermination?.api?.status === "exited" && firstTermination.worker?.status === "exited" && firstTermination.temporal?.status === "exited", "first extracted runtime stack did not terminate");

  const secondStack = await startExtractedRuntimeStack(runtimePlan);
  let secondTermination = null;
  let secondTemporalDescription = null;
  let restartEvidence = null;
  try {
    invariant(secondStack.worker.pid !== firstStack.worker.pid, "runtime restart reused the first worker pid");
    invariant(
      secondStack.apiHealth.worker.heartbeat.workerId !== firstStack.apiHealth.worker.heartbeat.workerId,
      "runtime restart reused the first worker heartbeat identity",
    );
    invariant(secondStack.apiHealth.dbIdentity === firstStack.apiHealth.dbIdentity, "runtime restart changed the JobCtrl DB identity");
    invariant(secondStack.apiHealth.worker.heartbeat.pid === secondStack.worker.pid, "runtime restart health does not identify the fresh worker");
    await requirePersistedJob(runtimePlan, offlineFixtureUrl);
    const persistedWorkflow = await requireJsonResponse(
      `${runtimePlan.apiOrigin}/v1/workflow-runs/${encodeURIComponent(workflowEvidence.workflowId)}`,
      { method: "GET" },
      "persisted workflow projection smoke",
    );
    invariant(persistedWorkflow?.status === "succeeded", "runtime restart lost the completed manual-capture workflow projection");
    invariant(
      JSON.stringify(persistedWorkflow.events) === JSON.stringify(workflowDetailEvidence.events),
      "runtime restart changed the completed manual-capture workflow history",
    );
    secondTemporalDescription = await describeTemporalWorkflow(runtimePlan, workflowEvidence.workflowId);
    invariant(secondTemporalDescription.runId === firstTemporalDescription.runId, "runtime restart changed the persisted Temporal run identity");
    restartEvidence = {
      status: "pass",
      firstWorkerPid: firstStack.worker.pid,
      secondWorkerPid: secondStack.worker.pid,
      firstWorkerId: firstStack.apiHealth.worker.heartbeat.workerId,
      secondWorkerId: secondStack.apiHealth.worker.heartbeat.workerId,
      dbIdentity: secondStack.apiHealth.dbIdentity,
      jobPersisted: true,
      workflowProjectionPersisted: true,
      temporalRunPersisted: true,
    };
  } finally {
    secondTermination = await terminateExtractedRuntimeStack(secondStack);
  }
  invariant(secondTermination?.api?.status === "exited" && secondTermination.worker?.status === "exited" && secondTermination.temporal?.status === "exited", "restarted extracted runtime stack did not terminate");
  const nativeLauncherLifecycleRequirement = nativeLauncherLifecycleSmokeRequirement(nativeLauncherReleaseChannel);
  const nativeLauncherLifecycle = nativeLauncherLifecycleRequirement.status === "required"
    ? await smokeNativeLauncherLifecycle({ payloadRoot, extractedRoot: canonicalExtractedRoot, stockEnvironment })
    : nativeLauncherLifecycleRequirement;
  await verifyExactPayloadTree(payloadRoot, manifest);
  return {
    status: "pass",
    nodeVersion,
    playwrightMcp: mcpProtocol,
    tlsClientNative: "darwin-arm64-load-pass",
    dbBackedRoute: "/v1/jobs",
    browserRevision: 1208,
    offlineManualCaptureJob: offlineFixtureUrl,
    manualCaptureWorkflow: {
      itemId: captureEvidence.itemId,
      workflowId: workflowEvidence.workflowId,
      status: workflowEvidence.status,
      temporalRunId: secondTemporalDescription.runId,
    },
    productionPdfBytes: fixtureEvidence.pdfBytes,
    pdfPreview: pdfPreviewEvidence,
    runtimeRestart: restartEvidence,
    runtimeTermination: { first: firstTermination, second: secondTermination },
    nativeLauncherLifecycle,
    networkIsolation,
    postSmokePayloadTree: "exact-manifest-match",
    extractionForbiddenAudit,
  };
}

export async function smokeExistingRealArtifact({ outputDirectory, root = REPO_ROOT } = {}) {
  invariant(outputDirectory, "existing real artifact smoke requires outputDirectory");
  const contracts = await loadBuildContracts(root);
  const outputRoot = path.resolve(outputDirectory);
  const archivePath = path.join(outputRoot, `jobctrl-${contracts.versions["jobctrl-launcher"]}-${contracts.platform.id}.zip`);
  invariant(await exists(archivePath), `existing real artifact archive is missing: ${archivePath}`);
  return smokeExtractedPayload(archivePath, outputRoot, contracts);
}

function filesMatchingSizeSpec(files, spec) {
  if (!spec) return [];
  return files.filter((file) => spec.paths.includes(file.path)
    || spec.prefixes.some((prefix) => file.path === prefix || file.path.startsWith(prefix)));
}

function summarizeSelectedFiles(files) {
  invariant(files.length > 0, "component size selection contains no files");
  const selected = [...files].sort((left, right) => bytewiseCompare(left.path, right.path));
  const canonical = selected.map((file) => file.type === "symlink"
    ? `${file.path}\0symlink\0${file.target}\0${file.sizeBytes}\n`
    : `${file.path}\0file\0${file.sha256}\0${file.sizeBytes}\0${file.mode}\n`).join("");
  return {
    sha256: createHash("sha256").update(canonical).digest("hex"),
    sizeBytes: selected.reduce((sum, file) => sum + file.sizeBytes, 0),
    fileCount: selected.length,
  };
}

function componentFilesForAccounting(files, contracts, inventory) {
  if (inventory.embeddedIn !== undefined) {
    return filesMatchingSizeSpec(files, contracts.embeddedComponentSpecs.get(inventory.id));
  }
  const root = contracts.componentPaths.get(inventory.id);
  invariant(root, `${inventory.id}: bundled component has no payload root`);
  const owned = files.filter((file) => file.path === root || file.path.startsWith(`${root}/`));
  const shared = filesMatchingSizeSpec(files, contracts.sharedComponentSpecs.get(inventory.id));
  return [...new Map([...owned, ...shared].map((file) => [file.path, file])).values()];
}

function providerPackAggregateTreeSha256(packs) {
  const canonical = packs
    .map((pack) => `${pack.id}\0${pack.version}\0${pack.treeSha256}\0${pack.fileCount}\0${pack.installedBytes}\n`)
    .sort(bytewiseCompare)
    .join("");
  return createHash("sha256").update(canonical).digest("hex");
}

function normalizeProviderPackMeasurement(contracts, measurement, { fixture = false } = {}) {
  const expectedLocks = [...contracts.providerPackLocks.packs].sort((left, right) => bytewiseCompare(left.id, right.id));
  if (measurement === null) {
    invariant(fixture, "real distribution size accounting requires exact provider-pack installed-tree measurement");
    return {
      measurementStatus: "unavailable-fixture",
      packs: expectedLocks.map((pack) => ({
        id: pack.id,
        version: pack.version,
        installedBytes: null,
        fileCount: null,
        treeSha256: null,
      })),
      totals: {
        installedBytes: null,
        fileCount: null,
        treeSha256: null,
      },
    };
  }
  invariant(measurement?.schemaVersion === 1 && measurement.measurementStatus === "exact-locked-wheel-extraction", "provider-pack size measurement must be exact locked-wheel extraction evidence");
  invariant(Array.isArray(measurement.packs), "provider-pack size measurement packs are missing");
  const measurements = new Map();
  for (const pack of measurement.packs) {
    invariant(!measurements.has(pack?.id), `provider-pack size measurement duplicates ${pack?.id}`);
    invariant(
      typeof pack?.id === "string"
        && typeof pack.version === "string"
        && Number.isInteger(pack.installedBytes)
        && pack.installedBytes >= 0
        && Number.isInteger(pack.fileCount)
        && pack.fileCount >= 0
        && /^[a-f0-9]{64}$/.test(pack.treeSha256),
      "provider-pack size measurement entry is invalid",
    );
    measurements.set(pack.id, pack);
  }
  const packs = expectedLocks.map((locked) => {
    const measured = measurements.get(locked.id);
    invariant(measured?.version === locked.version, `${locked.id}: provider-pack size measurement version does not match locked pack`);
    return {
      id: locked.id,
      version: locked.version,
      installedBytes: measured.installedBytes,
      fileCount: measured.fileCount,
      treeSha256: measured.treeSha256,
    };
  });
  invariant(measurements.size === packs.length, "provider-pack size measurement contains an unrecognized pack");
  return {
    measurementStatus: "exact-locked-wheel-extraction",
    packs,
    totals: {
      installedBytes: packs.reduce((sum, pack) => sum + pack.installedBytes, 0),
      fileCount: packs.reduce((sum, pack) => sum + pack.fileCount, 0),
      treeSha256: providerPackAggregateTreeSha256(packs),
    },
  };
}

export function buildDistributionSizeAccounting(files, contracts, { allowUnmaterializedIds = new Set(), providerPackMeasurement = null, fixture = false } = {}) {
  const drilldownOwnerByPath = new Map();
  for (const spec of [...contracts.embeddedComponentSpecs.values(), ...contracts.sharedComponentSpecs.values()]) {
    for (const file of filesMatchingSizeSpec(files, spec)) {
      invariant(!drilldownOwnerByPath.has(file.path), `${file.path}: size drill-down overlaps ${drilldownOwnerByPath.get(file.path)} and ${spec.id}`);
      drilldownOwnerByPath.set(file.path, spec.id);
    }
  }
  const components = [...contracts.inventoryById.values()]
    .filter((component) => component.redistribution === "bundle")
    .sort((left, right) => bytewiseCompare(left.id, right.id))
    .map((inventory) => {
      const selected = componentFilesForAccounting(files, contracts, inventory);
      invariant(allowUnmaterializedIds.has(inventory.id) || selected.length > 0, `${inventory.id}: bundled component has no size-accounted files`);
      const summary = selected.length > 0 ? summarizeSelectedFiles(selected) : { sizeBytes: 0, fileCount: 0 };
      const embeddedSpec = contracts.embeddedComponentSpecs.get(inventory.id);
      const sharedSpec = contracts.sharedComponentSpecs.get(inventory.id);
      const root = contracts.componentPaths.get(inventory.id) ?? null;
      const ownedFiles = root === null ? [] : files.filter((file) => file.path === root || file.path.startsWith(`${root}/`));
      const sharedFiles = filesMatchingSizeSpec(files, sharedSpec);
      const accounting = selected.length === 0
        ? (inventory.id === "jobctrl-release-metadata" ? "self-referential-excluded" : "fixture-unmaterialized")
        : embeddedSpec
        ? (inventory.id === "system-browser-adapter" ? "shared-code" : "embedded-subset")
        : sharedSpec ? "owned-root-plus-shared-subset" : "owned-root";
      return {
        id: inventory.id,
        classification: inventory.classification,
        redistribution: inventory.redistribution,
        accounting,
        path: root,
        includedIn: embeddedSpec?.includedIn ?? sharedSpec?.includedIn ?? null,
        overlapsCoreTotal: Boolean(embeddedSpec || sharedSpec),
        fileCount: summary.fileCount,
        installedBytes: summary.sizeBytes,
        ...(sharedSpec ? {
          ownedRootBytes: ownedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
          sharedSubsetBytes: sharedFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
        } : {}),
        bomRef: `pkg:generic/jobctrl/${inventory.id}@${encodeURIComponent(contracts.versions[inventory.id])}`,
        ...(inventory.id === "system-browser-adapter" ? {
          sharedDependencies: {
            installedBytes: 0,
            accounting: "already-counted-in-jobctrl-worker",
            note: "Shared configuration and discovery/browser helpers are not falsely allocated to the adapter.",
          },
        } : {}),
      };
    });
  const expectedBundleIds = [...contracts.inventoryById.values()]
    .filter((component) => component.redistribution === "bundle")
    .map((component) => component.id)
    .sort(bytewiseCompare);
  invariant(JSON.stringify(components.map((component) => component.id)) === JSON.stringify(expectedBundleIds), "size accounting does not cover every bundled inventory component");

  const measuredProviders = normalizeProviderPackMeasurement(contracts, providerPackMeasurement, { fixture });
  const measuredById = new Map(measuredProviders.packs.map((pack) => [pack.id, pack]));
  const packs = [...contracts.providerPackLocks.packs]
    .sort((left, right) => bytewiseCompare(left.id, right.id))
    .map((pack) => {
      const measured = measuredById.get(pack.id);
      return {
        id: pack.id,
        version: pack.version,
        redistribution: "official-download",
        accounting: "artifact-excluded-on-demand",
        includedInCoreArtifact: false,
        measurementStatus: measuredProviders.measurementStatus,
        wheelCount: pack.wheels.length,
        downloadBytes: pack.wheels.reduce((sum, wheel) => sum + wheel.sizeBytes, 0),
        installedBytes: measured.installedBytes,
        fileCount: measured.fileCount,
        treeSha256: measured.treeSha256,
        installedSizeSource: measuredProviders.measurementStatus === "exact-locked-wheel-extraction"
          ? "signed-wheel-safe-extraction"
          : "unavailable-fixture",
        bomRef: `pkg:generic/jobctrl/${pack.id}@${encodeURIComponent(pack.version)}`,
      };
    });
  const expectedPackIds = [...contracts.inventoryById.values()]
    .filter((component) => component.redistribution === "official-download")
    .map((component) => component.id)
    .sort(bytewiseCompare);
  invariant(JSON.stringify(packs.map((pack) => pack.id)) === JSON.stringify(expectedPackIds), "size accounting does not cover every provider-pack inventory component");
  return {
    components,
    providerPacks: packs,
    providerPackTotals: {
      measurementStatus: measuredProviders.measurementStatus,
      packCount: packs.length,
      wheelCount: packs.reduce((sum, pack) => sum + pack.wheelCount, 0),
      downloadBytes: packs.reduce((sum, pack) => sum + pack.downloadBytes, 0),
      installedBytes: measuredProviders.totals.installedBytes,
      fileCount: measuredProviders.totals.fileCount,
      treeSha256: measuredProviders.totals.treeSha256,
      installedSizeSource: measuredProviders.measurementStatus === "exact-locked-wheel-extraction"
        ? "signed-wheel-safe-extraction"
        : "unavailable-fixture",
    },
  };
}

function topLevelSbomComponents(contracts, preliminaryFiles) {
  return [...contracts.inventoryById.values()]
    .filter((component) => component.redistribution === "bundle")
    .sort((left, right) => bytewiseCompare(left.id, right.id))
    .map((inventory) => {
    const selectedFiles = componentFilesForAccounting(preliminaryFiles, contracts, inventory);
    const summary = selectedFiles.length > 0 ? summarizeSelectedFiles(selectedFiles) : null;
    const root = contracts.componentPaths.get(inventory.id) ?? null;
    const includedIn = inventory.embeddedIn ?? contracts.sharedComponentSpecs.get(inventory.id)?.includedIn ?? null;
    return {
      type: inventory.id.startsWith("jobctrl-") ? "application" : "library",
      "bom-ref": `pkg:generic/jobctrl/${inventory.id}@${encodeURIComponent(contracts.versions[inventory.id])}`,
      name: inventory.id,
      version: contracts.versions[inventory.id],
      supplier: { name: inventory.owner },
      licenses: [{ expression: inventory.license }],
      externalReferences: [{ type: "distribution", url: inventory.source }],
      ...(summary ? { hashes: [{ alg: "SHA-256", content: summary.sha256 }] } : {}),
      properties: [
        { name: "jobctrl:classification", value: inventory.classification },
        ...(root ? [{ name: "jobctrl:payload-path", value: root }] : []),
        ...(includedIn ? [{ name: "jobctrl:included-in", value: includedIn }] : []),
        { name: "jobctrl:redistribution", value: inventory.redistribution },
      ],
    };
  });
}

async function generateReleaseMetadata(payloadRoot, contracts, {
  root,
  mode,
  sourceDateEpoch,
  pythonSbom = null,
  nodeLicenseInventory = null,
  providerPackMeasurement = null,
  providerPackComparison = null,
  attributionEvidence = null,
  licenseSources = [],
}) {
  invariant(typeof root === "string" && root.length > 0, "release metadata requires a source root");
  const releaseRoot = componentRoot(payloadRoot, contracts, "jobctrl-release-metadata");
  await rm(releaseRoot, { recursive: true, force: true });
  await mkdir(path.join(releaseRoot, "licenses"), { recursive: true, mode: 0o755 });

  const preliminaryFiles = (await buildFileInventory(payloadRoot)).filter((file) => !file.path.startsWith(`${contracts.componentPaths.get("jobctrl-release-metadata")}/`));
  const components = topLevelSbomComponents(contracts, preliminaryFiles);
  if (mode === "real") {
    components.push({
      type: "framework",
      "bom-ref": `pkg:golang/go@${GO_TOOLCHAIN_VERSION.slice(2)}`,
      name: "Go standard library",
      version: GO_TOOLCHAIN_VERSION.slice(2),
      supplier: { name: "The Go Authors" },
      licenses: [{ expression: "BSD-3-Clause" }],
      externalReferences: [{ type: "distribution", url: "https://go.dev/" }],
      properties: [{ name: "jobctrl:launcher-closure", value: "standard-library-only" }],
    });
  }
  if (pythonSbom) {
    const python = JSON.parse(await readFile(pythonSbom, "utf8"));
    for (const component of python.components ?? []) components.push(component);
  }
  if (nodeLicenseInventory) {
    for (const entry of nodeLicenseInventory.packages) {
      for (const version of entry.versions) {
        components.push({
          type: "library",
          "bom-ref": `pkg:npm/${encodeURIComponent(entry.name)}@${encodeURIComponent(version)}`,
          name: entry.name,
          version,
          licenses: [{ expression: entry.license }],
        });
      }
    }
  }
  const uniqueComponents = [...new Map(components.map((component) => [component["bom-ref"], component])).values()]
    .sort((left, right) => bytewiseCompare(left["bom-ref"], right["bom-ref"]));
  const sbom = {
    bomFormat: "CycloneDX",
    specVersion: "1.6",
    serialNumber: `urn:uuid:${createHash("sha256").update(`jobctrl:${contracts.versions["jobctrl-launcher"]}:${sourceDateEpoch}`).digest("hex").replace(/^(.{8})(.{4})(.{4})(.{4})(.{12}).*$/, "$1-$2-$3-$4-$5")}`,
    version: 1,
    metadata: {
      timestamp: new Date(sourceDateEpoch * 1000).toISOString(),
      component: {
        type: "application",
        name: "JobCtrl payload",
        version: contracts.versions["jobctrl-launcher"],
      },
      properties: [
        { name: "jobctrl:build-mode", value: mode },
        { name: "jobctrl:provider-packs", value: "excluded-official-download" },
      ],
    },
    components: uniqueComponents,
  };
  await writeJson(path.join(releaseRoot, "sbom.cdx.json"), sbom);
  if (pythonSbom) await copyFile(pythonSbom, path.join(releaseRoot, "python-core.sbom.cdx.json"));
  if (nodeLicenseInventory) await writeJson(path.join(releaseRoot, "node-production-licenses.json"), nodeLicenseInventory);
  const licenseRecords = await materializeLicenseSources(releaseRoot, licenseSources);
  if (attributionEvidence) {
    await writeJson(path.join(releaseRoot, "attribution-evidence.json"), {
      ...attributionEvidence,
      licenseFiles: licenseRecords,
    });
  }

  const projectLegalFiles = [
    { source: path.join(root, "LICENSE"), path: "JobCtrl-AGPL-3.0.txt", label: "JobCtrl LICENSE" },
    { source: path.join(root, "NOTICE"), path: "JobCtrl-NOTICE.txt", label: "JobCtrl NOTICE" },
  ];
  for (const legalFile of projectLegalFiles) {
    await requireFile(legalFile.source, legalFile.label);
    const destination = path.join(releaseRoot, "licenses", legalFile.path);
    await copyFile(legalFile.source, destination);
    await chmod(destination, 0o644);
    legalFile.sha256 = await sha256File(destination);
  }

  const attributions = topLevelSbomComponents(contracts, preliminaryFiles).map((component) => ({
    id: component.name,
    version: component.version,
    owner: contracts.inventoryById.get(component.name).owner,
    license: contracts.inventoryById.get(component.name).license,
    source: contracts.inventoryById.get(component.name).source,
    redistribution: "bundle",
  }));
  await writeJson(path.join(releaseRoot, "licenses", "index.json"), {
    schemaVersion: 1,
    status: mode === "fixture" ? "fixture-contract" : "collected-from-production-inputs",
    components: attributions,
    projectLegalFiles: projectLegalFiles.map(({ path: legalPath, sha256 }) => ({ path: legalPath, sha256 })),
  });
  await writeJson(path.join(releaseRoot, "provenance.json"), {
    schemaVersion: 1,
    buildMode: mode,
    sourceDateEpoch,
    platform: contracts.platform.id,
    source: "https://github.com/ebarti/JobCtrl",
    launcherToolchain: {
      version: contracts.launcherToolchain.goVersion,
      moduleClosure: contracts.launcherToolchain.moduleClosure,
      license: contracts.launcherToolchain.license,
      licenseSource: contracts.launcherToolchain.licenseSource,
      licenseSha256: contracts.launcherToolchain.licenseSha256,
      archive: nativeGoArchiveLock(contracts.launcherToolchain),
      officialMetadataUrl: contracts.launcherToolchain.archive.officialMetadataUrl,
    },
    providerPacks: {
      included: false,
      policy: "official-download",
      ids: ["antigravity-provider-runtime", "claude-agent-sdk", "codex-provider-runtime"],
    },
    lockedInputs: contracts.locks.inputs.map(({ id, componentId, version, url, sha256 }) => ({ id, componentId, version, url, sha256 })),
  });
  await writeJson(path.join(releaseRoot, "provider-packs.lock.json"), contracts.providerPackLocks);
  // The Python worker reads this immutable catalog in bundled mode. It lives
  // below signed release metadata, never in mutable JOBCTRL_DIR state.
  await copyFile(
    path.join(root, "packaging", "distribution", "capability-policy.json"),
    path.join(releaseRoot, "capability-policy.json"),
  );
  await chmod(path.join(releaseRoot, "capability-policy.json"), 0o644);

  const allowedUnmaterialized = new Set(["jobctrl-release-metadata"]);
  if (mode === "fixture") {
    for (const component of contracts.inventoryById.values()) {
      if (component.redistribution === "bundle" && component.embeddedIn !== undefined) allowedUnmaterialized.add(component.id);
    }
  }
  const sizeAccounting = buildDistributionSizeAccounting(preliminaryFiles, contracts, {
    allowUnmaterializedIds: allowedUnmaterialized,
    providerPackMeasurement,
    fixture: mode === "fixture",
  });
  const resolvedProviderPackComparison = providerPackComparison
    ?? compareProviderPackMeasurements(sizeAccounting.providerPacks);
  await writeJson(path.join(releaseRoot, "size-report.json"), {
    schemaVersion: 1,
    measurement: "installed-logical-bytes-before-release-metadata",
    installedBytes: preliminaryFiles.reduce((sum, file) => sum + file.sizeBytes, 0),
    components: sizeAccounting.components,
    providerPacks: sizeAccounting.providerPacks,
    providerPackTotals: sizeAccounting.providerPackTotals,
    providerPackComparison: resolvedProviderPackComparison,
    compressedReport: "published beside the compressed artifact as size-report.json",
  });
}

async function manifestFiles(payloadRoot) {
  return (await buildFileInventory(payloadRoot)).filter((file) => !ENVELOPE_FILES.has(file.path));
}

export async function createReleaseManifest(payloadRoot, contracts, {
  buildId,
  sourceDateEpoch,
  releaseChannel = "local",
  manifestKeyId = releaseChannel === "local" ? "local-development" : contracts.signingPolicy.manifestSigning.keyId,
  codeSigning = releaseChannel === "local" ? "unsigned-local" : "developer-id",
  notarized = releaseChannel !== "local",
}) {
  invariant(/^[0-9A-Za-z][0-9A-Za-z._-]{7,127}$/.test(buildId), "local buildId is invalid");
  invariant(Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0, "sourceDateEpoch must be a non-negative integer");
  invariant(RELEASE_CHANNELS.has(releaseChannel), "releaseChannel is invalid");
  const files = await manifestFiles(payloadRoot);
  const components = [...contracts.componentPaths.entries()].sort(([left], [right]) => bytewiseCompare(left, right)).map(([id, componentPath]) => {
    const inventory = contracts.inventoryById.get(id);
    const summary = summarizeComponentFiles(componentPath, files);
    return {
      id,
      classification: inventory.classification,
      version: contracts.versions[id],
      owner: inventory.owner,
      source: inventory.source,
      license: inventory.license,
      redistribution: "bundle",
      path: componentPath,
      sha256: summary.sha256,
      sizeBytes: summary.sizeBytes,
      required: inventory.requiredInCore,
    };
  });
  const capabilities = [...contracts.capabilitiesById.entries()].sort(([left], [right]) => bytewiseCompare(left, right)).map(([id, capability]) => ({
    id,
    defaultEnabled: capability.defaultEnabled,
    componentIds: [...capability.componentIds],
  }));
  const manifest = {
    schemaVersion: 1,
    appVersion: contracts.versions["jobctrl-launcher"],
    buildId,
    releaseChannel,
    sourceDateEpoch,
    platform: {
      id: contracts.platform.id,
      os: contracts.platform.os,
      arch: contracts.platform.arch,
      minimumOsVersion: contracts.platform.minimumOsVersion,
    },
    launcherCompatibility: { ...contracts.platform.launcherCompatibility },
    components,
    capabilities,
    files,
    signing: {
      manifestAlgorithm: "ed25519",
      manifestKeyId,
      codeSigning,
      notarized,
    },
  };
  validateDistributionManifest(manifest, contracts);
  await writeJson(path.join(payloadRoot, "manifest.json"), manifest);
  return manifest;
}

export async function createLocalManifest(payloadRoot, contracts, options) {
  const manifest = await createReleaseManifest(payloadRoot, contracts, options);
  invariant(manifest.releaseChannel === "local", "createLocalManifest only supports local channel envelopes");
  await writeJson(path.join(payloadRoot, "manifest.sig"), {
    schemaVersion: 1,
    status: "unsigned-local",
    manifestAlgorithm: "ed25519",
    manifestKeyId: "local-development",
    signature: null,
    promotable: false,
  });
  return manifest;
}

export async function verifyExactPayloadTree(payloadRoot, manifest) {
  const actual = await manifestFiles(payloadRoot);
  invariant(JSON.stringify(actual) === JSON.stringify(manifest.files), "payload tree does not exactly match manifest.files");
  const actualEnvelope = (await readdir(payloadRoot)).filter((name) => ENVELOPE_FILES.has(name)).sort(bytewiseCompare);
  invariant(JSON.stringify(actualEnvelope) === JSON.stringify([...ENVELOPE_FILES].sort(bytewiseCompare)), "local payload envelope is incomplete");
  return true;
}

function isProbablyText(contents) {
  if (contents.includes(0)) return false;
  const sample = contents.subarray(0, Math.min(contents.length, 8192));
  let printable = 0;
  for (const value of sample) if (value === 9 || value === 10 || value === 13 || (value >= 32 && value <= 126)) printable += 1;
  return sample.length === 0 || printable / sample.length > 0.9;
}

export async function scanForbiddenPayload(payloadRoot, { forbiddenAbsolutePaths = [] } = {}) {
  const files = await buildFileInventory(payloadRoot);
  const failures = [];
  const artifactWideNeedles = [
    ...forbiddenAbsolutePaths.filter(Boolean),
    ...FORBIDDEN_TOOL_INVOCATION_NEEDLES,
    ...FORBIDDEN_BROWSER_REDISTRIBUTION_NEEDLES,
  ];
  let streamScannedFileCount = 0;
  let semanticTextScannedFileCount = 0;
  for (const file of files) {
    const lowerPath = file.path.toLowerCase();
    const segments = lowerPath.split("/");
    const pythonRelativePath = pythonRuntimeRelativePath(file.path);
    if (segments.some((segment) => FORBIDDEN_SEGMENTS.has(segment))) failures.push(`${file.path}: development/test/cache path`);
    if (lowerPath.endsWith(".map") || lowerPath.endsWith("esbuild-metafile.json")) failures.push(`${file.path}: build-only metadata`);
    if (path.posix.basename(lowerPath) === "mockserviceworker.js" || lowerPath.includes("spikes.table-filters")) failures.push(`${file.path}: developer-only web fixture`);
    if (FORBIDDEN_PLAYWRIGHT_MCP_RUNTIME_PATHS.some((prefix) => file.path === prefix || file.path.startsWith(`${prefix}/`))) {
      failures.push(`${file.path}: Playwright MCP test/docs/viewer closure`);
    }
    if (file.path.startsWith("playwright-mcp/node_modules/") && lowerPath.endsWith(".md")) {
      failures.push(`${file.path}: Playwright MCP documentation closure`);
    }
    if (isTemporalBridgeBuildSourcePath(pythonRelativePath)) {
      failures.push(`${file.path}: Temporal bridge build/source closure`);
    }
    if (isKnownPythonNonRuntimePath(pythonRelativePath)) {
      failures.push(`${file.path}: known non-runtime Python source/docs/fixture closure`);
    }
    if (isGitMetadataBasename(path.posix.basename(lowerPath))) failures.push(`${file.path}: Git metadata`);
    if ((lowerPath.endsWith(".md") || lowerPath.endsWith(".rst")) && !isAllowedRuntimeDocumentationPath(file.path)) {
      failures.push(`${file.path}: runtime documentation outside the legal/attribution allowlist`);
    }
    if (FORBIDDEN_PROVIDER_PATTERNS.some((pattern) => pattern.test(lowerPath))) failures.push(`${file.path}: provider pack entered the core payload`);
    if (file.type === "file" && FORBIDDEN_TOOL_NAMES.has(path.posix.basename(lowerPath))) failures.push(`${file.path}: forbidden build tool`);
    if (file.type === "file") {
      streamScannedFileCount += 1;
      const leaked = await binaryContainsNeedle(path.join(payloadRoot, ...file.path.split("/")), artifactWideNeedles);
      if (leaked) failures.push(`${file.path}: artifact-wide forbidden build/runtime string ${leaked}`);
    }
    if (file.type !== "file" || file.sizeBytes > 2 * 1024 * 1024) continue;
    const contents = await readFile(path.join(payloadRoot, ...file.path.split("/")));
    if (!isProbablyText(contents)) continue;
    semanticTextScannedFileCount += 1;
    const text = contents.toString("utf8");
    for (const forbidden of forbiddenAbsolutePaths.filter(Boolean)) {
      if (text.includes(forbidden)) failures.push(`${file.path}: leaks build path ${forbidden}`);
    }
  }
  invariant(failures.length === 0, `forbidden payload content:\n${[...new Set(failures)].sort(bytewiseCompare).join("\n")}`);
  return {
    fileCount: files.length,
    streamScannedFileCount,
    semanticTextScannedFileCount,
    artifactWideNeedleCount: artifactWideNeedles.length,
    status: "clean",
  };
}

function tarOctal(value, length) {
  const encoded = value.toString(8).padStart(length - 1, "0");
  invariant(encoded.length <= length - 1, `tar numeric value ${value} exceeds field width`);
  return `${encoded}\0`;
}

function splitTarPath(relativePath, { allowPlaceholder = false } = {}) {
  const encoded = Buffer.byteLength(relativePath);
  if (encoded <= 100) return { name: relativePath, prefix: "" };
  for (let index = relativePath.lastIndexOf("/"); index > 0; index = relativePath.lastIndexOf("/", index - 1)) {
    const prefix = relativePath.slice(0, index);
    const name = relativePath.slice(index + 1);
    if (Buffer.byteLength(prefix) <= 155 && Buffer.byteLength(name) <= 100) return { name, prefix };
  }
  if (allowPlaceholder) return null;
  throw new Error(`${relativePath}: path is too long for deterministic ustar output`);
}

function tarHeader({ path: relativePath, mode, size, type, target = "" }, sourceDateEpoch) {
  const header = Buffer.alloc(512);
  const { name, prefix } = splitTarPath(relativePath);
  header.write(name, 0, 100, "utf8");
  header.write(tarOctal(Number.parseInt(mode, 8), 8), 100, 8, "ascii");
  header.write(tarOctal(0, 8), 108, 8, "ascii");
  header.write(tarOctal(0, 8), 116, 8, "ascii");
  header.write(tarOctal(size, 12), 124, 12, "ascii");
  header.write(tarOctal(sourceDateEpoch, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  invariant(Buffer.byteLength(target) <= 100, `${relativePath}: symlink target is too long for ustar output`);
  header.write(target, 157, 100, "utf8");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("wheel", 297, 32, "ascii");
  header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const value of header) checksum += value;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

export async function createDeterministicTarGz(payloadRoot, archivePath, sourceDateEpoch) {
  const files = await buildFileInventory(payloadRoot);
  await mkdir(path.dirname(archivePath), { recursive: true, mode: 0o755 });
  const output = createWriteStream(archivePath, { mode: 0o644 });
  const gzip = createGzip({ level: 9, mtime: 0 });
  gzip.pipe(output);
  async function writeChunk(chunk) {
    if (!gzip.write(chunk)) await once(gzip, "drain");
  }
  async function writeGnuLongValue(type, value) {
    const contents = Buffer.from(`${value}\0`, "utf8");
    await writeChunk(tarHeader({ path: "././@LongLink", mode: "0644", size: contents.length, type }, sourceDateEpoch));
    await writeChunk(contents);
    const padding = (512 - (contents.length % 512)) % 512;
    if (padding > 0) await writeChunk(Buffer.alloc(padding));
  }
  for (const file of files) {
    const archiveRelativePath = `payload/${file.path}`;
    const pathFitsUstar = splitTarPath(archiveRelativePath, { allowPlaceholder: true }) !== null;
    if (!pathFitsUstar) await writeGnuLongValue("L", archiveRelativePath);
    const headerPath = pathFitsUstar ? archiveRelativePath : "payload/GNU-LONGNAME";
    if (file.type === "symlink") {
      const targetFitsUstar = Buffer.byteLength(file.target) <= 100;
      if (!targetFitsUstar) await writeGnuLongValue("K", file.target);
      await writeChunk(tarHeader({
        path: headerPath,
        mode: "0777",
        size: 0,
        type: "2",
        target: targetFitsUstar ? file.target : "GNU-LONGLINK",
      }, sourceDateEpoch));
      continue;
    }
    await writeChunk(tarHeader({ path: headerPath, mode: file.mode, size: file.sizeBytes, type: "0" }, sourceDateEpoch));
    for await (const chunk of createReadStream(path.join(payloadRoot, ...file.path.split("/")))) await writeChunk(chunk);
    const padding = (512 - (file.sizeBytes % 512)) % 512;
    if (padding > 0) await writeChunk(Buffer.alloc(padding));
  }
  await writeChunk(Buffer.alloc(1024));
  gzip.end();
  await finished(output);
  await chmod(archivePath, 0o644);
  const archiveStat = await stat(archivePath);
  return { compressedBytes: archiveStat.size, sha256: await sha256File(archivePath), fileCount: files.length };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) value = (value >>> 1) ^ ((value & 1) === 1 ? 0xedb88320 : 0);
    table[index] = value >>> 0;
  }
  return table;
})();

function updateCrc32(value, chunk) {
  let crc = value;
  for (const byte of chunk) crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  return crc >>> 0;
}

function zipDosDateTime(sourceDateEpoch) {
  invariant(Number.isInteger(sourceDateEpoch) && sourceDateEpoch >= 0 && sourceDateEpoch <= ZIP_UINT32_MAX, "ZIP SOURCE_DATE_EPOCH must be a non-negative uint32");
  const date = new Date(Math.max(sourceDateEpoch, ZIP_EPOCH_FLOOR) * 1000);
  const year = date.getUTCFullYear();
  invariant(year >= 1980 && year <= 2107, "ZIP SOURCE_DATE_EPOCH is outside the DOS timestamp range");
  return {
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
  };
}

function zipExtendedTimestamp(sourceDateEpoch) {
  const extra = Buffer.alloc(9);
  extra.writeUInt16LE(0x5455, 0);
  extra.writeUInt16LE(5, 2);
  extra.writeUInt8(1, 4);
  extra.writeUInt32LE(sourceDateEpoch, 5);
  return extra;
}

async function zipEntryMetadata(payloadRoot, file) {
  const source = file.type === "symlink"
    ? Readable.from([Buffer.from(file.target, "utf8")])
    : createReadStream(path.join(payloadRoot, ...file.path.split("/")));
  let crc = 0xffffffff;
  let size = 0;
  for await (const chunk of source) {
    crc = updateCrc32(crc, chunk);
    size += chunk.length;
  }
  invariant(size === file.sizeBytes, `${file.path}: ZIP source size drifted from manifest inventory`);
  return { crc32: (crc ^ 0xffffffff) >>> 0, size };
}

function zipLocalHeader({ name, extra, dos, method }) {
  const header = Buffer.alloc(30 + name.length + extra.length);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0008, 6); // data descriptor: stream without buffering the payload
  header.writeUInt16LE(method, 8);
  header.writeUInt16LE(dos.time, 10);
  header.writeUInt16LE(dos.date, 12);
  header.writeUInt32LE(0, 14);
  header.writeUInt32LE(0, 18);
  header.writeUInt32LE(0, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(extra.length, 28);
  name.copy(header, 30);
  extra.copy(header, 30 + name.length);
  return header;
}

function zipCentralDirectoryHeader(entry) {
  const header = Buffer.alloc(46 + entry.name.length + entry.extra.length);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4); // Unix creator, ZIP 2.0
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0008, 8);
  header.writeUInt16LE(entry.method, 10);
  header.writeUInt16LE(entry.dos.time, 12);
  header.writeUInt16LE(entry.dos.date, 14);
  header.writeUInt32LE(entry.crc32, 16);
  header.writeUInt32LE(entry.compressedSize, 20);
  header.writeUInt32LE(entry.size, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(entry.extra.length, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  const mode = entry.type === "symlink" ? 0o120777 : 0o100000 | Number.parseInt(entry.mode, 8);
  header.writeUInt32LE((mode << 16) >>> 0, 38);
  header.writeUInt32LE(entry.offset, 42);
  entry.name.copy(header, 46);
  entry.extra.copy(header, 46 + entry.name.length);
  return header;
}

function zipDataDescriptor(entry) {
  const descriptor = Buffer.alloc(16);
  descriptor.writeUInt32LE(0x08074b50, 0);
  descriptor.writeUInt32LE(entry.crc32, 4);
  descriptor.writeUInt32LE(entry.compressedSize, 8);
  descriptor.writeUInt32LE(entry.size, 12);
  return descriptor;
}

// createDeterministicZip streams each payload file through raw Deflate and
// uses ZIP data descriptors, so production artifacts remain bounded by file
// streams rather than a whole-payload buffer. The central directory records
// Unix file modes and safe symlink targets for the native installer.
export async function createDeterministicZip(payloadRoot, archivePath, sourceDateEpoch) {
  const files = await buildFileInventory(payloadRoot);
  const dos = zipDosDateTime(sourceDateEpoch);
  const extra = zipExtendedTimestamp(sourceDateEpoch);
  await mkdir(path.dirname(archivePath), { recursive: true, mode: 0o755 });
  const output = createWriteStream(archivePath, { mode: 0o644 });
  let offset = 0;
  const entries = [];
  async function writeChunk(chunk) {
    invariant(offset + chunk.length <= ZIP_UINT32_MAX, "ZIP64 output is not supported");
    offset += chunk.length;
    if (!output.write(chunk)) await once(output, "drain");
  }
  try {
    for (const file of files) {
      const name = Buffer.from(file.path, "utf8");
      const metadata = await zipEntryMetadata(payloadRoot, file);
      invariant(metadata.size <= ZIP_UINT32_MAX, `${file.path}: ZIP entry exceeds ZIP32 size limit`);
      const entry = {
        ...file,
        ...metadata,
        name,
        extra,
        dos,
        method: 8,
        offset,
        compressedSize: 0,
      };
      await writeChunk(zipLocalHeader(entry));
      const source = file.type === "symlink"
        ? Readable.from([Buffer.from(file.target, "utf8")])
        : createReadStream(path.join(payloadRoot, ...file.path.split("/")));
      const deflater = createDeflateRaw({ level: 9 });
      source.pipe(deflater);
      for await (const chunk of deflater) {
        entry.compressedSize += chunk.length;
        invariant(entry.compressedSize <= ZIP_UINT32_MAX, `${file.path}: compressed ZIP entry exceeds ZIP32 size limit`);
        await writeChunk(chunk);
      }
      await writeChunk(zipDataDescriptor(entry));
      entries.push(entry);
    }
    const centralDirectoryOffset = offset;
    for (const entry of entries) await writeChunk(zipCentralDirectoryHeader(entry));
    const centralDirectorySize = offset - centralDirectoryOffset;
    invariant(entries.length <= 0xffff, "ZIP entry count exceeds ZIP32 limit");
    invariant(centralDirectorySize <= ZIP_UINT32_MAX, "ZIP central directory exceeds ZIP32 limit");
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(0, 4);
    end.writeUInt16LE(0, 6);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(centralDirectorySize, 12);
    end.writeUInt32LE(centralDirectoryOffset, 16);
    end.writeUInt16LE(0, 20);
    await writeChunk(end);
    output.end();
    await finished(output);
  } catch (error) {
    output.destroy();
    await rm(archivePath, { force: true });
    throw error;
  }
  await chmod(archivePath, 0o644);
  const archiveStat = await stat(archivePath);
  return { compressedBytes: archiveStat.size, sha256: await sha256File(archivePath), fileCount: files.length };
}

function compareProviderPackMeasurements(current, baseline = null) {
  if (current === undefined) return undefined;
  invariant(Array.isArray(current), "current provider-pack measurement must be an array");
  const exact = current.every((pack) => pack.measurementStatus === "exact-locked-wheel-extraction"
    && Number.isInteger(pack.installedBytes)
    && Number.isInteger(pack.fileCount)
    && /^[a-f0-9]{64}$/.test(pack.treeSha256));
  if (!exact) {
    const status = current.every((pack) => pack.measurementStatus === "unavailable-fixture")
      ? "unavailable-fixture"
      : "unavailable-current-measurement";
    return {
      status,
      installedBytesDelta: null,
      fileCountDelta: null,
      packs: current.map((pack) => ({ id: pack.id, version: pack.version, status })),
    };
  }
  if (baseline === null) {
    return {
      status: "baseline-not-provided",
      installedBytesDelta: null,
      fileCountDelta: null,
      packs: current.map((pack) => ({ id: pack.id, version: pack.version, status: "baseline-not-provided" })),
    };
  }
  if (!Array.isArray(baseline.providerPacks)) {
    return {
      status: "baseline-missing-provider-pack-measurement",
      installedBytesDelta: null,
      fileCountDelta: null,
      packs: current.map((pack) => ({ id: pack.id, version: pack.version, status: "baseline-missing-provider-pack-measurement" })),
    };
  }
  const previousById = new Map(baseline.providerPacks.map((pack) => [pack.id, pack]));
  const packs = current.map((pack) => {
    const previous = previousById.get(pack.id);
    if (!previous || !Number.isInteger(previous.installedBytes) || !Number.isInteger(previous.fileCount)) {
      return { id: pack.id, version: pack.version, status: "new-or-unmeasured", installedBytesDelta: null, fileCountDelta: null };
    }
    return {
      id: pack.id,
      version: pack.version,
      status: "compared",
      previousVersion: previous.version,
      installedBytesDelta: pack.installedBytes - previous.installedBytes,
      fileCountDelta: pack.fileCount - previous.fileCount,
      treeChanged: pack.treeSha256 !== previous.treeSha256,
    };
  });
  const previousExact = baseline.providerPacks.every((pack) => Number.isInteger(pack.installedBytes) && Number.isInteger(pack.fileCount));
  if (!previousExact) {
    return {
      status: "baseline-missing-provider-pack-measurement",
      installedBytesDelta: null,
      fileCountDelta: null,
      packs,
    };
  }
  return {
    status: "compared",
    installedBytesDelta: current.reduce((sum, pack) => sum + pack.installedBytes, 0)
      - baseline.providerPacks.reduce((sum, pack) => sum + pack.installedBytes, 0),
    fileCountDelta: current.reduce((sum, pack) => sum + pack.fileCount, 0)
      - baseline.providerPacks.reduce((sum, pack) => sum + pack.fileCount, 0),
    packs,
  };
}

export function compareSizeReports(current, baseline = null) {
  invariant(current && typeof current === "object", "current size metrics must be an object");
  invariant(typeof current.platform === "string" && current.platform.length > 0, "current size metrics require a platform");
  invariant(Number.isInteger(current.installedBytes) && current.installedBytes >= 0, "current installedBytes must be non-negative");
  invariant(Number.isInteger(current.compressedBytes) && current.compressedBytes >= 0, "current compressedBytes must be non-negative");
  if (baseline === null) {
    const comparison = {
      status: "baseline-not-provided",
      previousBuildId: null,
      installedBytesDelta: null,
      installedPercentDelta: null,
      compressedBytesDelta: null,
      compressedPercentDelta: null,
    };
    const providerPacks = compareProviderPackMeasurements(current.providerPacks);
    return providerPacks === undefined ? comparison : { ...comparison, providerPacks };
  }
  invariant(baseline && typeof baseline === "object", "baseline size report must be an object");
  invariant(baseline.platform === current.platform, "baseline size report platform does not match the current build");
  invariant(typeof baseline.buildId === "string" && baseline.buildId.length > 0, "baseline size report requires buildId");
  invariant(Number.isInteger(baseline.installedBytes) && baseline.installedBytes >= 0, "baseline installedBytes must be non-negative");
  invariant(Number.isInteger(baseline.compressedBytes) && baseline.compressedBytes >= 0, "baseline compressedBytes must be non-negative");
  const percentDelta = (value, previous) => previous === 0 ? null : Number((((value - previous) / previous) * 100).toFixed(6));
  const comparison = {
    status: "compared",
    previousBuildId: baseline.buildId,
    installedBytesDelta: current.installedBytes - baseline.installedBytes,
    installedPercentDelta: percentDelta(current.installedBytes, baseline.installedBytes),
    compressedBytesDelta: current.compressedBytes - baseline.compressedBytes,
    compressedPercentDelta: percentDelta(current.compressedBytes, baseline.compressedBytes),
  };
  const providerPacks = compareProviderPackMeasurements(current.providerPacks, baseline);
  return providerPacks === undefined ? comparison : { ...comparison, providerPacks };
}

export async function buildFixturePayload({
  outputDirectory,
  buildId = "fixture-build-0001",
  sourceDateEpoch = 0,
  root = REPO_ROOT,
} = {}) {
  invariant(outputDirectory, "fixture build requires outputDirectory");
  const contracts = await loadBuildContracts(root);
  const outputRoot = path.resolve(outputDirectory);
  const payloadRoot = path.join(outputRoot, "payload");
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true, mode: 0o755 });
  await writeFixtureComponents(payloadRoot, contracts);
  await generateReleaseMetadata(payloadRoot, contracts, { root, mode: "fixture", sourceDateEpoch });
  const manifest = await createLocalManifest(payloadRoot, contracts, { buildId, sourceDateEpoch });
  await verifyExactPayloadTree(payloadRoot, manifest);
  await scanForbiddenPayload(payloadRoot, { forbiddenAbsolutePaths: [root, outputRoot] });
  const archivePath = path.join(outputRoot, `jobctrl-${contracts.versions["jobctrl-launcher"]}-${contracts.platform.id}.zip`);
  const compressed = await createDeterministicZip(payloadRoot, archivePath, sourceDateEpoch);
  const installedBytes = manifest.files.reduce((sum, file) => sum + file.sizeBytes, 0)
    + (await stat(path.join(payloadRoot, "manifest.json"))).size
    + (await stat(path.join(payloadRoot, "manifest.sig"))).size;
  const fixtureSizeAccounting = buildDistributionSizeAccounting(await buildFileInventory(payloadRoot), contracts, {
    allowUnmaterializedIds: new Set([...contracts.inventoryById.values()]
      .filter((component) => component.redistribution === "bundle" && component.embeddedIn !== undefined)
      .map((component) => component.id)),
    fixture: true,
  });
  const sizeReport = {
    schemaVersion: 1,
    platform: contracts.platform.id,
    buildId,
    installedBytes,
    compressedBytes: compressed.compressedBytes,
    compressionRatio: Number((compressed.compressedBytes / installedBytes).toFixed(6)),
    archiveSha256: compressed.sha256,
    comparison: compareSizeReports({
      platform: contracts.platform.id,
      installedBytes,
      compressedBytes: compressed.compressedBytes,
      providerPacks: fixtureSizeAccounting.providerPacks,
    }),
    components: fixtureSizeAccounting.components,
    providerPacks: fixtureSizeAccounting.providerPacks,
    providerPackTotals: fixtureSizeAccounting.providerPackTotals,
  };
  await writeJson(path.join(outputRoot, "size-report.json"), sizeReport);
  const installerPath = path.join(outputRoot, "jobctrl-installer");
  await copyFile(path.join(payloadRoot, "launcher", "jobctrl-installer"), installerPath);
  await chmod(installerPath, 0o755);
  const release = await writeLocalReleaseBundle({
    outputDirectory: outputRoot,
    archivePath,
    manifestPath: path.join(payloadRoot, "manifest.json"),
    installerPath,
    buildId,
    appVersion: contracts.versions["jobctrl-launcher"],
    platform: contracts.platform,
  });
  const result = {
    schemaVersion: 1,
    mode: "fixture",
    buildId,
    releaseChannel: "local",
    archiveType: "zip",
    payloadRoot,
    archivePath,
    manifestPath: path.join(payloadRoot, "manifest.json"),
    manifestSha256: await sha256File(path.join(payloadRoot, "manifest.json")),
    archiveSha256: compressed.sha256,
    installedBytes,
    compressedBytes: compressed.compressedBytes,
    release,
  };
  await writeJson(path.join(outputRoot, "build-result.json"), result);
  return { ...result, manifest, sizeReport };
}

export async function buildRealPayload({
  outputDirectory,
  cacheDirectory = path.join(os.homedir(), "Library", "Caches", "JobCtrl", "distribution"),
  buildId = "local-real-build-0001",
  sourceDateEpoch = Number.parseInt(process.env.SOURCE_DATE_EPOCH ?? "0", 10),
  baselineSizeReportPath = null,
  releaseChannel = "local",
  releaseTrustKeyBase64 = "",
  root = REPO_ROOT,
} = {}) {
  invariant(outputDirectory, "real build requires outputDirectory");
  validateReleaseBuildBinding(releaseChannel, releaseTrustKeyBase64);
  // A signed channel starts as an explicitly local *pre-sign* envelope. P6
  // signs mutable code, staples nested applications, then recreates and signs
  // the final manifest from post-staple bytes. The provisional envelope is
  // never publishable.
  const contracts = await loadBuildContracts(root);
  const baselineSizeReport = baselineSizeReportPath === null
    ? null
    : JSON.parse(await readFile(path.resolve(baselineSizeReportPath), "utf8"));
  const outputRoot = path.resolve(outputDirectory);
  const payloadRoot = path.join(outputRoot, "payload");
  const scratchDirectory = await mkdtemp(path.join(os.tmpdir(), "jobctrl-real-build-"));
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(payloadRoot, { recursive: true, mode: 0o755 });
  try {
    const resolvedCacheDirectory = path.resolve(cacheDirectory);
    const [externalInputs, nativeGoToolchain] = await Promise.all([
      assembleExternalRuntimes(payloadRoot, contracts, resolvedCacheDirectory, scratchDirectory),
      prepareNativeGoToolchain(root, resolvedCacheDirectory, scratchDirectory, contracts.launcherToolchain),
    ]);
    const pythonRuntimePrune = await pruneUnusedPythonRuntime(componentRoot(payloadRoot, contracts, "python-runtime"));
    await prepareStandardProductionInputs(root, contracts, externalInputs);
    await copyPreparedApplicationInputs(payloadRoot, root, contracts);
    await Promise.all([
      assemblePlaywrightMcp(payloadRoot, root, contracts, externalInputs),
      writeGeneratedComponents(payloadRoot, root, contracts, sourceDateEpoch, nativeGoToolchain, { releaseChannel, releaseTrustKeyBase64 }),
    ]);
    await assertHeadlessChromiumPayload(payloadRoot, contracts);
    const pythonSbom = await preparePythonWorker(payloadRoot, root, contracts, scratchDirectory);
    const providerPackMeasurement = await measureProviderPackInstalledTrees(payloadRoot, root, contracts, scratchDirectory);
    const providerPackComparison = compareProviderPackMeasurements(
      normalizeProviderPackMeasurement(contracts, providerPackMeasurement).packs.map((pack) => ({
        ...pack,
        measurementStatus: "exact-locked-wheel-extraction",
      })),
      baselineSizeReport,
    );
    const nodeContributors = await collectNodeContributors(payloadRoot, root, contracts);

    const [nodeBase, pythonAttribution, topLevelSources, browserResources] = await Promise.all([
      collectNodeLicenseInventory(contracts, path.resolve(cacheDirectory), nodeContributors),
      collectPythonLicenseEvidence(payloadRoot, contracts, path.resolve(cacheDirectory)),
      collectTopLevelLicenseEvidence(payloadRoot, root, contracts),
      browserCreditsEvidence(payloadRoot, contracts),
    ]);
    await reconcilePythonSbom(pythonSbom, pythonAttribution.packages, { sourceDateEpoch });
    const chromiumCredits = await captureChromiumCredits(payloadRoot, contracts, scratchDirectory);
    await Promise.all([
      pruneInstalledPythonTree(path.join(componentRoot(payloadRoot, contracts, "python-runtime"), "lib", "python3.12")),
      pruneInstalledPythonTree(path.join(componentRoot(payloadRoot, contracts, "jobctrl-worker"), "site-packages")),
      pruneInstalledPythonTree(path.join(componentRoot(payloadRoot, contracts, "playwright-python"), "site-packages")),
    ]);
    const nodeLicenseInventory = nodeBase.inventory;
    const payloadNpmPackages = nodeContributors
      .filter((entry) => [...entry.contributions.values()].some((contribution) => contribution.kind === "payload-npm-tree"))
      .map((entry) => ({
        package: entry.key,
        paths: [...entry.contributions.values()]
          .filter((contribution) => contribution.kind === "payload-npm-tree")
          .map((contribution) => contribution.artifactPath)
          .sort(bytewiseCompare),
      }));
    const licenseSources = [
      ...nodeBase.licenseSources,
      ...pythonAttribution.licenseSources,
      ...topLevelSources,
      { subject: "chromium-core-third-party-credits", source: chromiumCredits },
    ];
    await generateReleaseMetadata(payloadRoot, contracts, {
      root,
      mode: "real",
      sourceDateEpoch,
      pythonSbom,
      nodeLicenseInventory,
      providerPackMeasurement,
      providerPackComparison,
      licenseSources,
      attributionEvidence: {
        schemaVersion: 1,
        status: "complete",
        nodePackageCount: nodeLicenseInventory.packages.reduce((count, entry) => count + entry.versions.length, 0),
        pythonPackageCount: pythonAttribution.packages.length,
        payloadNpmPackages,
        browserEmbeddedResources: browserResources,
        chromiumCredits: "licenses/texts contains the verbatim LICENSE.headless_shell notice file from the pinned headless browser",
      },
    });
    const manifest = await createLocalManifest(payloadRoot, contracts, { buildId, sourceDateEpoch });
    await verifyExactPayloadTree(payloadRoot, manifest);
    const forbiddenAudit = await scanForbiddenPayload(payloadRoot, { forbiddenAbsolutePaths: [root, outputRoot, scratchDirectory] });
    const machO = await scanMachODependencies(payloadRoot, {
      forbiddenStrings: [root, outputRoot, scratchDirectory],
      declaredMinimumOsVersion: contracts.platform.minimumOsVersion,
    });

    const evidenceRoot = path.join(outputRoot, "build-evidence");
    await mkdir(evidenceRoot, { recursive: true, mode: 0o755 });
    await copyFile(path.join(root, "dist", "api", "metafile.json"), path.join(evidenceRoot, "api-esbuild-metafile.json"));
    await chmod(path.join(evidenceRoot, "api-esbuild-metafile.json"), 0o644);
    await writeJson(path.join(evidenceRoot, "node-contribution-closure.json"), {
      schemaVersion: 1,
      status: "complete",
      packages: nodeLicenseInventory.packages.map((entry) => ({
        package: `${entry.name}@${entry.versions[0]}`,
        contributions: entry.contributions,
      })),
    });
    await writeJson(path.join(evidenceRoot, "provider-pack-installed-trees.json"), providerPackMeasurement);
    const archivePath = path.join(outputRoot, `jobctrl-${contracts.versions["jobctrl-launcher"]}-${contracts.platform.id}.zip`);
    const compressed = await createDeterministicZip(payloadRoot, archivePath, sourceDateEpoch);
    const smoke = await smokeExtractedPayload(archivePath, outputRoot, contracts, {
      nativeLauncherReleaseChannel: releaseChannel,
    });
    await rm(path.join(outputRoot, "clean-extraction"), { recursive: true, force: true });

    const installedBytes = (await buildFileInventory(payloadRoot)).reduce((sum, file) => sum + file.sizeBytes, 0);
    const sizeAccounting = buildDistributionSizeAccounting(await buildFileInventory(payloadRoot), contracts, {
      providerPackMeasurement,
    });
    const sizeReport = {
      schemaVersion: 1,
      platform: contracts.platform.id,
      buildId,
      installedBytes,
      compressedBytes: compressed.compressedBytes,
      compressionRatio: Number((compressed.compressedBytes / installedBytes).toFixed(6)),
      archiveSha256: compressed.sha256,
      comparison: compareSizeReports({
        platform: contracts.platform.id,
        installedBytes,
        compressedBytes: compressed.compressedBytes,
        providerPacks: sizeAccounting.providerPacks,
      }, baselineSizeReport),
      components: sizeAccounting.components,
      providerPacks: sizeAccounting.providerPacks,
      providerPackTotals: sizeAccounting.providerPackTotals,
    };
    await writeJson(path.join(outputRoot, "size-report.json"), sizeReport);
    const installerPath = path.join(outputRoot, "jobctrl-installer");
    await copyFile(path.join(payloadRoot, "launcher", "jobctrl-installer"), installerPath);
    await chmod(installerPath, 0o755);
    const release = await writeLocalReleaseBundle({
      outputDirectory: outputRoot,
      archivePath,
      manifestPath: path.join(payloadRoot, "manifest.json"),
      installerPath,
      buildId,
      appVersion: contracts.versions["jobctrl-launcher"],
      platform: contracts.platform,
    });
    const result = {
      schemaVersion: 1,
      mode: "real",
      buildId,
      releaseChannel: "local",
      nativeLauncherReleaseChannel: releaseChannel,
      nativeLauncherReleaseTrustKeyBase64: releaseTrustKeyBase64 || null,
      nativeLauncherReleaseTrustKeySha256: releaseTrustKeyBase64
        ? createHash("sha256").update(releaseTrustKeyBase64).digest("hex")
        : null,
      archiveType: "zip",
      payloadRoot,
      archivePath,
      manifestPath: path.join(payloadRoot, "manifest.json"),
      manifestSha256: await sha256File(path.join(payloadRoot, "manifest.json")),
      archiveSha256: compressed.sha256,
      installedBytes,
      compressedBytes: compressed.compressedBytes,
      runtimePruning: [pythonRuntimePrune],
      machO,
      forbiddenAudit,
      smoke,
      release,
    };
    await writeJson(path.join(outputRoot, "build-result.json"), result);
    return { ...result, manifest, sizeReport };
  } catch (error) {
    const nativeLifecycleCleanup = await cleanupNativeLauncherRuntime(path.join(outputRoot, "clean-extraction"));
    await writeJson(path.join(outputRoot, "build-failure.json"), {
      schemaVersion: 1,
      mode: "real",
      buildId,
      status: "failed",
      error: error.message,
      nativeLifecycleCleanup,
    });
    throw error;
  } finally {
    await rm(scratchDirectory, { recursive: true, force: true });
  }
}

function parseCliOptions(argv) {
  if (argv[0] === "--") argv = argv.slice(1);
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    invariant(option.startsWith("--"), `unknown argument ${option}`);
    const key = option.slice(2);
    const value = argv[index + 1];
    invariant(value && !value.startsWith("--"), `${option} requires a value`);
    invariant(options[key] === undefined, `${option} may only be specified once`);
    options[key] = value;
    index += 1;
  }
  return options;
}

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "fixture";
  const options = parseCliOptions(argv.slice(1));
  if (command === "audit") {
    invariant(Object.keys(options).length === 0, "distribution audit accepts no options");
    const contracts = await loadBuildContracts(REPO_ROOT);
    process.stdout.write(canonicalJson({
      status: "pass",
      launcherToolchain: {
        version: contracts.launcherToolchain.goVersion,
        archive: nativeGoArchiveLock(contracts.launcherToolchain),
      },
    }));
    return;
  }
  if (command === "fixture") {
    const result = await buildFixturePayload({
      outputDirectory: path.resolve(options.output ?? path.join(REPO_ROOT, "dist", "distribution-fixture")),
      buildId: options["build-id"] ?? "fixture-build-0001",
      sourceDateEpoch: Number.parseInt(options["source-date-epoch"] ?? process.env.SOURCE_DATE_EPOCH ?? "0", 10),
    });
    process.stdout.write(canonicalJson({
      mode: result.mode,
      payloadRoot: result.payloadRoot,
      archivePath: result.archivePath,
      manifestSha256: result.manifestSha256,
      archiveSha256: result.archiveSha256,
      installedBytes: result.installedBytes,
      compressedBytes: result.compressedBytes,
    }));
    return;
  }
  if (command === "real") {
    const result = await buildRealPayload({
      outputDirectory: path.resolve(options.output ?? path.join(REPO_ROOT, "dist", "distribution-real")),
      cacheDirectory: options.cache ? path.resolve(options.cache) : undefined,
      buildId: options["build-id"] ?? "local-real-build-0001",
      sourceDateEpoch: Number.parseInt(options["source-date-epoch"] ?? process.env.SOURCE_DATE_EPOCH ?? "0", 10),
      baselineSizeReportPath: options["baseline-size-report"] ?? null,
      releaseChannel: options["release-channel"] ?? "local",
      releaseTrustKeyBase64: options["release-trust-key"] ?? "",
    });
    process.stdout.write(canonicalJson({
      mode: result.mode,
      payloadRoot: result.payloadRoot,
      archivePath: result.archivePath,
      manifestSha256: result.manifestSha256,
      archiveSha256: result.archiveSha256,
      installedBytes: result.installedBytes,
      compressedBytes: result.compressedBytes,
      smoke: result.smoke,
    }));
    return;
  }
  throw new Error(`unknown distribution build mode: ${command}`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath && path.basename(process.argv[1] ?? "") === "distribution-build.mjs") {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`distribution-build: ${error.message}\n`);
    process.exitCode = 1;
  }
}
