const { spawn } = require("node:child_process");
const path = require("node:path");
const { seedOwnedE2eWorkspace } = require("./seed-workspace.cjs");

const repoRoot = path.resolve(__dirname, "../../../..");
// Playwright starts webServer plugins before globalSetup. Seed before the API
// opens SQLite so the browser and test helpers observe the same database.
seedOwnedE2eWorkspace(repoRoot);
const command =
  process.env.JOBCTRL_E2E_ISOLATED === "1"
    ? ["pnpm", "--filter", "@jobctrl/api", "exec", "tsx", "test/e2e-server.ts"]
    : ["pnpm", "--filter", "@jobctrl/api", "dev"];
const child = spawn("corepack", command, {
  cwd: repoRoot,
  env: process.env,
  stdio: "inherit",
});
child.once("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal ? 1 : (code ?? 1);
});
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => child.kill(signal));
