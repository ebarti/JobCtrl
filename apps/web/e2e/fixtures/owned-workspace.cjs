const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const DIRECTORY_PREFIX = "jobctrl-e2e-";
const OWNERSHIP_MARKER = ".jobctrl-e2e-owned.json";
const WORKSPACE_ENV = "JOBCTRL_E2E_WORKSPACE";
const creatorAllocations = new Map();
let creatorCleanupRegistered = false;

function retainCreatorCleanup(workspace) {
  // Only configure's allocating process owns this fallback. Processes receiving
  // a capability through their environment leave cleanup to its creator.
  creatorAllocations.set(workspace.appDir, Object.freeze({ ...workspace }));
  if (creatorCleanupRegistered) return;
  creatorCleanupRegistered = true;
  process.once("exit", () => {
    for (const allocated of creatorAllocations.values()) {
      try {
        try {
          fs.lstatSync(allocated.appDir);
        } catch (error) {
          if (error.code === "ENOENT") continue;
          throw error;
        }
        removeOwnedE2eWorkspace(allocated);
      } catch (error) {
        // Preserve a replaced or otherwise unsafe directory for inspection.
        console.error(`E2E creator cleanup refused: ${error.message}`);
        if (!process.exitCode) process.exitCode = 1;
      }
    }
  });
}

function isStrictDescendant(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
}

function canonicalExistingDirectory(candidate, label) {
  let canonical;
  try {
    canonical = fs.realpathSync(candidate);
  } catch (error) {
    throw new Error(`${label} must be an existing directory: ${candidate}`, {
      cause: error,
    });
  }
  if (!fs.statSync(canonical).isDirectory())
    throw new Error(`${label} must be a directory: ${canonical}`);
  return canonical;
}

function canonicalTemporaryRoot() {
  return canonicalExistingDirectory(os.tmpdir(), "System temporary root");
}

function canonicalTemporaryRoots() {
  const roots = [canonicalTemporaryRoot()];
  for (const candidate of ["/tmp", "/private/tmp"]) {
    try {
      const canonical = canonicalExistingDirectory(candidate, "Temporary root");
      if (!roots.includes(canonical)) roots.push(canonical);
    } catch {
      // Conventional POSIX roots do not exist on every supported host.
    }
  }
  return roots;
}

