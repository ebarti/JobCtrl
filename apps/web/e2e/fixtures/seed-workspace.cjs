const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  assertE2eWorkspaceEnvironment,
  assertExpectedWorkspace,
} = require("./owned-workspace.cjs");

function seedOwnedE2eWorkspace(
  repoRoot,
  env = process.env,
  runSeed = execFileSync,
) {
  const workspace = assertE2eWorkspaceEnvironment(env);
  // Never reseed an already-started run, including concurrent startup attempts.
  fs.writeFileSync(
    path.join(workspace.appDir, ".jobctrl-e2e-seeding"),
    "started\n",
    { flag: "wx", mode: 0o600 },
  );
  fs.mkdirSync(env.JOBCTRL_E2E_SERVICE_HOME, { recursive: true });
  fs.mkdirSync(env.TMPDIR, { recursive: true });
  const stdout = runSeed(
    "corepack",
    [
      "pnpm",
      "--filter",
      "@jobctrl/api",
      "exec",
      "tsx",
      "test/qa-seed.ts",
      workspace.appDir,
    ],
    {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "inherit"],
      encoding: "utf8",
    },
  );
  const report = JSON.parse(stdout.trim());
  assertExpectedWorkspace(report, env);
  fs.writeFileSync(
    env.JOBCTRL_E2E_STATE_FILE,
    JSON.stringify({ workspace: report }),
    { flag: "wx", mode: 0o600 },
  );
  return report;
}

module.exports = { seedOwnedE2eWorkspace };
