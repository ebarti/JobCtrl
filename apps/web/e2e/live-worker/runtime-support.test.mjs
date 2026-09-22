import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

import {
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
    JOBCTRL_LIVE_WORKER_SMOKE: "1",
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
