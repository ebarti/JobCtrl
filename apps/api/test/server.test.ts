import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { createJobHunterApiClient } from "@jobhunter/api-client";
import { CredentialKeys, type ActionCommandPayload, type CredentialKey } from "@jobhunter/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveApiConfig } from "../src/config.js";
import { defaultActionDispatcher, type ActionDispatchResult } from "../src/local-actions.js";
import { buildApp, type BuildAppOptions } from "../src/server.js";

let tempDir = "";
let options: BuildAppOptions;

function validProfileFixture(fullName: string): Record<string, unknown> {
  return {
    personal: { full_name: fullName, email: "jordan@example.com" },
    resume: {
      executive_profile: { baseline_text: "Experienced platform leader." },
      experience_entries: [
        {
          id: "role_1",
          title: "Engineer",
          company: "Example",
          date_range: "2024 -- Present",
          location: "Remote",
          bullets: ["Shipped reliable systems."],
        },
      ],
      education_entries: [],
      skill_categories: [],
      tailoring_rules: {},
    },
  };
}

function profileWithTargetSearch(fullName: string, location: string, workModel: string): Record<string, unknown> {
  return {
    ...validProfileFixture(fullName),
    experience: {
      target_role: "Principal Platform Engineer",
      target_track: "IC",
      target_seniority_floor: "Principal",
      target_functions: "Platform",
      target_specializations: "SaaS",
      target_locations: location,
      target_work_models: workModel,
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitForExpectation(assertion: () => void, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      assertion();
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  assertion();
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-"));
  options = {
    dbPath: path.join(tempDir, "jobhunter.db"),
    profilePath: path.join(tempDir, "profile.json"),
    resumeStylePath: path.join(tempDir, "resume_style.json"),
    resumeTemplatePath: path.join(tempDir, "resume_template.tex"),
    settingsPath: path.join(tempDir, "dashboard.json"),
    actionDispatcher: vi.fn(async (): Promise<ActionDispatchResult> => ({ status: "queued", runId: "run-profile-retailor" })),
  };
  seedDatabase(options.dbPath);
  fs.writeFileSync(options.profilePath, JSON.stringify(validProfileFixture("Jordan Candidate")));
  fs.writeFileSync(options.resumeStylePath, JSON.stringify({ font_family: "sans" }));
  fs.writeFileSync(options.resumeTemplatePath, "\\documentclass{article}");
  fs.writeFileSync(
    options.settingsPath,
    JSON.stringify({
      target_role: "Platform Engineering",
      location_filter: "Remote",
      min_fit_score: 8,
      auto_apply: true,
      apply_concurrency: 3,
      score_criteria: "Security leadership and platform reliability.",
      target_criteria: "Director-plus infrastructure and security roles.",
    }),
  );
});

afterEach(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("local TypeScript API", () => {
  it("defaults the shared API client to the local API origin under Node.js", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, dbPath: options.dbPath, dbExists: true }), {
        status: 200,
        statusText: "OK",
      }),
    );

    await createJobHunterApiClient().health();

    expect(fetchMock).toHaveBeenCalledWith("http://127.0.0.1:8766/v1/health", { method: "GET" });
    fetchMock.mockRestore();
  });

  it("refuses non-loopback API binds unless explicitly allowed", () => {
    expect(() => resolveApiConfig({ JOBHUNTER_API_HOST: "0.0.0.0" })).toThrow(/Refusing to bind/);
    expect(resolveApiConfig({ JOBHUNTER_API_HOST: "0.0.0.0", JOBHUNTER_API_ALLOW_REMOTE_BIND: "1" }).host).toBe(
      "0.0.0.0",
    );
  });

  it("reports local database health", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { origin: "http://localhost:8765" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:8765");
    expect(response.json()).toMatchObject({
      ok: true,
      appDir: tempDir,
      dbPath: options.dbPath,
      dbExists: true,
      worker: {
        status: "missing",
        expectedDbPath: options.dbPath,
        expectedAppDir: tempDir,
        heartbeat: null,
      },
    });

    await app.close();
  });

  it("reports a healthy Temporal worker heartbeat from the API database", async () => {
    insertWorkerHeartbeat(options.dbPath, {
      workerId: "worker-1",
      appDir: tempDir,
      dbPath: options.dbPath,
      lastSeenAt: new Date().toISOString(),
    });
    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      worker: {
        status: "healthy",
        expectedDbPath: options.dbPath,
        expectedAppDir: tempDir,
        heartbeat: {
          workerId: "worker-1",
          appDir: tempDir,
          dbPath: options.dbPath,
          taskQueue: "jobhunter-default",
        },
      },
    });

    await app.close();
  });

  it("reports a stale Temporal worker heartbeat", async () => {
    insertWorkerHeartbeat(options.dbPath, {
      workerId: "worker-stale",
      appDir: tempDir,
      dbPath: options.dbPath,
      lastSeenAt: "2026-01-01T00:00:00.000Z",
    });
    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      worker: {
        status: "stale",
        heartbeat: {
          workerId: "worker-stale",
        },
      },
    });

    await app.close();
  });

  it("reports a mismatched Temporal worker heartbeat", async () => {
    insertWorkerHeartbeat(options.dbPath, {
      workerId: "worker-wrong-db",
      appDir: path.join(tempDir, "other-app"),
      dbPath: path.join(tempDir, "other-app", "jobhunter.db"),
      lastSeenAt: new Date().toISOString(),
    });
    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      worker: {
        status: "mismatched",
        expectedDbPath: options.dbPath,
        expectedAppDir: tempDir,
        heartbeat: {
          workerId: "worker-wrong-db",
          appDir: path.join(tempDir, "other-app"),
          dbPath: path.join(tempDir, "other-app", "jobhunter.db"),
        },
      },
    });
    expect(response.json().worker.message).toContain("does not match");

    await app.close();
  });

  it("blocks stage dispatch when the worker runtime does not match the API runtime", async () => {
    const dispatch = vi.fn(async (): Promise<ActionDispatchResult> => ({ status: "queued", runId: "run-ignored" }));
    insertWorkerHeartbeat(options.dbPath, {
      workerId: "worker-wrong-db",
      appDir: path.join(tempDir, "other-app"),
      dbPath: path.join(tempDir, "other-app", "jobhunter.db"),
      lastSeenAt: new Date().toISOString(),
    });
    const app = buildApp({
      ...options,
      actionDispatcher: dispatch,
      requireHealthyWorkerForActions: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["tailor"], dryRun: true, limit: 1 },
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "worker_runtime_unavailable",
      worker: {
        status: "mismatched",
        expectedDbPath: options.dbPath,
        expectedAppDir: tempDir,
      },
    });
    expect(response.json().message).toContain("does not match");
    expect(dispatch).not.toHaveBeenCalled();

    await app.close();
  });

  it("does not allow cross-site browser reads from non-local origins", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
      headers: { origin: "https://example.com" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("allows loopback browser access to the event stream", async () => {
    const app = buildApp(options);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local test server address");
    }

    const response = await fetch(`http://127.0.0.1:${address.port}/v1/events/stream?tenantId=local`, {
      headers: { origin: "http://127.0.0.1:5175" },
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5175");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    await response.body?.cancel();
    await app.close();
  });

  it("allows loopback browser preflight for local profile saves", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "OPTIONS",
      url: "/v1/profile",
      headers: {
        origin: "http://127.0.0.1:5173",
        "access-control-request-method": "PATCH",
      },
    });

    expect(response.statusCode, response.body).toBe(204);
    expect(response.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5173");
    expect(response.headers["access-control-allow-methods"]).toContain("PATCH");
    expect(response.headers["access-control-allow-methods"]).toContain("POST");

    await app.close();
  });

  it("rejects non-loopback browser mutation sources before handlers run", async () => {
    const dispatch = vi.fn(
      async (_command: ActionCommandPayload): Promise<ActionDispatchResult> => ({ status: "queued" }),
    );
    const opener = vi.fn(async () => undefined);
    const importer = vi.fn(async () => ({ profile: {} }));
    const app = buildApp({ ...options, actionDispatcher: dispatch, artifactOpener: opener, profileImporter: importer });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");
    const originalProfile = fs.readFileSync(options.profilePath, "utf8");

    const mutationRequests = [
      {
        method: "POST",
        url: `/v1/jobs/${jobKey}/actions/apply`,
        payload: { dryRun: true },
      },
      {
        method: "POST",
        url: `/v1/jobs/${jobKey}/actions/mark-applied`,
        payload: { reason: "cross-site" },
      },
      {
        method: "DELETE",
        url: `/v1/jobs/${jobKey}`,
        payload: { reason: "cross-site" },
      },
      {
        method: "POST",
        url: "/v1/artifacts/1/open",
      },
      {
        method: "PATCH",
        url: "/v1/profile",
        payload: { profileText: JSON.stringify({ personal: { full_name: "Cross Site" } }) },
      },
      {
        method: "POST",
        url: "/v1/profile/import-resume",
        payload: { filename: "resume.pdf", pdfBase64: Buffer.from("%PDF test").toString("base64") },
      },
      {
        method: "PATCH",
        url: "/v1/credentials",
        payload: { key: "OPENAI_API_KEY", value: "cross-site" },
      },
      {
        method: "DELETE",
        url: "/v1/credentials/OPENAI_API_KEY",
      },
    ] as const;

    for (const request of mutationRequests) {
      const response = await app.inject({
        ...request,
        headers: { origin: "https://example.com" },
      });
      expect(response.statusCode, `${request.method} ${request.url}: ${response.body}`).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: "cross_site_request" });
    }

    const refererResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/mark-skipped`,
      headers: { referer: "https://example.com/jobs" },
      payload: { reason: "cross-site" },
    });
    expect(refererResponse.statusCode, refererResponse.body).toBe(403);
    expect(dispatch).not.toHaveBeenCalled();
    expect(opener).not.toHaveBeenCalled();
    expect(importer).not.toHaveBeenCalled();
    expect(fs.readFileSync(options.profilePath, "utf8")).toBe(originalProfile);

    const db = new Database(options.dbPath);
    const row = db.prepare("SELECT apply_status, applied_at FROM jobs WHERE url = ?").get("https://example.com/jobs/ready") as {
      apply_status: string | null;
      applied_at: string | null;
    };
    db.close();
    expect(row).toMatchObject({ apply_status: null, applied_at: null });

    await app.close();
  });

  it("allows loopback browser and no-origin mutation callers", async () => {
    const app = buildApp(options);
    const appliedKey = encodeURIComponent("https://example.com/jobs/ready");
    const skippedKey = encodeURIComponent("https://example.com/jobs/blocked-tailor");

    const loopback = await app.inject({
      method: "POST",
      url: `/v1/jobs/${appliedKey}/actions/mark-applied`,
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { reason: "local browser" },
    });
    const noOrigin = await app.inject({
      method: "POST",
      url: `/v1/jobs/${skippedKey}/actions/mark-skipped`,
      payload: { reason: "CLI" },
    });

    expect(loopback.statusCode, loopback.body).toBe(200);
    expect(noOrigin.statusCode, noOrigin.body).toBe(200);
    expect(loopback.json()).toMatchObject({ action: "mark_applied", stage: { state: "succeeded" } });
    expect(noOrigin.json()).toMatchObject({ action: "mark_skipped", stage: { state: "skipped" } });

    await app.close();
  });

  it("returns dashboard summary from the existing SQLite schema", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.totals).toMatchObject({
      jobs: 3,
      jobsToday: 0,
      failures: 1,
      blocked: 1,
      ready: 1,
      applied: 0,
      appliedToday: 0,
      dryRuns: 1,
    });
    expect(body.funnel.find((stage: { stage: string }) => stage.stage === "score")).toMatchObject({
      failed: 1,
      succeeded: 2,
      blocked: 0,
    });
    expect(body.activity[0]).toMatchObject({
      eventId: "1",
      eventType: "ActionFailed",
      jobKey: "https://example.com/jobs/failed-score",
      title: "Backend Engineer",
      company: "ExampleCo",
      stage: "score",
      level: "error",
    });
    expect(body.applyRuns[0]).toMatchObject({ runId: "run-1", dryRun: true });

    await app.close();
  });

  it("returns the latest pipeline progress snapshot from durable events", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        null,
        "discover",
        "StageCompleted",
        "info",
        "Discovery source workday ok",
        "2026-04-29T10:20:00+00:00",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          progress: {
            completed: 3,
            total: 5,
            percent: 60,
            currentStep: "Workday scraper",
            status: "running",
            message: "Workday scraper complete",
          },
        }),
      );
    } finally {
      db.close();
    }

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().progress).toEqual([
      {
        stage: "discover",
        status: "running",
        percent: 60,
        completed: 3,
        total: 5,
        currentStep: "Workday scraper",
        message: "Workday scraper complete",
        updatedAt: "2026-04-29T10:20:00+00:00",
      },
    ]);

    await app.close();
  });

  it("returns local-day dashboard deltas for active jobs and applications", async () => {
    const now = new Date().toISOString();
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "UPDATE jobs SET discovered_at = ?, apply_status = 'applied', applied_at = ? WHERE url = ?",
      ).run(now, now, "https://example.com/jobs/ready");
    } finally {
      db.close();
    }

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().totals).toMatchObject({
      jobsToday: 1,
      appliedToday: 1,
    });

    await app.close();
  });

  it("keeps dashboard activity bounded while debug activity is paginated", async () => {
    const db = new Database(options.dbPath);
    try {
      const insertActivity = db.prepare(
        "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (let index = 0; index < 75; index += 1) {
        const suffix = String(index + 1).padStart(2, "0");
        insertActivity.run(
          "https://example.com/jobs/ready",
          "score",
          "JobScored",
          "info",
          `Uncapped dashboard activity ${suffix}`,
          `2026-04-29T10:${String(index + 20).padStart(2, "0")}:00+00:00`,
        );
      }
    } finally {
      db.close();
    }

    const app = buildApp(options);
    const dashboard = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
    const debugPageOne = await app.inject({ method: "GET", url: "/v1/debug/activity?page=1&pageSize=50" });
    const debugPageTwo = await app.inject({ method: "GET", url: "/v1/debug/activity?page=2&pageSize=50" });

    expect(dashboard.statusCode, dashboard.body).toBe(200);
    expect(dashboard.json().activity).toHaveLength(50);
    expect(debugPageOne.statusCode, debugPageOne.body).toBe(200);
    expect(debugPageOne.json().pagination).toMatchObject({ page: 1, total: 76, pages: 2 });
    expect(debugPageOne.json().items).toHaveLength(50);
    expect(debugPageTwo.statusCode, debugPageTwo.body).toBe(200);
    expect(debugPageTwo.json().pagination).toMatchObject({ page: 2, total: 76, pages: 2 });
    expect(debugPageTwo.json().items).toHaveLength(26);
    const olderEventId = debugPageTwo.json().items[0].eventId;
    const olderEvent = await app.inject({ method: "GET", url: `/v1/debug/activity/${olderEventId}` });
    expect(olderEvent.statusCode, olderEvent.body).toBe(200);
    expect(olderEvent.json().event).toMatchObject({ eventId: olderEventId, title: "Platform Engineer" });

    await app.close();
  });

  it("does not expose dashboard activity links for events whose job no longer exists", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      "https://example.com/jobs/missing-parent",
      "tailor",
      "StageFailed",
      "error",
      "Orphan tailor event",
      "2026-04-29T10:20:00+00:00",
    );
    db.close();

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

    expect(response.statusCode, response.body).toBe(200);
    const activity = response.json().activity as Array<{ jobKey: string | null; message: string }>;
    expect(activity.some((event) => event.message === "Orphan tailor event")).toBe(false);
    expect(activity.some((event) => event.jobKey === "https://example.com/jobs/missing-parent")).toBe(false);

    await app.close();
  });

  it("returns a controlled error when the local database cannot be read", async () => {
    fs.writeFileSync(options.dbPath, "not a sqlite database");
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

    expect(response.statusCode, response.body).toBeGreaterThanOrEqual(500);
    expect(response.json()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/^db_(open|read)_failed$/),
    });

    await app.close();
  });

  it("filters, sorts, and paginates jobs globally", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/jobs?state=failed&sort=fit_score&dir=desc&page=1&pageSize=1",
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.pagination).toMatchObject({ page: 1, pageSize: 1, total: 1, pages: 1 });
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      jobKey: "https://example.com/jobs/failed-score",
      title: "Backend Engineer",
      currentStage: "score",
      currentState: "failed",
      fitScore: 8,
      discoverySource: "test",
    });

    const scoreFiltered = await app.inject({
      method: "GET",
      url: "/v1/jobs?minFitScore=9&sort=fit_score&dir=desc",
    });
    expect(scoreFiltered.statusCode, scoreFiltered.body).toBe(200);
    expect(scoreFiltered.json().items.map((job: { fitScore: number | null }) => job.fitScore)).toEqual([9]);

    await app.close();
  });

  it("soft-deletes jobs, hides them from active lists, and restores them", async () => {
    const app = buildApp(options);
    const readyKey = encodeURIComponent("https://example.com/jobs/ready");

    const singleDelete = await app.inject({
      method: "DELETE",
      url: `/v1/jobs/${readyKey}`,
      payload: { reason: "not relevant" },
    });
    const bulkDelete = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-delete",
      payload: { allMatching: true, filter: { state: "failed", deleted: "active" }, jobKeys: [] },
    });

    expect(singleDelete.statusCode, singleDelete.body).toBe(200);
    expect(singleDelete.json()).toMatchObject({ ok: true, count: 1, jobKeys: ["https://example.com/jobs/ready"] });
    expect(bulkDelete.statusCode, bulkDelete.body).toBe(200);
    expect(bulkDelete.json()).toMatchObject({ ok: true, count: 1, jobKeys: ["https://example.com/jobs/failed-score"] });

    const active = await app.inject({ method: "GET", url: "/v1/jobs" });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().pagination.total).toBe(1);
    expect(active.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual(["https://example.com/jobs/blocked-tailor"]);

    const deleted = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted&sort=title&dir=asc" });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().pagination.total).toBe(2);
    expect(deleted.json().items[0]).toMatchObject({ deletedAt: expect.any(String) });

    const summary = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().totals).toMatchObject({
      jobs: 1,
      failures: 0,
      blocked: 1,
      ready: 0,
      dryRuns: 0,
    });
    expect(summary.json().activity).toHaveLength(0);
    expect(summary.json().applyRuns).toHaveLength(0);

    const artifacts = await app.inject({ method: "GET", url: "/v1/artifacts" });
    expect(artifacts.statusCode, artifacts.body).toBe(200);
    expect(artifacts.json().pagination.total).toBe(0);

    const restore = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-restore",
      payload: { allMatching: true, filter: { deleted: "deleted" }, jobKeys: [] },
    });
    expect(restore.statusCode, restore.body).toBe(200);
    expect(restore.json()).toMatchObject({ ok: true, count: 2 });

    const restored = await app.inject({ method: "GET", url: "/v1/jobs" });
    expect(restored.json().pagination.total).toBe(3);
    const emptyDeleted = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted" });
    expect(emptyDeleted.json().pagination.total).toBe(0);

    await app.close();
  });

  it("treats stale restores before later deletes as deleted", async () => {
    const db = new Database(options.dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS jobhunter_deleted_jobs (
        job_url TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL,
        reason TEXT,
        restored_at TEXT
      );
    `);
    db.prepare(
      "INSERT INTO jobhunter_deleted_jobs (job_url, deleted_at, reason, restored_at) VALUES (?, ?, ?, ?)",
    ).run(
      "https://example.com/jobs/ready",
      "2026-05-25T23:10:33.870522+00:00",
      "discovery hygiene rejected source",
      "2026-05-25T21:35:55.879345+00:00",
    );
    db.close();

    const app = buildApp(options);
    const active = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active&q=Platform" });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().pagination.total).toBe(0);

    const deleted = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted&q=Platform" });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().pagination.total).toBe(1);
    expect(deleted.json().items[0]).toMatchObject({
      jobKey: "https://example.com/jobs/ready",
      deletedAt: "2026-05-25T23:10:33.870522+00:00",
    });

    await app.close();
  });

  it("hides jobs in a separate tab and unhides them without using deleted state", async () => {
    const app = buildApp(options);

    const hide = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-hide",
      payload: {
        allMatching: false,
        jobKeys: ["https://example.com/jobs/blocked-tailor"],
        reason: "never show again",
      },
    });
    expect(hide.statusCode, hide.body).toBe(200);
    expect(hide.json()).toMatchObject({ ok: true, count: 1 });

    const active = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active&sort=title&dir=asc" });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().pagination.total).toBe(2);
    expect(active.json().items.map((job: { jobKey: string }) => job.jobKey)).not.toContain(
      "https://example.com/jobs/blocked-tailor",
    );

    const deleted = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted" });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().pagination.total).toBe(0);

    const hidden = await app.inject({ method: "GET", url: "/v1/jobs?deleted=hidden" });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.json().pagination.total).toBe(1);
    expect(hidden.json().items[0]).toMatchObject({
      jobKey: "https://example.com/jobs/blocked-tailor",
      hiddenAt: expect.any(String),
      deletedAt: null,
    });

    const unhide = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-unhide",
      payload: { allMatching: true, filter: { deleted: "hidden" }, jobKeys: [] },
    });
    expect(unhide.statusCode, unhide.body).toBe(200);
    expect(unhide.json()).toMatchObject({ ok: true, count: 1 });

    const restoredActive = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active" });
    expect(restoredActive.json().pagination.total).toBe(3);
    const emptyHidden = await app.inject({ method: "GET", url: "/v1/jobs?deleted=hidden" });
    expect(emptyHidden.json().pagination.total).toBe(0);

    await app.close();
  });

  it("permanently deletes job rows and clears delete/hide tombstones so rediscovery can add them again", async () => {
    const app = buildApp(options);
    const readyUrl = "https://example.com/jobs/ready";
    const blockedUrl = "https://example.com/jobs/blocked-tailor";

    const softDelete = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-delete",
      payload: { allMatching: false, jobKeys: [readyUrl] },
    });
    const hide = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-hide",
      payload: { allMatching: false, jobKeys: [blockedUrl] },
    });
    expect(softDelete.statusCode, softDelete.body).toBe(200);
    expect(hide.statusCode, hide.body).toBe(200);

    const permanentDelete = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-delete-permanent",
      payload: { allMatching: false, jobKeys: [readyUrl, blockedUrl] },
    });
    expect(permanentDelete.statusCode, permanentDelete.body).toBe(200);
    expect(permanentDelete.json()).toMatchObject({ ok: true, count: 2, jobKeys: [readyUrl, blockedUrl] });

    const active = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active&sort=title&dir=asc" });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().pagination.total).toBe(1);
    expect(active.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
      "https://example.com/jobs/failed-score",
    ]);

    const deleted = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted" });
    expect(deleted.json().pagination.total).toBe(0);
    const hidden = await app.inject({ method: "GET", url: "/v1/jobs?deleted=hidden" });
    expect(hidden.json().pagination.total).toBe(0);

    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${encodeURIComponent(readyUrl)}` });
    expect(detail.statusCode, detail.body).toBe(404);

    const db = new Database(options.dbPath);
    expect(countRows(db, "jobs", "url", readyUrl)).toBe(0);
    expect(countRows(db, "jobhunter_deleted_jobs", "job_url", readyUrl)).toBe(0);
    expect(countRows(db, "jobhunter_hidden_jobs", "job_url", blockedUrl)).toBe(0);
    expect(countRows(db, "job_stage_states", "job_url", readyUrl)).toBe(0);
    expect(countRows(db, "job_scores", "job_url", readyUrl)).toBe(0);

    insertJob(db, {
      url: readyUrl,
      title: "Rediscovered Engineer",
      site: "ExampleCo",
      fitScore: null,
    });
    db.prepare(
      "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(readyUrl, "discover", "JobDiscovered", "info", "Rediscovered after permanent delete.", "2026-04-30T10:00:00+00:00");
    db.close();

    const rediscovered = await app.inject({
      method: "GET",
      url: "/v1/jobs?deleted=active&q=rediscovered&sort=title&dir=asc",
    });
    expect(rediscovered.statusCode, rediscovered.body).toBe(200);
    expect(rediscovered.json().pagination.total).toBe(1);
    expect(rediscovered.json().items[0]).toMatchObject({
      jobKey: readyUrl,
      title: "Rediscovered Engineer",
      deletedAt: null,
      hiddenAt: null,
    });

    await app.close();
  });

  it("derives apply state from apply_run_projections when legacy jobs columns are NULL", async () => {
    // PR 4 of the Temporal stack: ``apply_run_projections`` (sourced
    // from ``job_events`` by the Python projection builder) is the
    // canonical apply lifecycle row. The TS read-model derives
    // applyStatus / appliedAt from the joined projection row so the
    // dashboard + jobs list show the right values without dual-writing
    // to ``jobs.apply_status`` / ``applied_at``.
    const db = new Database(options.dbPath);
    const newJobUrl = "https://example.com/jobs/new-path-applied";
    insertJob(db, {
      url: newJobUrl,
      title: "New Path Engineer",
      site: "NewPathCo",
      fitScore: 9,
    });
    db.prepare(
      "INSERT INTO apply_run_projections (run_id, job_id, job_title, job_employer, status, result, dry_run, started_at, finished_at) "
        + "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "run-new-path",
      newJobUrl,
      "New Path Engineer",
      "NewPathCo",
      "succeeded",
      "applied",
      0,
      "2026-05-01T00:00:00+00:00",
      "2026-05-01T00:01:00+00:00",
    );
    db.close();

    const app = buildApp(options);
    try {
      const jobsRes = await app.inject({
        method: "GET",
        url: `/v1/jobs?q=${encodeURIComponent("New Path Engineer")}`,
      });
      expect(jobsRes.statusCode, jobsRes.body).toBe(200);
      const job = jobsRes.json().items[0];
      // Read-model derivation: ar.status === 'succeeded' ⇒
      // applyStatus 'applied' + appliedAt = ar.finished_at, with no
      // legacy column writes. (We don't assert currentStage /
      // currentState here because the synthesised job hasn't moved
      // through the upstream stages — the apply-derivation contract
      // is what M2 is locking in.)
      expect(job).toMatchObject({
        jobKey: newJobUrl,
        applyStatus: "applied",
        appliedAt: "2026-05-01T00:01:00+00:00",
      });

      const summary = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(summary.statusCode, summary.body).toBe(200);
      const body = summary.json();
      // The new-path job is counted as applied even though its
      // legacy ``jobs.applied_at`` is NULL.
      expect(body.totals.applied).toBeGreaterThanOrEqual(1);
      // Recent apply runs widget surfaces the row with the canonical
      // labels (the row's own title/site reach the widget directly).
      const newRun = body.applyRuns.find((r: { runId: string }) => r.runId === "run-new-path");
      expect(newRun).toMatchObject({
        runId: "run-new-path",
        title: "New Path Engineer",
        company: "NewPathCo",
        status: "succeeded",
      });
    } finally {
      await app.close();
    }
  });

  it("keeps legacy unscored jobs pending at the score stage", async () => {
    const db = new Database(options.dbPath);
    insertJob(db, {
      url: "https://example.com/jobs/unscored",
      title: "Unscored Engineer",
      site: "LegacyCo",
      fitScore: null,
      scoredAt: null,
    });
    db.close();

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/jobs?q=Unscored" });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({
      jobKey: "https://example.com/jobs/unscored",
      currentStage: "score",
      currentState: "pending",
      fitScore: null,
    });

    await app.close();
  });

  it("returns job detail with stages and local artifacts", async () => {
    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");
    const response = await app.inject({ method: "GET", url: `/v1/jobs/${jobKey}` });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.job).toMatchObject({
      jobKey: "https://example.com/jobs/ready",
      currentStage: "apply",
      currentState: "pending",
      artifactCount: 2,
    });
    expect(body.stages.map((stage: { stage: string }) => stage.stage)).toEqual([
      "discover",
      "enrich",
      "score",
      "tailor",
      "cover",
      "apply",
    ]);
    expect(body.artifacts[0]).toMatchObject({
      type: "tailored_resume_txt",
      status: "active",
      size: "12b",
    });

    await app.close();
  });

  it("corrects a score through the API and records correction evidence", async () => {
    const legacyJobUrl = "https://example.com/jobs/private-legacy";
    const legacyReason = "Legacy correction mentioned a private resume detail.";
    const seedDb = new Database(options.dbPath);
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS scoring_policies (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        version INTEGER NOT NULL,
        rubric_json TEXT NOT NULL,
        anchors_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_from_event_id INTEGER,
        PRIMARY KEY (tenant_id, version)
      )
    `);
    seedDb
      .prepare(
        `INSERT INTO scoring_policies (
           tenant_id, version, rubric_json, anchors_json, created_at, created_from_event_id
         ) VALUES ('local', 1, ?, ?, ?, NULL)`,
      )
      .run(
        JSON.stringify({
          rubric_version: "default-scoring-rubric-v1",
          dimensions: [
            { name: "technical_fit", weight: 0.45 },
            { name: "experience_fit", weight: 0.3 },
            { name: "role_fit", weight: 0.25 },
          ],
          fit_band_thresholds: [
            { band: "excellent", minimum_score: 9 },
            { band: "strong", minimum_score: 7 },
            { band: "plausible", minimum_score: 5 },
            { band: "stretch", minimum_score: 3 },
            { band: "poor", minimum_score: 1 },
          ],
        }),
        JSON.stringify([
          {
            anchor_id: "legacy-anchor",
            job_id: legacyJobUrl,
            fit_score: 5,
            rationale: legacyReason,
            dimensions: ["technical_fit"],
            created_at: "2026-04-29T10:03:00+00:00",
          },
        ]),
        "2026-04-29T10:03:00+00:00",
      );
    seedDb.close();

    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/score-correction`,
      payload: { correctedScore: 6, reason: "Manual review found a seniority mismatch." },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().job).toMatchObject({
      jobKey: "https://example.com/jobs/ready",
      fitScore: 6,
      scoreVersion: 2,
      scoreCorrection: {
        correctedScore: 6,
        rationale: "Manual review found a seniority mismatch.",
        correctedBy: "local",
      },
    });

    const db = new Database(options.dbPath);
    try {
      const latest = db
        .prepare(
          `SELECT version, fit_score, correction_json, trace_json
           FROM job_scores
           WHERE job_url = ?
           ORDER BY version DESC
           LIMIT 1`,
        )
        .get("https://example.com/jobs/ready") as {
        version: number;
        fit_score: number;
        correction_json: string;
        trace_json: string;
      };
      expect(latest.version).toBe(2);
      expect(latest.fit_score).toBe(6);
      expect(JSON.parse(latest.correction_json)).toMatchObject({
        corrected_fit_score: 6,
        rationale: "Manual review found a seniority mismatch.",
        corrected_by: "local",
      });
      expect(JSON.parse(latest.trace_json).correction_history[0]).toMatchObject({
        original_score: 9,
        corrected_score: 6,
      });
      const event = db
        .prepare("SELECT event_type, payload_json FROM job_events WHERE event_type = 'ScoreCorrected'")
        .get() as { event_type: string; payload_json: string };
      expect(event.event_type).toBe("ScoreCorrected");
      expect(JSON.parse(event.payload_json)).toMatchObject({
        jobId: "https://example.com/jobs/ready",
        originalScore: 9,
        correctedScore: 6,
      });
      const policies = db
        .prepare(
          `SELECT version, rubric_json, anchors_json
           FROM scoring_policies
           WHERE tenant_id = 'local'
           ORDER BY version`,
        )
        .all() as Array<{ version: number; rubric_json: string; anchors_json: string }>;
      expect(policies.map((policy) => policy.version)).toEqual([1, 2]);
      const updatedPolicy = policies[1];
      expect(updatedPolicy).toBeDefined();
      expect(JSON.parse(updatedPolicy!.rubric_json)).toMatchObject({
        rubric_version: "default-scoring-rubric-v1",
        dimensions: [
          { name: "technical_fit", weight: 0.45 },
          { name: "experience_fit", weight: 0.3 },
          { name: "role_fit", weight: 0.25 },
        ],
      });
      expect(updatedPolicy!.anchors_json).not.toContain("https://example.com/jobs/ready");
      expect(updatedPolicy!.anchors_json).not.toContain("Manual review found a seniority mismatch.");
      const anchors = JSON.parse(updatedPolicy!.anchors_json) as Array<Record<string, unknown>>;
      expect(updatedPolicy!.anchors_json).not.toContain(legacyJobUrl);
      expect(updatedPolicy!.anchors_json).not.toContain(legacyReason);
      expect(anchors).toHaveLength(2);
      const anchor = anchors.find((item) => String(item.anchor_id ?? "").startsWith("correction-anchor-"));
      expect(anchor).toBeDefined();
      expect(anchor).toMatchObject({
        job_ref_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        fit_score: 6,
        original_fit_score: 9,
        corrected_fit_score: 6,
        correction_delta: -3,
        correction_direction: "decreased",
        source_policy_version: 0,
      });
      expect(anchor).not.toHaveProperty("job_id");
      expect(anchor).not.toHaveProperty("rationale");
      expect(anchor!.anchor_id).toMatch(/^correction-anchor-/);
      expect(anchor!.dimensions).toEqual(["technical_fit", "experience_fit", "role_fit"]);
      const legacyAnchor = anchors.find((item) => item.anchor_id === "legacy-anchor");
      expect(legacyAnchor).toBeDefined();
      expect(legacyAnchor).toMatchObject({
        job_ref_hash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        fit_score: 5,
      });
      expect(legacyAnchor).not.toHaveProperty("job_id");
      expect(legacyAnchor).not.toHaveProperty("rationale");
    } finally {
      db.close();
      await app.close();
    }
  });

  it("marks comparable uncorrected scores stale when API correction changes the scoring policy", async () => {
    const seedDb = new Database(options.dbPath);
    const comparableUrl = "https://example.com/jobs/comparable-old-policy";
    const currentPolicyUrl = "https://example.com/jobs/current-policy";
    const alreadyCorrectedUrl = "https://example.com/jobs/already-corrected";
    insertJob(seedDb, {
      url: comparableUrl,
      title: "Comparable Engineer",
      site: "ExampleCo",
      fitScore: 7,
    });
    insertScore(seedDb, comparableUrl, 1, 7, { policyVersion: 1 });
    insertStage(seedDb, comparableUrl, "score", "succeeded");
    insertJob(seedDb, {
      url: currentPolicyUrl,
      title: "Already Current Engineer",
      site: "ExampleCo",
      fitScore: 8,
    });
    insertScore(seedDb, currentPolicyUrl, 1, 8, { policyVersion: 2 });
    insertStage(seedDb, currentPolicyUrl, "score", "succeeded");
    insertJob(seedDb, {
      url: alreadyCorrectedUrl,
      title: "Reviewed Engineer",
      site: "ExampleCo",
      fitScore: 6,
    });
    insertScore(seedDb, alreadyCorrectedUrl, 1, 6, { policyVersion: 1 });
    insertScore(seedDb, alreadyCorrectedUrl, 2, 8, {
      correction: {
        corrected_fit_score: 8,
        rationale: "Already corrected.",
        corrected_by: "local",
        corrected_at: "2026-04-29T10:06:00+00:00",
      },
      policyVersion: 1,
    });
    insertStage(seedDb, alreadyCorrectedUrl, "score", "succeeded");
    seedDb.close();

    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/score-correction`,
      payload: { correctedScore: 6, reason: "Manual review found a seniority mismatch." },
    });

    expect(response.statusCode, response.body).toBe(200);

    const db = new Database(options.dbPath);
    try {
      const comparable = db
        .prepare(
          `SELECT stale_reason, old_policy_version, new_policy_version, resolved
           FROM job_score_staleness
           WHERE job_url = ?`,
        )
        .get(comparableUrl) as {
        stale_reason: string;
        old_policy_version: number;
        new_policy_version: number;
        resolved: number;
      };
      expect(comparable).toMatchObject({
        stale_reason: "scoring_policy_changed",
        old_policy_version: 1,
        new_policy_version: 2,
        resolved: 0,
      });
      const excludedRows = db
        .prepare(
          `SELECT job_url
           FROM job_score_staleness
           WHERE job_url IN (?, ?, ?)`,
        )
        .all("https://example.com/jobs/ready", currentPolicyUrl, alreadyCorrectedUrl);
      expect(excludedRows).toEqual([]);
      const staleStage = db
        .prepare("SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'")
        .get(comparableUrl) as { state: string };
      expect(staleStage.state).toBe("stale");
      const event = db
        .prepare("SELECT event_type FROM job_events WHERE job_url = ? ORDER BY event_id DESC LIMIT 1")
        .get(comparableUrl) as { event_type: string };
      expect(event.event_type).toBe("ScoreMarkedStale");
    } finally {
      db.close();
      await app.close();
    }
  });

  it("resets stale score markers for explicit rescore through the API", async () => {
    const staleUrl = "https://example.com/jobs/stale-score";
    const seedDb = new Database(options.dbPath);
    insertJob(seedDb, {
      url: staleUrl,
      title: "Stale Engineer",
      site: "ExampleCo",
      fitScore: 7,
    });
    insertScore(seedDb, staleUrl, 1, 7, { policyVersion: 1 });
    insertStage(seedDb, staleUrl, "score", "stale");
    createScoreStalenessTable(seedDb);
    seedDb
      .prepare(
        `INSERT INTO job_score_staleness (
           tenant_id, job_url, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v2', 2, '2026-04-29T10:07:00+00:00', 0)`,
      )
      .run(staleUrl);
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "POST",
      url: "/v1/scoring/stale-scores/actions/reset-for-rescore",
      payload: { limit: 1, jobKeys: [staleUrl] },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [staleUrl],
      nextAction: "jobhunter run score --rescore",
    });

    const db = new Database(options.dbPath);
    try {
      const marker = db
        .prepare("SELECT resolved, resolved_at FROM job_score_staleness WHERE job_url = ?")
        .get(staleUrl) as { resolved: number; resolved_at: string | null };
      expect(marker.resolved).toBe(1);
      expect(marker.resolved_at).toBeTruthy();
      const stage = db
        .prepare("SELECT state, attempt_count FROM job_stage_states WHERE job_url = ? AND stage = 'score'")
        .get(staleUrl) as { state: string; attempt_count: number };
      expect(stage).toMatchObject({ state: "pending", attempt_count: 0 });
      const event = db
        .prepare("SELECT event_type, payload_json FROM job_events WHERE job_url = ? ORDER BY event_id DESC LIMIT 1")
        .get(staleUrl) as { event_type: string; payload_json: string };
      expect(event.event_type).toBe("ScoreRescoreRequested");
      expect(JSON.parse(event.payload_json)).toMatchObject({
        nextAction: "jobhunter run score --rescore",
        newPolicyVersion: 2,
      });
    } finally {
      db.close();
      await app.close();
    }
  });

  it("exposes score policy trace and unresolved staleness on job list and detail payloads", async () => {
    const staleUrl = "https://example.com/jobs/stale-read-model";
    const seedDb = new Database(options.dbPath);
    insertJob(seedDb, {
      url: staleUrl,
      title: "Read Model Stale Engineer",
      site: "ExampleCo",
      fitScore: 7,
    });
    insertScore(seedDb, staleUrl, 1, 7, { policyVersion: 1 });
    insertStage(seedDb, staleUrl, "score", "stale");
    createScoreStalenessTable(seedDb);
    seedDb
      .prepare(
        `INSERT INTO job_score_staleness (
           tenant_id, job_url, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v2', 2, '2026-04-29T10:07:00+00:00', 0)`,
      )
      .run(staleUrl);
    seedDb.close();

    const app = buildApp(options);
    try {
      const listResponse = await app.inject({ method: "GET", url: "/v1/jobs?pageSize=200" });
      const detailResponse = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent(staleUrl)}`,
      });

      expect(listResponse.statusCode, listResponse.body).toBe(200);
      expect(detailResponse.statusCode, detailResponse.body).toBe(200);
      const listJob = listResponse.json().items.find((job: { jobKey: string }) => job.jobKey === staleUrl);
      expect(listJob).toMatchObject({
      scoreTrace: {
        scoringPolicyId: "local:scoring-policy-v1",
        scoringPolicyVersion: 1,
        policyAnchorCount: 0,
      },
        scoreStaleness: {
          isStale: true,
          staleReason: "scoring_policy_changed",
          currentPolicyVersion: 1,
          targetPolicyVersion: 2,
          markedAt: "2026-04-29T10:07:00+00:00",
          pendingExplicitRescore: true,
        },
      });
      expect(detailResponse.json().job).toMatchObject({
        jobKey: staleUrl,
        scoreStaleness: listJob.scoreStaleness,
      scoreTrace: {
        scoringPolicyVersion: 1,
      },
    });
      expect(JSON.stringify(listJob.scoreTrace)).not.toContain("anchor_ids");
      expect(JSON.stringify(listJob.scoreTrace)).not.toContain("anchorIds");
    } finally {
      await app.close();
    }
  });

  it("returns artifact detail by artifact id", async () => {
    const app = buildApp(options);
    const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_txt" });
    const listBody = listResponse.json();
    const artifactId = encodeURIComponent(listBody.items[0].artifactId);
    const response = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}` });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      artifact: {
        jobKey: "https://example.com/jobs/ready",
        type: "tailored_resume_txt",
        status: "active",
      },
    });

    await app.close();
  });

  it("hides suppressed current tailored artifacts from active displays and apply readiness", async () => {
    const suppressedUrl = "https://example.com/jobs/suppressed-artifact";
    const suppressedPath = path.join(tempDir, "suppressed-resume.txt");
    fs.writeFileSync(suppressedPath, "suppressed resume");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    insertJob(seedDb, {
      url: suppressedUrl,
      title: "Suppressed Materials Engineer",
      site: "ExampleCo",
      fitScore: 9,
      tailoredPath: suppressedPath,
    });
    insertScore(seedDb, suppressedUrl, 1, 9);
    for (const stage of ["discover", "enrich", "score", "tailor", "cover"]) {
      insertStage(seedDb, suppressedUrl, stage, "succeeded");
    }
    insertStage(seedDb, suppressedUrl, "apply", "pending");
    insertMaterialsGeneration(seedDb, {
      jobUrl: suppressedUrl,
      artifactId: "artifact-suppressed-resume",
      artifactType: "tailored_resume",
      status: "suppressed",
      path: suppressedPath,
      metadata: { tailoring_policy_version: 1 },
    });
    seedDb.close();

    const app = buildApp(options);
    try {
      const detailResponse = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent(suppressedUrl)}`,
      });
      const defaultArtifactsResponse = await app.inject({
        method: "GET",
        url: "/v1/artifacts?type=tailored_resume",
      });
      const suppressedArtifactsResponse = await app.inject({
        method: "GET",
        url: "/v1/artifacts?type=tailored_resume&status=suppressed",
      });
      const artifactDetailResponse = await app.inject({
        method: "GET",
        url: "/v1/artifacts/artifact-suppressed-resume",
      });
      const dashboardResponse = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

      expect(detailResponse.statusCode, detailResponse.body).toBe(200);
      const detailBody = detailResponse.json();
      expect(detailBody.job).toMatchObject({
        jobKey: suppressedUrl,
        artifactCount: 0,
      });
      expect(detailBody.artifacts).toEqual([]);

      expect(defaultArtifactsResponse.statusCode, defaultArtifactsResponse.body).toBe(200);
      expect(
        defaultArtifactsResponse
          .json()
          .items.some((artifact: { artifactId: string }) => artifact.artifactId === "artifact-suppressed-resume"),
      ).toBe(false);

      expect(suppressedArtifactsResponse.statusCode, suppressedArtifactsResponse.body).toBe(200);
      expect(suppressedArtifactsResponse.json().items).toEqual([
        expect.objectContaining({
          artifactId: "artifact-suppressed-resume",
          jobKey: suppressedUrl,
          status: "suppressed",
          type: "tailored_resume",
        }),
      ]);

      expect(artifactDetailResponse.statusCode, artifactDetailResponse.body).toBe(200);
      expect(artifactDetailResponse.json().artifact).toMatchObject({
        artifactId: "artifact-suppressed-resume",
        status: "suppressed",
      });

      expect(dashboardResponse.statusCode, dashboardResponse.body).toBe(200);
      expect(dashboardResponse.json().totals.ready).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("exposes preparation policy versions, distinct outdated counts, and work-item counts in the dashboard summary", async () => {
    const seedDb = new Database(options.dbPath);
    createScoreStalenessTable(seedDb);
    createMaterialsTables(seedDb);
    seedDb.exec(`
      CREATE TABLE scoring_policies (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        version INTEGER NOT NULL,
        rubric_json TEXT NOT NULL,
        anchors_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_from_event_id INTEGER,
        PRIMARY KEY (tenant_id, version)
      );
      CREATE TABLE tailoring_policies (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        version INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, version)
      );
      CREATE TABLE preparation_work_items (
        item_id TEXT NOT NULL PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        target_version INTEGER NOT NULL,
        source_event_id TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL,
        idempotency_key TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        available_at TEXT NOT NULL
      );
    `);
    const insertScoringPolicy = seedDb.prepare(
      "INSERT INTO scoring_policies (tenant_id, version, rubric_json, anchors_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    insertScoringPolicy.run("local", 2, "{}", "[]", "2026-05-26T10:00:00+00:00");
    insertScoringPolicy.run("local", 3, "{}", "[]", "2026-05-26T10:05:00+00:00");
    seedDb
      .prepare("INSERT INTO tailoring_policies (tenant_id, version, created_at) VALUES (?, ?, ?)")
      .run("local", 2, "2026-05-26T10:00:00+00:00");
    seedDb
      .prepare(
        `INSERT INTO job_score_staleness (
           tenant_id, job_url, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v2', 2, '2026-05-26T10:01:00+00:00', 0)`,
      )
      .run("https://example.com/jobs/failed-score");
    seedDb
      .prepare(
        `INSERT INTO job_score_staleness (
           tenant_id, job_url, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v3', 3, '2026-05-26T10:06:00+00:00', 0)`,
      )
      .run("https://example.com/jobs/failed-score");
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/ready",
      artifactId: "artifact-ready-old-policy",
      artifactType: "tailored_resume",
      status: "approved",
      path: path.join(tempDir, "ready-resume.txt"),
      metadata: { tailoring_policy_version: 1 },
    });
    for (const [itemId, jobId, state] of [
      ["prep-queued", "https://example.com/jobs/ready", "queued"],
      ["prep-running", "https://example.com/jobs/failed-score", "running"],
      ["prep-failed", "https://example.com/jobs/blocked-tailor", "failed"],
    ] as const) {
      seedDb
        .prepare(
          `INSERT INTO preparation_work_items (
             item_id, tenant_id, job_id, kind, target_version, source_event_id, state,
             idempotency_key, attempts, last_error, created_at, updated_at, available_at
           ) VALUES (?, 'local', ?, 'rescore', 2, 'event-1', ?, ?, 0, '', ?, ?, ?)`,
        )
        .run(
          itemId,
          jobId,
          state,
          `${itemId}-key`,
          "2026-05-26T10:02:00+00:00",
          "2026-05-26T10:02:00+00:00",
          "2026-05-26T10:02:00+00:00",
        );
    }
    seedDb.close();

    const app = buildApp(options);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().preparation).toEqual({
        currentScoringPolicyVersion: 3,
        currentTailoringPolicyVersion: 2,
        outdatedScoreCount: 1,
        outdatedTailoredArtifactCount: 1,
        workItems: { queued: 1, running: 1, failed: 1 },
      });
    } finally {
      await app.close();
    }
  });

  it("does not count corrected old-policy scores as outdated when staleness markers are absent", async () => {
    const seedDb = new Database(options.dbPath);
    seedDb.exec(`
      CREATE TABLE scoring_policies (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        version INTEGER NOT NULL,
        rubric_json TEXT NOT NULL,
        anchors_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_from_event_id INTEGER,
        PRIMARY KEY (tenant_id, version)
      );
    `);
    seedDb
      .prepare(
        "INSERT INTO scoring_policies (tenant_id, version, rubric_json, anchors_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("local", 2, "{}", "[]", "2026-05-26T10:00:00+00:00");
    seedDb
      .prepare("UPDATE job_scores SET trace_json = ?")
      .run(JSON.stringify({ scoring_policy_id: "local:scoring-policy-v2", scoring_policy_version: 2 }));
    insertJob(seedDb, {
      url: "https://example.com/jobs/outdated-policy-score",
      title: "Outdated Score",
      site: "ExampleCo",
      fitScore: 8,
    });
    insertScore(seedDb, "https://example.com/jobs/outdated-policy-score", 1, 8, { policyVersion: 1 });
    insertJob(seedDb, {
      url: "https://example.com/jobs/corrected-policy-score",
      title: "Corrected Score",
      site: "ExampleCo",
      fitScore: 9,
    });
    insertScore(seedDb, "https://example.com/jobs/corrected-policy-score", 1, 9, {
      correction: { fit_score: 9, reason: "user corrected score" },
      policyVersion: 1,
    });
    seedDb.close();

    const app = buildApp(options);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().preparation.outdatedScoreCount).toBe(1);
    } finally {
      await app.close();
    }
  });

  it("does not count corrected latest scores as outdated when stale markers remain unresolved", async () => {
    const seedDb = new Database(options.dbPath);
    createScoreStalenessTable(seedDb);
    seedDb.exec(`
      CREATE TABLE scoring_policies (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        version INTEGER NOT NULL,
        rubric_json TEXT NOT NULL,
        anchors_json TEXT NOT NULL DEFAULT '[]',
        created_at TEXT NOT NULL,
        created_from_event_id INTEGER,
        PRIMARY KEY (tenant_id, version)
      );
    `);
    seedDb
      .prepare(
        "INSERT INTO scoring_policies (tenant_id, version, rubric_json, anchors_json, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .run("local", 3, "{}", "[]", "2026-05-26T10:00:00+00:00");
    insertJob(seedDb, {
      url: "https://example.com/jobs/stale-but-corrected",
      title: "Corrected Stale Score",
      site: "ExampleCo",
      fitScore: 9,
    });
    insertScore(seedDb, "https://example.com/jobs/stale-but-corrected", 1, 7, { policyVersion: 1 });
    insertScore(seedDb, "https://example.com/jobs/stale-but-corrected", 2, 9, {
      correction: { fit_score: 9, reason: "user corrected score" },
      policyVersion: 1,
    });
    seedDb
      .prepare(
        `INSERT INTO job_score_staleness (
           tenant_id, job_url, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v3', 3, '2026-05-26T10:06:00+00:00', 0)`,
      )
      .run("https://example.com/jobs/stale-but-corrected");
    seedDb.close();

    const app = buildApp(options);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().preparation.outdatedScoreCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("formats zero-byte artifacts as real files instead of missing files", async () => {
    const db = new Database(options.dbPath);
    db.prepare("UPDATE job_artifacts SET size_bytes = 0 WHERE artifact_type = ?").run("tailored_resume_txt");
    db.close();

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_txt" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().items[0]).toMatchObject({
      sizeBytes: 0,
      size: "0b",
    });

    await app.close();
  });

  it("returns 404 for unknown artifacts", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/artifacts/missing-artifact" });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: "artifact_not_found" });

    await app.close();
  });

  it("returns the workflow runs list from apply_run_projections", async () => {
    // PR 5 of the Temporal stack: `/v1/workflow-runs` is the read-side
    // surface for the new Workflow Runs view. The seed inserts a single
    // `apply_run_projections` row (`run-1`, status `finished` ⇒
    // normalized to `succeeded`), so the happy path returns one entry.
    const app = buildApp(options);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/workflow-runs" });
      expect(response.statusCode, response.body).toBe(200);
      const body = response.json();
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      const run = body.items.find((r: { workflowId: string }) => r.workflowId === "run-1");
      expect(run).toBeDefined();
      expect(run).toMatchObject({
        workflowId: "run-1",
        runId: "run-1",
        jobKey: "https://example.com/jobs/ready",
        title: "Platform Engineer",
        company: "ExampleCo",
        // Seed inserts `status: "finished"`, the read-model normalizes
        // it to the `WorkflowRunStatus` enum (`succeeded`).
        status: "succeeded",
        dryRun: true,
      });
      expect(body.pagination).toMatchObject({ page: 1, total: 1, pages: 1 });
      expect(body.filter).toMatchObject({ status: "all" });
      expect(body.sort).toMatchObject({ field: "started_at", dir: "desc" });
    } finally {
      await app.close();
    }
  });

  it("accepts workflow run sort fields", async () => {
    const app = buildApp(options);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?sort=title&dir=asc",
      });
      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().sort).toMatchObject({ field: "title", dir: "asc" });
    } finally {
      await app.close();
    }
  });

  it("filters workflow runs by status", async () => {
    const app = buildApp(options);
    try {
      const succeeded = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?status=succeeded",
      });
      expect(succeeded.statusCode, succeeded.body).toBe(200);
      expect(succeeded.json().items).toHaveLength(1);

      const failed = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?status=failed",
      });
      expect(failed.statusCode, failed.body).toBe(200);
      expect(failed.json().items).toHaveLength(0);
    } finally {
      await app.close();
    }
  });

  it("opens only a known existing artifact through the injected opener", async () => {
    const opened: string[] = [];
    const app = buildApp({
      ...options,
      artifactOpener: async (artifactPath) => {
        opened.push(artifactPath);
      },
    });
    const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_txt" });
    const artifact = listResponse.json().items[0];
    const response = await app.inject({
      method: "POST",
      url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/open`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      opened: true,
      path: artifact.localPath,
    });
    expect(opened).toEqual([artifact.localPath]);

    await app.close();
  });

  it("resolves legacy artifact ids with slashes for detail and open routes", async () => {
    const opened: string[] = [];
    const app = buildApp({
      ...options,
      artifactOpener: async (artifactPath) => {
        opened.push(artifactPath);
      },
    });
    const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_pdf" });
    const artifact = listResponse.json().items[0];
    fs.writeFileSync(artifact.localPath, "%PDF test");
    const artifactId = encodeURIComponent(artifact.artifactId);

    const detailResponse = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}` });
    const previewResponse = await app.inject({ method: "GET", url: `/v1/artifacts/${artifactId}/preview.pdf` });
    const openResponse = await app.inject({ method: "POST", url: `/v1/artifacts/${artifactId}/open` });

    expect(detailResponse.statusCode, detailResponse.body).toBe(200);
    expect(detailResponse.json()).toMatchObject({
      ok: true,
      artifact: {
        artifactId: artifact.artifactId,
        jobKey: "https://example.com/jobs/ready",
        type: "tailored_resume_pdf",
      },
    });
    expect(previewResponse.statusCode, previewResponse.body).toBe(200);
    expect(previewResponse.headers["content-type"]).toContain("application/pdf");
    expect(previewResponse.body).toBe("%PDF test");
    expect(openResponse.statusCode, openResponse.body).toBe(200);
    expect(openResponse.json()).toMatchObject({
      ok: true,
      opened: true,
      path: artifact.localPath,
    });
    expect(opened).toEqual([artifact.localPath]);

    await app.close();
  });

  it("rejects artifact open when the known local file is missing", async () => {
    const opened = vi.fn();
    const db = new Database(options.dbPath);
    const artifactPath = db.prepare("SELECT path FROM job_artifacts LIMIT 1").get() as { path: string };
    fs.rmSync(artifactPath.path);
    db.close();

    const app = buildApp({ ...options, artifactOpener: opened });
    const response = await app.inject({ method: "POST", url: "/v1/artifacts/1/open" });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: "artifact_missing" });
    expect(opened).not.toHaveBeenCalled();

    await app.close();
  });

  it("resets a retry stage through a structured job action", async () => {
    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/failed-score");
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retry-stage`,
      payload: { stage: "score", resetAttempts: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "retry_stage",
      status: "reset",
      stage: {
        stage: "score",
        state: "pending",
        attemptCount: 0,
      },
    });

    const db = new Database(options.dbPath);
    const job = db.prepare("SELECT fit_score, scored_at FROM jobs WHERE url = ?").get("https://example.com/jobs/failed-score") as {
      fit_score: number | null;
      scored_at: string | null;
    };
    const event = db.prepare("SELECT stage, level, message FROM job_events ORDER BY event_id DESC LIMIT 1").get() as {
      stage: string;
      level: string;
      message: string;
    };
    db.close();
    expect(job).toMatchObject({ fit_score: null, scored_at: null });
    expect(event).toMatchObject({ stage: "score", level: "info", message: "Retry reset requested for score" });

    await app.close();
  });

  it("resets selected failed jobs through the bulk retry action", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-retry-failed",
      payload: {
        allMatching: false,
        jobKeys: ["https://example.com/jobs/failed-score", "https://example.com/jobs/ready"],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: ["https://example.com/jobs/failed-score"],
    });

    const db = new Database(options.dbPath);
    const failed = db
      .prepare("SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'")
      .get("https://example.com/jobs/failed-score") as { state: string };
    const ready = db
      .prepare("SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'")
      .get("https://example.com/jobs/ready") as { state: string };
    const event = db
      .prepare("SELECT message FROM job_events WHERE job_url = ? ORDER BY event_id DESC LIMIT 1")
      .get("https://example.com/jobs/failed-score") as { message: string };
    db.close();

    expect(failed.state).toBe("pending");
    expect(ready.state).toBe("succeeded");
    expect(event.message).toBe("Retry reset requested for score");

    await app.close();
  });

  // Phase 7 (S-26 round-1 review B2 + round-2 L4): API-driven retry-enrich
  // MUST clear the ``job_enrichments`` aggregate's terminal-state fields,
  // otherwise the worker's ``_ENRICHMENT_PENDING`` queue predicate
  // permanently excludes the row and the retry is a silent no-op. Mirror
  // of the Python ``test_reset_job_stage_enrich_clears_job_enrichments_aggregate``
  // — exercises ``resetEnrichmentAggregate`` in
  // ``apps/api/src/write-model.ts`` end-to-end through the HTTP route.
  it("retry-enrich resets the job_enrichments aggregate to pending", async () => {
    // Seed an enriched aggregate row directly — independent of the rest
    // of the fixture so the test is self-contained.
    const seedDb = new Database(options.dbPath);
    seedDb.prepare(
      `INSERT INTO job_enrichments (
         job_url, tenant_id, current_status, full_description,
         application_url, enriched_at, extraction_tier,
         attempts_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "https://example.com/jobs/failed-score",
      "local",
      "enriched",
      "The full job description.",
      "https://example.com/apply",
      "2026-04-29T10:01:00+00:00",
      "json_ld",
      '[{"attempt_number":1,"status":"succeeded","extraction_tier":"json_ld",'
        + '"started_at":"t0","finished_at":"t1","error":null}]',
      "2026-04-29T10:01:00+00:00",
    );
    seedDb.close();

    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/failed-score");
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retry-stage`,
      payload: { stage: "enrich", resetAttempts: true },
    });
    expect(response.statusCode, response.body).toBe(200);

    const db = new Database(options.dbPath);
    const enrichment = db
      .prepare(
        `SELECT current_status, full_description, application_url,
                enriched_at, extraction_tier
         FROM job_enrichments WHERE job_url = ?`,
      )
      .get("https://example.com/jobs/failed-score") as {
      current_status: string;
      full_description: string | null;
      application_url: string | null;
      enriched_at: string | null;
      extraction_tier: string | null;
    };
    // Sanity: legacy columns are also nulled (existing behavior).
    const legacyJob = db
      .prepare(
        "SELECT detail_scraped_at, detail_error FROM jobs WHERE url = ?",
      )
      .get("https://example.com/jobs/failed-score") as {
      detail_scraped_at: string | null;
      detail_error: string | null;
    };
    db.close();

    expect(enrichment.current_status).toBe("pending");
    expect(enrichment.full_description).toBeNull();
    expect(enrichment.application_url).toBeNull();
    expect(enrichment.enriched_at).toBeNull();
    expect(enrichment.extraction_tier).toBeNull();
    expect(legacyJob.detail_scraped_at).toBeNull();
    expect(legacyJob.detail_error).toBeNull();

    await app.close();
  });

  it("retry-enrich is a no-op when no job_enrichments row exists", async () => {
    // Confirm ``resetEnrichmentAggregate`` doesn't crash when the
    // aggregate row was never written (job in legacy-only state). The
    // legacy column reset still fires; the JE update is a 0-row UPDATE.
    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/blocked-tailor");
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retry-stage`,
      payload: { stage: "enrich", resetAttempts: true },
    });
    expect(response.statusCode, response.body).toBe(200);

    const db = new Database(options.dbPath);
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM job_enrichments WHERE job_url = ?")
      .get("https://example.com/jobs/blocked-tailor") as { c: number };
    db.close();
    expect(count.c).toBe(0); // still no row — UPDATE was a no-op
    await app.close();
  });

  it("dispatches run-after apply retry through the job-scoped action dispatcher path", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const retryResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retry-stage`,
      payload: { stage: "apply", runAfter: true, dryRun: true },
    });

    expect(retryResponse.statusCode, retryResponse.body).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "retry_stage",
        jobKey: "https://example.com/jobs/ready",
        stage: "apply",
        runAfter: true,
        dryRun: true,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("rejects unsupported per-job material generation and run-after material retries without dispatching", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const generateResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/generate-materials`,
      payload: { stages: ["tailor", "cover"], dryRun: true, limit: 1 },
    });
    const retryResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retry-stage`,
      payload: { stage: "cover", runAfter: true, dryRun: true },
    });

    expect(generateResponse.statusCode, generateResponse.body).toBe(400);
    expect(generateResponse.json()).toMatchObject({
      ok: false,
      accepted: false,
      error: "unsupported_per_job_material_action",
      jobKey: "https://example.com/jobs/ready",
    });
    expect(retryResponse.statusCode, retryResponse.body).toBe(400);
    expect(retryResponse.json()).toMatchObject({
      ok: false,
      accepted: false,
      error: "unsupported_per_job_material_action",
    });
    expect(dispatch).not.toHaveBeenCalled();

    const db = new Database(options.dbPath);
    const coverStage = db
      .prepare("SELECT state FROM job_stage_states WHERE job_url = ? AND stage = ?")
      .get("https://example.com/jobs/ready", "cover") as { state: string };
    db.close();
    expect(coverStage.state).toBe("succeeded");

    await app.close();
  });

  it("does not translate unsupported material actions into global stage CLI commands", async () => {
    await expect(
      defaultActionDispatcher(
        {
          action: "generate_materials",
          jobKey: "https://example.com/jobs/ready",
          stages: ["tailor"],
          limit: 1,
          dryRun: true,
        },
        { appDir: tempDir, dbPath: options.dbPath },
      ),
    ).resolves.toMatchObject({
      status: "unsupported",
      message: "No job-scoped local command is available for this action.",
    });
    await expect(
      defaultActionDispatcher(
        {
          action: "retry_stage",
          jobKey: "https://example.com/jobs/ready",
          stage: "tailor",
          runAfter: true,
          limit: 1,
          dryRun: true,
        },
        { appDir: tempDir, dbPath: options.dbPath },
      ),
    ).resolves.toMatchObject({
      status: "unsupported",
      message: "No job-scoped local command is available for this action.",
    });
  });

  it("validates job action bodies before dispatch", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retry-stage`,
      payload: { stage: "not-a-stage" },
    });

    expect(response.statusCode).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();

    await app.close();
  });

  it("defaults apply actions to dry-run dispatch", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", runId: "run-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/apply`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "apply",
      status: "queued",
      command: {
        dryRun: true,
        limit: 1,
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "apply", dryRun: true, jobKey: "https://example.com/jobs/ready" }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("dispatches current-policy rescore and re-tailor maintenance actions", async () => {
    const dispatch = vi.fn(async (command: ActionCommandPayload): Promise<ActionDispatchResult> => ({
      status: "queued",
      runId: `run-${command.action}`,
      result: { ok: true, action: command.action },
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const rescoreJob = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/rescore-current-policy`,
      payload: { dryRun: true, reason: "policy refresh" },
    });
    const rescoreBulk = await app.inject({
      method: "POST",
      url: "/v1/scoring/actions/rescore-current-policy",
      payload: { jobKeys: ["https://example.com/jobs/failed-score"], limit: 10, dryRun: true },
    });
    const retailorJob = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retailor-current-policy`,
      payload: {
        dryRun: true,
        suppressExistingArtifacts: false,
        tailorModels: ["gemini:test"],
        tailorJudgeModel: "judge:test",
        tailorJudgeMinScore: 0.82,
        reason: "policy refresh",
      },
    });
    const retailorBulk = await app.inject({
      method: "POST",
      url: "/v1/materials/actions/retailor-current-policy",
      payload: {
        jobKeys: ["https://example.com/jobs/ready"],
        limit: 5,
        dryRun: false,
        suppressExistingArtifacts: true,
      },
    });

    for (const response of [rescoreJob, rescoreBulk, retailorJob, retailorBulk]) {
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({ ok: true, status: "queued" });
    }
    expect(dispatch).toHaveBeenCalledTimes(4);
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "rescore_job",
        jobKey: "https://example.com/jobs/ready",
        dryRun: true,
        reason: "policy refresh",
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        action: "rescore_jobs_not_on_current_scoring_policy",
        jobKey: "pipeline",
        jobKeys: ["https://example.com/jobs/failed-score"],
        limit: 10,
        dryRun: true,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        action: "retailor_job",
        jobKey: "https://example.com/jobs/ready",
        dryRun: true,
        suppressExistingArtifacts: false,
        tailorModels: ["gemini:test"],
        tailorJudgeModel: "judge:test",
        tailorJudgeMinScore: 0.82,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        action: "retailor_current_policy",
        jobKey: "pipeline",
        jobKeys: ["https://example.com/jobs/ready"],
        limit: 5,
        dryRun: false,
        suppressExistingArtifacts: true,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("dispatches global pipeline stage runs with shared stage options and safe apply defaults", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: {
        stages: ["score", "tailor", "apply"],
        limit: 1000,
        workers: 3,
        minScore: 8,
        validationMode: "strict",
        dryRun: true,
        rescore: true,
        retailor: true,
        headless: true,
        model: "sonnet",
        continuous: true,
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    const body = response.json();
    expect(body).toMatchObject({
      ok: true,
      action: "run_stage",
      status: "queued",
      jobKey: "pipeline",
      count: 1,
      actions: [
        {
          action: "run_stage",
          status: "queued",
          jobKey: "pipeline",
          command: {
            action: "run_stage",
            jobKey: "pipeline",
            stage: "score",
            stages: ["score", "tailor", "apply"],
            limit: 1000,
            workers: 3,
            minScore: 8,
            validationMode: "strict",
            dryRun: true,
            rescore: true,
            retailor: true,
            headless: true,
            model: "sonnet",
            continuous: true,
          },
        },
      ],
    });
    expect(body.command).not.toHaveProperty("tailorJudgeMinScore");
    await waitForExpectation(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const dispatchedCommand = (dispatch.mock.calls as unknown as Array<[ActionCommandPayload, unknown]>)[0]?.[0];
    expect(dispatchedCommand).not.toHaveProperty("tailorJudgeMinScore");
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "run_stage",
        stage: "score",
        stages: ["score", "tailor", "apply"],
        dryRun: true,
        headless: true,
        model: "sonnet",
        continuous: true,
        jobKey: "pipeline",
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("rejects direct top-level enrich runs because Discovery owns detail enrichment", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["enrich"], dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();

    await app.close();
  });

  it("returns queued non-apply global stage workflow starts as 202", async () => {
    const dispatch = vi.fn(async () => ({
      status: "queued",
      runId: "pipeline-wf",
      workflowId: "pipeline-wf",
      firstExecutionRunId: "first-exec-run-id",
      result: {
        runId: "pipeline-wf",
        workflowId: "pipeline-wf",
        firstExecutionRunId: "first-exec-run-id",
      },
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["score"], dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "queued",
      count: 1,
      actions: [
        {
          action: "run_stage",
          actionId: "pipeline-wf",
          runId: "pipeline-wf",
          workflowId: "pipeline-wf",
          firstExecutionRunId: "first-exec-run-id",
          status: "queued",
          result: {
            runId: "pipeline-wf",
            workflowId: "pipeline-wf",
            firstExecutionRunId: "first-exec-run-id",
          },
          command: { action: "run_stage", stage: "score", dryRun: true },
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "run_stage", stage: "score", jobKey: "pipeline" }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("starts one ordered pipeline workflow for mixed stage requests", async () => {
    const pipelineDispatch = deferred<ActionDispatchResult>();
    const dispatch = vi.fn((command: ActionCommandPayload) => {
      if (command.action === "run_stage") return pipelineDispatch.promise;
      throw new Error(`Unexpected stage ${String(command.stage)}`);
    });
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const responsePromise = app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["score", "tailor", "apply"], dryRun: true },
    });

    try {
      await waitForExpectation(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({
        action: "run_stage",
        stage: "score",
        stages: ["score", "tailor", "apply"],
      });

      const earlyResponse = await Promise.race([
        responsePromise,
        new Promise<"not-yet">((resolve) => setTimeout(() => resolve("not-yet"), 50)),
      ]);
      expect(earlyResponse).toBe("not-yet");

      pipelineDispatch.resolve({ status: "queued", runId: "run-pipeline" });
      const response = await responsePromise;
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        ok: true,
        status: "queued",
        count: 1,
        actions: [
          {
            action: "run_stage",
            actionId: "run-pipeline",
            runId: "run-pipeline",
            status: "queued",
            command: { action: "run_stage", stage: "score", stages: ["score", "tailor", "apply"], dryRun: true },
          },
        ],
      });
    } finally {
      pipelineDispatch.resolve({ status: "queued", runId: "run-pipeline" });
      await responsePromise.catch(() => undefined);
      await app.close();
    }
  });

  it("does not return accepted when mixed pipeline workflow dispatch fails", async () => {
    const dispatch = vi.fn(async (_command: ActionCommandPayload): Promise<ActionDispatchResult> => {
      return {
        status: "failed",
        message: "Temporal workflow start failed.",
        result: { code: "TEMPORAL_UNAVAILABLE" },
      };
    });
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["score", "apply"], dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "failed",
      count: 1,
      actions: [
        {
          action: "run_stage",
          status: "failed",
          message: "Temporal workflow start failed.",
          result: { code: "TEMPORAL_UNAVAILABLE" },
          command: { action: "run_stage", stage: "score", stages: ["score", "apply"], dryRun: true },
        },
      ],
    });
    expect(dispatch.mock.calls.map(([command]) => command.action)).toEqual(["run_stage"]);

    await app.close();
  });

  it("defaults global apply stage starts to dry-run when dryRun is omitted", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", runId: "run-pipeline" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["apply"] },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "queued",
      actions: [
        {
          action: "run_stage",
          actionId: "run-pipeline",
          runId: "run-pipeline",
          status: "queued",
          command: { action: "run_stage", stage: "apply", stages: ["apply"], dryRun: true, limit: 25, workers: 1, minScore: 7 },
        },
      ],
    });
    await waitForExpectation(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "run_stage", stage: "apply", stages: ["apply"], dryRun: true, jobKey: "pipeline" }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("marks jobs applied and skipped through structured actions", async () => {
    const app = buildApp(options);
    const appliedKey = encodeURIComponent("https://example.com/jobs/ready");
    const skippedKey = encodeURIComponent("https://example.com/jobs/blocked-tailor");

    const applied = await app.inject({
      method: "POST",
      url: `/v1/jobs/${appliedKey}/actions/mark-applied`,
      payload: { reason: "manual confirmation" },
    });
    const skipped = await app.inject({
      method: "POST",
      url: `/v1/jobs/${skippedKey}/actions/mark-skipped`,
      payload: { reason: "not a fit" },
    });

    expect(applied.statusCode, applied.body).toBe(200);
    expect(skipped.statusCode, skipped.body).toBe(200);
    expect(applied.json()).toMatchObject({ action: "mark_applied", stage: { state: "succeeded" } });
    expect(skipped.json()).toMatchObject({ action: "mark_skipped", stage: { state: "skipped" } });

    await app.close();
  });

  it("rejects malformed job detail routes before lookup", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/jobs/%E0%A4%A" });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: "FST_ERR_BAD_URL" });

    await app.close();
  });

  it("imports legacy profile files once and returns relational profile configuration", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/profile" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      ok: true,
      profile: { personal: { full_name: "Jordan Candidate" } },
      style: { font_family: "sans" },
      templateText: "\\documentclass{article}",
    });
    expect(body.paths).toBeUndefined();
    const db = new Database(options.dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM candidate_profiles").get()).toMatchObject({ count: 1 });
      const rootColumns = db.prepare("PRAGMA table_info(candidate_profiles)").all() as Array<{ name: string }>;
      expect(rootColumns.map((column) => column.name)).not.toEqual(
        expect.arrayContaining(["profile_json", "style_json", "payload_json"]),
      );
    } finally {
      db.close();
    }

    await app.close();
  });

  it("seeds a default resume template when the legacy template file is missing", async () => {
    fs.rmSync(options.resumeTemplatePath, { force: true });
    const app = buildApp(options);
    const initial = await app.inject({ method: "GET", url: "/v1/profile" });

    expect(initial.statusCode, initial.body).toBe(200);
    const initialBody = initial.json();
    expect(initialBody.templateText).toContain("{{ personal_data }}");

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: validProfileFixture("Template Save"),
        style: initialBody.style,
        templateText: initialBody.templateText,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      profile: { personal: { full_name: "Template Save" } },
    });
    const db = new Database(options.dbPath);
    try {
      const row = db.prepare("SELECT resume_template_text FROM candidate_profiles").get() as {
        resume_template_text: string;
      };
      expect(row.resume_template_text).toContain("{{ personal_data }}");
    } finally {
      db.close();
    }

    await app.close();
  });

  it("persists profile, style, and template updates to relational rows without rewriting legacy files", async () => {
    const app = buildApp(options);
    const originalLegacyProfile = fs.readFileSync(options.profilePath, "utf8");
    const validProfile = validProfileFixture("Taylor Updated");
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: validProfile,
        style: { moderncv_style: "classic" },
        templateText: "\\documentclass{moderncv}",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      profile: { personal: { full_name: "Taylor Updated" } },
      style: { moderncv_style: "classic" },
      templateText: "\\documentclass{moderncv}",
    });
    expect(fs.readFileSync(options.profilePath, "utf8")).toBe(originalLegacyProfile);
    const db = new Database(options.dbPath);
    try {
      expect(
        db.prepare(
          "SELECT personal_full_name, resume_style_font_family, resume_style_moderncv_style, resume_template_text FROM candidate_profiles",
        ).get(),
      ).toMatchObject({
        personal_full_name: "Taylor Updated",
        resume_style_moderncv_style: "classic",
        resume_template_text: "\\documentclass{moderncv}",
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM candidate_profile_experience_bullets").get()).toMatchObject({
        count: 1,
      });
    } finally {
      db.close();
    }

    await app.close();
  });

  it("validates target-search locations before saving profile preferences", async () => {
    const placeValidator = vi.fn(async (place: string) => place === "Barcelona, Spain");
    const app = buildApp({ ...options, placeValidator });
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: profileWithTargetSearch("Location Target", "Barcelona, Spain", "Remote"),
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(placeValidator).toHaveBeenCalledWith("Barcelona, Spain");
    const db = new Database(options.dbPath);
    try {
      expect(
        db.prepare(
          `SELECT
             experience_target_role,
             experience_target_track,
             experience_target_seniority_floor,
             experience_target_functions,
             experience_target_specializations,
             experience_target_locations,
             experience_target_work_models
           FROM candidate_profiles`,
        ).get(),
      ).toMatchObject({
        experience_target_role: "Principal Platform Engineer",
        experience_target_track: "IC",
        experience_target_seniority_floor: "Principal",
        experience_target_functions: "Platform",
        experience_target_specializations: "SaaS",
        experience_target_locations: "Barcelona, Spain",
        experience_target_work_models: "Remote",
      });
    } finally {
      db.close();
    }

    await app.close();
  });

  it("rejects target-search locations that do not resolve to real places", async () => {
    const dispatch = vi.fn(async (): Promise<ActionDispatchResult> => ({ status: "queued", runId: "run-retailor" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch, placeValidator: vi.fn(async () => false) });
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: profileWithTargetSearch("Bad Location", "Atlantis", "Hybrid"),
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "invalid_profile",
      message: 'target location "Atlantis" does not resolve to a real place.',
    });
    expect(dispatch).not.toHaveBeenCalled();

    await app.close();
  });

  it("records profile updates and starts an event-driven re-tailoring run", async () => {
    const dispatch = vi.fn(async (): Promise<ActionDispatchResult> => ({ status: "queued", runId: "run-retailor" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile: validProfileFixture("Event Driven Candidate") },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "pipeline",
        stage: "tailor",
        stages: ["tailor"],
        dryRun: false,
        limit: 0,
        minScore: 0,
        retailor: true,
      }),
      { appDir: tempDir, dbPath: options.dbPath },
    );

    const db = new Database(options.dbPath);
    try {
      const event = db
        .prepare(
          "SELECT job_url, stage, event_type, payload_json FROM job_events WHERE event_type = 'ProfileUpdated' ORDER BY event_id DESC LIMIT 1",
        )
        .get() as { job_url: string | null; stage: string | null; event_type: string; payload_json: string };
      expect(event).toMatchObject({
        job_url: null,
        stage: null,
        event_type: "ProfileUpdated",
      });
      expect(JSON.parse(event.payload_json)).toMatchObject({
        tenantId: "local",
        changedSections: ["profile"],
        updatedAt: expect.any(String),
      });
    } finally {
      db.close();
    }

    await app.close();
  });

  it("preserves existing non-default style fields during partial style updates", async () => {
    fs.writeFileSync(options.resumeStylePath, JSON.stringify({ font_family: "roman", moderncv_color: "blue" }));
    const app = buildApp(options);
    await app.inject({ method: "GET", url: "/v1/profile" });

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        style: { moderncv_style: "classic" },
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      style: {
        font_family: "roman",
        moderncv_color: "blue",
        moderncv_style: "classic",
      },
    });

    await app.close();
  });

  it("rejects unsupported top-level profile fields before storing updates", async () => {
    const app = buildApp(options);
    const profile = { ...validProfileFixture("Future Candidate"), custom_section: { future: "thing" } };
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "invalid_profile",
    });
    expect(response.json().message).toContain("unsupported top-level profile field(s): custom_section");

    await app.close();
  });

  it("rejects unsupported top-level legacy profile fields before import", async () => {
    fs.writeFileSync(
      options.profilePath,
      JSON.stringify({ ...validProfileFixture("Future Legacy"), custom_section: { future: "thing" } }),
    );
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/profile" });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "invalid_profile",
    });
    expect(response.json().message).toContain("unsupported top-level profile field(s): custom_section");

    await app.close();
  });

  it("rejects invalid profile JSON writes", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profileText: "{" },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: "invalid_profile" });

    await app.close();
  });

  it("validates all profile update inputs before changing relational rows", async () => {
    const app = buildApp(options);
    const originalProfile = fs.readFileSync(options.profilePath, "utf8");
    const originalStyle = fs.readFileSync(options.resumeStylePath, "utf8");
    await app.inject({ method: "GET", url: "/v1/profile" });
    const db = new Database(options.dbPath);
    const before = db.prepare("SELECT personal_full_name FROM candidate_profiles").get();
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: validProfileFixture("Should Not Persist"),
        styleText: "{",
      },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: "invalid_profile" });
    expect(fs.readFileSync(options.profilePath, "utf8")).toBe(originalProfile);
    expect(fs.readFileSync(options.resumeStylePath, "utf8")).toBe(originalStyle);
    expect(db.prepare("SELECT personal_full_name FROM candidate_profiles").get()).toEqual(before);
    db.close();

    await app.close();
  });

  it("imports resume PDFs through an injected profile importer without running Python in tests", async () => {
    const importer = vi.fn(async (input) => ({
      profile: { personal: { full_name: "Imported Candidate" } },
      style: { font_family: "imported" },
      templateText: "\\documentclass{article}",
      source: { filename: input.filename, bytes: input.pdfBytes.length },
    }));
    const app = buildApp({ ...options, profileImporter: importer });
    const response = await app.inject({
      method: "POST",
      url: "/v1/profile/import-resume",
      payload: {
        filename: "resume.pdf",
        pdfBase64: Buffer.from("%PDF test").toString("base64"),
        importProfile: true,
        importStyle: true,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      profile: { personal: { full_name: "Imported Candidate" } },
      style: { font_family: "imported" },
      source: { filename: "resume.pdf", bytes: 9 },
    });
    expect(importer).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: "resume.pdf",
        importProfile: true,
        importStyle: true,
        pdfBytes: expect.any(Buffer),
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("rejects malformed resume import payloads before importer dispatch", async () => {
    const importer = vi.fn();
    const app = buildApp({ ...options, profileImporter: importer });
    const response = await app.inject({
      method: "POST",
      url: "/v1/profile/import-resume",
      payload: { filename: "resume.pdf", pdfBase64: "not base64 !!" },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ ok: false, error: "invalid_profile_import" });
    expect(importer).not.toHaveBeenCalled();

    await app.close();
  });

  it("serves a rendered profile PDF preview", async () => {
    const renderer = vi.fn(async () => Buffer.from("%PDF-1.7\nmock preview"));
    const app = buildApp({ ...options, profilePreviewRenderer: renderer });
    const response = await app.inject({ method: "GET", url: "/v1/profile/preview.pdf" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("application/pdf");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.rawPayload.subarray(0, 5).toString()).toBe("%PDF-");
    expect(renderer).toHaveBeenCalledWith(
      {
        profile: expect.objectContaining({ personal: expect.objectContaining({ full_name: "Jordan Candidate" }) }),
        templateText: "\\documentclass{article}",
      },
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("returns normalized runtime settings", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      settings: {
        targetRole: "Platform Engineering",
        locationFilter: "Remote",
        minFitScore: 8,
        autoApply: true,
        applyConcurrency: 3,
        scoreCriteria: "Security leadership and platform reliability.",
        targetCriteria: "Director-plus infrastructure and security roles.",
      },
      paths: {
        settingsPath: options.settingsPath,
      },
    });

    await app.close();
  });

  it("falls back to defaults when settings are missing", async () => {
    fs.rmSync(options.settingsPath);
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      settings: {
        targetRole: "",
        locationFilter: "",
        minFitScore: 7,
        autoApply: false,
        applyConcurrency: 1,
        scoreCriteria: "",
        targetCriteria: "",
      },
    });

    await app.close();
  });

  it("persists editable runtime settings", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: {
        targetRole: "CISO",
        locationFilter: "Europe remote",
        minFitScore: 9,
        autoApply: false,
        applyConcurrency: 2,
        scoreCriteria: "Prioritize platform security, DevSecOps, and leadership scope.",
        targetCriteria: "Target senior engineering leadership roles.",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      settings: {
        targetRole: "CISO",
        locationFilter: "Europe remote",
        minFitScore: 9,
        autoApply: false,
        applyConcurrency: 2,
        scoreCriteria: "Prioritize platform security, DevSecOps, and leadership scope.",
        targetCriteria: "Target senior engineering leadership roles.",
      },
    });
    expect(JSON.parse(fs.readFileSync(options.settingsPath, "utf8"))).toMatchObject({
      target_role: "CISO",
      location_filter: "Europe remote",
      min_fit_score: 9,
      auto_apply: false,
      apply_concurrency: 2,
      score_criteria: "Prioritize platform security, DevSecOps, and leadership scope.",
      target_criteria: "Target senior engineering leadership roles.",
    });

    await app.close();
  });

  it("stores credential configuration through the injected credential store", async () => {
    const stored = new Map<CredentialKey, string>();
    const credentialStore = {
      list: vi.fn(async () => ({
        ok: true as const,
        credentials: CredentialKeys.map((key) => ({
          key,
          label: key,
          configured: stored.has(key),
          storage: "keychain" as const,
        })),
      })),
      set: vi.fn(async (key: CredentialKey, value: string) => {
        stored.set(key, value);
        return credentialStore.list();
      }),
      delete: vi.fn(async (key: CredentialKey) => {
        stored.delete(key);
        return credentialStore.list();
      }),
    };
    const app = buildApp({ ...options, credentialStore });

    const initial = await app.inject({ method: "GET", url: "/v1/credentials" });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json().credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "OPENAI_API_KEY", configured: false, storage: "keychain" }),
        expect.objectContaining({ key: "GEMINI_API_KEY", configured: false, storage: "keychain" }),
      ]),
    );

    const save = await app.inject({
      method: "PATCH",
      url: "/v1/credentials",
      payload: { key: "OPENAI_API_KEY", value: "test-secret" },
    });
    expect(save.statusCode, save.body).toBe(200);
    expect(credentialStore.set).toHaveBeenCalledWith("OPENAI_API_KEY", "test-secret");
    expect(save.json().credentials.find((credential: { key: string }) => credential.key === "OPENAI_API_KEY")).toMatchObject({
      configured: true,
    });

    const remove = await app.inject({ method: "DELETE", url: "/v1/credentials/OPENAI_API_KEY" });
    expect(remove.statusCode, remove.body).toBe(200);
    expect(credentialStore.delete).toHaveBeenCalledWith("OPENAI_API_KEY");
    expect(remove.json().credentials.find((credential: { key: string }) => credential.key === "OPENAI_API_KEY")).toMatchObject({
      configured: false,
    });

    await app.close();
  });

  // -------------------------------------------------------------------------
  // S-12: §8.5 state-machine gate + JSON-RPC envelope endpoint
  // -------------------------------------------------------------------------

  it("rejects illegal stage transitions through validateStageTransition", async () => {
    const { validateStageTransition, InputError } = await import("../src/write-model.js");
    const db = new Database(options.dbPath);
    try {
      // Pending → Succeeded is not a row in §8.5.
      expect(() =>
        validateStageTransition(db, "https://example.com/jobs/ready", "apply", "succeeded"),
      ).toThrow(InputError);
      // Succeeded → Pending is not allowed (only Stale → Pending).
      expect(() =>
        validateStageTransition(db, "https://example.com/jobs/ready", "score", "pending"),
      ).toThrow(InputError);
      // Failed → Pending IS allowed (row 10).
      expect(() =>
        validateStageTransition(db, "https://example.com/jobs/failed-score", "score", "pending"),
      ).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("admin-override commands bypass the §8.5 gate to mirror Python parity", async () => {
    // The seed has apply=pending; markJobApplied is an admin override and
    // must succeed even though Pending → Succeeded is not in the §8.5 table.
    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/mark-applied`,
      payload: { reason: "external" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().stage.state).toBe("succeeded");
    await app.close();
  });

  it("/v1/_internal/rpc accepts a JSON-RPC envelope and returns a valid response", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "POST",
      url: "/v1/_internal/rpc",
      payload: {
        jsonrpc: "2.0",
        method: "reset_stage",
        params: { tenantId: "local", jobUrl: "https://example.com/job/1", stage: "score" },
        id: 7,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 7 });
    expect(body.result).toMatchObject({ method: "reset_stage", status: "accepted" });
    expect(body.error).toBeUndefined();

    await app.close();
  });

  it("/v1/_internal/rpc rejects malformed JSON-RPC envelopes with code -32600", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "POST",
      url: "/v1/_internal/rpc",
      payload: { not: "json-rpc", id: 9 },
    });

    expect(response.statusCode, response.body).toBe(400);
    const body = response.json();
    expect(body).toMatchObject({ jsonrpc: "2.0", id: 9 });
    expect(body.error.code).toBe(-32600);

    await app.close();
  });
});

