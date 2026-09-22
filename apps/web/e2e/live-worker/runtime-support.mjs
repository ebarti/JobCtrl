import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { assertE2eWorkspaceEnvironment } = require("../fixtures/owned-workspace.cjs");

export const DEFAULT_TEMPORAL_BINARY = "/opt/homebrew/bin/temporal";

export function validateLiveWorkerEnvironment(
  env = process.env,
  { accessSync = fs.accessSync } = {},
) {
  const workspace = assertE2eWorkspaceEnvironment(env);
  if (env.JOBCTRL_LIVE_WORKER_SMOKE !== "1") {
    throw new Error("Live-worker smoke requires JOBCTRL_LIVE_WORKER_SMOKE=1");
  }
  if (["1", "true", "yes"].includes((env.JOBCTRL_E2E_STUB_DISPATCH ?? "").toLowerCase())) {
    throw new Error("Live-worker smoke refuses JOBCTRL_E2E_STUB_DISPATCH");
  }
  if (env.JOBCTRL_E2E_ISOLATED === "1") {
    throw new Error("Live-worker smoke refuses the isolated E2E server");
  }

  const temporalBinary = env.JOBCTRL_TEMPORAL_BINARY || DEFAULT_TEMPORAL_BINARY;
  accessSync(temporalBinary, fs.constants.X_OK);

  const ports = Object.fromEntries(
    [
      "JOBCTRL_E2E_API_PORT",
      "JOBCTRL_E2E_WEB_PORT",
      "JOBCTRL_LIVE_WORKER_TEMPORAL_PORT",
      "JOBCTRL_LIVE_WORKER_TEMPORAL_UI_PORT",
      "JOBCTRL_LIVE_WORKER_CONTROL_PORT",
    ].map((name) => [name, requiredPort(env, name)]),
  );
  if (new Set(Object.values(ports)).size !== Object.values(ports).length) {
    throw new Error("Live-worker smoke ports must be unique");
  }

  const token = env.JOBCTRL_LIVE_WORKER_SMOKE_TOKEN;
  if (token !== workspace.token) {
    throw new Error("Live-worker smoke token does not own this workspace");
  }
  if (path.resolve(env.JOBCTRL_LIVE_WORKER_SMOKE_APP_DIR ?? "") !== workspace.appDir) {
    throw new Error("Live-worker smoke app directory does not own this workspace");
  }
  const providerUrl = new URL(env.JOBCTRL_LIVE_WORKER_SMOKE_PROVIDER_URL ?? "invalid:");
  if (
    providerUrl.protocol !== "http:" ||
    providerUrl.hostname !== "127.0.0.1" ||
    providerUrl.port !== String(ports.JOBCTRL_LIVE_WORKER_CONTROL_PORT) ||
    providerUrl.pathname !== "/provider/chat" ||
    providerUrl.search ||
    providerUrl.hash
  ) {
    throw new Error("Live-worker smoke provider URL must target its owned control server");
  }

  const evidenceDir = path.resolve(env.JOBCTRL_LIVE_WORKER_EVIDENCE_DIR ?? "");
  if (!path.isAbsolute(evidenceDir) || evidenceDir === path.parse(evidenceDir).root) {
    throw new Error("Live-worker smoke evidence directory must be an absolute scoped path");
  }

  return {
    workspace,
    temporalBinary,
    evidenceDir,
    ports,
    token,
  };
}

function requiredPort(env, name) {
  const value = Number.parseInt(env[name] ?? "", 10);
  if (!Number.isInteger(value) || value < 1024 || value > 65535) {
    throw new Error(`${name} must be a non-privileged TCP port`);
  }
  return value;
}

export async function waitForCondition(
  check,
  {
    timeoutMs,
    intervalMs = 100,
    description = "condition",
    delay = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
    now = Date.now,
  },
) {
  const deadline = now() + timeoutMs;
  let lastError;
  while (now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await delay(intervalMs);
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : "";
  throw new Error(`Timed out waiting for ${description}${suffix}`);
}

export async function stopProcessGroup(
  pid,
  {
    paused = false,
    graceMs = 5_000,
    sendSignal = (target, signal) => process.kill(target, signal),
    waitForExit,
  } = {},
) {
  if (!Number.isInteger(pid) || pid <= 0) return "not-running";
  const target = -pid;
  const send = (signal) => {
    try {
      sendSignal(target, signal);
      return true;
    } catch (error) {
      if (error?.code === "ESRCH") return false;
      throw error;
    }
  };
  if (paused) send("SIGCONT");
  if (!send("SIGTERM")) return "already-exited";
  if (!waitForExit) return "terminated";
  try {
    await Promise.race([
      waitForExit(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("cleanup timeout")), graceMs);
      }),
    ]);
    return "terminated";
  } catch {
    send("SIGKILL");
    return "killed";
  }
}

export function sanitizedRuntimeEnvironment(env = process.env) {
  const sanitized = { ...env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "CAPSOLVER_API_KEY",
    "GEMINI_API_KEY",
    "GOOGLE_API_KEY",
    "LANGFUSE_PUBLIC_KEY",
    "LANGFUSE_SECRET_KEY",
    "LANGFUSE_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
  ]) {
    delete sanitized[key];
  }
  delete sanitized.JOBCTRL_E2E_STUB_DISPATCH;
  delete sanitized.JOBCTRL_E2E_ISOLATED;
  return sanitized;
}
