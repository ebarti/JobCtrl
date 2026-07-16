const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const DIRECTORY_PREFIX = "jobctrl-docs-screenshots-";
const OWNERSHIP_MARKER = ".jobctrl-docs-screenshots-owned.json";
const MARKER_PURPOSE = "jobctrl-docs-screenshots";

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

async function canonicalExistingDirectory(candidate, label) {
  let canonical;
  try {
    canonical = await fs.realpath(candidate);
  } catch (error) {
    throw new Error(`${label} must be an existing directory: ${candidate}`, {
      cause: error,
    });
  }
  const metadata = await fs.stat(canonical);
  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a directory: ${canonical}`);
  }
  return canonical;
}

async function canonicalTemporaryRoot() {
  return await canonicalExistingDirectory(os.tmpdir(), "System temporary root");
}

async function canonicalTemporaryRoots() {
  const roots = [await canonicalTemporaryRoot()];
  for (const candidate of ["/tmp", "/private/tmp"]) {
    try {
      const canonical = await canonicalExistingDirectory(
        candidate,
        "Temporary root",
      );
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch {
      // These conventional POSIX roots do not exist on every supported host.
    }
  }
  return roots;
}

async function writeOwnershipMarker(appDir) {
  const markerPath = path.join(appDir, OWNERSHIP_MARKER);
  await fs.writeFile(
    markerPath,
    `${JSON.stringify(
      {
        schemaVersion: 1,
        purpose: MARKER_PURPOSE,
        appDir,
      },
      null,
      2,
    )}\n`,
    { encoding: "utf8", flag: "wx", mode: 0o600 },
  );
}

async function assertOwnedDocsScreenshotDirectory(appDir) {
  const temporaryRoots = await canonicalTemporaryRoots();
  const canonical = await canonicalExistingDirectory(
    appDir,
    "Documentation screenshot workspace",
  );
  if (!temporaryRoots.some((root) => isStrictDescendant(root, canonical))) {
    throw new Error(
      `Documentation screenshot workspace must be a strict descendant of a canonical temporary root (${temporaryRoots.join(", ")}); received ${canonical}`,
    );
  }
  if (!path.basename(canonical).startsWith(DIRECTORY_PREFIX)) {
    throw new Error(
      `Documentation screenshot workspace must use the ${DIRECTORY_PREFIX} prefix; received ${canonical}`,
    );
  }

  const markerPath = path.join(canonical, OWNERSHIP_MARKER);
  let markerMetadata;
  let marker;
  try {
    markerMetadata = await fs.lstat(markerPath);
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch (error) {
    throw new Error(
      `Documentation screenshot workspace lacks a valid ownership marker: ${canonical}`,
      { cause: error },
    );
  }
  if (
    !markerMetadata.isFile() ||
    markerMetadata.isSymbolicLink() ||
    marker?.schemaVersion !== 1 ||
    marker?.purpose !== MARKER_PURPOSE ||
    marker?.appDir !== canonical
  ) {
    throw new Error(
      `Documentation screenshot workspace has an invalid ownership marker: ${canonical}`,
    );
  }
  return canonical;
}

async function createOwnedDocsScreenshotDirectory(parentOverride) {
  const temporaryRoot = await canonicalTemporaryRoot();
  let parent = temporaryRoot;
  if (parentOverride !== undefined) {
    const temporaryRoots = await canonicalTemporaryRoots();
    parent = await canonicalExistingDirectory(
      parentOverride,
      "JOBCTRL_E2E_APP_DIR parent",
    );
    if (!temporaryRoots.some((root) => isStrictDescendant(root, parent))) {
      throw new Error(
        `JOBCTRL_E2E_APP_DIR parent must be a strict descendant of a canonical temporary root (${temporaryRoots.join(", ")}); received ${parent}`,
      );
    }
  }

  const appDir = await fs.mkdtemp(path.join(parent, DIRECTORY_PREFIX));
  const canonical = await fs.realpath(appDir);
  await writeOwnershipMarker(canonical);
  return canonical;
}

async function prepareOwnedDocsScreenshotDirectory(appDir) {
  const canonical = await assertOwnedDocsScreenshotDirectory(appDir);
  await fs.rm(canonical, { force: true, recursive: true });
  await fs.mkdir(canonical);
  await writeOwnershipMarker(canonical);
  return canonical;
}

module.exports = {
  DIRECTORY_PREFIX,
  OWNERSHIP_MARKER,
  assertOwnedDocsScreenshotDirectory,
  canonicalTemporaryRoot,
  canonicalTemporaryRoots,
  createOwnedDocsScreenshotDirectory,
  prepareOwnedDocsScreenshotDirectory,
};