function seedDatabase(dbPath: string): void {
  const artifactPath = path.join(path.dirname(dbPath), "ready-resume.txt");
  fs.writeFileSync(artifactPath, "hello world!");

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
      tailor_attempts INTEGER,
      cover_letter_path TEXT,
      cover_letter_at TEXT,
      cover_attempts INTEGER,
      apply_status TEXT,
      apply_error TEXT,
      applied_at TEXT
    );
    CREATE TABLE job_stage_states (
      job_url TEXT,
      stage TEXT,
      state TEXT,
      attempt_count INTEGER,
      max_attempts INTEGER,
      started_at TEXT,
      updated_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER,
      blocked_by_json TEXT,
      next_action TEXT
    );
    CREATE TABLE job_artifacts (
      job_url TEXT,
      stage TEXT,
      artifact_type TEXT,
      status TEXT,
      path TEXT,
      created_at TEXT,
      size_bytes INTEGER
    );
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL DEFAULT '',
      level TEXT,
      message TEXT,
      occurred_at TEXT,
      payload_json TEXT
    );
    CREATE TABLE job_scores (
      job_url TEXT NOT NULL,
      version INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      fit_score INTEGER NOT NULL,
      breakdown_json TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      scored_at TEXT NOT NULL,
      correction_json TEXT,
      criteria_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (job_url, version)
    );
    CREATE TABLE job_enrichments (
      job_url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      current_status TEXT NOT NULL,
      full_description TEXT,
      application_url TEXT,
      enriched_at TEXT,
      extraction_tier TEXT,
      attempts_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL
    );
    CREATE TABLE apply_run_projections (
      run_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      job_title TEXT NOT NULL DEFAULT '',
      job_employer TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      result TEXT,
      dry_run INTEGER NOT NULL DEFAULT 0,
      worker_id INTEGER,
      model TEXT,
      started_at TEXT,
      finished_at TEXT,
      duration_ms INTEGER,
      events_json TEXT NOT NULL DEFAULT '[]'
    );
  `);

  insertJob(db, {
    url: "https://example.com/jobs/ready",
    title: "Platform Engineer",
    site: "ExampleCo",
    fitScore: 9,
    tailoredPath: artifactPath,
  });
  insertScore(db, "https://example.com/jobs/ready", 1, 9);
  insertScore(db, "https://example.com/jobs/failed-score", 1, 8);
  insertScore(db, "https://example.com/jobs/blocked-tailor", 1, 6);
  insertJob(db, {
    url: "https://example.com/jobs/failed-score",
    title: "Backend Engineer",
    site: "ExampleCo",
    fitScore: 8,
  });
  insertJob(db, {
    url: "https://example.com/jobs/blocked-tailor",
    title: "Frontend Engineer",
    site: "Acme",
    fitScore: 6,
  });

  for (const stage of ["discover", "enrich", "score", "tailor", "cover"]) {
    insertStage(db, "https://example.com/jobs/ready", stage, "succeeded");
  }
  insertStage(db, "https://example.com/jobs/ready", "apply", "pending");
  insertStage(db, "https://example.com/jobs/failed-score", "discover", "succeeded");
  insertStage(db, "https://example.com/jobs/failed-score", "enrich", "succeeded");
  insertStage(db, "https://example.com/jobs/failed-score", "score", "failed", "LLM_ERROR");
  insertStage(db, "https://example.com/jobs/blocked-tailor", "discover", "succeeded");
  insertStage(db, "https://example.com/jobs/blocked-tailor", "enrich", "succeeded");
  insertStage(db, "https://example.com/jobs/blocked-tailor", "score", "succeeded");
  insertStage(db, "https://example.com/jobs/blocked-tailor", "tailor", "blocked", "MIN_SCORE");

  db.prepare(
    "INSERT INTO job_artifacts (job_url, stage, artifact_type, status, path, created_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "https://example.com/jobs/ready",
    "tailor",
    "tailored_resume_txt",
    "active",
    artifactPath,
    "2026-04-29T10:05:00+00:00",
    12,
  );
  db.prepare(
    "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "https://example.com/jobs/failed-score",
    "score",
    "ActionFailed",
    "error",
    "Score failed",
    "2026-04-29T10:10:00+00:00",
  );
  db.prepare(
    "INSERT INTO apply_run_projections (run_id, job_id, job_title, job_employer, status, result, dry_run, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "run-1",
    "https://example.com/jobs/ready",
    "Platform Engineer",
    "ExampleCo",
    "finished",
    "succeeded",
    1,
    "2026-04-29T10:15:00+00:00",
  );
  db.close();
}

function insertWorkerHeartbeat(
  dbPath: string,
  heartbeat: {
    workerId: string;
    appDir: string;
    dbPath: string;
    lastSeenAt: string;
  },
): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS worker_runtime_heartbeats (
      worker_id TEXT PRIMARY KEY,
      component TEXT NOT NULL,
      pid INTEGER NOT NULL,
      hostname TEXT NOT NULL,
      app_dir TEXT NOT NULL,
      db_path TEXT NOT NULL,
      task_queue TEXT NOT NULL,
      started_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    );
  `);
  db.prepare(
    `INSERT INTO worker_runtime_heartbeats
      (worker_id, component, pid, hostname, app_dir, db_path, task_queue, started_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    heartbeat.workerId,
    "temporal-worker",
    1234,
    "localhost",
    heartbeat.appDir,
    heartbeat.dbPath,
    "jobhunter-default",
    "2026-05-20T10:00:00.000Z",
    heartbeat.lastSeenAt,
  );
  db.close();
}

function insertJob(
  db: Database.Database,
  job: {
    url: string;
    title: string;
    site: string;
    fitScore?: number | null;
    scoredAt?: string | null;
    tailoredPath?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (
      url, title, site, strategy, location, salary, discovered_at, application_url,
      description, full_description, detail_scraped_at, fit_score, score_reasoning,
      scored_at, tailored_resume_path, tailored_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.url,
    job.title,
    job.site,
    "test",
    "Remote",
    "",
    "2026-04-29T10:00:00+00:00",
    job.url,
    "Short description",
    "Long description",
    "2026-04-29T10:01:00+00:00",
    job.fitScore ?? null,
    "Good fit",
    job.scoredAt === undefined ? "2026-04-29T10:02:00+00:00" : job.scoredAt,
    job.tailoredPath ?? null,
    job.tailoredPath ? "2026-04-29T10:03:00+00:00" : null,
  );
}

function countRows(db: Database.Database, tableName: string, columnName: string, value: string): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName} WHERE ${columnName} = ?`).get(value) as {
    count: number;
  };
  return Number(row.count);
}

