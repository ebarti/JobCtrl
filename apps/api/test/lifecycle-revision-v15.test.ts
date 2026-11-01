import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { openDatabase } from "../src/db.js";
import { initializeExactDatabase } from "./exact-schema.js";

const ID = "00000000-0000-4000-8000-000000001280";
const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-01T00:00:00.001Z";
const cleanups: Array<() => void> = [];

afterEach(() => { while (cleanups.length) cleanups.pop()?.(); });

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-lifecycle-v15-"));
  const dbPath = path.join(dir, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const first = openDatabase(dbPath);
  const second = openDatabase(dbPath);
  cleanups.push(() => { first.close(); second.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { first, second };
}

function insertJob(db: Database.Database, tenant: string, jobId: string, suffix: string) {
  db.prepare(`INSERT INTO jobs (tenant_id,job_id,url,title,company,discovered_at)
    VALUES (?, ?, ?, 'Synthetic job', 'Example', ?)`).run(tenant, jobId, `https://example.test/${suffix}`, AT);
}

function revision(db: Database.Database, tenant = "local", jobId = ID): number | null {
  const row = db.prepare("SELECT revision FROM job_lifecycle_revisions WHERE tenant_id = ? AND job_id = ?")
    .get(tenant, jobId) as { revision: number } | undefined;
  return row?.revision ?? null;
}

describe("exact-v15 lifecycle revision authority", () => {
  it("records same-byte delete/restore/delete and hide/unhide/hide across independent writers", () => {
    const { first, second } = fixture();
    insertJob(first, "local", ID, "local");
    const initial = revision(first)!;
    second.prepare("INSERT INTO jobctrl_deleted_jobs (tenant_id,job_id,deleted_at,restored_at) VALUES ('local',?,?,NULL)").run(ID, AT);
    const deleted = revision(first)!;
    second.prepare("UPDATE jobctrl_deleted_jobs SET restored_at=? WHERE tenant_id='local' AND job_id=?").run(LATER, ID);
    const restored = revision(first)!;
    second.prepare("UPDATE jobctrl_deleted_jobs SET restored_at=NULL WHERE tenant_id='local' AND job_id=?").run(ID);
    const deletedAgain = revision(first)!;
    second.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at,unhidden_at) VALUES ('local',?,?,NULL)").run(ID, AT);
    const hidden = revision(first)!;
    second.prepare("UPDATE jobctrl_hidden_jobs SET unhidden_at=? WHERE tenant_id='local' AND job_id=?").run(AT, ID);
    const unhidden = revision(first)!;
    second.prepare("UPDATE jobctrl_hidden_jobs SET unhidden_at=NULL WHERE tenant_id='local' AND job_id=?").run(ID);
    const hiddenAgain = revision(first)!;
    expect([deleted, restored, deletedAgain, hidden, unhidden, hiddenAgain]).toEqual(
      [...new Set([deleted, restored, deletedAgain, hidden, unhidden, hiddenAgain])].sort((a, b) => a - b),
    );
    expect(deleted).toBeGreaterThan(initial);
    expect(first.prepare("SELECT COUNT(*) AS count FROM job_events WHERE job_id=?").get(ID)).toEqual({ count: 0 });
  });

  it("does not invalidate a job for independent heartbeat or another tenant's lifecycle changes", () => {
    const { first, second } = fixture();
    insertJob(first, "local", ID, "local");
    insertJob(first, "other", ID, "other");
    const before = revision(first)!;
    second.prepare(`INSERT INTO worker_runtime_heartbeats
      (worker_id,component,pid,hostname,app_dir,db_path,task_queue,started_at,last_seen_at)
      VALUES ('synthetic','worker',1,'fixture','/fixture','/fixture/db','fixture',?,?)`).run(AT, AT);
    second.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('other',?,?)").run(ID, AT);
    expect(revision(first)).toBe(before);
    expect(revision(first, "other")).toBeGreaterThan(before);
  });

  it("rolls back revisions with the lifecycle write and never reuses a token after a job is deleted and recreated", () => {
    const { first, second } = fixture();
    insertJob(first, "local", ID, "local");
    const initial = revision(first)!;
    expect(() => second.transaction(() => {
      second.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('local',?,?)").run(ID, AT);
      throw new Error("synthetic failure");
    })()).toThrow("synthetic failure");
    expect(revision(first)).toBe(initial);
    second.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('local',?,?)").run(ID, AT);
    const beforeDelete = revision(first)!;
    second.prepare("DELETE FROM jobs WHERE tenant_id='local' AND job_id=?").run(ID);
    expect(revision(first)).toBeNull();
    insertJob(second, "local", ID, "local-recreated");
    const recreated = revision(first)!;
    expect(recreated).toBeGreaterThan(beforeDelete);
    second.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('local',?,?)").run(ID, AT);
    expect(revision(first)).toBeGreaterThan(recreated);
  });
});
