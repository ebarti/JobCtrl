import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { chmod, copyFile, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import {
  assertNodeAttributionClosure,
  assertHeadlessChromiumPayload,
  buildFixturePayload,
  collectNodeLicenseInventory,
  collectPayloadNpmContributors,
  compareMacOsVersions,
  compareSizeReports,
  createNativeLauncherBuildPlan,
  createExtractedRuntimeStackPlan,
  createDeterministicZip,
  createDeterministicTarGz,
  extensionCaptureSmokeHeaders,
  normalizeInstalledPythonMetadata,
  loadNativeLauncherToolchain,
  nativeLauncherLifecycleSmokeRequirement,
  npmIdentityForContributingSource,
  parseMachOMinimumVersions,
  parseOtoolDependencies,
  prepareExtractedSmokeLayout,
  pruneInstalledPythonTree,
  pruneUnusedPythonRuntime,
  reconcilePythonSbom,
  scanForbiddenPayload,
  terminateChildProcess,
  verifyExactPayloadTree,
  webContributionBuildInvocation,
  writePlaywrightRevisionMarkers,
} from "./distribution-build.mjs";
import {
  extractVerifiedArchive,
  parseTarGzArchive,
  parseZipArchive,
  sha256File,
  verifyLockedArchive,
} from "./distribution-archive.mjs";
import { buildFileInventory } from "./distribution-manifest.mjs";
import { parseExportedRequirements } from "./distribution-provider-lock.mjs";

const execFileAsync = promisify(execFile);

const FIXTURE_BUILD_ROOT_FILES = [
  "LICENSE",
  "NOTICE",
  "package.json",
  "pnpm-lock.yaml",
  "apps/api/package.json",
  "apps/web/package.json",
  "workers/automation/pyproject.toml",
  "workers/automation/uv.lock",
  "launcher/GO-LICENSE",
  "launcher/toolchain.json",
  "packaging/distribution/capability-policy.json",
  "packaging/distribution/component-inventory.json",
  "packaging/distribution/components.lock.json",
  "packaging/distribution/license-evidence.lock.json",
  "packaging/distribution/manifest.schema.json",
  "packaging/distribution/node-license-evidence.lock.json",
  "packaging/distribution/payload-layout.json",
  "packaging/distribution/platforms.json",
  "packaging/distribution/provider-packs.lock.json",
  "packaging/distribution/signing-policy.json",
  "packaging/distribution/source-baseline.json",
];

async function createFixtureBuildRoot(root) {
  for (const relativePath of FIXTURE_BUILD_ROOT_FILES) {
    const destination = path.join(root, relativePath);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(process.cwd(), relativePath), destination);
  }
  return root;
}

test("native launcher build pins an official verified darwin-arm64 compiler contract", async (context) => {
  const root = process.cwd();
  const temporary = await mkdtemp(path.join(os.tmpdir(), "jobctrl-launcher-build-"));
  context.after(async () => rm(temporary, { recursive: true, force: true }));
  const firstPayload = path.join(temporary, "first");
  const secondPayload = path.join(temporary, "second");
  await Promise.all([mkdir(path.join(firstPayload, "launcher"), { recursive: true }), mkdir(path.join(secondPayload, "launcher"), { recursive: true })]);
  const options = {
    root,
    platform: { os: "darwin", arch: "arm64" },
    sourceDateEpoch: 0,
    goExecutable: "/verified/go/bin/go",
    goRoot: "/verified/go",
  };
  const first = createNativeLauncherBuildPlan({ ...options, payloadRoot: firstPayload });
  const second = createNativeLauncherBuildPlan({ ...options, payloadRoot: secondPayload });
  assert.equal(first.command, "/verified/go/bin/go");
  assert.deepEqual(first.environment, {
    CGO_ENABLED: "0",
    GOOS: "darwin",
    GOARCH: "arm64",
    GOROOT: "/verified/go",
    GOENV: "off",
    GOFLAGS: "",
    GOWORK: "off",
    GOTOOLCHAIN: "local",
    GOEXPERIMENT: "",
    GOARM64: "v8.0",
    SOURCE_DATE_EPOCH: "0",
  });
  assert.deepEqual(first.args.slice(0, 4), ["build", "-buildvcs=false", "-trimpath", "-ldflags=-s -w -buildid= -X github.com/ebarti/jobctrl/launcher/internal/launcher.releaseChannel=local"]);
  assert.equal(first.args.at(-1), "./cmd/jobctrl");
  assert.equal(first.args[5], path.join(firstPayload, "launcher", "jobctrl"));
  assert.equal(second.args[5], path.join(secondPayload, "launcher", "jobctrl"));
  const installer = createNativeLauncherBuildPlan({ ...options, payloadRoot: firstPayload, binary: "jobctrl-installer" });
  assert.equal(installer.args[5], path.join(firstPayload, "launcher", "jobctrl-installer"));
  assert.equal(installer.args.at(-1), "./cmd/jobctrl-installer");
  const releaseKey = Buffer.alloc(32, 7).toString("base64");
  const signed = createNativeLauncherBuildPlan({ ...options, payloadRoot: firstPayload, releaseChannel: "stable", releaseTrustKeyBase64: releaseKey });
  assert.match(signed.args[3], /releaseChannel=stable/);
  assert.match(signed.args[3], new RegExp(`releaseTrustKeyBase64=${releaseKey}`));
  assert.throws(() => createNativeLauncherBuildPlan({ ...options, payloadRoot: firstPayload, releaseChannel: "local", releaseTrustKeyBase64: releaseKey }), /local native builds/);
  const runtimeManifest = JSON.parse(await readFile(path.join(root, "launcher", "runtime-manifest.json"), "utf8"));
  assert.equal(runtimeManifest.ports.api, 8766);
  assert.equal(runtimeManifest.ports.temporalGrpc, 7233);
  assert.equal(runtimeManifest.ports.temporalUi, 8233);
  assert.deepEqual(JSON.parse(await readFile(path.join(root, "launcher", "toolchain.json"), "utf8")), {
    schemaVersion: 1,
    goVersion: "go1.26.4",
    archive: {
      type: "tar.gz",
      url: "https://go.dev/dl/go1.26.4.darwin-arm64.tar.gz",
      sha256: "b62ad2b6d7d2464f12a5bcad7ff47f19d08325773b5efd21610e445a05a9bf53",
      sizeBytes: 64723756,
      officialMetadataUrl: "https://go.dev/dl/?mode=json&include=all",
    },
    moduleClosure: "standard-library-only",
    license: "BSD-3-Clause",
    licenseSource: "https://go.dev/LICENSE",
    licenseSha256: "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad",
  });
  const toolchain = await loadNativeLauncherToolchain(root);
  assert.equal(toolchain.archive.sizeBytes, 64723756);
  assert.equal(await sha256File(path.join(root, "launcher", "GO-LICENSE")), "911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad");
});

