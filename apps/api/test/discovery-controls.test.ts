import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { buildApp } from "../src/server.js";

function withTempDb(): { dbPath: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-discovery-controls-"));
  const dbPath = path.join(dir, "jobs.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      site TEXT,
      strategy TEXT,
      location TEXT,
      salary TEXT,
      discovered_at TEXT,
      application_url TEXT,
      description TEXT,
      full_description TEXT,
      detail_scraped_at TEXT,
      detail_error TEXT,
      fit_score INTEGER,
      score_reasoning TEXT,
      scored_at TEXT,
      tailored_resume_path TEXT,
      tailored_at TEXT,
      tailor_attempts INTEGER DEFAULT 0,
      cover_letter_path TEXT,
      cover_letter_at TEXT,
      cover_attempts INTEGER DEFAULT 0,
      applied_at TEXT,
      apply_status TEXT,
      apply_error TEXT
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL DEFAULT '',
      level TEXT,
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    );
  `);
  db.close();
  return {
    dbPath,
    dir,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function options(dbPath: string, dir: string) {
  return {
    dbPath,
    profilePath: path.join(dir, "profile.json"),
    resumeStylePath: path.join(dir, "resume_style.json"),
    resumeTemplatePath: path.join(dir, "resume_template.tex"),
    settingsPath: path.join(dir, "dashboard.json"),
  };
}

describe("discovery product controls API", () => {
  it("upserts source registry entries and emits source registry events", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/sources",
        payload: {
          sourceId: "greenhouse-example",
          kind: "ats_api",
          displayName: "Greenhouse Example",
          priority: "canonical",
          state: "experimental",
          seedUrl: "https://example.com/careers",
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().source).toMatchObject({
        sourceId: "greenhouse-example",
        displayName: "Greenhouse Example",
        state: "experimental",
      });

      const list = await app.inject({ method: "GET", url: "/v1/discovery/sources" });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().sources).toHaveLength(1);

      const db = new Database(dbPath);
      const event = db
        .prepare("SELECT event_type, payload_json FROM job_events ORDER BY event_id DESC LIMIT 1")
        .get() as { event_type: string; payload_json: string };
      db.close();
      expect(event.event_type).toBe("SourceRegistryEntryCreated");
      expect(JSON.parse(event.payload_json)).toMatchObject({
        sourceId: "greenhouse-example",
        kind: "ats_api",
        state: "experimental",
      });
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("records discovery feedback without copying the free-form note into domain events", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/feedback",
        payload: {
          jobKey: "https://example.com/jobs/stale",
          sourceId: "greenhouse-example",
          kind: "bad_source",
          note: "private reviewer note",
        },
      });
      expect(response.statusCode, response.body).toBe(200);

      const dashboard = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(dashboard.statusCode, dashboard.body).toBe(200);
      expect(dashboard.json().sourceHealth[0]).toMatchObject({
        sourceId: "greenhouse-example",
        observedJobs: 1,
        lastErrorClass: "user_bad_source",
      });

      const db = new Database(dbPath);
      const event = db
        .prepare("SELECT payload_json FROM job_events WHERE event_type = 'DiscoveryFeedbackRecorded'")
        .get() as { payload_json: string };
      db.close();
      const payload = JSON.parse(event.payload_json);
      expect(payload).toMatchObject({
        jobId: "https://example.com/jobs/stale",
        sourceId: "greenhouse-example",
        kind: "bad_source",
      });
      expect(JSON.stringify(payload)).not.toContain("private reviewer note");
    } finally {
      await app.close();
      cleanup();
    }
  });

  it("imports manual capture provenance while storing only content metadata", async () => {
    const { dbPath, dir, cleanup } = withTempDb();
    const app = buildApp(options(dbPath, dir));
    try {
      await app.inject({ method: "GET", url: "/v1/discovery/manual-capture" });
      const db = new Database(dbPath);
      db.prepare(
        `INSERT INTO manual_capture_queue (
           tenant_id, item_id, originating_url, source_id, reason,
           retry_context_json, required_at, status
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "manual-1",
        "https://example.com/protected/job",
        "greenhouse-example",
        "login_required",
        "{}",
        "2026-05-12T10:00:00+00:00",
        "pending",
      );
      db.close();

      const response = await app.inject({
        method: "POST",
        url: "/v1/discovery/manual-capture/manual-1/import",
        payload: {
          captureMode: "pasted_text",
          capturedUrl: "https://example.com/protected/job",
          contentText: "Visible user-provided posting text.",
          futureManualActionRequired: true,
        },
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toMatchObject({
        itemId: "manual-1",
        jobKey: "https://example.com/protected/job",
        provenance: {
          sourceKind: "user_mediated_capture",
          captureMode: "pasted_text",
          futureManualActionRequired: true,
        },
      });

      const verifyDb = new Database(dbPath);
      const row = verifyDb
        .prepare(
          "SELECT status, content_sha256, content_length, captured_url FROM manual_capture_queue WHERE item_id = ?",
        )
        .get("manual-1") as {
        status: string;
        content_sha256: string;
        content_length: number;
        captured_url: string;
      };
      verifyDb.close();
      expect(row.status).toBe("imported");
      expect(row.content_sha256).toHaveLength(64);
      expect(row.content_length).toBe("Visible user-provided posting text.".length);
      expect(JSON.stringify(row)).not.toContain("Visible user-provided posting text.");
    } finally {
      await app.close();
      cleanup();
    }
  });
});
