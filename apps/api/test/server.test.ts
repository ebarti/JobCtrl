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
let strayProfileExportPath = "";
let strayStyleExportPath = "";
let strayTemplateExportPath = "";

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
    settingsPath: path.join(tempDir, "dashboard.json"),
    actionDispatcher: vi.fn(async (): Promise<ActionDispatchResult> => ({ status: "queued", runId: "run-profile-retailor" })),
  };
  strayProfileExportPath = path.join(tempDir, "candidate-profile-export.json");
  strayStyleExportPath = path.join(tempDir, "resume-rendering-export.json");
  strayTemplateExportPath = path.join(tempDir, "resume-rendering-export.tex");
  seedDatabase(options.dbPath);
  fs.writeFileSync(strayProfileExportPath, JSON.stringify(validProfileFixture("Jordan Candidate")));
  fs.writeFileSync(strayStyleExportPath, JSON.stringify({ font_family: "sans" }));
  fs.writeFileSync(strayTemplateExportPath, "\\documentclass{article}");
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

  it("reports a healthy JobHunter automation worker heartbeat from the API database", async () => {
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

  it("reports a stale JobHunter automation worker heartbeat", async () => {
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

  it("reports a mismatched JobHunter automation worker heartbeat", async () => {
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

  it("surfaces low-score role-match suggestions and records approval decisions", async () => {
    const db = new Database(options.dbPath);
    const jobKey = "https://example.com/jobs/test-engineering";
    insertJob(db, {
      url: jobKey,
      title: "Manager, Test Engineering",
      site: "Monolithic Power Systems",
      fitScore: 2,
    });
    insertScore(db, jobKey, 1, 2);
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/discovery/role-match-feedback",
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.suggestions).toHaveLength(1);
    expect(body.suggestions[0]).toMatchObject({
      status: "pending",
      ruleKind: "exact_title_exclusion",
      titlePattern: "manager test engineering",
      titleDisplay: "Manager, Test Engineering",
      reasonCode: "low_role_fit",
      sampleCount: 1,
    });

    const suggestionId = body.suggestions[0].suggestionId;
    const decision = await app.inject({
      method: "POST",
      url: `/v1/discovery/role-match-feedback/${encodeURIComponent(suggestionId)}/decision`,
      payload: {
        decision: "approve",
        reason: "Confirmed low-signal test-management title.",
      },
      headers: { origin: "http://localhost:5173" },
    });

    expect(decision.statusCode, decision.body).toBe(200);
    expect(decision.json().suggestion).toMatchObject({
      suggestionId,
      status: "approved",
      decisionReason: "Confirmed low-signal test-management title.",
    });

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
    const originalProfile = fs.readFileSync(strayProfileExportPath, "utf8");

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
    expect(fs.readFileSync(strayProfileExportPath, "utf8")).toBe(originalProfile);

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
    expect(body.applyRuns[0]).toMatchObject({
      runId: "run-1",
      dryRun: true,
      events: [
        {
          at: "2026-04-29T10:15:00+00:00",
          type: "ApplyRunStarted",
          level: "info",
          message: "Apply agent acquired job",
        },
      ],
    });

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
          runId: "discovery:workday:run-1",
          workflowId: "workflow-run-1",
          progress: {
            completed: 3,
            total: 5,
            percent: 60,
            currentStep: "Workday scraper",
            status: "running",
            message: "Workday scraper complete",
            sourceProgress: {
              completed: 35,
              total: 72,
              unit: "searches",
              currentQuery: "Head of Platform",
              currentLocation: "Spain (remote)",
              newJobs: 13,
              existingJobs: 46,
              filteredJobs: 412,
              errorCount: 0,
              rawTotal: 1000,
            },
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
        runId: "discovery:workday:run-1",
        workflowId: "workflow-run-1",
        percent: 60,
        completed: 3,
        total: 5,
        currentStep: "Workday scraper",
        message: "Workday scraper complete",
        sourceProgress: {
          completed: 35,
          total: 72,
          unit: "searches",
          currentQuery: "Head of Platform",
          currentLocation: "Spain (remote)",
          newJobs: 13,
          existingJobs: 46,
          filteredJobs: 412,
          errorCount: 0,
          rawTotal: 1000,
        },
        updatedAt: "2026-04-29T10:20:00+00:00",
      },
    ]);

    await app.close();
  });

  it("normalizes source progress to a visible nonzero percentage", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        null,
        "discover",
        "StageProgress",
        "info",
        "JobSpy search completed",
        "2026-04-29T10:21:00+00:00",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          runId: "discovery:jobspy:run-1",
          workflowId: "workflow-run-1",
          progress: {
            completed: 0,
            total: 6,
            percent: 0,
            currentStep: "JobSpy",
            status: "running",
            message: "JobSpy search completed",
            sourceProgress: {
              completed: 2,
              total: 72,
              unit: "searches",
              currentQuery: "Director of Engineering",
              currentLocation: "European Union",
              newJobs: 0,
              existingJobs: 12,
              filteredJobs: 242,
              errorCount: 0,
              rawTotal: 254,
            },
          },
        }),
      );
    } finally {
      db.close();
    }

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().progress[0]).toMatchObject({
      stage: "discover",
      status: "running",
      percent: 1,
      sourceProgress: {
        completed: 2,
        total: 72,
        currentQuery: "Director of Engineering",
        currentLocation: "European Union",
      },
    });

    await app.close();
  });

  it("preserves partial terminal pipeline progress from durable event payloads", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        null,
        "discover",
        "StageCompleted",
        "warn",
        "discover stage partial",
        "2026-04-29T10:25:00+00:00",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          status: "partial",
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
        status: "partial",
        percent: 100,
        completed: 1,
        total: 1,
        currentStep: null,
        message: "Stage completed with warnings",
        updatedAt: "2026-04-29T10:25:00+00:00",
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
      currentStage: "discover",
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

    const stateSorted = await app.inject({
      method: "GET",
      url: "/v1/jobs?sort=current_state&dir=asc",
    });
    expect(stateSorted.statusCode, stateSorted.body).toBe(200);
    expect(stateSorted.json().items.map((job: { currentState: string }) => job.currentState)).toEqual([
      "failed",
      "blocked",
      "pending",
    ]);

    const stageSorted = await app.inject({
      method: "GET",
      url: "/v1/jobs?sort=current_stage&dir=asc",
    });
    expect(stageSorted.statusCode, stageSorted.body).toBe(200);
    expect(stageSorted.json().items.map((job: { currentStage: string }) => job.currentStage)).toEqual([
      "apply",
      "discover",
      "discover",
    ]);

    await app.close();
  });

  it("returns a curated per-job audit history without raw debug events", async () => {
    const jobUrl = "https://example.com/jobs/ready";
    const db = new Database(options.dbPath);
    const insertAuditEvent = db.prepare(
      "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertAuditEvent.run(
      jobUrl,
      "discover",
      "JobDiscovered",
      "info",
      "raw discovery message",
      "2026-04-29T10:00:00+00:00",
      JSON.stringify({
        tenantId: "local",
        jobId: jobUrl,
        postingUrl: jobUrl,
        source: "workday:example",
        employer: "ExampleCo",
        discoveredAt: "2026-04-29T10:00:00+00:00",
      }),
    );
    insertAuditEvent.run(
      jobUrl,
      "score",
      "JobScored",
      "info",
      "raw score message",
      "2026-04-29T10:02:00+00:00",
      JSON.stringify({
        tenantId: "local",
        jobId: jobUrl,
        fitScore: 9,
        fitBand: "excellent",
        confidence: "high",
        eligibility: { status: "eligible" },
        keywords: ["platform reliability"],
      }),
    );
    insertAuditEvent.run(
      jobUrl,
      "apply",
      "ApplyReviewDecisionRecorded",
      "info",
      "debug apply review event",
      "2026-04-29T10:03:00+00:00",
      JSON.stringify({
        tenantId: "local",
        jobKey: jobUrl,
        decisionId: "decision-1",
        decision: "approve_dry_run",
        reasonPresent: true,
      }),
    );
    insertAuditEvent.run(
      jobUrl,
      "apply",
      "ApplicationOutcomeRecorded",
      "info",
      "debug outcome event",
      "2026-04-29T10:04:00+00:00",
      JSON.stringify({
        tenantId: "local",
        jobKey: jobUrl,
        outcomeId: "outcome-1",
        kind: "interview",
        source: "manual",
        notePresent: true,
      }),
    );
    insertAuditEvent.run(
      jobUrl,
      "apply",
      "RawDebugEvent",
      "debug",
      "raw debug statement that should not render",
      "2026-04-29T10:05:00+00:00",
      JSON.stringify({ tenantId: "local", jobKey: jobUrl, secret: "payload_json" }),
    );
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.auditHistory.map((entry: { title: string }) => entry.title)).toEqual([
      "Job discovered",
      "Job scored",
      "Apply review decision recorded",
      "Application outcome recorded",
    ]);
    expect(body.auditHistory[0]).toMatchObject({
      category: "discovery",
      tone: "success",
      description: "Found via workday:example.",
      actor: "system",
      details: expect.arrayContaining([
        { label: "Source", value: "workday:example" },
        { label: "Employer", value: "ExampleCo" },
      ]),
    });
    expect(body.auditHistory[2]).toMatchObject({
      category: "apply",
      description: "Human review approved a dry-run application.",
      actor: "user",
    });
    expect(body.auditHistory[3]).toMatchObject({
      category: "outcome",
      tone: "success",
      description: "Outcome: Interview.",
      actor: "user",
    });
    expect(JSON.stringify(body.auditHistory)).not.toContain("RawDebugEvent");
    expect(JSON.stringify(body.auditHistory)).not.toContain("raw debug statement");
    expect(JSON.stringify(body.auditHistory)).not.toContain("payload_json");

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

  it("separates closed postings from active and deleted jobs", async () => {
    const db = new Database(options.dbPath);
    db.exec(`
      CREATE TABLE IF NOT EXISTS posting_snapshot_sets (
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_url TEXT NOT NULL,
        snapshot_set_json TEXT NOT NULL,
        latest_snapshot_version INTEGER NOT NULL DEFAULT 0,
        latest_active_state TEXT NOT NULL DEFAULT 'unknown',
        updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, job_url)
      );
    `);
    db.prepare(
      `INSERT INTO posting_snapshot_sets (
        tenant_id, job_url, snapshot_set_json, latest_snapshot_version,
        latest_active_state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "local",
      "https://example.com/jobs/failed-score",
      JSON.stringify({ tenant_id: "local", job_id: "https://example.com/jobs/failed-score", latest_active_state: "removed" }),
      0,
      "removed",
      "2026-05-29T10:00:00+00:00",
    );
    db.prepare(
      "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "https://example.com/jobs/failed-score",
      "enrich",
      "JobActiveStateChanged",
      "info",
      "Job active state changed.",
      "2026-05-29T10:00:00+00:00",
      JSON.stringify({
        job_id: "https://example.com/jobs/failed-score",
        active_state: "removed",
        previous_state: "active",
      }),
    );
    db.close();

    const app = buildApp(options);

    const active = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active&sort=title&dir=asc" });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().pagination.total).toBe(2);
    expect(active.json().items.map((job: { jobKey: string }) => job.jobKey)).not.toContain(
      "https://example.com/jobs/failed-score",
    );

    const closed = await app.inject({ method: "GET", url: "/v1/jobs?deleted=closed" });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().pagination.total).toBe(1);
    expect(closed.json().items[0]).toMatchObject({
      jobKey: "https://example.com/jobs/failed-score",
      activeState: "removed",
      deletedAt: null,
      hiddenAt: null,
    });

    const deleted = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted" });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().pagination.total).toBe(0);

    const summary = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
    expect(summary.statusCode, summary.body).toBe(200);
    expect(summary.json().totals).toMatchObject({
      jobs: 2,
      failures: 0,
      blocked: 1,
      ready: 1,
    });

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

      const appliedJobsRes = await app.inject({
        method: "GET",
        url: `/v1/jobs?q=${encodeURIComponent("New Path Engineer")}&applyStatus=applied`,
      });
      expect(appliedJobsRes.statusCode, appliedJobsRes.body).toBe(200);
      const appliedJobsBody = appliedJobsRes.json();
      expect(appliedJobsBody.filter).toMatchObject({ applyStatus: "applied" });
      expect(appliedJobsBody.items).toHaveLength(1);
      expect(appliedJobsBody.items[0]).toMatchObject({
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
      currentStage: "discover",
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
    expect(body.applyAudit).toMatchObject({
      state: "preparing",
      label: "materials preparing",
      reviewEvidenceAvailable: true,
      hardBlockers: [],
    });
    expect(body.applyAudit.missingPrerequisites).toEqual([
      expect.objectContaining({ code: "missing_resume_pdf" }),
    ]);
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

  it("keeps the compensation boundary from changing fit score, filters, readiness, or apply dispatch", async () => {
    const seedDb = new Database(options.dbPath);
    seedDb
      .prepare("UPDATE jobs SET salary = ? WHERE url = ?")
      .run("€55,000/year", "https://example.com/jobs/ready");
    insertPostedCompensationFact(seedDb, "https://example.com/jobs/ready");
    seedDb.close();

    const dispatch = vi.fn(async () => ({ status: "queued", runId: "run-compensation-boundary" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const readyKey = encodeURIComponent("https://example.com/jobs/ready");

    const list = await app.inject({
      method: "GET",
      url: "/v1/jobs?sort=fit_score&dir=desc&pageSize=3",
    });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items.map((job) => job.jobKey)).toEqual([
      "https://example.com/jobs/ready",
      "https://example.com/jobs/failed-score",
      "https://example.com/jobs/blocked-tailor",
    ]);
    expect(items[0]).toMatchObject({
      jobKey: "https://example.com/jobs/ready",
      fitScore: 9,
      salary: "€55,000/year",
    });
    expect(items[0]).not.toHaveProperty("compensationSummary");
    expect(items[0]).not.toHaveProperty("compensationAudit");

    const filtered = await app.inject({
      method: "GET",
      url: "/v1/jobs?minFitScore=9&sort=fit_score&dir=desc",
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
      "https://example.com/jobs/ready",
    ]);

    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${readyKey}` });
    expect(detail.statusCode, detail.body).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.job).toMatchObject({
      jobKey: "https://example.com/jobs/ready",
      salary: "€55,000/year",
      fitScore: 9,
    });
    expect(detailBody.job).not.toHaveProperty("compensationSummary");
    expect(detailBody.job).not.toHaveProperty("compensationAudit");
    expect(detailBody.applyAudit).toMatchObject({
      state: "preparing",
      label: "materials preparing",
      reviewEvidenceAvailable: true,
    });

    const apply = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/actions/apply`,
      payload: {},
    });
    expect(apply.statusCode, apply.body).toBe(202);
    expect(apply.json()).toMatchObject({
      ok: true,
      action: "apply",
      status: "queued",
      jobKey: "https://example.com/jobs/ready",
      command: { dryRun: true },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "apply", dryRun: true, jobKey: "https://example.com/jobs/ready" }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("keeps the market compensation boundary from changing fit score, filters, readiness, or apply dispatch", async () => {
    const seedDb = new Database(options.dbPath);
    seedDb
      .prepare("UPDATE jobs SET salary = ? WHERE url = ?")
      .run("€55,000/year", "https://example.com/jobs/ready");
    insertMarketCompensationEstimate(seedDb, "https://example.com/jobs/ready");
    seedDb.close();

    const dispatch = vi.fn(async () => ({ status: "queued", runId: "run-market-compensation-boundary" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const readyKey = encodeURIComponent("https://example.com/jobs/ready");

    const list = await app.inject({
      method: "GET",
      url: "/v1/jobs?sort=fit_score&dir=desc&pageSize=3",
    });
    expect(list.statusCode, list.body).toBe(200);
    const items = list.json().items as Array<Record<string, unknown>>;
    expect(items.map((job) => job.jobKey)).toEqual([
      "https://example.com/jobs/ready",
      "https://example.com/jobs/failed-score",
      "https://example.com/jobs/blocked-tailor",
    ]);
    expect(items[0]).toMatchObject({
      jobKey: "https://example.com/jobs/ready",
      fitScore: 9,
      salary: "€55,000/year",
    });
    expect(items[0]).not.toHaveProperty("compensationSummary");
    expect(items[0]).not.toHaveProperty("compensationAudit");
    expect(items[0]).not.toHaveProperty("marketCompensationEstimate");

    const filtered = await app.inject({
      method: "GET",
      url: "/v1/jobs?minFitScore=9&sort=fit_score&dir=desc",
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
      "https://example.com/jobs/ready",
    ]);

    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${readyKey}` });
    expect(detail.statusCode, detail.body).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.job).toMatchObject({
      jobKey: "https://example.com/jobs/ready",
      salary: "€55,000/year",
      fitScore: 9,
    });
    expect(detailBody.job).not.toHaveProperty("compensationSummary");
    expect(detailBody.job).not.toHaveProperty("compensationAudit");
    expect(detailBody.job).not.toHaveProperty("marketCompensationEstimate");
    expect(detailBody.applyAudit).toMatchObject({
      state: "preparing",
      label: "materials preparing",
      reviewEvidenceAvailable: true,
    });

    const apply = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/actions/apply`,
      payload: {},
    });
    expect(apply.statusCode, apply.body).toBe(202);
    expect(apply.json()).toMatchObject({
      ok: true,
      action: "apply",
      status: "queued",
      jobKey: "https://example.com/jobs/ready",
      command: { dryRun: true },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "apply", dryRun: true, jobKey: "https://example.com/jobs/ready" }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("reconciles stale retryable stage projections from latest failure events", async () => {
    const seedDb = new Database(options.dbPath);
    seedDb
      .prepare("UPDATE job_stage_states SET retryable = 1, next_action = ? WHERE job_url = ? AND stage = ?")
      .run(
        "jobhunter retry score https://example.com/jobs/failed-score",
        "https://example.com/jobs/failed-score",
        "score",
      );
    seedDb
      .prepare(
        `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "https://example.com/jobs/failed-score",
        "score",
        "StageFailed",
        "error",
        "score failed",
        "2026-04-29T12:00:00+00:00",
        JSON.stringify({ retryable: false }),
      );
    seedDb.close();

    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/failed-score");
    const response = await app.inject({ method: "GET", url: `/v1/jobs/${jobKey}` });

    expect(response.statusCode, response.body).toBe(200);
    const scoreStage = response
      .json()
      .stages.find((stage: { stage: string }) => stage.stage === "score");
    expect(scoreStage).toMatchObject({ state: "failed", retryable: false, nextAction: null });

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
      tailoringExplanation: null,
    });

    await app.close();
  });

  it("returns safe tailoring explanation for tailored resume artifacts", async () => {
    const resumePath = path.join(tempDir, "tailoring-evidence-resume.txt");
    fs.writeFileSync(resumePath, "Senior platform reliability resume.");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    insertJob(seedDb, {
      url: "https://example.com/jobs/tailoring-evidence",
      title: "Senior Platform Engineer",
      site: "EvidenceCo",
      fitScore: 9,
      tailoredPath: resumePath,
      fullDescription:
        "Senior platform reliability role covering Platform Engineering, Kubernetes, AWS, GCP, CI/CD, Infrastructure as Code, Java, Node.js, Observability, Cost Optimization, Developer Productivity, and Scalability.",
    });
    insertScore(seedDb, "https://example.com/jobs/tailoring-evidence", 1, 9, {
      keywords: [
        "Platform Engineering",
        "Kubernetes",
        "AWS",
        "GCP",
        "CI/CD",
        "Infrastructure as Code",
        "Java",
        "Node.js",
        "Observability",
        "Cost Optimization",
        "Developer Productivity",
        "Scalability",
      ],
    });
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-evidence",
      artifactId: "artifact-tailoring-evidence",
      artifactType: "tailored_resume",
      status: "approved",
      path: resumePath,
      metadata: {
        validation_mode: "normal",
        attempts: 2,
        quality_plan: {
          target_seniority: "senior",
          claim_mode: "evidence_reframing",
          auto_approvable_claim_modes: ["verified_only", "evidence_reframing"],
          allow_adjacent_achievement_drafts: false,
          job_keywords: [
            "platform reliability",
            "typescript",
            "join",
            "impress",
            "europe",
            "health",
            "tech",
            "innovator",
            "believe",
            "everyone",
            "deserves",
            "smile",
          ],
          required_evidence_ids: ["ev_latency"],
          seniority_evidence_ids: ["ev_scope"],
          verified_metric_count: 2,
        },
        quality_checks: {
          passed: true,
          errors: [],
          warnings: ["Low keyword coverage"],
          notes: ["Keyword coverage: 1/2"],
          keyword_coverage: {
            covered: ["platform reliability", "head", "2019", "across"],
            missing: [
              "typescript",
              "join",
              "impress",
              "europe",
              "health",
              "tech",
              "innovator",
              "believe",
              "everyone",
              "deserves",
              "smile",
              "they",
              "love",
              "largest",
              "ortho",
              "clinic",
              "chain",
            ],
          },
          evidence_support: {
            represented_ids: ["ev_latency"],
            missing_ids: [],
          },
          metric_claims: ["35%", "5teams", "2service", "15engineers"],
          repeated_keywords: [{ keyword: "platform", count: 5 }],
        },
        judge: {
          passed: true,
          verdict: "PASS",
          score: 0.91,
          issues: [],
          unsupported_claims: [],
          fabrications: [],
          missing_required_evidence: [],
          repair_instructions: [],
        },
        judge_min_score: 0.82,
        adversarial_review: {
          ran: true,
          passed: true,
          score: 0.88,
          score_rationale: "All personas passed with no blockers.",
          threshold: 0.8,
          blockers: [],
          warnings: ["Bullet could be more concise."],
          repair_instructions: [],
          personas: [
            {
              persona: "evidence_auditor",
              verdict: "PASS",
              score: 0.9,
              score_rationale: "Evidence was supported by profile facts.",
              prompt_rubric: "Check that every metric, tool, role, company, and achievement is supported.",
              blockers: [],
              warnings: [],
              repair_instructions: [],
              score_basis: ["LLM verdict: PASS", "LLM score: 0.90", "Blockers: none"],
              response: {
                verdict: "PASS",
                score: 0.9,
                score_rationale: "Evidence was supported by profile facts.",
                blockers: [],
                warnings: [],
                repair_instructions: [],
              },
            },
          ],
          llm_audit: {
            model: "judge-a",
            schema_version: "tailor-adversarial.v2",
            prompt_messages: [
              {
                role: "system",
                content: "Evaluate the tailored resume from every persona below.",
              },
              {
                role: "user",
                content: "Run the adversarial review and return JSON.",
              },
            ],
            response: {
              verdict: "PASS",
              score: 0.88,
              score_rationale: "All personas passed with no blockers.",
              blockers: [],
              warnings: ["Bullet could be more concise."],
              repair_instructions: [],
              personas: [
                {
                  verdict: "PASS",
                  score: 0.9,
                  score_rationale: "Evidence was supported by profile facts.",
                  blockers: [],
                  warnings: [],
                  repair_instructions: [],
                },
              ],
            },
          },
          skipped_reason: "",
        },
        review_feedback: {
          warning_retry_attempted: true,
          accepted_with_residual_warnings: true,
          accepted_warning_notes: ["Bullet could be more concise."],
        },
        change_annotations: [
          {
            section: "executive_profile",
            label: "Executive profile",
            change_type: "summary_reframed",
            source_id: "executive_profile",
            source_text: ["Senior backend engineer."],
            tailored_text: ["Senior platform engineer focused on Kubernetes reliability."],
            rationale: "Summary was framed toward senior platform reliability.",
            job_signals: ["platform reliability", "kubernetes", "join"],
            controls: ["target seniority: senior", "claim mode: evidence_reframing"],
            evidence_ids: ["ev_scope"],
            evidence_notes: ["ev_scope: technical ownership"],
          },
        ],
        candidate_models: ["generator-a"],
        selected_model: "generator-a",
        selected_candidate: "candidate-1",
        judge_model: "judge-a",
        system_prompt: "must not leak",
        job_text: "must not leak",
        parsed_json: { must: "not leak" },
      },
    });
    // Phase 4: the keyword coverage block is served from the canonical coverage
    // audit row (computed against rendered text at generation time), NOT recomputed
    // from the resume file / job description at read time.
    insertBulletProvenanceRow(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-evidence",
      artifactId: "artifact-tailoring-evidence",
      bulletId: "experience:acme_swe#0",
      section: "experience",
      sourceId: "acme_swe",
      evidenceIds: ["ev_latency"],
      requirementIds: ["req_platform"],
      matchedKeywords: ["platform reliability"],
      transformType: "reframe",
      control: "rephrase_allowed",
      rationale: "Reframed toward platform reliability.",
      generatedText: "Owned platform reliability across the fleet.",
      coverage: {
        computed_against: "rendered_text",
        planned: ["platform reliability", "kubernetes", "observability"],
        covered: ["platform reliability"],
        missing: ["kubernetes", "observability"],
        covered_by: { "platform reliability": "experience:acme_swe#0" },
        counts: { planned: 3, covered: 1, missing: 2 },
      },
    });
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact-tailoring-evidence",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      artifact: {
        artifactId: "artifact-tailoring-evidence",
        type: "tailored_resume",
        status: "approved",
      },
      tailoringExplanation: {
        targetSeniority: "senior",
        claimMode: "evidence_reframing",
        validationMode: "normal",
        // Phase 4: derived from the canonical coverage audit row, NOT recomputed.
        keywords: {
          coverageRecorded: true,
          planned: ["platform reliability", "kubernetes", "observability"],
          covered: ["platform reliability"],
          missing: ["kubernetes", "observability"],
          filtered: {
            planned: [],
            covered: [],
            missing: [],
          },
          counts: {
            planned: 3,
            covered: 1,
            missing: 2,
            displayedPlanned: 3,
            displayedCovered: 1,
            displayedMissing: 2,
            filteredPlanned: 0,
            filteredCovered: 0,
            filteredMissing: 0,
          },
        },
        evidence: {
          requiredIds: ["ev_latency"],
          representedIds: ["ev_latency"],
          verifiedMetricCount: 2,
        },
        quality: {
          // Phase 4: quality messages pass through verbatim from canonical
          // metadata; the read model no longer synthesises coverage messages.
          warnings: ["Low keyword coverage"],
          notes: ["Keyword coverage: 1/2"],
          metricClaims: ["35%"],
        },
        judge: {
          passed: true,
          score: 0.91,
          minScore: 0.82,
        },
        adversarialReview: {
          ran: true,
          passed: true,
          scoreRationale: "All personas passed with no blockers.",
          warnings: ["Bullet could be more concise."],
          personas: [
            {
              persona: "evidence_auditor",
              verdict: "PASS",
              score: 0.9,
              scoreRationale: "Evidence was supported by profile facts.",
              promptRubric: "Check that every metric, tool, role, company, and achievement is supported.",
              blockers: [],
              warnings: [],
              repairInstructions: [],
              scoreBasis: ["LLM verdict: PASS", "LLM score: 0.90", "Blockers: none"],
              response: {
                verdict: "PASS",
                score: 0.9,
                scoreRationale: "Evidence was supported by profile facts.",
                blockers: [],
                warnings: [],
                repairInstructions: [],
              },
            },
          ],
          audit: {
            model: "judge-a",
            schemaVersion: "tailor-adversarial.v2",
            promptMessages: [
              {
                role: "system",
                content: "Evaluate the tailored resume from every persona below.",
              },
              {
                role: "user",
                content: "Run the adversarial review and return JSON.",
              },
            ],
            response: {
              verdict: "PASS",
              score: 0.88,
              scoreRationale: "All personas passed with no blockers.",
              warnings: ["Bullet could be more concise."],
            },
          },
        },
        reviewFeedback: {
          warningRepairAttempted: true,
          acceptedWithResidualWarnings: true,
          acceptedWarnings: ["Bullet could be more concise."],
        },
        annotatedChanges: [
          {
            section: "executive_profile",
            label: "Executive profile",
            changeType: "summary_reframed",
            sourceId: "executive_profile",
            sourceText: ["Senior backend engineer."],
            tailoredText: ["Senior platform engineer focused on Kubernetes reliability."],
            rationale: "Summary was framed toward senior platform reliability.",
            jobSignals: ["platform reliability", "kubernetes"],
            controls: ["target seniority: senior", "claim mode: evidence_reframing"],
            evidenceIds: ["ev_scope"],
            evidenceNotes: ["ev_scope: technical ownership"],
          },
        ],
        models: {
          selectedModel: "generator-a",
          judgeModel: "judge-a",
          attempts: 2,
        },
      },
    });
    expect(JSON.stringify(response.json())).not.toContain("must not leak");
    // The legacy ``keyword_coverage`` junk in metadata_json (head/2019/join/...) is
    // never read: the keyword block now mirrors the canonical coverage row exactly.
    expect(JSON.stringify(response.json().tailoringExplanation.keywords)).not.toContain("head");
    expect(JSON.stringify(response.json().tailoringExplanation.keywords)).not.toContain("2019");
    expect(JSON.stringify(response.json().tailoringExplanation.keywords)).not.toContain("join");
    expect(JSON.stringify(response.json().tailoringExplanation.keywords)).not.toContain("innovator");
    expect(JSON.stringify(response.json().tailoringExplanation.keywords)).not.toContain("smile");
    expect(JSON.stringify(response.json())).not.toContain("5teams");
    expect(JSON.stringify(response.json())).not.toContain("2service");
    expect(JSON.stringify(response.json())).not.toContain("15engineers");

    await app.close();
  });

  it("derives the keyword block from the canonical coverage audit row, not the resume file", async () => {
    // Phase 4 (AUDIT-01 / GROUND-06): the keyword block is served from the
    // canonical coverage audit row (computed against rendered text at generation
    // time). A resume FILE whose text happens to mention extra job keywords does
    // NOT change the block — there is no read-time recompute against the file.
    const resumePath = path.join(tempDir, "tailoring-canonical-coverage-resume.txt");
    // The file mentions AWS/GCP/Java/Observability, but the canonical coverage
    // recorded a different (smaller) set — the canonical set wins.
    fs.writeFileSync(resumePath, "tailored resume with AWS/GCP, Java, and observability");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    insertJob(seedDb, {
      url: "https://example.com/jobs/tailoring-canonical-coverage",
      title: "Platform Engineering Lead",
      site: "EvidenceCo",
      fitScore: 9,
      tailoredPath: resumePath,
      fullDescription:
        "Platform Engineering Lead with AWS, GCP, Java, Observability, Infrastructure as Code, and multi-region context.",
    });
    insertScore(seedDb, "https://example.com/jobs/tailoring-canonical-coverage", 1, 9, {
      keywords: ["AWS", "GCP", "Java", "Observability", "Infrastructure as Code", "Multi-region"],
    });
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-canonical-coverage",
      artifactId: "artifact-tailoring-canonical-coverage",
      artifactType: "tailored_resume",
      status: "approved",
      path: resumePath,
      metadata: completeTailoringAuditMetadata(),
    });
    insertBulletProvenanceRow(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-canonical-coverage",
      artifactId: "artifact-tailoring-canonical-coverage",
      bulletId: "experience:platform#0",
      section: "experience",
      sourceId: "platform",
      evidenceIds: ["ev_platform"],
      requirementIds: ["req_iac"],
      matchedKeywords: [],
      transformType: "reframe",
      control: "rephrase_allowed",
      generatedText: "Built infrastructure as code for the platform.",
      coverage: {
        computed_against: "rendered_text",
        planned: ["infrastructure as code", "platform engineering"],
        covered: ["infrastructure as code"],
        missing: ["platform engineering"],
        covered_by: { "infrastructure as code": "experience:platform#0" },
        counts: { planned: 2, covered: 1, missing: 1 },
      },
    });
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact-tailoring-canonical-coverage",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      tailoringExplanation: {
        // Exactly the canonical coverage row — NOT the file's AWS/GCP/Java text.
        keywords: {
          coverageRecorded: true,
          planned: ["infrastructure as code", "platform engineering"],
          covered: ["infrastructure as code"],
          missing: ["platform engineering"],
          counts: {
            planned: 2,
            covered: 1,
            missing: 1,
          },
        },
        coverageAudit: {
          computedAgainst: "rendered_text",
          covered: ["infrastructure as code"],
          missing: ["platform engineering"],
        },
        bulletProvenance: [
          expect.objectContaining({
            bulletId: "experience:platform#0",
            matchedKeywords: ["infrastructure as code"],
          }),
        ],
      },
    });
    // The file text (aws/gcp/java/observability) does NOT leak into the block.
    expect(JSON.stringify(response.json().tailoringExplanation.keywords)).not.toContain("aws");
    expect(JSON.stringify(response.json().tailoringExplanation.keywords)).not.toContain("gcp");
    expect(JSON.stringify(response.json().tailoringExplanation.keywords)).not.toContain("Multi-region");

    await app.close();
  });

  it("serves an empty keyword block when no canonical coverage exists (no read-time recompute)", async () => {
    // Phase 4 (AUDIT-01): without a canonical coverage row, the keyword block is
    // honestly empty (coverageRecorded:false). The old code would have recomputed
    // coverage from the resume FILE + job description — that path is deleted.
    const resumePath = path.join(tempDir, "tailoring-no-canonical-coverage-resume.txt");
    // The file + JD are FULL of recoverable keywords — proving the absence of any
    // read-time recompute (none of them appear in the served block).
    fs.writeFileSync(resumePath, "Resume with AWS, CI/CD, Developer Platform, and Observability delivery.");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    insertJob(seedDb, {
      url: "https://example.com/jobs/tailoring-no-canonical-coverage",
      title: "Platform Director",
      site: "EvidenceCo",
      fitScore: 9,
      tailoredPath: resumePath,
      fullDescription: "We need AWS, CI/CD, Developer Platform delivery, and Observability.",
    });
    insertScore(seedDb, "https://example.com/jobs/tailoring-no-canonical-coverage", 1, 9, {
      keywords: ["Developer Platform", "CI/CD", "AWS", "Observability"],
    });
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-no-canonical-coverage",
      artifactId: "artifact-tailoring-no-canonical-coverage",
      artifactType: "tailored_resume",
      status: "approved",
      path: resumePath,
      // Complete audit metadata so the explanation renders — but NO canonical
      // coverage row and NO coverage in metadata.
      metadata: completeTailoringAuditMetadata(),
    });
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact-tailoring-no-canonical-coverage",
    });

    expect(response.statusCode, response.body).toBe(200);
    const explanation = response.json().tailoringExplanation;
    expect(explanation).not.toBeNull();
    // Honest empty — NOT recomputed from the file/JD.
    expect(explanation.keywords).toMatchObject({
      coverageRecorded: false,
      planned: [],
      covered: [],
      missing: [],
      counts: { planned: 0, covered: 0, missing: 0 },
    });
    expect(explanation.coverageAudit).toBeNull();
    // None of the recoverable file/JD keywords leak into the served block.
    expect(JSON.stringify(explanation.keywords)).not.toContain("AWS");
    expect(JSON.stringify(explanation.keywords)).not.toContain("CI/CD");
    expect(JSON.stringify(explanation.keywords)).not.toContain("Developer Platform");
    expect(JSON.stringify(explanation.keywords)).not.toContain("Observability");

    await app.close();
  });

  it("backfills profile evidence mapping for legacy resume bullets", async () => {
    const resumePath = path.join(tempDir, "tailoring-legacy-profile-evidence-resume.txt");
    fs.writeFileSync(resumePath, "Resume with platform reliability and 35% latency improvement.");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    seedDb.exec(`
      CREATE TABLE candidate_profile_experience_entries (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        position_index INTEGER NOT NULL,
        date_range TEXT NOT NULL DEFAULT '',
        title TEXT NOT NULL DEFAULT '',
        company TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (tenant_id, profile_id, entry_id)
      );
      CREATE TABLE candidate_profile_experience_bullets (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        bullet_index INTEGER NOT NULL,
        bullet_text TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id, entry_id, bullet_index)
      );
    `);
    seedDb.prepare(`
      INSERT INTO candidate_profile_experience_entries (
        tenant_id, profile_id, entry_id, position_index, title, company
      ) VALUES ('local', 'default', 'acme_swe', 0, 'Senior SWE', 'Acme Corp')
    `).run();
    seedDb.prepare(`
      INSERT INTO candidate_profile_experience_bullets (
        tenant_id, profile_id, entry_id, bullet_index, bullet_text
      ) VALUES ('local', 'default', 'acme_swe', 0, ?)
    `).run("Owned API latency 35% by replacing synchronous calls.");
    insertJob(seedDb, {
      url: "https://example.com/jobs/tailoring-legacy-profile-evidence",
      title: "Platform Engineering Lead",
      site: "EvidenceCo",
      fitScore: 9,
      tailoredPath: resumePath,
      fullDescription: "Platform reliability, API latency, and senior ownership.",
    });
    insertScore(seedDb, "https://example.com/jobs/tailoring-legacy-profile-evidence", 1, 9, {
      keywords: ["platform reliability", "api latency"],
    });
    const metadata = completeTailoringAuditMetadata();
    const qualityPlan = metadata.quality_plan as Record<string, unknown>;
    qualityPlan.required_evidence_ids = [];
    qualityPlan.seniority_evidence_ids = [];
    metadata.change_annotations = [
      {
        section: "experience",
        label: "Senior SWE at Acme Corp",
        change_type: "achievement_reframed",
        source_id: "acme_swe",
        source_text: ["Senior SWE", "Owned API latency 35% by replacing synchronous calls."],
        tailored_text: ["Owned platform reliability and reduced API latency 35%."],
        rationale: "Reframed toward platform reliability.",
        job_signals: ["platform reliability", "api latency"],
        controls: ["target seniority: executive", "claim mode: evidence_reframing"],
        evidence_ids: [],
        evidence_notes: [],
      },
    ];
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-legacy-profile-evidence",
      artifactId: "artifact-tailoring-legacy-profile-evidence",
      artifactType: "tailored_resume",
      status: "approved",
      path: resumePath,
      metadata,
    });
    insertBulletProvenanceRow(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-legacy-profile-evidence",
      artifactId: "artifact-tailoring-legacy-profile-evidence",
      bulletId: "experience:acme_swe#0",
      section: "experience",
      sourceId: "acme_swe",
      evidenceIds: [],
      requirementIds: ["req_platform"],
      matchedKeywords: ["platform reliability", "api latency"],
      transformType: "reframe",
      control: "rephrase_allowed",
      rationale: "Reframed legacy resume bullet toward the job.",
      generatedText: "Owned platform reliability and reduced API latency 35%.",
      coverage: {
        computed_against: "rendered_text",
        planned: ["platform reliability", "api latency"],
        covered: ["platform reliability", "api latency"],
        missing: [],
        covered_by: { "platform reliability": "experience:acme_swe#0", "api latency": "experience:acme_swe#0" },
        counts: { planned: 2, covered: 2, missing: 0 },
      },
    });
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact-tailoring-legacy-profile-evidence",
    });

    expect(response.statusCode, response.body).toBe(200);
    const explanation = response.json().tailoringExplanation;
    expect(explanation.evidence.requiredIds).toContain("acme_swe_bullet_1");
    expect(explanation.evidence.seniorityIds).toContain("acme_swe_bullet_1");
    expect(explanation.evidence.representedIds).toContain("acme_swe_bullet_1");
    expect(explanation.annotatedChanges[0].evidenceIds).toContain("acme_swe_bullet_1");
    expect(explanation.bulletProvenance[0].evidenceIds).toContain("acme_swe_bullet_1");
    expect(explanation.bulletProvenance[0].sourceText).toEqual([
      "Owned API latency 35% by replacing synchronous calls.",
    ]);
    expect(explanation.quality.errors.join("\n")).not.toContain("profile evidence mapping");

    await app.close();
  });

  it("resolves skill-category source text for bullet provenance", async () => {
    const resumePath = path.join(tempDir, "tailoring-skill-source-resume.txt");
    fs.writeFileSync(resumePath, "Leadership: Team Building & Mentoring, Global Teams (30+ engineers)");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    seedDb.exec(`
      CREATE TABLE candidate_profile_skill_categories (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        position_index INTEGER NOT NULL,
        label TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (tenant_id, profile_id, category_id)
      );
      CREATE TABLE candidate_profile_skill_items (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        item_index INTEGER NOT NULL,
        item_text TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id, category_id, item_index)
      );
      CREATE TABLE candidate_profile_required_skills (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        category_id TEXT NOT NULL,
        skill_index INTEGER NOT NULL,
        skill_text TEXT NOT NULL,
        PRIMARY KEY (tenant_id, profile_id, category_id, skill_index)
      );
      CREATE TABLE candidate_profile_achievement_evidence (
        tenant_id TEXT NOT NULL,
        profile_id TEXT NOT NULL,
        entry_id TEXT NOT NULL,
        evidence_index INTEGER NOT NULL,
        evidence_id TEXT NOT NULL DEFAULT '',
        source_text TEXT NOT NULL DEFAULT '',
        scope TEXT NOT NULL DEFAULT '',
        action TEXT NOT NULL DEFAULT '',
        tools_json TEXT NOT NULL DEFAULT '[]',
        metrics_json TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT '',
        seniority_signal TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (tenant_id, profile_id, entry_id, evidence_index)
      );
    `);
    seedDb.prepare(`
      INSERT INTO candidate_profile_skill_categories (
        tenant_id, profile_id, category_id, position_index, label
      ) VALUES ('local', 'default', 'leadership', 0, 'Leadership')
    `).run();
    const insertSkillItem = seedDb.prepare(`
      INSERT INTO candidate_profile_skill_items (
        tenant_id, profile_id, category_id, item_index, item_text
      ) VALUES ('local', 'default', 'leadership', ?, ?)
    `);
    insertSkillItem.run(0, "Team Building & Mentoring");
    insertSkillItem.run(1, "Global Teams (30+ engineers)");
    seedDb.prepare(`
      INSERT INTO candidate_profile_required_skills (
        tenant_id, profile_id, category_id, skill_index, skill_text
      ) VALUES ('local', 'default', 'leadership', 0, 'Wrong fallback skill')
    `).run();
    seedDb.prepare(`
      INSERT INTO candidate_profile_achievement_evidence (
        tenant_id, profile_id, entry_id, evidence_index, evidence_id, source_text
      ) VALUES ('local', 'default', 'rider_law', 0, 'ev_rider_law', 'Preserved the Spanish market under aggressive legal deadlines.')
    `).run();
    insertJob(seedDb, {
      url: "https://example.com/jobs/tailoring-skill-source",
      title: "Engineering Director",
      site: "EvidenceCo",
      fitScore: 9,
      tailoredPath: resumePath,
      fullDescription: "Needs global team leadership.",
    });
    insertScore(seedDb, "https://example.com/jobs/tailoring-skill-source", 1, 9, {
      keywords: ["global teams"],
    });
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-skill-source",
      artifactId: "artifact-tailoring-skill-source",
      artifactType: "tailored_resume",
      status: "approved",
      path: resumePath,
      metadata: completeTailoringAuditMetadata(),
    });
    insertBulletProvenanceRow(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-skill-source",
      artifactId: "artifact-tailoring-skill-source",
      bulletId: "skills:leadership#0",
      section: "skills",
      sourceId: "leadership",
      evidenceIds: ["ev_rider_law"],
      requirementIds: ["req_leadership"],
      matchedKeywords: ["global teams"],
      transformType: "rephrase",
      control: "rephrase_allowed",
      rationale: "Skill ordering highlights job-matching signals while preserving profile skills.",
      generatedText: "Leadership: Team Building & Mentoring, Global Teams (30+ engineers)",
    });
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact-tailoring-skill-source",
    });

    expect(response.statusCode, response.body).toBe(200);
    const explanation = response.json().tailoringExplanation;
    expect(explanation.bulletProvenance[0]).toMatchObject({
      section: "skills",
      sourceId: "leadership",
      sourceText: ["Leadership: Team Building & Mentoring, Global Teams (30+ engineers)"],
    });

    await app.close();
  });

  it("flags keyword-only tailoring explanations as incomplete audit metadata", async () => {
    const resumePath = path.join(tempDir, "tailoring-incomplete-audit-resume.txt");
    fs.writeFileSync(resumePath, "Resume with AWS and CI/CD delivery.");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    insertJob(seedDb, {
      url: "https://example.com/jobs/tailoring-incomplete-audit",
      title: "Platform Engineering Lead",
      site: "EvidenceCo",
      fitScore: 9,
      tailoredPath: resumePath,
      fullDescription: "Platform Engineering Lead with AWS, CI/CD, Observability, and Infrastructure as Code.",
    });
    insertScore(seedDb, "https://example.com/jobs/tailoring-incomplete-audit", 1, 9, {
      keywords: ["AWS", "CI/CD", "Observability", "Infrastructure as Code"],
    });
    // A shell metadata blob (no audit fields) plus a canonical coverage row: the
    // explanation must STILL flag the incomplete audit metadata, and its keyword
    // block reflects the canonical coverage (not a read-time recompute).
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-incomplete-audit",
      artifactId: "artifact-tailoring-incomplete-audit",
      artifactType: "tailored_resume",
      status: "approved",
      path: resumePath,
      metadata: {
        quality_checks: {
          errors: [],
          warnings: [],
          notes: [],
        },
      },
    });
    insertBulletProvenanceRow(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-incomplete-audit",
      artifactId: "artifact-tailoring-incomplete-audit",
      bulletId: "experience:aws#0",
      section: "experience",
      sourceId: "aws",
      evidenceIds: ["ev_aws"],
      requirementIds: ["req_aws"],
      matchedKeywords: ["aws"],
      transformType: "reframe",
      control: "rephrase_allowed",
      generatedText: "Ran AWS and CI/CD delivery.",
      coverage: {
        computed_against: "rendered_text",
        planned: ["aws", "ci/cd", "observability"],
        covered: ["aws", "ci/cd"],
        missing: ["observability"],
        covered_by: { aws: "experience:aws#0", "ci/cd": "experience:aws#0" },
        counts: { planned: 3, covered: 2, missing: 1 },
      },
    });
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact-tailoring-incomplete-audit",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      tailoringExplanation: {
        keywords: {
          coverageRecorded: true,
          planned: ["aws", "ci/cd", "observability"],
          covered: ["aws", "ci/cd"],
          missing: ["observability"],
        },
      },
    });
    expect(response.json().tailoringExplanation.quality.errors[0]).toContain(
      "Tailoring audit metadata incomplete: missing target seniority",
    );
    expect(response.json().tailoringExplanation.quality.errors[0]).toContain("selected model");
    expect(response.json().tailoringExplanation.quality.errors[0]).toContain("persona review");

    await app.close();
  });

  it("does not synthesize a PDF artifact's audit from a sibling artifact's metadata", async () => {
    // Phase 4 (AUDIT-01): the sibling-FILE / sibling-metadata fallback is deleted.
    // A PDF artifact whose own metadata is a shell renders ONLY its own (incomplete)
    // metadata — it does NOT borrow the sibling text resume's complete audit blob.
    const resumePath = path.join(tempDir, "tailoring-pdf-no-synth-resume.txt");
    const pdfPath = path.join(tempDir, "tailoring-pdf-no-synth-resume.pdf");
    fs.writeFileSync(resumePath, "Executive platform resume with AWS and CI/CD.");
    fs.writeFileSync(pdfPath, "fake pdf");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    insertJob(seedDb, {
      url: "https://example.com/jobs/tailoring-pdf-no-synth",
      title: "Platform Director",
      site: "EvidenceCo",
      fitScore: 9,
      tailoredPath: resumePath,
      fullDescription: "Platform Director role requiring AWS, CI/CD, and Platform Engineering.",
    });
    insertScore(seedDb, "https://example.com/jobs/tailoring-pdf-no-synth", 1, 9, {
      keywords: ["AWS", "CI/CD", "Platform Engineering"],
    });
    // The sibling text resume carries a COMPLETE audit blob...
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-pdf-no-synth",
      artifactId: "artifact-tailoring-pdf-no-synth-text",
      artifactType: "tailored_resume",
      status: "approved",
      path: resumePath,
      metadata: completeTailoringAuditMetadata(),
    });
    // ...but the PDF's own metadata is a shell. Its explanation must reflect ONLY
    // the shell (so it is honestly flagged incomplete), never the sibling's audit.
    insertMaterialsGeneration(seedDb, {
      jobUrl: "https://example.com/jobs/tailoring-pdf-no-synth",
      artifactId: "artifact-tailoring-pdf-no-synth-pdf",
      artifactType: "resume_pdf",
      status: "approved",
      path: pdfPath,
      metadata: {
        quality_checks: {
          errors: [],
          warnings: [],
          notes: [],
        },
      },
    });
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact-tailoring-pdf-no-synth-pdf",
    });

    expect(response.statusCode, response.body).toBe(200);
    const explanation = response.json().tailoringExplanation;
    // The PDF does NOT borrow the sibling's complete audit fields.
    expect(explanation.targetSeniority).toBeNull();
    expect(explanation.claimMode).toBeNull();
    expect(explanation.models.selectedModel).toBeNull();
    expect(explanation.models.judgeModel).toBeNull();
    // It is honestly flagged as incomplete instead of synthesised-from-sibling.
    expect(JSON.stringify(explanation.quality.errors)).toContain(
      "Tailoring audit metadata incomplete",
    );

    await app.close();
  });

  it("returns null tailoring explanation for legacy material artifacts without metadata column", async () => {
    const resumePath = path.join(tempDir, "legacy-no-metadata-resume.txt");
    fs.writeFileSync(resumePath, "legacy tailored resume");
    const seedDb = new Database(options.dbPath);
    seedDb.exec(`
      CREATE TABLE IF NOT EXISTS job_materials (
        job_url TEXT NOT NULL,
        generation INTEGER NOT NULL,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
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
        created_at TEXT NOT NULL,
        PRIMARY KEY (job_url, generation, artifact_type)
      );
    `);
    insertJob(seedDb, {
      url: "https://example.com/jobs/legacy-no-metadata",
      title: "Legacy Resume Engineer",
      site: "LegacyCo",
      fitScore: 8,
      tailoredPath: resumePath,
    });
    seedDb
      .prepare(
        `INSERT INTO job_materials (
           job_url, generation, tenant_id, status, created_at, updated_at
         ) VALUES (?, 1, 'local', 'resume_approved', ?, ?)`,
      )
      .run(
        "https://example.com/jobs/legacy-no-metadata",
        "2026-05-26T10:00:00+00:00",
        "2026-05-26T10:00:00+00:00",
      );
    seedDb
      .prepare(
        `INSERT INTO job_materials_artifacts (
           job_url, generation, artifact_type, artifact_id, status, path,
           render_format, size_bytes, created_at
         ) VALUES (?, 1, 'tailored_resume', 'artifact-legacy-no-metadata', 'approved', ?, 'text', ?, ?)`,
      )
      .run(
        "https://example.com/jobs/legacy-no-metadata",
        resumePath,
        fs.statSync(resumePath).size,
        "2026-05-26T10:00:00+00:00",
      );
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/artifacts/artifact-legacy-no-metadata",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      artifact: {
        artifactId: "artifact-legacy-no-metadata",
        type: "tailored_resume",
      },
      tailoringExplanation: null,
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

  it("serves a rendered PNG page preview for a known PDF artifact", async () => {
    const rendered: Array<{ path: string; pageNumber: number }> = [];
    const app = buildApp({
      ...options,
      artifactPdfPageRenderer: async (artifactPath, pageNumber) => {
        rendered.push({ path: artifactPath, pageNumber });
        return Buffer.from("png page");
      },
    });
    const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_pdf" });
    const artifact = listResponse.json().items[0];
    fs.writeFileSync(artifact.localPath, "%PDF test");

    const response = await app.inject({
      method: "GET",
      url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/preview/page/2.png`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("image/png");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toBe("png page");
    expect(rendered).toEqual([{ path: artifact.localPath, pageNumber: 2 }]);

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

  it("dispatches run-after bulk retry as grouped preparation workflows", async () => {
    const secondFailedUrl = "https://example.com/jobs/failed-score-two";
    const seedDb = new Database(options.dbPath);
    insertJob(seedDb, {
      url: secondFailedUrl,
      title: "Second Failed Score",
      site: "ExampleCo",
      fitScore: null,
      scoredAt: null,
    });
    insertStage(seedDb, secondFailedUrl, "discover", "succeeded");
    insertStage(seedDb, secondFailedUrl, "enrich", "succeeded");
    insertStage(seedDb, secondFailedUrl, "score", "failed", "LLM_ERROR");
    seedDb.close();
    const dispatch = vi.fn(async (): Promise<ActionDispatchResult> => ({
      status: "queued",
      workflowId: "retry-score-workflow",
      runId: "retry-score-run",
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-retry-failed",
      payload: {
        allMatching: false,
        jobKeys: [
          "https://example.com/jobs/failed-score",
          secondFailedUrl,
          "https://example.com/jobs/ready",
        ],
        runAfter: true,
        workers: 14,
        minScore: 8,
        validationMode: "strict",
        dryRun: false,
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      count: 2,
      jobKeys: ["https://example.com/jobs/failed-score", secondFailedUrl],
      stageCounts: { score: 2 },
      runAfter: true,
      status: "queued",
      actions: [
        {
          action: "run_stage",
          status: "queued",
          jobKey: "pipeline",
          workflowId: "retry-score-workflow",
          runId: "retry-score-run",
          command: {
            action: "run_stage",
            jobKey: "pipeline",
            jobKeys: ["https://example.com/jobs/failed-score", secondFailedUrl],
            stage: "score",
            stages: ["score", "tailor", "cover"],
            workers: 14,
            limit: 2,
            minScore: 8,
            validationMode: "strict",
            dryRun: false,
          },
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "pipeline",
        jobKeys: ["https://example.com/jobs/failed-score", secondFailedUrl],
        stage: "score",
        stages: ["score", "tailor", "cover"],
        workers: 14,
        limit: 2,
        minScore: 8,
        validationMode: "strict",
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    const db = new Database(options.dbPath);
    const states = db
      .prepare("SELECT job_url, state FROM job_stage_states WHERE stage = 'score' AND job_url IN (?, ?) ORDER BY job_url")
      .all("https://example.com/jobs/failed-score", secondFailedUrl) as Array<{ job_url: string; state: string }>;
    const queuedEvents = db
      .prepare("SELECT job_url, event_type, payload_json FROM job_events WHERE event_type = 'StageQueued' ORDER BY job_url")
      .all() as Array<{ job_url: string; event_type: string; payload_json: string }>;
    db.close();

    expect(states).toEqual([
      { job_url: "https://example.com/jobs/failed-score", state: "queued" },
      { job_url: secondFailedUrl, state: "queued" },
    ]);
    expect(queuedEvents).toHaveLength(2);
    expect(JSON.parse(queuedEvents[0]!.payload_json)).toMatchObject({
      source: "bulk_retry_failed",
      workflowId: "retry-score-workflow",
      runId: "retry-score-run",
      requestedWorkers: 14,
      requestedLimit: 2,
    });

    await app.close();
  });

  it("dispatches eligible pending preparation as grouped workflows without resetting failures or apply", async () => {
    const pendingEnrichUrl = "https://example.com/jobs/pending-enrich";
    const pendingScoreUrl = "https://example.com/jobs/pending-score-bulk";
    const pendingTailorUrl = "https://example.com/jobs/pending-tailor-bulk";
    const pendingApplyUrl = "https://example.com/jobs/pending-apply";
    const lowFitTailorUrl = "https://example.com/jobs/low-fit-pending-tailor";
    const seedDb = new Database(options.dbPath);
    insertJob(seedDb, {
      url: pendingEnrichUrl,
      title: "Pending Enrich",
      site: "ExampleCo",
      fullDescription: "",
      fitScore: null,
      scoredAt: null,
    });
    insertStage(seedDb, pendingEnrichUrl, "discover", "succeeded");
    insertStage(seedDb, pendingEnrichUrl, "enrich", "pending");
    insertJob(seedDb, {
      url: pendingScoreUrl,
      title: "Pending Score",
      site: "ExampleCo",
      fitScore: null,
      scoredAt: null,
    });
    insertStage(seedDb, pendingScoreUrl, "discover", "succeeded");
    insertStage(seedDb, pendingScoreUrl, "enrich", "succeeded");
    insertStage(seedDb, pendingScoreUrl, "score", "pending");
    insertJob(seedDb, {
      url: pendingTailorUrl,
      title: "Pending Tailor",
      site: "ExampleCo",
      fitScore: 8,
    });
    insertScore(seedDb, pendingTailorUrl, 1, 8);
    insertStage(seedDb, pendingTailorUrl, "discover", "succeeded");
    insertStage(seedDb, pendingTailorUrl, "enrich", "succeeded");
    insertStage(seedDb, pendingTailorUrl, "score", "succeeded");
    insertStage(seedDb, pendingTailorUrl, "tailor", "pending");
    insertJob(seedDb, {
      url: lowFitTailorUrl,
      title: "Low Fit Pending Tailor",
      site: "ExampleCo",
      fitScore: 5,
    });
    insertScore(seedDb, lowFitTailorUrl, 1, 5);
    insertStage(seedDb, lowFitTailorUrl, "discover", "succeeded");
    insertStage(seedDb, lowFitTailorUrl, "enrich", "succeeded");
    insertStage(seedDb, lowFitTailorUrl, "score", "succeeded");
    insertStage(seedDb, lowFitTailorUrl, "tailor", "pending");
    insertJob(seedDb, {
      url: pendingApplyUrl,
      title: "Pending Apply",
      site: "ExampleCo",
      fitScore: 9,
      tailoredPath: "/tmp/resume.pdf",
    });
    insertScore(seedDb, pendingApplyUrl, 1, 9);
    insertStage(seedDb, pendingApplyUrl, "discover", "succeeded");
    insertStage(seedDb, pendingApplyUrl, "enrich", "succeeded");
    insertStage(seedDb, pendingApplyUrl, "score", "succeeded");
    insertStage(seedDb, pendingApplyUrl, "tailor", "succeeded");
    insertStage(seedDb, pendingApplyUrl, "cover", "succeeded");
    insertStage(seedDb, pendingApplyUrl, "apply", "pending");
    seedDb.close();
    const dispatch = vi.fn(async (command: ActionCommandPayload): Promise<ActionDispatchResult> => ({
      status: "queued",
      workflowId: `pending-${command.stage}-workflow`,
      runId: `pending-${command.stage}-run`,
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-run-pending-preparation",
      payload: {
        allMatching: false,
        jobKeys: [
          pendingEnrichUrl,
          pendingScoreUrl,
          pendingTailorUrl,
          lowFitTailorUrl,
          pendingApplyUrl,
          "https://example.com/jobs/failed-score",
        ],
        workers: 14,
        minScore: 7,
        validationMode: "normal",
        dryRun: false,
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      count: 3,
      jobKeys: [pendingEnrichUrl, pendingScoreUrl, pendingTailorUrl],
      stageCounts: { enrich: 1, score: 1, tailor: 1 },
      status: "queued",
    });
    expect(dispatch).toHaveBeenCalledTimes(3);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "pipeline",
        jobKeys: [pendingEnrichUrl],
        stage: "enrich",
        stages: ["enrich", "score", "tailor", "cover"],
        workers: 14,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "pipeline",
        jobKeys: [pendingScoreUrl],
        stage: "score",
        stages: ["score", "tailor", "cover"],
        workers: 14,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "pipeline",
        jobKeys: [pendingTailorUrl],
        stage: "tailor",
        stages: ["tailor", "cover"],
        workers: 14,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    const db = new Database(options.dbPath);
    const queuedStates = db
      .prepare(
        `SELECT job_url, stage, state FROM job_stage_states
         WHERE job_url IN (?, ?, ?) AND state = 'queued'
         ORDER BY job_url`,
      )
      .all(pendingEnrichUrl, pendingScoreUrl, pendingTailorUrl) as Array<{
        job_url: string;
        stage: string;
        state: string;
      }>;
    const failed = db
      .prepare("SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'score'")
      .get("https://example.com/jobs/failed-score") as { state: string };
    const apply = db
      .prepare("SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'apply'")
      .get(pendingApplyUrl) as { state: string };
    const queuedEvent = db
      .prepare("SELECT payload_json FROM job_events WHERE event_type = 'StageQueued' AND job_url = ?")
      .get(pendingScoreUrl) as { payload_json: string };
    db.close();

    expect(queuedStates).toEqual([
      { job_url: pendingEnrichUrl, stage: "enrich", state: "queued" },
      { job_url: pendingScoreUrl, stage: "score", state: "queued" },
      { job_url: pendingTailorUrl, stage: "tailor", state: "queued" },
    ]);
    expect(failed.state).toBe("failed");
    expect(apply.state).toBe("pending");
    expect(JSON.parse(queuedEvent.payload_json)).toMatchObject({
      source: "bulk_run_pending_preparation",
      workflowId: "pending-score-workflow",
      requestedWorkers: 14,
    });

    await app.close();
  });

  it("skips non-retryable failed stages in the bulk retry action", async () => {
    const seedDb = new Database(options.dbPath);
    seedDb
      .prepare(
        `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "https://example.com/jobs/failed-score",
        "score",
        "StageFailed",
        "error",
        "score failed",
        "2026-04-29T12:00:00+00:00",
        JSON.stringify({ retryable: false }),
      );
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-retry-failed",
      payload: {
        allMatching: false,
        jobKeys: ["https://example.com/jobs/failed-score"],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      count: 0,
      jobKeys: [],
    });

    const db = new Database(options.dbPath);
    const failed = db
      .prepare("SELECT state, retryable FROM job_stage_states WHERE job_url = ? AND stage = 'score'")
      .get("https://example.com/jobs/failed-score") as { state: string; retryable: number };
    db.close();

    expect(failed).toMatchObject({ state: "failed", retryable: 1 });

    await app.close();
  });

  it("retries enrich scrape failures even when prior diagnostics marked them non-retryable", async () => {
    const jobUrl = "https://example.com/jobs/failed-enrich";
    const seedDb = new Database(options.dbPath);
    insertJob(seedDb, {
      url: jobUrl,
      title: "Failed Enrich Engineer",
      site: "ExampleCo",
    });
    insertStage(seedDb, jobUrl, "discover", "succeeded");
    insertStage(seedDb, jobUrl, "enrich", "failed", "DETAIL_ERROR");
    seedDb
      .prepare(
        "UPDATE job_stage_states SET retryable = 0 WHERE job_url = ? AND stage = 'enrich'",
      )
      .run(jobUrl);
    seedDb
      .prepare(
        `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        jobUrl,
        "enrich",
        "StageFailed",
        "error",
        "no data extracted",
        "2026-04-29T12:00:00+00:00",
        JSON.stringify({ retryable: false, errorMessage: "no data extracted" }),
      );
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-retry-failed",
      payload: {
        allMatching: false,
        jobKeys: [jobUrl],
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [jobUrl],
    });

    const db = new Database(options.dbPath);
    const enrich = db
      .prepare("SELECT state FROM job_stage_states WHERE job_url = ? AND stage = 'enrich'")
      .get(jobUrl) as { state: string };
    db.close();

    expect(enrich.state).toBe("pending");

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

  it("dispatches run-after preparation retry through the job-scoped pipeline path", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/failed-score");

    const retryResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retry-stage`,
      payload: { stage: "enrich", runAfter: true, dryRun: true },
    });

    expect(retryResponse.statusCode, retryResponse.body).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "retry_stage",
        jobKey: "https://example.com/jobs/failed-score",
        stage: "enrich",
        stages: ["enrich", "score", "tailor", "cover"],
        runAfter: true,
        dryRun: true,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("dispatches pending preparation pickup without resetting the stage", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const db = new Database(options.dbPath);
    insertJob(db, {
      url: "https://example.com/jobs/pending-score",
      title: "Unscored Platform Engineer",
      site: "ExampleCo",
      fitScore: null,
      scoredAt: null,
    });
    insertStage(db, "https://example.com/jobs/pending-score", "discover", "succeeded");
    insertStage(db, "https://example.com/jobs/pending-score", "enrich", "succeeded");
    insertStage(db, "https://example.com/jobs/pending-score", "score", "pending");
    db.close();
    const jobKey = encodeURIComponent("https://example.com/jobs/pending-score");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/run-stage`,
      payload: { stage: "score", dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "https://example.com/jobs/pending-score",
        stage: "score",
        stages: ["score", "tailor", "cover"],
        dryRun: true,
        limit: 1,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("does not dispatch automatic pickup for known-ineligible preparation work", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const db = new Database(options.dbPath);
    insertJob(db, {
      url: "https://example.com/jobs/low-fit-tailor",
      title: "Low Fit Tailor",
      site: "ExampleCo",
      fitScore: 5,
    });
    insertScore(db, "https://example.com/jobs/low-fit-tailor", 1, 5);
    insertStage(db, "https://example.com/jobs/low-fit-tailor", "discover", "succeeded");
    insertStage(db, "https://example.com/jobs/low-fit-tailor", "enrich", "succeeded");
    insertStage(db, "https://example.com/jobs/low-fit-tailor", "score", "succeeded");
    insertStage(db, "https://example.com/jobs/low-fit-tailor", "tailor", "pending");
    db.close();
    const jobKey = encodeURIComponent("https://example.com/jobs/low-fit-tailor");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/run-stage`,
      payload: { stage: "tailor", dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "run_stage",
      status: "not_eligible",
      jobKey: "https://example.com/jobs/low-fit-tailor",
      result: { reason: "score_below_threshold" },
    });
    expect(dispatch).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects job-scoped preparation pickup for missing jobs", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/missing");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/run-stage`,
      payload: { stage: "score", dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "job_not_found",
    });
    expect(dispatch).not.toHaveBeenCalled();

    await app.close();
  });

  it("rejects unsupported job-scoped starts for non-preparation stages", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/run-stage`,
      payload: { stage: "apply", dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "unsupported_job_stage_run",
      stage: "apply",
    });
    expect(dispatch).not.toHaveBeenCalled();

    await app.close();
  });

  it("dispatches per-job material generation over the material stages (INSPECT-01)", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test", runId: "run-materials" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const generateResponse = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/generate-materials`,
      payload: { stages: ["tailor", "cover"], dryRun: true, limit: 1 },
    });

    expect(generateResponse.statusCode, generateResponse.body).toBe(202);
    expect(generateResponse.json()).toMatchObject({
      ok: true,
      action: "run_stage",
      status: "queued",
      jobKey: "https://example.com/jobs/ready",
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "https://example.com/jobs/ready",
        stage: "tailor",
        stages: ["tailor", "cover"],
        dryRun: true,
        limit: 1,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("defaults per-job material generation to the tailor+cover stages", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test", runId: "run-materials" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/generate-materials`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        stage: "tailor",
        stages: ["tailor", "cover"],
      }),
      expect.anything(),
    );

    await app.close();
  });

  it("rejects per-job material generation for missing jobs", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/missing");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/generate-materials`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: "job_not_found" });
    expect(dispatch).not.toHaveBeenCalled();

    await app.close();
  });

  it("guards per-job material generation behind worker readiness", async () => {
    const { actionDispatcher: _ignored, ...optionsWithoutDispatcher } = options;
    const app = buildApp({ ...optionsWithoutDispatcher, requireHealthyWorkerForActions: true });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/generate-materials`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, error: "worker_runtime_unavailable" });

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
    const tailorJob = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/tailor`,
      payload: { dryRun: true, reason: "manual low-fit override" },
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

    for (const response of [rescoreJob, rescoreBulk, tailorJob, retailorJob, retailorBulk]) {
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({ ok: true, status: "queued" });
    }
    expect(dispatch).toHaveBeenCalledTimes(5);
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
        action: "tailor_job",
        jobKey: "https://example.com/jobs/ready",
        dryRun: true,
        reason: "manual low-fit override",
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      4,
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
      5,
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
    const db = new Database(options.dbPath);
    try {
      const events = db
        .prepare("SELECT event_type FROM job_events WHERE job_url = ? ORDER BY event_id DESC")
        .all("https://example.com/jobs/ready")
        .map((row) => (row as { event_type: string }).event_type);
      expect(events).toContain("TailorRequested");
      expect(events).toContain("RetailorRequested");
    } finally {
      db.close();
    }

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

  it("cancels an in-flight workflow run by run id", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
      ).run(
        null,
        "discover",
        "StageStarted",
        "info",
        "Discover workflow started",
        "2026-04-29T10:20:00+00:00",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          runId: "discovery:jobspy:run-1",
          workflowId: "workflow-run-1",
          progress: {
            completed: 0,
            total: 6,
            percent: 0,
            currentStep: "JobSpy",
            status: "running",
            message: "JobSpy started",
          },
        }),
      );
      db.exec(`
        CREATE TABLE discovery_runs (
          tenant_id TEXT NOT NULL DEFAULT 'local',
          run_id TEXT NOT NULL,
          source_ids_json TEXT NOT NULL DEFAULT '[]',
          profile_snapshot_id TEXT,
          status TEXT NOT NULL,
          counts_json TEXT NOT NULL DEFAULT '{}',
          progress_json TEXT NOT NULL DEFAULT '{}',
          error_classes_json TEXT NOT NULL DEFAULT '[]',
          started_at TEXT NOT NULL,
          updated_at TEXT,
          completed_at TEXT,
          failed_at TEXT,
          workflow_id TEXT,
          PRIMARY KEY (tenant_id, run_id)
        );
      `);
      db.prepare(
        `INSERT INTO discovery_runs (
          tenant_id, run_id, source_ids_json, status, counts_json, progress_json,
          error_classes_json, started_at, updated_at, workflow_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "local",
        "discovery:jobspy:run-1",
        JSON.stringify(["jobspy:indeed"]),
        "running",
        JSON.stringify({ total: 0, new_jobs: 0, existing_jobs: 0 }),
        JSON.stringify({ completed: 0, total: 72, unit: "searches" }),
        JSON.stringify([]),
        "2026-04-29T10:20:00+00:00",
        "2026-04-29T10:20:00+00:00",
        "workflow-run-1",
      );
    } finally {
      db.close();
    }
    const dispatch = vi.fn(async () => ({
      runId: "workflow-run-1",
      status: "cancel_requested",
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/workflow-runs/workflow-run-1/actions/cancel",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "cancel",
      status: "cancel_requested",
      jobKey: "pipeline",
      runId: "workflow-run-1",
      command: {
        action: "cancel",
        jobKey: "pipeline",
        runId: "workflow-run-1",
      },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "cancel",
        jobKey: "pipeline",
        runId: "workflow-run-1",
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    const summaryResponse = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
    expect(summaryResponse.statusCode, summaryResponse.body).toBe(200);
    expect(summaryResponse.json().progress).toContainEqual(
      expect.objectContaining({
        stage: "discover",
        status: "failed",
        runId: "discovery:jobspy:run-1",
        workflowId: "workflow-run-1",
        message: "Discover canceled",
      }),
    );
    const verifyDb = new Database(options.dbPath);
    try {
      const row = verifyDb
        .prepare(
          "SELECT status, error_classes_json, failed_at, updated_at, progress_json FROM discovery_runs WHERE run_id = ?",
        )
        .get("discovery:jobspy:run-1") as
        | {
            status: string;
            error_classes_json: string;
            failed_at: string;
            updated_at: string;
            progress_json: string;
          }
        | undefined;
      expect(row).toBeDefined();
      expect(row).toMatchObject({
        status: "failed",
        failed_at: expect.any(String),
        updated_at: expect.any(String),
      });
      expect(JSON.parse(row?.error_classes_json ?? "[]")).toEqual(["canceled"]);
      expect(JSON.parse(row?.progress_json ?? "{}")).toMatchObject({
        status: "failed",
        message: "Discover canceled",
      });
    } finally {
      verifyDb.close();
    }

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

  it("returns empty relational profile configuration when rows are absent", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/profile" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body).toMatchObject({
      ok: true,
      profile: {},
      style: { font_family: "sans" },
    });
    expect(body.templateText).toContain("{{ personal_data }}");
    expect(body.paths).toBeUndefined();
    const db = new Database(options.dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM candidate_profiles").get()).toMatchObject({ count: 0 });
      const rootColumns = db.prepare("PRAGMA table_info(candidate_profiles)").all() as Array<{ name: string }>;
      expect(rootColumns.map((column) => column.name)).not.toEqual(expect.arrayContaining(["style_json", "payload_json"]));
    } finally {
      db.close();
    }

    await app.close();
  });

  it("uses a default resume template before the profile is initialized", async () => {
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

  it("persists profile, style, and template updates to relational rows without rewriting stray files", async () => {
    const app = buildApp(options);
    const originalStrayProfile = fs.readFileSync(strayProfileExportPath, "utf8");
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
    expect(fs.readFileSync(strayProfileExportPath, "utf8")).toBe(originalStrayProfile);
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

  it("preserves profile achievement evidence and tailoring quality controls", async () => {
    const app = buildApp(options);
    const profile = validProfileFixture("Evidence Candidate");
    const resume = profile.resume as Record<string, unknown>;
    const entries = resume.experience_entries as Array<Record<string, unknown>>;
    entries[0]!.achievement_evidence = [
      {
        id: "ev_role_1_latency",
        source_text: "Reduced API latency 35% by replacing synchronous enrichment calls.",
        scope: "owned service",
        action: "replaced synchronous enrichment calls",
        tools: ["Python", "PostgreSQL"],
        metrics: ["35% latency reduction"],
        outcome: "faster API responses",
        seniority_signal: "technical ownership",
        evidence_strength: "verified",
        claim_confidence: 0.95,
        user_confirmed: true,
        tags: ["latency", "backend", "performance"],
      },
    ];
    resume.tailoring_rules = {
      tailoring_policy: {
        mode: "aggressive",
        claim_mode: "draft_requires_confirmation",
        auto_approvable_claim_modes: ["verified_only", "draft_requires_confirmation"],
        allow_adjacent_achievement_drafts: true,
      },
    };

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.profile.resume.experience_entries[0].achievement_evidence[0]).toMatchObject({
      id: "ev_role_1_latency",
      metrics: ["35% latency reduction"],
      claim_confidence: 0.95,
      user_confirmed: true,
    });
    expect(body.profile.resume.tailoring_rules.tailoring_policy).toMatchObject({
      mode: "aggressive",
      claim_mode: "draft_requires_confirmation",
      auto_approvable_claim_modes: ["verified_only"],
      allow_adjacent_achievement_drafts: true,
    });

    const db = new Database(options.dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM candidate_profile_achievement_evidence").get()).toMatchObject({
        count: 1,
      });
      expect(
        db.prepare(
          "SELECT tailoring_claim_mode, tailoring_auto_approvable_claim_modes_json, "
            + "tailoring_allow_adjacent_achievement_drafts FROM candidate_profiles",
        ).get(),
      ).toMatchObject({
        tailoring_claim_mode: "draft_requires_confirmation",
        tailoring_auto_approvable_claim_modes_json: '["verified_only"]',
        tailoring_allow_adjacent_achievement_drafts: 1,
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
        stages: ["tailor", "cover"],
        dryRun: false,
        limit: 0,
        minScore: 6,
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
    const app = buildApp(options);
    const seed = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: validProfileFixture("Style Candidate"),
        style: { font_family: "roman", moderncv_color: "blue" },
      },
    });
    expect(seed.statusCode, seed.body).toBe(200);

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

  it("ignores unsupported top-level fields in stray profile files", async () => {
    fs.writeFileSync(
      strayProfileExportPath,
      JSON.stringify({ ...validProfileFixture("Future Export"), custom_section: { future: "thing" } }),
    );
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/profile" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      profile: {},
    });
    const db = new Database(options.dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM candidate_profiles").get()).toMatchObject({ count: 0 });
    } finally {
      db.close();
    }

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
    const originalProfile = fs.readFileSync(strayProfileExportPath, "utf8");
    const originalStyle = fs.readFileSync(strayStyleExportPath, "utf8");
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
    expect(fs.readFileSync(strayProfileExportPath, "utf8")).toBe(originalProfile);
    expect(fs.readFileSync(strayStyleExportPath, "utf8")).toBe(originalStyle);
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
    const seed = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: validProfileFixture("Jordan Candidate"),
        templateText: "\\documentclass{article}",
      },
    });
    expect(seed.statusCode, seed.body).toBe(200);
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
    "INSERT INTO apply_run_projections (run_id, job_id, job_title, job_employer, status, result, dry_run, started_at, events_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "run-1",
    "https://example.com/jobs/ready",
    "Platform Engineer",
    "ExampleCo",
    "finished",
    "succeeded",
    1,
    "2026-04-29T10:15:00+00:00",
    JSON.stringify([
      {
        event_type: "ApplyRunStarted",
        level: "info",
        occurred_at: "2026-04-29T10:15:00+00:00",
        message: "Apply agent acquired job",
        payload: { run_id: "run-1" },
      },
    ]),
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
    description?: string;
    fullDescription?: string;
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
    job.description ?? "Short description",
    job.fullDescription ?? "Long description",
    "2026-04-29T10:01:00+00:00",
    job.fitScore ?? null,
    "Good fit",
    job.scoredAt === undefined ? "2026-04-29T10:02:00+00:00" : job.scoredAt,
    job.tailoredPath ?? null,
    job.tailoredPath ? "2026-04-29T10:03:00+00:00" : null,
  );
}

function insertPostedCompensationFact(db: Database.Database, jobUrl: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_posted_compensation_facts (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      source_field TEXT NOT NULL DEFAULT 'jobs.salary',
      source_text TEXT,
      legacy_raw_salary TEXT,
      parse_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'unknown',
      component TEXT NOT NULL DEFAULT 'unknown',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      annualized_minimum_amount INTEGER,
      annualized_maximum_amount INTEGER,
      annualization_assumption TEXT,
      confidence TEXT NOT NULL DEFAULT 'none',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      parser_version TEXT NOT NULL,
      source_hash TEXT NOT NULL,
      parsed_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_url)
    );
  `);
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
      tenant_id, job_url, source_field, source_text, legacy_raw_salary,
      parse_state, currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
      confidence, warnings_json, parser_version, source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    "jobs.salary",
    "€55,000/year",
    "€55,000/year",
    "parsed_range",
    "EUR",
    "year",
    "base_salary",
    55_000,
    55_000,
    55_000,
    55_000,
    "Source text states annual compensation.",
    "high",
    "[]",
    "posted-compensation-v1",
    "b".repeat(64),
    "2026-06-19T10:00:00Z",
  );
}

