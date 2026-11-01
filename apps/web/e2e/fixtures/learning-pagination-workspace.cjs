const fs = require("node:fs");
const { Worker, isMainThread, parentPort, workerData } = require("node:worker_threads");
const Database = require("better-sqlite3");
const {
  assertE2eWorkspaceEnvironment,
  assertExpectedWorkspace,
  createSiblingOwnedE2eWorkspace,
  removeOwnedE2eWorkspace,
  workspaceEnvironment,
} = require("./owned-workspace.cjs");

async function copyWorkspace(sharedEnvironment, workspace) {
  const shared = assertE2eWorkspaceEnvironment(sharedEnvironment);
  const state = JSON.parse(fs.readFileSync(sharedEnvironment.JOBCTRL_E2E_STATE_FILE, "utf8"));
  assertExpectedWorkspace(state.workspace, sharedEnvironment);

  if (workspace.appDir === shared.appDir || workspace.temporaryRoot !== shared.temporaryRoot) {
    throw new Error("Synthetic copy requires a separate owned workspace.");
  }
  const environment = workspaceEnvironment(workspace);
  fs.mkdirSync(environment.TMPDIR, { recursive: true });
  fs.mkdirSync(environment.JOBCTRL_E2E_SERVICE_HOME, { recursive: true });
  const source = new Database(sharedEnvironment.JOBCTRL_E2E_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    await source.backup(environment.JOBCTRL_E2E_DB_PATH);
  } finally {
    source.close();
  }
  fs.copyFileSync(sharedEnvironment.JOBCTRL_E2E_CONFIG_PATH, environment.JOBCTRL_E2E_CONFIG_PATH, fs.constants.COPYFILE_EXCL);
  const copy = new Database(environment.JOBCTRL_E2E_DB_PATH, { readonly: true, fileMustExist: true });
  try {
    const ids = copy.prepare("SELECT tenant_id, recommendation_id FROM learning_recommendations ORDER BY tenant_id, recommendation_id").all();
    const expected = ["a", "b"].map((value) => ({ tenant_id: "local", recommendation_id: `learning-recommendation:${value.repeat(64)}` }));
    const reviews = copy.prepare("SELECT COUNT(*) AS count FROM learning_recommendation_reviews").get();
    const tombstones = copy.prepare("SELECT COUNT(*) AS count FROM learning_recommendation_tombstones").get();
    const policy = copy.prepare("SELECT COUNT(*) AS count FROM tailoring_policies WHERE tenant_id='local' AND version=2").get();
    if (JSON.stringify(ids) !== JSON.stringify(expected) || reviews.count || tombstones.count || policy.count) {
      throw new Error("Shared synthetic seed does not have the two pending learning recommendations.");
    }
  } finally {
    copy.close();
  }
  const report = { appDir: workspace.appDir, dbPath: environment.JOBCTRL_E2E_DB_PATH, configPath: environment.JOBCTRL_E2E_CONFIG_PATH };
  assertExpectedWorkspace(report, environment);
  fs.writeFileSync(environment.JOBCTRL_E2E_STATE_FILE, JSON.stringify({ workspace: report }), { flag: "wx", mode: 0o600 });
}

function deadline(promise, milliseconds) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), milliseconds); }),
  ]).finally(() => clearTimeout(timer));
}

async function createPaginationWorkspace(sharedEnvironment, options = {}) {
  const shared = assertE2eWorkspaceEnvironment(sharedEnvironment);
  // Allocate before starting the worker so even a stalled or terminated worker
  // has a known owner-bound destination outside the shared run's directory.
  const workspace = createSiblingOwnedE2eWorkspace(shared);
  const workerEnv = { ...sharedEnvironment, TMPDIR: shared.temporaryRoot, TMP: shared.temporaryRoot, TEMP: shared.temporaryRoot };
  let messageError;
  let workerError;
  let exited = false;
  let worker;
  try {
    worker = (options.workerFactory ?? ((file, opts) => new Worker(file, opts)))(
      options.workerFile ?? __filename,
      { env: workerEnv, workerData: { role: "learning-pagination-copy", sharedEnvironment, workspace } },
    );
  } catch (error) {
    return { workspace, stopped: false, error };
  }
  worker.on("message", (message) => {
    if (message?.type === "error") messageError = message.error;
  });
  worker.once("error", (error) => { workerError = error; });
  const exit = new Promise((resolve) => worker.once("exit", (code) => { exited = true; resolve(code); }));
  let code = await deadline(exit, options.timeoutMs ?? 20_000);
  const timedOut = code === null;
  if (timedOut) {
    try {
      const termination = worker.terminate();
      Promise.resolve(termination).catch(() => {});
      code = await deadline(exit, options.terminationTimeoutMs ?? 3_000);
    } catch (error) {
      workerError = error;
    }
    if (!exited) worker.unref();
  }
  const stopped = exited;
  if (!stopped) return { workspace, stopped, error: new Error("Synthetic seed worker did not exit; preserving its workspace.") };
  if (timedOut) return { workspace, stopped, error: new Error("Synthetic seed worker timed out.") };
  if (workerError || messageError || code !== 0) {
    return { workspace, stopped, error: workerError ?? new Error(messageError ?? `Synthetic seed worker exited with code ${code}.`) };
  }
  try {
    const environment = workspaceEnvironment(workspace);
    const state = JSON.parse(fs.readFileSync(environment.JOBCTRL_E2E_STATE_FILE, "utf8"));
    assertExpectedWorkspace(state.workspace, environment);
    if (!fs.statSync(environment.JOBCTRL_E2E_DB_PATH).isFile() || !fs.statSync(environment.JOBCTRL_E2E_CONFIG_PATH).isFile()) {
      throw new Error("Synthetic seed worker did not create its database and configuration.");
    }
  } catch (error) {
    return { workspace, stopped, error };
  }
  return { workspace, stopped };
}

async function cleanupPaginationWorkspace({ workspace, app, page, seedStopped, verifyShared, routeTimeoutMs = 5_000, closeTimeoutMs = 5_000 }) {
  let routesStopped = !page;
  let appStopped = !app;
  try {
    if (page) {
      const unrouted = await deadline(Promise.resolve().then(() => page.unrouteAll({ behavior: "wait" })).then(() => true), routeTimeoutMs);
      if (!unrouted) throw new Error("Browser routes did not stop; preserving their workspace.");
      routesStopped = true;
    }
  } finally {
    try {
      if (app) {
        const closed = await deadline(Promise.resolve().then(() => app.close()).then(() => true), closeTimeoutMs);
        if (!closed) throw new Error("Private API did not close; preserving its workspace.");
        appStopped = true;
      }
    } finally {
      try {
        if (workspace && seedStopped && routesStopped && appStopped) removeOwnedE2eWorkspace(workspace);
      } finally {
        await verifyShared();
      }
    }
  }
}

if (!isMainThread && workerData?.role === "learning-pagination-copy") {
  copyWorkspace(workerData.sharedEnvironment, workerData.workspace).catch((error) => {
    parentPort.postMessage({ type: "error", error: error instanceof Error ? error.message : String(error) });
    process.exitCode = 1;
  });
}

module.exports = { createPaginationWorkspace, cleanupPaginationWorkspace };
