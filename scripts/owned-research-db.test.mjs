import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import ownedWorkspace from "../apps/web/e2e/fixtures/owned-workspace.cjs";
import guarded from "../apps/web/e2e/fixtures/owned-research-db.cjs";

const { createOwnedE2eWorkspace, workspaceEnvironment } = ownedWorkspace;
const { createAcquisitionCleanup, openOwnedResearchDb } = guarded;
const requireWeb = createRequire(new URL("../apps/web/package.json", import.meta.url));

function fixture(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-research-owner-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const workspace = createOwnedE2eWorkspace(parent);
  const env = workspaceEnvironment(workspace);
  return { env, dbPath: env.JOBCTRL_E2E_DB_PATH, parent };
}

function seededCleanupFixture(t) {
  const { env, dbPath, parent } = fixture(t);
  const Database = requireWeb("better-sqlite3");
  const setup = new Database(dbPath);
  setup.exec(`
    CREATE TABLE application_outcomes(tenant_id TEXT, outcome_id TEXT, job_id TEXT);
    CREATE TABLE job_list_projections(tenant_id TEXT, job_id TEXT);
    CREATE TABLE contact_research_tasks(tenant_id TEXT, task_id TEXT);
    CREATE TABLE contact_research_task_projections(tenant_id TEXT, task_id TEXT);
    CREATE TABLE contact_candidates(tenant_id TEXT, task_id TEXT);
    CREATE TABLE job_events(tenant_id TEXT, entity_kind TEXT, entity_ref TEXT);
    INSERT INTO application_outcomes VALUES ('local', 'other-outcome', 'other-job');
    INSERT INTO job_list_projections VALUES ('local', 'other-job');
    INSERT INTO contact_research_tasks VALUES ('local', 'synthetic-task');
    INSERT INTO contact_research_task_projections VALUES ('local', 'synthetic-task');
    INSERT INTO contact_candidates VALUES ('local', 'synthetic-task');
    INSERT INTO job_events VALUES ('local', 'contact_research', 'synthetic-task');
  `);
  setup.close();
  const open = (identity) => openOwnedResearchDb(
    dbPath, (filename) => new Database(filename, { fileMustExist: true }), env, identity,
  );
  const cleanup = createAcquisitionCleanup(open, "synthetic-task", "synthetic-job");
  const seed = open();
  try {
    seed.db.transaction(() => {
      seed.verify();
      seed.db.prepare("INSERT INTO application_outcomes VALUES (?, ?, ?)")
        .run("local", "outcome-e2e-outreach", "synthetic-job");
      seed.db.prepare("INSERT INTO job_list_projections VALUES (?, ?)").run("local", "synthetic-job");
      seed.verify();
    })();
    cleanup.seedCommitted(seed.identity);
  } finally {
    seed.close();
  }
  return { cleanup, dbPath, parent, Database };
}

test("a failed subprocess after the initial seed cleans it without deleting an unowned task", (t) => {
  const { cleanup, dbPath, Database } = seededCleanupFixture(t);
  assert.throws(() => {
    try {
      const worker = spawnSync(process.execPath, ["-e", "process.exit(17)"]);
      if (worker.status !== 0) throw new Error("synthetic worker failed");
    } finally {
      cleanup.cleanup();
    }
  }, /synthetic worker failed/);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    assert.deepEqual(db.prepare("SELECT outcome_id, job_id FROM application_outcomes").all(), [
      { outcome_id: "other-outcome", job_id: "other-job" },
    ]);
    assert.deepEqual(db.prepare("SELECT job_id FROM job_list_projections").all(), [{ job_id: "other-job" }]);
    for (const table of ["contact_research_tasks", "contact_research_task_projections", "contact_candidates", "job_events"])
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 1);
  } finally {
    db.close();
  }
});

test("cleanup removes the task only after its handoff commits", (t) => {
  const { cleanup, dbPath, Database } = seededCleanupFixture(t);
  cleanup.taskCommitted();
  cleanup.cleanup();
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    for (const table of ["contact_research_tasks", "contact_research_task_projections", "contact_candidates", "job_events"])
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM application_outcomes").get().count, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM job_list_projections").get().count, 1);
  } finally {
    db.close();
  }
});

test("an uncommitted seed is never opened for cleanup", () => {
  const cleanup = createAcquisitionCleanup(() => { throw new Error("unexpected database open"); }, "task", "job");
  cleanup.cleanup();
  assert.throws(() => cleanup.taskCommitted(), /seed has not committed/);
});

