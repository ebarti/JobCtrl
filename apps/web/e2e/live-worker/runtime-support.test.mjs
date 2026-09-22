import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
  CREDENTIAL_ENV_KEYS,
  cleanupOwnedProcessGroups,
  initializeOwnedProcessState,
  inspectOwnedProcessGroup,
  launchOwnedProcessGroup,
  sanitizedRuntimeEnvironment,
  stopProcessGroup,
  validateLiveWorkerEnvironment,
  waitForCondition,
} from "./runtime-support.mjs";

const require = createRequire(import.meta.url);
const { createOwnedE2eWorkspace, removeOwnedE2eWorkspace, workspaceEnvironment } =
  require("../fixtures/owned-workspace.cjs");

function environment(workspace) {
  const controlPort = "34104";
  return {
    ...workspaceEnvironment(workspace),
    HOME: path.join(workspace.appDir, "service-home"),
    USERPROFILE: path.join(workspace.appDir, "service-home"),
    XDG_CONFIG_HOME: path.join(workspace.appDir, "service-home", ".config"),
    JOBCTRL_LIVE_WORKER_SMOKE: "1",
    JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP: "1",
    JOBCTRL_LIVE_WORKER_SMOKE_APP_DIR: workspace.appDir,
    JOBCTRL_LIVE_WORKER_SMOKE_TOKEN: workspace.token,
    JOBCTRL_LIVE_WORKER_SMOKE_PROVIDER_URL: `http://127.0.0.1:${controlPort}/provider/chat`,
    JOBCTRL_LIVE_WORKER_EVIDENCE_DIR: path.join(workspace.appDir, "evidence"),
    JOBCTRL_E2E_API_PORT: "34100",
    JOBCTRL_E2E_WEB_PORT: "34101",
    JOBCTRL_LIVE_WORKER_TEMPORAL_PORT: "34102",
    JOBCTRL_LIVE_WORKER_TEMPORAL_UI_PORT: "34103",
    JOBCTRL_LIVE_WORKER_CONTROL_PORT: controlPort,
  };
}

test("live-worker preflight rejects unsafe, stubbed, and missing runtime prerequisites", () => {
  const workspace = createOwnedE2eWorkspace();
  try {
    const env = environment(workspace);
    assert.throws(
      () => validateLiveWorkerEnvironment({ ...env, JOBCTRL_E2E_STUB_DISPATCH: "1" }),
      /refuses JOBCTRL_E2E_STUB_DISPATCH/,
    );
    assert.throws(
      () => validateLiveWorkerEnvironment(env, { accessSync: () => { throw new Error("missing"); } }),
      /missing/,
    );
    assert.throws(
      () => validateLiveWorkerEnvironment({ ...env, JOBCTRL_LIVE_WORKER_SMOKE_TOKEN: "x" }),
      /does not own this workspace/,
    );
    fs.renameSync(
      path.join(workspace.appDir, ".jobctrl-e2e-owned.json"),
      path.join(workspace.appDir, ".jobctrl-e2e-owned.replaced"),
    );
    assert.throws(
      () => validateLiveWorkerEnvironment(env, { accessSync: () => {} }),
      /ENOENT|marker/,
    );
  } finally {
    // Restore the marker only so the independent ownership guard authorizes cleanup.
    const replaced = path.join(workspace.appDir, ".jobctrl-e2e-owned.replaced");
    if (fs.existsSync(replaced)) {
      fs.renameSync(replaced, path.join(workspace.appDir, ".jobctrl-e2e-owned.json"));
    }
    removeOwnedE2eWorkspace(workspace);
  }
});

test("live-worker scrubs provider credentials and rejects inherited credential homes", () => {
  const workspace = createOwnedE2eWorkspace();
  try {
    const dirty = environment(workspace);
    for (const key of CREDENTIAL_ENV_KEYS) dirty[key] = `secret-${key}`;
    const sanitized = sanitizedRuntimeEnvironment(dirty);
    assert.equal(sanitized.JOBCTRL_LIVE_WORKER_SMOKE_BOOTSTRAP, "1");
    assert.deepEqual(
      CREDENTIAL_ENV_KEYS.filter((key) => sanitized[key]),
      [],
    );
    validateLiveWorkerEnvironment(sanitized, { accessSync: () => {} });
    assert.throws(
      () =>
        validateLiveWorkerEnvironment(
          { ...sanitized, HOME: process.env.HOME, OPENAI_API_KEY: "secret" },
          { accessSync: () => {} },
        ),
      /credential environment is not empty/,
    );
  } finally {
    removeOwnedE2eWorkspace(workspace);
  }
});

