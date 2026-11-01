import { spawn } from "node:child_process";
import { once } from "node:events";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/server.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { initializeExactDatabase } from "./exact-schema.js";

const DELETED = "00000000-0000-4000-8000-0000000000a1";
const HIDDEN = "00000000-0000-4000-8000-0000000000a2";
const ACTIVE = "00000000-0000-4000-8000-0000000000a3";
const NEW = "00000000-0000-4000-8000-0000000000a4";
const DELETED_URL = "https://jobs.example.test/deleted";
const DELETED_AT = "2026-09-01T10:00:00.000Z";
const HIDDEN_AT = "2026-09-01T11:00:00.000Z";
let directory: string;
let dbPath: string;
let app: FastifyInstance;

function seed(): void {
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.prepare(`INSERT INTO resume_templates (tenant_id, template_id, display_name, status, built_in, created_at, updated_at)
    VALUES ('local','built_in:modern-html','Modern HTML','active',1,?,?)`).run(DELETED_AT, DELETED_AT);
  db.prepare(`INSERT INTO resume_template_versions (tenant_id, version_id, template_id, version_number, display_name, status, theme_json, layout_json, content_hash, created_at)
    VALUES ('local','built_in:modern-html:v1','built_in:modern-html',1,'Modern HTML','active',?,'{}','synthetic',?)`).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), DELETED_AT);
  const insert = db.prepare(`INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
    VALUES (?, ?, ?, ?, 'Synthetic', 'example', '2026-01-01T00:00:00Z')`);
  insert.run("local", DELETED, DELETED_URL, "Deleted");
  insert.run("local", HIDDEN, "https://jobs.example.test/hidden", "Hidden");
  insert.run("local", ACTIVE, "https://jobs.example.test/active", "Active");
  insert.run("foreign", DELETED, "https://jobs.example.test/foreign", "Foreign");
  db.prepare(`INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,reason,restored_at)
              VALUES ('local',?,?, 'synthetic', NULL)`).run(DELETED, DELETED_AT);
  db.prepare(`INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at,reason,unhidden_at)
              VALUES ('local',?,?, 'synthetic', NULL)`).run(HIDDEN, HIDDEN_AT);
  db.prepare(`INSERT INTO job_materials (tenant_id,job_id,generation,status,created_at,updated_at)
              VALUES ('local',?,1,'resume_approved',?,?)`).run(DELETED, DELETED_AT, DELETED_AT);
  db.prepare(`INSERT INTO job_materials_artifacts (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,created_at)
              VALUES ('local',?,1,'resume_pdf','synthetic-artifact','approved','synthetic.pdf','pdf',?)`).run(DELETED, DELETED_AT);
  db.close();
}

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-reviewed-delete-"));
  dbPath = path.join(directory, "jobctrl.db");
  seed();
  fs.writeFileSync(path.join(directory, "config.json"), "{}");
  app = buildApp({ dbPath, appDir: directory, configPath: path.join(directory, "config.json") });
});