test("cleanup refuses a replaced workspace database without touching either copy", (t) => {
  const { cleanup, dbPath, parent } = seededCleanupFixture(t);
  const original = path.join(parent, "retained-original.db");
  const replacement = path.join(parent, "replacement.db");
  fs.copyFileSync(dbPath, replacement);
  const beforeOriginal = fs.readFileSync(dbPath);
  const beforeReplacement = fs.readFileSync(replacement);
  fs.renameSync(dbPath, original);
  fs.copyFileSync(replacement, dbPath);
  assert.throws(() => cleanup.cleanup(), /identity changed/);
  assert.deepEqual(fs.readFileSync(original), beforeOriginal);
  assert.deepEqual(fs.readFileSync(replacement), beforeReplacement);
  assert.deepEqual(fs.readFileSync(dbPath), beforeReplacement);
});

test("the Node seeder binds the actual SQLite descriptor to its owned database", (t) => {
  const { env, dbPath } = fixture(t);
  const Database = requireWeb("better-sqlite3");
  const seed = new Database(dbPath);
  seed.exec("CREATE TABLE synthetic(value TEXT)");
  seed.close();
  const guard = openOwnedResearchDb(dbPath, (filename) => new Database(filename, { fileMustExist: true }), env);
  try {
    guard.db.transaction(() => {
      guard.verify();
      guard.db.prepare("INSERT INTO synthetic(value) VALUES (?)").run("owned");
      guard.verify();
    })();
    assert.equal(guard.db.prepare("SELECT value FROM synthetic").get().value, "owned");
  } finally {
    guard.close();
  }
});

test("the Node seeder refuses a replacement during SQLite open without writing either file", (t) => {
  const { env, dbPath, parent } = fixture(t);
  const Database = requireWeb("better-sqlite3");
  const replacement = path.join(parent, "replacement.db");
  const retained = path.join(parent, "original.db");
  for (const [filename, value] of [[dbPath, "original"], [replacement, "replacement"]]) {
    const db = new Database(filename);
    db.exec(`CREATE TABLE synthetic(value TEXT); INSERT INTO synthetic VALUES ('${value}')`);
    db.close();
  }
  const originalBytes = fs.readFileSync(dbPath);
  const replacementBytes = fs.readFileSync(replacement);
  assert.throws(() => openOwnedResearchDb(dbPath, (filename) => {
    fs.renameSync(filename, retained);
    fs.copyFileSync(replacement, filename);
    return new Database(filename, { fileMustExist: true });
  }, env), /does not match the owned file/);
  assert.deepEqual(fs.readFileSync(retained), originalBytes);
  assert.deepEqual(fs.readFileSync(replacement), replacementBytes);
  assert.deepEqual(fs.readFileSync(dbPath), replacementBytes);
});

test("a matching decoy descriptor cannot hide a replacement opened by the Node seeder", (t) => {
  const { env, dbPath, parent } = fixture(t);
  const replacement = path.join(parent, "replacement.db");
  const retained = path.join(parent, "original.db");
  fs.writeFileSync(dbPath, "original synthetic database");
  fs.writeFileSync(replacement, "replacement synthetic database");
  const originalBytes = fs.readFileSync(dbPath);
  const replacementBytes = fs.readFileSync(replacement);
  assert.throws(() => openOwnedResearchDb(dbPath, (filename) => {
    fs.renameSync(filename, retained);
    fs.copyFileSync(replacement, filename);
    const decoy = fs.openSync(retained, "r+");
    const actual = fs.openSync(filename, "r+");
    return { close: () => { fs.closeSync(decoy); fs.closeSync(actual); } };
  }, env), /does not match the owned file/);
  assert.deepEqual(fs.readFileSync(retained), originalBytes);
  assert.deepEqual(fs.readFileSync(replacement), replacementBytes);
  assert.deepEqual(fs.readFileSync(dbPath), replacementBytes);
});

test("the Node seeder refuses a replacement after open before mutation", (t) => {
  const { env, dbPath, parent } = fixture(t);
  const replacement = path.join(parent, "replacement.db");
  const retained = path.join(parent, "original.db");
  fs.writeFileSync(dbPath, "original synthetic database");
  fs.writeFileSync(replacement, "replacement synthetic database");
  const originalBytes = fs.readFileSync(dbPath);
  const replacementBytes = fs.readFileSync(replacement);
  const guard = openOwnedResearchDb(dbPath, (filename) => {
    const descriptor = fs.openSync(filename, "r+");
    return { close: () => fs.closeSync(descriptor) };
  }, env);
  try {
    fs.renameSync(dbPath, retained);
    fs.copyFileSync(replacement, dbPath);
    assert.throws(() => guard.verify(), /identity changed/);
  } finally {
    guard.close();
  }
  assert.deepEqual(fs.readFileSync(retained), originalBytes);
  assert.deepEqual(fs.readFileSync(replacement), replacementBytes);
  assert.deepEqual(fs.readFileSync(dbPath), replacementBytes);
});