function insertScore(
  db: Database.Database,
  jobUrl: string,
  version: number,
  fitScore: number,
  options: {
    correction?: Record<string, unknown> | null;
    policyVersion?: number;
    policyId?: string;
  } = {},
): void {
  db.prepare(
    `INSERT INTO job_scores (
      job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
    scored_at, correction_json, criteria_json, trace_json
    ) VALUES (?, ?, 'local', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobUrl,
    version,
    fitScore,
    JSON.stringify({
      technical_fit: fitScore,
      experience_fit: Math.max(fitScore - 1, 0),
      role_fit: fitScore,
      reasoning: "Seeded structured score.",
      fit_band: fitScore >= 9 ? "excellent" : fitScore >= 7 ? "strong" : "plausible",
      confidence: "medium",
      eligibility: { status: "eligible", hard_blockers: [], warnings: [] },
      matched_signals: ["platform reliability"],
      missing_signals: [],
      transferable_signals: [],
    }),
    JSON.stringify(["platform"]),
    "2026-04-29T10:02:00+00:00",
    options.correction === undefined
      ? null
      : options.correction === null
        ? null
        : JSON.stringify(options.correction),
    JSON.stringify({
      min_fit_score: 7,
      criteria_text: "Seeded criteria.",
      target_criteria: "Seeded target.",
      profile_preferences: { target_work_models: "remote" },
      criteria_version: "seeded-criteria",
    }),
    JSON.stringify({
      prompt_version: "score-fit-assessment-v1",
      schema_version: "score-fit-assessment-v1",
      model: "seed",
      criteria_version: "seeded-criteria",
      profile_snapshot_version: 1,
      ...(options.policyVersion === undefined
        ? {}
        : {
            scoring_policy_id: options.policyId ?? `local:scoring-policy-v${options.policyVersion}`,
            scoring_policy_version: options.policyVersion,
          }),
      parser_warnings: [],
      correction_history: [],
    }),
  );
}

function createScoreStalenessTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_score_staleness (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      stale_reason TEXT NOT NULL,
      old_policy_id TEXT NOT NULL DEFAULT '',
      old_policy_version INTEGER NOT NULL,
      new_policy_id TEXT NOT NULL DEFAULT '',
      new_policy_version INTEGER NOT NULL,
      marked_at TEXT NOT NULL,
      resolved INTEGER NOT NULL DEFAULT 0,
      resolved_at TEXT,
      resolved_by_score_version INTEGER,
      PRIMARY KEY (
        tenant_id, job_url, stale_reason,
        old_policy_version, new_policy_version
      )
    )
  `);
}

function createMaterialsTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_materials (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_validation_json TEXT,
      last_verdict_json TEXT,
      metadata_json TEXT,
      PRIMARY KEY (job_url, generation)
    );
    CREATE TABLE IF NOT EXISTS job_materials_artifacts (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      artifact_id TEXT NOT NULL,
      status TEXT NOT NULL,
      path TEXT NOT NULL,
      render_format TEXT NOT NULL,
      size_bytes INTEGER,
      metadata_json TEXT,
      created_at TEXT NOT NULL,
      superseded_at TEXT,
      PRIMARY KEY (job_url, generation, artifact_type)
    );
  `);
}

function insertMaterialsGeneration(
  db: Database.Database,
  artifact: {
    jobUrl: string;
    artifactId: string;
    artifactType: string;
    status: string;
    path: string;
    metadata?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO job_materials (
       job_url, generation, tenant_id, status, created_at, updated_at, metadata_json
     ) VALUES (?, 1, 'local', ?, ?, ?, ?)`,
  ).run(
    artifact.jobUrl,
    artifact.status === "suppressed" ? "suppressed" : "resume_approved",
    "2026-05-26T10:00:00+00:00",
    "2026-05-26T10:00:00+00:00",
    "{}",
  );
  db.prepare(
    `INSERT OR REPLACE INTO job_materials_artifacts (
       job_url, generation, artifact_type, artifact_id, status, path,
       render_format, size_bytes, metadata_json, created_at
     ) VALUES (?, 1, ?, ?, ?, ?, 'text', ?, ?, ?)`,
  ).run(
    artifact.jobUrl,
    artifact.artifactType,
    artifact.artifactId,
    artifact.status,
    artifact.path,
    fs.existsSync(artifact.path) ? fs.statSync(artifact.path).size : null,
    JSON.stringify(artifact.metadata ?? {}),
    "2026-05-26T10:00:00+00:00",
  );
}

function insertStage(
  db: Database.Database,
  jobUrl: string,
  stage: string,
  state: string,
  errorCode: string | null = null,
): void {
  db.prepare(
    `INSERT INTO job_stage_states (
      job_url, stage, state, attempt_count, max_attempts, updated_at,
      error_code, error_message, retryable, blocked_by_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobUrl,
    stage,
    state,
    state === "failed" ? 1 : 0,
    3,
    "2026-04-29T10:04:00+00:00",
    errorCode,
    errorCode ? `${stage} failed` : null,
    state === "blocked" ? 0 : 1,
    "[]",
  );
}