function insertMarketCompensationEstimate(db: Database.Database, jobUrl: string): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_market_compensation_estimates (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      estimate_state TEXT NOT NULL,
      currency TEXT,
      period TEXT NOT NULL DEFAULT 'year',
      component TEXT NOT NULL DEFAULT 'base_salary',
      minimum_amount INTEGER,
      maximum_amount INTEGER,
      confidence_band TEXT NOT NULL DEFAULT 'none',
      confidence_score REAL NOT NULL DEFAULT 0,
      source_count INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER,
      aggregate_bucket TEXT,
      geography_scope TEXT,
      occupation_code TEXT,
      occupation_label TEXT,
      seniority_label TEXT,
      source_snapshot_json TEXT NOT NULL DEFAULT '[]',
      factor_reasons_json TEXT NOT NULL DEFAULT '[]',
      insufficient_reasons_json TEXT NOT NULL DEFAULT '[]',
      unsupported_reasons_json TEXT NOT NULL DEFAULT '[]',
      source_unavailable_reasons_json TEXT NOT NULL DEFAULT '[]',
      warnings_json TEXT NOT NULL DEFAULT '[]',
      estimator_version TEXT NOT NULL,
      estimated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_url)
    );
  `);
  db.prepare(
    `INSERT INTO job_market_compensation_estimates (
      tenant_id, job_url, estimate_state, currency, period, component,
      minimum_amount, maximum_amount, confidence_band, confidence_score,
      source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json,
      factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
      source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobUrl,
    "estimated_range",
    "EUR",
    "year",
    "base_salary",
    72_000,
    92_000,
    "medium",
    0.82,
    2,
    900,
    "Eurostat SES occupation/country aggregate",
    "remote_europe",
    "2512.1",
    "Software developer",
    "aggregate",
    JSON.stringify([
      {
        source_id: "eurostat_structure_of_earnings",
        display_name: "Eurostat Structure of Earnings Survey",
        source_type: "public_wage_baseline",
        release_year: 2024,
        snapshot_version: "synthetic-public-fixture",
        geography_scope: "EU",
        aggregate_bucket: "Eurostat SES occupation/country aggregate",
        attribution: "Eurostat public statistical aggregate",
        sample_count: 900,
      },
    ]),
    JSON.stringify([{ name: "occupation", score: 0.9, band: "high", reason: "Occupation mapped." }]),
    "[]",
    "[]",
    "[]",
    JSON.stringify(["aggregate_baseline", "remote_europe_assumption"]),
    "market-compensation-v1",
    "2026-06-19T10:00:00Z",
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
    keywords?: string[];
    matchedSignals?: string[];
    missingSignals?: string[];
    transferableSignals?: string[];
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
      matched_signals: options.matchedSignals ?? ["platform reliability"],
      missing_signals: options.missingSignals ?? [],
      transferable_signals: options.transferableSignals ?? [],
    }),
    JSON.stringify(options.keywords ?? ["platform"]),
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
    CREATE TABLE IF NOT EXISTS job_bullet_provenance (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      bullet_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      artifact_id TEXT NOT NULL,
      section TEXT NOT NULL,
      source_id TEXT,
      evidence_ids_json TEXT NOT NULL DEFAULT '[]',
      requirement_ids_json TEXT NOT NULL DEFAULT '[]',
      matched_keywords_json TEXT NOT NULL DEFAULT '[]',
      transform_type TEXT NOT NULL,
      control TEXT NOT NULL,
      rationale TEXT NOT NULL DEFAULT '',
      generated_text TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      coverage_json TEXT,
      voice_json TEXT,
      PRIMARY KEY (job_url, generation, bullet_id)
    );
  `);
}

/**
 * Seed a canonical per-bullet provenance row exactly as the Python repository
 * writes it (the projection builder reads this table to materialise the
 * ``bullet_provenance_json`` / ``coverage_audit_json`` / ``voice_pass_json``
 * projection columns the read model serves). The set-level ``coverage`` / ``voice``
 * are denormalised onto every row of a generation, mirroring the Python repo.
 */
function insertBulletProvenanceRow(
  db: Database.Database,
  row: {
    jobUrl: string;
    artifactId: string;
    bulletId: string;
    section: string;
    sourceId?: string | null;
    evidenceIds?: string[];
    requirementIds?: string[];
    matchedKeywords?: string[];
    transformType: string;
    control: string;
    rationale?: string;
    generatedText: string;
    position?: number;
    coverage?: Record<string, unknown> | null;
    voice?: Record<string, unknown> | null;
    generation?: number;
  },
): void {
  db.prepare(
    `INSERT OR REPLACE INTO job_bullet_provenance (
       job_url, generation, bullet_id, tenant_id, artifact_id, section, source_id,
       evidence_ids_json, requirement_ids_json, matched_keywords_json,
       transform_type, control, rationale, generated_text, position, created_at,
       coverage_json, voice_json
     ) VALUES (?, ?, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.jobUrl,
    row.generation ?? 1,
    row.bulletId,
    row.artifactId,
    row.section,
    row.sourceId ?? null,
    JSON.stringify(row.evidenceIds ?? []),
    JSON.stringify(row.requirementIds ?? []),
    JSON.stringify(row.matchedKeywords ?? []),
    row.transformType,
    row.control,
    row.rationale ?? "",
    row.generatedText,
    row.position ?? 0,
    "2026-05-26T10:05:00+00:00",
    row.coverage ? JSON.stringify(row.coverage) : null,
    row.voice ? JSON.stringify(row.voice) : null,
  );
}

