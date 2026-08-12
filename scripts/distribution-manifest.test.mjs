import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  auditDistributionContracts,
  buildFileInventory,
  loadDistributionContracts,
  loadManifestValidationContracts,
  measureDistribution,
  summarizeComponentFiles,
  validateDistributionManifest,
  validateComponentInventory,
  validateComponentLocks,
  validateLicenseReview,
  validateNodeLicenseEvidenceLocks,
  validatePythonLicenseEvidenceLocks,
  validateSigningPolicy,
} from "./distribution-manifest.mjs";

const EMPTY_SHA = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function sorted(values) {
  return [...values].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

async function validManifest(contracts) {
  contracts ??= await loadManifestValidationContracts();
  const platform = contracts.platformsById.values().next().value;
  const componentIds = sorted(platform.requiredComponents);
  const files = componentIds.map((id) => ({
    type: "file",
    path: `libexec/jobctrl/components/${id}/payload`,
    sha256: EMPTY_SHA,
    sizeBytes: 0,
    mode: "0644",
  }));
  const components = componentIds.map((id) => {
    const inventory = contracts.inventoryById.get(id);
    const componentPath = `libexec/jobctrl/components/${id}`;
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
      required: true,
    };
  });
  const capabilities = sorted(contracts.capabilitiesById.keys()).map((id) => {
    const capability = contracts.capabilitiesById.get(id);
    return {
      id,
      defaultEnabled: capability.defaultEnabled,
      componentIds: [...capability.componentIds],
    };
  });
  return {
    schemaVersion: 1,
    appVersion: contracts.versions["jobctrl-launcher"],
    buildId: "test-build-0001",
    releaseChannel: "local",
    sourceDateEpoch: 0,
    platform: {
      id: platform.id,
      os: platform.os,
      arch: platform.arch,
      minimumOsVersion: platform.minimumOsVersion,
    },
    launcherCompatibility: { ...platform.launcherCompatibility },
    components,
    capabilities,
    files,
    signing: {
      manifestAlgorithm: "ed25519",
      manifestKeyId: "local-development",
      codeSigning: "unsigned-local",
      notarized: false,
    },
  };
}

test("distribution contracts are complete and every version source resolves", async () => {
  const report = await auditDistributionContracts();
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.componentCount >= 20);
  assert.equal(report.lockedInputCount, 6);
  assert.equal(report.pythonLicenseEvidenceCount, 2);
  assert.equal(report.nodeLicenseEvidenceCount, 13);
  assert.equal(report.capabilityCount, 3);
  assert.deepEqual(report.platforms, ["darwin-arm64"]);
  assert.equal(report.versions["jobctrl-launcher"], "0.1.0");
  assert.equal(report.versions["playwright-python"], "1.58.0");
  assert.equal(report.versions["font-geist"], "5.2.9");
  assert.equal(report.versions["font-jetbrains-mono"], "5.2.8");
  assert.equal(report.versions["pdfjs-renderer"], "5.7.284");
  assert.equal(report.versions["claude-agent-sdk"], "0.2.115");
});

test("manifest validation accepts the complete local core closure", async () => {
  const contracts = await loadManifestValidationContracts();
  const manifest = await validManifest(contracts);
  assert.equal(contracts.schemaValidator(manifest), true);
  assert.equal(validateDistributionManifest(manifest, contracts), manifest);
});

test("schema and semantic validation reject unknown fields", async () => {
  const contracts = await loadManifestValidationContracts();
  const manifest = await validManifest(contracts);
  manifest.components[0].credentialDump = "not-a-real-secret";
  assert.equal(contracts.schemaValidator(manifest), false);
  assert.throws(() => validateDistributionManifest(manifest, contracts), /schema validation failed/);
});

