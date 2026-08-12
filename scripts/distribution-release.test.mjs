import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createHash, generateKeyPairSync } from "node:crypto";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { buildFixturePayload } from "./distribution-build.mjs";
import {
  canonicalReleaseUrls,
  chromiumEntitlementsForTarget,
  assertCandidateIdentity,
  assertPublishedVersion,
  assertPreSignVerificationMatches,
  assertRunningStatus,
  assertStoppedStatus,
  candidateIdentityFromDescriptor,
  classifyAppleSigningTargets,
  createReleaseChannelPointer,
  createAppleSigningPlan,
  notarizeAndStaplePayload,
  publishedCandidateSmokePlan,
  privateKeyFromBase64,
  renderPinnedInstallScript,
  recordPublishedCandidateSmoke,
  releasePublicKeyBase64,
  signReleaseBytes,
  verifyPyPIReleaseGate,
  verifyApplePayload,
  verifyReleaseBytes,
  main as releaseCli,
  validateReleaseDescriptor,
  validateReleaseChannelPointer,
  validateReleaseDescriptorSignature,
  verifyPreparedCandidate,
} from "./distribution-release.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const execFileAsync = promisify(execFile);

test("release signing accepts standard canonical Ed25519 PKCS#8 DER", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const privateKeyDer = Buffer.from(privateKey.export({ format: "der", type: "pkcs8" }));
  const publicKeyDer = Buffer.from(publicKey.export({ format: "der", type: "spki" }));
  const encodedPrivateKey = privateKeyDer.toString("base64");

  assert.equal(privateKeyDer.length, 48, "the standard Ed25519 PKCS#8 encoding is 48 bytes");
  const importedPrivateKey = privateKeyFromBase64(encodedPrivateKey);
  assert.equal(importedPrivateKey.asymmetricKeyType, "ed25519");
  assert.equal(
    releasePublicKeyBase64(importedPrivateKey),
    publicKeyDer.subarray(12).toString("base64"),
  );

  assert.throws(() => privateKeyFromBase64(`${encodedPrivateKey}\n`), /non-empty base64 PKCS#8 DER/);
  assert.throws(() => privateKeyFromBase64(`${encodedPrivateKey}=`), /canonical base64 PKCS#8 DER/);
  assert.throws(() => privateKeyFromBase64(Buffer.from("not a DER key").toString("base64")), /Ed25519 PKCS#8 DER key/);
  const { privateKey: ecPrivateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const ecPrivateKeyBase64 = Buffer.from(ecPrivateKey.export({ format: "der", type: "pkcs8" })).toString("base64");
  assert.throws(() => privateKeyFromBase64(ecPrivateKeyBase64), /release signing key must be Ed25519/);
});

test("public release metadata describes the independent pre-sign verification gate", async () => {
  const source = await readFile(
    path.join(process.cwd(), "scripts", "distribution-release.mjs"),
    "utf8",
  );
  assert.match(source, /independentPreSignVerificationRequired: true/);
  assert.doesNotMatch(source, /unsignedBuildComparisonRequired/);
});

test("tracked release-authority bundles are byte-reproducible with pinned esbuild", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-finalizer-rebuild-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const notice = await readFile(path.join(
    process.cwd(),
    "scripts",
    "distribution-release-authority-bundles.NOTICE.txt",
  ));
  for (const [source, bundle] of [
    ["distribution-release-finalizer-entry.mjs", "distribution-release.finalizer.bundle.mjs"],
    ["distribution-homebrew-render-entry.mjs", "distribution-homebrew.render.bundle.mjs"],
  ]) {
    const rebuilt = path.join(root, bundle);
    await execFileAsync("corepack", [
      "pnpm", "exec", "esbuild", `scripts/${source}`,
      "--bundle", "--platform=node", "--format=esm", "--target=node22",
      `--outfile=${rebuilt}`,
    ], { cwd: process.cwd() });
    const [actual, tracked, checksumRaw] = await Promise.all([
      readFile(rebuilt),
      readFile(path.join(process.cwd(), "scripts", bundle)),
      readFile(path.join(process.cwd(), "scripts", `${bundle}.sha256`), "utf8"),
    ]);
    assert.deepEqual(actual, tracked);
    assert.equal(
      checksumRaw,
      `${sha256(tracked)}  ${bundle}\n` +
      `${sha256(notice)}  distribution-release-authority-bundles.NOTICE.txt\n`,
    );
  }
});

test("tracked release-authority bundles dispatch exactly one intended CLI", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-authority-cli-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await writePyPIGateFixture(root, {
    privateKey: generateKeyPairSync("ed25519").privateKey,
  });
  const finalizer = path.join(
    process.cwd(),
    "scripts",
    "distribution-release.finalizer.bundle.mjs",
  );
  const importedFinalizer = await import(
    `${pathToFileURL(finalizer).href}?import-regression=${Date.now()}`
  );
  assert.equal(typeof importedFinalizer.privateKeyFromBase64, "function");
  assert.equal(typeof importedFinalizer.releasePublicKeyBase64, "function");
  const bundledPrivateKeyDer = Buffer.from(
    generateKeyPairSync("ed25519").privateKey.export({ format: "der", type: "pkcs8" }),
  );
  assert.equal(bundledPrivateKeyDer.length, 48);
  assert.equal(
    importedFinalizer.privateKeyFromBase64(bundledPrivateKeyDer.toString("base64")).asymmetricKeyType,
    "ed25519",
  );
  const pointerPath = path.join(root, "channel-pointer.json");
  const pointerRun = await execFileAsync(
    process.execPath,
    [finalizer, "validate-pointer", pointerPath],
    { cwd: process.cwd() },
  );
  assert.equal(pointerRun.stderr, "");
  assert.equal(JSON.parse(pointerRun.stdout).channel, "stable");

  const metadata = JSON.parse(
    await readFile(path.join(root, "release-metadata.json"), "utf8"),
  );
  const formulaPath = path.join(root, "jobctrl.rb");
  const homebrew = path.join(
    process.cwd(),
    "scripts",
    "distribution-homebrew.render.bundle.mjs",
  );
  const homebrewRun = await execFileAsync(process.execPath, [
    homebrew,
    "render",
    "--descriptor", path.join(root, "release-descriptor.json"),
    "--signature", path.join(root, "release-descriptor.json.sig"),
    "--descriptor-url", metadata.publicationUrls.immutableDescriptorUrl,
    "--trust", path.join(root, "release-keys.json"),
    "--output", formulaPath,
  ], { cwd: process.cwd() });
  assert.equal(homebrewRun.stderr, "");
  assert.equal(JSON.parse(homebrewRun.stdout).output, formulaPath);
  assert.match(await readFile(formulaPath, "utf8"), /class Jobctrl < Formula/);
});

test("release CLI rejects non-canonical owner-supplied integers", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-release-integers-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const verification = path.join(root, "verification.json");
  await writeFile(verification, "{}\n");
  const args = (sequence, minimumSafeSequence, sourceDateEpoch) => [
    "finalize",
    "--prepared", path.join(root, "prepared"),
    "--verification", verification,
    "--output", path.join(root, "release"),
    "--channel", "stable",
    "--sequence", sequence,
    "--minimum-safe-sequence", minimumSafeSequence,
    "--revoked-build-ids", "[]",
    "--source-date-epoch", sourceDateEpoch,
    "--source-commit", "a".repeat(40),
  ];

  await assert.rejects(releaseCli(args("42junk", "1", "0")), /--sequence must be a canonical integer/);
  await assert.rejects(releaseCli(args("42", "01", "0")), /--minimum-safe-sequence must be a canonical integer/);
  await assert.rejects(releaseCli(args("42", "1", "0junk")), /--source-date-epoch must be a canonical integer/);
});