test("pre-sign network candidates defer only the unavailable native lifecycle smoke", () => {
  assert.deepEqual(nativeLauncherLifecycleSmokeRequirement("local"), { status: "required" });
  assert.deepEqual(nativeLauncherLifecycleSmokeRequirement("stable"), {
    status: "skipped",
    reason: "pre-sign-unavailable",
    releaseChannel: "stable",
  });
  assert.deepEqual(nativeLauncherLifecycleSmokeRequirement("prerelease"), {
    status: "skipped",
    reason: "pre-sign-unavailable",
    releaseChannel: "prerelease",
  });
  assert.throws(() => nativeLauncherLifecycleSmokeRequirement("preview"), /release channel is invalid/);
});

function tarField(value, width) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarArchive(entries) {
  const blocks = [];
  for (const entry of entries) {
    const contents = Buffer.from(entry.contents ?? "");
    const header = Buffer.alloc(512);
    header.write(entry.path, 0, 100, "utf8");
    header.write(tarField(entry.mode ?? 0o644, 8), 100, 8, "ascii");
    header.write(tarField(0, 8), 108, 8, "ascii");
    header.write(tarField(0, 8), 116, 8, "ascii");
    header.write(tarField(contents.length, 12), 124, 12, "ascii");
    header.write(tarField(0, 12), 136, 12, "ascii");
    header.fill(0x20, 148, 156);
    header.write(entry.type ?? "0", 156, 1, "ascii");
    if (entry.target) header.write(entry.target, 157, 100, "utf8");
    header.write("ustar\0", 257, 6, "ascii");
    header.write("00", 263, 2, "ascii");
    let checksum = 0;
    for (const value of header) checksum += value;
    header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
    blocks.push(header, contents);
    const padding = (512 - contents.length % 512) % 512;
    if (padding > 0) blocks.push(Buffer.alloc(padding));
  }
  blocks.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(blocks), { mtime: 0 });
}

function crc32(contents) {
  let crc = 0xffffffff;
  for (const byte of contents) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function storedZip(entries) {
  const localParts = [];
  const centralParts = [];
  let localOffset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const contents = Buffer.from(entry.contents ?? "");
    const crc = crc32(contents);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x800, 6);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(contents.length, 18);
    local.writeUInt32LE(contents.length, 22);
    local.writeUInt16LE(name.length, 26);
    localParts.push(local, name, contents);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x800, 8);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(contents.length, 20);
    central.writeUInt32LE(contents.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    central.writeUInt32LE(localOffset, 42);
    centralParts.push(central, name);
    localOffset += local.length + name.length + contents.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(localOffset, 16);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

test("Mach-O parsing separates dylib identity and validates minimum-version ordering", () => {
  const dependencyOutput = `/tmp/libEGL.dylib:\n\t./libEGL.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`;
  assert.deepEqual(parseOtoolDependencies(dependencyOutput, { dylib: true }), ["/usr/lib/libSystem.B.dylib"]);
  assert.deepEqual(parseOtoolDependencies(dependencyOutput), ["./libEGL.dylib", "/usr/lib/libSystem.B.dylib"]);

  const loadCommands = `Load command 8\n      cmd LC_BUILD_VERSION\n  cmdsize 32\n platform 1\n    minos 12.0\n      sdk 26.2\nLoad command 9\n      cmd LC_LOAD_DYLIB\n`;
  assert.deepEqual(parseMachOMinimumVersions(loadCommands), ["12.0"]);
  assert.equal(compareMacOsVersions("12.0", "15.0"), -1);
  assert.equal(compareMacOsVersions("15", "15.0.0"), 0);
  assert.equal(compareMacOsVersions("15.0.1", "15.0"), 1);
  assert.throws(() => compareMacOsVersions("latest", "15.0"), /invalid Mach-O minimum/);

  const universalBundleOutput = `/tmp/extension.so (architecture x86_64):\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n/tmp/extension.so (architecture arm64):\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`;
  assert.deepEqual(parseOtoolDependencies(universalBundleOutput), [
    "/usr/lib/libSystem.B.dylib",
    "/usr/lib/libSystem.B.dylib",
  ]);

  const universalDylibOutput = `/tmp/lib.dylib (architecture x86_64):\n\t./lib.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n/tmp/lib.dylib (architecture arm64):\n\t./lib.dylib (compatibility version 0.0.0, current version 0.0.0)\n\t/usr/lib/libSystem.B.dylib (compatibility version 1.0.0, current version 1.0.0)\n`;
  assert.deepEqual(parseOtoolDependencies(universalDylibOutput, { dylib: true }), [
    "/usr/lib/libSystem.B.dylib",
    "/usr/lib/libSystem.B.dylib",
  ]);
});

test("provider-lock export parsing includes CPython packages and excludes Windows markers", () => {
  const packages = parseExportedRequirements(`always_here==1.0.0
windows-only==2.0.0 ; sys_platform == 'win32' \\
    --hash=sha256:${"0".repeat(64)}
cpython-only==3.0.0 ; platform_python_implementation != 'PyPy' \\
    --hash=sha256:${"1".repeat(64)}
`);
  assert.deepEqual([...packages], [["always-here", "1.0.0"], ["cpython-only", "3.0.0"]]);
  assert.throws(
    () => parseExportedRequirements("unknown==1.0.0 ; python_version > '3.10' \\\n"),
    /unsupported provider-lock marker/,
  );
});

test("installed Python metadata removes volatile cache and stale console-script records", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-python-metadata-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const outputs = [];
  for (const variant of ["first-absolute-shebang", "second-absolute-shebang"]) {
    const site = path.join(root, variant, "site-packages");
    const distInfo = path.join(site, "example-1.0.0.dist-info");
    await mkdir(distInfo, { recursive: true });
    await writeFile(path.join(site, "example.py"), "VALUE = 1\n");
    await writeFile(path.join(distInfo, "uv_cache.json"), JSON.stringify({ timestamp: variant }));
    await writeFile(path.join(distInfo, "direct_url.json"), JSON.stringify({ url: `/tmp/${variant}` }));
    await writeFile(path.join(distInfo, "RECORD"), [
      `bin/example,sha256=${variant},123`,
      "example.py,sha256=stable,10",
      `example-1.0.0.dist-info/direct_url.json,sha256=${variant},1`,
      `example-1.0.0.dist-info/uv_cache.json,sha256=${variant},1`,
      "example-1.0.0.dist-info/RECORD,,",
      "",
    ].join("\n"));
    await normalizeInstalledPythonMetadata([site]);
    outputs.push(await readFile(path.join(distInfo, "RECORD"), "utf8"));
    await assert.rejects(readFile(path.join(distInfo, "uv_cache.json"), "utf8"), /ENOENT/);
  }
  assert.equal(outputs[0], outputs[1]);
  assert.equal(outputs[0], "example.py,sha256=stable,10\nexample-1.0.0.dist-info/RECORD,,\n");
});