test("live-worker waits are bounded", async () => {
  let time = 0;
  await assert.rejects(
    waitForCondition(
      () => false,
      {
        timeoutMs: 20,
        intervalMs: 5,
        description: "synthetic readiness",
        delay: async (duration) => { time += duration; },
        now: () => time,
      },
    ),
    /Timed out waiting for synthetic readiness/,
  );
});

test("live-worker cleanup resumes a paused group and escalates after timeout", async () => {
  const signals = [];
  const outcome = await stopProcessGroup(4321, {
    paused: true,
    graceMs: 1,
    sendSignal: (target, signal) => signals.push([target, signal]),
    waitForExit: () => new Promise(() => {}),
  });
  assert.equal(outcome, "killed");
  assert.deepEqual(signals, [
    [-4321, "SIGCONT"],
    [-4321, "SIGTERM"],
    [-4321, "SIGKILL"],
  ]);
});

test("outer cleanup survives supervisor state loss and verifies the owned group", async () => {
  const workspace = createOwnedE2eWorkspace();
  const statePath = path.join(workspace.appDir, ".jobctrl-live-worker-processes.json");
  initializeOwnedProcessState({ statePath, workspace });
  const { record } = launchOwnedProcessGroup({
    name: "supervisor-loss",
    executable: process.execPath,
    args: ["-e", "setInterval(() => {}, 1000)"],
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    statePath,
    workspace,
  });
  try {
    await waitForCondition(() => inspectOwnedProcessGroup(record), {
      timeoutMs: 5_000,
      description: "authenticated test process group",
    });
    const outcomes = await cleanupOwnedProcessGroups({ statePath, workspace });
    assert.equal(outcomes["supervisor-loss"], "terminated");
    assert.equal(await inspectOwnedProcessGroup(record), false);
  } finally {
    await cleanupOwnedProcessGroups({ statePath, workspace }).catch(() => {});
    removeOwnedE2eWorkspace(workspace);
  }
});

test("outer cleanup escalates a shutdown timeout and rejects a reused identity", async () => {
  const workspace = createOwnedE2eWorkspace();
  const statePath = path.join(workspace.appDir, ".jobctrl-live-worker-processes.json");
  const readyPath = path.join(workspace.appDir, "stubborn-ready");
  initializeOwnedProcessState({ statePath, workspace });
  const { record } = launchOwnedProcessGroup({
    name: "stubborn",
    executable: process.execPath,
    args: [
      "-e",
      `require("node:fs").writeFileSync(${JSON.stringify(readyPath)}, "ready"); ` +
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ],
    cwd: process.cwd(),
    env: process.env,
    stdio: "ignore",
    statePath,
    workspace,
  });
  const originalState = fs.readFileSync(statePath, "utf8");
  try {
    await waitForCondition(() => inspectOwnedProcessGroup(record), {
      timeoutMs: 5_000,
      description: "authenticated stubborn process group",
    });
    await waitForCondition(() => fs.existsSync(readyPath), {
      timeoutMs: 5_000,
      description: "stubborn child signal handler",
    });
    const replaced = JSON.parse(originalState);
    replaced.groups[0].capability = "b".repeat(64);
    fs.writeFileSync(statePath, JSON.stringify(replaced), { mode: 0o600 });
    await assert.rejects(
      cleanupOwnedProcessGroups({ statePath, workspace, graceMs: 100 }),
      /no longer matches owned stubborn identity/,
    );
    assert.equal(await inspectOwnedProcessGroup(record), true);

    fs.writeFileSync(statePath, originalState, { mode: 0o600 });
    const outcomes = await cleanupOwnedProcessGroups({
      statePath,
      workspace,
      graceMs: 100,
    });
    assert.equal(outcomes.stubborn, "killed");
    assert.equal(await inspectOwnedProcessGroup(record), false);
  } finally {
    fs.writeFileSync(statePath, originalState, { mode: 0o600 });
    await cleanupOwnedProcessGroups({ statePath, workspace, graceMs: 100 }).catch(() => {});
    removeOwnedE2eWorkspace(workspace);
  }
});