async function writePyPIGateFixture(root, { privateKey, sourceCommit = "a".repeat(40) }) {
  const keyId = "jobctrl-release-v1";
  const publicKeyBase64 = releasePublicKeyBase64(privateKey);
  const archiveFile = "jobctrl-0.1.0-darwin-arm64.zip";
  const archive = Buffer.from("fixture P6 archive\n");
  const manifestRaw = '{"fixture":"signed-manifest"}\n';
  const urls = canonicalReleaseUrls("stable", archiveFile, "stable-build-0000042");
  const descriptor = {
    schemaVersion: 1,
    channel: "stable",
    sequence: 42,
    minimumSafeSequence: 1,
    revokedBuildIds: [],
    buildId: "stable-build-0000042",
    appVersion: "0.1.0",
    sourceCommit,
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: {
      url: urls.artifactUrl,
      sha256: sha256(archive),
      sizeBytes: archive.length,
      archiveType: "zip",
      manifestSha256: sha256(manifestRaw),
    },
  };
  const descriptorRaw = `${JSON.stringify(descriptor, null, 2)}\n`;
  const descriptorSignatureRaw = `${JSON.stringify(signReleaseBytes({ domain: "jobctrl:release-descriptor:v1\0", raw: descriptorRaw, privateKey, keyId, kind: "descriptor" }), null, 2)}\n`;
  const channelPointerRaw = `${JSON.stringify(createReleaseChannelPointer({ descriptorRaw, signatureRaw: descriptorSignatureRaw, descriptorUrl: urls.immutableDescriptorUrl, signatureUrl: urls.immutableDescriptorSignatureUrl }), null, 2)}\n`;
  const manifestSignatureRaw = `${JSON.stringify(signReleaseBytes({ domain: "jobctrl:manifest:v1\0", raw: manifestRaw, privateKey, keyId, kind: "manifest" }), null, 2)}\n`;
  const installer = "fixture installer\n";
  const metadata = {
    schemaVersion: 1,
    status: "signed-notarized-release-candidate",
    publicationStatus: "blocked-until-published-candidate-smoke",
    pypiPublicationAuthorized: false,
    channel: "stable",
    buildId: descriptor.buildId,
    appVersion: descriptor.appVersion,
    sourceCommit,
    archive: { file: archiveFile, sha256: descriptor.artifact.sha256, sizeBytes: archive.length, url: urls.artifactUrl },
    installer: { file: "jobctrl-installer", sha256: sha256(installer), url: urls.installerUrl },
    publicationUrls: urls,
    channelPointer: { sha256: sha256(channelPointerRaw), url: urls.immutableChannelPointerUrl },
    manifest: { sha256: descriptor.artifact.manifestSha256, keyId },
    descriptor: { sha256: sha256(descriptorRaw), keyId },
  };
  const smoke = {
    schemaVersion: 1,
    status: "passed",
    publicationStatus: "published-candidate-verified",
    pypiPublicationAuthorized: true,
    descriptorUrl: urls.immutableDescriptorUrl,
    channelPointerUrl: urls.immutableChannelPointerUrl,
    installerUrl: urls.installerUrl,
    installerSha256: metadata.installer.sha256,
    candidate: {
      descriptorSha256: metadata.descriptor.sha256,
      buildId: descriptor.buildId,
      appVersion: descriptor.appVersion,
      artifactSha256: descriptor.artifact.sha256,
      artifactSizeBytes: archive.length,
      manifestSha256: descriptor.artifact.manifestSha256,
    },
  };
  const files = new Map([
    [archiveFile, archive],
    ["jobctrl-installer", installer],
    ["release-descriptor.json", descriptorRaw],
    ["release-descriptor.json.sig", descriptorSignatureRaw],
    ["channel-pointer.json", channelPointerRaw],
    ["manifest.json", manifestRaw],
    ["manifest.sig", manifestSignatureRaw],
    ["release-keys.json", `${JSON.stringify({ schemaVersion: 1, keys: { [keyId]: publicKeyBase64 } }, null, 2)}\n`],
    ["release-metadata.json", `${JSON.stringify(metadata, null, 2)}\n`],
    ["published-candidate-smoke.json", `${JSON.stringify(smoke, null, 2)}\n`],
  ]);
  for (const [name, contents] of files) await writeFile(path.join(root, name), contents);
  const sums = [...files.entries()]
    .filter(([name]) => name !== "published-candidate-smoke.json")
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, contents]) => `${sha256(contents)}  ${name}`)
    .join("\n");
  await writeFile(path.join(root, "SHA256SUMS"), `${sums}\n`);
  return { keyId, publicKeyBase64, sourceCommit };
}

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
    appVersion: "0.1.0",
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: {
      url: "file:///jobctrl-local-release/jobctrl-0.1.0-darwin-arm64.zip",
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

test("release signatures have strict manifest and descriptor domains", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = '{"fixture":true}\n';
  const manifest = signReleaseBytes({ domain: "jobctrl:manifest:v1\0", raw, privateKey, keyId: "fixture-key", kind: "manifest" });
  assert.doesNotThrow(() => verifyReleaseBytes({ domain: "jobctrl:manifest:v1\0", raw, signature: manifest, publicKey, keyId: "fixture-key", kind: "manifest" }));
  assert.throws(() => verifyReleaseBytes({ domain: "jobctrl:release-descriptor:v1\0", raw, signature: manifest, publicKey, keyId: "fixture-key", kind: "manifest" }), /verification failed/);
});