test("Python SBOM reconciliation replaces wall-clock UUID and timestamp with epoch identity", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-python-sbom-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const outputs = [];
  for (const variant of ["first", "second"]) {
    const sbomPath = path.join(root, `${variant}.json`);
    await writeFile(sbomPath, JSON.stringify({
      bomFormat: "CycloneDX",
      specVersion: "1.5",
      serialNumber: `urn:uuid:${variant}`,
      metadata: { timestamp: `${variant}-wall-clock`, tools: [{ name: "uv" }] },
      components: [{ name: "example", version: "1.0.0", licenses: [{ expression: "NOASSERTION" }] }],
    }));
    await reconcilePythonSbom(sbomPath, [{ name: "example", version: "1.0.0", license: "MIT" }], { sourceDateEpoch: 0 });
    outputs.push(await readFile(sbomPath, "utf8"));
  }
  assert.equal(outputs[0], outputs[1]);
  const reconciled = JSON.parse(outputs[0]);
  assert.equal(reconciled.metadata.timestamp, "1970-01-01T00:00:00.000Z");
  assert.match(reconciled.serialNumber, /^urn:uuid:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
});

test("Python runtime pruning removes the complete unreachable Tcl Tk GUI closure atomically", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-python-prune-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const libraryRoot = path.join(root, "lib");
  const dynamicRoot = path.join(libraryRoot, "python3.12", "lib-dynload");
  for (const directory of ["itcl4.2.4", "tcl8", "tcl8.6", "thread2.8.9", "tk8.6"]) {
    await mkdir(path.join(libraryRoot, directory), { recursive: true });
    await writeFile(path.join(libraryRoot, directory, "payload"), directory);
  }
  await mkdir(dynamicRoot, { recursive: true });
  for (const directory of ["idlelib", "tkinter", "turtledemo"]) {
    await mkdir(path.join(libraryRoot, "python3.12", directory), { recursive: true });
    await writeFile(path.join(libraryRoot, "python3.12", directory, "payload.py"), "gui\n");
  }
  for (const file of ["libtcl8.6.dylib", "libtk8.6.dylib"]) await writeFile(path.join(libraryRoot, file), file);
  await writeFile(path.join(dynamicRoot, "_tkinter.cpython-312-darwin.so"), "native");
  await writeFile(path.join(libraryRoot, "python3.12", "turtle.py"), "gui\n");
  await writeFile(path.join(dynamicRoot, "_sqlite3.cpython-312-darwin.so"), "retained");

  const evidence = await pruneUnusedPythonRuntime(root);
  assert.equal(evidence.status, "pruned");
  assert.deepEqual((await readdir(libraryRoot)).sort(), ["python3.12"]);
  assert.deepEqual(await readdir(dynamicRoot), ["_sqlite3.cpython-312-darwin.so"]);
});

test("size reports expose explicit first-release status and reproducible prior-build deltas", () => {
  const current = { platform: "darwin-arm64", installedBytes: 120, compressedBytes: 60 };
  assert.deepEqual(compareSizeReports(current), {
    status: "baseline-not-provided",
    previousBuildId: null,
    installedBytesDelta: null,
    installedPercentDelta: null,
    compressedBytesDelta: null,
    compressedPercentDelta: null,
  });
  assert.deepEqual(compareSizeReports(current, {
    platform: "darwin-arm64",
    buildId: "previous-build",
    installedBytes: 100,
    compressedBytes: 50,
  }), {
    status: "compared",
    previousBuildId: "previous-build",
    installedBytesDelta: 20,
    installedPercentDelta: 20,
    compressedBytesDelta: 10,
    compressedPercentDelta: 20,
  });
  assert.throws(
    () => compareSizeReports(current, { platform: "linux-arm64", buildId: "wrong", installedBytes: 1, compressedBytes: 1 }),
    /platform does not match/,
  );
});

