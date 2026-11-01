import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(new URL("../apps/web/package.json", import.meta.url));
const Database = require("better-sqlite3");
const { createOwnedE2eWorkspace, createSiblingOwnedE2eWorkspace, removeOwnedE2eWorkspace, workspaceEnvironment } = require("./e2e/fixtures/owned-workspace.cjs");
const { createPaginationWorkspace, cleanupPaginationWorkspace } = require("./e2e/fixtures/learning-pagination-workspace.cjs");

function sharedFixture() {
  const workspace = createOwnedE2eWorkspace();
  const environment = workspaceEnvironment(workspace);
  fs.mkdirSync(environment.TMPDIR, { recursive: true });
  fs.mkdirSync(environment.JOBCTRL_E2E_SERVICE_HOME, { recursive: true });
  fs.writeFileSync(environment.JOBCTRL_E2E_CONFIG_PATH, '{"synthetic":true}');
  const db = new Database(environment.JOBCTRL_E2E_DB_PATH);
  db.exec(`CREATE TABLE learning_recommendations (tenant_id TEXT, recommendation_id TEXT);
    CREATE TABLE learning_recommendation_reviews (review_id TEXT);
    CREATE TABLE learning_recommendation_tombstones (tombstone_id TEXT);
    CREATE TABLE tailoring_policies (tenant_id TEXT, version INTEGER);`);
  for (const value of ["a", "b"]) db.prepare("INSERT INTO learning_recommendations VALUES ('local', ?)").run(`learning-recommendation:${value.repeat(64)}`);
  db.close();
  const report = { appDir: workspace.appDir, dbPath: environment.JOBCTRL_E2E_DB_PATH, configPath: environment.JOBCTRL_E2E_CONFIG_PATH };
  fs.writeFileSync(environment.JOBCTRL_E2E_STATE_FILE, JSON.stringify({ workspace: report }));
  return { workspace, environment };
}

test("sibling allocation rejects an unverified owner", () => {
  const workspace = createOwnedE2eWorkspace();
  try {
    assert.throws(() => createSiblingOwnedE2eWorkspace({ ...workspace, token: "0".repeat(64) }), /ownership marker/);
    assert.equal(fs.existsSync(workspace.appDir), true);
  } finally {
    removeOwnedE2eWorkspace(workspace);
  }
});

test("copies an owned seed and removes only its private sibling", async () => {
  const shared = sharedFixture();
  try {
    const result = await createPaginationWorkspace(shared.environment);
    assert.equal(result.stopped, true);
    assert.equal(result.error, undefined);
    assert.notEqual(result.workspace.appDir, shared.workspace.appDir);
    assert.equal(path.dirname(result.workspace.appDir), shared.workspace.temporaryRoot);
    const copy = new Database(path.join(result.workspace.appDir, "jobctrl.db"), { readonly: true });
    assert.equal(copy.prepare("SELECT COUNT(*) AS count FROM learning_recommendations").get().count, 2);
    copy.close();
    let verified = false;
    let unrouted = false;
    await cleanupPaginationWorkspace({ workspace: result.workspace, seedStopped: result.stopped, page: { unrouteAll: async (options) => { assert.deepEqual(options, { behavior: "wait" }); unrouted = true; } }, verifyShared: () => { verified = true; } });
    assert.equal(unrouted, true);
    assert.equal(verified, true);
    assert.equal(fs.existsSync(result.workspace.appDir), false);
    assert.equal(fs.existsSync(shared.environment.JOBCTRL_E2E_DB_PATH), true);
  } finally {
    removeOwnedE2eWorkspace(shared.workspace);
  }
});

test("failed copy waits for worker exit and permits owned cleanup", async () => {
  const shared = sharedFixture();
  try {
    fs.writeFileSync(shared.environment.JOBCTRL_E2E_DB_PATH, "invalid synthetic database");
    const result = await createPaginationWorkspace(shared.environment);
    assert.equal(result.stopped, true);
    assert.ok(result.error);
    assert.ok(result.workspace);
    await cleanupPaginationWorkspace({ workspace: result.workspace, seedStopped: result.stopped, verifyShared: () => {} });
    assert.equal(fs.existsSync(result.workspace.appDir), false);
    assert.equal(fs.readFileSync(shared.environment.JOBCTRL_E2E_DB_PATH, "utf8"), "invalid synthetic database");
  } finally {
    removeOwnedE2eWorkspace(shared.workspace);
  }
});

test("an unexpected shared learning baseline is refused without changing it", async () => {
  const shared = sharedFixture();
  try {
    const db = new Database(shared.environment.JOBCTRL_E2E_DB_PATH);
    db.prepare("INSERT INTO learning_recommendations VALUES ('local', 'additional-synthetic')").run();
    db.close();
    const result = await createPaginationWorkspace(shared.environment);
    assert.equal(result.stopped, true);
    assert.match(result.error.message, /two pending learning recommendations/);
    await cleanupPaginationWorkspace({ workspace: result.workspace, seedStopped: result.stopped, verifyShared: () => {} });
    const preserved = new Database(shared.environment.JOBCTRL_E2E_DB_PATH, { readonly: true });
    assert.equal(preserved.prepare("SELECT COUNT(*) AS count FROM learning_recommendations").get().count, 3);
    preserved.close();
  } finally {
    removeOwnedE2eWorkspace(shared.workspace);
  }
});