test("Apple signing preserves a valid outer vendor app and signs only the remaining leaf-first code", async () => {
  const root = "/private/tmp/jobctrl-signing-fixture";
  const vendorApp = `${root}/chromium/Chromium.app`;
  const targets = await classifyAppleSigningTargets({
    machO: [`${vendorApp}/Contents/MacOS/Chromium`, `${root}/launcher/jobctrl`, `${root}/launcher/jobctrl-installer`],
    appBundles: [vendorApp],
    runner: async (command, args) => {
      if (command === "/usr/sbin/spctl") return { stdout: "source=Notarized Developer ID", stderr: "" };
      assert.equal(command, "/usr/bin/codesign");
      if (args[0] === "-dv") return { stdout: "", stderr: args.at(-1) === vendorApp ? "Authority=Developer ID Application: Vendor (TEAM)" : "Signature=adhoc" };
      if (args[0] === "--verify") return { stdout: "", stderr: "" };
      throw new Error(`unexpected ${args.join(" ")}`);
    },
  });
  assert.deepEqual(targets.preservedApps, [vendorApp]);
  assert.deepEqual(targets.signingMachO, [`${root}/launcher/jobctrl`, `${root}/launcher/jobctrl-installer`]);
  const plan = createAppleSigningPlan({ machO: targets.signingMachO, appBundles: targets.signingApps, identity: "Developer ID Application: Fixture (TEAM)" });
  assert.equal(plan.length, 2);
  assert.ok(plan.every((command) => !command.args.includes("--deep")));
  assert.ok(plan.every((command) => !command.target.includes("Chromium.app")));
});