function assertInside(root, candidate) {
  if (
    typeof candidate !== "string" ||
    !path.isAbsolute(candidate) ||
    path.normalize(candidate) !== candidate
  )
    throw new Error("E2E paths must be absolute and normalized");
  if (!isStrictDescendant(root, candidate))
    throw new Error("E2E path escaped its owned workspace");
  let component = root;
  for (const segment of path.relative(root, candidate).split(path.sep)) {
    component = path.join(component, segment);
    try {
      if (fs.lstatSync(component).isSymbolicLink())
        throw new Error("E2E path follows a symlink");
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return candidate;
}

function createOwnedE2eWorkspace(parentOverride) {
  const roots = canonicalTemporaryRoots();
  const parent =
    parentOverride === undefined
      ? roots[0]
      : canonicalExistingDirectory(
          parentOverride,
          "JOBCTRL_E2E_APP_DIR parent",
        );
  const temporaryRoot = roots.find((root) =>
    parentOverride === undefined
      ? root === parent
      : isStrictDescendant(root, parent),
  );
  if (!temporaryRoot)
    throw new Error(
      "JOBCTRL_E2E_APP_DIR parent must be a strict descendant of a canonical temporary root",
    );
  if (parentOverride !== undefined) {
    // Permit conventional aliases such as macOS /tmp -> /private/tmp, while
    // rejecting symlinks within the caller-selected temporary subtree.
    const lexicalParent = path.resolve(parentOverride);
    const canonicalSpelling =
      lexicalParent === parent ||
      [os.tmpdir(), "/tmp", "/private/tmp"].some((alias) => {
        try {
          return (
            isStrictDescendant(path.resolve(alias), lexicalParent) &&
            path.join(
              fs.realpathSync(alias),
              path.relative(path.resolve(alias), lexicalParent),
            ) === parent
          );
        } catch {
          return false;
        }
      });
    if (!canonicalSpelling)
      throw new Error("E2E parent must not follow a symlink");
    assertInside(temporaryRoot, parent);
  }
  const appDir = fs.mkdtempSync(path.join(parent, DIRECTORY_PREFIX));
  const metadata = fs.lstatSync(appDir, { bigint: true });
  const workspace = {
    schemaVersion: 1,
    appDir,
    temporaryRoot,
    token: randomBytes(32).toString("hex"),
    device: metadata.dev.toString(),
    inode: metadata.ino.toString(),
  };
  fs.writeFileSync(
    path.join(appDir, OWNERSHIP_MARKER),
    JSON.stringify(workspace),
    {
      flag: "wx",
      mode: 0o600,
    },
  );
  return workspace;
}

function assertOwnedE2eWorkspace(workspace) {
  if (
    !workspace ||
    workspace.schemaVersion !== 1 ||
    !/^[a-f0-9]{64}$/.test(workspace.token ?? "") ||
    typeof workspace.appDir !== "string" ||
    typeof workspace.temporaryRoot !== "string" ||
    !/^[0-9]+$/.test(workspace.device ?? "") ||
    !/^[0-9]+$/.test(workspace.inode ?? "")
  )
    throw new Error(
      "E2E run requires its independently allocated ownership capability",
    );
  const { appDir, temporaryRoot } = workspace;
  if (
    !path.basename(appDir).startsWith(DIRECTORY_PREFIX) ||
    canonicalExistingDirectory(temporaryRoot, "E2E temporary root") !==
      temporaryRoot
  )
    throw new Error("Invalid E2E workspace root");
  assertInside(temporaryRoot, appDir);
  const metadata = fs.lstatSync(appDir, { bigint: true });
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    metadata.dev.toString() !== workspace.device ||
    metadata.ino.toString() !== workspace.inode
  )
    throw new Error("E2E workspace identity changed after allocation");
  const descriptor = fs.openSync(
    path.join(appDir, OWNERSHIP_MARKER),
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const markerMetadata = fs.fstatSync(descriptor);
    const marker = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (
      !markerMetadata.isFile() ||
      markerMetadata.nlink !== 1 ||
      Object.keys(workspace).some((key) => marker[key] !== workspace[key])
    )
      throw new Error("E2E ownership marker does not match this run");
  } finally {
    fs.closeSync(descriptor);
  }
  return workspace;
}

function workspaceEnvironment(workspace) {
  assertOwnedE2eWorkspace(workspace);
  const { appDir } = workspace;
  return {
    [WORKSPACE_ENV]: JSON.stringify(workspace),
    JOBCTRL_E2E_APP_DIR: appDir,
    JOBCTRL_E2E_DB_PATH: path.join(appDir, "jobctrl.db"),
    JOBCTRL_E2E_CONFIG_PATH: path.join(appDir, "config.json"),
    JOBCTRL_E2E_STATE_FILE: path.join(appDir, ".jobctrl-e2e-state.json"),
    JOBCTRL_E2E_SERVICE_HOME: path.join(appDir, "service-home"),
    JOBCTRL_DIR: appDir,
    JOBCTRL_DB_PATH: path.join(appDir, "jobctrl.db"),
    JOBCTRL_CONFIG_PATH: path.join(appDir, "config.json"),
    TMPDIR: path.join(appDir, "tmp"),
    TMP: path.join(appDir, "tmp"),
    TEMP: path.join(appDir, "tmp"),
  };
}

function assertE2eWorkspaceEnvironment(env = process.env) {
  const workspace = assertOwnedE2eWorkspace(
    JSON.parse(env[WORKSPACE_ENV] ?? "null"),
  );
  const expected = workspaceEnvironment(workspace);
  for (const [key, value] of Object.entries(expected)) {
    if (env[key] !== value)
      throw new Error(`E2E workspace environment mismatch: ${key}`);
  }
  for (const key of [
    "JOBCTRL_E2E_DB_PATH",
    "JOBCTRL_E2E_CONFIG_PATH",
    "JOBCTRL_E2E_STATE_FILE",
    "JOBCTRL_E2E_SERVICE_HOME",
    "TMPDIR",
  ])
    assertInside(workspace.appDir, env[key]);
  return workspace;
}

function configureE2eWorkspace(env = process.env) {
  if (env[WORKSPACE_ENV]) return assertE2eWorkspaceEnvironment(env);
  // Caller paths describe a parent, never a pre-existing app/data/state directory.
  for (const key of [
    "JOBCTRL_E2E_DB_PATH",
    "JOBCTRL_E2E_CONFIG_PATH",
    "JOBCTRL_E2E_STATE_FILE",
    "JOBCTRL_E2E_SERVICE_HOME",
  ])
    if (env[key])
      throw new Error(`${key} requires this run's allocated workspace`);
  const workspace = createOwnedE2eWorkspace(env.JOBCTRL_E2E_APP_DIR);
  retainCreatorCleanup(workspace);
  Object.assign(env, workspaceEnvironment(workspace));
  return workspace;
}

function assertExpectedWorkspace(report, env = process.env) {
  const workspace = assertE2eWorkspaceEnvironment(env);
  if (
    report?.appDir !== workspace.appDir ||
    report?.dbPath !== env.JOBCTRL_E2E_DB_PATH ||
    (report.configPath !== undefined &&
      report.configPath !== env.JOBCTRL_E2E_CONFIG_PATH)
  )
    throw new Error("E2E state belongs to a different run");
  return workspace;
}

function removeOwnedE2eWorkspace(workspace) {
  assertOwnedE2eWorkspace(workspace);
  fs.rmSync(workspace.appDir, { recursive: true, force: true });
  if (creatorAllocations.get(workspace.appDir)?.token === workspace.token)
    creatorAllocations.delete(workspace.appDir);
}

module.exports = {
  DIRECTORY_PREFIX,
  OWNERSHIP_MARKER,
  WORKSPACE_ENV,
  assertInside,
  canonicalTemporaryRoot,
  canonicalTemporaryRoots,
  createOwnedE2eWorkspace,
  assertOwnedE2eWorkspace,
  workspaceEnvironment,
  assertE2eWorkspaceEnvironment,
  configureE2eWorkspace,
  assertExpectedWorkspace,
  removeOwnedE2eWorkspace,
};
