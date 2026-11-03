import { describe, expect, it, vi } from "vitest";
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

  it("exposes an unverified historical receipt and refuses recovery after its snapshot is accepted", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-manual-history-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), jobUrlValidator: async () => ({ allowed: true }) });
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
      const reviewed = listManualCaptureQueue(db).items[0]!.lifecycleId;
      // A matching snapshot proves the old capture and removes the review item.
      db.prepare("UPDATE posting_snapshot_sets SET snapshot_set_json=? WHERE job_id=?")
        .run(snapshot(originalHash), jobId);
      expect(listManualCaptureQueue(db).items).toHaveLength(0);
      const acceptedBefore = db.prepare("SELECT * FROM manual_capture_queue WHERE item_id=?").get(itemId);
      const snapshotBefore = db.prepare("SELECT * FROM posting_snapshot_sets WHERE job_id=?").get(jobId);
      const lateRecovery = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/supersede`,
        payload: { expectedLifecycleId: reviewed } });
      expect(lateRecovery.statusCode).toBe(409);
      expect(db.prepare("SELECT * FROM manual_capture_queue WHERE item_id=?").get(itemId)).toEqual(acceptedBefore);
      expect(db.prepare("SELECT * FROM posting_snapshot_sets WHERE job_id=?").get(jobId)).toEqual(snapshotBefore);
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
      await app.close();
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

  it("keeps historical recovery in one review lifetime and rejects stale cross-client writes", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-manual-lifetime-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const imported: Array<{ generation: string | null | undefined }> = [];
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"), jobUrlValidator: async () => ({ allowed: true }),
      manualCaptureImporter: async (itemId, input, context) => {
        imported.push({ generation: context.expectedCaptureGeneration });
        return { ok: true, itemId, jobKey: "synthetic", importedAt: "2026-10-28", provenance: {
          sourceKind: "user_mediated_capture", originatingUrl: "https://example.test/job/lifetime",
          captureMode: input.captureMode, futureManualActionRequired: input.futureManualActionRequired,
        } };
      } });
    try {
      const itemId = "manual-lifetime";
      db.prepare(`INSERT INTO manual_capture_queue
        (tenant_id,item_id,originating_url,source_id,reason,retry_context_json,required_at,status)
        VALUES ('local',?,'https://example.test/job/lifetime','manual:test','login_required',?,'2026-10-28','pending')`)
        .run(itemId, JSON.stringify({ manual_capture_generation: "old-generation", manual_capture_draft: { content: "old" } }));
      const original = listManualCaptureQueue(db).items[0]!.lifecycleId!;
      db.prepare("UPDATE manual_capture_queue SET retry_context_json=? WHERE item_id=?")
        .run(JSON.stringify({ manual_capture_generation: "recovery-generation", manual_capture_reopen_authority: {
          run_id: "synthetic-run", previous_generation: "old-generation", generation: "recovery-generation",
        }, manual_capture_legacy_owner: "synthetic-owner", manual_capture_draft: { content: "old", token: "old-token", page_determination_id: "old-decision" } }), itemId);
      expect(listManualCaptureQueue(db).items[0]!.lifecycleId).toBe(original);
      const recovery = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/supersede`,
        payload: { expectedLifecycleId: original } });
      expect(recovery.statusCode).toBe(200);
      const recovered = recovery.json().lifecycleId as string;
      expect(recovered).not.toBe(original);
      const retained = JSON.parse((db.prepare("SELECT retry_context_json FROM manual_capture_queue WHERE item_id=?").get(itemId) as { retry_context_json: string }).retry_context_json);
      expect(retained.manual_capture_draft).toMatchObject({ content: "old", page_determination_id: "old-decision" });
      expect(retained.manual_capture_draft.token).toMatch(/^[a-f0-9]{32}$/);
      expect(retained.manual_capture_draft.token).not.toBe("old-token");
      expect(retained.manual_capture_legacy_owner).toBe("synthetic-owner");
      expect(retained.manual_capture_reopen_authority).toBeUndefined();
      const staleRecovery = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/supersede`,
        payload: { expectedLifecycleId: original } });
      expect(staleRecovery.statusCode).toBe(409);
      const dismiss = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/dismiss`,
        payload: { expectedLifecycleId: recovered } });
      expect(dismiss.statusCode).toBe(200);
      db.prepare("UPDATE manual_capture_queue SET status='pending', retry_context_json=? WHERE item_id=?")
        .run(JSON.stringify({ manual_capture_generation: "new-generation", manual_capture_draft: { content: "new review" } }), itemId);
      const reopened = listManualCaptureQueue(db).items[0]!.lifecycleId!;
      expect(reopened).not.toBe(original);
      const staleDismiss = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/dismiss`,
        payload: { expectedLifecycleId: original } });
      expect(staleDismiss.statusCode).toBe(409);
      const payload = { captureMode: "pasted_text", contentText: "old submission", futureManualActionRequired: false };
      const staleImport = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/import`,
        payload: { ...payload, expectedLifecycleId: original } });
      expect(staleImport.statusCode).toBe(409);
      const unboundImport = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/import`, payload });
      expect(unboundImport.statusCode).toBe(409);
      expect(imported).toEqual([]);
      expect(listManualCaptureQueue(db).items[0]!.retryContext.manual_capture_draft).toEqual({ content: "new review" });
      const prepare = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/prepare`,
        payload: { ...payload, expectedLifecycleId: reopened } });
      expect(prepare.statusCode).toBe(200);
      const preparedLifecycle = prepare.json().lifecycleId as string;
      const currentImport = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/import`,
        payload: { ...payload, expectedLifecycleId: preparedLifecycle } });
      expect(currentImport.statusCode).toBe(200);
      expect(imported).toEqual([{ generation: expect.stringMatching(/^[0-9a-f]{32}$/) }]);
      db.prepare("UPDATE manual_capture_queue SET retry_context_json='invalid-json' WHERE item_id=?").run(itemId);
      expect(listManualCaptureQueue(db).items[0]!.lifecycleId).toBeNull();
      const invalidDismiss = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/dismiss`,
        payload: { expectedLifecycleId: reopened } });
      expect(invalidDismiss.statusCode).toBe(409);
      const invalidImport = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${itemId}/import`,
        payload: { ...payload, expectedLifecycleId: reopened } });
      expect(invalidImport.statusCode).toBe(409);
      expect(db.prepare("SELECT retry_context_json FROM manual_capture_queue WHERE item_id=?").get(itemId))
        .toEqual({ retry_context_json: "invalid-json" });
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("retains and fences a prepared submission before dispatch, including delayed requests", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-manual-preparation-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    const imports: string[] = [];
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"),
      manualCaptureImporter: async (itemId, input, context) => {
        imports.push(String(context.expectedCaptureGeneration));
        return { ok: true, itemId, jobKey: "synthetic", importedAt: "2026-10-30", provenance: {
          sourceKind: "user_mediated_capture", originatingUrl: "https://example.test/job/prepared",
          captureMode: input.captureMode, futureManualActionRequired: input.futureManualActionRequired,
        } };
      } });
    try {
      const itemId = "manual-prepared";
      const endpoint = `/v1/discovery/manual-capture/${itemId}`;
      db.prepare(`INSERT INTO manual_capture_queue
        (tenant_id,item_id,originating_url,source_id,reason,retry_context_json,required_at,status)
        VALUES ('local',?,'https://example.test/job/prepared','manual:test','login_required','{}','2026-10-30','pending')`).run(itemId);
      const lifecycle = listManualCaptureQueue(db).items[0]!.lifecycleId!;
      const body = { expectedLifecycleId: lifecycle, captureMode: "pasted_text", contentText: "Original page",
        capturedUrl: "https://example.test/job/prepared", note: "original note", futureManualActionRequired: false };
      expect((await app.inject({ method: "POST", url: `${endpoint}/import`, payload: body })).statusCode).toBe(409);
      const prepared = await app.inject({ method: "POST", url: `${endpoint}/prepare`, payload: body });
      expect(prepared.statusCode).toBe(200);
      const first = prepared.json().lifecycleId as string;
      expect(first).not.toBe(lifecycle);
      const queued = listManualCaptureQueue(db).items[0]!;
      expect(queued.retryContext.manual_capture_import_unresolved).toBe(true);
      expect(queued.retryContext.manual_capture_api_admission).toBeUndefined();
      expect(queued.retryContext.manual_capture_draft).toMatchObject({ content: "Original page", note: "original note" });
      expect((await app.inject({ method: "POST", url: `${endpoint}/prepare`, payload: body })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${endpoint}/import`, payload: { ...body, expectedLifecycleId: first, contentText: "Different page" } })).statusCode).toBe(409);
      const recovered = await app.inject({ method: "POST", url: `${endpoint}/supersede`, payload: { expectedLifecycleId: first } });
      expect(recovered.statusCode).toBe(200);
      const next = recovered.json().lifecycleId as string;
      const revised = { ...body, expectedLifecycleId: next, contentText: "New reviewed page" };
      const secondPrepare = await app.inject({ method: "POST", url: `${endpoint}/prepare`, payload: revised });
      expect(secondPrepare.statusCode).toBe(200);
      const second = secondPrepare.json().lifecycleId as string;
      expect((await app.inject({ method: "POST", url: `${endpoint}/import`, payload: { ...body, expectedLifecycleId: first } })).statusCode).toBe(409);
      expect((await app.inject({ method: "POST", url: `${endpoint}/prepare`, payload: body })).statusCode).toBe(409);
      expect(listManualCaptureQueue(db).items[0]!.retryContext.manual_capture_draft).toMatchObject({ content: "New reviewed page" });
      expect((await app.inject({ method: "POST", url: `${endpoint}/import`, payload: { ...revised, expectedLifecycleId: second } })).statusCode).toBe(200);
      expect(imports).toHaveLength(1);
    } finally {
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reserves an extension capture before dispatch and permits only identical replay", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-extension-preparation-"));
    const dbPath = path.join(dir, "jobctrl.db");
    initializeExactDatabase(dbPath);
    const db = new Database(dbPath);
    let unblock: (error: Error) => void = () => {};
    const pending = new Promise<never>((_resolve, reject) => { unblock = reject; });
    void pending.catch(() => {});
    const generations: Array<string | null | undefined> = [];
    const app = buildApp({ dbPath, configPath: path.join(dir, "config.json"),
      manualCaptureImporter: async (_itemId, _input, context) => {
        generations.push(context.expectedCaptureGeneration);
        return pending;
      } });
    try {
      const body = { captureId: "synthetic-extension-reservation", originatingUrl: "https://example.test/job/extension",
        capturedUrl: "https://example.test/job/extension", captureMode: "pasted_text", contentText: "Extension page",
        futureManualActionRequired: false, captureClient: "browser_extension", extensionVersion: "1.0" };
      const token = (await app.inject({ method: "GET", url: "/v1/extension/pairing-token" })).json().token as string;
      const headers = { origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", authorization: `Bearer ${token}`,
        "sec-fetch-site": "cross-site" };
      const first = app.inject({ method: "POST", url: "/v1/extension/captures", headers, payload: body });
      await vi.waitFor(() => expect(generations).toHaveLength(1));
      const item = listManualCaptureQueue(db).items[0]!;
      expect(item.retryContext.manual_capture_import_unresolved).toBe(true);
      expect(item.retryContext.manual_capture_draft).toMatchObject({ content: "Extension page" });
      expect(generations).toEqual([expect.stringMatching(/^[0-9a-f]{32}$/)]);
      const changed = await app.inject({ method: "POST", url: "/v1/extension/captures", headers, payload: { ...body, contentText: "Changed page" } });
      expect(changed.statusCode).toBe(409);
      expect(generations).toHaveLength(1);
      const replay = app.inject({ method: "POST", url: "/v1/extension/captures", headers, payload: body });
      await vi.waitFor(() => expect(generations).toHaveLength(2));
      expect(generations[1]).toBe(generations[0]);
      const recovered = await app.inject({ method: "POST", url: `/v1/discovery/manual-capture/${item.itemId}/supersede`,
        payload: { expectedLifecycleId: item.lifecycleId } });
      expect(recovered.statusCode).toBe(200);
      unblock(new Error("synthetic delayed worker"));
      expect((await first).statusCode).toBe(409);
      expect((await replay).statusCode).toBe(409);
      expect(listManualCaptureQueue(db).items[0]!.retryContext.manual_capture_draft).toMatchObject({ content: "Extension page" });
    } finally {
      unblock(new Error("test cleanup"));
      await app.close();
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