test("manifest validation binds component identity and resolved versions to inventory", async () => {
  const contracts = await loadManifestValidationContracts();
  const wrongOwner = await validManifest(contracts);
  wrongOwner.components[0].owner = "Someone else";
  assert.throws(() => validateDistributionManifest(wrongOwner, contracts), /owner does not match/);

  const wrongVersion = await validManifest(contracts);
  wrongVersion.components[0].version = "999.0.0";
  assert.throws(() => validateDistributionManifest(wrongVersion, contracts), /version does not match/);

  const unclassified = await validManifest(contracts);
  unclassified.components[0].id = "mystery-runtime";
  assert.throws(() => validateDistributionManifest(unclassified, contracts), /not classified/);

  const embedded = await validManifest(contracts);
  const embeddedInventory = contracts.inventoryById.get("system-browser-adapter");
  Object.assign(embedded.components[0], {
    id: embeddedInventory.id,
    classification: embeddedInventory.classification,
    version: contracts.versions[embeddedInventory.id],
    owner: embeddedInventory.owner,
    source: embeddedInventory.source,
    license: embeddedInventory.license,
    required: false,
  });
  assert.throws(() => validateDistributionManifest(embedded, contracts), /embedded component cannot own/);
});

test("manifest app and launcher compatibility versions are contract-bound", async () => {
  const contracts = await loadManifestValidationContracts();
  const wrongApp = await validManifest(contracts);
  wrongApp.appVersion = "3.0.0";
  assert.throws(() => validateDistributionManifest(wrongApp, contracts), /appVersion does not match/);

  const wrongLauncher = await validManifest(contracts);
  wrongLauncher.launcherCompatibility.maximum += 1;
  assert.throws(() => validateDistributionManifest(wrongLauncher, contracts), /maximum does not match/);
});

test("manifest validation rejects traversal, overlapping roots, and unowned files", async () => {
  const contracts = await loadManifestValidationContracts();
  const traversal = await validManifest(contracts);
  traversal.files[0].path = "../escape";
  assert.throws(() => validateDistributionManifest(traversal, contracts), /escapes the payload root|must be normalized/);

  const overlap = await validManifest(contracts);
  overlap.components[1].path = `${overlap.components[0].path}/nested`;
  assert.throws(() => validateDistributionManifest(overlap, contracts), /component roots overlap/);

  const orphan = await validManifest(contracts);
  orphan.files.push({ type: "file", path: "zz-unowned/private.txt", sha256: EMPTY_SHA, sizeBytes: 0, mode: "0644" });
  assert.throws(() => validateDistributionManifest(orphan, contracts), /exactly one component owner; found 0/);
});

test("manifest paths are printable ASCII for cross-language byte ordering", async () => {
  const contracts = await loadManifestValidationContracts();
  const manifest = await validManifest(contracts);
  manifest.files[0].path = `${manifest.components[0].path}/\u{10000}`;
  assert.throws(() => validateDistributionManifest(manifest, contracts), /schema validation failed|printable ASCII/);
});

test("manifest symlinks stay resolvable inside one component", async () => {
  const contracts = await loadManifestValidationContracts();
  const manifest = await validManifest(contracts);
  const component = manifest.components[0];
  const link = {
    type: "symlink",
    path: `${component.path}/current`,
    target: "payload",
    sizeBytes: Buffer.byteLength("payload"),
  };
  manifest.files.push(link);
  manifest.files = sorted(manifest.files.map((file) => file.path)).map((filePath) =>
    manifest.files.find((file) => file.path === filePath));
  Object.assign(component, summarizeComponentFiles(component.path, manifest.files));
  delete component.fileCount;
  assert.equal(validateDistributionManifest(manifest, contracts), manifest);

  link.target = "../../../../../../outside";
  link.sizeBytes = Buffer.byteLength(link.target);
  assert.throws(() => validateDistributionManifest(manifest, contracts), /resolved symlink target.*escapes|resolved symlink target.*relative/);

  const dangling = await validManifest(contracts);
  const danglingComponent = dangling.components[0];
  dangling.files.push({
    type: "symlink",
    path: `${danglingComponent.path}/dangling`,
    target: "missing",
    sizeBytes: Buffer.byteLength("missing"),
  });
  dangling.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  Object.assign(danglingComponent, summarizeComponentFiles(danglingComponent.path, dangling.files));
  delete danglingComponent.fileCount;
  assert.throws(() => validateDistributionManifest(dangling, contracts), /target is not represented/);

  const cycle = await validManifest(contracts);
  const cycleComponent = cycle.components[0];
  cycle.files.push(
    { type: "symlink", path: `${cycleComponent.path}/a`, target: "b", sizeBytes: 1 },
    { type: "symlink", path: `${cycleComponent.path}/b`, target: "a", sizeBytes: 1 },
  );
  cycle.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  Object.assign(cycleComponent, summarizeComponentFiles(cycleComponent.path, cycle.files));
  delete cycleComponent.fileCount;
  assert.throws(() => validateDistributionManifest(cycle, contracts), /symlink cycle detected/);

  const crossComponent = await validManifest(contracts);
  const sourceComponent = crossComponent.components[0];
  const targetComponent = crossComponent.components[1];
  const crossTarget = path.posix.relative(sourceComponent.path, `${targetComponent.path}/payload`);
  crossComponent.files.push({
    type: "symlink",
    path: `${sourceComponent.path}/cross-component`,
    target: crossTarget,
    sizeBytes: Buffer.byteLength(crossTarget),
  });
  crossComponent.files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  Object.assign(sourceComponent, summarizeComponentFiles(sourceComponent.path, crossComponent.files));
  delete sourceComponent.fileCount;
  assert.throws(() => validateDistributionManifest(crossComponent, contracts), /crosses component ownership/);
});