test("web contribution evidence invokes Vite directly with hidden source maps", () => {
  assert.deepEqual(webContributionBuildInvocation(), {
    command: "corepack",
    args: ["pnpm", "--filter", "@jobctrl/web", "exec", "vite", "build", "--sourcemap", "hidden"],
  });
});

test("Node attribution closure is exactly bidirectional at name and version granularity", () => {
  const contributors = [
    { key: "runtime-a@1.0.0" },
    { key: "runtime-b@2.0.0" },
  ];
  const inventory = {
    packages: [
      { name: "runtime-a", versions: ["1.0.0"], contributions: [{ kind: "payload-npm-tree", artifactPath: "api/node_modules/runtime-a" }] },
      { name: "runtime-b", versions: ["2.0.0"], contributions: [{ kind: "web-hidden-sourcemap", artifactPath: "web" }] },
    ],
  };
  assert.equal(assertNodeAttributionClosure(contributors, inventory), true);
  assert.throws(
    () => assertNodeAttributionClosure(contributors, { packages: [inventory.packages[0]] }),
    /missing=runtime-b@2\.0\.0/,
  );
  assert.throws(
    () => assertNodeAttributionClosure(contributors, {
      packages: [{ name: "runtime-a", versions: ["1.0.0"], contributions: [] }],
    }),
    /lacks a concrete contribution reference/,
  );
  assert.throws(
    () => assertNodeAttributionClosure(contributors, {
      packages: [{ name: "runtime-a", versions: ["1.0.0", "1.0.1"], contributions: [{ kind: "payload-npm-tree" }] }],
    }),
    /exactly one version/,
  );
});

test("Node source attribution resolves the package boundary rather than internal package metadata", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-npm-contribution-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const packageRoot = path.join(root, "node_modules", ".pnpm", "runtime-a@1.0.0", "node_modules", "runtime-a");
  const internalRoot = path.join(packageRoot, "v4", "classic");
  await mkdir(internalRoot, { recursive: true });
  await writeFile(path.join(packageRoot, "package.json"), JSON.stringify({
    name: "runtime-a",
    version: "1.0.0",
    license: "MIT",
  }));
  await writeFile(path.join(internalRoot, "package.json"), JSON.stringify({ private: true }));
  const identity = await npmIdentityForContributingSource(root, path.join(internalRoot, "package.json"), {
    kind: "api-esbuild-metafile",
    artifactPath: "api/server.mjs",
  });
  assert.equal(identity?.key, "runtime-a@1.0.0");
  assert.equal(identity?.packageRoot, packageRoot);
});

test("MIT runtime packages without a bundled license text use their shipped metadata plus canonical MIT text", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-node-license-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "runtime-a", version: "1.0.0", license: "MIT" }));
  const contributor = {
    key: "runtime-a@1.0.0",
    name: "runtime-a",
    version: "1.0.0",
    license: "MIT",
    attribution: "Runtime A",
    source: "https://example.test/runtime-a",
    packageRoots: new Set([root]),
    contributions: new Map([[JSON.stringify({ kind: "payload-npm-tree", artifactPath: "api/node_modules/runtime-a" }), {
      kind: "payload-npm-tree",
      artifactPath: "api/node_modules/runtime-a",
      sourceCount: 1,
    }]]),
  };
  const collected = await collectNodeLicenseInventory({ nodeLicenseEvidenceLocks: { inputs: [] } }, root, [contributor]);
  assert.equal(collected.inventory.packages[0].name, "runtime-a");
  assert.equal(collected.licenseSources.length, 2);
  assert.ok(collected.licenseSources.some((entry) => entry.source.endsWith("package.json")));
  assert.ok(collected.licenseSources.some((entry) => entry.source.endsWith("MIT.txt")));
});

test("physical npm payload traversal rejects pnpm virtual-store content", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-payload-npm-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const nodeModules = path.join(root, "api", "node_modules");
  await mkdir(path.join(nodeModules, ".pnpm", "runtime-a", "node_modules", "runtime-a"), { recursive: true });
  await assert.rejects(
    collectPayloadNpmContributors(root, nodeModules),
    /pnpm virtual-store content is forbidden in the payload/,
  );
});