afterEach(async () => {
  if (app) await app.close();
  vi.restoreAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

function expected(jobKey: string, deletedAt: string | null, hiddenAt: string | null) {
  return { jobKey, deletedAt, hiddenAt };
}
async function observe(): Promise<string> {
  const result = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=deleted,hidden" });
  expect(result.statusCode, result.body).toBe(200);
  expect(result.json().items.map((item: { jobKey: string }) => item.jobKey).sort()).toEqual([DELETED, HIDDEN].sort());
  return result.json().observationId as string;
}
async function preview(keys: string[], states = [expected(DELETED, DELETED_AT, null)], observationId?: string) {
  return app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
    observationId: observationId ?? await observe(),
    selections: [{ allMatching: false, jobKeys: keys }], expected: states,
  } });
}
async function commit(selectionId: string, jobKeys: string[]) {
  return app.inject({ method: "POST", url: "/v1/jobs/bulk-delete-permanent", payload: {
    allMatching: false, jobKeys, selectionId,
  } });
}
function count(table: string, tenant = "local"): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE tenant_id = ?`).get(tenant) as { n: number }).n);
  } finally { db.close(); }
}

function seedMany(count: number, removed: boolean): void {
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  const insertJob = db.prepare(`INSERT INTO jobs (tenant_id,job_id,url,title,company,site,discovered_at)
    VALUES ('local',?,?,?,'Synthetic','example','2026-01-01T00:00:00Z')`);
  const insertTombstone = db.prepare(`INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,reason,restored_at)
    VALUES ('local',?,?, 'synthetic', NULL)`);
  db.transaction(() => {
    for (let index = 0; index < count; index += 1) {
      const jobId = `00000000-0000-4000-8001-${index.toString(16).padStart(12, "0")}`;
      insertJob.run(jobId, `https://jobs.example.test/bulk/${index}`, `Synthetic ${index}`);
      if (removed) insertTombstone.run(jobId, DELETED_AT);
    }
  })();
  db.close();
}

