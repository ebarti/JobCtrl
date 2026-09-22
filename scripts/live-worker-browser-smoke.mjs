import { spawn } from "node:child_process";

if (process.env.JOBCTRL_E2E_STUB_DISPATCH || process.env.JOBCTRL_E2E_ISOLATED) {
  throw new Error(
    "The live-worker smoke refuses stub or isolated E2E dispatch",
  );
}

const child = spawn(
  "corepack",
  [
    "pnpm",
    "--filter",
    "@jobctrl/web",
    "exec",
    "playwright",
    "test",
    "--config=e2e/live-worker.playwright.config.ts",
  ],
  {
    env: {
      ...process.env,
      JOBCTRL_LIVE_WORKER_SMOKE: "1",
      UV_LOCKED: "1",
    },
    detached: true,
    stdio: "inherit",
  },
);

const timeout = setTimeout(() => {
  if (child.pid) process.kill(-child.pid, "SIGTERM");
}, 270_000);

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (child.pid) process.kill(-child.pid, signal);
  });
}

const exit = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);
if (exit.code !== 0) {
  throw new Error(
    `Live-worker browser smoke failed (${exit.code ?? exit.signal})`,
  );
}