test("child termination retains one exit promise across timeout and stale exitCode observation", async () => {
  class RacingChild extends EventEmitter {
    exitCode = null;
    signalCode = null;
    signals = [];

    kill(signal) {
      this.signals.push(signal);
      if (signal === "SIGKILL") this.emit("exit", null, "SIGTERM");
      return true;
    }
  }
  const child = new RacingChild();
  assert.deepEqual(await terminateChildProcess(child, { timeoutMs: 0 }), {
    status: "exited",
    exitCode: null,
    signalCode: "SIGTERM",
    forced: true,
  });
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("extracted runtime stack plan uses embedded binaries, persistent Temporal state, and one shared runtime identity", () => {
  const componentPaths = new Map([
    ["python-runtime", "python"],
    ["node-runtime", "node"],
    ["temporal-runtime", "temporal"],
    ["jobctrl-web", "web"],
    ["chromium-core", "chromium"],
  ]);
  const plan = createExtractedRuntimeStackPlan({
    payloadRoot: "/tmp/extracted/payload",
    stateRoot: "/tmp/extracted/state",
    temporalPort: 17233,
    apiPort: 18000,
    contracts: { componentPaths },
  });
  assert.equal(plan.environment.TEMPORAL_ADDRESS, "127.0.0.1:17233");
  assert.equal(plan.environment.JOBCTRL_DIR, "/tmp/extracted/state/home/.jobctrl");
  assert.deepEqual(plan.worker, {
    command: "/tmp/extracted/payload/python/bin/python3",
    args: ["-I", "-B", "-m", "jobctrl", "worker"],
  });
  assert.equal(plan.api.command, "/tmp/extracted/payload/node/bin/node");
  assert.ok(plan.temporal.args.includes("--db-filename"));
  assert.ok(plan.temporal.args.includes(plan.temporalDbPath));
  assert.ok(plan.temporal.args.includes("--disable-config-file"));
  assert.ok(plan.temporalHealth.args.includes("--disable-config-file"));
});

test("extension capture smoke uses the real bearer plus Chrome extension caller contract", () => {
  const token = "t".repeat(32);
  assert.deepEqual(extensionCaptureSmokeHeaders(token), {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    "sec-fetch-site": "cross-site",
  });
});

test("successful distribution CLI invocation accepts the option separator and always persists build-result.json", async (context) => {
  const output = await mkdtemp(path.join(os.tmpdir(), "jobctrl-cli-result-"));
  context.after(async () => rm(output, { recursive: true, force: true }));
  const { stdout } = await execFileAsync(process.execPath, [
    path.join(process.cwd(), "scripts", "distribution-build.mjs"),
    "fixture",
    "--",
    "--output", output,
  ], { cwd: process.cwd() });
  const result = JSON.parse(await readFile(path.join(output, "build-result.json"), "utf8"));
  assert.equal(result.mode, "fixture");
  assert.equal(JSON.parse(stdout).archiveSha256, result.archiveSha256);
});

test("the bundled Playwright headless-shell revision is preseeded with immutable first-launch markers", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-browser-markers-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  for (const revision of ["chromium_headless_shell-1208"]) {
    const revisionRoot = path.join(root, revision);
    await mkdir(revisionRoot, { recursive: true });
    await writePlaywrightRevisionMarkers(revisionRoot);
    assert.deepEqual((await buildFileInventory(revisionRoot)).map((file) => [file.path, file.mode, file.sizeBytes]), [
      ["DEPENDENCIES_VALIDATED", "0644", 0],
      ["INSTALLATION_COMPLETE", "0644", 0],
    ]);
  }
});

test("fixture builds are bytewise reproducible in different directories", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "jobctrl-payload-fixture-"));
  context.after(async () => rm(parent, { recursive: true, force: true }));
  const first = await buildFixturePayload({ outputDirectory: path.join(parent, "first") });
  const second = await buildFixturePayload({ outputDirectory: path.join(parent, "second") });
  assert.deepEqual(first.manifest, second.manifest);
  assert.equal(first.manifestSha256, second.manifestSha256);
  assert.equal(first.archiveSha256, second.archiveSha256);
  assert.equal(first.release.descriptorSha256, second.release.descriptorSha256);
  assert.equal(await readFile(first.release.descriptorPath, "utf8"), await readFile(second.release.descriptorPath, "utf8"));
  assert.match(first.archivePath, /\.zip$/);
  assert.deepEqual(first.sizeReport, second.sizeReport);
  assert.equal(first.manifest.signing.codeSigning, "unsigned-local");
  assert.equal(first.manifest.signing.notarized, false);
  assert.equal(first.manifest.components.length, 12);
  assert.equal(first.sizeReport.components.length, 16);
  assert.deepEqual(first.sizeReport.providerPackTotals, {
    measurementStatus: "unavailable-fixture",
    packCount: 3,
    wheelCount: 46,
    downloadBytes: 197697242,
    installedBytes: null,
    fileCount: null,
    treeSha256: null,
    installedSizeSource: "unavailable-fixture",
  });
  assert.ok(first.sizeReport.providerPacks.every((pack) => pack.measurementStatus === "unavailable-fixture"));
  assert.equal(first.sizeReport.comparison.providerPacks.status, "unavailable-fixture");
  assert.deepEqual(
    first.sizeReport.components.filter((component) => component.accounting === "fixture-unmaterialized").map((component) => component.id),
    ["better-sqlite3-native", "font-geist", "font-jetbrains-mono", "system-browser-adapter"],
  );
  assert.ok(first.manifest.files.some((file) => file.path === "release/sbom.cdx.json"));
  assert.ok(first.manifest.files.some((file) => file.path === "release/capability-policy.json"));
  assert.ok(first.manifest.files.some((file) => file.path === "launcher/jobctrl"));
  assert.ok(first.manifest.files.some((file) => file.path === "launcher/jobctrl-installer"));
  assert.ok(first.manifest.files.every((file) => !/claude|openai.codex|antigravity/i.test(file.path)));
});

test("fixture release metadata preserves the selected root legal files and requires NOTICE", async (context) => {
  const parent = await mkdtemp(path.join(os.tmpdir(), "jobctrl-fixture-legal-root-"));
  context.after(async () => rm(parent, { recursive: true, force: true }));
  const fixtureRoot = await createFixtureBuildRoot(path.join(parent, "root"));
  const license = "fixture root license\n";
  const notice = "fixture root notice\n";
  await writeFile(path.join(fixtureRoot, "LICENSE"), license, { mode: 0o644 });
  await writeFile(path.join(fixtureRoot, "NOTICE"), notice, { mode: 0o644 });

  const build = await buildFixturePayload({
    outputDirectory: path.join(parent, "build"),
    root: fixtureRoot,
  });
  const licensesRoot = path.join(build.payloadRoot, "release", "licenses");
  const licensePath = path.join(licensesRoot, "JobCtrl-AGPL-3.0.txt");
  const noticePath = path.join(licensesRoot, "JobCtrl-NOTICE.txt");
  assert.equal(await readFile(licensePath, "utf8"), license);
  assert.equal(await readFile(noticePath, "utf8"), notice);
  assert.deepEqual(
    JSON.parse(await readFile(path.join(licensesRoot, "index.json"), "utf8")).projectLegalFiles,
    [
      { path: "JobCtrl-AGPL-3.0.txt", sha256: await sha256File(licensePath) },
      { path: "JobCtrl-NOTICE.txt", sha256: await sha256File(noticePath) },
    ],
  );
  const manifestPaths = new Set(build.manifest.files.map((file) => file.path));
  assert.ok(manifestPaths.has("release/licenses/JobCtrl-AGPL-3.0.txt"));
  assert.ok(manifestPaths.has("release/licenses/JobCtrl-NOTICE.txt"));

  const missingNoticeRoot = await createFixtureBuildRoot(path.join(parent, "missing-notice-root"));
  await rm(path.join(missingNoticeRoot, "NOTICE"));
  await assert.rejects(
    buildFixturePayload({ outputDirectory: path.join(parent, "missing-notice-build"), root: missingNoticeRoot }),
    /JobCtrl NOTICE is missing/,
  );
});

