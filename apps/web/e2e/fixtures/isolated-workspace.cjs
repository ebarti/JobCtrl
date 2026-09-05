const fs = require("node:fs");
const path = require("node:path");
const {
  assertOwnedDocsScreenshotDirectory,
} = require("./docs-screenshot-workspace.cjs");

function assertInside(root, candidate) {
  if (!candidate || !path.isAbsolute(candidate))
    throw new Error("Isolated E2E paths must be absolute");
  const relative = path.relative(root, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Isolated E2E path escaped its owned workspace");
  if (path.normalize(candidate) !== candidate)
    throw new Error("Isolated E2E path must be normalized");
  let component = root;
  for (const segment of relative.split(path.sep)) {
    component = path.join(component, segment);
    try {
      if (fs.lstatSync(component).isSymbolicLink())
        throw new Error("Isolated E2E path follows a symlink");
    } catch (error) {
      if (error.code === "ENOENT") break;
      throw error;
    }
  }
  return candidate;
}

async function assertIsolatedE2eWorkspace(env = process.env) {
  if (env.JOBCTRL_E2E_ISOLATED !== "1" || env.JOBCTRL_DOCS_SCREENSHOTS !== "1")
    throw new Error("Isolated E2E requires the owned screenshot fixture mode");
  const appDir = await assertOwnedDocsScreenshotDirectory(
    env.JOBCTRL_E2E_APP_DIR,
  );
  if (fs.realpathSync(env.JOBCTRL_DIR) !== appDir)
    throw new Error("Isolated E2E app directory mismatch");
  for (const name of [
    "JOBCTRL_DB_PATH",
    "JOBCTRL_CONFIG_PATH",
    "JOBCTRL_E2E_DB_PATH",
    "JOBCTRL_E2E_CONFIG_PATH",
    "JOBCTRL_E2E_STATE_FILE",
    "JOBCTRL_E2E_SERVICE_HOME",
    "TMPDIR",
  ]) {
    assertInside(appDir, env[name]);
  }
  if (
    env.JOBCTRL_DB_PATH !== env.JOBCTRL_E2E_DB_PATH ||
    env.JOBCTRL_CONFIG_PATH !== env.JOBCTRL_E2E_CONFIG_PATH
  )
    throw new Error("Isolated E2E database/configuration mismatch");
  return appDir;
}

function assertExpectedWorkspace(workspace, env = process.env) {
  const root = fs.realpathSync(env.JOBCTRL_E2E_APP_DIR);
  if (
    workspace?.appDir !== root ||
    workspace?.dbPath !== env.JOBCTRL_E2E_DB_PATH
  )
    throw new Error("Isolated E2E state belongs to a different run");
  assertInside(root, workspace.dbPath);
  if (
    workspace.configPath !== undefined &&
    workspace.configPath !== env.JOBCTRL_E2E_CONFIG_PATH
  )
    throw new Error("Isolated E2E state configuration mismatch");
}

module.exports = {
  assertInside,
  assertIsolatedE2eWorkspace,
  assertExpectedWorkspace,
};