test("Apple signing rejects ad-hoc apps, preserves both signed Node executables, and entitles only the headless core shell", async () => {
  const root = "/private/tmp/jobctrl-signing-roles";
  const chrome = `${root}/chromium/Google Chrome for Testing.app`;
  const node = `${root}/node/bin/node`;
  const playwrightNode = `${root}/playwright-python/site-packages/playwright/driver/node`;
  const classified = await classifyAppleSigningTargets({
    machO: [`${chrome}/Contents/MacOS/Google Chrome for Testing`, node, playwrightNode],
    appBundles: [chrome],
    runner: async (command, args) => {
      if (command === "/usr/bin/codesign" && args[0] === "-dv") {
        return { stdout: "", stderr: [node, playwrightNode].includes(args.at(-1)) ? "Authority=Developer ID Application: Node.js Foundation (HX7739G8FX)\nTeamIdentifier=HX7739G8FX" : "Signature=adhoc" };
      }
      if (command === "/usr/bin/codesign") return { stdout: "", stderr: "" };
      if (command === "/usr/sbin/spctl") return { stdout: "source=Notarized Developer ID", stderr: "" };
      throw new Error(`unexpected ${command}`);
    },
  });
  assert.deepEqual(classified.preservedApps, []);
  assert.deepEqual(classified.preservedStandalone, [node, playwrightNode]);
  assert.ok(classified.signingMachO.some((target) => target.includes("Google Chrome for Testing")));
  assert.ok(!classified.signingMachO.includes(node));
  assert.ok(!classified.signingMachO.includes(playwrightNode));

  const headless = `${root}/chromium/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
  const dylib = `${root}/chromium/chromium_headless_shell-1208/chrome-headless-shell-mac-arm64/libEGL.dylib`;
  const plan = createAppleSigningPlan({
    machO: [headless, dylib],
    codeBundles: [],
    identity: "Developer ID Application: Fixture (TEAM)",
  });
  const commandFor = (target) => plan.find((entry) => entry.target === target).args;
  assert.ok(commandFor(headless).some((value) => value.endsWith("chromium-headless-shell.entitlements.plist")));
  assert.ok(!commandFor(dylib).includes("--entitlements"));
  assert.equal(chromiumEntitlementsForTarget(headless).endsWith("chromium-headless-shell.entitlements.plist"), true);
  assert.equal(chromiumEntitlementsForTarget(`${chrome}/Contents/MacOS/Google Chrome for Testing`), null);
});

test("Apple signing fails closed when a bundled Node path loses its vendor signature or notarization", async () => {
  const node = "/private/tmp/jobctrl-signing-node/node/bin/node";
  await assert.rejects(
    classifyAppleSigningTargets({
      machO: [node],
      appBundles: [],
      runner: async (command, args) => {
        assert.equal(command, "/usr/bin/codesign");
        assert.equal(args[0], "-dv");
        return { stdout: "", stderr: "Authority=Developer ID Application: Wrong Vendor (BADTEAM)\nTeamIdentifier=BADTEAM" };
      },
    }),
    /bundled Node executable is not preservably signed/,
  );
});

test("notarization requires an Accepted submission and log, then staples only outer applications", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-notary-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const archive = path.join(root, "candidate.zip");
  await writeFile(archive, "fixture");
  const outer = `${root}/Chromium.app`;
  const nested = `${outer}/Contents/Helpers/Helper.app`;
  const calls = [];
  const result = await notarizeAndStaplePayload({
    payloadRoot: root,
    archivePath: archive,
    appBundles: [nested, outer],
    notaryProfile: "fixture-notary",
    runner: async (command, args) => {
      calls.push([command, args]);
      if (args[1] === "submit") return { stdout: '{"id":"submission-1","status":"Accepted","issues":[]}', stderr: "" };
      if (args[1] === "log") {
        await writeFile(args.at(-1), '{"jobId":"submission-1","status":"Accepted","issues":[]}');
        return { stdout: "", stderr: "" };
      }
      return { stdout: "", stderr: "" };
    },
  });
  assert.deepEqual(result.stapledBundles, [outer]);
  assert.equal(calls.filter(([, args]) => args[1] === "staple").length, 1);
  assert.equal(calls.filter(([, args]) => args[1] === "validate").length, 1);
});

test("Apple verification codesigns every Mach-O and uses notarization verification rather than spctl for standalone executables", async () => {
  const dylib = "/tmp/payload/python/libexample.dylib";
  const executable = "/tmp/payload/launcher/jobctrl";
  const calls = [];
  const result = await verifyApplePayload({
    machO: [dylib, executable],
    appBundles: [],
    standaloneExecutables: [executable],
    runner: async (command, args) => {
      calls.push([command, args]);
      return { stdout: command === "/usr/sbin/spctl" ? "source=Notarized Developer ID" : "", stderr: "" };
    },
  });
  assert.equal(calls.filter(([command]) => command === "/usr/bin/codesign").length, 3);
  assert.deepEqual(calls.filter(([command]) => command === "/usr/sbin/spctl"), []);
  assert.equal(result.notarizationVerifiedStandaloneExecutables, 1);
});

test("pre-sign verification binds release channel and compiled public-key digest", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-verify-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const { privateKey } = generateKeyPairSync("ed25519");
  const publicKeyBase64 = releasePublicKeyBase64(privateKey);
  const trustKeySha256 = sha256(publicKeyBase64);
  const writePreparedFixture = async (name, buildId) => {
    const directory = path.join(root, name);
    await buildFixturePayload({
      outputDirectory: directory,
      buildId,
      sourceDateEpoch: 0,
    });
    const buildResultPath = path.join(directory, "build-result.json");
    const buildResult = JSON.parse(await readFile(buildResultPath, "utf8"));
    await writeFile(buildResultPath, `${JSON.stringify({
      ...buildResult,
      mode: "real",
      nativeLauncherReleaseChannel: "stable",
      nativeLauncherReleaseTrustKeyBase64: publicKeyBase64,
      nativeLauncherReleaseTrustKeySha256: trustKeySha256,
    }, null, 2)}\n`);
    return directory;
  };
  const runner = async (command) => {
    assert.equal(command, "/usr/bin/strings");
    return { stdout: `${publicKeyBase64}\nstable\n`, stderr: "" };
  };
  const prepared = await writePreparedFixture("candidate", "fixture-build-0001");
  const verification = await verifyPreparedCandidate({
    preparedDirectory: prepared,
    channel: "stable",
    publicKeyBase64,
    runner,
  });
  assert.equal(verification.status, "verified-unsigned-pre-sign-candidate");
  assert.equal(verification.nativeLauncherReleaseTrustKeySha256, trustKeySha256);
});

test("finalization cannot reuse a passing pre-sign verification for another build", () => {
  const prepared = {
    buildId: "fixture-build-0001",
    archiveSha256: "a".repeat(64),
    manifestSha256: "b".repeat(64),
    compressedBytes: 1,
    installedBytes: 2,
    nativeLauncherReleaseChannel: "stable",
    nativeLauncherReleaseTrustKeySha256: "c".repeat(64),
  };
  const verification = { schemaVersion: 1, status: "verified-unsigned-pre-sign-candidate", ...prepared };
  assert.doesNotThrow(() => assertPreSignVerificationMatches(prepared, verification));
  assert.throws(() => assertPreSignVerificationMatches(prepared, { ...verification, buildId: "fixture-build-0002" }), /prepared buildId/);
});

test("published paths, installer pins, and smoke contract use canonical HTTPS assets and lifecycle commands", () => {
  const urls = canonicalReleaseUrls("stable", "jobctrl-2.0.0-darwin-arm64.zip", "stable-build-0000042");
  assert.equal(urls.descriptorUrl, "https://releases.jobctrl.dev/v1/stable/darwin-arm64.json");
  assert.equal(urls.immutableDescriptorUrl, "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000042/release-descriptor.json");
  const rendered = renderPinnedInstallScript({
    templateRaw: '#!/usr/bin/env bash\n# BEGIN JOBCTRL RELEASE PINS\nINSTALLER_URL=""\nINSTALLER_SHA256=""\nINSTALLER_VERSION=""\n# END JOBCTRL RELEASE PINS\n# no signed native installer is published yet; P6 release signing is still blocked\n',
    installerUrl: urls.installerUrl,
    installerSha256: "a".repeat(64),
    installerVersion: "2.0.0",
  });
  assert.match(rendered, /INSTALLER_URL="https:\/\/releases\.jobctrl\.dev\/v1\/artifacts\/stable-build-0000042\/jobctrl-installer"/);
  const plan = publishedCandidateSmokePlan({ descriptorUrl: urls.descriptorUrl, installerPath: "/tmp/installer", outputHome: "/tmp/home" });
  assert.deepEqual(plan.map((step) => step.args[0]), ["--fail", "--fail", "--source", "start", "status", "version", "stop", "status"]);
  assert.ok(plan[2].args.includes("--release-url"));
  assert.ok(!plan[2].args.includes("--descriptor-url"));
});

test("install-script rendering advances the actual bounded pin header without changing fixture assignments", async () => {
  const [template, publicInstall] = await Promise.all([
    readFile(path.join(process.cwd(), "scripts", "get"), "utf8"),
    readFile(path.join(process.cwd(), "docs", "public", "install.sh"), "utf8"),
  ]);
  assert.equal(publicInstall, template, "the public installer must match the canonical template");
  const fixtureBranch = 'if [[ -n "$FIXTURE_CONTRACT" ]]; then';
  const fixtureBody = template.slice(template.indexOf(fixtureBranch));
  assert.ok(fixtureBody.startsWith(fixtureBranch));
  const first = renderPinnedInstallScript({
    templateRaw: template,
    installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000042/jobctrl-installer",
    installerSha256: "a".repeat(64),
    installerVersion: "2.0.0",
  });
  const rerendered = renderPinnedInstallScript({
    templateRaw: first,
    installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000043/jobctrl-installer",
    installerSha256: "b".repeat(64),
    installerVersion: "2.0.1",
  });
  assert.match(rerendered, /INSTALLER_URL="https:\/\/releases\.jobctrl\.dev\/v1\/artifacts\/stable-build-0000043\/jobctrl-installer"/);
  assert.match(rerendered, /INSTALLER_SHA256="b{64}"/);
  assert.match(rerendered, /INSTALLER_VERSION="2\.0\.1"/);
  assert.doesNotMatch(rerendered, /stable-build-0000042|a{64}|INSTALLER_VERSION="2\.0\.0"/);
  assert.equal(rerendered.slice(rerendered.indexOf(fixtureBranch)), fixtureBody, "fixture assignments must remain byte-for-byte unchanged");

  assert.throws(
    () => renderPinnedInstallScript({
      templateRaw: template.replace(/^INSTALLER_URL=.*$/m, "INSTALLER_URL=https://releases.jobctrl.dev/jobctrl-installer"),
      installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000043/jobctrl-installer",
      installerSha256: "b".repeat(64),
      installerVersion: "2.0.1",
    }),
    /malformed INSTALLER_URL assignment/,
  );
  assert.throws(
    () => renderPinnedInstallScript({
      templateRaw: template.replace(/^INSTALLER_VERSION=.*$/m, '$&\nexport INSTALLER_VERSION="2.0.1"'),
      installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000043/jobctrl-installer",
      installerSha256: "b".repeat(64),
      installerVersion: "2.0.1",
    }),
    /exactly one INSTALLER_VERSION assignment/,
  );
  assert.throws(
    () => renderPinnedInstallScript({
      templateRaw: template.replace('# BEGIN JOBCTRL RELEASE PINS', '# BEGIN JOBCTRL RELEASE PINS\n# BEGIN JOBCTRL RELEASE PINS'),
      installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000043/jobctrl-installer",
      installerSha256: "b".repeat(64),
      installerVersion: "2.0.1",
    }),
    /exactly one release-pin header start marker/,
  );
  assert.throws(
    () => renderPinnedInstallScript({
      templateRaw: template.replace('# END JOBCTRL RELEASE PINS', '# END JOBCTRL RELEASE PINS\n# END JOBCTRL RELEASE PINS'),
      installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000043/jobctrl-installer",
      installerSha256: "b".repeat(64),
      installerVersion: "2.0.1",
    }),
    /exactly one release-pin header end marker/,
  );
  assert.throws(
    () => renderPinnedInstallScript({
      templateRaw: template.replace('Usage: scripts/get', '# END JOBCTRL RELEASE PINS\nUsage: scripts/get'),
      installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000043/jobctrl-installer",
      installerSha256: "b".repeat(64),
      installerVersion: "2.0.1",
    }),
    /exactly one release-pin header end marker/,
  );
});

test("channel pointers atomically bind one immutable descriptor/signature pair", () => {
  const privateKey = generateKeyPairSync("ed25519").privateKey;
  const archiveFile = "jobctrl-2.0.0-darwin-arm64.zip";
  const urls = canonicalReleaseUrls("stable", archiveFile, "stable-build-0000042");
  const descriptorRaw = `${JSON.stringify({ schemaVersion: 1, channel: "stable", sequence: 42, minimumSafeSequence: 1, revokedBuildIds: [], buildId: "stable-build-0000042", appVersion: "2.0.0", sourceCommit: "a".repeat(40), platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" }, artifact: { url: urls.artifactUrl, sha256: "b".repeat(64), sizeBytes: 1, archiveType: "zip", manifestSha256: "c".repeat(64) } }, null, 2)}\n`;
  const signatureRaw = `${JSON.stringify(signReleaseBytes({ domain: "jobctrl:release-descriptor:v1\0", raw: descriptorRaw, privateKey, keyId: "jobctrl-release-v1", kind: "descriptor" }), null, 2)}\n`;
  const pointer = createReleaseChannelPointer({ descriptorRaw, signatureRaw, descriptorUrl: urls.immutableDescriptorUrl, signatureUrl: urls.immutableDescriptorSignatureUrl });
  assert.equal(validateReleaseChannelPointer(pointer), pointer);
  assert.equal(pointer.descriptor.url, urls.immutableDescriptorUrl);
  assert.equal(pointer.signature.url, urls.immutableDescriptorSignatureUrl);
  assert.equal(pointer.buildId, "stable-build-0000042");
  assert.equal(pointer.sequence, 42);
  assert.throws(() => validateReleaseChannelPointer({ ...pointer, signature: { ...pointer.signature, url: urls.descriptorSignatureUrl } }), /paired|immutable/);
  assert.throws(() => validateReleaseChannelPointer({ ...pointer, buildId: "stable-build-0000043" }), /selected immutable build path/);
  assert.throws(() => validateReleaseChannelPointer({ ...pointer, descriptor: { ...pointer.descriptor, url: pointer.descriptor.url.replace("release-descriptor.json", "%72elease-descriptor.json") } }), /selected immutable build path/);
});

test("published smoke evidence cannot authorize a different mutable descriptor at the same URL", () => {
  const descriptor = {
    schemaVersion: 1,
    channel: "stable",
    sequence: 2,
    minimumSafeSequence: 1,
    revokedBuildIds: [],
    buildId: "stable-build-0000002",
    appVersion: "2.0.0",
    sourceCommit: "a".repeat(40),
    platform: { id: "darwin-arm64", os: "darwin", arch: "arm64" },
    artifact: { url: "https://releases.jobctrl.dev/v1/stable/jobctrl-2.0.0-darwin-arm64.zip", sha256: "a".repeat(64), sizeBytes: 1, archiveType: "zip", manifestSha256: "b".repeat(64) },
  };
  const first = candidateIdentityFromDescriptor(`${JSON.stringify(descriptor)}\n`);
  const second = candidateIdentityFromDescriptor(`${JSON.stringify({ ...descriptor, buildId: "stable-build-0000003", artifact: { ...descriptor.artifact, sha256: "c".repeat(64) } })}\n`);
  assert.throws(() => assertCandidateIdentity(first, second), /candidate identity mismatch/);
});

test("published lifecycle smoke rejects degraded status, wrong version identity, and live post-stop components", () => {
  assert.throws(() => assertRunningStatus({ status: "degraded", components: {} }), /must be running/);
  assert.throws(
    () => assertPublishedVersion({ buildId: "other", manifestSha256: "b".repeat(64) }, { buildId: "expected", manifestSha256: "b".repeat(64) }),
    /buildId/,
  );
  assert.throws(() => assertStoppedStatus({ status: "stopped", components: { api: { state: "running" } } }), /live component/);
});

test("recording post-publication smoke leaves the candidate checksum closure immutable", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-smoke-record-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const candidate = {
    descriptorSha256: "a".repeat(64),
    buildId: "stable-build-0000042",
    appVersion: "2.0.0",
    artifactSha256: "b".repeat(64),
    artifactSizeBytes: 1,
    manifestSha256: "c".repeat(64),
  };
  await writeFile(path.join(root, "release-metadata.json"), JSON.stringify({
    pypiPublicationAuthorized: false,
    publicationUrls: { immutableDescriptorUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000042/release-descriptor.json", immutableChannelPointerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000042/channel-pointer.json", installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000042/jobctrl-installer" },
    installer: { sha256: "d".repeat(64) },
    descriptor: { sha256: candidate.descriptorSha256 },
    buildId: candidate.buildId,
    appVersion: candidate.appVersion,
    archive: { sha256: candidate.artifactSha256, sizeBytes: candidate.artifactSizeBytes },
    manifest: { sha256: candidate.manifestSha256 },
  }));
  await writeFile(path.join(root, "SHA256SUMS"), "pre-publication-checksum\n");
  const before = await readFile(path.join(root, "SHA256SUMS"), "utf8");
  await recordPublishedCandidateSmoke({
    releaseDirectory: root,
    smoke: {
      status: "passed",
      publicationStatus: "published-candidate-verified",
      pypiPublicationAuthorized: true,
      descriptorUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000042/release-descriptor.json",
      channelPointerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000042/channel-pointer.json",
      installerUrl: "https://releases.jobctrl.dev/v1/artifacts/stable-build-0000042/jobctrl-installer",
      installerSha256: "d".repeat(64),
      candidate,
    },
  });
  assert.equal(await readFile(path.join(root, "SHA256SUMS"), "utf8"), before);
});

test("PyPI promotion binds signed source provenance to protected external release trust", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-pypi-gate-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  const trusted = generateKeyPairSync("ed25519");
  const attacker = generateKeyPairSync("ed25519");
  const sourceCommit = "a".repeat(40);
  const trustedRoot = path.join(root, "trusted");
  const attackerRoot = path.join(root, "attacker");
  await mkdir(trustedRoot);
  await mkdir(attackerRoot);
  const trustedFixture = await writePyPIGateFixture(trustedRoot, { privateKey: trusted.privateKey, sourceCommit });
  await assert.doesNotReject(verifyPyPIReleaseGate({
    releaseDirectory: trustedRoot,
    expectedTag: "v0.1.0",
    sourceCommit,
    expectedPublicKeyBase64: trustedFixture.publicKeyBase64,
    expectedKeyId: trustedFixture.keyId,
  }));

  // An attacker can replace every mutable Release asset and create a coherent
  // signature registry for their own key. The protected PyPI environment's
  // independently configured public key must still reject that candidate.
  await writePyPIGateFixture(attackerRoot, { privateKey: attacker.privateKey, sourceCommit });
  await assert.rejects(verifyPyPIReleaseGate({
    releaseDirectory: attackerRoot,
    expectedTag: "v0.1.0",
    sourceCommit,
    expectedPublicKeyBase64: trustedFixture.publicKeyBase64,
    expectedKeyId: trustedFixture.keyId,
  }), /protected expected release trust/);
});

test("release workflows use protected manual signing, artifact handoff, candidate trust, and a PyPI gate", async () => {
  const [releaseWorkflow, homebrewWorkflow] = await Promise.all([
    readFile(path.join(process.cwd(), ".github", "workflows", "release-distribution.yml"), "utf8"),
    readFile(path.join(process.cwd(), ".github", "workflows", "sync-homebrew-tap.yml"), "utf8"),
  ]);
  await assert.rejects(
    readFile(path.join(process.cwd(), ".github", "workflows", "release-pypi.yml"), "utf8"),
    /ENOENT/,
  );
  assert.match(releaseWorkflow, /workflow_dispatch:/);
  assert.match(releaseWorkflow, /^  push:\n    tags:\n      - v2\.0\.7$/m);
  assert.match(releaseWorkflow, /\$\{\{ inputs\.release_tag \|\| github\.ref_name \}\}/);
  assert.match(releaseWorkflow, /\$\{\{ inputs\.channel \|\| 'stable' \}\}/);
  assert.match(releaseWorkflow, /\$\{\{ inputs\.sequence \|\| '1' \}\}/);
  assert.match(releaseWorkflow, /\$\{\{ inputs\.minimum_safe_sequence \|\| '1' \}\}/);
  assert.match(releaseWorkflow, /\$\{\{ inputs\.revoked_build_ids \|\| '\[\]' \}\}/);
  assert.match(releaseWorkflow, /\$\{\{ inputs\.expected_channel_pointer_sha256 \|\| 'absent' \}\}/);
  assert.match(releaseWorkflow, /pypi_recovery_only:/);
  for (const marker of [
    "runs-on: macos-15",
    "environment: release-signing",
    "environment: release-publication",
    "GH_REPO: ${{ github.repository }}",
    "Preflight checkout-free GitHub publication access",
    "gh repo view \"$GH_REPO\" --json nameWithOwner",
    "distribution-release.mjs prepare",
    "distribution-release.finalizer.bundle.mjs verify-prepared",
    "distribution-release.finalizer.bundle.mjs finalize",
    "distribution-release.mjs smoke",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "gh release create \"$RELEASE_TAG\"",
    "gh release edit \"$RELEASE_TAG\" --draft=false",
    "channel-pointer.json",
    "aws s3api put-object",
    "--if-match \"$etag\"",
    "--if-none-match '*'",
    "JOBCTRL_R2_ACCESS_KEY_ID",
    "JOBCTRL_R2_SECRET_ACCESS_KEY",
    "JOBCTRL_R2_ACCOUNT_ID",
    "JOBCTRL_R2_BUCKET",
    "channel-promotion-evidence.json",
    "immutableDescriptorUrl",
    "tap_name=\"jobctrl/release-smoke-${GITHUB_RUN_ID}\"",
    "brew tap-new --no-git \"$tap_name\"",
    "install -m 0644 \"$release/jobctrl.rb\" \"$tap_repo/Formula/jobctrl.rb\"",
    "formula=\"$tap_name/jobctrl\"",
    "brew audit --strict --formula \"$formula\"",
    "brew install --formula \"$formula\"",
    "brew test \"$formula\"",
    "for attempt in {1..24}",
    "sleep 5",
    "jobctrl-release-readback=${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-pre",
    "jobctrl-release-readback=${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-post-${attempt}",
    "jobctrl-release-readback=${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-channel-pre",
    "jobctrl-release-readback=${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}-channel-post-${attempt}",
  ]) assert.ok(releaseWorkflow.includes(marker), `missing release workflow marker ${marker}`);
  assert.doesNotMatch(releaseWorkflow, /brew audit --strict --formula \"\$release\/jobctrl\.rb\"/);
  assert.doesNotMatch(releaseWorkflow, /brew install --formula \"\$release\/jobctrl\.rb\"/);
  for (const removedJob of ["prepare-a", "prepare-b", "pypi-build-a", "pypi-build-b", "pypi-compare"]) {
    assert.doesNotMatch(releaseWorkflow, new RegExp(`^  ${removedJob}:`, "m"));
  }
  assert.match(releaseWorkflow, /^  prepare:/m);
  assert.match(releaseWorkflow, /^  pypi-build:/m);
  const publicationPreflight = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  publication-preflight:"),
    releaseWorkflow.indexOf("  prepare:"),
  );
  assert.match(publicationPreflight, /needs: resolve/);
  assert.match(publicationPreflight, /gh release view "\$RELEASE_TAG"/);
  assert.doesNotMatch(publicationPreflight, /actions\/checkout@/);
  assert.match(releaseWorkflow, /needs: \[resolve, publication-preflight, prepare\]/);
  assert.doesNotMatch(releaseWorkflow, /JOBCTRL_RELEASE_UPLOAD_BASE_URL/);
  assert.doesNotMatch(homebrewWorkflow, /workflow_dispatch:/);
  assert.match(homebrewWorkflow, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  assert.match(homebrewWorkflow, /--trust "\$TRUST_PATH"/);
  assert.doesNotMatch(homebrewWorkflow, /environment: release-publication|HOMEBREW_TAP_DEPLOY_KEY|^  publish:/m);
  const syncHomebrew = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  sync-homebrew:"),
    releaseWorkflow.indexOf("  publish-homebrew:"),
  );
  const publishHomebrew = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  publish-homebrew:"),
    releaseWorkflow.indexOf("  promote-channel-pointer:"),
  );
  const githubRelease = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  publish-github-release:"),
    releaseWorkflow.indexOf("  pypi-resolve:"),
  );
  assert.match(syncHomebrew, /uses: \.\/\.github\/workflows\/sync-homebrew-tap\.yml/);
  assert.doesNotMatch(syncHomebrew, /HOMEBREW_TAP_DEPLOY_KEY|environment: release-publication/);
  assert.match(publishHomebrew, /needs: \[resolve, sign, sync-homebrew, promote-channel-pointer\]/);
  assert.match(publishHomebrew, /environment: release-publication/);
  assert.match(publishHomebrew, /test -n "\$HOMEBREW_TAP_DEPLOY_KEY"/);
  assert.match(publishHomebrew, /ssh-key: \$\{\{ secrets\.HOMEBREW_TAP_DEPLOY_KEY \}\}/);
  assert.match(publishHomebrew, /git -C homebrew-tap remote get-url origin\)" = "git@github\.com:ebarti\/homebrew-tap\.git"/);
  assert.ok(
    publishHomebrew.indexOf("Require the SSH Homebrew tap origin") < publishHomebrew.indexOf("Commit synchronized formula"),
    "the tap checkout must prove its SSH origin before commit or push",
  );
  assert.match(githubRelease, /needs: \[resolve, sign, package-signed-candidate, smoke-and-verify, publish-homebrew, promote-channel-pointer\]/);
  assert.match(githubRelease, /needs\['publish-homebrew'\]\.result == 'success'/);
  assert.doesNotMatch(`${releaseWorkflow}\n${homebrewWorkflow}`, /uses:\s+[^\s@]+@(?![0-9a-f]{40}(?:\s|$|#))/);
  const releaseGate = releaseWorkflow.indexOf("distribution-release.finalizer.bundle.mjs verify-pypi-gate");
  const buildDependencies = releaseWorkflow.indexOf("--only-group release-build");
  const publish = releaseWorkflow.indexOf("uses: pypa/gh-action-pypi-publish@cef221092ed1bacb1cc03d23a2d87d1d172e277b");
  assert.ok(
    releaseGate >= 0 && releaseGate < buildDependencies && buildDependencies < publish,
    "PyPI must verify signed evidence before build dependencies and upload",
  );
  assert.doesNotMatch(releaseWorkflow, /pypa\/gh-action-pypi-publish@6733eb7d741f0b11ec6a39b58540dab7590f9b7d/);
  assert.match(releaseWorkflow, /JOBCTRL_RELEASE_PUBLIC_KEY: \$\{\{ needs\.resolve\.outputs\.release_public_key \}\}/);
  assert.match(releaseWorkflow, /JOBCTRL_RELEASE_KEY_ID: \$\{\{ needs\.resolve\.outputs\.release_key_id \}\}/);
  assert.match(releaseWorkflow, /filter="data"/);
  const pypiResolve = releaseWorkflow.slice(
    releaseWorkflow.indexOf("  pypi-resolve:"),
    releaseWorkflow.indexOf("  pypi-build:"),
  );
  const pypiBuild = releaseJob("pypi-build");
  const pypiPublish = releaseJob("publish-pypi");
  assert.match(pypiResolve, /needs: \[resolve, publish-github-release, pypi-recovery-preflight\]/);
  assert.match(pypiResolve, /needs\['publish-github-release'\]\.result == 'success'/);
  assert.match(pypiResolve, /needs\['pypi-recovery-preflight'\]\.result == 'success'/);
  assert.match(pypiResolve, /if: \$\{\{ !cancelled\(\) && needs\.resolve\.result == 'success'/);
  assert.match(pypiBuild, /if: \$\{\{ !cancelled\(\) && needs\.pypi-resolve\.result == 'success' \}\}/);
  assert.match(pypiPublish, /if: \$\{\{ !cancelled\(\) && needs\.pypi-resolve\.result == 'success' && needs\.pypi-build\.result == 'success' \}\}/);
  assert.doesNotMatch(`${pypiResolve}\n${pypiBuild}\n${pypiPublish}`, /\balways\(\)/);
  assert.doesNotMatch(pypiResolve, /(?:corepack|pnpm|npm|npx|uv|pip)\s/);

  function releaseJob(name) {
    const start = releaseWorkflow.indexOf(`  ${name}:\n`);
    assert.ok(start >= 0, `missing ${name} job`);
    const remainder = releaseWorkflow.slice(start + 1);
    const next = remainder.search(/\n  [A-Za-z0-9-]+:\n/);
    return next < 0 ? remainder : remainder.slice(0, next);
  }
  const recoveryExclusion = "github.event_name != 'workflow_dispatch' || inputs.pypi_recovery_only != true";
  for (const jobName of [
    "publication-preflight",
    "prepare",
    "sign",
    "package-signed-candidate",
    "publish-immutable",
    "smoke-and-verify",
    "sync-homebrew",
    "publish-homebrew",
    "promote-channel-pointer",
    "publish-github-release",
  ]) assert.ok(releaseJob(jobName).includes(recoveryExclusion), `${jobName} must skip PyPI recovery`);
  const recovery = releaseJob("pypi-recovery-preflight");
  assert.match(recovery, /github\.event_name == 'workflow_dispatch' && inputs\.pypi_recovery_only == true/);
  for (const marker of [
    'test "$RELEASE_TAG" = v2.0.7',
    "compare/$RELEASE_REF...main",
    "isDraft",
    "isPrerelease",
    "isImmutable",
    'gh release verify "$RELEASE_TAG"',
  ]) assert.ok(recovery.includes(marker), `recovery must prove ${marker}`);
  assert.doesNotMatch(recovery, /\baws\b|git push|gh release (?:create|edit|upload)/);
});

test("release lineage allows main to advance without loosening exact tag identity", async () => {
  const [releaseWorkflow, homebrewWorkflow] = await Promise.all([
    readFile(path.join(process.cwd(), ".github", "workflows", "release-distribution.yml"), "utf8"),
    readFile(path.join(process.cwd(), ".github", "workflows", "sync-homebrew-tap.yml"), "utf8"),
  ]);
  const workflows = `${releaseWorkflow}\n${homebrewWorkflow}`;
  assert.doesNotMatch(workflows, /repos\/\$GITHUB_REPOSITORY\/commits\/main/);
  for (const marker of [
    "compare/$head_sha...main",
    "compare/$RELEASE_REF...main",
    "compare/$EXPECTED_SOURCE_COMMIT...main",
    "compare/$tag_sha...main",
    "commits/$RELEASE_TAG",
  ]) assert.ok(workflows.includes(marker), `missing release-lineage marker ${marker}`);
  const lineageAssertions = workflows.match(/\[\[ "\$main_relation" = ahead \|\| "\$main_relation" = identical \]\]/g) ?? [];
  assert.ok(lineageAssertions.length >= 16, "every release side-effect boundary must preserve main ancestry");
});