test("fixture manifest covers the exact payload tree", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-payload-tree-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const build = await buildFixturePayload({ outputDirectory: root });
  assert.equal(await verifyExactPayloadTree(build.payloadRoot, build.manifest), true);
  await writeFile(path.join(build.payloadRoot, "api", "unrecorded"), "mutation\n", { mode: 0o644 });
  await assert.rejects(verifyExactPayloadTree(build.payloadRoot, build.manifest), /does not exactly match/);
});

test("smoke extraction keeps generated state outside the exact immutable payload tree", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-payload-smoke-layout-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const build = await buildFixturePayload({ outputDirectory: root });
  const layout = await prepareExtractedSmokeLayout({
    archivePath: build.archivePath,
    outputRoot: root,
  });

  assert.equal(path.dirname(layout.payloadRoot), layout.canonicalExtractedRoot);
  assert.equal(path.dirname(layout.homeRoot), layout.canonicalExtractedRoot);
  assert.equal(path.dirname(layout.stateRoot), layout.homeRoot);
  assert.notEqual(layout.payloadRoot, layout.homeRoot);
  assert.ok(!layout.homeRoot.startsWith(`${layout.payloadRoot}${path.sep}`));
  assert.ok(!layout.stateRoot.startsWith(`${layout.payloadRoot}${path.sep}`));
  assert.ok(!layout.payloadRoot.startsWith(`${layout.homeRoot}${path.sep}`));

  await writeFile(path.join(layout.stateRoot, "distribution-smoke.pdf"), "smoke state\n", { mode: 0o644 });
  assert.equal(await verifyExactPayloadTree(layout.payloadRoot, build.manifest), true);
  assert.ok((await buildFileInventory(layout.canonicalExtractedRoot)).some(
    (file) => file.path === "home/.jobctrl/distribution-smoke.pdf",
  ));
  assert.ok(!(await buildFileInventory(layout.payloadRoot)).some(
    (file) => file.path === "home/.jobctrl/distribution-smoke.pdf",
  ));
});

test("installed Python pruning removes proven build sources, docs, examples, and fixtures", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-python-runtime-prune-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const files = new Map([
    ["temporalio/bridge/temporal_sdk_bridge.abi3.so", "native\n"],
    ["temporalio/bridge/sdk-core/README.md", "build checkout\n"],
    ["temporalio/bridge/src/lib.rs", "source\n"],
    ["temporalio/bridge/Cargo.toml", "[package]\n"],
    ["temporalio/bridge/Cargo.lock", "lock\n"],
    ["google/protobuf/testdata/__init__.py", ""],
    ["numpy/random/_examples/example.pyx", "source\n"],
    ["playwright/driver/README.md", "docs\n"],
    ["temporalio/contrib/openai_agents/README.md", "docs\n"],
    ["runtime-package/.gitattributes", "*.py text\n"],
    ["runtime-package/.gitmodules", "[submodule]\n"],
    ["httpx-1.0.dist-info/licenses/LICENSE.md", "legal\n"],
  ]);
  for (const [relativePath, contents] of files) {
    const destination = path.join(root, ...relativePath.split("/"));
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, contents, { mode: 0o644 });
  }

  const result = await pruneInstalledPythonTree(root);

  assert.equal(result.temporalBridge.status, "temporal-bridge-build-sources-pruned");
  assert.deepEqual(result.temporalBridge.removedPaths, [
    "temporalio/bridge/sdk-core",
    "temporalio/bridge/src",
    "temporalio/bridge/Cargo.toml",
    "temporalio/bridge/Cargo.lock",
  ]);
  assert.deepEqual((await buildFileInventory(root)).map((file) => file.path), [
    "httpx-1.0.dist-info/licenses/LICENSE.md",
    "temporalio/bridge/temporal_sdk_bridge.abi3.so",
  ]);
});

