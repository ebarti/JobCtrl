import { createHash, randomBytes } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { assertE2eWorkspaceEnvironment } = require("../fixtures/owned-workspace.cjs");
const execFile = promisify(execFileCallback);
const here = path.dirname(fileURLToPath(import.meta.url));

export const DEFAULT_TEMPORAL_BINARY = "/opt/homebrew/bin/temporal";
export const OWNED_PROCESS_GROUP_LAUNCHER = path.join(here, "owned-process-group.mjs");
export const OWNED_PROCESS_STATE_BASENAME = ".jobctrl-live-worker-processes.json";
export const LIVE_WORKER_BOOTSTRAP_ENV = "JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP";
export const CREDENTIAL_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_FOUNDRY_RESOURCE",
  "ANTHROPIC_VERTEX_PROJECT_ID",
  "ANTHROPIC_AWS_WORKSPACE_ID",
  "AWS_ACCESS_KEY_ID",
  "AWS_CONFIG_FILE",
  "AWS_PROFILE",
  "AWS_REGION",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_SHARED_CREDENTIALS_FILE",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_CONFIG_DIR",
  "AZURE_TENANT_ID",
  "CAPSOLVER_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_USE_ANTHROPIC_AWS",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CLOUDSDK_CONFIG",
  "CLOUD_ML_REGION",
  "CODEX_API_KEY",
  "CODEX_HOME",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_CLOUD_LOCATION",
  "GOOGLE_CLOUD_PROJECT",
  "GOOGLE_GENAI_USE_VERTEXAI",
  "LANGFUSE_BASE_URL",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
]);

export function validateLiveWorkerEnvironment(
  env = process.env,
  { accessSync = fs.accessSync } = {},
) {
  const workspace = assertE2eWorkspaceEnvironment(env);
  if (env.JOBCTRL_LIVE_WORKER_SMOKE !== "1") {
    throw new Error("Live-worker smoke requires JOBCTRL_LIVE_WORKER_SMOKE=1");
  }
  if (env[LIVE_WORKER_BOOTSTRAP_ENV] !== "1") {
    throw new Error(`Live-worker smoke requires ${LIVE_WORKER_BOOTSTRAP_ENV}=1`);
  }
  if (["1", "true", "yes"].includes((env.JOBCTRL_E2E_STUB_DISPATCH ?? "").toLowerCase())) {
    throw new Error("Live-worker smoke refuses JOBCTRL_E2E_STUB_DISPATCH");
  }
  if (env.JOBCTRL_E2E_ISOLATED === "1") {
    throw new Error("Live-worker smoke refuses the isolated E2E server");
  }
  assertCredentialFreeRuntimeEnvironment(env, workspace);

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
    processStatePath: path.join(workspace.appDir, OWNED_PROCESS_STATE_BASENAME),
  };
}

export function assertCredentialFreeRuntimeEnvironment(env, workspace) {
  const present = CREDENTIAL_ENV_KEYS.filter((key) => (env[key] ?? "").trim());
  if (present.length) {
    throw new Error(`Live-worker smoke credential environment is not empty: ${present.join(", ")}`);
  }
  const expectedHome = path.join(workspace.appDir, "service-home");
  for (const key of ["HOME", "USERPROFILE"]) {
    if (path.resolve(env[key] ?? "") !== expectedHome) {
      throw new Error(`Live-worker smoke requires an owned ${key}`);
    }
  }
  if (path.resolve(env.XDG_CONFIG_HOME ?? "") !== path.join(expectedHome, ".config")) {
    throw new Error("Live-worker smoke requires an owned XDG_CONFIG_HOME");
  }
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
  for (const key of CREDENTIAL_ENV_KEYS) delete sanitized[key];
  delete sanitized.JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP_VALIDATED;
  delete sanitized.JOBCTRL_E2E_STUB_DISPATCH;
  delete sanitized.JOBCTRL_E2E_ISOLATED;
  sanitized[LIVE_WORKER_BOOTSTRAP_ENV] = "1";
  return sanitized;
}

export function initializeOwnedProcessState({ statePath, workspace }) {
  assertOwnedProcessStatePath(statePath, workspace);
  const state = processStateDocument(workspace, []);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return state;
}

export function launchOwnedProcessGroup({
  name,
  executable,
  args,
  cwd,
  env,
  stdio,
  statePath,
  workspace,
}) {
  assertOwnedProcessStatePath(statePath, workspace);
  if (!/^[a-z][a-z0-9-]{0,31}$/.test(name)) {
    throw new Error("Owned process group name is invalid");
  }
  const capability = randomBytes(32).toString("hex");
  const child = spawn(
    process.execPath,
    [
      OWNED_PROCESS_GROUP_LAUNCHER,
      "--state",
      statePath,
      "--owner-hash",
      tokenHash(workspace.token),
      "--capability",
      capability,
      "--name",
      name,
      "--",
      executable,
      ...args,
    ],
    { cwd, env, detached: true, stdio },
  );
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    throw new Error(`Owned ${name} process group did not receive a PID`);
  }
  const record = {
    name,
    pid: child.pid,
    capability,
    launcherPath: OWNED_PROCESS_GROUP_LAUNCHER,
  };
  try {
    const state = readOwnedProcessState({ statePath, workspace });
    if (state.groups.some((item) => item.name === name)) {
      throw new Error(`Owned process group ${name} is already registered`);
    }
    writeOwnedProcessState(statePath, { ...state, groups: [...state.groups, record] });
  } catch (error) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // Preserve the registration failure; the group may not have started yet.
    }
    throw error;
  }
  return { child, record };
}

