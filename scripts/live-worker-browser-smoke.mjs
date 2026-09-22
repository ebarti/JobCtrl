import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

import { sanitizedRuntimeEnvironment } from "../apps/web/e2e/live-worker/runtime-support.mjs";

export async function runLiveWorkerBrowserSmoke({
  environment = process.env,
  spawnProcess = spawn,
  signalProcess = process,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (environment.JOBCTRL_E2E_STUB_DISPATCH || environment.JOBCTRL_E2E_ISOLATED) {
    throw new Error(
      "The live-worker smoke refuses stub or isolated E2E dispatch",
    );
  }

  const childEnvironment = sanitizedRuntimeEnvironment({
    ...environment,
    JOBCTRL_LIVE_WORKER_SMOKE: "1",
    UV_LOCKED: "1",
  });
  const child = spawnProcess(
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
      env: childEnvironment,
      detached: true,
      stdio: "inherit",
    },
  );

  const timeout = setTimer(() => {
    if (child.pid) signalProcess.kill(-child.pid, "SIGTERM");
  }, 270_000);
  const signalHandlers = new Map();
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const handler = () => {
      if (child.pid) signalProcess.kill(-child.pid, signal);
    };
    signalHandlers.set(signal, handler);
    signalProcess.once(signal, handler);
  }

  try {
    const exit = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    if (exit.code !== 0) {
      throw new Error(
        `Live-worker browser smoke failed (${exit.code ?? exit.signal})`,
      );
    }
  } finally {
    clearTimer(timeout);
    for (const [signal, handler] of signalHandlers) {
      signalProcess.off(signal, handler);
    }
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  await runLiveWorkerBrowserSmoke();
}
