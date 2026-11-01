const {
  assertInside,
  assertE2eWorkspaceEnvironment,
  assertExpectedWorkspace,
} = require("./owned-workspace.cjs");

function assertIsolatedE2eWorkspace(env = process.env) {
  if (env.JOBCTRL_E2E_ISOLATED !== "1")
    throw new Error("Isolated E2E requires the isolated fixture mode");
  return assertE2eWorkspaceEnvironment(env).appDir;
}

module.exports = {
  assertInside,
  assertIsolatedE2eWorkspace,
  assertExpectedWorkspace,
};
