import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { dismissManualCapture, listManualCaptureQueue, seedExtensionManualCapture } from "../src/discovery-controls.js";
import { buildApp } from "../src/server.js";
import { initializeExactDatabase } from "./exact-schema.js";

describe("manual capture retry data", () => {
  it("derives page feedback only from the tenant and URL bound determination", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-manual-decision-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), jobUrlValidator: async () => ({ allowed: true }) });
    try {
      const url = "https://example.test/job/decision";
      const itemId = seedExtensionManualCapture(db, {
        captureId: "decision-capture", originatingUrl: url, capturedUrl: url,
        captureMode: "current_page", contentText: "synthetic content",
        futureManualActionRequired: false, captureClient: "browser_extension", extensionVersion: "1.0",
      }).itemId;
      const id = "a".repeat(64);
      const draft = { token: "owned", captured_url: url, content: "synthetic content", page_determination_id: id };
      db.prepare("UPDATE manual_capture_queue SET retry_context_json=? WHERE tenant_id='local' AND item_id=?")
        .run(JSON.stringify({ manual_capture_draft: draft, manual_capture_page_decision: "access_blocked" }), itemId);
      const envelope = { tenant_id: "local", determination_id: id, input_fingerprint: id,
        entity_id: url, kind: "page_interpretation", lane: "enrichment",
        result: { page_kind: { value: "listing" }, access_state: { value: "clear" } } };
      db.prepare(`INSERT INTO semantic_determinations
        (tenant_id,determination_id,entity_id,kind,schema_version,prompt_version,provider,model,lane,input_fingerprint,created_at,envelope_json)
        VALUES ('local',?,?,'page_interpretation','1','1','synthetic','synthetic','enrichment',?,'2026-10-28',?)`)
        .run(id, url, id, JSON.stringify(envelope));
      expect(listManualCaptureQueue(db).items[0]?.retryContext.manual_capture_page_decision).toBe("posting_unverified");
      const response = await app.inject({ method: "GET", url: "/v1/discovery/manual-capture" });
      expect(response.statusCode).toBe(200);
      expect(response.json().items[0].retryContext.manual_capture_page_decision).toBe("posting_unverified");
      envelope.result = { page_kind: { value: "posting" }, access_state: { value: "login_required" } };
      db.prepare("UPDATE semantic_determinations SET envelope_json=? WHERE tenant_id='local' AND determination_id=?")
        .run(JSON.stringify(envelope), id);
      expect(listManualCaptureQueue(db).items[0]?.retryContext.manual_capture_page_decision).toBe("access_blocked");
      envelope.entity_id = "https://example.test/job/different";
      db.prepare("UPDATE semantic_determinations SET envelope_json=? WHERE tenant_id='local' AND determination_id=?")
        .run(JSON.stringify(envelope), id);
      expect(listManualCaptureQueue(db).items[0]?.retryContext.manual_capture_page_decision).toBeUndefined();
      envelope.entity_id = url;
      envelope.tenant_id = "other";
      db.prepare("UPDATE semantic_determinations SET tenant_id='other',envelope_json=? WHERE tenant_id='local' AND determination_id=?")
        .run(JSON.stringify(envelope), id);
      expect(listManualCaptureQueue(db).items[0]?.retryContext.manual_capture_page_decision).toBeUndefined();
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exposes an unverified historical receipt without attributing a failure", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-manual-history-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    try {
      const input = { captureId: "old-capture", originatingUrl: "https://example.test/job/old",
        captureMode: "current_page" as const, capturedUrl: "https://example.test/job/old",
        contentText: "synthetic content", futureManualActionRequired: false,
        captureClient: "browser_extension" as const, extensionVersion: "1.0" };
      const itemId = seedExtensionManualCapture(db, input).itemId;
      const jobId = "40000000-0000-4000-8000-000000000045";
      db.prepare("INSERT INTO jobs (tenant_id,job_id,url) VALUES ('local',?,?)").run(jobId, input.originatingUrl);
      db.prepare(`INSERT INTO job_source_observations
        (tenant_id,source_observation_id,job_id,source_id,source_native_id,observed_url,normalized_observed_url,run_id,observed_at)
        VALUES ('local','original',?,'manual_capture:extension',?,?,?,?,?)`)
        .run(jobId, itemId, input.originatingUrl, input.originatingUrl, `manual-capture:${itemId}`, "2026-10-28");
      const originalHash = "a".repeat(64);
      const snapshot = (hash: string) => JSON.stringify({ snapshots: [{
        source_id: "manual_capture:extension", snapshot_version: 1, raw_text_hash: hash,
      }], failures: [{ source_id: "some-other-source" }] });
      db.prepare(`INSERT INTO posting_snapshot_sets
        (tenant_id,job_id,snapshot_set_json,latest_snapshot_version,latest_active_state,updated_at)
        VALUES ('local',?,?,1,'active','2026-10-28')`).run(jobId, snapshot("b".repeat(64)));
      const provenance = { source_kind: "user_mediated_capture", source_id: "manual_capture:extension",
        originating_url: input.originatingUrl, capture_mode: input.captureMode, captured_at: "2026-10-28",
        future_manual_action_required: false };
      db.prepare(`UPDATE manual_capture_queue SET status='imported',job_id=?,imported_at='2026-10-28',
        captured_url=?,capture_mode=?,content_sha256=?,content_length=?,retry_context_json=? WHERE item_id=?`)
        .run(jobId, input.capturedUrl, input.captureMode, originalHash, input.contentText.length,
          JSON.stringify({ manual_capture_provenance: provenance }), itemId);
      expect(listManualCaptureQueue(db).items[0]).toMatchObject({
        itemId, status: "imported", retryContext: { manual_capture_recovery_unverified: true },
      });
      // A matching snapshot proves the old capture and removes the review item.
      db.prepare("UPDATE posting_snapshot_sets SET snapshot_set_json=? WHERE job_id=?")
        .run(snapshot(originalHash), jobId);
      expect(listManualCaptureQueue(db).items).toHaveLength(0);
      db.prepare("UPDATE posting_snapshot_sets SET snapshot_set_json=? WHERE job_id=?")
        .run(snapshot("b".repeat(64)), jobId);
      db.prepare("UPDATE job_source_observations SET source_native_id='different' WHERE job_id=?").run(jobId);
      expect(listManualCaptureQueue(db).items).toHaveLength(0);
      db.prepare("UPDATE job_source_observations SET source_native_id=? WHERE job_id=?").run(itemId, jobId);
      expect(listManualCaptureQueue(db).items[0]).toMatchObject({
        itemId, status: "imported", retryContext: { manual_capture_recovery_unverified: true },
      });
      expect(seedExtensionManualCapture(db, input)).toEqual({ itemId, sourceId: "manual_capture:extension" });
      dismissManualCapture(db, itemId);
      expect(listManualCaptureQueue(db).items).toHaveLength(0);
      expect(seedExtensionManualCapture(db, input)).toMatchObject({ status: "dismissed" });
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("survives an extension re-seed, stays tenant-scoped and is removed on dismissal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-manual-retry-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    try {
      const input = {
        captureId: "owned-synthetic-capture", originatingUrl: "https://example.test/job/1",
        captureMode: "current_page" as const, capturedUrl: "https://example.test/job/1",
        contentText: "synthetic content", futureManualActionRequired: false,
        captureClient: "browser_extension" as const, extensionVersion: "1.0",
      };
      const seeded = seedExtensionManualCapture(db, input);
      const itemId = seeded.itemId;
      const draft = { token: "first", capture_mode: "current_page", content: "synthetic content" };
      const admission = { scheduled_us: 10, run_id: "synthetic", activity_id: "1", attempt: 1 };
      db.prepare("UPDATE manual_capture_queue SET retry_context_json=? WHERE tenant_id='local' AND item_id=?")
        .run(JSON.stringify({ manual_capture_draft: draft, manual_capture_legacy_owner: "original-owner", manual_capture_admission: admission }), itemId);
      db.prepare(`INSERT INTO manual_capture_queue
        (tenant_id,item_id,originating_url,source_id,reason,retry_context_json,required_at,status)
        VALUES ('other',?,'https://example.test/other','other','login_required',?,'2026-10-28','pending')`)
        .run(itemId, JSON.stringify({ manual_capture_draft: { content: "other tenant" } }));
      seedExtensionManualCapture(db, { ...input, originatingUrl: "https://example.test/job/changed", extensionVersion: "1.1" });
      expect(listManualCaptureQueue(db).items).toHaveLength(1);
      expect(listManualCaptureQueue(db).items[0]?.retryContext.manual_capture_draft).toEqual(draft);
      expect(listManualCaptureQueue(db).items[0]?.retryContext.manual_capture_legacy_owner).toBe("original-owner");
      expect(listManualCaptureQueue(db).items[0]?.retryContext.manual_capture_admission).toBeUndefined();
      expect(listManualCaptureQueue(db).items[0]?.originatingUrl).toBe(input.originatingUrl);
      const retained = db.prepare("SELECT retry_context_json FROM manual_capture_queue WHERE tenant_id='local' AND item_id=?")
        .get(itemId) as { retry_context_json: string };
      expect(JSON.parse(retained.retry_context_json).manual_capture_admission).toEqual(admission);
      dismissManualCapture(db, itemId);
      const rows = db.prepare("SELECT tenant_id,status,retry_context_json FROM manual_capture_queue ORDER BY tenant_id")
        .all() as Array<{ tenant_id: string; status: string; retry_context_json: string }>;
      expect(rows[0]?.status).toBe("dismissed");
      expect(JSON.parse(rows[0]!.retry_context_json).manual_capture_draft).toBeUndefined();
      expect(JSON.parse(rows[0]!.retry_context_json).manual_capture_admission).toEqual(admission);
      expect(JSON.parse(rows[0]!.retry_context_json).manual_capture_generation).toMatch(/^[a-f0-9]{32}$/);
      expect(JSON.parse(rows[1]!.retry_context_json).manual_capture_draft.content).toBe("other tenant");
      expect(listManualCaptureQueue(db).items).toHaveLength(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