export async function cleanupOwnedProcessGroups({
  statePath,
  workspace,
  graceMs = 5_000,
  inspect = inspectOwnedProcessGroup,
  groupExists = defaultGroupExists,
  sendSignal = (target, signal) => process.kill(target, signal),
}) {
  assertOwnedProcessStatePath(statePath, workspace);
  let state;
  try {
    state = readOwnedProcessState({ statePath, workspace });
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
  const outcomes = {};
  for (const record of [...state.groups].reverse()) {
    const live = await inspect(record);
    if (!live) {
      if (groupExists(record.pid)) {
        throw new Error(
          `Owned ${record.name} group ${record.pid} still exists without its authenticated leader`,
        );
      }
      outcomes[record.name] = "already-exited";
      continue;
    }

    const signal = (name) => {
      try {
        sendSignal(-record.pid, name);
        return true;
      } catch (error) {
        if (error?.code === "ESRCH") return false;
        throw error;
      }
    };
    signal("SIGCONT");
    if (!signal("SIGTERM")) {
      outcomes[record.name] = "already-exited";
      continue;
    }
    try {
      await waitForCondition(() => !groupExists(record.pid), {
        timeoutMs: graceMs,
        intervalMs: 50,
        description: `${record.name} process-group termination`,
      });
      outcomes[record.name] = "terminated";
    } catch {
      signal("SIGKILL");
      await waitForCondition(() => !groupExists(record.pid), {
        timeoutMs: graceMs,
        intervalMs: 50,
        description: `${record.name} process-group kill`,
      });
      outcomes[record.name] = "killed";
    }
  }
  writeOwnedProcessState(statePath, {
    ...state,
    cleanup: outcomes,
    cleanedAt: new Date().toISOString(),
  });
  return outcomes;
}

export async function inspectOwnedProcessGroup(record, { runPs = execFile } = {}) {
  validateProcessRecord(record);
  let stdout;
  try {
    ({ stdout } = await runPs("/bin/ps", [
      "-p",
      String(record.pid),
      "-o",
      "pid=",
      "-o",
      "pgid=",
      "-o",
      "command=",
    ]));
  } catch (error) {
    if (error?.code === 1) return false;
    throw error;
  }
  const match = stdout.trim().match(/^(\d+)\s+(\d+)\s+([\s\S]+)$/);
  if (!match) return false;
  const pid = Number.parseInt(match[1], 10);
  const pgid = Number.parseInt(match[2], 10);
  const command = match[3];
  const ownershipArgument = `--capability ${record.capability} --name ${record.name} --`;
  if (
    pid !== record.pid ||
    pgid !== record.pid ||
    !command.includes(record.launcherPath) ||
    !command.includes(ownershipArgument)
  ) {
    throw new Error(`Process group ${record.pid} no longer matches owned ${record.name} identity`);
  }
  return true;
}

function readOwnedProcessState({ statePath, workspace }) {
  assertOwnedProcessStatePath(statePath, workspace);
  const descriptor = fs.openSync(
    statePath,
    fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
  );
  try {
    const metadata = fs.fstatSync(descriptor);
    const state = JSON.parse(fs.readFileSync(descriptor, "utf8"));
    if (!metadata.isFile() || metadata.nlink !== 1 || (metadata.mode & 0o077)) {
      throw new Error("Owned process state must be a private regular file");
    }
    if (
      state?.schemaVersion !== 1 ||
      state.appDir !== workspace.appDir ||
      state.ownerTokenHash !== tokenHash(workspace.token) ||
      !Array.isArray(state.groups)
    ) {
      throw new Error("Owned process state does not match this workspace");
    }
    for (const record of state.groups) validateProcessRecord(record);
    return state;
  } finally {
    fs.closeSync(descriptor);
  }
}

function validateProcessRecord(record) {
  if (
    !record ||
    !/^[a-z][a-z0-9-]{0,31}$/.test(record.name ?? "") ||
    !Number.isInteger(record.pid) ||
    record.pid <= 0 ||
    !/^[a-f0-9]{64}$/.test(record.capability ?? "") ||
    record.launcherPath !== OWNED_PROCESS_GROUP_LAUNCHER
  ) {
    throw new Error("Owned process state contains an invalid process identity");
  }
}

function assertOwnedProcessStatePath(statePath, workspace) {
  if (
    path.resolve(statePath) !==
    path.join(workspace.appDir, OWNED_PROCESS_STATE_BASENAME)
  ) {
    throw new Error("Owned process state path escaped its workspace");
  }
}

function processStateDocument(workspace, groups) {
  return {
    schemaVersion: 1,
    appDir: workspace.appDir,
    ownerTokenHash: tokenHash(workspace.token),
    groups,
  };
}

function writeOwnedProcessState(statePath, state) {
  const temporary = `${statePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(state, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(temporary, statePath);
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function defaultGroupExists(pid) {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    throw error;
  }
}