test("manifest validation reconciles component digests and sizes", async () => {
  const contracts = await loadManifestValidationContracts();
  const wrongDigest = await validManifest(contracts);
  wrongDigest.components[0].sha256 = "0".repeat(64);
  assert.throws(() => validateDistributionManifest(wrongDigest, contracts), /component SHA-256 does not match/);

  const wrongSize = await validManifest(contracts);
  wrongSize.components[0].sizeBytes = 1;
  assert.throws(() => validateDistributionManifest(wrongSize, contracts), /component size does not match/);
});

test("manifest validation rejects dangerous file modes", async () => {
  const contracts = await loadManifestValidationContracts();
  for (const mode of ["04755", "02755", "01777", "0777", "0000"]) {
    const manifest = await validManifest(contracts);
    manifest.files[0].mode = mode;
    assert.throws(() => validateDistributionManifest(manifest, contracts), /schema validation failed|unsafe mode/);
  }
});

test("manifest capabilities must exactly match the safe policy", async () => {
  const contracts = await loadManifestValidationContracts();
  const empty = await validManifest(contracts);
  empty.capabilities = [];
  assert.throws(() => validateDistributionManifest(empty, contracts), /schema validation failed|must not be empty/);

  const unsafeDefault = await validManifest(contracts);
  const apply = unsafeDefault.capabilities.find((capability) => capability.id === "auto-apply-browser");
  apply.defaultEnabled = true;
  assert.throws(() => validateDistributionManifest(unsafeDefault, contracts), /defaultEnabled does not match/);

  const missingComponent = await validManifest(contracts);
  missingComponent.capabilities.find((capability) => capability.id === "auto-apply-browser").componentIds = ["jobctrl-worker"];
  assert.throws(() => validateDistributionManifest(missingComponent, contracts), /componentIds do not match/);
});

test("release channels are bound to the configured signing key and trust policy", async () => {
  const contracts = await loadManifestValidationContracts();
  const manifest = await validManifest(contracts);
  manifest.releaseChannel = "stable";
  assert.throws(() => validateDistributionManifest(manifest, contracts, { stable: true }), /manifest key id does not match/);

  manifest.signing.manifestKeyId = contracts.signingPolicy.manifestSigning.keyId;
  manifest.signing.codeSigning = "developer-id";
  manifest.signing.notarized = true;
  assert.throws(() => validateDistributionManifest(manifest, contracts, { stable: true }), /promotion is blocked/);

  const signingPolicy = structuredClone(contracts.signingPolicy);
  signingPolicy.stableReleaseStatus = "ready";
  signingPolicy.manifestSigning.publicKeyStatus = "provisioned";
  signingPolicy.appleSigning.teamIdStatus = "provisioned";
  validateSigningPolicy(signingPolicy);
  const readyContracts = { ...contracts, signingPolicy };
  assert.equal(validateDistributionManifest(manifest, readyContracts, { stable: true }), manifest);
});

