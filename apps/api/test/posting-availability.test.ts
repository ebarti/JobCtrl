import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { RpcMethods } from "@jobctrl/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/server.js";
import { postingAvailability } from "../src/read-model.js";
import { initializeExactV7Database } from "./v7-schema.js";

const JOB = "10000000-0000-4000-8000-000000000123";
const URL = "https://careers.example.org/jobs/role-123";
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()?.(); });

function fixture() {
  const appDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-availability-api-"));
  const dbPath = path.join(appDir, "jobs.db");
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  db.prepare("INSERT INTO jobs (tenant_id, job_id, url, title, site, discovered_at) VALUES ('local', ?, ?, 'Synthetic role', 'synthetic', '2026-10-01T00:00:00Z')").run(JOB, URL);
  cleanups.push(() => { db.close(); fs.rmSync(appDir, { recursive: true, force: true }); });
  return { db, appDir, dbPath };
}

describe("saved posting availability", () => {
  it("dispatches strict runtime-bound RPC without holding a database writer", async () => {
    const { db, appDir, dbPath } = fixture();
    const call = vi.fn(async (method, params) => {
      db.exec("BEGIN IMMEDIATE"); db.exec("ROLLBACK");
      expect(method).toBe(RpcMethods.CheckPostingAvailability);
      expect(params).toEqual({ tenantId: "local", jobId: JOB, expectedAppDir: appDir, expectedDbPath: dbPath });
      return { jsonrpc: "2.0" as const, id: 1, result: { runId: "run", workflowId: `availability-local-${JOB}` } };
    });
    const app = buildApp({ dbPath, configPath: path.join(appDir, "config.json"), providerDispatcher: { call, close: async () => undefined } });
    cleanups.push(() => app.close());
    const response = await app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/check-availability`, payload: {} });
    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({ ok: true, status: "queued", runId: "run" });
    expect(call).toHaveBeenCalledTimes(1);
    const bad = await app.inject({ method: "POST", url: `/v1/jobs/${JOB}/actions/check-availability`, payload: { bypass: true } });
    expect(bad.statusCode).toBe(400);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("reads uncertainty and prior success through a readonly connection without RPC or writes", () => {
    const { db, dbPath } = fixture();
    const value = { verdict: "unknown", reason: "conflicting_signals", method: "public_http", postingUrl: URL,
      lastAttemptedAt: "2026-10-04T00:00:00Z", lastSuccessfullyVerifiedAt: "2026-10-01T00:00:00Z", lastSuccessfulState: "active",
      nextDueAt: "2026-10-04T00:05:00Z", evidenceRef: "availability:latest", lineage: [{ sourceUrl: URL, finalUrl: URL,
        status: 200, method: "public_http", rawHash: "a".repeat(64), signals: [{ kind: "current_closed_status", value: true },
          { kind: "posting_deadline", value: "2999-01-01T00:00:00Z", past: false }] }] };
    db.prepare("INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, entity_kind, entity_ref, occurred_at, payload_json) VALUES ('local', ?, 1, 'enrich', 'JobAvailabilityObserved', 'posting_availability', ?, ?, ?)")
      .run(JOB, JOB, value.lastAttemptedAt, JSON.stringify(value));
    const deferred = { jobId: JOB, status: "deferred", reason: "retry_backoff", requestedAt: "2026-10-04T00:01:00Z", retryAt: value.nextDueAt };
    db.prepare("INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, entity_kind, entity_ref, occurred_at, payload_json) VALUES ('local', ?, 1, 'enrich', 'AvailabilityLeaseChanged', 'posting_availability_request', ?, ?, ?)")
      .run(JOB, JOB, deferred.requestedAt, JSON.stringify(deferred));
    const reader = new Database(dbPath, { readonly: true });
    try {
      const count = db.prepare("SELECT COUNT(*) AS n FROM job_events").get();
      const observation = postingAvailability(reader, JOB, Date.parse("2026-10-05T00:00:00Z"));
      expect(observation).toMatchObject({ verdict: "unknown", lastSuccessfulState: "active", overdue: true });
      expect(observation.lineage[0]?.signals).toHaveLength(2);
      expect(observation.request).toEqual({ status: deferred.status, reason: deferred.reason,
        requestedAt: deferred.requestedAt, retryAt: deferred.retryAt });
      expect(db.prepare("SELECT COUNT(*) AS n FROM job_events").get()).toEqual(count);
    } finally { reader.close(); }
  });
});