// All data is synthetic and each test uses a uniquely owned exact-v15 workspace.
describe("reviewed permanent-delete selection", () => {
  it("keeps active-only lists readable without allocating destructive-review authority", async () => {
    const result = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=active" });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().items.map((item: { jobKey: string }) => item.jobKey)).toEqual([ACTIVE]);
    expect(result.json().observationId).toBeNull();
    expect(count("jobs")).toBe(3);
  });

  it("observes the removed list without altering user-owned jobs, tombstones, materials, or history", async () => {
    const snapshot = () => {
      const db = new Database(dbPath, { readonly: true });
      try {
        return Object.fromEntries(["jobs", "jobctrl_deleted_jobs", "jobctrl_hidden_jobs", "job_materials", "job_materials_artifacts", "job_events"].map((table) =>
          [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
      } finally { db.close(); }
    };
    const before = snapshot();
    await observe();
    expect(snapshot()).toEqual(before);
  });

  it("refuses an observation when the database path is replaced", async () => {
    const observationId = await observe();
    const replacement = path.join(directory, "replacement.db");
    initializeExactDatabase(replacement);
    fs.renameSync(dbPath, path.join(directory, "previous.db"));
    fs.renameSync(replacement, dbPath);
    const result = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observationId);
    expect(result.statusCode, result.body).toBe(409);
    const prior = new Database(path.join(directory, "previous.db"), { readonly: true });
    try { expect(prior.prepare("SELECT COUNT(*) AS n FROM jobs WHERE tenant_id = 'local'").get()).toEqual({ n: 3 }); }
    finally { prior.close(); }
  });

  it("fails closed for an observation created by a prior API instance", async () => {
    const observationId = await observe();
    await app.close();
    app = buildApp({ dbPath, appDir: directory, configPath: path.join(directory, "config.json") });
    const result = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observationId);
    expect(result.statusCode, result.body).toBe(409);
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("rejects widening to a removed job outside the observed list even if no data changed", async () => {
    const list = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=deleted" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().items.map((item: { jobKey: string }) => item.jobKey)).toEqual([DELETED]);
    const result = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId: list.json().observationId,
      selections: [{ allMatching: false, jobKeys: [HIDDEN] }],
      expected: [expected(HIDDEN, null, HIDDEN_AT)],
    } });
    expect(result.statusCode, result.body).toBe(409);
    expect(count("jobs")).toBe(3);
  });

  it("expires and consumes observed-list authority before confirmation", async () => {
    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow);
    const staleObservation = await observe();
    now.mockReturnValue(realNow + 61_000);
    const expired = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], staleObservation);
    expect(expired.statusCode, expired.body).toBe(409);
    now.mockReturnValue(realNow + 62_000);
    const observation = await observe();
    const prepared = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observation);
    expect(prepared.statusCode, prepared.body).toBe(200);
    const replay = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observation);
    expect(replay.statusCode, replay.body).toBe(409);
    expect(count("jobs")).toBe(3);
  });

  it("preserves the entire mixed cohort and owned material when a selected job was restored", async () => {
    const reviewed = await preview([DELETED, HIDDEN], [expected(DELETED, DELETED_AT, null), expected(HIDDEN, null, HIDDEN_AT)]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    const restore = await app.inject({ method: "POST", url: "/v1/jobs/bulk-restore", payload: { jobKeys: [DELETED] } });
    expect(restore.statusCode, restore.body).toBe(200);
    const result = await commit(selectionId, jobKeys);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json()).toMatchObject({ ok: false, error: "permanent_delete_selection_conflict", deletedJobKeys: [], conflictingJobKeys: [DELETED], unprocessedJobKeys: [HIDDEN] });
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
    expect(count("jobs", "foreign")).toBe(1);
    expect((await commit(selectionId, jobKeys)).statusCode).toBe(409);
  });

  it("rejects a selected hidden job changed by unhide and preserves its graph", async () => {
    const reviewed = await preview([HIDDEN], [expected(HIDDEN, null, HIDDEN_AT)]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    expect((await app.inject({ method: "POST", url: "/v1/jobs/bulk-unhide", payload: { jobKeys: [HIDDEN] } })).statusCode).toBe(200);
    const result = await commit(selectionId, jobKeys);
    expect(result.statusCode, result.body).toBe(409);
    expect(count("jobs")).toBe(3);
  });

  it("rejects stale explicit state before confirmation", async () => {
    const observationId = await observe();
    expect((await app.inject({ method: "POST", url: "/v1/jobs/bulk-restore", payload: { jobKeys: [DELETED] } })).statusCode).toBe(200);
    const result = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observationId);
    expect(result.statusCode, result.body).toBe(409);
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("allows an unchanged selection after an unrelated worker heartbeat commit", async () => {
    const observationId = await observe();
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO worker_runtime_heartbeats (worker_id, component, pid, hostname, app_dir, db_path, task_queue, started_at, last_seen_at)
                VALUES ('synthetic-worker','temporal-worker',1,'test',?,?, 'synthetic',?,?)`).run(directory, dbPath, DELETED_AT, DELETED_AT);
    db.close();
    const result = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observationId);
    expect(result.statusCode, result.body).toBe(200);
    const { selectionId, jobKeys } = result.json();
    const deleted = await commit(selectionId, jobKeys);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(count("jobs")).toBe(2);
  });

  it("rejects a tombstone ABA after the list was observed even when the bytes return to the same values", async () => {
    const observationId = await observe();
    const writer = new Database(dbPath);
    writer.transaction(() => {
      writer.prepare("UPDATE jobctrl_deleted_jobs SET restored_at = ? WHERE tenant_id = 'local' AND job_id = ?").run("2026-09-02T00:00:00Z", DELETED);
      writer.prepare("UPDATE jobctrl_deleted_jobs SET restored_at = NULL WHERE tenant_id = 'local' AND job_id = ?").run(DELETED);
    })();
    writer.close();
    const result = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observationId);
    expect(result.statusCode, result.body).toBe(409);
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("refuses to widen an all-matching cohort after the original list observation", async () => {
    const observationId = await observe();
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO jobs (tenant_id,job_id,url,title,company,site,discovered_at)
                VALUES ('local',?,'https://jobs.example.test/new','New','Synthetic','example','2026-01-01T00:00:00Z')`).run(NEW);
    db.prepare(`INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,reason,restored_at)
                VALUES ('local',?,?, 'synthetic', NULL)`).run(NEW, DELETED_AT);
    db.close();
    const result = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId, selections: [{ allMatching: true, jobKeys: [], filter: { jobStates: ["deleted", "hidden"] } }],
    } });
    expect(result.statusCode, result.body).toBe(200);
    expect(new Set(result.json().jobKeys)).toEqual(new Set([DELETED, HIDDEN]));
    const deleted = await commit(result.json().selectionId, result.json().jobKeys);
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(count("jobs")).toBe(2);
    const check = new Database(dbPath, { readonly: true });
    try { expect(check.prepare("SELECT job_id FROM jobs WHERE tenant_id = 'local' AND job_id = ?").get(NEW)).toEqual({ job_id: NEW }); }
    finally { check.close(); }
  });

  it("captures all matching removed IDs before confirmation without adding later matches", async () => {
    const observationId = await observe();
    const reviewed = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId,
      selections: [{ allMatching: true, jobKeys: [], filter: { jobStates: ["deleted", "hidden"] } }],
    } });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    expect(new Set(jobKeys)).toEqual(new Set([DELETED, HIDDEN]));
    const db = new Database(dbPath);
    db.prepare(`INSERT INTO jobs (tenant_id,job_id,url,title,company,site,discovered_at)
                VALUES ('local',?,'https://jobs.example.test/new','New','Synthetic','example','2026-01-01T00:00:00Z')`).run(NEW);
    db.prepare(`INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,reason,restored_at)
                VALUES ('local',?,?, 'synthetic', NULL)`).run(NEW, DELETED_AT);
    db.close();
    const result = await commit(selectionId, jobKeys);
    expect(result.statusCode, result.body).toBe(200);
    expect(count("jobs")).toBe(2);
    const check = new Database(dbPath, { readonly: true });
    try { expect(check.prepare("SELECT job_id FROM jobs WHERE tenant_id = 'local' AND job_id = ?").get(NEW)).toEqual({ job_id: NEW }); }
    finally { check.close(); }
  });

  it("purges a frozen unchanged removed cohort and preserves active and other-tenant data", async () => {
    const observationId = await observe();
    const reviewed = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId,
      selections: [{ allMatching: true, jobKeys: [], filter: { jobStates: ["deleted", "hidden"] } }],
    } });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    const result = await commit(selectionId, jobKeys);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ ok: true, count: 2 });
    expect(count("jobs")).toBe(1);
    expect(count("jobs", "foreign")).toBe(1);
    expect((await commit(selectionId, jobKeys)).statusCode).toBe(409);
  });

  it("resolves and deletes a reviewed cohort larger than one lifecycle query batch", async () => {
    seedMany(251, true);
    const list = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=deleted" });
    expect(list.statusCode, list.body).toBe(200);
    const reviewed = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId: list.json().observationId,
      selections: [{ allMatching: true, jobKeys: [], filter: { jobStates: ["deleted"] } }],
    } });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json().jobKeys).toHaveLength(252);
    const result = await commit(reviewed.json().selectionId, reviewed.json().jobKeys);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().count).toBe(252);
    expect(count("jobs")).toBe(2);
    expect(count("jobs", "foreign")).toBe(1);
  }, 60_000);

  it.each([5000, 5001])("handles the exact %i removed-job cohort boundary without truncation", async (size) => {
    seedMany(size - 1, true);
    const list = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=deleted" });
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().pagination.total).toBe(size);
    const newlyMatching = ["00000000-0000-4000-0000-000000000001", "00000000-0000-4000-0000-000000000002"];
    if (size === 5000) {
      const writer = new Database(dbPath);
      const job = writer.prepare(`INSERT INTO jobs (tenant_id,job_id,url,title,company,site,discovered_at)
        VALUES ('local',?,?, 'Added later','Synthetic','example','2026-01-01T00:00:00Z')`);
      const tombstone = writer.prepare(`INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,reason,restored_at)
        VALUES ('local',?,?, 'synthetic', NULL)`);
      writer.transaction(() => { for (const [index, id] of newlyMatching.entries()) {
        job.run(id, `https://jobs.example.test/new-earlier/${index}`);
        tombstone.run(id, DELETED_AT);
      } })();
      writer.close();
    }
    const reviewed = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId: list.json().observationId,
      selections: [{ allMatching: true, jobKeys: [], filter: { jobStates: ["deleted"] } }],
    } });
    if (size === 5001) {
      expect(reviewed.statusCode, reviewed.body).toBe(409);
      expect(reviewed.json().message).toMatch(/5,000/);
      expect(count("jobs")).toBe(size + 2);
      expect(count("job_materials_artifacts")).toBe(1);
    } else {
      expect(reviewed.statusCode, reviewed.body).toBe(200);
      expect(reviewed.json().jobKeys).toHaveLength(size);
      expect(reviewed.json().jobKeys).not.toContain(newlyMatching[0]);
      expect(reviewed.json().jobKeys).not.toContain(newlyMatching[1]);
      expect(count("jobs")).toBe(size + 4);
    }
    expect(count("jobs", "foreign")).toBe(1);
  }, 60_000);

  it("bounds mixed all-matching selection by removed jobs rather than 5,001 active jobs", async () => {
    seedMany(5001, false);
    const list = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=active,deleted" });
    expect(list.statusCode, list.body).toBe(200);
    const reviewed = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId: list.json().observationId,
      selections: [{ allMatching: true, jobKeys: [], filter: { jobStates: ["active", "deleted"] } }],
    } });
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    expect(reviewed.json().jobKeys).toEqual([DELETED]);
    const result = await commit(reviewed.json().selectionId, reviewed.json().jobKeys);
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json().count).toBe(1);
    expect(count("jobs")).toBe(5003);
  }, 60_000);

  it("returns exact conflicts and unprocessed members for a stale all-matching cohort", async () => {
    const observationId = await observe();
    const restore = await app.inject({ method: "POST", url: "/v1/jobs/bulk-restore", payload: { jobKeys: [DELETED] } });
    expect(restore.statusCode, restore.body).toBe(200);
    const result = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId,
      selections: [{ allMatching: true, jobKeys: [], filter: { jobStates: ["deleted", "hidden"] } }],
    } });
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json()).toMatchObject({ deletedJobKeys: [], conflictingJobKeys: [DELETED], unprocessedJobKeys: [HIDDEN] });
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("rolls back the whole cohort if the second graph purge fails", async () => {
    const reviewed = await preview([DELETED, HIDDEN], [expected(DELETED, DELETED_AT, null), expected(HIDDEN, null, HIDDEN_AT)]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    const original = Database.prototype.prepare;
    let rootDeletes = 0;
    const spy = vi.spyOn(Database.prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      if (/^DELETE FROM jobs WHERE/.test(sql) && ++rootDeletes === 2) {
        throw new Error("injected second purge failure");
      }
      return original.call(this, sql);
    });
    try {
      const result = await commit(selectionId, jobKeys);
      expect(result.statusCode, result.body).toBe(500);
      expect(rootDeletes).toBe(2);
    } finally { spy.mockRestore(); }
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
    expect(count("jobs", "foreign")).toBe(1);
    expect((await commit(selectionId, jobKeys)).statusCode).toBe(409);
  });

  it("rejects aliases in guarded selection but retains the unguarded alias contract", async () => {
    const reviewed = await preview([DELETED_URL], [expected(DELETED_URL, DELETED_AT, null)]);
    expect(reviewed.statusCode, reviewed.body).toBe(409);
    expect(count("job_materials_artifacts")).toBe(1);
    const legacy = await app.inject({ method: "POST", url: "/v1/jobs/bulk-delete-permanent", payload: {
      allMatching: false, jobKeys: [DELETED_URL],
    } });
    expect(legacy.statusCode, legacy.body).toBe(200);
    expect(legacy.json()).toMatchObject({ count: 1, jobKeys: [DELETED] });
  });

  it("rejects altered scope, unknown or reused receipt IDs without mutation", async () => {
    const reviewed = await preview([DELETED]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId } = reviewed.json();
    const result = await commit(selectionId, [DELETED, ACTIVE]);
    expect(result.statusCode, result.body).toBe(409);
    expect(count("jobs")).toBe(3);
    expect((await commit(selectionId, [DELETED])).statusCode).toBe(409);
    expect((await commit("00000000-0000-4000-8000-0000000000aa", [DELETED])).statusCode).toBe(409);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("checks the reviewed state after an independently held writer finishes", async () => {
    const reviewed = await preview([DELETED]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    const sqlitePath = createRequire(import.meta.url).resolve("better-sqlite3");
    const program = `const Database = require(process.argv[1]);
      const db = new Database(process.argv[2]);
      db.pragma('busy_timeout=5000');
      db.exec('BEGIN IMMEDIATE');
      db.prepare("UPDATE jobctrl_deleted_jobs SET restored_at = ? WHERE tenant_id = 'local' AND job_id = ?")
        .run('2026-09-02T00:00:00Z', process.argv[3]);
      process.stdout.write('locked\\n');
      setTimeout(() => { db.exec('COMMIT'); db.close(); }, 300);`;
    const child = spawn(process.execPath, ["-e", program, sqlitePath, dbPath, DELETED], { stdio: ["ignore", "pipe", "pipe"] });
    const exit = once(child, "exit");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const [chunk] = await Promise.race([
        once(child.stdout, "data"),
        exit.then(([code]) => { throw new Error(`writer exited before acquiring lock: ${code}`); }),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("writer did not acquire lock")), 2000);
        }),
      ]);
      if (timeout) clearTimeout(timeout);
      expect(String(chunk)).toContain("locked");
      const result = await commit(selectionId, jobKeys);
      expect(result.statusCode, result.body).toBe(409);
      const [code] = await exit;
      expect(code).toBe(0);
      expect(count("jobs")).toBe(3);
      expect(count("job_materials_artifacts")).toBe(1);
    } finally {
      if (timeout) clearTimeout(timeout);
      if (child.exitCode === null) child.kill();
    }
  });

  it("compares lifecycle revisions without losing precision above the JavaScript safe integer limit", async () => {
    const db = new Database(dbPath);
    db.exec("UPDATE job_lifecycle_clock SET revision = 9007199254740991 WHERE singleton = 1");
    db.prepare("UPDATE jobctrl_deleted_jobs SET reason = ? WHERE tenant_id = 'local' AND job_id = ?").run("before", DELETED);
    db.close();
    const observationId = await observe();
    const writer = new Database(dbPath);
    writer.prepare("UPDATE jobctrl_deleted_jobs SET reason = ? WHERE tenant_id = 'local' AND job_id = ?").run("after", DELETED);
    writer.close();
    const result = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observationId);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json()).toMatchObject({ conflictingJobKeys: [DELETED], deletedJobKeys: [] });
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("refuses a missing lifecycle revision rather than admitting an unversioned job", async () => {
    const observationId = await observe();
    const db = new Database(dbPath);
    db.prepare("DELETE FROM job_lifecycle_revisions WHERE tenant_id = 'local' AND job_id = ?").run(DELETED);
    db.close();
    const result = await preview([DELETED], [expected(DELETED, DELETED_AT, null)], observationId);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json()).toMatchObject({ conflictingJobKeys: [DELETED], deletedJobKeys: [] });
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("refuses delete and recreation of the same job ID while its tombstone survives", async () => {
    const reviewed = await preview([DELETED]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    const writer = new Database(dbPath);
    writer.pragma("foreign_keys = OFF");
    writer.transaction(() => {
      writer.prepare("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?").run(DELETED);
      writer.prepare(`INSERT INTO jobs (tenant_id,job_id,url,title,company,site,discovered_at)
        VALUES ('local',?,?, 'Replacement','Synthetic','example','2026-01-01T00:00:00Z')`).run(DELETED, DELETED_URL);
    })();
    writer.close();
    const result = await commit(selectionId, jobKeys);
    expect(result.statusCode, result.body).toBe(409);
    expect(result.json()).toMatchObject({ conflictingJobKeys: [DELETED], deletedJobKeys: [] });
    const check = new Database(dbPath, { readonly: true });
    try { expect(check.prepare("SELECT title FROM jobs WHERE tenant_id = 'local' AND job_id = ?").get(DELETED)).toEqual({ title: "Replacement" }); }
    finally { check.close(); }
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("rejects ABA even when the tombstone returns to identical bytes without a lifecycle event", async () => {
    const reviewed = await preview([DELETED]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    const writer = new Database(dbPath);
    writer.transaction(() => {
      writer.prepare("UPDATE jobctrl_deleted_jobs SET restored_at = ? WHERE tenant_id = 'local' AND job_id = ?").run("2026-09-02T00:00:00Z", DELETED);
      writer.prepare("UPDATE jobctrl_deleted_jobs SET restored_at = NULL WHERE tenant_id = 'local' AND job_id = ?").run(DELETED);
    })();
    writer.close();
    const result = await commit(selectionId, jobKeys);
    expect(result.statusCode, result.body).toBe(409);
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("does not accept a foreign-only locator or incomplete explicit expectations", async () => {
    const foreign = await preview(["https://jobs.example.test/foreign"], [expected("https://jobs.example.test/foreign", DELETED_AT, null)]);
    expect(foreign.statusCode, foreign.body).toBe(409);
    const incomplete = await preview([DELETED, HIDDEN], [expected(DELETED, DELETED_AT, null)]);
    expect([400, 409]).toContain(incomplete.statusCode);
    expect(count("jobs")).toBe(3);
    expect(count("jobs", "foreign")).toBe(1);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("expires a review rather than accepting it after the confirmation deadline", async () => {
    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow);
    const reviewed = await preview([DELETED]);
    expect(reviewed.statusCode, reviewed.body).toBe(200);
    const { selectionId, jobKeys } = reviewed.json();
    now.mockReturnValue(realNow + 61_000);
    const result = await commit(selectionId, jobKeys);
    expect(result.statusCode, result.body).toBe(409);
    expect(count("jobs")).toBe(3);
    expect(count("job_materials_artifacts")).toBe(1);
  });

  it("bounds pending review resources and releases expired receipts", async () => {
    const realNow = Date.now();
    const now = vi.spyOn(Date, "now").mockReturnValue(realNow);
    for (let index = 0; index < 64; index += 1) {
      const response = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=deleted,hidden" });
      expect(response.statusCode, response.body).toBe(200);
    }
    const overCapacity = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=deleted,hidden" });
    expect(overCapacity.statusCode, overCapacity.body).toBe(200);
    expect(overCapacity.json().observationId).toBeNull();
    expect(overCapacity.json().items.length).toBe(2);
    const unavailable = await app.inject({ method: "POST", url: "/v1/jobs/permanent-delete-selection", payload: {
      observationId: overCapacity.json().observationId,
      selections: [{ allMatching: false, jobKeys: [DELETED] }],
      expected: [expected(DELETED, DELETED_AT, null)],
    } });
    expect(unavailable.statusCode).toBe(400);
    now.mockReturnValue(realNow + 61_000);
    const afterExpiry = await app.inject({ method: "GET", url: "/v1/jobs/reviewable-list?jobStates=deleted,hidden" });
    expect(afterExpiry.statusCode, afterExpiry.body).toBe(200);
    expect(afterExpiry.json().observationId).toEqual(expect.any(String));
    expect(count("jobs")).toBe(3);
  });

  it("retains the existing explicitly authorized unrestricted permanent-delete path", async () => {
    const result = await app.inject({ method: "POST", url: "/v1/jobs/bulk-delete-permanent", payload: { allMatching: false, jobKeys: [ACTIVE] } });
    expect(result.statusCode, result.body).toBe(200);
    expect(result.json()).toMatchObject({ count: 1, jobKeys: [ACTIVE] });
    expect(count("jobs")).toBe(2);
    expect(count("jobs", "foreign")).toBe(1);
  });
});