test("forbidden scan rejects provider packs, dev tools, caches, and build-path leaks", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-forbidden-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "worker", "claude_agent_sdk"), { recursive: true });
  await writeFile(path.join(root, "worker", "claude_agent_sdk", "client.py"), "pass\n", { mode: 0o644 });
  await mkdir(path.join(root, "node", "bin"), { recursive: true });
  await writeFile(path.join(root, "node", "bin", "npm"), "#!/bin/sh\n", { mode: 0o755 });
  await chmod(path.join(root, "node", "bin", "npm"), 0o755);
  await assert.rejects(scanForbiddenPayload(root), /provider pack entered|forbidden build tool/);

  await rm(path.join(root, "worker"), { recursive: true });
  await rm(path.join(root, "node"), { recursive: true });
  await mkdir(path.join(root, "api"), { recursive: true });
  await writeFile(path.join(root, "api", "server.mjs"), "source=/private/tmp/secret-build\n", { mode: 0o644 });
  await assert.rejects(scanForbiddenPayload(root, { forbiddenAbsolutePaths: ["/private/tmp/secret-build"] }), /leaks build path/);

  await rm(path.join(root, "api", "server.mjs"));
  const largeBinary = Buffer.concat([Buffer.alloc(3 * 1024 * 1024), Buffer.from("/private/tmp/secret-build")]);
  await writeFile(path.join(root, "api", "large-native.bin"), largeBinary, { mode: 0o644 });
  await assert.rejects(
    scanForbiddenPayload(root, { forbiddenAbsolutePaths: ["/private/tmp/secret-build"] }),
    /artifact-wide forbidden build\/runtime string/,
  );

  await rm(path.join(root, "api"), { recursive: true });
  await mkdir(path.join(root, "playwright-mcp", "node_modules", "playwright-core", "lib", "vite", "traceViewer"), { recursive: true });
  await writeFile(
    path.join(root, "playwright-mcp", "node_modules", "playwright-core", "lib", "vite", "traceViewer", "index.html"),
    "viewer\n",
    { mode: 0o644 },
  );
  await assert.rejects(scanForbiddenPayload(root), /Playwright MCP test\/docs\/viewer closure/);

  await rm(path.join(root, "playwright-mcp"), { recursive: true });
  await mkdir(path.join(root, "playwright-mcp", "node_modules", "@playwright", "mcp"), { recursive: true });
  await writeFile(path.join(root, "playwright-mcp", "node_modules", "@playwright", "mcp", "README.md"), "docs\n", { mode: 0o644 });
  await assert.rejects(scanForbiddenPayload(root), /Playwright MCP test\/docs\/viewer closure|Playwright MCP documentation closure/);

  await rm(path.join(root, "playwright-mcp"), { recursive: true });
  await mkdir(path.join(root, ".playwright-mcp"), { recursive: true });
  await writeFile(path.join(root, ".playwright-mcp", "page.yml"), "generated state\n", { mode: 0o644 });
  await assert.rejects(scanForbiddenPayload(root), /development\/test\/cache path/);

  await rm(path.join(root, ".playwright-mcp"), { recursive: true });
  await mkdir(path.join(root, "worker", "site-packages", "temporalio", "bridge", "sdk-core"), { recursive: true });
  await writeFile(path.join(root, "worker", "site-packages", "temporalio", "bridge", "sdk-core", "lib.rs"), "source\n", { mode: 0o644 });
  await assert.rejects(scanForbiddenPayload(root), /Temporal bridge build\/source closure/);

  await rm(path.join(root, "worker"), { recursive: true });
  await mkdir(path.join(root, "worker", "site-packages", "google", "protobuf", "testdata"), { recursive: true });
  await writeFile(path.join(root, "worker", "site-packages", "google", "protobuf", "testdata", "fixture.bin"), "fixture\n", { mode: 0o644 });
  await assert.rejects(scanForbiddenPayload(root), /known non-runtime Python source\/docs\/fixture closure/);

  await rm(path.join(root, "worker"), { recursive: true });
  await mkdir(path.join(root, "worker", "site-packages", "runtime-package"), { recursive: true });
  await writeFile(path.join(root, "worker", "site-packages", "runtime-package", "README.md"), "runtime docs\n", { mode: 0o644 });
  await assert.rejects(scanForbiddenPayload(root), /runtime documentation outside the legal\/attribution allowlist/);

  await rm(path.join(root, "worker"), { recursive: true });
  await mkdir(path.join(root, "worker", "site-packages", "runtime-package"), { recursive: true });
  await writeFile(path.join(root, "worker", "site-packages", "runtime-package", ".gitmodules"), "[submodule]\n", { mode: 0o644 });
  await assert.rejects(scanForbiddenPayload(root), /Git metadata/);

  await rm(path.join(root, "worker"), { recursive: true });
  await mkdir(path.join(root, "worker", "site-packages", "httpx-1.0.dist-info", "licenses"), { recursive: true });
  await writeFile(path.join(root, "worker", "site-packages", "httpx-1.0.dist-info", "licenses", "LICENSE.md"), "legal\n", { mode: 0o644 });
  assert.equal((await scanForbiddenPayload(root)).status, "clean");
});

test("forbidden payload scan blocks Widevine from the redistributable Chromium core", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-widevine-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "chromium", "Google Chrome for Testing.app", "Contents", "Frameworks"), { recursive: true });
  await writeFile(path.join(root, "chromium", "Google Chrome for Testing.app", "Contents", "Frameworks", "libwidevinecdm.dylib"), "WidevineCdm", { mode: 0o644 });
  await assert.rejects(scanForbiddenPayload(root), /WidevineCdm|libwidevinecdm/);
});

test("headless Chromium topology rejects a full browser path even without Widevine", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-headless-topology-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const shell = path.join(root, "chromium", "chromium_headless_shell-1208", "chrome-headless-shell-mac-arm64", "chrome-headless-shell");
  await mkdir(path.dirname(shell), { recursive: true });
  await writeFile(shell, "headless", { mode: 0o755 });
  const contracts = { componentPaths: new Map([["chromium-core", "chromium"]]) };
  assert.match((await assertHeadlessChromiumPayload(root, contracts)).executable, /chrome-headless-shell$/);
  const fullBrowser = path.join(root, "chromium", "chromium-1208", "chrome-mac-arm64", "browser");
  await mkdir(path.dirname(fullBrowser), { recursive: true });
  await writeFile(fullBrowser, "not-widevine", { mode: 0o755 });
  await assert.rejects(assertHeadlessChromiumPayload(root, contracts), /unexpected browser revisions|full browser topology/);
});