test("external input locks require the exact pinned builder closure", async () => {
  const { inventory, componentLocks } = await loadDistributionContracts();
  const inventoryById = validateComponentInventory(inventory);
  const missingTemporal = structuredClone(componentLocks);
  missingTemporal.inputs = missingTemporal.inputs.filter((input) => input.id !== "temporal-runtime-archive");
  assert.throws(() => validateComponentLocks(missingTemporal, inventoryById), /exact required external input set/);

  const wrongChromium = structuredClone(componentLocks);
  wrongChromium.inputs.find((input) => input.id === "chromium-core-headless-archive").componentId = "temporal-runtime";
  assert.throws(() => validateComponentLocks(wrongChromium, inventoryById), /componentId does not match/);
});

test("human license review is machine-bound to inventory policy", async () => {
  const { inventory } = await loadDistributionContracts();
  const inventoryById = validateComponentInventory(inventory);
  const review = await readFile(path.join(process.cwd(), "packaging", "distribution", "LICENSE-REVIEW.md"), "utf8");
  assert.equal(validateLicenseReview(review, inventoryById).length, inventory.components.length);
  assert.throws(
    () => validateLicenseReview(review.replace("| `jobctrl-launcher` | `core-runtime` |", "| `jobctrl-launcher` | `optional-capability` |"), inventoryById),
    /classification does not match/,
  );
  assert.throws(
    () => validateLicenseReview(review.replace("| `jobctrl-launcher` | `core-runtime` | `AGPL-3.0-only` |", "| `jobctrl-launcher` | `core-runtime` | `MIT` |"), inventoryById),
    /license does not match/,
  );
  assert.throws(
    () => validateLicenseReview(review.replace("| `jobctrl-launcher` | `core-runtime` | `AGPL-3.0-only` | `bundle` |", "| `jobctrl-launcher` | `core-runtime` | `AGPL-3.0-only` | `exclude` |"), inventoryById),
    /decision does not match/,
  );
});

test("license evidence locks are closed, immutable, exact, and bound to dependency locks", async () => {
  const { pythonLicenseEvidenceLocks, nodeLicenseEvidenceLocks } = await loadDistributionContracts();
  const uvLock = await readFile(path.join(process.cwd(), "workers", "automation", "uv.lock"), "utf8");
  const pnpmLocks = (await Promise.all([
    "pnpm-lock.yaml",
    "packaging/distribution/playwright-mcp/pnpm-lock.yaml",
    "packaging/distribution/api-native/pnpm-lock.yaml",
  ].map((file) => readFile(path.join(process.cwd(), file), "utf8")))).join("\n");

  assert.equal(validatePythonLicenseEvidenceLocks(pythonLicenseEvidenceLocks, uvLock).inputs.length, 2);
  assert.equal(validateNodeLicenseEvidenceLocks(nodeLicenseEvidenceLocks, pnpmLocks).inputs.length, 13);

  const missingPythonSubject = structuredClone(pythonLicenseEvidenceLocks);
  missingPythonSubject.inputs.pop();
  assert.throws(
    () => validatePythonLicenseEvidenceLocks(missingPythonSubject, uvLock),
    /exact required subject set/,
  );

  const mutablePythonReference = structuredClone(pythonLicenseEvidenceLocks);
  mutablePythonReference.inputs[0].url = "https://raw.githubusercontent.com/open-telemetry/opentelemetry-python-contrib/v0.62b1/LICENSE";
  assert.throws(
    () => validatePythonLicenseEvidenceLocks(mutablePythonReference, uvLock),
    /pinned to a full commit SHA/,
  );

  const invalidNodeHash = structuredClone(nodeLicenseEvidenceLocks);
  invalidNodeHash.inputs[0].sha256 = "not-a-sha256";
  assert.throws(
    () => validateNodeLicenseEvidenceLocks(invalidNodeHash, pnpmLocks),
    /sha256 must be lowercase SHA-256/,
  );

  const wrongNodeEvidenceKind = structuredClone(nodeLicenseEvidenceLocks);
  wrongNodeEvidenceKind.inputs.find((input) => input.package === "abstract-logging").evidenceKind = "license-text";
  assert.throws(
    () => validateNodeLicenseEvidenceLocks(wrongNodeEvidenceKind, pnpmLocks),
    /evidenceKind does not match/,
  );

  const unknownNodeField = structuredClone(nodeLicenseEvidenceLocks);
  unknownNodeField.inputs[0].fallback = true;
  assert.throws(
    () => validateNodeLicenseEvidenceLocks(unknownNodeField, pnpmLocks),
    /fields must be exactly/,
  );

  assert.throws(
    () => validatePythonLicenseEvidenceLocks(pythonLicenseEvidenceLocks, ""),
    /not exactly pinned in uv.lock/,
  );
  assert.throws(
    () => validateNodeLicenseEvidenceLocks(nodeLicenseEvidenceLocks, ""),
    /not exactly pinned in the pnpm lock closure/,
  );
});

