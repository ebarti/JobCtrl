import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it, vi } from "vitest";

import { acknowledgeDigest, buildDigest, readDigestState } from "../src/read-model.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

function workspace() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-digest-authority-"));
  const dbPath = path.join(root, "jobctrl.db");
  initializeExactDatabase(dbPath);
  const db = new Database(dbPath);
  return { root, dbPath, db, cleanup: () => { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

function jobId(n: number): string {
  return `94000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

function seedJob(db: Database.Database, tenant: string, n: number, discovered: string, score: number | null): string {
  const id = jobId(n);
  db.prepare("INSERT INTO jobs (tenant_id,job_id,url,title,company,discovered_at) VALUES (?,?,?,'Synthetic','Example',?)")
    .run(tenant, id, `https://${tenant}.example.test/jobs/${n}`, discovered);
  if (score !== null) {
    db.prepare("INSERT INTO job_list_projections (tenant_id,job_id,discovered_at,scored_at,fit_score) VALUES (?,?,?,?,?)")
      .run(tenant, id, discovered, discovered, score);
  }
  return id;
}

function outcome(db: Database.Database, id: string, key: string, kind: string, when: string): void {
  db.prepare("INSERT INTO application_outcomes (tenant_id,outcome_id,job_id,kind,source,occurred_at,recorded_at) VALUES ('local',?,?,?,'manual',?,?)")
    .run(key, id, kind, when, when);
}

describe("digest canonical ownership and acknowledgement", () => {
  it("counts a corrected score while its stale marker remains unresolved", async () => {
    const s = workspace();
    const when = "2020-05-01T00:00:00Z";
    const stale = seedJob(s.db, "local", 1, when, 8);
    const hidden = seedJob(s.db, "local", 2, when, 7);
    for (const id of [stale, hidden]) {
      s.db.prepare("INSERT INTO job_scores (tenant_id,job_id,version,fit_score,breakdown_json,keywords_json,scored_at,correction_json,criteria_json,trace_json) VALUES ('local',?,1,8,'{}','[]',?,'{}','{}','{}')").run(id, when);
      s.db.prepare("INSERT INTO job_score_staleness (tenant_id,job_id,stale_reason,old_policy_version,new_policy_version,marked_at,resolved) VALUES ('local',?,'scoring_policy_changed',1,2,?,0)").run(id, when);
    }
    s.db.prepare("INSERT INTO jobctrl_hidden_jobs (tenant_id,job_id,hidden_at) VALUES ('local',?,?)").run(hidden, when);
    const app = buildApp({ dbPath: s.dbPath, configPath: path.join(s.root, "config.json"), appDir: s.root });
    try {
      const digest = await app.inject({ method: "GET", url: "/v1/digest" });
      const summary = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(digest.statusCode, digest.body).toBe(200);
      expect(summary.statusCode, summary.body).toBe(200);
      expect(digest.json().staleScores.count).toBe(1);
      expect(summary.json().preparation.outdatedScoreCount).toBe(1);
    } finally {
      await app.close();
      s.cleanup();
    }
  });

  it("excludes a foreign-only job from actual API match and follow-up counts", async () => {
    const s = workspace();
    const id = seedJob(s.db, "other", 1, "2020-01-01T00:00:00Z", null);
    s.db.prepare("INSERT INTO job_list_projections (tenant_id,job_id,discovered_at,fit_score) VALUES ('local',?,'2020-01-01T00:00:00Z',9)").run(id);
    s.db.pragma("foreign_keys = OFF");
    outcome(s.db, id, "foreign-orphan", "applied_confirmation", "2020-01-01T00:00:00Z");
    const app = buildApp({ dbPath: s.dbPath, configPath: path.join(s.root, "config.json"), appDir: s.root });
    try {
      const response = await app.inject({ method: "GET", url: "/v1/digest" });
      expect(response.statusCode).toBe(200);
      expect(response.json().newMatches).toEqual({ count: 0, highFitCount: 0 });
      expect(response.json().followUpsDue.count).toBe(0);
      expect(response.json().staleScores.count).toBe(0);
      expect(response.json().pendingApprovals.count).toBe(0);
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM job_list_projections WHERE tenant_id='local' AND job_id=?").get(id)).toEqual({ n: 1 });
    } finally {
      await app.close();
      s.cleanup();
    }
  });

  it("compares matches and follow-ups by instant at millisecond precision", async () => {
    const s = workspace();
    const since = "2020-05-01T10:00:00.500Z";
    s.db.prepare(`INSERT INTO resume_templates
      (tenant_id, template_id, display_name, status, built_in, created_at, updated_at)
      VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, ?, ?)`).run(since, since);
    s.db.prepare(`INSERT INTO resume_template_versions
      (tenant_id, version_id, template_id, version_number, display_name, status, theme_json, layout_json, content_hash, created_at)
      VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1, 'Modern HTML', 'active', ?, '{}', 'synthetic', ?)`).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), since);
    s.db.prepare("INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)").run(since, since);
    seedJob(s.db, "local", 1, "2020-05-01T09:30:00-02:00", 9);
    seedJob(s.db, "local", 2, "2020-05-01T11:00:00+02:00", 6);
    seedJob(s.db, "local", 3, "2020-05-01T10:00:00.5+00:00", 7);
    seedJob(s.db, "local", 4, "2020-05-01T10:00:00.4999Z", 9);
    const due = seedJob(s.db, "local", 5, "2020-04-01T00:00:00Z", null);
    const notDue = seedJob(s.db, "local", 6, "2020-04-01T00:00:00Z", null);
    const priorReply = seedJob(s.db, "local", 7, "2020-04-01T00:00:00Z", null);
    const stopped = seedJob(s.db, "local", 8, "2020-04-01T00:00:00Z", null);
    outcome(s.db, due, "due", "applied_confirmation", "2020-05-01T11:00:00+02:00");
    outcome(s.db, notDue, "not-due", "applied_confirmation", "2020-05-01T09:30:00-02:00");
    outcome(s.db, priorReply, "prior-apply", "applied_confirmation", "2020-05-01T08:00:00.5-02:00");
    outcome(s.db, priorReply, "prior-reply", "recruiter_reply", "2020-05-01T10:30:00+02:00");
    outcome(s.db, stopped, "stopped-apply", "applied_confirmation", "2020-04-01T00:00:00Z");
    outcome(s.db, stopped, "stopped-reply", "recruiter_reply", "2020-04-02T00:00:00Z");
    const app = buildApp({ dbPath: s.dbPath, configPath: path.join(s.root, "config.json"), appDir: s.root });
    try {
      const digest = buildDigest(s.db, { now: new Date("2020-05-08T10:00:00.500Z"), minFitScore: 7 });
      expect(digest.newMatches).toEqual({ count: 2, highFitCount: 2 });
      expect(digest.followUpsDue.count).toBe(2);
      const response = await app.inject({ method: "GET", url: "/v1/digest" });
      expect(response.statusCode).toBe(200);
      expect(response.json().newMatches).toEqual({ count: 2, highFitCount: 2 });
      const jobsResponse = await app.inject({
        method: "GET",
        url: `/v1/jobs?deleted=active&discoveredSince=${encodeURIComponent(since)}&scoredSince=${encodeURIComponent(since)}`,
      });
      expect(jobsResponse.statusCode, jobsResponse.body).toBe(200);
      const items = jobsResponse.json().items as Array<{ jobKey: string }>;
      expect(items.map((job) => job.jobKey).sort()).toEqual([jobId(1), jobId(3)]);
      expect(readDigestState(s.db).lastAcknowledgedAt).toBe(since);
    } finally {
      await app.close();
      s.cleanup();
    }
  });

  it("rolls back a failed review event without losing caller-owned work", () => {
    const s = workspace();
    const since = "2020-05-01T00:00:00Z";
    s.db.prepare("INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)").run(since, since);
    s.db.exec("CREATE TEMP TRIGGER deny_digest_event BEFORE INSERT ON job_events WHEN NEW.event_type='DigestReviewed' BEGIN SELECT RAISE(ABORT, 'synthetic event failure'); END");
    try {
      s.db.transaction(() => {
        s.db.prepare("INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('other',?,?)").run(since, since);
        expect(() => acknowledgeDigest(s.db, { acknowledgedAt: "2020-05-10T00:00:00Z", now: new Date("2020-05-20T00:00:00Z") })).toThrow("synthetic event failure");
        expect(readDigestState(s.db).lastAcknowledgedAt).toBe(since);
      })();
      expect(readDigestState(s.db).lastAcknowledgedAt).toBe(since);
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM digest_state WHERE tenant_id='other'").get()).toEqual({ n: 1 });
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='DigestReviewed'").get()).toEqual({ n: 0 });
    } finally {
      s.cleanup();
    }
  });

  it("does not advance the watermark when the real API event write fails", async () => {
    const s = workspace();
    const since = "2020-05-01T00:00:00Z";
    s.db.prepare("INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)").run(since, since);
    const app = buildApp({ dbPath: s.dbPath, configPath: path.join(s.root, "config.json"), appDir: s.root });
    const prototype = Object.getPrototypeOf(s.db) as { prepare: Database.Database["prepare"] };
    const original = prototype.prepare;
    const spy = vi.spyOn(prototype, "prepare").mockImplementation(function (this: Database.Database, sql: string) {
      if (sql.includes("INSERT INTO job_events") && sql.includes("DigestReviewed")) throw new Error("synthetic event failure");
      return original.call(this, sql);
    });
    try {
      const response = await app.inject({ method: "POST", url: "/v1/digest/acknowledge", payload: { acknowledgedAt: "2020-05-10T00:00:00Z" } });
      expect(response.statusCode).toBeGreaterThanOrEqual(400);
      expect(readDigestState(s.db).lastAcknowledgedAt).toBe(since);
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='DigestReviewed'").get()).toEqual({ n: 0 });
    } finally {
      spy.mockRestore();
      await app.close();
      s.cleanup();
    }
  });

  it("preserves a more precise prior instant and bounds future acknowledgements", () => {
    const s = workspace();
    const previous = "2020-05-10T00:00:00.500000123Z";
    const now = new Date("2020-05-20T00:00:00Z");
    s.db.prepare("INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)").run(previous, previous);
    try {
      expect(acknowledgeDigest(s.db, { acknowledgedAt: "2020-05-10T01:00:00.500000122+01:00", now }).state.lastAcknowledgedAt).toBe(previous);
      const localPrevious = "2020-05-10T00:00:00.500000123";
      s.db.prepare("UPDATE digest_state SET last_acknowledged_at=? WHERE tenant_id='local'").run(localPrevious);
      expect(acknowledgeDigest(s.db, { acknowledgedAt: "2020-05-10T00:00:00.500000122", now }).state.lastAcknowledgedAt).toBe(localPrevious);
      expect(acknowledgeDigest(s.db, { acknowledgedAt: "2020-05-20T00:00:00.000000001Z", now }).state.lastAcknowledgedAt).toBe(now.toISOString());
      s.db.prepare("UPDATE digest_state SET last_acknowledged_at='invalid' WHERE tenant_id='local'").run();
      expect(() => acknowledgeDigest(s.db, { now })).toThrow("digest watermark is not a valid timestamp");
      expect(readDigestState(s.db).lastAcknowledgedAt).toBe("invalid");
    } finally {
      s.cleanup();
    }
  });

  it("leaves a successful nested acknowledgement under caller control", () => {
    const s = workspace();
    const since = "2020-05-01T00:00:00Z";
    s.db.prepare("INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('local',?,?)").run(since, since);
    try {
      s.db.exec("BEGIN IMMEDIATE");
      s.db.prepare("INSERT INTO digest_state (tenant_id,last_acknowledged_at,updated_at) VALUES ('other',?,?)").run(since, since);
      acknowledgeDigest(s.db, { acknowledgedAt: "2020-05-10T00:00:00Z", now: new Date("2020-05-20T00:00:00Z") });
      expect(s.db.inTransaction).toBe(true);
      const observer = new Database(s.dbPath, { readonly: true });
      try {
        expect(readDigestState(observer).lastAcknowledgedAt).toBe(since);
      } finally { observer.close(); }
      s.db.exec("ROLLBACK");
      expect(readDigestState(s.db).lastAcknowledgedAt).toBe(since);
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM digest_state WHERE tenant_id='other'").get()).toEqual({ n: 0 });
      expect(s.db.prepare("SELECT COUNT(*) AS n FROM job_events WHERE event_type='DigestReviewed'").get()).toEqual({ n: 0 });
    } finally {
      if (s.db.inTransaction) s.db.exec("ROLLBACK");
      s.cleanup();
    }
  });

  it("serializes separate callers and keeps the newer acknowledgement after a lost-response retry", async () => {
    const s = workspace();
    const newer = "2020-05-10T00:00:00Z";
    const older = "2020-05-01T00:00:00Z";
    const now = "2020-05-20T00:00:00Z";
    s.db.pragma("busy_timeout = 5000");
    s.db.exec("BEGIN IMMEDIATE");
    acknowledgeDigest(s.db, { acknowledgedAt: newer, now: new Date(now) });
    const child = spawn(process.execPath, [
      "--import", "tsx", fileURLToPath(new URL("./digest-ack-worker.ts", import.meta.url)), s.dbPath, older, now,
    ], { cwd: path.resolve(fileURLToPath(new URL("..", import.meta.url))), env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let errors = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { errors += chunk; });
    const childDone = new Promise<number | null>((resolve, reject) => {
      child.once("close", resolve);
      child.once("error", reject);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("acknowledgement worker did not start")), 5000);
        const onData = () => {
          if (output.includes("READY\n")) { clearTimeout(timer); child.stdout.off("data", onData); resolve(); }
        };
        child.stdout.on("data", onData);
        child.once("error", reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(child.exitCode).toBeNull();
      expect(output.trim()).toBe("READY");
      s.db.exec("COMMIT");
      const code = await childDone;
      expect(code, errors).toBe(0);
      const result = JSON.parse(output.trim().split("\n")[1]!);
      expect(result.state.lastAcknowledgedAt).toBe(newer);
      expect(readDigestState(s.db).lastAcknowledgedAt).toBe(newer);
      const retry = acknowledgeDigest(s.db, { acknowledgedAt: older, now: new Date(now) });
      expect(retry.state.lastAcknowledgedAt).toBe(newer);
      const events = s.db.prepare("SELECT payload_json FROM job_events WHERE event_type='DigestReviewed' ORDER BY event_id").all() as Array<{payload_json: string}>;
      expect(events.map((event) => JSON.parse(event.payload_json).acknowledgedAt)).toEqual([newer, newer, newer]);
    } finally {
      if (s.db.inTransaction) s.db.exec("ROLLBACK");
      if (child.exitCode === null && child.signalCode === null) child.kill();
      await childDone.catch(() => undefined);
      s.cleanup();
    }
  });
});