test("tar parser preserves safe links and rejects traversal, hard links, and special modes", () => {
  const safe = tarArchive([
    { path: "wrapper/bin/tool", contents: "tool\n", mode: 0o755 },
    { path: "wrapper/bin/current", type: "2", target: "tool" },
  ]);
  assert.deepEqual(
    parseTarGzArchive(safe, { stripComponents: 1 }).map((entry) => [entry.type, entry.path, entry.target ?? null]),
    [["symlink", "bin/current", "tool"], ["file", "bin/tool", null]],
  );
  assert.throws(() => parseTarGzArchive(tarArchive([{ path: "../escape", contents: "x" }])), /escapes/);
  assert.throws(() => parseTarGzArchive(tarArchive([{ path: "hard", type: "1", target: "target" }])), /unsupported tar entry type/);
  assert.throws(() => parseTarGzArchive(tarArchive([{ path: "setuid", contents: "x", mode: 0o4755 }])), /unsafe special mode/);
  assert.throws(
    () => parseTarGzArchive(tarArchive([{ path: "Dir/File", contents: "a" }, { path: "dir/file", contents: "b" }])),
    /collides case-insensitively/,
  );
});

test("tar parser may skip an explicit upstream test subtree before portable path validation", () => {
  const archive = tarArchive([
    { path: "go/bin/go", mode: 0o755, contents: "compiler" },
    { path: "go/test/Þfixture.go", contents: "nonportable fixture" },
  ]);
  const entries = parseTarGzArchive(archive, {
    stripComponents: 1,
    skipEntry: (rawPath) => rawPath.startsWith("go/test/"),
  });
  assert.deepEqual(entries.map((entry) => entry.path), ["bin/go"]);
  assert.throws(() => parseTarGzArchive(archive, { stripComponents: 1 }), /printable ASCII/);
});

test("zip parser preserves Unix symlinks and rejects traversal and special entries", () => {
  const safe = storedZip([
    { path: "wrapper/bin/tool", contents: "tool\n", mode: 0o100755 },
    { path: "wrapper/bin/current", contents: "tool", mode: 0o120777 },
  ]);
  assert.deepEqual(
    parseZipArchive(safe, { stripComponents: 1 }).map((entry) => [entry.type, entry.path, entry.target ?? null]),
    [["symlink", "bin/current", "tool"], ["file", "bin/tool", null]],
  );
  assert.throws(() => parseZipArchive(storedZip([{ path: "../escape", contents: "x" }])), /escapes/);
  assert.throws(() => parseZipArchive(storedZip([{ path: "fifo", contents: "x", mode: 0o010644 }])), /unsupported ZIP entry type/);
  assert.throws(
    () => parseZipArchive(storedZip([{ path: "Dir/File", contents: "a" }, { path: "dir/file", contents: "b" }])),
    /collides case-insensitively/,
  );
});

test("deterministic tar emits GNU records for long paths and link targets", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-long-tar-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const longPath = `${"a".repeat(120)}/${"b".repeat(120)}/payload.txt`;
  await mkdir(path.join(root, path.posix.dirname(longPath)), { recursive: true });
  await writeFile(path.join(root, ...longPath.split("/")), "long path\n", { mode: 0o644 });
  await symlink(longPath, path.join(root, "current"));
  const archivePath = path.join(root, "payload.tar.gz");
  await createDeterministicTarGz(root, archivePath, 0);
  const entries = parseTarGzArchive(await readFile(archivePath), { stripComponents: 1 });
  assert.ok(entries.some((entry) => entry.type === "file" && entry.path === longPath));
  assert.ok(entries.some((entry) => entry.type === "symlink" && entry.path === "current" && entry.target === longPath));
});

test("deterministic ZIP preserves executable modes and confined symlinks at the payload root", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-deterministic-zip-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "launcher"), { recursive: true });
  await writeFile(path.join(root, "launcher", "jobctrl"), "#!/bin/sh\n", { mode: 0o755 });
  await chmod(path.join(root, "launcher", "jobctrl"), 0o755);
  await symlink("jobctrl", path.join(root, "launcher", "current"));
  const archivePath = path.join(root, "payload.zip");
  await createDeterministicZip(root, archivePath, 0);
  const entries = parseZipArchive(await readFile(archivePath));
  assert.deepEqual(entries.map((entry) => [entry.type, entry.path, entry.mode ?? null, entry.target ?? null]), [
    ["symlink", "launcher/current", null, "jobctrl"],
    ["file", "launcher/jobctrl", "0755", null],
  ]);
  const extracted = path.join(root, "extracted");
  await execFileAsync("/usr/bin/unzip", ["-q", archivePath, "-d", extracted]);
  assert.equal((await lstat(path.join(extracted, "launcher", "jobctrl"))).mode & 0o777, 0o755);
  assert.equal((await lstat(path.join(extracted, "launcher", "current"))).isSymbolicLink(), true);
  assert.equal(await readFile(path.join(extracted, "launcher", "current"), "utf8"), "#!/bin/sh\n");
});

test("locked archives are verified before safe extraction", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-archive-lock-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const archivePath = path.join(root, "input.tar.gz");
  await writeFile(archivePath, tarArchive([{ path: "wrapper/bin/tool", contents: "tool\n", mode: 0o755 }]), { mode: 0o644 });
  const lock = {
    id: "fixture-archive",
    archiveType: "tar.gz",
    sha256: await sha256File(archivePath),
  };
  assert.equal(await verifyLockedArchive(archivePath, lock), lock.sha256);
  const destination = path.join(root, "extracted");
  await extractVerifiedArchive({ archivePath, lock, destination, stripComponents: 1 });
  assert.equal(await readFile(path.join(destination, "bin", "tool"), "utf8"), "tool\n");
  assert.deepEqual((await buildFileInventory(destination)).map((file) => [file.path, file.mode]), [["bin/tool", "0755"]]);

  const bad = { ...lock, sha256: "0".repeat(64) };
  await assert.rejects(extractVerifiedArchive({ archivePath, lock: bad, destination: path.join(root, "must-not-exist") }), /SHA-256 mismatch/);
  await assert.rejects(readFile(path.join(root, "must-not-exist", "bin", "tool")), /ENOENT/);
});