function completeTailoringAuditMetadata(): Record<string, unknown> {
  return {
    validation_mode: "normal",
    attempts: 1,
    quality_plan: {
      target_seniority: "executive",
      claim_mode: "evidence_reframing",
      auto_approvable_claim_modes: ["verified_only", "evidence_reframing"],
      allow_adjacent_achievement_drafts: false,
      job_keywords: [],
      required_evidence_ids: ["ev_scope"],
      seniority_evidence_ids: ["ev_scope"],
      verified_metric_count: 3,
    },
    quality_checks: {
      passed: true,
      errors: [],
      warnings: [],
      notes: [],
    },
    judge: {
      passed: true,
      verdict: "PASS",
      score: 0.9,
      issues: [],
      unsupported_claims: [],
      fabrications: [],
      missing_required_evidence: [],
      repair_instructions: [],
    },
    judge_min_score: 0.82,
    adversarial_review: {
      ran: true,
      passed: true,
      score: 0.9,
      score_rationale: "All personas passed.",
      threshold: 0.8,
      blockers: [],
      warnings: [],
      repair_instructions: [],
      personas: [
        {
          persona: "evidence_auditor",
          verdict: "PASS",
          score: 0.9,
          score_rationale: "Claims are supported by evidence.",
          prompt_rubric: "Check support for every tailored claim.",
          blockers: [],
          warnings: [],
          repair_instructions: [],
          score_basis: ["LLM verdict: PASS", "LLM score: 0.90", "Blockers: none"],
          response: {
            verdict: "PASS",
            score: 0.9,
            score_rationale: "Claims are supported by evidence.",
            blockers: [],
            warnings: [],
            repair_instructions: [],
          },
        },
      ],
      llm_audit: {
        model: "judge-a",
        schema_version: "tailor-adversarial.v2",
        prompt_messages: [
          {
            role: "system",
            content: "Evaluate the tailored resume using the persona rubric.",
          },
          {
            role: "user",
            content: "Return the structured adversarial review.",
          },
        ],
        response: {
          verdict: "PASS",
          score: 0.9,
          score_rationale: "All personas passed.",
          blockers: [],
          warnings: [],
          repair_instructions: [],
          personas: [
            {
              verdict: "PASS",
              score: 0.9,
              score_rationale: "Claims are supported by evidence.",
              blockers: [],
              warnings: [],
              repair_instructions: [],
            },
          ],
        },
      },
    },
    change_annotations: [
      {
        section: "executive_profile",
        label: "Executive profile",
        change_type: "summary_reframed",
        source_id: "executive_profile",
        source_text: ["Platform leadership profile."],
        tailored_text: ["Executive platform leadership profile."],
        rationale: "Profile was reframed toward executive platform leadership.",
        job_signals: ["Platform Engineering"],
        controls: ["target seniority: executive", "claim mode: evidence_reframing"],
        evidence_ids: ["ev_scope"],
        evidence_notes: ["ev_scope: platform ownership"],
      },
    ],
    candidate_models: ["generator-a"],
    selected_model: "generator-a",
    selected_candidate: "candidate-1",
    judge_model: "judge-a",
  };
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
