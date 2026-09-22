import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { runLiveWorkerBrowserSmoke } from "../../../../scripts/live-worker-browser-smoke.mjs";

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
const {
  createOwnedE2eWorkspace,
  markLiveWorkerExitCleanupVerified,
  removeOwnedE2eWorkspace,
  workspaceEnvironment,
} = require("../fixtures/owned-workspace.cjs");
const ownedWorkspaceModule = fileURLToPath(
  new URL("../fixtures/owned-workspace.cjs", import.meta.url),
);

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

test("root live-worker command scrubs hostile credentials before its first spawn", async () => {
  const ambient = {
    ...process.env,
    PATH: process.env.PATH,
    JOBCTRL_TEST_NON_SECRET: "preserved",
  };
  for (const key of CREDENTIAL_ENV_KEYS) ambient[key] = `hostile-${key}`;
  const child = new EventEmitter();
  child.pid = 4321;
  const signalProcess = new EventEmitter();
  signalProcess.kill = () => {
    throw new Error("test child should exit before a signal is required");
  };
  let observed;

  await runLiveWorkerBrowserSmoke({
    environment: ambient,
    spawnProcess: (executable, args, options) => {
      observed = { executable, args, options };
      queueMicrotask(() => child.emit("exit", 0, null));
      return child;
    },
    signalProcess,
    setTimer: () => 1,
    clearTimer: () => {},
  });

  assert.equal(observed.executable, "corepack");
  assert.equal(observed.args[0], "pnpm");
  assert.equal(observed.options.env.JOBCTRL_TEST_NON_SECRET, "preserved");
  assert.equal(observed.options.env.JOBCTRL_LIVE_WORKER_SMOKE, "1");
  assert.equal(observed.options.env.UV_LOCKED, "1");
  assert.deepEqual(
    CREDENTIAL_ENV_KEYS.filter((key) => observed.options.env[key]),
    [],
  );
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

test("runner exit preserves a live-worker workspace until cleanup is verified", () => {
  const reportDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-live-worker-exit-test-"),
  );
  const reportPath = path.join(reportDirectory, "workspace.json");
  const childScript = `
    const fs = require("node:fs");
    const fixture = require(${JSON.stringify(ownedWorkspaceModule)});
    const workspace = fixture.configureE2eWorkspace();
    fixture.requireLiveWorkerExitCleanup(workspace);
    fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(workspace));
  `;
  const childEnvironment = { ...process.env };
  for (const key of [
    "JOBCTRL_E2E_WORKSPACE",
    "JOBCTRL_E2E_APP_DIR",
    "JOBCTRL_E2E_DB_PATH",
    "JOBCTRL_E2E_CONFIG_PATH",
    "JOBCTRL_E2E_STATE_FILE",
    "JOBCTRL_E2E_SERVICE_HOME",
  ]) {
    delete childEnvironment[key];
  }
  let workspace;
  try {
    const result = spawnSync(process.execPath, ["-e", childScript], {
      env: childEnvironment,
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /child-group cleanup is not verified; preserving owned workspace/,
    );
    workspace = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(fs.existsSync(workspace.appDir), true);
    const guard = JSON.parse(
      fs.readFileSync(
        path.join(workspace.appDir, ".jobctrl-live-worker-exit-cleanup.json"),
        "utf8",
      ),
    );
    assert.equal(guard.status, "pending");
    assert.throws(
      () => removeOwnedE2eWorkspace(workspace),
      /child-group cleanup is not verified/,
    );
  } finally {
    if (workspace && fs.existsSync(workspace.appDir)) {
      markLiveWorkerExitCleanupVerified(workspace);
      removeOwnedE2eWorkspace(workspace);
    }
    fs.rmSync(reportDirectory, { recursive: true, force: true });
  }
});

test("standard fixture runner exit still removes its unguarded workspace", () => {
  const reportDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "jobctrl-standard-exit-test-"),
  );
  const reportPath = path.join(reportDirectory, "workspace.json");
  const childScript = `
    const fs = require("node:fs");
    const fixture = require(${JSON.stringify(ownedWorkspaceModule)});
    const workspace = fixture.configureE2eWorkspace();
    fs.writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify(workspace));
  `;
  const childEnvironment = { ...process.env };
  for (const key of [
    "JOBCTRL_E2E_WORKSPACE",
    "JOBCTRL_E2E_APP_DIR",
    "JOBCTRL_E2E_DB_PATH",
    "JOBCTRL_E2E_CONFIG_PATH",
    "JOBCTRL_E2E_STATE_FILE",
    "JOBCTRL_E2E_SERVICE_HOME",
  ]) {
    delete childEnvironment[key];
  }
  try {
    const result = spawnSync(process.execPath, ["-e", childScript], {
      env: childEnvironment,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const workspace = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    assert.equal(fs.existsSync(workspace.appDir), false);
  } finally {
    fs.rmSync(reportDirectory, { recursive: true, force: true });
  }
});