test("timeout terminates and waits for the actual worker before cleanup", async () => {
  const shared = sharedFixture();
  const script = path.join(shared.workspace.appDir, "blocked-worker.cjs");
  fs.writeFileSync(script, "while(true) {}");
  try {
    const result = await createPaginationWorkspace(shared.environment, { workerFile: script, timeoutMs: 1_000 });
    assert.equal(result.stopped, true);
    assert.match(result.error.message, /timed out/);
    assert.ok(result.workspace);
    await cleanupPaginationWorkspace({ workspace: result.workspace, seedStopped: result.stopped, verifyShared: () => {} });
    assert.equal(fs.existsSync(result.workspace.appDir), false);
  } finally {
    removeOwnedE2eWorkspace(shared.workspace);
  }
});

test("unverified worker exit preserves the workspace and still verifies shared data", async () => {
  const shared = sharedFixture();
  class UnstoppableWorker extends EventEmitter {
    terminate() { return new Promise(() => {}); }
    unref() {}
  }
  let privateWorkspace;
  try {
    const result = await createPaginationWorkspace(shared.environment, { workerFactory: () => new UnstoppableWorker(), timeoutMs: 20, terminationTimeoutMs: 20 });
    privateWorkspace = result.workspace;
    assert.equal(result.stopped, false);
    assert.match(result.error.message, /preserving/);
    let verified = false;
    await cleanupPaginationWorkspace({ workspace: result.workspace, seedStopped: result.stopped, verifyShared: () => { verified = true; } });
    assert.equal(verified, true);
    assert.equal(fs.existsSync(privateWorkspace.appDir), true);
  } finally {
    if (privateWorkspace) removeOwnedE2eWorkspace(privateWorkspace);
    removeOwnedE2eWorkspace(shared.workspace);
  }
});

test("worker startup failure retains the already-known owned workspace", async () => {
  const shared = sharedFixture();
  let privateWorkspace;
  try {
    const result = await createPaginationWorkspace(shared.environment, { workerFactory: () => { throw new Error("worker startup failed"); } });
    privateWorkspace = result.workspace;
    assert.ok(privateWorkspace);
    assert.equal(result.stopped, false);
    assert.match(result.error.message, /worker startup failed/);
    let verified = false;
    await cleanupPaginationWorkspace({ workspace: privateWorkspace, seedStopped: result.stopped, verifyShared: () => { verified = true; } });
    assert.equal(verified, true);
    assert.equal(fs.existsSync(privateWorkspace.appDir), true);
  } finally {
    if (privateWorkspace) removeOwnedE2eWorkspace(privateWorkspace);
    removeOwnedE2eWorkspace(shared.workspace);
  }
});

test("API close failure preserves its workspace and still verifies shared data", async () => {
  const workspace = createOwnedE2eWorkspace();
  let verified = false;
  try {
    await assert.rejects(cleanupPaginationWorkspace({ workspace, seedStopped: true, app: { close: async () => { throw new Error("close failed"); } }, verifyShared: () => { verified = true; } }), /close failed/);
    assert.equal(verified, true);
    assert.equal(fs.existsSync(workspace.appDir), true);
  } finally {
    removeOwnedE2eWorkspace(workspace);
  }
});

test("API close timeout preserves its workspace and still verifies shared data", async () => {
  const workspace = createOwnedE2eWorkspace();
  let verified = false;
  try {
    await assert.rejects(cleanupPaginationWorkspace({ workspace, seedStopped: true, app: { close: () => new Promise(() => {}) }, closeTimeoutMs: 20, verifyShared: () => { verified = true; } }), /did not close/);
    assert.equal(verified, true);
    assert.equal(fs.existsSync(workspace.appDir), true);
  } finally {
    removeOwnedE2eWorkspace(workspace);
  }
});

test("route disposal rejection still closes the API and verifies shared data", async () => {
  const workspace = createOwnedE2eWorkspace();
  let closed = false;
  let verified = false;
  try {
    await assert.rejects(cleanupPaginationWorkspace({ workspace, seedStopped: true, page: { unrouteAll: async () => { throw new Error("unroute failed"); } }, app: { close: async () => { closed = true; } }, verifyShared: () => { verified = true; } }), /unroute failed/);
    assert.equal(closed, true);
    assert.equal(verified, true);
    assert.equal(fs.existsSync(workspace.appDir), true);
  } finally {
    removeOwnedE2eWorkspace(workspace);
  }
});

test("route disposal timeout retains the workspace and handles a late rejection", async () => {
  const workspace = createOwnedE2eWorkspace();
  let rejectRoute;
  const pending = new Promise((_, reject) => { rejectRoute = reject; });
  let closed = false;
  let verified = false;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  try {
    await assert.rejects(cleanupPaginationWorkspace({ workspace, seedStopped: true, page: { unrouteAll: () => pending }, routeTimeoutMs: 20, app: { close: async () => { closed = true; } }, verifyShared: () => { verified = true; } }), /Browser routes did not stop/);
    assert.equal(closed, true);
    assert.equal(verified, true);
    assert.equal(fs.existsSync(workspace.appDir), true);
    rejectRoute(new Error("late unroute rejection"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
    removeOwnedE2eWorkspace(workspace);
  }
});