test("artifact file inventory is bytewise deterministic after mode normalization", async (context) => {
  const first = await mkdtemp(path.join(os.tmpdir(), "jobctrl-dist-a-"));
  const second = await mkdtemp(path.join(os.tmpdir(), "jobctrl-dist-b-"));
  context.after(async () => Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]));
  for (const root of [first, second]) {
    await mkdir(path.join(root, "bin"), { recursive: true });
    await writeFile(path.join(root, "bin", "z-data"), "data\n");
    await writeFile(path.join(root, "bin", "JobCtrl"), "launcher\n");
    await chmod(path.join(root, "bin", "z-data"), 0o644);
    await chmod(path.join(root, "bin", "JobCtrl"), 0o755);
  }
  const firstInventory = await buildFileInventory(first);
  const secondInventory = await buildFileInventory(second);
  assert.deepEqual(firstInventory, secondInventory);
  assert.deepEqual(firstInventory.map((file) => file.path), ["bin/JobCtrl", "bin/z-data"]);
});

test("artifact file inventory preserves safe relative symlinks and rejects escapes", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "jobctrl-dist-unsafe-"));
  context.after(async () => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, "Versions", "145", "Resources"), { recursive: true });
  await writeFile(path.join(root, "Versions", "145", "Resources", "asset"), "data\n");
  await chmod(path.join(root, "Versions", "145", "Resources", "asset"), 0o644);
  await symlink("145", path.join(root, "Versions", "Current"));
  await symlink("Versions/Current/Resources", path.join(root, "Resources"));
  const inventory = await buildFileInventory(root);
  assert.deepEqual(
    inventory.filter((file) => file.type === "symlink").map((file) => [file.path, file.target]),
    [["Resources", "Versions/Current/Resources"], ["Versions/Current", "145"]],
  );

  await symlink("../outside", path.join(root, "escape"));
  await assert.rejects(buildFileInventory(root), /resolved symlink target.*escapes|resolved symlink target.*relative/);
  await rm(path.join(root, "escape"));
  await chmod(path.join(root, "Versions", "145", "Resources", "asset"), 0o777);
  await assert.rejects(buildFileInventory(root), /unsafe mode 0777/);
});

test("source measurement reports dependency, lockfile, and environment presence", async () => {
  const report = await measureDistribution();
  assert.equal(report.schemaVersion, 1);
  assert.ok(report.source.javascript.uniqueDirect > 0);
  assert.ok(report.source.javascript.uniqueRuntimeDirect > 0);
  assert.equal(report.source.python.coreRuntimeDirect, 19);
  assert.equal(report.source.python.providerRuntimeDirect, 4);
  assert.ok(report.source.locks.pnpmPackageRecords > 0);
  assert.ok(report.source.locks.uvPackageRecords > 0);
  assert.ok(["present", "absent"].includes(report.source.environmentPresence.nodeModules));
  assert.ok(["present", "absent"].includes(report.source.environmentPresence.pythonEnvironment));
});
