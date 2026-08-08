import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { createJobCtrlApiClient } from "@jobctrl/api-client";
import {
  CREDENTIAL_VALUE_MAX_LENGTH,
  CredentialKeys,
  JsonRpcErrorCodes,
  LearningRecommendationEvidenceListResponseSchema,
  LearningRecommendationListResponseSchema,
  LearningRecommendationReviewResponseSchema,
  TailoringPolicyRevisionListResponseSchema,
  TailoringPolicyRollbackResponseSchema,
  PipelineOperationsSnapshotSchema,
  ProviderConfigurationKeys,
  RpcMethods,
  ScoringKeywordAggregationResponseSchema,
  SecretCredentialKeys,
  type ActionCommandPayload,
  type CredentialBatchOperation,
  type CredentialKey,
} from "@jobctrl/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { resolveApiConfig } from "../src/config.js";
import { SUPPORTED_SCHEMA_VERSION } from "../src/db.js";
import {
  CredentialStoreUnavailableError,
  KeychainCredentialStore,
} from "../src/credentials.js";
import type { JsonRpcDispatcher } from "../src/json-rpc-adapter.js";
import {
  PROFILE_PREVIEW_SCRIPT,
  defaultActionDispatcher,
  type ActionDispatcher,
  type ActionDispatchResult,
} from "../src/local-actions.js";
import { persistProfileUpdate } from "../src/profile-events.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { buildApp, type BuildAppOptions } from "../src/server.js";
import { initializeExactV7Database } from "./v7-schema.js";

let tempDir = "";
let options: BuildAppOptions;
let strayProfileExportPath = "";
let strayStyleExportPath = "";
let strayTemplateExportPath = "";
const CHROME_EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const COMPENSATION_JOB_ID = "11111111-1111-4111-8111-111111111111";
const INERT_RESUME_TEMPLATE = "{{ personal_data }}\n\n{{ resume_body }}\n";
const REJECTED_CREDENTIAL_VALUE_MARKER =
  "rejected-credential-must-not-appear";

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
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-"));
  options = {
    dbPath: path.join(tempDir, "jobctrl.db"),
    configPath: path.join(tempDir, "config.json"),
    actionDispatcher: vi.fn(async (): Promise<ActionDispatchResult> => ({ status: "queued", runId: "run-profile-retailor" })),
    resumePdfRenderer: ({ htmlPath, pdfPath }) => {
      fs.writeFileSync(pdfPath, `%PDF-1.4 rendered\n${fs.readFileSync(htmlPath, "utf8")}`);
    },
  };
  strayProfileExportPath = path.join(tempDir, "candidate-profile-export.json");
  strayStyleExportPath = path.join(tempDir, "resume-rendering-export.json");
  strayTemplateExportPath = path.join(tempDir, "resume-rendering-export.tex");
  seedDatabase(options.dbPath);
  fs.writeFileSync(strayProfileExportPath, JSON.stringify(validProfileFixture("Jordan Candidate")));
  fs.writeFileSync(strayStyleExportPath, JSON.stringify({ font_family: "sans" }));
  fs.writeFileSync(strayTemplateExportPath, INERT_RESUME_TEMPLATE);
  fs.writeFileSync(
    options.configPath,
    JSON.stringify({
      target_role: "Platform Engineering",
      location_filter: "Remote",
      min_fit_score: 8,
      auto_apply: true,
      apply_concurrency: 3,
      daily_budget_usd: 12.5,
      score_criteria: "Security leadership and platform reliability.",
      target_criteria: "Director-plus infrastructure and security roles.",
      preferred_models: { claude: "opus" },
    }),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("local TypeScript API", () => {
  it("serves production web assets with SPA fallback and cache-safe headers", async () => {
    const webDir = path.join(tempDir, "web");
    fs.mkdirSync(path.join(webDir, "assets"), { recursive: true });
    fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><main>JobCtrl app</main>");
    fs.writeFileSync(path.join(webDir, "assets", "app-C0FFEE123.js"), "export const ready = true;");
    fs.writeFileSync(path.join(webDir, "assets", "app.12345678.js"), "export const notVite = true;");
    fs.writeFileSync(path.join(webDir, "favicon.svg"), "<svg></svg>");
    fs.writeFileSync(path.join(webDir, "favicon-C0FFEE123.svg"), "<svg></svg>");
    const app = buildApp({ ...options, webAssetsDir: webDir });

    const index = await app.inject({ method: "GET", url: "/" });
    const route = await app.inject({
      method: "GET",
      url: "/jobs/example",
      headers: { accept: "text/html", "sec-fetch-dest": "document", "sec-fetch-mode": "navigate" },
    });
    const hashedAsset = await app.inject({ method: "GET", url: "/assets/app-C0FFEE123.js" });
    const dotHashedAsset = await app.inject({ method: "GET", url: "/assets/app.12345678.js" });
    const unhashedAsset = await app.inject({ method: "GET", url: "/favicon.svg" });
    const rootHashedAsset = await app.inject({ method: "GET", url: "/favicon-C0FFEE123.svg" });
    const missingAsset = await app.inject({ method: "GET", url: "/assets/missing.js" });
    const missingNestedAsset = await app.inject({ method: "GET", url: "/images/missing.png" });
    const missingFetch = await app.inject({
      method: "GET",
      url: "/jobs/fetched",
      headers: { accept: "application/json" },
    });
    const nonNavigationHtmlFetch = await app.inject({
      method: "GET",
      url: "/jobs/fetched-html",
      headers: { accept: "text/html", "sec-fetch-mode": "cors" },
    });
    const missingApi = await app.inject({ method: "GET", url: "/v1/missing" });

    expect(index.statusCode, index.body).toBe(200);
    expect(index.body).toContain("JobCtrl app");
    expect(index.headers["cache-control"]).toBe("no-cache");
    expect(route.statusCode, route.body).toBe(200);
    expect(route.body).toContain("JobCtrl app");
    expect(route.headers["cache-control"]).toBe("no-cache");
    expect(hashedAsset.statusCode, hashedAsset.body).toBe(200);
    expect(hashedAsset.headers["content-type"]).toContain("text/javascript");
    expect(hashedAsset.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(hashedAsset.headers["x-content-type-options"]).toBe("nosniff");
    expect(dotHashedAsset.headers["cache-control"]).toBe("no-cache");
    expect(unhashedAsset.headers["cache-control"]).toBe("no-cache");
    expect(rootHashedAsset.headers["cache-control"]).toBe("no-cache");
    expect(missingAsset.statusCode, missingAsset.body).toBe(404);
    expect(missingNestedAsset.statusCode, missingNestedAsset.body).toBe(404);
    expect(missingFetch.statusCode, missingFetch.body).toBe(404);
    expect(missingFetch.body).not.toContain("JobCtrl app");
    expect(nonNavigationHtmlFetch.statusCode, nonNavigationHtmlFetch.body).toBe(404);
    expect(nonNavigationHtmlFetch.body).not.toContain("JobCtrl app");
    expect(missingApi.statusCode, missingApi.body).toBe(404);

    await app.close();
  });

  it("rejects production web traversal and keeps loopback host enforcement", async () => {
    const webDir = path.join(tempDir, "web");
    fs.mkdirSync(webDir, { recursive: true });
    fs.writeFileSync(path.join(webDir, "index.html"), "<!doctype html><main>JobCtrl app</main>");
    fs.writeFileSync(path.join(tempDir, "outside.txt"), "must not be served");
    const app = buildApp({ ...options, webAssetsDir: webDir });

    const traversal = await app.inject({ method: "GET", url: "/..%2Foutside.txt" });
    const forbiddenHost = await app.inject({
      method: "GET",
      url: "/",
      headers: { host: "example.test" },
    });

    expect(traversal.statusCode, traversal.body).toBe(400);
    expect(traversal.body).not.toContain("must not be served");
    expect(forbiddenHost.statusCode, forbiddenHost.body).toBe(403);
    expect(forbiddenHost.json()).toMatchObject({ ok: false, error: "forbidden_host" });

    await app.close();
  });

  it("defaults the shared API client to the local API origin under Node.js", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, dbPath: options.dbPath, dbExists: true }), {
        status: 200,
        statusText: "OK",
      }),
    );

    await createJobCtrlApiClient().health();

    // The client attaches an AbortSignal (per-request timeout) to every fetch;
    // assert the URL + method and ignore the signal implementation detail.
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/v1/health",
      expect.objectContaining({ method: "GET" }),
    );
    fetchMock.mockRestore();
  });

  it("refuses non-loopback API binds unless explicitly allowed", () => {
    expect(() => resolveApiConfig({ JOBCTRL_API_HOST: "0.0.0.0" })).toThrow(/Refusing to bind/);
    expect(
      resolveApiConfig({
        JOBCTRL_API_HOST: "0.0.0.0",
        JOBCTRL_API_ALLOW_REMOTE_BIND: "1",
        JOBCTRL_DIR: path.join(tempDir, "remote-bind"),
      }).host,
    ).toBe("0.0.0.0");
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
    const health = response.json();
    expect(health).toMatchObject({
      ok: true,
      appDir: tempDir,
      dbPath: options.dbPath,
      dbExists: true,
      llmSpend: {
        status: "ok",
        inputTokens: 0,
        outputTokens: 0,
        estimatedUsd: 0,
        dailyBudgetUsd: 12.5,
        remainingUsd: 12.5,
        unlimited: false,
      },
      worker: {
        status: "missing",
        expectedDbPath: options.dbPath,
        expectedAppDir: tempDir,
        heartbeat: null,
      },
    });
    for (const policyKey of [
      "analysisLegs",
      "tailoringGeneratorModels",
      "tailoringJudgeModel",
      "tailoringJudgeMinScore",
      "applyMaxBudgetUsd",
      "applyTimeoutSeconds",
    ]) {
      expect(health.llmSpend).not.toHaveProperty(policyKey);
    }

    await app.close();
  });

  it("rejects legacy lifecycle tables before health-only startup completes", async () => {
    const legacyDbPath = path.join(tempDir, "legacy-health.sqlite3");
    const token = "job" + "ctl";
    const db = new Database(legacyDbPath);
    db.exec(`
      CREATE TABLE ${token}_hidden_jobs (
        job_url TEXT PRIMARY KEY,
        hidden_at TEXT NOT NULL,
        reason TEXT
      );
      INSERT INTO ${token}_hidden_jobs
        (job_url, hidden_at, reason)
      VALUES ('https://example.test/legacy-health', '2026-07-07T00:00:00Z', 'legacy');
    `);
    db.close();

    expect(() => buildApp({ ...options, dbPath: legacyDbPath })).toThrow("schema version 0");
  });

  it("reports today's LLM spend against the configured budget", async () => {
    const day = new Date().toISOString().slice(0, 10);
    const db = new Database(options.dbPath);
    db.exec(
      `CREATE TABLE IF NOT EXISTS llm_spend (
        day TEXT PRIMARY KEY,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_usd REAL NOT NULL DEFAULT 0
      )`,
    );
    db.prepare(
      `INSERT INTO llm_spend (day, input_tokens, output_tokens, estimated_usd)
       VALUES (?, ?, ?, ?)`,
    ).run(day, 1234, 567, 13);
    db.close();

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/health" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      llmSpend: {
        status: "over_budget",
        day,
        inputTokens: 1234,
        outputTokens: 567,
        estimatedUsd: 13,
        dailyBudgetUsd: 12.5,
        remainingUsd: 0,
        unlimited: false,
      },
    });

    await app.close();
  });

  it("reports a healthy JobCtrl automation worker heartbeat from the API database", async () => {
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
          taskQueue: "jobctrl-default",
          maxConcurrentActivities: 8,
          activityExecutorMaxWorkers: 10,
        },
      },
    });

    await app.close();
  });

  it("reports legacy worker heartbeat rows without Temporal concurrency metadata", async () => {
    const db = new Database(options.dbPath);
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
      "worker-legacy",
      "temporal-worker",
      1234,
      "localhost",
      tempDir,
      options.dbPath,
      "jobctrl-default",
      "2026-05-20T10:00:00.000Z",
      new Date().toISOString(),
    );
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/health",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      worker: {
        status: "healthy",
        heartbeat: {
          workerId: "worker-legacy",
          maxConcurrentActivities: null,
          activityExecutorMaxWorkers: null,
        },
      },
    });

    await app.close();
  });

  it("reports a stale JobCtrl automation worker heartbeat", async () => {
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

  it("reports a mismatched JobCtrl automation worker heartbeat", async () => {
    insertWorkerHeartbeat(options.dbPath, {
      workerId: "worker-wrong-db",
      appDir: path.join(tempDir, "other-app"),
      dbPath: path.join(tempDir, "other-app", "jobctrl.db"),
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
          dbPath: path.join(tempDir, "other-app", "jobctrl.db"),
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

    const approvedSnapshot = decision.json().suggestion;
    const refreshedDb = new Database(options.dbPath);
    const secondJobKey = "https://example.com/jobs/test-engineering-second";
    insertJob(refreshedDb, {
      url: secondJobKey,
      title: "Manager, Test Engineering",
      site: "Example Systems",
      fitScore: 1,
    });
    insertScore(refreshedDb, secondJobKey, 1, 1);
    refreshedDb.close();

    const refreshed = await app.inject({
      method: "GET",
      url: "/v1/discovery/role-match-feedback",
    });
    expect(refreshed.statusCode, refreshed.body).toBe(200);
    expect(refreshed.json().suggestions).toContainEqual(approvedSnapshot);

    const repeatedApproval = await app.inject({
      method: "POST",
      url: `/v1/discovery/role-match-feedback/${encodeURIComponent(suggestionId)}/decision`,
      payload: {
        decision: "approve",
        reason: "A repeated request must not rewrite reviewed history.",
      },
      headers: { origin: "http://localhost:5173" },
    });
    expect(repeatedApproval.statusCode, repeatedApproval.body).toBe(200);
    expect(repeatedApproval.json().suggestion).toEqual(approvedSnapshot);

    const conflictingDecision = await app.inject({
      method: "POST",
      url: `/v1/discovery/role-match-feedback/${encodeURIComponent(suggestionId)}/decision`,
      payload: { decision: "decline" },
      headers: { origin: "http://localhost:5173" },
    });
    expect(conflictingDecision.statusCode, conflictingDecision.body).toBe(409);
    expect(conflictingDecision.json()).toMatchObject({
      error: "role_match_feedback_decision_conflict",
    });

    await app.close();
  });

  it("blocks stage dispatch when the worker runtime does not match the API runtime", async () => {
    const dispatch = vi.fn(async (): Promise<ActionDispatchResult> => ({ status: "queued", runId: "run-ignored" }));
    insertWorkerHeartbeat(options.dbPath, {
      workerId: "worker-wrong-db",
      appDir: path.join(tempDir, "other-app"),
      dbPath: path.join(tempDir, "other-app", "jobctrl.db"),
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

  it("streams only column-scoped tenant events with a canonical JobId envelope", async () => {
    vi.stubEnv("JOBCTRL_API_SSE_POLL_MS", "5");
    const app = buildApp(options);
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected local test server address");
    }

    const db = new Database(options.dbPath);
    const cursor = Number(
      (db.prepare("SELECT COALESCE(MAX(event_id), 0) AS event_id FROM job_events").get() as {
        event_id: number;
      }).event_id,
    );
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/events/stream?tenantId=local&since=${cursor}`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level,
         message, occurred_at, payload_json
       ) VALUES (?, ?, 1, ?, ?, 'info', NULL, ?, ?)`,
    );
    const occurredAt = "2026-04-29T10:30:00+00:00";
    insertEvent.run(
      "other",
      null,
      null,
      "ProfileUpdated",
      occurredAt,
      JSON.stringify({ tenantId: "local" }),
    );
    const jobUrl = "https://example.com/jobs/ready";
    const jobId = jobIdFor(jobUrl);
    insertEvent.run(
      "local",
      jobId,
      "score",
      "StageReset",
      occurredAt,
      JSON.stringify({ tenantId: "other", jobId }),
    );
    insertEvent.run(
      "local",
      jobId,
      "score",
      "StageReset",
      occurredAt,
      JSON.stringify({ tenantId: "local", jobKey: jobUrl }),
    );
    insertEvent.run(
      "local",
      jobId,
      "score",
      "StageReset",
      occurredAt,
      JSON.stringify({
        tenantId: "local",
        occurred_at: "2026-04-29T10:29:00+00:00",
        postingUrl: "https://example.com/jobs/legacy-timestamp",
      }),
    );
    const outcomeOccurredAt = "2026-04-01T09:00:00+00:00";
    insertEvent.run(
      "local",
      jobId,
      "apply",
      "ApplicationOutcomeRecorded",
      occurredAt,
      JSON.stringify({
        tenantId: "local",
        jobId,
        outcomeId: "outcome-historical",
        kind: "interview",
        source: "manual",
        occurredAt: outcomeOccurredAt,
        notePresent: false,
      }),
    );
    const canonical = insertEvent.run(
      "local",
      jobId,
      "score",
      "StageReset",
      occurredAt,
      JSON.stringify({ tenantId: "local", postingUrl: jobUrl }),
    );

    const reader = response.body?.getReader();
    if (!reader) throw new Error("Expected event stream body");
    const decoder = new TextDecoder();
    let streamed = "";
    const expectedId = `id: ${String(canonical.lastInsertRowid)}`;
    while (!streamed.includes(expectedId)) {
      const next = await Promise.race([
        reader.read(),
        new Promise<never>((_resolve, reject) => {
          setTimeout(() => reject(new Error("Timed out waiting for canonical SSE event")), 1_000);
        }),
      ]);
      if (next.done) break;
      streamed += decoder.decode(next.value, { stream: true });
    }

    expect(streamed).toContain(expectedId);
    expect(streamed).toContain("event: StageReset");
    expect(streamed).toContain(`\"tenantId\":\"local\"`);
    expect(streamed).toContain(`\"jobId\":\"${jobId}\"`);
    expect(streamed).toContain(`\"postingUrl\":\"${jobUrl}\"`);
    expect(streamed).toContain(`\"occurredAt\":\"${occurredAt}\"`);
    expect(streamed).toContain("event: ApplicationOutcomeRecorded");
    expect(streamed).toContain("outcome-historical");
    expect(streamed).toContain(`\"occurredAt\":\"${outcomeOccurredAt}\"`);
    expect(streamed).not.toContain("event: ProfileUpdated");
    expect(streamed).not.toContain("\"jobKey\"");
    expect(streamed).not.toContain("legacy-timestamp");
    await reader.cancel();
    db.close();
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

  it("issues and rotates a local extension capability token only for CLI and trusted Settings callers", async () => {
    const app = buildApp(options);
    try {
      const first = await app.inject({
        method: "GET",
        url: "/v1/extension/pairing-token",
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.headers["cache-control"]).toBe("no-store");
      const firstBody = first.json() as { token: string; tokenPath: string; created: boolean };
      expect(firstBody.token).toHaveLength(43);
      expect(firstBody.tokenPath).toBe(path.join(tempDir, "extension-capability-token"));
      expect(fs.readFileSync(firstBody.tokenPath, "utf8").trim()).toBe(firstBody.token);
      if (process.platform !== "win32") {
        expect(fs.statSync(firstBody.tokenPath).mode & 0o777).toBe(0o600);
      }

      const trustedSettingsRead = await app.inject({
        method: "GET",
        url: "/v1/extension/pairing-token",
        headers: {
          origin: "http://127.0.0.1:5173",
          "sec-fetch-site": "same-site",
        },
      });
      expect(trustedSettingsRead.statusCode, trustedSettingsRead.body).toBe(200);
      expect((trustedSettingsRead.json() as { token: string }).token).toBe(firstBody.token);

      const loopbackWebRead = await app.inject({
        method: "GET",
        url: "/v1/extension/pairing-token",
        headers: {
          origin: "http://127.0.0.1:9999",
          "sec-fetch-site": "same-site",
        },
      });
      expect(loopbackWebRead.statusCode, loopbackWebRead.body).toBe(403);
      expect(loopbackWebRead.json()).toMatchObject({ ok: false, error: "untrusted_extension_pairing_request" });

      const loopbackWebReadWithoutFetchMetadata = await app.inject({
        method: "GET",
        url: "/v1/extension/pairing-token",
        headers: { origin: "http://localhost:9999" },
      });
      expect(loopbackWebReadWithoutFetchMetadata.statusCode, loopbackWebReadWithoutFetchMetadata.body).toBe(403);
      expect(loopbackWebReadWithoutFetchMetadata.json()).toMatchObject({
        ok: false,
        error: "untrusted_extension_pairing_request",
      });

      const extensionRead = await app.inject({
        method: "GET",
        url: "/v1/extension/pairing-token",
        headers: { origin: CHROME_EXTENSION_ORIGIN },
      });
      expect(extensionRead.statusCode, extensionRead.body).toBe(403);
      expect(extensionRead.headers["access-control-allow-origin"]).toBeUndefined();
      expect(extensionRead.json()).toMatchObject({ ok: false, error: "untrusted_extension_pairing_request" });

      const rotated = await app.inject({
        method: "POST",
        url: "/v1/extension/pairing-token/rotate",
        headers: {
          origin: "http://127.0.0.1:5173",
          "sec-fetch-site": "same-site",
        },
      });
      expect(rotated.statusCode, rotated.body).toBe(200);
      const rotatedBody = rotated.json() as { token: string; tokenPath: string };
      expect(rotatedBody.tokenPath).toBe(firstBody.tokenPath);
      expect(rotatedBody.token).not.toBe(firstBody.token);
      expect(fs.readFileSync(rotatedBody.tokenPath, "utf8").trim()).toBe(rotatedBody.token);

      const loopbackWebRotate = await app.inject({
        method: "POST",
        url: "/v1/extension/pairing-token/rotate",
        headers: {
          origin: "http://127.0.0.1:9999",
          "sec-fetch-site": "same-site",
        },
      });
      expect(loopbackWebRotate.statusCode, loopbackWebRotate.body).toBe(403);
      expect(loopbackWebRotate.json()).toMatchObject({ ok: false, error: "cross_site_request" });
      expect(fs.readFileSync(rotatedBody.tokenPath, "utf8").trim()).toBe(rotatedBody.token);
    } finally {
      await app.close();
    }
  });

  it("allows CORS preflight only for authenticated extension API routes", async () => {
    const app = buildApp(options);
    try {
      const extensionPreflight = await app.inject({
        method: "OPTIONS",
        url: "/v1/extension/auth/status",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      });
      expect(extensionPreflight.statusCode, extensionPreflight.body).toBe(204);
      expect(extensionPreflight.headers["access-control-allow-origin"]).toBe(CHROME_EXTENSION_ORIGIN);
      expect(String(extensionPreflight.headers["access-control-allow-headers"])).toContain("authorization");
      expect(String(extensionPreflight.headers["access-control-allow-headers"])).toContain("content-type");

      const profilePreflight = await app.inject({
        method: "OPTIONS",
        url: "/v1/profile",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          "access-control-request-method": "PATCH",
          "access-control-request-headers": "authorization, content-type",
        },
      });
      expect(profilePreflight.statusCode, profilePreflight.body).toBe(204);
      expect(profilePreflight.headers["access-control-allow-origin"]).toBeUndefined();
    } finally {
      await app.close();
    }
  });

  it("trusts valid extension bearer tokens only on extension API routes without weakening CSRF", async () => {
    const app = buildApp(options);
    try {
      const tokenResponse = await app.inject({ method: "GET", url: "/v1/extension/pairing-token" });
      const token = (tokenResponse.json() as { token: string }).token;

      const missingTokenRead = await app.inject({
        method: "GET",
        url: "/v1/extension/auth/status",
        headers: { origin: CHROME_EXTENSION_ORIGIN },
      });
      expect(missingTokenRead.statusCode, missingTokenRead.body).toBe(401);
      expect(missingTokenRead.headers["access-control-allow-origin"]).toBe(CHROME_EXTENSION_ORIGIN);
      expect(missingTokenRead.json()).toMatchObject({ ok: false, error: "invalid_extension_capability_token" });

      const extensionStatus = await app.inject({
        method: "POST",
        url: "/v1/extension/auth/status",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "cross-site",
        },
      });
      expect(extensionStatus.statusCode, extensionStatus.body).toBe(200);
      expect(extensionStatus.headers["access-control-allow-origin"]).toBe(CHROME_EXTENSION_ORIGIN);
      expect(extensionStatus.json()).toMatchObject({
        ok: true,
        authenticated: true,
        capabilities: ["capture", "autofill_read"],
      });

      const invalidToken = await app.inject({
        method: "POST",
        url: "/v1/extension/auth/status",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: "Bearer not-the-local-token",
          "sec-fetch-site": "cross-site",
        },
      });
      expect(invalidToken.statusCode, invalidToken.body).toBe(403);
      expect(invalidToken.json()).toMatchObject({ ok: false, error: "cross_site_request" });

      const foreignOrigin = await app.inject({
        method: "POST",
        url: "/v1/extension/auth/status",
        headers: {
          origin: "https://example.com",
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "cross-site",
        },
      });
      expect(foreignOrigin.statusCode, foreignOrigin.body).toBe(403);
      expect(foreignOrigin.json()).toMatchObject({ ok: false, error: "cross_site_request" });

      const jobKey = encodeURIComponent("https://example.com/jobs/ready");
      const nonExtensionRoute = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobKey}/actions/mark-applied`,
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "cross-site",
        },
        payload: { reason: "must stay blocked" },
      });
      expect(nonExtensionRoute.statusCode, nonExtensionRoute.body).toBe(403);
      expect(nonExtensionRoute.json()).toMatchObject({ ok: false, error: "cross_site_request" });

      const db = new Database(options.dbPath);
      const row = db.prepare("SELECT apply_status, applied_at FROM jobs WHERE url = ?").get("https://example.com/jobs/ready") as {
        apply_status: string | null;
        applied_at: string | null;
      };
      db.close();
      expect(row).toMatchObject({ apply_status: null, applied_at: null });
    } finally {
      await app.close();
    }
  });

  it("serves a token-gated autofill profile without sensitive profile fields", async () => {
    const app = buildApp(options);
    try {
      const profile = {
        ...validProfileFixture("Jordan Candidate"),
        personal: {
          full_name: "Jordan Candidate",
          email: "jordan@example.com",
          phone: "+1 555 0100",
          linkedin_url: "https://linkedin.com/in/jordan",
          password: "must-not-leave-profile",
        },
        work_authorization: {
          legally_authorized_to_work: "Yes",
          require_sponsorship: "No",
          work_permit_type: "Citizen",
        },
        availability: {
          earliest_start_date: "2026-08-01",
          available_for_full_time: "Yes",
          available_for_contract: "No",
        },
        compensation: {
          salary_expectation: "150000",
          salary_currency: "USD",
        },
      };
      const save = await app.inject({
        method: "PATCH",
        url: "/v1/profile",
        headers: {
          origin: "http://127.0.0.1:5173",
          "sec-fetch-site": "same-site",
        },
        payload: { profile },
      });
      expect(save.statusCode, save.body).toBe(200);

      const tokenResponse = await app.inject({ method: "GET", url: "/v1/extension/pairing-token" });
      const token = (tokenResponse.json() as { token: string }).token;
      const response = await app.inject({
        method: "GET",
        url: "/v1/extension/autofill/profile",
        headers: {
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: `Bearer ${token}`,
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers["access-control-allow-origin"]).toBe(CHROME_EXTENSION_ORIGIN);
      const body = response.json() as { profileVersion: number; fields: Array<{ path: string; value: string }> };
      expect(body.profileVersion).toBeGreaterThan(0);
      expect(body.fields).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: "personal.email", value: "jordan@example.com" }),
          expect.objectContaining({ path: "personal.phone", value: "+1 555 0100" }),
          expect.objectContaining({ path: "work_authorization.legally_authorized_to_work", value: "Yes" }),
          expect.objectContaining({ path: "compensation.salary_expectation", value: "150000" }),
        ]),
      );
      expect(JSON.stringify(body)).not.toContain("must-not-leave-profile");
      expect(body.fields.some((field) => field.path === "personal.password")).toBe(false);
      expect(body.fields.some((field) => field.path.startsWith("resume."))).toBe(false);
    } finally {
      await app.close();
    }
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

  it.each([
    {
      name: "cross-site browser metadata",
      jobUrl: "https://example.com/jobs/ready",
      action: "mark-applied",
      payload: { reason: "cross-site metadata" },
      headers: { "sec-fetch-site": "cross-site" },
      expectedStatus: 403,
      expectedBody: { ok: false, error: "cross_site_request" },
    },
    {
      name: "same-site browser metadata without loopback origin",
      jobUrl: "https://example.com/jobs/ready",
      action: "mark-applied",
      payload: { reason: "same-site metadata" },
      headers: { "sec-fetch-site": "same-site" },
      expectedStatus: 403,
      expectedBody: { ok: false, error: "cross_site_request" },
    },
    {
      name: "loopback same-site browser metadata",
      jobUrl: "https://example.com/jobs/ready",
      action: "mark-applied",
      payload: { reason: "loopback same-site metadata" },
      headers: { origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-site" },
      expectedStatus: 200,
      expectedBody: { action: "mark_applied", stage: { state: "succeeded" } },
    },
    {
      name: "non-first-party loopback browser metadata",
      jobUrl: "https://example.com/jobs/ready",
      action: "mark-applied",
      payload: { reason: "non-first-party loopback metadata" },
      headers: { origin: "http://127.0.0.1:9999", "sec-fetch-site": "same-site" },
      expectedStatus: 403,
      expectedBody: { ok: false, error: "cross_site_request" },
    },
    {
      name: "same-origin browser metadata",
      jobUrl: "https://example.com/jobs/ready",
      action: "mark-applied",
      payload: { reason: "same-origin browser" },
      headers: { origin: "http://127.0.0.1:5173", "sec-fetch-site": "same-origin" },
      expectedStatus: 200,
      expectedBody: { action: "mark_applied", stage: { state: "succeeded" } },
    },
    {
      name: "browser navigation metadata",
      jobUrl: "https://example.com/jobs/blocked-tailor",
      action: "mark-skipped",
      payload: { reason: "browser navigation" },
      headers: { "sec-fetch-site": "none" },
      expectedStatus: 403,
      expectedBody: { ok: false, error: "cross_site_request" },
    },
    {
      name: "headerless curl-style mutation",
      jobUrl: "https://example.com/jobs/failed-score",
      action: "mark-skipped",
      payload: { reason: "CLI" },
      headers: {},
      expectedStatus: 403,
      expectedBody: { ok: false, error: "cross_site_request" },
    },
  ])("enforces the unsafe mutation CSRF matrix for $name", async (testCase) => {
    const app = buildApp(options);
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/jobs/${encodeURIComponent(testCase.jobUrl)}/actions/${testCase.action}`,
        headers: testCase.headers,
        payload: testCase.payload,
      });

      expect(response.statusCode, response.body).toBe(testCase.expectedStatus);
      expect(response.json()).toMatchObject(testCase.expectedBody);

      if (testCase.expectedStatus === 403) {
        const db = new Database(options.dbPath);
        const row = db.prepare("SELECT apply_status, applied_at FROM jobs WHERE url = ?").get(testCase.jobUrl) as {
          apply_status: string | null;
          applied_at: string | null;
        };
        db.close();
        expect(row).toMatchObject({ apply_status: null, applied_at: null });
      }
    } finally {
      await app.close();
    }
  });

  it("allows first-party browser and token-authenticated no-origin mutation callers", async () => {
    const app = buildApp(options);
    const appliedKey = encodeURIComponent("https://example.com/jobs/ready");
    const skippedKey = encodeURIComponent("https://example.com/jobs/blocked-tailor");

    const loopback = await app.inject({
      method: "POST",
      url: `/v1/jobs/${appliedKey}/actions/mark-applied`,
      headers: { origin: "http://127.0.0.1:5173" },
      payload: { reason: "local browser" },
    });
    const tokenResponse = await app.inject({ method: "GET", url: "/v1/extension/pairing-token" });
    const token = (tokenResponse.json() as { token: string }).token;
    const noOriginWithToken = await app.inject({
      method: "POST",
      url: `/v1/jobs/${skippedKey}/actions/mark-skipped`,
      headers: { authorization: `Bearer ${token}` },
      payload: { reason: "CLI" },
    });
    const loopbackBrowserWithToken = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/failed-score")}/actions/mark-skipped`,
      headers: {
        origin: "http://127.0.0.1:9999",
        authorization: `Bearer ${token}`,
        "sec-fetch-site": "same-site",
      },
      payload: { reason: "token must not bless arbitrary loopback web origins" },
    });

    expect(loopback.statusCode, loopback.body).toBe(200);
    expect(noOriginWithToken.statusCode, noOriginWithToken.body).toBe(200);
    expect(loopbackBrowserWithToken.statusCode, loopbackBrowserWithToken.body).toBe(403);
    expect(loopback.json()).toMatchObject({ action: "mark_applied", stage: { state: "succeeded" } });
    expect(noOriginWithToken.json()).toMatchObject({ action: "mark_skipped", stage: { state: "skipped" } });
    expect(loopbackBrowserWithToken.json()).toMatchObject({ ok: false, error: "cross_site_request" });

    await app.close();
  });

  it("rejects requests whose Host header is not a loopback host", async () => {
    const app = buildApp(options);
    try {
      const foreignHealth = await app.inject({
        method: "GET",
        url: "/v1/health",
        headers: { host: "evil.example.com" },
      });
      expect(foreignHealth.statusCode, foreignHealth.body).toBe(403);
      expect(foreignHealth.json()).toMatchObject({ ok: false, error: "forbidden_host" });

      const foreignProfile = await app.inject({
        method: "GET",
        url: "/v1/profile",
        headers: { host: "attacker.test:8766" },
      });
      expect(foreignProfile.statusCode, foreignProfile.body).toBe(403);
      expect(foreignProfile.json()).toMatchObject({ ok: false, error: "forbidden_host" });
    } finally {
      await app.close();
    }
  });

  it("rejects spoofed loopback Host headers from non-loopback peers", async () => {
    const app = buildApp(options);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/profile",
        headers: { host: "127.0.0.1:8766" },
        remoteAddress: "203.0.113.10",
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: "forbidden_remote_client" });
    } finally {
      await app.close();
    }
  });

  it("rejects DNS-rebinding Host headers that embed a loopback label in a foreign name", async () => {
    const app = buildApp(options);
    const rebindingHosts = [
      "localhost.evil.com",
      "127.0.0.1.evil.com",
      "localhost.",
      "127.0.0.1, evil.com",
      "[::ffff:127.0.0.1]",
    ];
    try {
      for (const host of rebindingHosts) {
        const response = await app.inject({ method: "GET", url: "/v1/health", headers: { host } });
        expect(response.statusCode, `${host}: ${response.body}`).toBe(403);
        expect(response.json(), host).toMatchObject({ ok: false, error: "forbidden_host" });
      }
    } finally {
      await app.close();
    }
  });

  it("blocks foreign-Host mutations before the handler runs", async () => {
    const app = buildApp(options);
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");
    try {
      const response = await app.inject({
        method: "POST",
        url: `/v1/jobs/${jobKey}/actions/mark-applied`,
        headers: { host: "evil.example.com", origin: "http://127.0.0.1:5173" },
        payload: { reason: "rebind" },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: "forbidden_host" });

      const db = new Database(options.dbPath);
      const row = db
        .prepare("SELECT apply_status, applied_at FROM jobs WHERE url = ?")
        .get("https://example.com/jobs/ready") as { apply_status: string | null; applied_at: string | null };
      db.close();
      expect(row).toMatchObject({ apply_status: null, applied_at: null });
    } finally {
      await app.close();
    }
  });

  it("keeps the Host gate mandatory for valid extension bearer tokens", async () => {
    const app = buildApp(options);
    try {
      const tokenResponse = await app.inject({ method: "GET", url: "/v1/extension/pairing-token" });
      const token = (tokenResponse.json() as { token: string }).token;
      const response = await app.inject({
        method: "POST",
        url: "/v1/extension/auth/status",
        headers: {
          host: "evil.example.com",
          origin: CHROME_EXTENSION_ORIGIN,
          authorization: `Bearer ${token}`,
          "sec-fetch-site": "cross-site",
        },
      });
      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: "forbidden_host" });
    } finally {
      await app.close();
    }
  });

  it("allows loopback Host headers with and without a port", async () => {
    const app = buildApp(options);
    try {
      for (const host of ["localhost", "localhost:8766", "127.0.0.1", "127.0.0.1:8766", "[::1]", "[::1]:8766"]) {
        const response = await app.inject({ method: "GET", url: "/v1/health", headers: { host } });
        expect(response.statusCode, `${host}: ${response.body}`).toBe(200);
        expect(response.json()).toMatchObject({ ok: true });
      }
    } finally {
      await app.close();
    }
  });

  it("allows loopback peer addresses with loopback Host headers", async () => {
    const app = buildApp(options);
    try {
      for (const remoteAddress of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
        const response = await app.inject({
          method: "GET",
          url: "/v1/health",
          headers: { host: "127.0.0.1:8766" },
          remoteAddress,
        });
        expect(response.statusCode, `${remoteAddress}: ${response.body}`).toBe(200);
        expect(response.json()).toMatchObject({ ok: true });
      }
    } finally {
      await app.close();
    }
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
      jobKey: jobIdFor("https://example.com/jobs/failed-score"),
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

  it("serves the typed pipeline operations snapshot from the existing SQLite schema", async () => {
    const app = buildApp(options);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/pipeline/operations" });

      expect(response.statusCode, response.body).toBe(200);
      expect(PipelineOperationsSnapshotSchema.safeParse(response.json()).success).toBe(true);
    } finally {
      await app.close();
    }
  });

  it("classifies current running work as active or stuck from canonical stage timestamps", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "UPDATE job_stage_states SET state = 'running', updated_at = ? WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'",
      ).run("2999-01-01T00:00:00Z", jobIdFor("https://example.com/jobs/failed-score"));
      db.prepare(
        "UPDATE job_stage_states SET state = 'running', updated_at = ? WHERE tenant_id = 'local' AND job_id = ? AND stage = 'tailor'",
      ).run("2020-01-01T00:00:00Z", jobIdFor("https://example.com/jobs/blocked-tailor"));
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const missingWorkerResponse = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(missingWorkerResponse.statusCode, missingWorkerResponse.body).toBe(200);
      expect(missingWorkerResponse.json().work).toMatchObject({
        active: 1,
        stuck: 1,
      });

      insertWorkerHeartbeat(options.dbPath, {
        workerId: "dashboard-worker",
        appDir: tempDir,
        dbPath: options.dbPath,
        lastSeenAt: new Date().toISOString(),
      });
      const healthyWorkerResponse = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(healthyWorkerResponse.statusCode, healthyWorkerResponse.body).toBe(200);
      expect(healthyWorkerResponse.json().work).toMatchObject({
        active: 2,
        stuck: 0,
        stuckItems: [],
      });

      const mismatchedHeartbeatDb = new Database(options.dbPath);
      try {
        mismatchedHeartbeatDb
          .prepare("UPDATE worker_runtime_heartbeats SET app_dir = ?")
          .run(`${tempDir}-other`);
      } finally {
        mismatchedHeartbeatDb.close();
      }
      const mismatchedWorkerResponse = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(mismatchedWorkerResponse.statusCode, mismatchedWorkerResponse.body).toBe(200);
      expect(mismatchedWorkerResponse.json().work).toMatchObject({
        active: 1,
        stuck: 1,
      });

      const invalidHeartbeatDb = new Database(options.dbPath);
      try {
        invalidHeartbeatDb
          .prepare("UPDATE worker_runtime_heartbeats SET app_dir = ?, last_seen_at = ?")
          .run(tempDir, "not-a-timestamp");
      } finally {
        invalidHeartbeatDb.close();
      }
      const invalidWorkerResponse = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(invalidWorkerResponse.statusCode, invalidWorkerResponse.body).toBe(200);
      expect(invalidWorkerResponse.json().work).toMatchObject({
        active: 1,
        stuck: 1,
      });

      const staleHeartbeatDb = new Database(options.dbPath);
      try {
        staleHeartbeatDb
          .prepare("UPDATE worker_runtime_heartbeats SET last_seen_at = ?")
          .run("2020-01-01T00:00:00Z");
      } finally {
        staleHeartbeatDb.close();
      }
      const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json().work).toEqual({
        active: 1,
        stuck: 1,
        stuckAfterSeconds: 150,
        stuckItems: [
          {
            jobKey: jobIdFor("https://example.com/jobs/blocked-tailor"),
            title: "Frontend Engineer",
            company: "Acme",
            stage: "tailor",
            updatedAt: "2020-01-01T00:00:00Z",
          },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("returns the latest pipeline progress snapshot from durable events", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
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
              currentLocation: "Exampleland (remote)",
              newJobs: 13,
              existingJobs: 46,
              filteredJobs: 412,
              errorCount: 0,
              rawTotal: 1000,
              recoveredUnits: 1,
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
          currentLocation: "Exampleland (remote)",
          newJobs: 13,
          existingJobs: 46,
          filteredJobs: 412,
          errorCount: 0,
          rawTotal: 1000,
          recoveredUnits: 1,
        },
        updatedAt: "2026-04-29T10:20:00+00:00",
      },
    ]);

    await app.close();
  });

  it("marks pipeline progress as not running when the linked workflow terminalized", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
      ).run(
        null,
        "discover",
        "StageStarted",
        "info",
        "Discover workflow started",
        "2026-07-04T07:57:11.846Z",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          runId: "discover-local",
          workflowId: "discover-local",
          progress: {
            completed: 0,
            total: 1,
            percent: 0,
            currentStep: null,
            status: "running",
            message: "Discover workflow started",
          },
        }),
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_run_projections (
          workflow_id            TEXT PRIMARY KEY,
          tenant_id              TEXT NOT NULL DEFAULT 'local',
          workflow_type          TEXT NOT NULL DEFAULT '',
          status                 TEXT NOT NULL DEFAULT 'in_progress',
          input_summary_json     TEXT NOT NULL DEFAULT '{}',
          error_code             TEXT,
          error_message          TEXT,
          retryable              INTEGER NOT NULL DEFAULT 0,
          started_at             TEXT,
          finished_at            TEXT,
          duration_ms            INTEGER,
          temporal_run_id        TEXT,
          events_json            TEXT NOT NULL DEFAULT '[]'
        )
      `);
      db.prepare(
        `INSERT INTO workflow_run_projections (
          workflow_id, tenant_id, workflow_type, status, input_summary_json,
          error_code, error_message, retryable, started_at, finished_at,
          temporal_run_id, events_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "discover-local",
        "local",
        "DiscoverWorkflow",
        "terminated",
        JSON.stringify({ limit: 1000 }),
        "reconciled_not_found",
        "The reconciler closed this run: its Temporal execution no longer exists on the server.",
        0,
        "2026-07-04T07:57:11.751742+00:00",
        "2026-07-04T11:16:55.314850+00:00",
        "temporal-run-1",
        "[]",
      );
    } finally {
      db.close();
    }

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().progress[0]).toMatchObject({
      stage: "discover",
      status: "failed",
      runId: "discover-local",
      workflowId: "discover-local",
      percent: 0,
      completed: 0,
      total: 1,
      message: "Workflow terminated: The reconciler closed this run: its Temporal execution no longer exists on the server.",
      updatedAt: "2026-07-04T11:16:55.314850+00:00",
    });

    await app.close();
  });

  it("keeps a live re-run of a reused workflow id running despite a stale terminal projection", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
      ).run(
        null,
        "discover",
        "StageStarted",
        "info",
        "Discover workflow started",
        "2026-07-04T12:00:00.000Z",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          runId: "discover-local",
          workflowId: "discover-local",
          progress: {
            completed: 0,
            total: 1,
            percent: 0,
            currentStep: null,
            status: "running",
            message: "Discover workflow started",
          },
        }),
      );
      db.exec(`
        CREATE TABLE IF NOT EXISTS workflow_run_projections (
          workflow_id            TEXT PRIMARY KEY,
          tenant_id              TEXT NOT NULL DEFAULT 'local',
          workflow_type          TEXT NOT NULL DEFAULT '',
          status                 TEXT NOT NULL DEFAULT 'in_progress',
          input_summary_json     TEXT NOT NULL DEFAULT '{}',
          error_code             TEXT,
          error_message          TEXT,
          retryable              INTEGER NOT NULL DEFAULT 0,
          started_at             TEXT,
          finished_at            TEXT,
          duration_ms            INTEGER,
          temporal_run_id        TEXT,
          events_json            TEXT NOT NULL DEFAULT '[]'
        )
      `);
      db.prepare(
        `INSERT INTO workflow_run_projections (
          workflow_id, tenant_id, workflow_type, status, input_summary_json,
          error_code, error_message, retryable, started_at, finished_at,
          temporal_run_id, events_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        "discover-local",
        "local",
        "DiscoverWorkflow",
        "terminated",
        JSON.stringify({ limit: 1000 }),
        "reconciled_not_found",
        "The reconciler closed this run: its Temporal execution no longer exists on the server.",
        0,
        "2026-07-04T07:57:11.751742+00:00",
        "2026-07-04T11:16:55.314850+00:00",
        "temporal-run-1",
        "[]",
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
      runId: "discover-local",
      workflowId: "discover-local",
      message: "Discover workflow started",
      updatedAt: "2026-07-04T12:00:00.000Z",
    });

    await app.close();
  });

  it("normalizes source progress to a visible nonzero percentage", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
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

  it("finalizes an unlinked discover progress card from the tenant's discover workflow", async () => {
    // The incident's frozen card: the Temporal-path smartextract completion
    // event carries only the per-source discovery run id — no workflowId — so
    // the workflow-status linkage must fall back to the deterministic
    // discover-<tenant> id instead of leaving "running 67%" on a failed run.
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
      ).run(
        null,
        "discover",
        "StageCompleted",
        "info",
        "Discovery source smartextract ok",
        "2026-07-04T13:35:06.648Z",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          source: "smartextract",
          runId: "discovery:smartextract:57cfde27c40b43fb97dfa21b3cb7fbbc",
          progress: {
            completed: 4,
            total: 6,
            percent: 67,
            currentStep: "Smart extract",
            status: "running",
            message: "Smart extract complete",
          },
        }),
      );
      insertDiscoverWorkflowRunRow(db, {
        status: "failed",
        errorCode: "source_unavailable",
        errorMessage: "Activity task failed",
        startedAt: DISCOVER_NEW_START,
        finishedAt: DISCOVER_FAILED_AT,
      });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const summary = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(summary.statusCode, summary.body).toBe(200);
      const discover = summary
        .json()
        .progress.find((entry: { stage: string }) => entry.stage === "discover");
      expect(discover).toMatchObject({
        stage: "discover",
        status: "failed",
        percent: 67,
        completed: 4,
        currentStep: "Smart extract",
      });
      expect(discover.message).toContain("Workflow failed");
    } finally {
      await app.close();
    }
  });

  it("preserves partial terminal pipeline progress from durable event payloads", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
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

  it("preserves partial discover warnings after the workflow succeeds", async () => {
    const db = new Database(options.dbPath);
    try {
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
      ).run(
        null,
        "discover",
        "StageCompleted",
        "warn",
        "Detail enrichment partially complete",
        "2026-07-04T14:06:43.000+00:00",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          workflowId: "discover-local",
          progress: {
            completed: 5,
            total: 6,
            percent: 83,
            currentStep: "Detail enrichment",
            status: "partial",
            message: "Detail enrichment partially complete",
          },
          siteErrors: {
            indeed: {
              error_class: "RuntimeError",
              error_message: "BrowserType.launch: Executable doesn't exist",
            },
          },
        }),
      );
      insertDiscoverWorkflowRunRow(db, {
        status: "succeeded",
        startedAt: DISCOVER_NEW_START,
        finishedAt: "2026-07-04T14:09:00.000+00:00",
        temporalRunId: DISCOVER_NEW_TEMPORAL_RUN,
      });
      insertPipelineWorkflowEvent(db, {
        eventType: "WorkflowStarted",
        occurredAt: DISCOVER_NEW_START,
        workflowId: "discover-local",
        temporalRunId: DISCOVER_NEW_TEMPORAL_RUN,
        startedAt: DISCOVER_NEW_START,
      });
      insertPipelineWorkflowEvent(db, {
        eventType: "WorkflowCompleted",
        occurredAt: "2026-07-04T14:09:00.000+00:00",
        workflowId: "discover-local",
        temporalRunId: DISCOVER_NEW_TEMPORAL_RUN,
        status: "succeeded",
        finishedAt: "2026-07-04T14:09:00.000+00:00",
      });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(response.statusCode, response.body).toBe(200);
      const discover = response
        .json()
        .progress.find((entry: { stage: string }) => entry.stage === "discover");
      expect(discover).toMatchObject({
        stage: "discover",
        status: "partial",
        workflowId: "discover-local",
        percent: 100,
        completed: 6,
        total: 6,
        currentStep: "Detail enrichment",
        message: "Detail enrichment partially complete",
        updatedAt: "2026-07-04T14:09:00.000+00:00",
      });
    } finally {
      await app.close();
    }
  });

  it("returns local-day dashboard deltas for active jobs and applications", async () => {
    const now = new Date().toISOString();
    const db = new Database(options.dbPath);
    try {
      const jobUrl = "https://example.com/jobs/ready";
      db.prepare("UPDATE jobs SET discovered_at = ? WHERE url = ?").run(now, jobUrl);
      db.prepare(
        `INSERT INTO job_events (
           tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at
         ) SELECT 'local', job_id, 1, 'apply', 'ApplicationManuallyMarked', 'info',
                  'Job marked applied from test.', ?
             FROM jobs
            WHERE tenant_id = 'local' AND url = ?`,
      ).run(now, jobUrl);
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
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?",
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

  it("finds workflow activity by its canonical workflow id and exposes that run reference", async () => {
    const workflowId = "run-activity-search-regression";
    const jobKey = jobIdFor("https://example.com/jobs/ready");
    const db = new Database(options.dbPath);
    let eventId = "";
    let stageEventId = "";
    try {
      insertPipelineWorkflowEvent(db, {
        eventType: "WorkflowStarted",
        occurredAt: "2026-04-29T11:30:00+00:00",
        workflowId,
        temporalRunId: "temporal-activity-search-regression",
        startedAt: "2026-04-29T11:30:00+00:00",
      });
      // Worker stage runners stamp the owning run into per-job stage events
      // (jobctrl.infrastructure.workflow_run_context), so run-scoped review
      // returns the run's actual work — not only lifecycle markers.
      const stageRow = db
        .prepare(
          `INSERT INTO job_events (
             tenant_id, job_id, identity_version, stage, event_type, level,
             message, occurred_at, payload_json
           ) VALUES ('local', ?, 1, 'score', 'StageCompleted', 'info',
                     'Fit score 9/10', '2026-04-29T11:31:00+00:00', ?)`,
        )
        .run(jobKey, JSON.stringify({ workflowId, jobId: jobKey, stage: "score" }));
      stageEventId = String(stageRow.lastInsertRowid);
      const row = db
        .prepare(
          `SELECT event_id
             FROM job_events
            WHERE json_extract(payload_json, '$.workflowId') = ?
              AND event_type = 'WorkflowStarted'`,
        )
        .get(workflowId) as { event_id: number };
      eventId = String(row.event_id);
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const activity = await app.inject({
        method: "GET",
        url: `/v1/debug/activity?q=${workflowId}`,
      });
      expect(activity.statusCode, activity.body).toBe(200);
      expect(activity.json().items).toEqual([
        expect.objectContaining({
          eventId: stageEventId,
          eventType: "StageCompleted",
          workflowId,
          jobKey,
          title: "Platform Engineer",
          company: "ExampleCo",
        }),
        expect.objectContaining({
          eventId,
          eventType: "WorkflowStarted",
          workflowId,
        }),
      ]);

      const detail = await app.inject({
        method: "GET",
        url: `/v1/debug/activity/${eventId}`,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().event).toMatchObject({ eventId, workflowId });
    } finally {
      await app.close();
    }
  });

  it("does not expose dashboard activity links for events whose job no longer exists", async () => {
    const db = new Database(options.dbPath);
    db.pragma("foreign_keys = OFF");
    db.prepare(
      "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at) VALUES ('local', ?, 1, ?, ?, ?, ?, ?)",
    ).run(
      jobIdFor("https://example.com/jobs/missing-parent"),
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
      jobKey: jobIdFor("https://example.com/jobs/failed-score"),
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

    const seedDb = new Database(options.dbPath);
    seedDb
      .prepare("UPDATE jobs SET salary = ?, apply_status = 'applied', applied_at = ? WHERE url = ?")
      .run("€55,000/year", "2026-04-29T10:15:00+00:00", "https://example.com/jobs/ready");
    insertPostedCompensationFact(seedDb, "https://example.com/jobs/ready");
    insertUnannualizedPostedCompensationFact(seedDb, "https://example.com/jobs/failed-score");
    insertMarketCompensationEstimate(seedDb, "https://example.com/jobs/ready");
    seedDb
      .prepare("INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?")
      .run(
        "https://example.com/jobs/ready",
        "enrich",
        "CompensationFactsUpdated",
        "info",
        "Compensation facts refreshed",
        "2026-06-19T10:01:00Z",
        JSON.stringify({ tenant_id: "local", changed_sections: ["posted", "market"] }),
      );
    seedDb.close();

    for (const sortField of [
      "source",
      "compensation_min_eur",
      "compensation_max_eur",
      "compensation_posted",
      "compensation_market",
      "compensation_confidence",
      "compensation_warnings",
      "apply_status",
    ]) {
      const sorted = await app.inject({
        method: "GET",
        url: `/v1/jobs?sort=${sortField}&dir=desc&pageSize=3`,
      });
      expect(sorted.statusCode, sorted.body).toBe(200);
      expect(sorted.json().sort).toMatchObject({ field: sortField, dir: "desc" });
    }

    const salarySorted = await app.inject({
      method: "GET",
      url: "/v1/jobs?sort=compensation_min_eur&dir=desc&pageSize=3",
    });
    expect(salarySorted.statusCode, salarySorted.body).toBe(200);
    expect(salarySorted.json().items[0]).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      compensationSummary: {
        posted: {
          displayRange: "EUR 55000/year",
          range: {
            annualizedMinimumEur: 55000,
            annualizedMaximumEur: 55000,
          },
        },
      },
    });

    const salaryMaxSorted = await app.inject({
      method: "GET",
      url: "/v1/jobs?sort=compensation_max_eur&dir=desc&pageSize=3",
    });
    expect(salaryMaxSorted.statusCode, salaryMaxSorted.body).toBe(200);
    expect(salaryMaxSorted.json().items[0]).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/ready"),
    });

    const marketSorted = await app.inject({
      method: "GET",
      url: "/v1/jobs?sort=compensation_market&dir=desc&pageSize=3",
    });
    expect(marketSorted.statusCode, marketSorted.body).toBe(200);
    expect(marketSorted.json().items[0]).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      compensationSummary: {
        market: { displayRange: "EUR 112000-142000/year" },
      },
    });

    await app.close();
  });

  it("serves projection-visible normalized scoring keyword filters and rollups", async () => {
    const longNormalizedKeyword = "x".repeat(241);
    const formatBoundaryKeyword = "\uFEFFkeyword";
    const db = new Database(options.dbPath);
    insertScoreKeyword(db, "https://example.com/jobs/ready", 1, "legacy-only", "Legacy only", 0);
    insertScore(db, "https://example.com/jobs/ready", 2, 9, { keywords: ["ignored JSON keyword"] });
    insertScoreKeyword(db, "https://example.com/jobs/ready", 2, "strasse", "Straße", 0);
    insertScoreKeyword(
      db,
      "https://example.com/jobs/ready",
      2,
      longNormalizedKeyword,
      longNormalizedKeyword,
      1,
    );
    insertScoreKeyword(
      db,
      "https://example.com/jobs/ready",
      2,
      formatBoundaryKeyword,
      formatBoundaryKeyword,
      2,
    );
    insertScoreKeyword(db, "https://example.com/jobs/failed-score", 1, "cloud", "Cloud", 0);
    db.prepare(
      `INSERT INTO job_score_staleness (
         tenant_id, job_id, stale_reason, old_policy_version, new_policy_version, marked_at
       ) VALUES ('local', ?, 'scoring_policy_changed', 1, 2, ?)`,
    ).run(jobIdFor("https://example.com/jobs/ready"), "2026-04-29T10:03:00+00:00");
    db.close();

    const app = buildApp(options);
    const filtered = await app.inject({
      method: "GET",
      url: "/v1/jobs?normalizedScoreKeyword=strasse",
    });
    const aggregated = await app.inject({ method: "GET", url: "/v1/scoring/keywords" });
    const longKeywordFiltered = await app.inject({
      method: "GET",
      url: `/v1/jobs?normalizedScoreKeyword=${encodeURIComponent(longNormalizedKeyword)}`,
    });
    const formatBoundaryFiltered = await app.inject({
      method: "GET",
      url: `/v1/jobs?normalizedScoreKeyword=${encodeURIComponent(formatBoundaryKeyword)}`,
    });

    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items).toEqual([
      expect.objectContaining({
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        scoreVersion: 2,
        scoreStaleness: expect.objectContaining({ isStale: true, staleReason: "scoring_policy_changed" }),
      }),
    ]);
    expect(longKeywordFiltered.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
      jobIdFor("https://example.com/jobs/ready"),
    ]);
    expect(formatBoundaryFiltered.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
      jobIdFor("https://example.com/jobs/ready"),
    ]);
    expect(ScoringKeywordAggregationResponseSchema.parse(aggregated.json())).toEqual({
      ok: true,
      keywords: [
        { normalizedKeyword: "cloud", displayKeyword: "Cloud", scoreVersion: 1, jobCount: 1 },
        { normalizedKeyword: "strasse", displayKeyword: "Straße", scoreVersion: 2, jobCount: 1 },
        {
          normalizedKeyword: longNormalizedKeyword,
          displayKeyword: longNormalizedKeyword,
          scoreVersion: 2,
          jobCount: 1,
        },
        {
          normalizedKeyword: formatBoundaryKeyword,
          displayKeyword: formatBoundaryKeyword,
          scoreVersion: 2,
          jobCount: 1,
        },
      ],
    });

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(aggregated.body, { status: 200, statusText: "OK" }),
    );
    const clientKeywords = await createJobCtrlApiClient().scoringKeywords();
    expect(clientKeywords).toEqual(ScoringKeywordAggregationResponseSchema.parse(aggregated.json()));
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/v1/scoring/keywords",
      expect.objectContaining({ method: "GET" }),
    );
    fetchMock.mockRestore();
    await app.close();
  });

  it("serves tenant-scoped learning recommendations without source content", async () => {
    const db = new Database(options.dbPath);
    insertLearningRecommendationFixture(db, {
      tenantId: "local",
      recommendationId: `learning-recommendation:${"a".repeat(64)}`,
      tombstoned: true,
    });
    insertLearningRecommendationFixture(db, {
      tenantId: "local",
      recommendationId: `learning-recommendation:${"d".repeat(64)}`,
      tombstoned: false,
    });
    insertLearningRecommendationFixture(db, {
      tenantId: "other",
      recommendationId: `learning-recommendation:${"b".repeat(64)}`,
      tombstoned: false,
    });
    db.prepare(
      `INSERT INTO resume_review_drafts (
         tenant_id, draft_id, job_id, base_generation, renderer_format,
         state, latest_revision_number, created_at, updated_at
       ) VALUES ('local', 'private-learning-draft', ?, 1, 'text',
                 'active', 0, ?, ?)`,
    ).run(
      jobIdFor("https://example.com/jobs/ready"),
      "2026-08-01T09:00:00Z",
      "2026-08-01T09:00:00Z",
    );
    db.prepare(
      `INSERT INTO tailoring_feedback_signals (
         tenant_id, signal_id, job_id, draft_id, source_kind, source_id,
         signal_kind, status, summary, created_at
       ) VALUES ('local', 'private-learning-signal', ?,
                 'private-learning-draft', 'edit_delta', 'private-delta',
                 'factual_correction', 'candidate', ?, ?)`,
    ).run(
      jobIdFor("https://example.com/jobs/ready"),
      "private resume, prompt, note, and job description",
      "2026-08-01T09:00:00Z",
    );
    const auditBefore = learningAuditSnapshot(db);
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/learning/recommendations?page=1&pageSize=1",
    });

    expect(response.statusCode, response.body).toBe(200);
    const parsed = LearningRecommendationListResponseSchema.parse(response.json());
    expect(parsed.recommendations).toHaveLength(1);
    expect(parsed).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 });
    expect(parsed.recommendations[0]).toMatchObject({
      recommendationId: `learning-recommendation:${"a".repeat(64)}`,
      context: "materials",
      policyKind: "tailoring_rule",
      signalKind: "factual_correction",
      ruleKey: "fact_handling",
      ruleValue: "require_source_match",
      status: "pending",
      active: false,
      observedSignalCount: 3,
      observedJobCount: 2,
      minimumSignalCount: 3,
      minimumJobCount: 2,
      confidenceLimit: "sample_gated_no_population_inference",
      supportingEvidenceCount: 3,
      contradictingEvidenceCount: 1,
      tombstoneCount: 1,
    });
    expect(response.body).not.toContain("private resume, prompt, note, and job description");
    expect(response.body).not.toContain("source-contradiction-local");
    expect(response.body).not.toContain(`learning-recommendation:${"b".repeat(64)}`);
    expect(() =>
      LearningRecommendationListResponseSchema.parse({
        ...parsed,
        recommendations: [
          {
            ...parsed.recommendations[0],
            recommendationId: "https://jobs.example/not-a-recommendation-id",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      LearningRecommendationListResponseSchema.parse({
        ...parsed,
        recommendations: [
          { ...parsed.recommendations[0], ruleKey: "private free text" },
        ],
      }),
    ).toThrow();
    const secondPage = LearningRecommendationListResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/learning/recommendations?page=2&pageSize=1",
        })
      ).json(),
    );
    expect(secondPage).toMatchObject({ page: 2, pageSize: 1, total: 2, totalPages: 2 });
    expect(secondPage.recommendations).toEqual([
      expect.objectContaining({
        recommendationId: `learning-recommendation:${"d".repeat(64)}`,
        active: true,
        tombstoneCount: 0,
      }),
    ]);

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(response.body, { status: 200, statusText: "OK" }),
    );
    await expect(
      createJobCtrlApiClient().learningRecommendations({ page: 1, pageSize: 1 }),
    ).resolves.toEqual(parsed);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/v1/learning/recommendations?page=1&pageSize=1",
      expect.objectContaining({ method: "GET" }),
    );
    fetchMock.mockRestore();
    const unchanged = new Database(options.dbPath);
    expect(learningAuditSnapshot(unchanged)).toBe(auditBefore);
    unchanged.close();
    await app.close();
  });

  it("excludes terminal learning recommendations from tenant-scoped pages without hiding evidence", async () => {
    const acceptedRecommendationId = `learning-recommendation:${"a".repeat(64)}`;
    const rejectedRecommendationId = `learning-recommendation:${"b".repeat(64)}`;
    const pendingRecommendationId = `learning-recommendation:${"c".repeat(64)}`;
    const otherTenantRecommendationId = `learning-recommendation:${"d".repeat(64)}`;
    const db = new Database(options.dbPath);
    insertLearningRecommendationFixture(db, {
      tenantId: "local",
      recommendationId: acceptedRecommendationId,
      tombstoned: false,
    });
    insertLearningRecommendationFixture(db, {
      tenantId: "local",
      recommendationId: rejectedRecommendationId,
      tombstoned: false,
    });
    insertLearningRecommendationFixture(db, {
      tenantId: "local",
      recommendationId: pendingRecommendationId,
      tombstoned: false,
    });
    insertLearningRecommendationFixture(db, {
      tenantId: "other",
      recommendationId: otherTenantRecommendationId,
      tombstoned: false,
    });
    insertTailoringPolicyFixture(db, {
      tenantId: "local",
      version: 1,
      learnedRules: {},
      createdAt: "2026-08-01T10:00:00Z",
    });
    db.prepare(
      `INSERT INTO learning_recommendation_reviews (
         tenant_id, review_id, recommendation_id, revision, decision,
         context, policy_kind, policy_version, reviewed_at
       ) VALUES ('local', ?, ?, 1, 'accepted', 'materials', 'tailoring_rule', 1, ?)`,
    ).run(
      `learning-recommendation-review:${"e".repeat(64)}`,
      acceptedRecommendationId,
      "2026-08-01T10:01:00Z",
    );
    db.prepare(
      `INSERT INTO learning_recommendation_reviews (
         tenant_id, review_id, recommendation_id, revision, decision,
         context, policy_kind, policy_version, reviewed_at
       ) VALUES ('local', ?, ?, 1, 'rejected', 'materials', 'tailoring_rule', NULL, ?)`,
    ).run(
      `learning-recommendation-review:${"f".repeat(64)}`,
      rejectedRecommendationId,
      "2026-08-01T10:02:00Z",
    );
    db.close();

    const app = buildApp(options);
    const firstPage = LearningRecommendationListResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/learning/recommendations?page=1&pageSize=1",
        })
      ).json(),
    );
    const secondPage = LearningRecommendationListResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: "/v1/learning/recommendations?page=2&pageSize=1",
        })
      ).json(),
    );
    const acceptedEvidence = LearningRecommendationEvidenceListResponseSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/v1/learning/recommendations/${encodeURIComponent(acceptedRecommendationId)}/evidence`,
        })
      ).json(),
    );

    expect(firstPage).toMatchObject({ page: 1, pageSize: 1, total: 1, totalPages: 1 });
    expect(firstPage.recommendations).toEqual([
      expect.objectContaining({ recommendationId: pendingRecommendationId }),
    ]);
    expect(secondPage).toMatchObject({ page: 2, pageSize: 1, total: 1, totalPages: 1 });
    expect(secondPage.recommendations).toEqual([]);
    expect(acceptedEvidence).toMatchObject({
      recommendationId: acceptedRecommendationId,
      total: 4,
    });

    await app.close();
  });

  it("serves privacy-bounded tailoring policy revision history", async () => {
    const recommendationId = `learning-recommendation:${"a".repeat(64)}`;
    const reviewId = `learning-recommendation-review:${"b".repeat(64)}`;
    const db = new Database(options.dbPath);
    insertLearningRecommendationFixture(db, {
      tenantId: "local",
      recommendationId,
      tombstoned: false,
    });
    insertTailoringPolicyFixture(db, {
      tenantId: "local",
      version: 1,
      learnedRules: {},
      createdAt: "2026-08-01T10:00:00Z",
    });
    insertTailoringPolicyFixture(db, {
      tenantId: "local",
      version: 2,
      learnedRules: { fact_handling: "require_source_match" },
      createdAt: "2026-08-01T11:00:00Z",
    });
    db.prepare(
      `INSERT INTO learning_recommendation_reviews (
         tenant_id, review_id, recommendation_id, revision, decision,
         context, policy_kind, policy_version, reviewed_at
       ) VALUES ('local', ?, ?, 1, 'accepted', 'materials', 'tailoring_rule', 2, ?)`,
    ).run(reviewId, recommendationId, "2026-08-01T11:00:00Z");
    insertTailoringPolicyFixture(db, {
      tenantId: "local",
      version: 3,
      learnedRules: {},
      rollbackOfVersion: 1,
      rollbackReason: "private historical rollback narrative",
      createdAt: "2026-08-01T11:30:00Z",
    });
    insertTailoringPolicyFixture(db, {
      tenantId: "local",
      version: 4,
      learnedRules: {},
      rollbackOfVersion: 1,
      rollbackReason: "user_requested",
      createdAt: "2026-08-01T12:00:00Z",
    });
    insertTailoringPolicyFixture(db, {
      tenantId: "other",
      version: 1,
      learnedRules: { provenance_policy: "require_direct_evidence" },
      createdAt: "2026-08-01T10:00:00Z",
    });
    const before = JSON.stringify(
      db.prepare("SELECT * FROM tailoring_policies ORDER BY tenant_id, version").all(),
    );
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: "/v1/learning/policies/materials?page=1&pageSize=4",
    });

    expect(response.statusCode, response.body).toBe(200);
    const parsed = TailoringPolicyRevisionListResponseSchema.parse(response.json());
    expect(parsed).toMatchObject({ page: 1, pageSize: 4, total: 4, totalPages: 1 });
    expect(parsed.revisions).toEqual([
      {
        context: "materials",
        policyKind: "tailoring_rule",
        version: 4,
        status: "current",
        learnedRules: [],
        sourceReviewId: null,
        sourceRecommendationId: null,
        rollbackOfVersion: 1,
        rollbackReasonCode: "user_requested",
        createdAt: "2026-08-01T12:00:00.000Z",
      },
      {
        context: "materials",
        policyKind: "tailoring_rule",
        version: 3,
        status: "superseded",
        learnedRules: [],
        sourceReviewId: null,
        sourceRecommendationId: null,
        rollbackOfVersion: 1,
        rollbackReasonCode: "historical_or_unspecified",
        createdAt: "2026-08-01T11:30:00.000Z",
      },
      {
        context: "materials",
        policyKind: "tailoring_rule",
        version: 2,
        status: "superseded",
        learnedRules: [{ ruleKey: "fact_handling", ruleValue: "require_source_match" }],
        sourceReviewId: reviewId,
        sourceRecommendationId: recommendationId,
        rollbackOfVersion: null,
        rollbackReasonCode: null,
        createdAt: "2026-08-01T11:00:00.000Z",
      },
      {
        context: "materials",
        policyKind: "tailoring_rule",
        version: 1,
        status: "superseded",
        learnedRules: [],
        sourceReviewId: null,
        sourceRecommendationId: null,
        rollbackOfVersion: null,
        rollbackReasonCode: null,
        createdAt: "2026-08-01T10:00:00.000Z",
      },
    ]);
    expect(response.body).not.toContain("sha256:private-prompt");
    expect(response.body).not.toContain("require_direct_evidence");
    expect(response.body).not.toContain("private historical rollback narrative");

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(response.body, { status: 200, statusText: "OK" }),
    );
    await expect(
      createJobCtrlApiClient().tailoringPolicyRevisions({ page: 1, pageSize: 4 }),
    ).resolves.toEqual(parsed);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/v1/learning/policies/materials?page=1&pageSize=4",
      expect.objectContaining({ method: "GET" }),
    );
    fetchMock.mockRestore();

    const unchanged = new Database(options.dbPath);
    expect(
      JSON.stringify(
        unchanged.prepare("SELECT * FROM tailoring_policies ORDER BY tenant_id, version").all(),
      ),
    ).toBe(before);
    unchanged.close();
    await app.close();
  });

  it("rolls back tailoring policy through the runtime-scoped RPC boundary", async () => {
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        status: "succeeded",
        context: "materials",
        policyKind: "tailoring_rule",
        policyVersion: 3,
        rollbackOfVersion: 1,
        rollbackReasonCode: "user_requested",
        learnedRules: [],
        rolledBackAt: "2026-08-01T12:34:56+00:00",
      },
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/learning/policies/materials/rollbacks",
      payload: { targetVersion: 1 },
    });

    expect(response.statusCode, response.body).toBe(200);
    const parsed = TailoringPolicyRollbackResponseSchema.parse(response.json());
    expect(parsed).toEqual({
      ok: true,
      context: "materials",
      policyKind: "tailoring_rule",
      version: 3,
      status: "current",
      learnedRules: [],
      sourceReviewId: null,
      sourceRecommendationId: null,
      rollbackOfVersion: 1,
      rollbackReasonCode: "user_requested",
      createdAt: "2026-08-01T12:34:56.000Z",
    });
    expect(call).toHaveBeenCalledWith(RpcMethods.RollbackTailoringPolicy, {
      tenantId: "local",
      targetVersion: 1,
      expectedAppDir: tempDir,
      expectedDbPath: options.dbPath,
    });

    const invalid = await app.inject({
      method: "POST",
      url: "/v1/learning/policies/materials/rollbacks",
      payload: { targetVersion: 0 },
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(call).toHaveBeenCalledTimes(1);
    await app.close();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(response.body, { status: 200, statusText: "OK" }),
    );
    await expect(
      createJobCtrlApiClient().rollbackTailoringPolicy({ targetVersion: 1 }),
    ).resolves.toEqual(parsed);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8766/v1/learning/policies/materials/rollbacks",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ targetVersion: 1 }),
      }),
    );
    fetchMock.mockRestore();

    const badCall = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        status: "succeeded",
        context: "materials",
        policyKind: "tailoring_rule",
        policyVersion: 3,
        rollbackOfVersion: 1,
        rollbackReasonCode: "private rollback narrative",
        learnedRules: [],
        rolledBackAt: "2026-08-01T12:34:56Z",
      },
    }));
    const badApp = buildApp({
      ...options,
      providerDispatcher: { call: badCall, close: vi.fn(async () => undefined) },
    });
    const badResponse = await badApp.inject({
      method: "POST",
      url: "/v1/learning/policies/materials/rollbacks",
      payload: { targetVersion: 1 },
    });
    expect(badResponse.statusCode, badResponse.body).toBe(502);
    expect(badResponse.json()).toEqual({
      ok: false,
      error: "tailoring_policy_rollback_failed",
      message: "The tailoring policy rollback could not be completed.",
    });
    expect(badResponse.body).not.toContain("private rollback narrative");
    await badApp.close();
  });

  it("serves paginated recommendation evidence links without source content", async () => {
    const recommendationId = `learning-recommendation:${"a".repeat(64)}`;
    const otherTenantRecommendationId = `learning-recommendation:${"b".repeat(64)}`;
    const db = new Database(options.dbPath);
    insertLearningRecommendationFixture(db, {
      tenantId: "local",
      recommendationId,
      tombstoned: false,
    });
    insertLearningRecommendationFixture(db, {
      tenantId: "other",
      recommendationId: otherTenantRecommendationId,
      tombstoned: false,
    });
    const auditBefore = learningAuditSnapshot(db);
    db.close();

    const app = buildApp(options);
    const firstResponse = await app.inject({
      method: "GET",
      url: `/v1/learning/recommendations/${encodeURIComponent(recommendationId)}/evidence?page=1&pageSize=3`,
    });

    expect(firstResponse.statusCode, firstResponse.body).toBe(200);
    const firstPage = LearningRecommendationEvidenceListResponseSchema.parse(
      firstResponse.json(),
    );
    expect(firstPage).toMatchObject({
      recommendationId,
      page: 1,
      pageSize: 3,
      total: 4,
      totalPages: 2,
    });
    expect(firstPage.evidence).toEqual([
      {
        signalId: "signal-local-1",
        evidenceRole: "supporting",
        sourceKind: "tailoring_feedback_signal",
        sourceRevision: 1,
        jobId: "11111111-1111-4111-8111-111111111111",
        recordedAt: "2026-08-01T10:00:01.000Z",
      },
      {
        signalId: "signal-local-2",
        evidenceRole: "supporting",
        sourceKind: "tailoring_feedback_signal",
        sourceRevision: 2,
        jobId: "11111111-1111-4111-8111-111111111111",
        recordedAt: "2026-08-01T10:00:02.000Z",
      },
      {
        signalId: "signal-local-3",
        evidenceRole: "supporting",
        sourceKind: "tailoring_feedback_signal",
        sourceRevision: 3,
        jobId: "22222222-2222-4222-8222-222222222222",
        recordedAt: "2026-08-01T10:00:03.000Z",
      },
    ]);
    expect(firstResponse.body).not.toContain(
      "private resume, prompt, note, and job description",
    );
    expect(firstResponse.body).not.toContain("source-local-1");

    const secondResponse = await app.inject({
      method: "GET",
      url: `/v1/learning/recommendations/${encodeURIComponent(recommendationId)}/evidence?page=2&pageSize=3`,
    });
    expect(secondResponse.statusCode, secondResponse.body).toBe(200);
    const secondPage = LearningRecommendationEvidenceListResponseSchema.parse(
      secondResponse.json(),
    );
    expect(secondPage.evidence).toEqual([
      {
        signalId: "contradiction-local",
        evidenceRole: "contradicting",
        sourceKind: "tailoring_feedback_signal",
        sourceRevision: 4,
        jobId: "33333333-3333-4333-8333-333333333333",
        recordedAt: "2026-08-01T10:00:04.000Z",
      },
    ]);
    expect(secondResponse.body).not.toContain(
      "private resume, prompt, note, and job description",
    );

    const otherTenant = await app.inject({
      method: "GET",
      url: `/v1/learning/recommendations/${encodeURIComponent(otherTenantRecommendationId)}/evidence`,
    });
    expect(otherTenant.statusCode, otherTenant.body).toBe(404);
    expect(otherTenant.json()).toEqual({
      ok: false,
      error: "learning_recommendation_not_found",
    });
    const invalid = await app.inject({
      method: "GET",
      url: `/v1/learning/recommendations/${encodeURIComponent("https://jobs.example/not-an-id")}/evidence`,
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.json()).toEqual({
      ok: false,
      error: "invalid_learning_recommendation_id",
    });
    expect(() =>
      LearningRecommendationEvidenceListResponseSchema.parse({
        ...firstPage,
        evidence: [
          {
            ...firstPage.evidence[0],
            signalId: "private free text",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      LearningRecommendationEvidenceListResponseSchema.parse({
        ...firstPage,
        evidence: [
          {
            ...firstPage.evidence[0],
            jobId: "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      LearningRecommendationEvidenceListResponseSchema.parse({
        ...firstPage,
        evidence: [
          {
            ...firstPage.evidence[0],
            jobId: "https://jobs.example/url-is-not-a-job-id",
          },
        ],
      }),
    ).toThrow();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(firstResponse.body, { status: 200, statusText: "OK" }),
    );
    await expect(
      createJobCtrlApiClient().learningRecommendationEvidence(recommendationId, {
        page: 1,
        pageSize: 3,
      }),
    ).resolves.toEqual(firstPage);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8766/v1/learning/recommendations/${encodeURIComponent(recommendationId)}/evidence?page=1&pageSize=3`,
      expect.objectContaining({ method: "GET" }),
    );
    fetchMock.mockRestore();

    const unchanged = new Database(options.dbPath);
    expect(learningAuditSnapshot(unchanged)).toBe(auditBefore);
    unchanged.close();
    await app.close();
  });

  it("reviews learning recommendations through the runtime-scoped RPC boundary", async () => {
    const recommendationId = `learning-recommendation:${"a".repeat(64)}`;
    const acceptedReviewId = `learning-recommendation-review:${"b".repeat(64)}`;
    const rejectedReviewId = `learning-recommendation-review:${"c".repeat(64)}`;
    const call = vi.fn<JsonRpcDispatcher["call"]>(async (_method, params) => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result:
        params.decision === "accepted"
          ? {
              status: "succeeded",
              reviewId: acceptedReviewId,
              recommendationId,
              revision: 1,
              decision: "accepted",
              context: "materials",
              policyKind: "tailoring_rule",
              policyVersion: 2,
              reviewedAt: "2026-08-01T12:34:56+00:00",
            }
          : {
              status: "succeeded",
              reviewId: rejectedReviewId,
              recommendationId,
              revision: 2,
              decision: "rejected",
              context: "materials",
              policyKind: "tailoring_rule",
              policyVersion: null,
              reviewedAt: "2026-08-01T12:35:56Z",
            },
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const accepted = await app.inject({
      method: "POST",
      url: `/v1/learning/recommendations/${recommendationId}/reviews`,
      payload: { decision: "accepted" },
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    const acceptedReview = LearningRecommendationReviewResponseSchema.parse(accepted.json());
    expect(acceptedReview).toMatchObject({
      reviewId: acceptedReviewId,
      recommendationId,
      decision: "accepted",
      policyVersion: 2,
      reviewedAt: "2026-08-01T12:34:56.000Z",
    });
    expect(call).toHaveBeenCalledWith(RpcMethods.ReviewLearningRecommendation, {
      tenantId: "local",
      recommendationId,
      decision: "accepted",
      expectedAppDir: tempDir,
      expectedDbPath: options.dbPath,
    });

    const rejected = await app.inject({
      method: "POST",
      url: `/v1/learning/recommendations/${recommendationId}/reviews`,
      payload: { decision: "rejected" },
    });
    expect(rejected.statusCode, rejected.body).toBe(200);
    expect(LearningRecommendationReviewResponseSchema.parse(rejected.json())).toMatchObject({
      reviewId: rejectedReviewId,
      recommendationId,
      decision: "rejected",
      policyVersion: null,
      reviewedAt: "2026-08-01T12:35:56.000Z",
    });
    await app.close();

    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify(acceptedReview), { status: 200, statusText: "OK" }),
    );
    await expect(
      createJobCtrlApiClient().reviewLearningRecommendation(recommendationId, {
        decision: "accepted",
      }),
    ).resolves.toEqual(acceptedReview);
    expect(fetchMock).toHaveBeenCalledWith(
      `http://127.0.0.1:8766/v1/learning/recommendations/${encodeURIComponent(recommendationId)}/reviews`,
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "accepted" }),
      }),
    );
    fetchMock.mockRestore();
  });

  it("rejects invalid learning review input before dispatch", async () => {
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => {
      throw new Error("review RPC must not be called");
    });
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const invalidId = await app.inject({
      method: "POST",
      url: "/v1/learning/recommendations/not-a-canonical-recommendation/reviews",
      payload: { decision: "accepted" },
    });
    const invalidDecision = await app.inject({
      method: "POST",
      url: `/v1/learning/recommendations/learning-recommendation:${"a".repeat(64)}/reviews`,
      payload: { decision: "deferred" },
    });

    expect(invalidId.statusCode, invalidId.body).toBe(400);
    expect(invalidId.json()).toEqual({ ok: false, error: "invalid_learning_recommendation_id" });
    expect(invalidDecision.statusCode).toBe(400);
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("sanitizes learning review worker failures", async () => {
    const recommendationId = `learning-recommendation:${"a".repeat(64)}`;
    const marker = "private-worker-detail-must-not-appear";
    const cases = [
      {
        statusCode: 409,
        response: {
          jsonrpc: "2.0" as const,
          id: 1,
          error: { code: JsonRpcErrorCodes.InvalidParams, message: marker, data: { marker } },
        },
      },
      {
        statusCode: 502,
        response: {
          jsonrpc: "2.0" as const,
          id: 1,
          error: { code: JsonRpcErrorCodes.InternalError, message: marker, data: { marker } },
        },
      },
      {
        statusCode: 502,
        response: {
          jsonrpc: "2.0" as const,
          id: 1,
          result: { status: "succeeded", privateDetail: marker },
        },
      },
      { statusCode: 503, error: new Error(marker) },
    ] as const;

    for (const failure of cases) {
      const call = vi.fn<JsonRpcDispatcher["call"]>(async () => {
        if ("error" in failure) {
          throw failure.error;
        }
        return failure.response;
      });
      const app = buildApp({
        ...options,
        providerDispatcher: { call, close: vi.fn(async () => undefined) },
      });
      const response = await app.inject({
        method: "POST",
        url: `/v1/learning/recommendations/${recommendationId}/reviews`,
        payload: { decision: "accepted" },
      });

      expect(response.statusCode, response.body).toBe(failure.statusCode);
      expect(response.json()).toEqual({
        ok: false,
        error: "learning_recommendation_review_failed",
        message: "The learning recommendation review could not be completed.",
      });
      expect(response.body).not.toContain(marker);
      await app.close();
    }
  });

  it("sanitizes an impossible calendar date in a learning recommendation review result", async () => {
    const recommendationId = `learning-recommendation:${"a".repeat(64)}`;
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        status: "succeeded",
        reviewId: `learning-recommendation-review:${"b".repeat(64)}`,
        recommendationId,
        revision: 1,
        decision: "accepted",
        context: "materials",
        policyKind: "tailoring_rule",
        policyVersion: 2,
        reviewedAt: "2026-02-31T12:34:56+00:00",
      },
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/learning/recommendations/${recommendationId}/reviews`,
      payload: { decision: "accepted" },
    });

    expect(response.statusCode, response.body).toBe(502);
    expect(response.json()).toEqual({
      ok: false,
      error: "learning_recommendation_review_failed",
      message: "The learning recommendation review could not be completed.",
    });
    await app.close();
  });

  it("dispatches a focused compensation refresh without running the full pipeline", async () => {
    const jobUrl = "https://example.com/jobs/ready";
    const exactV7DbPath = path.join(tempDir, "compensation-focused-v7.db");
    seedExactV7CompensationDatabase(exactV7DbPath, {
      jobId: COMPENSATION_JOB_ID,
      postingUrl: jobUrl,
    });
    const actionDispatcher = vi.fn(async (): Promise<ActionDispatchResult> => ({
      status: "succeeded",
      result: {
        ok: true,
        status: "succeeded",
        postingUrl: jobUrl,
        postedFactsRefreshed: 1,
        reportedObservationsLoaded: 0,
        estimatesRefreshed: 0,
        tenantId: "local",
      },
    }));
    const app = buildApp({ ...options, dbPath: exactV7DbPath, actionDispatcher });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/https%3A%2F%2Fexample.com%2Fjobs%2Fready/actions/refresh-compensation",
      payload: { observationsJsonPath: "/tmp/reported-compensation.json" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "refresh_compensation",
      status: "succeeded",
      jobKey: COMPENSATION_JOB_ID,
      command: {
        action: "refresh_compensation",
        jobKey: COMPENSATION_JOB_ID,
        observationsJsonPath: "/tmp/reported-compensation.json",
      },
    });
    expect(actionDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refresh_compensation",
        jobKey: COMPENSATION_JOB_ID,
        observationsJsonPath: "/tmp/reported-compensation.json",
      }),
      expect.objectContaining({ dbPath: exactV7DbPath }),
    );

    await app.close();
  });

  it("dispatches an all-jobs compensation refresh without running the full pipeline", async () => {
    const exactV7DbPath = path.join(tempDir, "compensation-all-jobs-v7.db");
    seedExactV7CompensationDatabase(exactV7DbPath);
    const actionDispatcher = vi.fn(async (): Promise<ActionDispatchResult> => ({
      status: "succeeded",
      result: {
        ok: true,
        status: "succeeded",
        postingUrl: null,
        postedFactsRefreshed: 2,
        reportedObservationsLoaded: 0,
        estimatesRefreshed: 2,
        tenantId: "local",
      },
    }));
    const app = buildApp({ ...options, dbPath: exactV7DbPath, actionDispatcher });
    const response = await app.inject({
      method: "POST",
      url: "/v1/jobs/actions/refresh-compensation",
      payload: { includeEuroTopTech: false, euroTopTechMaxPages: 3 },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "refresh_compensation",
      status: "succeeded",
      jobKey: "pipeline",
      command: {
        action: "refresh_compensation",
        jobKey: "pipeline",
        includeEuroTopTech: false,
        euroTopTechMaxPages: 3,
      },
    });
    expect(actionDispatcher).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refresh_compensation",
        jobKey: "pipeline",
        includeEuroTopTech: false,
        euroTopTechMaxPages: 3,
      }),
      expect.objectContaining({ dbPath: exactV7DbPath }),
    );

    await app.close();
  });

  it("returns a curated per-job audit history without raw debug events", async () => {
    const jobUrl = "https://example.com/jobs/ready";
    const db = new Database(options.dbPath);
    const insertAuditEvent = db.prepare(
      "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
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

  it("attributes rejected duplicate links to the surviving owner's audit history", async () => {
    const jobUrl = "https://example.com/jobs/ready";
    const candidateUrl = "https://jobs.lever.co/acme/staff-platform-engineer-india";
    const db = new Database(options.dbPath);
    db.prepare(
      "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
    ).run(
      jobUrl,
      "discover",
      "DuplicateJobLinkRejected",
      "info",
      "DuplicateJobLinkRejected",
      "2026-04-29T10:06:00+00:00",
      JSON.stringify({
        tenantId: "local",
        duplicate_link_id: "dup:policy-1",
        job_id: jobUrl,
        candidate_posting_url: candidateUrl,
        reason: "content_match_policy_rejected: current_policy_mismatch: location_mismatch",
        rejected_at: "2026-04-29T10:06:00+00:00",
      }),
    );
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    const rejected = body.auditHistory.find(
      (entry: { title: string }) => entry.title === "Duplicate link rejected",
    );
    expect(rejected, JSON.stringify(body.auditHistory)).toBeDefined();
    expect(rejected.category).toBe("discovery");
    expect(rejected.details).toEqual(
      expect.arrayContaining([{ label: "Candidate", value: candidateUrl }]),
    );
    // The event carries no confidence, so no empty Confidence row should render.
    expect(rejected.details.map((detail: { label: string }) => detail.label)).not.toContain("Confidence");

    await app.close();
  });

  it("attributes accepted duplicate links to the surviving owner's audit history", async () => {
    const jobUrl = "https://example.com/jobs/ready";
    const supersededUrl = "https://careers.acme.com/staff-platform-engineer";
    const db = new Database(options.dbPath);
    db.prepare(
      "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
    ).run(
      jobUrl,
      "discover",
      "DuplicateJobLinked",
      "info",
      "DuplicateJobLinked",
      "2026-04-29T10:07:00+00:00",
      JSON.stringify({
        tenantId: "local",
        duplicate_link_id: "dup:linked-1",
        surviving_job_id: jobIdFor(jobUrl),
        superseded_job_or_observation_id: supersededUrl,
        reason: "content_fingerprint_match",
        confidence: 0.95,
      }),
    );
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    const linked = body.auditHistory.find(
      (entry: { title: string }) => entry.title === "Duplicate linked",
    );
    expect(linked, JSON.stringify(body.auditHistory)).toBeDefined();
    expect(linked.category).toBe("discovery");
    expect(linked.details).toEqual(
      expect.arrayContaining([
        { label: "Reason", value: "Content Fingerprint Match" },
        { label: "Confidence", value: "95%" },
      ]),
    );

    await app.close();
  });

  it("surfaces enrichment confidence and quarantine on the content-snapshot audit entry", async () => {
    const jobUrl = "https://example.com/jobs/ready";
    const db = new Database(options.dbPath);
    db.prepare(
      "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
    ).run(
      jobUrl,
      "enrich",
      "PostingContentSnapshotCaptured",
      "info",
      "raw snapshot message",
      "2026-04-29T10:06:00+00:00",
      JSON.stringify({
        tenantId: "local",
        jobId: jobUrl,
        sourceId: "workday:example",
        snapshotVersion: 1,
        extractionTier: "llm_assisted",
        confidence: "low",
        quarantineReason: "low_confidence_extraction",
        quarantined: true,
      }),
    );
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    const snapshotEntry = body.auditHistory.find(
      (entry: { title: string }) => entry.title === "Content snapshot captured",
    );
    expect(snapshotEntry).toBeDefined();
    expect(snapshotEntry.tone).toBe("warning");
    expect(snapshotEntry.details).toEqual(
      expect.arrayContaining([
        { label: "Confidence", value: "Low" },
        { label: "Quarantine", value: "Low Confidence Extraction" },
      ]),
    );

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
    expect(singleDelete.json()).toMatchObject({ ok: true, count: 1, jobKeys: [jobIdFor("https://example.com/jobs/ready")] });
    expect(bulkDelete.statusCode, bulkDelete.body).toBe(200);
    expect(bulkDelete.json()).toMatchObject({ ok: true, count: 1, jobKeys: [jobIdFor("https://example.com/jobs/failed-score")] });

    const active = await app.inject({ method: "GET", url: "/v1/jobs" });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().pagination.total).toBe(1);
    expect(active.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([jobIdFor("https://example.com/jobs/blocked-tailor")]);

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
    db.prepare(
      "INSERT INTO jobctrl_deleted_jobs (tenant_id, job_id, deleted_at, reason, restored_at) VALUES ('local', ?, ?, ?, ?)",
    ).run(
      jobIdFor("https://example.com/jobs/ready"),
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
      jobKey: jobIdFor("https://example.com/jobs/ready"),
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
      jobIdFor("https://example.com/jobs/blocked-tailor"),
    );

    const deleted = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted" });
    expect(deleted.statusCode, deleted.body).toBe(200);
    expect(deleted.json().pagination.total).toBe(0);

    const hidden = await app.inject({ method: "GET", url: "/v1/jobs?deleted=hidden" });
    expect(hidden.statusCode, hidden.body).toBe(200);
    expect(hidden.json().pagination.total).toBe(1);
    expect(hidden.json().items[0]).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/blocked-tailor"),
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
    db.prepare(
      `INSERT INTO posting_snapshot_sets (
        tenant_id, job_id, snapshot_set_json, latest_snapshot_version,
        latest_active_state, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      "local",
      jobIdFor("https://example.com/jobs/failed-score"),
      JSON.stringify({ tenant_id: "local", job_id: jobIdFor("https://example.com/jobs/failed-score"), latest_active_state: "removed" }),
      0,
      "removed",
      "2026-05-29T10:00:00+00:00",
    );
    db.prepare(
      "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
    ).run(
      "https://example.com/jobs/failed-score",
      "enrich",
      "JobActiveStateChanged",
      "info",
      "Job active state changed.",
      "2026-05-29T10:00:00+00:00",
      JSON.stringify({
        job_id: jobIdFor("https://example.com/jobs/failed-score"),
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
      jobIdFor("https://example.com/jobs/failed-score"),
    );

    const closed = await app.inject({ method: "GET", url: "/v1/jobs?deleted=closed" });
    expect(closed.statusCode, closed.body).toBe(200);
    expect(closed.json().pagination.total).toBe(1);
    expect(closed.json().items[0]).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/failed-score"),
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
    expect(permanentDelete.json()).toMatchObject({
      ok: true,
      count: 2,
      jobKeys: [jobIdFor(readyUrl), jobIdFor(blockedUrl)],
    });

    const active = await app.inject({ method: "GET", url: "/v1/jobs?deleted=active&sort=title&dir=asc" });
    expect(active.statusCode, active.body).toBe(200);
    expect(active.json().pagination.total).toBe(1);
    expect(active.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
      jobIdFor("https://example.com/jobs/failed-score"),
    ]);

    const deleted = await app.inject({ method: "GET", url: "/v1/jobs?deleted=deleted" });
    expect(deleted.json().pagination.total).toBe(0);
    const hidden = await app.inject({ method: "GET", url: "/v1/jobs?deleted=hidden" });
    expect(hidden.json().pagination.total).toBe(0);

    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${encodeURIComponent(readyUrl)}` });
    expect(detail.statusCode, detail.body).toBe(404);

    const db = new Database(options.dbPath);
    expect(countRows(db, "jobs", "url", readyUrl)).toBe(0);
    expect(countRows(db, "jobctrl_deleted_jobs", "job_id", jobIdFor(readyUrl))).toBe(0);
    expect(countRows(db, "jobctrl_hidden_jobs", "job_id", jobIdFor(blockedUrl))).toBe(0);
    expect(countRows(db, "job_stage_states", "job_id", jobIdFor(readyUrl))).toBe(0);
    expect(countRows(db, "job_scores", "job_id", jobIdFor(readyUrl))).toBe(0);

    insertJob(db, {
      url: readyUrl,
      title: "Rediscovered Engineer",
      site: "ExampleCo",
      fitScore: null,
    });
    db.prepare(
      "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?",
    ).run(readyUrl, "discover", "JobDiscovered", "info", "Rediscovered after permanent delete.", "2026-04-30T10:00:00+00:00");
    db.close();

    const rediscovered = await app.inject({
      method: "GET",
      url: "/v1/jobs?deleted=active&q=rediscovered&sort=title&dir=asc",
    });
    expect(rediscovered.statusCode, rediscovered.body).toBe(200);
    expect(rediscovered.json().pagination.total).toBe(1);
    expect(rediscovered.json().items[0]).toMatchObject({
      jobKey: jobIdFor(readyUrl),
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
      jobIdFor(newJobUrl),
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
        jobKey: jobIdFor(newJobUrl),
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
        jobKey: jobIdFor(newJobUrl),
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
      jobKey: jobIdFor("https://example.com/jobs/unscored"),
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
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      currentStage: "apply",
      currentState: "pending",
      artifactCount: 2,
    });
    expect(body.applyAudit).toMatchObject({
      state: "ready",
      label: "materials ready",
      reviewEvidenceAvailable: true,
      hardBlockers: [],
    });
    expect(body.applyAudit.missingPrerequisites).toEqual([]);
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

  it("keeps a job's active apply-run cancellation target outside the bounded dashboard history", async () => {
    const jobUrl = "https://example.com/jobs/ready";
    const db = new Database(options.dbPath);
    const insertApplyRun = db.prepare(
      `INSERT INTO apply_run_projections (
         run_id, job_id, job_title, job_employer, status, result, dry_run, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    // These rows legitimately occupy the dashboard's twelve most-recent slots
    // but belong to other jobs. The in-flight target must remain cancellable
    // from its own detail view.
    for (let index = 0; index < 12; index += 1) {
      insertApplyRun.run(
        `newer-run-${index}`,
        jobIdFor(`https://example.com/jobs/newer-${index}`),
        `Newer role ${index}`,
        "ExampleCo",
        "succeeded",
        "applied",
        0,
        `2026-06-01T00:${String(index).padStart(2, "0")}:00+00:00`,
      );
    }
    insertApplyRun.run(
      "active-run-older",
      jobIdFor(jobUrl),
      "Platform Engineer",
      "ExampleCo",
      "in_progress",
      null,
      0,
      "2026-04-28T10:00:00+00:00",
    );
    db.close();

    const app = buildApp(options);
    try {
      const dashboard = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(dashboard.statusCode, dashboard.body).toBe(200);
      expect(dashboard.json().applyRuns).toHaveLength(12);
      expect(
        dashboard.json().applyRuns.some((run: { runId: string }) => run.runId === "active-run-older"),
      ).toBe(false);

      const detail = await app.inject({
        method: "GET",
        url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().activeApplyRun).toMatchObject({
        runId: "active-run-older",
        status: "in_progress",
        dryRun: false,
      });
    } finally {
      await app.close();
    }
  });

  it("labels apply readiness repairs from the failed preparation substage", async () => {
    const db = new Database(options.dbPath);
    const jobUrl = "https://example.com/jobs/tailor-failed";
    insertJob(db, {
      url: jobUrl,
      title: "Tailor Failed Engineer",
      site: "Example",
      fitScore: 9,
    });
    insertScore(db, jobUrl, 1, 9);
    for (const stage of ["discover", "enrich", "score"]) {
      insertStage(db, jobUrl, stage, "succeeded");
    }
    insertStage(db, jobUrl, "tailor", "failed", "FAILED_VALIDATION");
    db.prepare("UPDATE job_stage_states SET error_message = ? WHERE tenant_id = 'local' AND job_id = ? AND stage = ?").run(
      "Tailoring ended with status failed_validation",
      jobIdFor(jobUrl),
      "tailor",
    );
    db.close();

    const app = buildApp(options);
    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(jobUrl)}`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      job: {
        currentStage: "discover",
        currentSubstage: "tailor",
        currentState: "failed",
      },
      applyAudit: {
        state: "repair",
        label: "tailor failed",
        hardBlockers: [
          expect.objectContaining({
            code: "stage_not_ready",
            label: "tailor failed",
            detail: "tailoring ended with status failed validation",
          }),
        ],
      },
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
      jobIdFor("https://example.com/jobs/ready"),
      jobIdFor("https://example.com/jobs/failed-score"),
      jobIdFor("https://example.com/jobs/blocked-tailor"),
    ]);
    expect(items[0]).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      fitScore: 9,
      salary: "€55,000/year",
      compensationSummary: {
        legacyRawSalary: "€55,000/year",
        warningCount: 0,
        posted: {
          recordStatus: "recorded",
          parseState: "parsed_range",
          displayRange: "EUR 55000/year",
          warningCount: 0,
        },
        market: {
          recordStatus: "not_requested",
          estimateState: "not_requested",
          displayRange: null,
        },
      },
    });
    expect(items[0]).not.toHaveProperty("compensationAudit");

    const filtered = await app.inject({
      method: "GET",
      url: "/v1/jobs?minFitScore=9&sort=fit_score&dir=desc",
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
      jobIdFor("https://example.com/jobs/ready"),
    ]);

    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${readyKey}` });
    expect(detail.statusCode, detail.body).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.job).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      salary: "€55,000/year",
      fitScore: 9,
      compensationSummary: {
        posted: { recordStatus: "recorded", parseState: "parsed_range" },
        market: { recordStatus: "not_requested", estimateState: "not_requested" },
      },
    });
    expect(detailBody.job).not.toHaveProperty("compensationAudit");
    expect(detailBody.compensationAudit).toMatchObject({
      posted: {
        recordStatus: "recorded",
        fact: {
          parseState: "parsed_range",
          sourceText: "€55,000/year",
          annualizedMinimumAmount: 55000,
          annualizedMaximumAmount: 55000,
        },
      },
      market: {
        recordStatus: "not_requested",
        jobId: jobIdFor("https://example.com/jobs/ready"),
      },
    });
    expect(detailBody.applyAudit).toMatchObject({
      state: "ready",
      label: "materials ready",
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
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      command: { dryRun: true },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apply",
        dryRun: true,
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
      }),
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
      jobIdFor("https://example.com/jobs/ready"),
      jobIdFor("https://example.com/jobs/failed-score"),
      jobIdFor("https://example.com/jobs/blocked-tailor"),
    ]);
    expect(items[0]).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      fitScore: 9,
      salary: "€55,000/year",
      compensationSummary: {
        legacyRawSalary: "€55,000/year",
        warningCount: 1,
        posted: {
          recordStatus: "not_recorded",
          parseState: null,
          displayRange: null,
        },
        market: {
          sourceKind: "reported_company_role_market",
          recordStatus: "recorded",
          estimateState: "estimated_range",
          displayRange: "EUR 112000-142000/year",
          sourceCount: 2,
          warningCount: 1,
        },
      },
    });
    expect(items[0]).not.toHaveProperty("compensationAudit");
    expect(items[0]).not.toHaveProperty("marketCompensationEstimate");

    const filtered = await app.inject({
      method: "GET",
      url: "/v1/jobs?minFitScore=9&sort=fit_score&dir=desc",
    });
    expect(filtered.statusCode, filtered.body).toBe(200);
    expect(filtered.json().items.map((job: { jobKey: string }) => job.jobKey)).toEqual([
      jobIdFor("https://example.com/jobs/ready"),
    ]);

    const detail = await app.inject({ method: "GET", url: `/v1/jobs/${readyKey}` });
    expect(detail.statusCode, detail.body).toBe(200);
    const detailBody = detail.json();
    expect(detailBody.job).toMatchObject({
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      salary: "€55,000/year",
      fitScore: 9,
      compensationSummary: {
        posted: { recordStatus: "not_recorded", parseState: null },
        market: {
          sourceKind: "reported_company_role_market",
          recordStatus: "recorded",
          estimateState: "estimated_range",
          displayRange: "EUR 112000-142000/year",
        },
      },
    });
    expect(detailBody.job).not.toHaveProperty("compensationAudit");
    expect(detailBody.job).not.toHaveProperty("marketCompensationEstimate");
    expect(detailBody.compensationAudit).toMatchObject({
      posted: {
        recordStatus: "not_recorded",
        legacyRawSalary: "€55,000/year",
      },
      market: {
        recordStatus: "recorded",
        estimate: {
          estimateState: "estimated_range",
          minimumAmount: 112000,
          maximumAmount: 142000,
          companyName: "Example",
          matchScope: "exact_company_role",
        },
      },
    });
    expect(detailBody.applyAudit).toMatchObject({
      state: "ready",
      label: "materials ready",
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
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      command: { dryRun: true },
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "apply",
        dryRun: true,
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("reconciles stale retryable stage projections from latest failure events", async () => {
    const seedDb = new Database(options.dbPath);
    seedDb
      .prepare("UPDATE job_stage_states SET retryable = 1, next_action = ? WHERE tenant_id = 'local' AND job_id = ? AND stage = ?")
      .run(
        "jobctrl retry score https://example.com/jobs/failed-score",
        jobIdFor("https://example.com/jobs/failed-score"),
        "score",
      );
    seedDb
      .prepare(
        `INSERT INTO job_events (
           tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
         ) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?`,
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
      jobKey: jobIdFor("https://example.com/jobs/ready"),
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
           WHERE tenant_id = 'local' AND job_id = ?
           ORDER BY version DESC
           LIMIT 1`,
        )
        .get(jobIdFor("https://example.com/jobs/ready")) as {
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
        jobId: jobIdFor("https://example.com/jobs/ready"),
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
           WHERE tenant_id = 'local' AND job_id = ?`,
        )
        .get(jobIdFor(comparableUrl)) as {
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
          `SELECT job_id
           FROM job_score_staleness
           WHERE tenant_id = 'local' AND job_id IN (?, ?, ?)`,
        )
        .all(
          jobIdFor("https://example.com/jobs/ready"),
          jobIdFor(currentPolicyUrl),
          jobIdFor(alreadyCorrectedUrl),
        );
      expect(excludedRows).toEqual([]);
      const staleStage = db
        .prepare("SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'")
        .get(jobIdFor(comparableUrl)) as { state: string };
      expect(staleStage.state).toBe("stale");
      const event = db
        .prepare("SELECT event_type FROM job_events WHERE tenant_id = 'local' AND job_id = ? ORDER BY event_id DESC LIMIT 1")
        .get(jobIdFor(comparableUrl)) as { event_type: string };
      expect(event.event_type).toBe("ScoreMarkedStale");
    } finally {
      db.close();
      await app.close();
    }
  });

  it("rolls back the whole score correction when a later staleness write fails", async () => {
    const comparableUrl = "https://example.com/jobs/comparable-atomic";
    const seedDb = new Database(options.dbPath);
    seedDb
      .prepare(
        `INSERT INTO scoring_policies (tenant_id, version, rubric_json, anchors_json, created_at, created_from_event_id)
         VALUES ('local', 1, ?, '[]', ?, NULL)`,
      )
      .run(JSON.stringify({ rubric_version: "default-scoring-rubric-v1" }), "2026-04-29T10:03:00+00:00");
    insertJob(seedDb, { url: comparableUrl, title: "Comparable Engineer", site: "ExampleCo", fitScore: 7 });
    insertScore(seedDb, comparableUrl, 1, 7, { policyVersion: 1 });
    insertStage(seedDb, comparableUrl, "score", "succeeded");
    createScoreStalenessTable(seedDb);
    seedDb.close();

    const app = buildApp(options);
    const faultDb = new Database(options.dbPath);
    // Force the staleness-marking step to abort mid-correction, mimicking a
    // SQLITE_BUSY / constraint failure from a concurrent worker write after the
    // new score version and policy row have already been inserted.
    faultDb.exec(`
      CREATE TRIGGER fail_staleness_insert
      BEFORE INSERT ON job_score_staleness
      BEGIN
        SELECT RAISE(ABORT, 'forced staleness failure');
      END;
    `);
    faultDb.close();
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");
    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/score-correction`,
      payload: { correctedScore: 6, reason: "Manual review found a seniority mismatch." },
    });

    expect(response.statusCode, response.body).toBe(500);
    expect(response.json()).toMatchObject({ ok: false, error: "db_write_failed" });

    const db = new Database(options.dbPath);
    try {
      const scores = db
        .prepare("SELECT version FROM job_scores WHERE tenant_id = 'local' AND job_id = ? ORDER BY version")
        .all(jobIdFor("https://example.com/jobs/ready")) as Array<{ version: number }>;
      expect(scores.map((row) => row.version)).toEqual([1]);
      const policies = db
        .prepare("SELECT version FROM scoring_policies WHERE tenant_id = 'local' ORDER BY version")
        .all() as Array<{ version: number }>;
      expect(policies.map((row) => row.version)).toEqual([1]);
      const staleCount = db.prepare("SELECT COUNT(*) AS count FROM job_score_staleness").get() as { count: number };
      expect(staleCount.count).toBe(0);
      const comparableStage = db
        .prepare("SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'")
        .get(jobIdFor(comparableUrl)) as { state: string };
      expect(comparableStage.state).toBe("succeeded");
      const correctionEvents = db
        .prepare("SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'ScoreCorrected'")
        .get() as { count: number };
      expect(correctionEvents.count).toBe(0);
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
           tenant_id, job_id, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v2', 2, '2026-04-29T10:07:00+00:00', 0)`,
      )
      .run(jobIdFor(staleUrl));
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
      jobKeys: [jobIdFor(staleUrl)],
      nextAction: "jobctrl run score --rescore",
    });

    const db = new Database(options.dbPath);
    try {
      const marker = db
        .prepare("SELECT resolved, resolved_at FROM job_score_staleness WHERE tenant_id = 'local' AND job_id = ?")
        .get(jobIdFor(staleUrl)) as { resolved: number; resolved_at: string | null };
      expect(marker.resolved).toBe(1);
      expect(marker.resolved_at).toBeTruthy();
      const stage = db
        .prepare("SELECT state, attempt_count FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'")
        .get(jobIdFor(staleUrl)) as { state: string; attempt_count: number };
      expect(stage).toMatchObject({ state: "pending", attempt_count: 0 });
      const event = db
        .prepare("SELECT event_type, payload_json FROM job_events WHERE tenant_id = 'local' AND job_id = ? ORDER BY event_id DESC LIMIT 1")
        .get(jobIdFor(staleUrl)) as { event_type: string; payload_json: string };
      expect(event.event_type).toBe("ScoreRescoreRequested");
      expect(JSON.parse(event.payload_json)).toMatchObject({
        nextAction: "jobctrl run score --rescore",
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
           tenant_id, job_id, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v2', 2, '2026-04-29T10:07:00+00:00', 0)`,
      )
      .run(jobIdFor(staleUrl));
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
      const listJob = listResponse.json().items.find(
        (job: { jobKey: string }) => job.jobKey === jobIdFor(staleUrl),
      );
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
        jobKey: jobIdFor(staleUrl),
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
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        type: "tailored_resume_txt",
        status: "active",
      },
      tailoringExplanation: null,
    });

    await app.close();
  });

  it("returns resume layout boxes on artifact detail", async () => {
    const resumePdfPath = path.join(tempDir, "layout-resume.pdf");
    fs.writeFileSync(resumePdfPath, "%PDF-layout");
    const seedDb = new Database(options.dbPath);
    createMaterialsTables(seedDb);
    insertJob(seedDb, {
      url: "https://example.com/jobs/layout-resume",
      title: "Layout Resume Engineer",
      site: "LayoutCo",
      fitScore: 9,
      tailoredPath: resumePdfPath,
      fullDescription: "Platform reliability role.",
    });
    seedDb
      .prepare(
        `INSERT OR REPLACE INTO job_materials (
           tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
         ) VALUES ('local', ?, 1, 'resume_approved', ?, ?, '{}')`,
      )
      .run(
        jobIdFor("https://example.com/jobs/layout-resume"),
        "2026-05-26T10:00:00+00:00",
        "2026-05-26T10:00:00+00:00",
      );
    seedDb
      .prepare(
        `INSERT OR REPLACE INTO job_materials_artifacts (
           tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
           render_format, size_bytes, metadata_json, created_at
         ) VALUES ('local', ?, 1, 'resume_pdf', 'artifact-layout-resume-pdf', 'approved', ?, 'html_pdf', ?, '{}', ?)`,
      )
      .run(
        jobIdFor("https://example.com/jobs/layout-resume"),
        resumePdfPath,
        fs.statSync(resumePdfPath).size,
        "2026-05-26T10:00:00+00:00",
      );
    seedDb
      .prepare(
        `INSERT OR REPLACE INTO job_material_layout_boxes (
           tenant_id, job_id, generation, artifact_id, box_index,
           semantic_id, page_number, line_number, text_excerpt,
           left_pct, top_pct, width_pct, height_pct, audit_target_json, created_at
         ) VALUES ('local', ?, 1, 'artifact-layout-resume-pdf', 0, ?, 1, 6, ?, 12.5, 24.0, 62.0, 2.4, '{}', ?)`,
      )
      .run(
        jobIdFor("https://example.com/jobs/layout-resume"),
        "experience:acme:bullet:1",
        "Cut latency.",
        "2026-05-26T10:00:00+00:00",
      );
    seedDb.close();

    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/artifacts/artifact-layout-resume-pdf" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      artifact: {
        artifactId: "artifact-layout-resume-pdf",
        type: "resume_pdf",
        status: "approved",
      },
      layoutBoxes: [
        {
          semanticId: "experience:acme:bullet:1",
          pageNumber: 1,
          lineNumber: 6,
          textExcerpt: "Cut latency.",
          leftPct: 12.5,
          topPct: 24,
          widthPct: 62,
          heightPct: 2.4,
        },
      ],
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
      ) VALUES ('local', 'default', 'fleet_safety', 0, 'ev_fleet_safety', 'Preserved the pilot market under aggressive compliance deadlines.')
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
      evidenceIds: ["ev_fleet_safety"],
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

  it("returns null tailoring explanation for material artifacts without metadata", async () => {
    const resumePath = path.join(tempDir, "legacy-no-metadata-resume.txt");
    fs.writeFileSync(resumePath, "legacy tailored resume");
    const seedDb = new Database(options.dbPath);
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
           tenant_id, job_id, generation, status, created_at, updated_at
         ) VALUES ('local', ?, 1, 'resume_approved', ?, ?)`,
      )
      .run(
        jobIdFor("https://example.com/jobs/legacy-no-metadata"),
        "2026-05-26T10:00:00+00:00",
        "2026-05-26T10:00:00+00:00",
      );
    seedDb
      .prepare(
        `INSERT INTO job_materials_artifacts (
           tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
           render_format, size_bytes, created_at
         ) VALUES ('local', ?, 1, 'tailored_resume', 'artifact-legacy-no-metadata', 'approved', ?, 'text', ?, ?)`,
      )
      .run(
        jobIdFor("https://example.com/jobs/legacy-no-metadata"),
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
        jobKey: jobIdFor(suppressedUrl),
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
          jobKey: jobIdFor(suppressedUrl),
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
    const insertScoringPolicy = seedDb.prepare(
      "INSERT INTO scoring_policies (tenant_id, version, rubric_json, anchors_json, created_at) VALUES (?, ?, ?, ?, ?)",
    );
    insertScoringPolicy.run("local", 2, "{}", "[]", "2026-05-26T10:00:00+00:00");
    insertScoringPolicy.run("local", 3, "{}", "[]", "2026-05-26T10:05:00+00:00");
    seedDb
      .prepare(`INSERT INTO tailoring_policies (
        tenant_id, version, prompt_version, schema_version, judge_schema_version,
        prompt_fingerprint, config_fingerprint, profile_policy_fingerprint,
        custom_prompt_fingerprint, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("local", 2, "test", "test", "test", "test", "test", "test", "test", "2026-05-26T10:00:00+00:00");
    seedDb
      .prepare(
        `INSERT INTO job_score_staleness (
           tenant_id, job_id, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v2', 2, '2026-05-26T10:01:00+00:00', 0)`,
      )
      .run(jobIdFor("https://example.com/jobs/failed-score"));
    seedDb
      .prepare(
        `INSERT INTO job_score_staleness (
           tenant_id, job_id, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v3', 3, '2026-05-26T10:06:00+00:00', 0)`,
      )
      .run(jobIdFor("https://example.com/jobs/failed-score"));
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
          jobIdFor(jobId),
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

  it("does not infer outdated scores when explicit staleness markers are absent", async () => {
    const seedDb = new Database(options.dbPath);
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
      expect(response.json().preparation.outdatedScoreCount).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("does not count corrected latest scores as outdated when stale markers remain unresolved", async () => {
    const seedDb = new Database(options.dbPath);
    createScoreStalenessTable(seedDb);
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
           tenant_id, job_id, stale_reason, old_policy_id, old_policy_version,
           new_policy_id, new_policy_version, marked_at, resolved
         ) VALUES ('local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', 1,
           'local:scoring-policy-v3', 3, '2026-05-26T10:06:00+00:00', 0)`,
      )
      .run(jobIdFor("https://example.com/jobs/stale-but-corrected"));
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

  it("returns the workflow runs list from workflow_run_projections (apply run enriched with job context)", async () => {
    // Temporal loop closure (P0): `/v1/workflow-runs` reads the unified
    // `workflow_run_projections` table for all workflow types. The seed
    // inserts one apply-type workflow row (`run-1`, status `succeeded`) plus
    // the matching `apply_run_projections` row, so the LEFT JOIN enriches it
    // with job title/company/dry-run.
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
        jobKey: jobIdFor("https://example.com/jobs/ready"),
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

  it("enriches job-scoped preparation and pipeline runs from their canonical tenant-scoped JobId", async () => {
    const jobId = jobIdFor("https://example.com/jobs/ready");
    const db = new Database(options.dbPath);
    db.prepare(
      `INSERT INTO job_list_projections (tenant_id, job_id, title, employer)
       VALUES (?, ?, ?, ?)`,
    ).run("other", jobId, "Wrong tenant title", "Wrong tenant employer");
    insertDiscoverWorkflowRunRow(db, {
      workflowId: "prepare-local",
      workflowType: "JobPreparationWorkflow",
      status: "succeeded",
      inputSummary: { jobId, dryRun: true, steps: ["tailor", "cover"] },
      startedAt: "2026-04-29T10:26:00+00:00",
      finishedAt: "2026-04-29T10:27:00+00:00",
      durationMs: 60_000,
      temporalRunId: "temporal-prepare-run",
      eventsJson: JSON.stringify([
        {
          eventType: "WorkflowStarted",
          occurredAt: "2026-04-29T10:26:00+00:00",
          status: "in_progress",
          message: null,
        },
        {
          eventType: "WorkflowCompleted",
          occurredAt: "2026-04-29T10:27:00+00:00",
          status: "succeeded",
          message: null,
        },
      ]),
    });
    insertDiscoverWorkflowRunRow(db, {
      workflowId: "prepare-url-shaped",
      workflowType: "JobPreparationWorkflow",
      status: "queued",
      inputSummary: { jobId: "https://example.com/jobs/ready" },
      startedAt: "2026-04-29T10:25:00+00:00",
    });
    insertDiscoverWorkflowRunRow(db, {
      workflowId: "pipeline-job-local",
      workflowType: "JobPipelineWorkflow",
      status: "in_progress",
      inputSummary: { jobId, stages: ["tailor", "cover"] },
      startedAt: "2026-04-29T10:25:30+00:00",
      temporalRunId: "temporal-pipeline-job-run",
    });
    insertDiscoverWorkflowRunRow(db, {
      workflowId: "discover-with-job-id",
      status: "queued",
      inputSummary: { jobId },
      startedAt: "2026-04-29T10:24:00+00:00",
    });
    db.close();

    const app = buildApp(options);
    try {
      const listResponse = await app.inject({ method: "GET", url: "/v1/workflow-runs" });
      expect(listResponse.statusCode, listResponse.body).toBe(200);
      const summary = listResponse
        .json()
        .items.find((item: { workflowId: string }) => item.workflowId === "prepare-local");
      expect(summary).toMatchObject({
        workflowId: "prepare-local",
        workflowType: "JobPreparationWorkflow",
        jobKey: jobId,
        title: "Platform Engineer",
        company: "ExampleCo",
        status: "succeeded",
        dryRun: true,
      });
      const urlShapedSummary = listResponse
        .json()
        .items.find((item: { workflowId: string }) => item.workflowId === "prepare-url-shaped");
      expect(urlShapedSummary).toMatchObject({
        jobKey: "",
        title: "JobPreparationWorkflow",
        company: "",
      });
      const pipelineSummary = listResponse
        .json()
        .items.find((item: { workflowId: string }) => item.workflowId === "pipeline-job-local");
      expect(pipelineSummary).toMatchObject({
        workflowId: "pipeline-job-local",
        workflowType: "JobPipelineWorkflow",
        jobKey: jobId,
        title: "Platform Engineer",
        company: "ExampleCo",
      });
      const discoverSummary = listResponse
        .json()
        .items.find((item: { workflowId: string }) => item.workflowId === "discover-with-job-id");
      expect(discoverSummary).toMatchObject({
        jobKey: "",
        title: "DiscoverWorkflow",
        company: "",
      });

      const detailResponse = await app.inject({ method: "GET", url: "/v1/workflow-runs/prepare-local" });
      expect(detailResponse.statusCode, detailResponse.body).toBe(200);
      expect(detailResponse.json()).toMatchObject({
        workflowId: "prepare-local",
        workflowType: "JobPreparationWorkflow",
        jobKey: jobId,
        title: "Platform Engineer",
        company: "ExampleCo",
        inputSummary: { jobId, dryRun: true, steps: ["tailor", "cover"] },
        events: [
          { eventType: "WorkflowStarted", status: "in_progress" },
          { eventType: "WorkflowCompleted", status: "succeeded" },
        ],
      });

      const pipelineDetail = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs/pipeline-job-local",
      });
      expect(pipelineDetail.statusCode, pipelineDetail.body).toBe(200);
      expect(pipelineDetail.json()).toMatchObject({
        workflowId: "pipeline-job-local",
        workflowType: "JobPipelineWorkflow",
        jobKey: jobId,
        title: "Platform Engineer",
        company: "ExampleCo",
        inputSummary: { jobId, stages: ["tailor", "cover"] },
      });
    } finally {
      await app.close();
    }
  });

  it("surfaces the standing auto-apply loop as an operations workflow run", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `INSERT INTO workflow_run_projections (
         workflow_id, workflow_type, status, input_summary_json, started_at,
         temporal_run_id, events_json
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "apply-auto-local",
      "ApplyWorkflow",
      "in_progress",
      JSON.stringify({ continuous: true, autoApplyLoop: true, dryRun: false }),
      "2026-04-29T10:25:00+00:00",
      "temporal-auto-run",
      JSON.stringify([
        {
          eventType: "WorkflowStarted",
          occurredAt: "2026-04-29T10:25:00+00:00",
          status: "in_progress",
          message: null,
        },
      ]),
    );
    db.close();

    const app = buildApp(options);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/workflow-runs" });
      expect(response.statusCode, response.body).toBe(200);
      const run = response
        .json()
        .items.find((item: { workflowId: string }) => item.workflowId === "apply-auto-local");
      expect(run).toMatchObject({
        workflowId: "apply-auto-local",
        workflowType: "ApplyWorkflow",
        title: "Standing apply loop",
        company: "Auto apply",
        status: "in_progress",
        dryRun: false,
      });
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

  it("filters workflow runs by exact type and canonical started interval before pagination", async () => {
    const db = new Database(options.dbPath);
    try {
      const insert = db.prepare(
        "INSERT INTO workflow_run_projections (workflow_id, workflow_type, status, started_at, temporal_run_id) VALUES (?, ?, ?, ?, ?)",
      );
      insert.run(
        "run-discover-early",
        "DiscoverWorkflow",
        "succeeded",
        "2026-04-29T10:00:00+00:00",
        "temporal-discover-early",
      );
      insert.run(
        "run-discover-boundary",
        "DiscoverWorkflow",
        "succeeded",
        "2026-04-29T10:15:00+00:00",
        "temporal-discover-boundary",
      );
      insert.run(
        "run-discover-late",
        "DiscoverWorkflow",
        "succeeded",
        "2026-04-29T10:20:00+00:00",
        "temporal-discover-late",
      );
      insert.run(
        "run-discover-no-start",
        "DiscoverWorkflow",
        "succeeded",
        null,
        "temporal-discover-no-start",
      );
      insert.run(
        "run-legacy-workflow",
        "",
        "succeeded",
        "2026-04-29T10:17:00+00:00",
        "temporal-legacy-workflow",
      );
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const byType = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?workflowType=DiscoverWorkflow&sort=started_at&dir=asc&pageSize=100",
      });
      expect(byType.statusCode, byType.body).toBe(200);
      expect(byType.json().items.map((run: { workflowId: string }) => run.workflowId)).toEqual(
        expect.arrayContaining([
          "run-discover-early",
          "run-discover-boundary",
          "run-discover-late",
          "run-discover-no-start",
        ]),
      );
      expect(byType.json().items.map((run: { workflowId: string }) => run.workflowId)).not.toContain(
        "run-legacy-workflow",
      );
      expect(byType.json().filter).toMatchObject({
        status: "all",
        workflowType: "DiscoverWorkflow",
        startedSince: null,
        startedBefore: null,
      });

      const lowerOnly = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?workflowType=DiscoverWorkflow&startedSince=2026-04-29T10:15:00.000Z&sort=started_at&dir=asc",
      });
      expect(lowerOnly.statusCode, lowerOnly.body).toBe(200);
      expect(lowerOnly.json().items.map((run: { workflowId: string }) => run.workflowId)).toEqual([
        "run-discover-boundary",
        "run-discover-late",
      ]);

      const upperOnly = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?workflowType=DiscoverWorkflow&startedBefore=2026-04-29T10:15:00.000Z&sort=started_at&dir=asc",
      });
      expect(upperOnly.statusCode, upperOnly.body).toBe(200);
      expect(upperOnly.json().items.map((run: { workflowId: string }) => run.workflowId)).toEqual([
        "run-discover-early",
      ]);

      const boundedPage = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?workflowType=DiscoverWorkflow&startedSince=2026-04-29T10:00:00.000Z&startedBefore=2026-04-29T10:30:00.000Z&sort=started_at&dir=asc&page=2&pageSize=1",
      });
      expect(boundedPage.statusCode, boundedPage.body).toBe(200);
      expect(boundedPage.json().items.map((run: { workflowId: string }) => run.workflowId)).toEqual([
        "run-discover-boundary",
      ]);
      expect(boundedPage.json().pagination).toEqual({
        page: 2,
        pageSize: 1,
        total: 3,
        pages: 3,
      });

      const unfiltered = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?sort=started_at&dir=asc&pageSize=100",
      });
      expect(unfiltered.statusCode, unfiltered.body).toBe(200);
      expect(unfiltered.json().items.map((run: { workflowId: string }) => run.workflowId)).toEqual(
        expect.arrayContaining(["run-legacy-workflow", "run-discover-no-start"]),
      );
    } finally {
      await app.close();
    }
  });

  it("renders non-apply workflow runs with their workflow type and detail", async () => {
    // Temporal loop closure (P0): a pipeline orchestrator run has no apply
    // job context — the unified list surfaces its workflow type, and the
    // detail endpoint returns the folded lifecycle timeline + failure cause.
    const db = new Database(options.dbPath);
    db.prepare(
      "INSERT INTO workflow_run_projections (workflow_id, workflow_type, status, input_summary_json, error_code, error_message, retryable, started_at, finished_at, duration_ms, temporal_run_id, events_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "run-pipeline-1",
      "JobPipelineWorkflow",
      "failed",
      JSON.stringify({ stages: ["discover"] }),
      "activity_error",
      "discover activity failed",
      1,
      "2026-04-29T11:00:00+00:00",
      "2026-04-29T11:01:00+00:00",
      60000,
      "temporal-run-2",
      JSON.stringify([
        { eventType: "WorkflowStarted", occurredAt: "2026-04-29T11:00:00+00:00", status: "in_progress", message: null },
        { eventType: "WorkflowFailed", occurredAt: "2026-04-29T11:01:00+00:00", status: "failed", message: "discover activity failed" },
      ]),
    );
    db.close();

    const app = buildApp(options);
    try {
      const list = await app.inject({ method: "GET", url: "/v1/workflow-runs?status=failed" });
      expect(list.statusCode, list.body).toBe(200);
      const failedRun = list
        .json()
        .items.find((r: { workflowId: string }) => r.workflowId === "run-pipeline-1");
      expect(failedRun).toMatchObject({
        workflowId: "run-pipeline-1",
        workflowType: "JobPipelineWorkflow",
        status: "failed",
        jobKey: "",
      });

      const detail = await app.inject({ method: "GET", url: "/v1/workflow-runs/run-pipeline-1" });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        workflowId: "run-pipeline-1",
        workflowType: "JobPipelineWorkflow",
        status: "failed",
        errorCode: "activity_error",
        errorMessage: "discover activity failed",
        retryable: true,
        inputSummary: { stages: ["discover"] },
      });
      expect(detail.json().events).toHaveLength(2);

      const missing = await app.inject({ method: "GET", url: "/v1/workflow-runs/does-not-exist" });
      expect(missing.statusCode).toBe(404);
      expect(missing.json()).toMatchObject({ ok: false, error: "workflow_run_not_found" });
    } finally {
      await app.close();
    }
  });

  it("supersedes a stale terminal workflow-run projection when a reused workflow id restarts and fails", async () => {
    // Discover-reliability incident: the reconciler terminated `discover-local`
    // (reconciled_not_found), then a NEW Temporal execution reused the same
    // workflow id, emitted a duplicate start marker, and ultimately failed. The
    // Python fold froze the row on the OLD terminal outcome (chimera). The read
    // model must re-fold the canonical lifecycle to the current run's verdict.
    const db = new Database(options.dbPath);
    try {
      insertDiscoverWorkflowRunRow(db, {
        status: "terminated",
        errorCode: "reconciled_not_found",
        errorMessage: RECONCILED_MESSAGE,
        startedAt: DISCOVER_OLD_START,
        finishedAt: DISCOVER_TERMINATE_AT,
        temporalRunId: DISCOVER_NEW_TEMPORAL_RUN,
        eventsJson: JSON.stringify([
          { eventType: "WorkflowStarted", occurredAt: DISCOVER_OLD_START, status: "in_progress", message: "Discover workflow started" },
          { eventType: "WorkflowTerminated", occurredAt: DISCOVER_TERMINATE_AT, status: "terminated", message: RECONCILED_MESSAGE },
          { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START, status: "in_progress", message: "Discover workflow started" },
          { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START_DUP, status: "in_progress", message: "Discover workflow started" },
          { eventType: "WorkflowFailed", occurredAt: DISCOVER_FAILED_AT, status: "failed", message: "Activity task failed" },
        ]),
      });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_OLD_START, workflowId: "discover-local", temporalRunId: DISCOVER_OLD_TEMPORAL_RUN, startedAt: DISCOVER_OLD_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowTerminated", occurredAt: DISCOVER_TERMINATE_AT, workflowId: "discover-local", temporalRunId: DISCOVER_OLD_TEMPORAL_RUN, errorCode: "reconciled_not_found", errorMessage: RECONCILED_MESSAGE, finishedAt: DISCOVER_TERMINATE_AT });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: DISCOVER_NEW_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START_DUP, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: DISCOVER_NEW_START_DUP });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowFailed", occurredAt: DISCOVER_FAILED_AT, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, errorCode: "activity_task_failed", errorMessage: "Activity task failed", retryable: true, finishedAt: DISCOVER_FAILED_AT });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const list = await app.inject({ method: "GET", url: "/v1/workflow-runs" });
      expect(list.statusCode, list.body).toBe(200);
      const run = list.json().items.find((r: { workflowId: string }) => r.workflowId === "discover-local");
      expect(run).toMatchObject({
        workflowId: "discover-local",
        status: "failed",
        startedAt: DISCOVER_NEW_START,
        finishedAt: DISCOVER_FAILED_AT,
      });

      const filtered = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs?workflowType=DiscoverWorkflow&startedSince=2026-07-04T12:13:38.000Z&startedBefore=2026-07-04T12:13:39.000Z",
      });
      expect(filtered.statusCode, filtered.body).toBe(200);
      expect(filtered.json()).toMatchObject({
        pagination: { total: 1 },
        items: [{ workflowId: "discover-local", startedAt: DISCOVER_NEW_START }],
      });

      const detail = await app.inject({ method: "GET", url: "/v1/workflow-runs/discover-local" });
      expect(detail.statusCode, detail.body).toBe(200);
      const body = detail.json();
      expect(body).toMatchObject({
        workflowId: "discover-local",
        status: "failed",
        errorCode: "activity_task_failed",
        errorMessage: "Activity task failed",
        retryable: true,
        startedAt: DISCOVER_NEW_START,
        finishedAt: DISCOVER_FAILED_AT,
      });
      // The superseded terminal outcome is gone from the served verdict.
      expect(body.status).not.toBe("terminated");
      expect(body.errorCode).not.toBe("reconciled_not_found");
      // The timeline preserves the full history of both executions.
      expect(body.events).toHaveLength(5);
    } finally {
      await app.close();
    }
  });

  it("clears the prior terminal error while a reused workflow id is back in progress (duplicate start idempotent)", async () => {
    // Same reuse, observed between the new run's start and its terminal event:
    // the frozen row still says terminated, but the canonical lifecycle shows an
    // open run. A duplicate `WorkflowStarted` must not advance the start time.
    const db = new Database(options.dbPath);
    try {
      insertDiscoverWorkflowRunRow(db, {
        status: "terminated",
        errorCode: "reconciled_not_found",
        errorMessage: RECONCILED_MESSAGE,
        startedAt: DISCOVER_NEW_START,
        finishedAt: DISCOVER_TERMINATE_AT,
      });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_OLD_START, workflowId: "discover-local", temporalRunId: DISCOVER_OLD_TEMPORAL_RUN, startedAt: DISCOVER_OLD_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowTerminated", occurredAt: DISCOVER_TERMINATE_AT, workflowId: "discover-local", temporalRunId: DISCOVER_OLD_TEMPORAL_RUN, errorCode: "reconciled_not_found", errorMessage: RECONCILED_MESSAGE, finishedAt: DISCOVER_TERMINATE_AT });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: DISCOVER_NEW_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START_DUP, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: DISCOVER_NEW_START_DUP });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const detail = await app.inject({ method: "GET", url: "/v1/workflow-runs/discover-local" });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        workflowId: "discover-local",
        status: "in_progress",
        errorCode: null,
        errorMessage: null,
        retryable: false,
        finishedAt: null,
        startedAt: DISCOVER_NEW_START,
      });
    } finally {
      await app.close();
    }
  });

  it("keeps the stored canceled run when its only lifecycle stream entry is a cancellation-audit fact", async () => {
    // Regression (PR #750 review, reproduced on the Python twin): a legacy
    // canceled run has no state-bearing Workflow* job_events. Recording the
    // WorkflowCancellationRequested audit fact (which the cancellation-audit
    // backfill does for exactly this population) must not create a degenerate
    // fold that serves the stored canceled run as in_progress with null
    // startedAt/finishedAt — the documented legacy-seed fallback ("Runs with
    // no Workflow* events fall back to the stored row") must keep holding.
    const db = new Database(options.dbPath);
    try {
      insertDiscoverWorkflowRunRow(db, {
        workflowId: "discover-legacy-canceled",
        status: "canceled",
        startedAt: "2026-08-01T09:00:00+00:00",
        finishedAt: "2026-08-01T09:30:00+00:00",
        temporalRunId: "temporal-legacy-canceled",
        inputSummary: { jobId: "job-2" },
      });
      insertPipelineWorkflowEvent(db, {
        eventType: "WorkflowCancellationRequested",
        occurredAt: "2026-08-04T21:04:08+00:00",
        workflowId: "discover-legacy-canceled",
        temporalRunId: "temporal-legacy-canceled",
        message: "Cancellation requested by temporal-cli:tester@local via temporal_cli.",
      });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const list = await app.inject({ method: "GET", url: "/v1/workflow-runs?status=canceled" });
      expect(list.statusCode, list.body).toBe(200);
      const run = list
        .json()
        .items.find((r: { workflowId: string }) => r.workflowId === "discover-legacy-canceled");
      expect(run).toMatchObject({
        workflowId: "discover-legacy-canceled",
        status: "canceled",
        startedAt: "2026-08-01T09:00:00+00:00",
        finishedAt: "2026-08-01T09:30:00+00:00",
      });

      const detail = await app.inject({
        method: "GET",
        url: "/v1/workflow-runs/discover-legacy-canceled",
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        workflowId: "discover-legacy-canceled",
        status: "canceled",
        startedAt: "2026-08-01T09:00:00+00:00",
        finishedAt: "2026-08-01T09:30:00+00:00",
        inputSummary: { jobId: "job-2" },
      });
    } finally {
      await app.close();
    }
  });

  it("reopens the same Temporal run only for an explicit missing-history recovery", async () => {
    const recoveredRunId = "temporal-recovered-same-run";
    const originalStart = "2026-07-13T18:49:49.146Z";
    const falseTerminalAt = "2026-07-13T22:45:00.000Z";
    const recoveryAt = "2026-07-16T15:00:00.000Z";
    const db = new Database(options.dbPath);
    try {
      insertDiscoverWorkflowRunRow(db, {
        status: "terminated",
        errorCode: "reconciled_not_found",
        errorMessage: RECONCILED_MESSAGE,
        startedAt: originalStart,
        finishedAt: falseTerminalAt,
        temporalRunId: recoveredRunId,
      });
      insertPipelineWorkflowEvent(db, {
        eventType: "WorkflowStarted",
        occurredAt: originalStart,
        workflowId: "discover-local",
        temporalRunId: recoveredRunId,
        startedAt: originalStart,
      });
      insertPipelineWorkflowEvent(db, {
        eventType: "WorkflowTerminated",
        occurredAt: falseTerminalAt,
        workflowId: "discover-local",
        temporalRunId: recoveredRunId,
        errorCode: "reconciled_not_found",
        errorMessage: RECONCILED_MESSAGE,
        finishedAt: falseTerminalAt,
      });
      insertPipelineWorkflowEvent(db, {
        eventType: "WorkflowStarted",
        occurredAt: recoveryAt,
        workflowId: "discover-local",
        temporalRunId: recoveredRunId,
        startedAt: originalStart,
        recoveredFromMissingHistory: true,
      });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const detail = await app.inject({ method: "GET", url: "/v1/workflow-runs/discover-local" });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        workflowId: "discover-local",
        status: "in_progress",
        errorCode: null,
        errorMessage: null,
        startedAt: originalStart,
        finishedAt: null,
      });
    } finally {
      await app.close();
    }
  });

  it("ignores a late duplicate start for an already-terminalized execution", async () => {
    // A finalize-activity retry can append a second `WorkflowStarted` AFTER the
    // run's terminal event, with a later occurredAt. Same temporal run id means
    // it is NOT a new execution, so the failed verdict must survive — run-id
    // equality outranks wall-clock ordering in the reopen guard.
    const db = new Database(options.dbPath);
    try {
      insertDiscoverWorkflowRunRow(db, {
        status: "failed",
        errorCode: "activity_task_failed",
        errorMessage: "Activity task failed",
        startedAt: DISCOVER_NEW_START,
        finishedAt: DISCOVER_FAILED_AT,
      });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: DISCOVER_NEW_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowFailed", occurredAt: DISCOVER_FAILED_AT, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, errorCode: "activity_task_failed", errorMessage: "Activity task failed", retryable: true, finishedAt: DISCOVER_FAILED_AT });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: "2026-07-04T14:09:10.000+00:00", workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: "2026-07-04T14:09:10.000+00:00" });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const detail = await app.inject({ method: "GET", url: "/v1/workflow-runs/discover-local" });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        workflowId: "discover-local",
        status: "failed",
        errorCode: "activity_task_failed",
        errorMessage: "Activity task failed",
        finishedAt: DISCOVER_FAILED_AT,
      });
    } finally {
      await app.close();
    }
  });

  it("ignores a late terminal from a superseded execution while a newer run is live", async () => {
    // Terminal-direction twin of the reopen guard: run A dies without a
    // terminal, run B starts, THEN the reconciler's WorkflowTerminated for run
    // A lands with a later occurredAt. The stale terminal belongs to the
    // superseded execution and must not flip the live run B; B's own terminal
    // must still apply afterwards.
    const db = new Database(options.dbPath);
    try {
      insertDiscoverWorkflowRunRow(db, {
        status: "terminated",
        errorCode: "reconciled_not_found",
        errorMessage: RECONCILED_MESSAGE,
        startedAt: DISCOVER_NEW_START,
        finishedAt: DISCOVER_TERMINATE_AT,
      });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_OLD_START, workflowId: "discover-local", temporalRunId: DISCOVER_OLD_TEMPORAL_RUN, startedAt: DISCOVER_OLD_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: DISCOVER_NEW_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowTerminated", occurredAt: "2026-07-04T12:13:39.000+00:00", workflowId: "discover-local", temporalRunId: DISCOVER_OLD_TEMPORAL_RUN, errorCode: "reconciled_not_found", errorMessage: RECONCILED_MESSAGE, finishedAt: "2026-07-04T12:13:39.000+00:00" });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const detail = await app.inject({ method: "GET", url: "/v1/workflow-runs/discover-local" });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        workflowId: "discover-local",
        status: "in_progress",
        errorCode: null,
        errorMessage: null,
        finishedAt: null,
        startedAt: DISCOVER_NEW_START,
      });

      const followUp = new Database(options.dbPath);
      try {
        insertPipelineWorkflowEvent(followUp, { eventType: "WorkflowCompleted", occurredAt: "2026-07-04T12:45:00.000+00:00", workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, finishedAt: "2026-07-04T12:45:00.000+00:00" });
      } finally {
        followUp.close();
      }
      const after = await app.inject({ method: "GET", url: "/v1/workflow-runs/discover-local" });
      expect(after.statusCode, after.body).toBe(200);
      expect(after.json()).toMatchObject({
        workflowId: "discover-local",
        status: "succeeded",
        finishedAt: "2026-07-04T12:45:00.000+00:00",
      });
    } finally {
      await app.close();
    }
  });

  it("keeps the first terminal verdict within a single execution (reconciler describe race)", async () => {
    // Regression guard for the M-1 backstop: a reconciler `describe` that
    // observes the closed run and emits COMPLETED after the real WorkflowFailed
    // must not flip the verdict back to succeeded.
    const db = new Database(options.dbPath);
    try {
      insertDiscoverWorkflowRunRow(db, {
        status: "failed",
        errorCode: "activity_task_failed",
        errorMessage: "Activity task failed",
        retryable: true,
        startedAt: DISCOVER_NEW_START,
        finishedAt: DISCOVER_FAILED_AT,
      });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: DISCOVER_NEW_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowFailed", occurredAt: DISCOVER_FAILED_AT, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, errorCode: "activity_task_failed", errorMessage: "Activity task failed", retryable: true, finishedAt: DISCOVER_FAILED_AT });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowCompleted", occurredAt: "2026-07-04T14:09:00.000+00:00", workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, status: "succeeded", finishedAt: "2026-07-04T14:09:00.000+00:00" });
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const detail = await app.inject({ method: "GET", url: "/v1/workflow-runs/discover-local" });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        status: "failed",
        errorCode: "activity_task_failed",
        finishedAt: DISCOVER_FAILED_AT,
      });
    } finally {
      await app.close();
    }
  });

  it("finalizes discover progress from the re-folded workflow verdict, not the stale terminal row", async () => {
    // Fix B: even with a frozen `terminated` row and a discover progress event
    // stuck at 67% "running", the dashboard progress must report the current
    // run's re-folded `failed` verdict without hiding the last known step.
    const db = new Database(options.dbPath);
    try {
      insertDiscoverWorkflowRunRow(db, {
        status: "terminated",
        errorCode: "reconciled_not_found",
        errorMessage: RECONCILED_MESSAGE,
        startedAt: DISCOVER_NEW_START,
        finishedAt: DISCOVER_TERMINATE_AT,
      });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowStarted", occurredAt: DISCOVER_NEW_START, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, startedAt: DISCOVER_NEW_START });
      insertPipelineWorkflowEvent(db, { eventType: "WorkflowFailed", occurredAt: DISCOVER_FAILED_AT, workflowId: "discover-local", temporalRunId: DISCOVER_NEW_TEMPORAL_RUN, errorCode: "activity_task_failed", errorMessage: "Activity task failed", retryable: true, finishedAt: DISCOVER_FAILED_AT });
      db.prepare(
        "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?",
      ).run(
        null,
        "discover",
        "StageStarted",
        "info",
        "Smart extract complete",
        "2026-07-04T13:00:00.000+00:00",
        JSON.stringify({
          tenantId: "local",
          jobId: "pipeline",
          stage: "discover",
          runId: "discover-local",
          workflowId: "discover-local",
          progress: {
            completed: 2,
            total: 3,
            percent: 67,
            currentStep: "Smart extract complete",
            status: "running",
            message: "Smart extract complete",
          },
        }),
      );
    } finally {
      db.close();
    }

    const app = buildApp(options);
    try {
      const response = await app.inject({ method: "GET", url: "/v1/dashboard/summary" });
      expect(response.statusCode, response.body).toBe(200);
      const progress = response
        .json()
        .progress.find((p: { stage: string }) => p.stage === "discover");
      expect(progress).toMatchObject({
        stage: "discover",
        status: "failed",
        workflowId: "discover-local",
        percent: 67,
        completed: 2,
        total: 3,
        currentStep: "Smart extract complete",
        message: "Workflow failed: Activity task failed",
        updatedAt: DISCOVER_FAILED_AT,
      });
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

  it("rejects opening an unregistered artifact id", async () => {
    const opened: string[] = [];
    const app = buildApp({
      ...options,
      artifactOpener: async (artifactPath) => {
        opened.push(artifactPath);
      },
    });
    try {
      const response = await app.inject({
        method: "POST",
        url: "/v1/artifacts/not-a-real-artifact/open",
      });
      expect(response.statusCode, response.body).toBe(404);
      expect(response.json()).toMatchObject({ ok: false, error: "artifact_not_found" });
      expect(opened).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("refuses to open an artifact whose path resolves outside the app directory", async () => {
    const opened: string[] = [];
    const isolatedAppDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-appdir-"));
    const app = buildApp({
      ...options,
      appDir: isolatedAppDir,
      artifactOpener: async (artifactPath) => {
        opened.push(artifactPath);
      },
    });
    try {
      const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_txt" });
      const artifact = listResponse.json().items[0];
      // The seeded artifact file lives under the default temp dir, which is
      // outside the isolated app directory configured for this app instance.
      const response = await app.inject({
        method: "POST",
        url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/open`,
      });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: "artifact_path_forbidden" });
      expect(opened).toEqual([]);
    } finally {
      await app.close();
      fs.rmSync(isolatedAppDir, { force: true, recursive: true });
    }
  });

  it("refuses to preview a PDF artifact whose path resolves outside the app directory", async () => {
    const isolatedAppDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-appdir-"));
    const app = buildApp({ ...options, appDir: isolatedAppDir });
    try {
      const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_pdf" });
      const artifact = listResponse.json().items[0];
      fs.writeFileSync(artifact.localPath, "%PDF test");
      const response = await app.inject({
        method: "GET",
        url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/preview.pdf`,
      });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: "artifact_path_forbidden" });
    } finally {
      await app.close();
      fs.rmSync(isolatedAppDir, { force: true, recursive: true });
    }
  });

  it("refuses to serve HTML preview for an artifact whose path resolves outside the app directory", async () => {
    const isolatedAppDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-appdir-"));
    const app = buildApp({ ...options, appDir: isolatedAppDir });
    try {
      const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_pdf" });
      const artifact = listResponse.json().items[0];
      fs.writeFileSync(artifact.localPath, "%PDF html-rendered escape test");
      const htmlPath = path.join(path.dirname(artifact.localPath), `${path.parse(artifact.localPath).name}.html`);
      fs.writeFileSync(htmlPath, '<!doctype html><main class="resume-page">Escape HTML preview</main>');
      const now = "2026-06-20T10:00:00+00:00";
      const db = new Database(options.dbPath);
      createMaterialsTables(db);
      db.prepare(
        `INSERT OR REPLACE INTO job_materials (
           tenant_id, job_id, generation, status, created_at, updated_at
         ) VALUES ('local', ?, 99, 'resume_approved', ?, ?)`,
      ).run(artifact.jobKey, now, now);
      db.prepare(
        `INSERT OR REPLACE INTO job_materials_artifacts (
           tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
           render_format, size_bytes, metadata_json, created_at
         ) VALUES ('local', ?, 99, 'resume_pdf', ?, 'approved', ?, 'html_pdf', ?, '{}', ?)`,
      ).run(artifact.jobKey, artifact.artifactId, artifact.localPath, fs.statSync(artifact.localPath).size, now);
      db.close();

      const response = await app.inject({
        method: "GET",
        url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/preview.html`,
      });

      expect(response.statusCode, response.body).toBe(403);
      expect(response.json()).toMatchObject({ ok: false, error: "artifact_path_forbidden" });
      expect(response.body).not.toContain("Escape HTML preview");
    } finally {
      await app.close();
      fs.rmSync(isolatedAppDir, { force: true, recursive: true });
    }
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
        jobKey: jobIdFor("https://example.com/jobs/ready"),
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

  it("serves the sibling HTML preview for an HTML-rendered resume PDF artifact", async () => {
    const app = buildApp(options);
    const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_pdf" });
    const artifact = listResponse.json().items[0];
    fs.writeFileSync(artifact.localPath, "%PDF html-rendered test");
    const htmlPath = path.join(path.dirname(artifact.localPath), `${path.parse(artifact.localPath).name}.html`);
    fs.writeFileSync(
      htmlPath,
      '<!doctype html><main class="resume-page"><h1 data-resume-layout-target="personal:full_name" data-resume-line-number="1">Jordan Candidate</h1></main>',
    );
    const now = "2026-06-20T10:00:00+00:00";
    const db = new Database(options.dbPath);
    createMaterialsTables(db);
    db.prepare(
      `INSERT OR REPLACE INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at
       ) VALUES ('local', ?, 99, 'resume_approved', ?, ?)`,
    ).run(artifact.jobKey, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
         render_format, size_bytes, metadata_json, created_at
       ) VALUES ('local', ?, 99, 'resume_pdf', ?, 'approved', ?, 'html_pdf', ?, '{}', ?)`,
    ).run(artifact.jobKey, artifact.artifactId, artifact.localPath, fs.statSync(artifact.localPath).size, now);
    db.close();

    const response = await app.inject({
      method: "GET",
      url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/preview.html`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("font-src data:");
    expect(response.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(response.body).toContain("Jordan Candidate");
    expect(response.body).toContain('data-resume-layout-target="personal:full_name"');

    await app.close();
  });

  it("serves sibling HTML preview for an exact artifact with HTML render metadata", async () => {
    const app = buildApp(options);
    const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_pdf" });
    const artifact = listResponse.json().items[0];
    fs.writeFileSync(artifact.localPath, "%PDF legacy html-rendered test");
    const htmlPath = path.join(path.dirname(artifact.localPath), `${path.parse(artifact.localPath).name}.html`);
    fs.writeFileSync(htmlPath, '<!doctype html><main class="resume-page">Legacy HTML preview</main>');
    const now = "2026-06-20T10:00:00+00:00";
    const db = new Database(options.dbPath);
    createMaterialsTables(db);
    db.prepare(
      `INSERT OR REPLACE INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at
       ) VALUES ('local', ?, 99, 'resume_approved', ?, ?)`,
    ).run(artifact.jobKey, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
         render_format, size_bytes, metadata_json, created_at
       ) VALUES ('local', ?, 99, 'resume_pdf', ?, 'approved', ?, 'html_pdf', ?, '{}', ?)`,
    ).run(artifact.jobKey, artifact.artifactId, artifact.localPath, fs.statSync(artifact.localPath).size, now);
    db.close();

    const response = await app.inject({
      method: "GET",
      url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/preview.html`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.body).toContain("Legacy HTML preview");

    await app.close();
  });

  it("rejects HTML preview for a legacy-rendered resume PDF artifact", async () => {
    const app = buildApp(options);
    const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_pdf" });
    const artifact = listResponse.json().items[0];
    fs.writeFileSync(artifact.localPath, "%PDF legacy test");
    const now = "2026-06-20T10:00:00+00:00";
    const db = new Database(options.dbPath);
    createMaterialsTables(db);
    db.prepare(
      `INSERT OR REPLACE INTO job_materials (
         tenant_id, job_id, generation, status, created_at, updated_at
       ) VALUES ('local', ?, 99, 'resume_approved', ?, ?)`,
    ).run(artifact.jobKey, now, now);
    db.prepare(
      `INSERT OR REPLACE INTO job_materials_artifacts (
         tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
         render_format, size_bytes, metadata_json, created_at
       ) VALUES ('local', ?, 99, 'resume_pdf', ?, 'approved', ?, 'latex_pdf', ?, '{}', ?)`,
    ).run(artifact.jobKey, artifact.artifactId, artifact.localPath, fs.statSync(artifact.localPath).size, now);
    db.close();

    const response = await app.inject({
      method: "GET",
      url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/preview.html`,
    });

    expect(response.statusCode, response.body).toBe(415);
    expect(response.json()).toMatchObject({
      ok: false,
      error: "artifact_preview_unsupported",
      message: "This artifact was not rendered through the HTML/CSS resume renderer.",
    });

    await app.close();
  });

  it("does not expose the retired Poppler-backed PDF page preview route", async () => {
    const app = buildApp(options);
    const listResponse = await app.inject({ method: "GET", url: "/v1/artifacts?type=tailored_resume_pdf" });
    const artifact = listResponse.json().items[0];
    fs.writeFileSync(artifact.localPath, "%PDF test");

    const response = await app.inject({
      method: "GET",
      url: `/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/preview/page/2.png`,
    });

    expect(response.statusCode, response.body).toBe(404);

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
    expect(job).toMatchObject({
      fit_score: 8,
      scored_at: "2026-04-29T10:02:00+00:00",
    });
    expect(event).toMatchObject({ stage: "score", level: "info", message: "Retry reset requested for score" });

    await app.close();
  });

  it("does not reset a retry stage when run-after requires an unavailable worker", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-ignored" }));
    const jobUrl = "https://example.com/jobs/blocked-tailor";
    const jobKey = encodeURIComponent(jobUrl);
    const readPersistedRetryState = () => {
      const db = new Database(options.dbPath);
      const stage = db
        .prepare(
          `SELECT state, attempt_count, updated_at, error_code, error_message,
                  retryable, blocked_by_json
             FROM job_stage_states
            WHERE tenant_id = 'local' AND job_id = ? AND stage = 'tailor'`,
        )
        .get(jobIdFor(jobUrl));
      const eventCount = db
        .prepare("SELECT COUNT(*) AS count FROM job_events WHERE tenant_id = 'local' AND job_id = ? AND stage = 'tailor'")
        .get(jobIdFor(jobUrl)) as { count: number };
      db.close();
      return { stage, eventCount: eventCount.count };
    };
    const before = readPersistedRetryState();
    const app = buildApp({
      ...options,
      actionDispatcher: dispatch,
      requireHealthyWorkerForActions: true,
    });

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/retry-stage`,
      payload: { stage: "tailor", runAfter: true, resetAttempts: true, dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toMatchObject({ ok: false, error: "worker_runtime_unavailable" });
    expect(readPersistedRetryState()).toEqual(before);
    expect(before.stage).toMatchObject({ state: "blocked", error_code: "MIN_SCORE" });
    expect(dispatch).not.toHaveBeenCalled();

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
      .prepare("SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'")
      .get(jobIdFor("https://example.com/jobs/failed-score")) as { state: string };
    const ready = db
      .prepare("SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'")
      .get(jobIdFor("https://example.com/jobs/ready")) as { state: string };
    const event = db
      .prepare("SELECT message FROM job_events WHERE tenant_id = 'local' AND job_id = ? ORDER BY event_id DESC LIMIT 1")
      .get(jobIdFor("https://example.com/jobs/failed-score")) as { message: string };
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
        jobIds: [jobIdFor("https://example.com/jobs/failed-score"), jobIdFor(secondFailedUrl)],
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
      .prepare("SELECT job_id, state FROM job_stage_states WHERE tenant_id = 'local' AND stage = 'score' AND job_id IN (?, ?) ORDER BY job_id")
      .all(jobIdFor("https://example.com/jobs/failed-score"), jobIdFor(secondFailedUrl)) as Array<{ job_id: string; state: string }>;
    const queuedEvents = db
      .prepare("SELECT job_id, event_type, payload_json FROM job_events WHERE tenant_id = 'local' AND event_type = 'StageQueued' ORDER BY job_id")
      .all() as Array<{ job_id: string; event_type: string; payload_json: string }>;
    db.close();

    expect(states).toEqual([
      { job_id: jobIdFor(secondFailedUrl), state: "queued" },
      { job_id: jobIdFor("https://example.com/jobs/failed-score"), state: "queued" },
    ].sort((left, right) => left.job_id.localeCompare(right.job_id)));
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
    seedDb.prepare(
      "UPDATE jobs SET full_description = ? WHERE tenant_id = 'local' AND job_id = ?",
    ).run(
      "Stale legacy description that must not override the canonical pending aggregate.",
      jobIdFor(pendingEnrichUrl),
    );
    seedDb.prepare(
      `INSERT INTO job_enrichments (
         tenant_id, job_id, current_status, full_description, application_url,
         enriched_at, extraction_tier, attempts_json, updated_at
       ) VALUES ('local', ?, 'pending', NULL, NULL, NULL, NULL, '[]', ?)`,
    ).run(jobIdFor(pendingEnrichUrl), "2026-08-05T23:15:00.000Z");
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
    insertEnrichment(seedDb, pendingScoreUrl);
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
    insertEnrichment(seedDb, pendingTailorUrl);
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
    insertEnrichment(seedDb, lowFitTailorUrl);
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
    insertEnrichment(seedDb, pendingApplyUrl);
    seedDb.close();
    const dispatch = vi.fn(async (command: ActionCommandPayload): Promise<ActionDispatchResult> => ({
      status: "queued",
      workflowId: `pending-${command.stage}-workflow`,
      runId: `pending-${command.stage}-workflow`,
      firstExecutionRunId: `pending-${command.stage}-execution`,
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
        jobIds: [jobIdFor(pendingEnrichUrl)],
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
        jobIds: [jobIdFor(pendingScoreUrl)],
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
        jobIds: [jobIdFor(pendingTailorUrl)],
        stage: "tailor",
        stages: ["tailor", "cover"],
        workers: 14,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    const db = new Database(options.dbPath);
    const queuedStates = db
      .prepare(
        `SELECT job_id, stage, state FROM job_stage_states
         WHERE tenant_id = 'local' AND job_id IN (?, ?, ?) AND state = 'queued'
         ORDER BY job_id`,
      )
      .all(jobIdFor(pendingEnrichUrl), jobIdFor(pendingScoreUrl), jobIdFor(pendingTailorUrl)) as Array<{
        job_id: string;
        stage: string;
        state: string;
      }>;
    const failed = db
      .prepare("SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'")
      .get(jobIdFor("https://example.com/jobs/failed-score")) as { state: string };
    const apply = db
      .prepare("SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'apply'")
      .get(jobIdFor(pendingApplyUrl)) as { state: string };
    const queuedEvent = db
      .prepare("SELECT payload_json FROM job_events WHERE tenant_id = 'local' AND event_type = 'StageQueued' AND job_id = ?")
      .get(jobIdFor(pendingScoreUrl)) as { payload_json: string };
    const enrichOwner = db
      .prepare(
        `SELECT metadata_json FROM job_stage_states
         WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
      )
      .get(jobIdFor(pendingEnrichUrl)) as { metadata_json: string };
    db.close();

    expect(queuedStates).toEqual([
      { job_id: jobIdFor(pendingEnrichUrl), stage: "enrich", state: "queued" },
      { job_id: jobIdFor(pendingScoreUrl), stage: "score", state: "queued" },
      { job_id: jobIdFor(pendingTailorUrl), stage: "tailor", state: "queued" },
    ].sort((left, right) => left.job_id.localeCompare(right.job_id)));
    expect(failed.state).toBe("failed");
    expect(apply.state).toBe("pending");
    expect(JSON.parse(queuedEvent.payload_json)).toMatchObject({
      source: "bulk_run_pending_preparation",
      workflowId: "pending-score-workflow",
      runId: "pending-score-execution",
      requestedWorkers: 14,
    });
    expect(JSON.parse(enrichOwner.metadata_json)).toEqual({
      workflowId: "pending-enrich-workflow",
      temporalRunId: "pending-enrich-execution",
    });

    const repeatedResponse = await app.inject({
      method: "POST",
      url: "/v1/jobs/bulk-run-pending-preparation",
      payload: {
        allMatching: false,
        jobKeys: [pendingEnrichUrl],
        workers: 14,
        minScore: 7,
        validationMode: "normal",
        dryRun: false,
      },
    });
    expect(repeatedResponse.statusCode, repeatedResponse.body).toBe(200);
    expect(repeatedResponse.json()).toMatchObject({
      ok: true,
      count: 0,
      jobKeys: [],
      stageCounts: {},
      status: "accepted",
      actions: [],
    });
    expect(dispatch).toHaveBeenCalledTimes(3);

    const repeatedDb = new Database(options.dbPath);
    const repeatedStates = repeatedDb
      .prepare(
        `SELECT
           (SELECT state FROM job_stage_states
             WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich') AS enrich_state,
           COALESCE((SELECT state FROM job_stage_states
             WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'), 'pending') AS score_state`,
      )
      .get(jobIdFor(pendingEnrichUrl), jobIdFor(pendingEnrichUrl)) as {
      enrich_state: string;
      score_state: string;
    };
    repeatedDb.close();
    expect(repeatedStates).toEqual({ enrich_state: "queued", score_state: "pending" });

    await app.close();
  });

  it("skips non-retryable failed stages in the bulk retry action", async () => {
    const seedDb = new Database(options.dbPath);
    seedDb
      .prepare(
        `INSERT INTO job_events (
           tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
         ) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?`,
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
      .prepare("SELECT state, retryable FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'score'")
      .get(jobIdFor("https://example.com/jobs/failed-score")) as { state: string; retryable: number };
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
        "UPDATE job_stage_states SET retryable = 0 WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'",
      )
      .run(jobIdFor(jobUrl));
    seedDb
      .prepare(
        `INSERT INTO job_events (
           tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
         ) SELECT 'local', (SELECT job_id FROM jobs WHERE tenant_id = 'local' AND url = ?), 1, ?, ?, ?, ?, ?, ?`,
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
      .prepare("SELECT state FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'")
      .get(jobIdFor(jobUrl)) as { state: string };
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
         job_id, tenant_id, current_status, full_description,
         application_url, enriched_at, extraction_tier,
         attempts_json, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      jobIdFor("https://example.com/jobs/failed-score"),
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
    seedDb.prepare(
      `UPDATE job_stage_states
          SET state = 'canceled', metadata_json = ?
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).run(
      JSON.stringify({
        workflowId: "workflow-canceled-enrich",
        temporalRunId: "run-canceled-enrich",
      }),
      jobIdFor("https://example.com/jobs/failed-score"),
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
         FROM job_enrichments WHERE tenant_id = 'local' AND job_id = ?`,
      )
      .get(jobIdFor("https://example.com/jobs/failed-score")) as {
      current_status: string;
      full_description: string | null;
      application_url: string | null;
      enriched_at: string | null;
      extraction_tier: string | null;
    };
    const stage = db
      .prepare(
        `SELECT state, metadata_json FROM job_stage_states
          WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
      )
      .get(jobIdFor("https://example.com/jobs/failed-score")) as {
      state: string;
      metadata_json: string | null;
    };
    // Retired wide columns remain untouched; exact-v7 state lives in the
    // canonical enrichment aggregate and stage rows.
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
    expect(stage).toEqual({ state: "pending", metadata_json: null });
    expect(legacyJob.detail_scraped_at).toBe("2026-04-29T10:01:00+00:00");
    expect(legacyJob.detail_error).toBeNull();

    await app.close();
  });

  it("retry-enrich is a no-op when no job_enrichments row exists", async () => {
    // Confirm ``resetEnrichmentAggregate`` doesn't crash when the
    // aggregate row was never written. Exact-v7 reset is a 0-row aggregate
    // update and never falls back to retired wide job columns.
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
      .prepare("SELECT COUNT(*) AS c FROM job_enrichments WHERE tenant_id = 'local' AND job_id = ?")
      .get(jobIdFor("https://example.com/jobs/blocked-tailor")) as { c: number };
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
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
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
        jobKey: jobIdFor("https://example.com/jobs/failed-score"),
        jobId: jobIdFor("https://example.com/jobs/failed-score"),
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
    insertEnrichment(db, "https://example.com/jobs/pending-score");
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
        jobKey: jobIdFor("https://example.com/jobs/pending-score"),
        jobId: jobIdFor("https://example.com/jobs/pending-score"),
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
    insertEnrichment(db, "https://example.com/jobs/low-fit-tailor");
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
      jobKey: jobIdFor("https://example.com/jobs/low-fit-tailor"),
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
      jobKey: jobIdFor("https://example.com/jobs/ready"),
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
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

  it("dispatches explicit interview prep generation without running pipeline stages", async () => {
    const dispatch = vi.fn(async (_command: unknown, _context: unknown) => ({
      status: "queued",
      actionId: "act-prep",
      runId: "run-prep",
      workflowId: "workflow-prep",
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/ready");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/generate-interview-prep`,
      payload: { llmModel: "gpt-test" },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "generate_interview_prep",
      status: "queued",
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      workflowId: "workflow-prep",
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "generate_interview_prep",
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
        llmModel: "gpt-test",
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch.mock.calls[0]?.[0]).not.toMatchObject({ action: "run_stage" });

    await app.close();
  });

  it("rejects interview prep generation for missing jobs", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-test" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const jobKey = encodeURIComponent("https://example.com/jobs/missing");

    const response = await app.inject({
      method: "POST",
      url: `/v1/jobs/${jobKey}/actions/generate-interview-prep`,
      payload: {},
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toMatchObject({ ok: false, error: "job_not_found" });
    expect(dispatch).not.toHaveBeenCalled();

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
      expect.objectContaining({
        action: "apply",
        dryRun: true,
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
      }),
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
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
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
        jobIds: [jobIdFor("https://example.com/jobs/failed-score")],
        limit: 10,
        dryRun: true,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        action: "tailor_job",
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
        dryRun: true,
        reason: "manual low-fit override",
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      4,
      expect.objectContaining({
        action: "retailor_job",
        jobKey: jobIdFor("https://example.com/jobs/ready"),
        jobId: jobIdFor("https://example.com/jobs/ready"),
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
        jobIds: [jobIdFor("https://example.com/jobs/ready")],
        limit: 5,
        dryRun: false,
        suppressExistingArtifacts: true,
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );
    const db = new Database(options.dbPath);
    try {
      const events = db
        .prepare("SELECT event_type FROM job_events WHERE tenant_id = 'local' AND job_id = ? ORDER BY event_id DESC")
        .all(jobIdFor("https://example.com/jobs/ready"))
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

  it("dispatches source-scoped Discover stage runs", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: {
        stages: ["discover"],
        limit: 25,
        workers: 2,
        dryRun: false,
        sourceIds: ["jobspy:linkedin"],
      },
    });

    expect(response.statusCode, response.body).toBe(202);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "run_stage",
      status: "queued",
      command: {
        stages: ["discover"],
        limit: 25,
        workers: 2,
        dryRun: false,
        sourceIds: ["jobspy:linkedin"],
      },
      actions: [
        {
          command: expect.objectContaining({
            action: "run_stage",
            stage: "discover",
            sourceIds: ["jobspy:linkedin"],
          }),
        },
      ],
    });
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "run_stage",
        stage: "discover",
        stages: ["discover"],
        sourceIds: ["jobspy:linkedin"],
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("requests in-flight workflow cancellation idempotently without synthetic terminal events", async () => {
    const db = new Database(options.dbPath);
    try {
      insertPipelineWorkflowEvent(db, {
        eventType: "WorkflowStarted",
        occurredAt: "2026-04-29T10:20:00+00:00",
        workflowId: "workflow-run-1",
        temporalRunId: "temporal-run-1",
        startedAt: "2026-04-29T10:20:00+00:00",
        inputSummary: { runId: "discovery:jobspy:run-1", stage: "discover" },
      });
      insertDiscoverWorkflowRunRow(db, {
        workflowId: "workflow-run-1",
        status: "in_progress",
        startedAt: "2026-04-29T10:20:00+00:00",
        temporalRunId: "temporal-run-1",
        inputSummary: { runId: "discovery:jobspy:run-1", stage: "discover" },
      });
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
      status: "canceling",
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/workflow-runs/workflow-run-1/actions/cancel",
    });
    const replay = await app.inject({
      method: "POST",
      url: "/v1/workflow-runs/workflow-run-1/actions/cancel",
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      action: "cancel",
      status: "canceling",
      jobKey: "pipeline",
      runId: "workflow-run-1",
      command: {
        action: "cancel",
        jobKey: "pipeline",
        runId: "workflow-run-1",
      },
    });
    expect(replay.statusCode, replay.body).toBe(200);
    expect(replay.json()).toMatchObject({ status: "canceling", runId: "workflow-run-1" });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        action: "cancel",
        jobKey: "pipeline",
        runId: "workflow-run-1",
      }),
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
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
        status: "running",
        failed_at: null,
        updated_at: "2026-04-29T10:20:00+00:00",
      });
      expect(JSON.parse(row?.error_classes_json ?? "[]")).toEqual([]);
      expect(JSON.parse(row?.progress_json ?? "{}")).toEqual({ completed: 0, total: 72, unit: "searches" });
      const syntheticEvents = verifyDb.prepare(
        `SELECT COUNT(*) AS count
           FROM job_events
          WHERE event_type IN ('StageFailed', 'DiscoveryRunFailed', 'WorkflowCanceled')
            AND payload_json LIKE '%workflow-run-1%'`,
      ).get() as { count: number };
      expect(syntheticEvents.count).toBe(0);
    } finally {
      verifyDb.close();
    }

    await app.close();
  });

  it("preserves preparation and Apply state across repeated cancellation and terminal refresh", async () => {
    const jobId = jobIdFor("https://example.com/jobs/ready");
    const db = new Database(options.dbPath);
    insertDiscoverWorkflowRunRow(db, {
      workflowId: "prepare-active",
      workflowType: "JobPreparationWorkflow",
      status: "in_progress",
      startedAt: "2026-04-29T10:21:00+00:00",
      temporalRunId: "temporal-prepare-active",
      inputSummary: { jobId, steps: ["tailor", "cover"] },
    });
    insertDiscoverWorkflowRunRow(db, {
      workflowId: "apply-active",
      workflowType: "ApplyWorkflow",
      status: "in_progress",
      startedAt: "2026-04-29T10:22:00+00:00",
      temporalRunId: "temporal-apply-active",
      inputSummary: { jobId, dryRun: true },
    });
    db.prepare(
      `INSERT INTO apply_run_projections (
         run_id, job_id, job_title, job_employer, status, result, dry_run, started_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "apply-active",
      jobId,
      "Platform Engineer",
      "ExampleCo",
      "in_progress",
      null,
      1,
      "2026-04-29T10:22:00+00:00",
    );
    const eventCount = (db.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count;
    db.close();

    const dispatch = vi.fn(async (command: { runId?: string }) => ({
      runId: command.runId ?? "",
      status: "canceling",
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    for (const runId of ["prepare-active", "apply-active"]) {
      const first = await app.inject({
        method: "POST",
        url: `/v1/workflow-runs/${runId}/actions/cancel`,
      });
      const replay = await app.inject({
        method: "POST",
        url: `/v1/workflow-runs/${runId}/actions/cancel`,
      });
      expect(first.statusCode, first.body).toBe(200);
      expect(first.json()).toMatchObject({
        action: "cancel",
        status: "canceling",
        jobKey: jobId,
        runId,
      });
      expect(replay.json()).toMatchObject({ status: "canceling", runId });
      const activeDetail = await app.inject({ method: "GET", url: `/v1/workflow-runs/${runId}` });
      expect(activeDetail.json()).toMatchObject({
        jobKey: jobId,
        status: "in_progress",
      });
    }
    expect(dispatch).toHaveBeenCalledTimes(4);

    const terminalDb = new Database(options.dbPath);
    terminalDb.prepare(
      `UPDATE workflow_run_projections
          SET status = 'canceled', finished_at = ?, events_json = ?
        WHERE workflow_id IN ('prepare-active', 'apply-active')`,
    ).run(
      "2026-04-29T10:23:00+00:00",
      JSON.stringify([
        {
          eventType: "WorkflowCanceled",
          occurredAt: "2026-04-29T10:23:00+00:00",
          status: "canceled",
          message: "Workflow canceled by request.",
        },
      ]),
    );
    terminalDb.prepare(
      "UPDATE apply_run_projections SET status = 'canceled', result = 'canceled', finished_at = ? WHERE run_id = ?",
    ).run("2026-04-29T10:23:00+00:00", "apply-active");
    terminalDb.close();

    for (const runId of ["prepare-active", "apply-active"]) {
      const terminal = await app.inject({
        method: "POST",
        url: `/v1/workflow-runs/${runId}/actions/cancel`,
      });
      expect(terminal.statusCode, terminal.body).toBe(200);
      expect(terminal.json()).toMatchObject({
        status: "already_terminal",
        jobKey: jobId,
        runId,
        result: { status: "canceled" },
      });
      const terminalDetail = await app.inject({ method: "GET", url: `/v1/workflow-runs/${runId}` });
      expect(terminalDetail.json()).toMatchObject({
        jobKey: jobId,
        status: "canceled",
        events: [{ eventType: "WorkflowCanceled", status: "canceled" }],
      });
    }
    expect(dispatch).toHaveBeenCalledTimes(4);
    const verifyDb = new Database(options.dbPath);
    expect((verifyDb.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(
      eventCount,
    );
    verifyDb.close();
    await app.close();
  });

  it("preserves an already-terminal Apply result before the worker gate without writes", async () => {
    const db = new Database(options.dbPath);
    const eventCount = (db.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count;
    db.close();
    const dispatch = vi.fn(async () => ({ status: "canceling" }));
    const app = buildApp({
      ...options,
      actionDispatcher: dispatch,
      requireHealthyWorkerForActions: true,
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/workflow-runs/run-1/actions/cancel",
    });
    const detail = await app.inject({ method: "GET", url: "/v1/workflow-runs/run-1" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      status: "already_terminal",
      jobKey: jobIdFor("https://example.com/jobs/ready"),
      runId: "run-1",
      result: { status: "succeeded", result: "succeeded" },
    });
    expect(detail.statusCode, detail.body).toBe(200);
    expect(detail.json()).toMatchObject({
      runId: "run-1",
      status: "succeeded",
      result: "succeeded",
    });
    expect(dispatch).not.toHaveBeenCalled();
    const verifyDb = new Database(options.dbPath);
    expect((verifyDb.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(
      eventCount,
    );
    verifyDb.close();
    await app.close();
  });

  it("does not mutate an active workflow when the worker is unavailable and rejects unknown runs", async () => {
    const db = new Database(options.dbPath);
    insertPipelineWorkflowEvent(db, {
      eventType: "WorkflowStarted",
      occurredAt: "2026-04-29T10:20:00+00:00",
      workflowId: "workflow-run-unavailable",
      temporalRunId: "temporal-run-unavailable",
      startedAt: "2026-04-29T10:20:00+00:00",
    });
    insertDiscoverWorkflowRunRow(db, {
      workflowId: "workflow-run-unavailable",
      status: "in_progress",
      startedAt: "2026-04-29T10:20:00+00:00",
      temporalRunId: "temporal-run-unavailable",
    });
    const eventCount = (db.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count;
    db.close();
    const dispatch = vi.fn(async () => ({ status: "canceling" }));
    const app = buildApp({
      ...options,
      actionDispatcher: dispatch,
      requireHealthyWorkerForActions: true,
    });

    const unavailable = await app.inject({
      method: "POST",
      url: "/v1/workflow-runs/workflow-run-unavailable/actions/cancel",
    });
    const unknown = await app.inject({
      method: "POST",
      url: "/v1/workflow-runs/workflow-run-missing/actions/cancel",
    });

    expect(unavailable.statusCode, unavailable.body).toBe(503);
    expect(unavailable.json()).toMatchObject({ ok: false, error: "worker_runtime_unavailable" });
    expect(unknown.statusCode, unknown.body).toBe(404);
    expect(unknown.json()).toMatchObject({ ok: false, error: "workflow_run_not_found" });
    expect(dispatch).not.toHaveBeenCalled();
    const verifyDb = new Database(options.dbPath);
    expect((verifyDb.prepare("SELECT COUNT(*) AS count FROM job_events").get() as { count: number }).count).toBe(
      eventCount,
    );
    verifyDb.close();
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

    const db = new Database(options.dbPath);
    const started = db
      .prepare(
        `SELECT payload_json FROM job_events
         WHERE tenant_id = 'local' AND event_type = 'StageStarted'
           AND json_extract(payload_json, '$.workflowId') = 'pipeline-wf'
         ORDER BY event_id DESC LIMIT 1`,
      )
      .get() as { payload_json: string };
    db.close();
    expect(JSON.parse(started.payload_json)).toMatchObject({
      workflowId: "pipeline-wf",
      runId: "first-exec-run-id",
    });

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
        templateText: INERT_RESUME_TEMPLATE,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      profile: { personal: { full_name: "Taylor Updated" } },
      style: { moderncv_style: "classic" },
      templateText: INERT_RESUME_TEMPLATE,
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
        resume_template_text: INERT_RESUME_TEMPLATE,
      });
      expect(db.prepare("SELECT COUNT(*) AS count FROM candidate_profile_experience_bullets").get()).toMatchObject({
        count: 1,
      });
    } finally {
      db.close();
    }

    await app.close();
  });

  it("persists typed application attestations through relational profile storage", async () => {
    const app = buildApp(options);
    const profile = validProfileFixture("Attestation Candidate");
    profile.application_attestations = {
      age_18_plus: true,
      background_check_consent: null,
      felony_conviction: false,
      previously_worked_at_employer: null,
      additional: { can_travel: "occasionally", requires_clearance: null },
    };
    profile.application_preferences = { how_heard: "Referral" };

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });

    expect(response.statusCode, response.body).toBe(200);
    const db = new Database(options.dbPath);
    try {
      expect(
        db.prepare(
          `SELECT application_attestation_age_18_plus,
                  application_attestation_background_check_consent,
                  application_attestation_felony_conviction,
                  application_attestation_previously_worked_at_employer,
                  application_attestation_additional_json,
                  application_preference_how_heard
             FROM candidate_profiles`,
        ).get(),
      ).toMatchObject({
        application_attestation_age_18_plus: 1,
        application_attestation_background_check_consent: null,
        application_attestation_felony_conviction: 0,
        application_attestation_previously_worked_at_employer: null,
        application_attestation_additional_json: JSON.stringify({
          can_travel: "occasionally",
          requires_clearance: null,
        }),
        application_preference_how_heard: "Referral",
      });
    } finally {
      db.close();
    }

    const stored = await app.inject({ method: "GET", url: "/v1/profile" });
    expect(stored.statusCode, stored.body).toBe(200);
    expect(stored.json().profile).toMatchObject({
      application_attestations: {
        age_18_plus: true,
        background_check_consent: null,
        felony_conviction: false,
        previously_worked_at_employer: null,
        additional: { can_travel: "occasionally", requires_clearance: null },
      },
      application_preferences: { how_heard: "Referral" },
    });

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

  it("materializes profile achievement evidence from bullets when explicit evidence is absent", async () => {
    const app = buildApp(options);
    const profile = validProfileFixture("Bullet Evidence Candidate");
    const resume = profile.resume as Record<string, unknown>;
    const entries = resume.experience_entries as Array<Record<string, unknown>>;
    entries[0]!.bullets = ["Reduced incidents 40% by hardening service ownership."];

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.profile.resume.experience_entries[0].achievement_evidence).toEqual([
      expect.objectContaining({
        id: "role_1_bullet_1",
        source_text: "Reduced incidents 40% by hardening service ownership.",
        metrics: ["40%"],
        evidence_strength: "supported",
        claim_confidence: 0.8,
        user_confirmed: true,
      }),
    ]);

    const db = new Database(options.dbPath);
    try {
      expect(db.prepare("SELECT COUNT(*) AS count FROM candidate_profile_achievement_evidence").get()).toMatchObject({
        count: 1,
      });
      expect(
        db.prepare("SELECT evidence_id, source_text, metrics_json FROM candidate_profile_achievement_evidence").get(),
      ).toMatchObject({
        evidence_id: "role_1_bullet_1",
        source_text: "Reduced incidents 40% by hardening service ownership.",
        metrics_json: '["40%"]',
      });
      db.prepare("DELETE FROM candidate_profile_achievement_evidence").run();
    } finally {
      db.close();
    }

    const repaired = await app.inject({ method: "GET", url: "/v1/profile" });
    expect(repaired.statusCode, repaired.body).toBe(200);
    expect(repaired.json().profile.resume.experience_entries[0].achievement_evidence).toEqual([
      expect.objectContaining({
        id: "role_1_bullet_1",
        source_text: "Reduced incidents 40% by hardening service ownership.",
        metrics: ["40%"],
      }),
    ]);

    await app.close();
  });

  it("rederives materialized bullet evidence when a profile bullet changes", async () => {
    const app = buildApp(options);
    const profile = validProfileFixture("Updated Bullet Evidence Candidate");
    const resume = profile.resume as Record<string, unknown>;
    const entries = resume.experience_entries as Array<Record<string, unknown>>;
    entries[0]!.bullets = ["Reduced incidents 40% by hardening service ownership."];

    const initial = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });

    expect(initial.statusCode, initial.body).toBe(200);
    const materializedProfile = initial.json().profile as Record<string, unknown>;
    const materializedResume = materializedProfile.resume as Record<string, unknown>;
    const materializedEntries = materializedResume.experience_entries as Array<Record<string, unknown>>;
    materializedEntries[0]!.bullets = ["Reduced incidents 55% by hardening service ownership."];

    const updated = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile: materializedProfile },
    });

    expect(updated.statusCode, updated.body).toBe(200);
    expect(updated.json().profile.resume.experience_entries[0].achievement_evidence).toEqual([
      expect.objectContaining({
        id: "role_1_bullet_1",
        source_text: "Reduced incidents 55% by hardening service ownership.",
        metrics: ["55%"],
      }),
    ]);

    const db = new Database(options.dbPath);
    try {
      expect(
        db.prepare("SELECT evidence_id, source_text, metrics_json FROM candidate_profile_achievement_evidence").get(),
      ).toMatchObject({
        evidence_id: "role_1_bullet_1",
        source_text: "Reduced incidents 55% by hardening service ownership.",
        metrics_json: '["55%"]',
      });
    } finally {
      db.close();
    }

    await app.close();
  });

  it("keeps explicit claim policy when legacy strict mode is present", async () => {
    const app = buildApp(options);
    const profile = validProfileFixture("Explicit Claim Policy Candidate");
    const resume = profile.resume as Record<string, unknown>;
    resume.tailoring_rules = {
      tailoring_policy: {
        mode: "strict",
        allow_title_reframing: true,
        allow_summary_rewrite: true,
        allow_achievement_rewriting: true,
        allow_skill_reordering: true,
        allow_minor_inference: true,
        claim_mode: "draft_requires_confirmation",
        auto_approvable_claim_modes: ["verified_only", "draft_requires_confirmation"],
        allow_adjacent_achievement_drafts: false,
      },
      revision_gates: {
        min_fit_score: 9,
        must_have_coverage: 0.9,
        max_revision_attempts: 2,
      },
    };

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.profile.resume.tailoring_rules.tailoring_policy).toMatchObject({
      mode: "strict",
      allow_title_reframing: false,
      allow_summary_rewrite: true,
      allow_achievement_rewriting: true,
      allow_skill_reordering: true,
      allow_minor_inference: true,
      claim_mode: "draft_requires_confirmation",
      auto_approvable_claim_modes: ["verified_only"],
      allow_adjacent_achievement_drafts: true,
    });
    expect(body.profile.resume.tailoring_rules.revision_gates).toMatchObject({
      min_fit_score: 9,
      must_have_coverage: 0.9,
      max_revision_attempts: 2,
    });

    const db = new Database(options.dbPath);
    try {
      expect(
        db.prepare(
          "SELECT tailoring_claim_mode, tailoring_auto_approvable_claim_modes_json, "
            + "tailoring_allow_adjacent_achievement_drafts, revision_min_fit_score, "
            + "revision_must_have_coverage, revision_max_attempts FROM candidate_profiles",
        ).get(),
      ).toMatchObject({
        tailoring_claim_mode: "draft_requires_confirmation",
        tailoring_auto_approvable_claim_modes_json: '["verified_only"]',
        tailoring_allow_adjacent_achievement_drafts: 1,
        revision_min_fit_score: 9,
        revision_must_have_coverage: 0.9,
        revision_max_attempts: 2,
      });
    } finally {
      db.close();
    }

    await app.close();
  });

  it("validates target-search locations before saving profile preferences", async () => {
    const placeValidator = vi.fn(async (place: string) => place === "Austin, TX");
    const app = buildApp({ ...options, placeValidator });
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: profileWithTargetSearch("Location Target", "Austin, TX", "Remote"),
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(placeValidator).toHaveBeenCalledWith("Austin, TX");
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
        experience_target_locations: "Austin, TX",
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

  it("records profile updates and resumes preparation without requiring an existing resume", async () => {
    const dispatch = vi.fn(async (_command: ActionCommandPayload): Promise<ActionDispatchResult> => ({
      status: "queued",
      runId: "run-retailor",
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile: validProfileFixture("Event Driven Candidate") },
    });

    expect(response.statusCode, response.body).toBe(200);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "pipeline",
        stage: "score",
        stages: ["score", "tailor", "cover"],
        dryRun: false,
        limit: 0,
        minScore: 6,
        retailor: true,
      }),
      { appDir: tempDir, configPath: options.configPath, dbPath: options.dbPath },
    );
    expect(dispatch.mock.calls[0]?.[0].rescore).toBeUndefined();

    const db = new Database(options.dbPath);
    try {
      const event = db
        .prepare(
          "SELECT job_id, stage, event_type, payload_json FROM job_events WHERE event_type = 'ProfileUpdated' ORDER BY event_id DESC LIMIT 1",
        )
        .get() as { job_id: string | null; stage: string | null; event_type: string; payload_json: string };
      expect(event).toMatchObject({
        job_id: null,
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

  it("does not redispatch preparation when a form resubmits the unchanged profile", async () => {
    const dispatch = vi.fn(async (): Promise<ActionDispatchResult> => ({ status: "queued" }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const profile = validProfileFixture("Unchanged Candidate");

    const first = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });
    expect(first.statusCode, first.body).toBe(200);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));

    const beforeDb = new Database(options.dbPath);
    const before = beforeDb.prepare(
      "SELECT version FROM candidate_profiles WHERE tenant_id = 'local' AND profile_id = 'default'",
    ).get() as { version: number };
    beforeDb.close();
    dispatch.mockClear();

    const repeated = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });

    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(dispatch).not.toHaveBeenCalled();
    const db = new Database(options.dbPath);
    try {
      expect(db.prepare(
        "SELECT version FROM candidate_profiles WHERE tenant_id = 'local' AND profile_id = 'default'",
      ).get()).toEqual(before);
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'ProfileUpdated'",
      ).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }

    await app.close();
  });

  it("rolls back the profile mutation when its durable continuation event cannot commit", async () => {
    const db = new Database(options.dbPath);
    expect(() => persistProfileUpdate(
      db,
      { profile: validProfileFixture("Atomic Candidate") },
      () => {
        throw new Error("profile outbox unavailable");
      },
    )).toThrow("profile outbox unavailable");
    db.close();

    const verifyDb = new Database(options.dbPath, { readonly: true });
    try {
      expect(verifyDb.prepare(
        "SELECT COUNT(*) AS count FROM candidate_profiles WHERE tenant_id = 'local' AND profile_id = 'default'",
      ).get()).toEqual({ count: 0 });
      expect(verifyDb.prepare(
        "SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'ProfileUpdated'",
      ).get()).toEqual({ count: 0 });
    } finally {
      verifyDb.close();
    }

  });

  it("coalesces concurrent identical profile saves into one version and continuation", async () => {
    const dispatched = deferred<ActionDispatchResult>();
    const dispatch = vi.fn<ActionDispatcher>(() => dispatched.promise);
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const profile = validProfileFixture("Concurrent Candidate");
    const save = () => app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: { profile },
    });

    const responses = Promise.all([save(), save()]);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    dispatched.resolve({ status: "queued", runId: "run-concurrent-profile" });
    expect((await responses).map((response) => response.statusCode)).toEqual([200, 200]);
    expect(dispatch).toHaveBeenCalledTimes(1);

    const db = new Database(options.dbPath);
    try {
      expect(db.prepare(
        "SELECT version FROM candidate_profiles WHERE tenant_id = 'local' AND profile_id = 'default'",
      ).get()).toEqual({ version: 1 });
      expect(db.prepare(
        "SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'ProfileUpdated'",
      ).get()).toEqual({ count: 1 });
    } finally {
      db.close();
    }

    await app.close();
  });

  it("coalesces simultaneous genuine profile revisions into the newest durable continuation", async () => {
    const dispatched = deferred<ActionDispatchResult>();
    const dispatch = vi.fn<ActionDispatcher>(() => dispatched.promise);
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const responses = Promise.all([
      app.inject({
        method: "PATCH",
        url: "/v1/profile",
        payload: { profile: validProfileFixture("Concurrent Candidate A") },
      }),
      app.inject({
        method: "PATCH",
        url: "/v1/profile",
        payload: { profile: validProfileFixture("Concurrent Candidate B") },
      }),
    ]);

    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const pendingDb = new Database(options.dbPath, { readonly: true });
    const events = pendingDb.prepare(
      "SELECT event_id FROM job_events WHERE event_type = 'ProfileUpdated' ORDER BY event_id",
    ).all() as Array<{ event_id: number }>;
    pendingDb.close();
    expect(events).toHaveLength(2);
    expect(dispatch.mock.calls[0]?.[0].reason).toBe(
      `profile_updated:${events[1]?.event_id}`,
    );

    dispatched.resolve({ status: "queued", runId: "run-latest-profile" });
    expect((await responses).map((response) => response.statusCode)).toEqual([200, 200]);
    await vi.waitFor(() => {
      const db = new Database(options.dbPath, { readonly: true });
      const row = db.prepare(
        "SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'ProfileContinuationHandled'",
      ).get() as { count: number };
      db.close();
      expect(row.count).toBe(2);
    });
    expect(dispatch).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("recovers an unacknowledged profile continuation on API startup", async () => {
    const db = new Database(options.dbPath);
    const inserted = db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level,
         message, occurred_at, payload_json
       ) VALUES ('local', NULL, 1, NULL, 'ProfileUpdated', 'info', ?, ?, ?)`,
    ).run(
      "Candidate profile updated.",
      "2026-08-04T20:00:00.000Z",
      JSON.stringify({
        tenantId: "local",
        changedSections: ["profile"],
        updatedAt: "2026-08-04T20:00:00.000Z",
      }),
    );
    db.close();

    const providerDispatcher: JsonRpcDispatcher = {
      call: vi.fn(async () => ({
        jsonrpc: "2.0" as const,
        id: 1,
        result: { capabilities: [], detectedBrowsers: [] },
      })),
      close: vi.fn(async () => undefined),
    };
    const dispatched = deferred<ActionDispatchResult>();
    const dispatch = vi.fn<ActionDispatcher>(() => dispatched.promise);
    const app = buildApp({ ...options, providerDispatcher, actionDispatcher: dispatch });

    await app.listen({ host: "127.0.0.1", port: 0 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls[0]?.[0].reason).toBe(
      `profile_updated:${Number(inserted.lastInsertRowid)}`,
    );
    dispatched.resolve({ status: "queued", runId: "run-startup-profile" });
    await vi.waitFor(() => {
      const handledDb = new Database(options.dbPath, { readonly: true });
      const row = handledDb.prepare(
        "SELECT COUNT(*) AS count FROM job_events WHERE idempotency_key = ?",
      ).get(`profile-continuation-handled:${Number(inserted.lastInsertRowid)}`) as { count: number };
      handledDb.close();
      expect(row.count).toBe(1);
    });

    await app.close();
  });

  it("does not launch startup continuations before the health-only database exists", async () => {
    fs.rmSync(options.dbPath, { force: true });
    const providerCall = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: { capabilities: [], detectedBrowsers: [] },
    }));
    const dispatch = vi.fn<ActionDispatcher>(async () => ({
      status: "queued",
      runId: "run-missing-database",
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: {
        call: providerCall,
        close: vi.fn(async () => undefined),
      },
      actionDispatcher: dispatch,
    });

    await app.listen({ host: "127.0.0.1", port: 0 });

    expect(providerCall).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    const health = await app.inject({ method: "GET", url: "/v1/health" });
    expect(health.statusCode, health.body).toBe(200);
    expect(health.json()).toMatchObject({ dbExists: false, dbPath: options.dbPath });

    await app.close();
  });

  it("reattaches an intended older profile continuation before dispatching a newer revision", async () => {
    const db = new Database(options.dbPath);
    const insertProfileEvent = db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level,
         message, occurred_at, payload_json
       ) VALUES ('local', NULL, 1, NULL, 'ProfileUpdated', 'info', ?, ?, ?)`,
    );
    const first = insertProfileEvent.run(
      "Candidate profile updated.",
      "2026-08-04T20:00:00.000Z",
      JSON.stringify({ tenantId: "local", changedSections: ["profile"], updatedAt: "2026-08-04T20:00:00.000Z" }),
    );
    const second = insertProfileEvent.run(
      "Candidate profile updated.",
      "2026-08-04T20:00:01.000Z",
      JSON.stringify({ tenantId: "local", changedSections: ["profile"], updatedAt: "2026-08-04T20:00:01.000Z" }),
    );
    const firstEventId = Number(first.lastInsertRowid);
    const secondEventId = Number(second.lastInsertRowid);
    db.prepare(
      `INSERT INTO job_events (
         tenant_id, job_id, identity_version, stage, event_type, level,
         message, occurred_at, payload_json, idempotency_key
       ) VALUES ('local', NULL, 1, NULL, 'ProfileContinuationDispatchIntended', 'info', ?, ?, ?, ?)`,
    ).run(
      "Profile update continuation dispatch reserved.",
      "2026-08-04T20:00:00.500Z",
      JSON.stringify({ sourceEventId: firstEventId, status: "dispatch_intended" }),
      `profile-continuation-dispatch-intended:${firstEventId}`,
    );
    db.close();

    const providerDispatcher: JsonRpcDispatcher = {
      call: vi.fn(async () => ({
        jsonrpc: "2.0" as const,
        id: 1,
        result: { capabilities: [], detectedBrowsers: [] },
      })),
      close: vi.fn(async () => undefined),
    };
    const firstDispatch = deferred<ActionDispatchResult>();
    const dispatch = vi.fn<ActionDispatcher>((command) =>
      command.reason === `profile_updated:${firstEventId}`
        ? firstDispatch.promise
        : Promise.resolve({ status: "queued", runId: "run-newer-profile" }),
    );
    const app = buildApp({ ...options, providerDispatcher, actionDispatcher: dispatch });

    await app.listen({ host: "127.0.0.1", port: 0 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    expect(dispatch.mock.calls[0]?.[0].reason).toBe(`profile_updated:${firstEventId}`);
    firstDispatch.resolve({ status: "queued", runId: "run-older-profile" });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(2));
    expect(dispatch.mock.calls.map(([command]) => command.reason)).toEqual([
      `profile_updated:${firstEventId}`,
      `profile_updated:${secondEventId}`,
    ]);

    await vi.waitFor(() => {
      const progressDb = new Database(options.dbPath, { readonly: true });
      const row = progressDb.prepare(
        "SELECT COUNT(*) AS count FROM job_events WHERE event_type = 'ProfileContinuationHandled'",
      ).get() as { count: number };
      progressDb.close();
      expect(row.count).toBe(2);
    });

    const handledDb = new Database(options.dbPath, { readonly: true });
    try {
      const statuses = handledDb.prepare(
        `SELECT json_extract(payload_json, '$.sourceEventId') AS source_event_id,
                json_extract(payload_json, '$.status') AS status
           FROM job_events
          WHERE event_type = 'ProfileContinuationHandled'
          ORDER BY source_event_id`,
      ).all();
      expect(statuses).toEqual([
        { source_event_id: firstEventId, status: "completed" },
        { source_event_id: secondEventId, status: "completed" },
      ]);
    } finally {
      handledDb.close();
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
      templateText: INERT_RESUME_TEMPLATE,
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

  it("uses the HTML/CSS resume renderer for default profile PDF previews", () => {
    expect(PROFILE_PREVIEW_SCRIPT).toContain("from jobctrl.infrastructure.materials.html_resume_pdf import HtmlResumePdfAdapter");
    expect(PROFILE_PREVIEW_SCRIPT).not.toContain("jobctrl.infrastructure.materials.latex_pdf");
    expect(PROFILE_PREVIEW_SCRIPT).toContain("HtmlResumePdfAdapter().render_resume_to_pdf(");
    expect(PROFILE_PREVIEW_SCRIPT).toContain("resume_theme = json.loads(sys.argv[3])");
    expect(PROFILE_PREVIEW_SCRIPT).toContain("resume_theme=resume_theme");
  });

  it("serves a rendered profile PDF preview", async () => {
    const renderer = vi.fn(async () => ({
      pdfBytes: Buffer.from("%PDF-1.7\nmock preview"),
      htmlText: "<main>mock profile resume</main>",
    }));
    const app = buildApp({ ...options, profilePreviewRenderer: renderer });
    const seed = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: validProfileFixture("Jordan Candidate"),
        templateText: INERT_RESUME_TEMPLATE,
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
        resumeTheme: BUILT_IN_RESUME_TEMPLATE_THEME,
        templateText: INERT_RESUME_TEMPLATE,
      },
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("serves a rendered profile HTML preview for the Profile Plate editor", async () => {
    const renderer = vi.fn(async () => ({
      pdfBytes: Buffer.from("%PDF-1.7\nmock preview"),
      htmlText: '<main class="resume-page">mock profile resume</main>',
    }));
    const app = buildApp({ ...options, profilePreviewRenderer: renderer });
    const seed = await app.inject({
      method: "PATCH",
      url: "/v1/profile",
      payload: {
        profile: validProfileFixture("Jordan Candidate"),
        templateText: INERT_RESUME_TEMPLATE,
      },
    });
    expect(seed.statusCode, seed.body).toBe(200);

    const response = await app.inject({ method: "GET", url: "/v1/profile/preview.html" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.headers["content-type"]).toContain("text/html");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["content-security-policy"]).toContain("font-src data:");
    expect(response.body).toContain("mock profile resume");
    expect(renderer).toHaveBeenCalledWith(
      {
        profile: expect.objectContaining({ personal: expect.objectContaining({ full_name: "Jordan Candidate" }) }),
        resumeTheme: BUILT_IN_RESUME_TEMPLATE_THEME,
        templateText: INERT_RESUME_TEMPLATE,
      },
      expect.objectContaining({ appDir: tempDir, dbPath: options.dbPath }),
    );

    await app.close();
  });

  it("applies the effective template layout order to profile previews", async () => {
    const renderer = vi.fn(async () => ({
      pdfBytes: Buffer.from("%PDF-1.7\nmock preview"),
      htmlText: '<main class="resume-page">mock profile resume</main>',
    }));
    const app = buildApp({ ...options, profilePreviewRenderer: renderer });
    const created = await app.inject({
      method: "POST",
      url: "/v1/resume-templates",
      payload: {
        displayName: "Ordered profile template",
        theme: BUILT_IN_RESUME_TEMPLATE_THEME,
        layout: { sectionOrder: ["skills", "summary", "experience"] },
      },
    });
    expect(created.statusCode, created.body).toBe(200);
    const template = created.json().template;
    const selected = await app.inject({
      method: "PATCH",
      url: "/v1/resume-templates/default",
      payload: {
        templateId: template.templateId,
        versionId: template.activeVersion.versionId,
      },
    });
    expect(selected.statusCode, selected.body).toBe(200);

    const response = await app.inject({ method: "GET", url: "/v1/profile/preview.html" });

    expect(response.statusCode, response.body).toBe(200);
    expect(renderer).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeTheme: expect.objectContaining({
          sectionOrder: ["skills", "summary", "experience"],
        }),
      }),
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
        applyConcurrency: 3,
        workerActivitySlots: 4,
        dailyBudgetUsd: 12.5,
        scoreCriteria: "Security leadership and platform reliability.",
        targetCriteria: "Director-plus infrastructure and security roles.",
        preferredModels: { claude: "opus" },
      },
      paths: {
        configPath: options.configPath,
      },
      effectiveSettings: {
        dailyBudgetUsd: { value: 12.5, source: "persisted", activation: "live", editable: true },
        applyConcurrency: { value: 3, source: "persisted", activation: "next_poll", editable: true },
        workerActivitySlots: { value: 4, source: "default", activation: "restart", editable: true },
        analysisLegs: { source: "default", activation: "next_analysis", editable: true },
        applyMaxBudgetUsd: { value: 5, source: "default", activation: "next_apply_job", editable: true },
      },
    });

    await app.close();
  });

  it("persists typed discovery runtime settings with truthful activation metadata", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/discovery/settings",
      payload: {
        roleFilterMode: "llm",
        roleFilterModel: "claude:sonnet",
        maxParallelFamilies: 3,
        crawlUserAgentProduct: "JobCtrlResearch",
        crawlUserAgentContact: "ops@example.test",
        schedulingEnabled: true,
        scheduleCron: "0 8 * * 1-5",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      settings: {
        roleFilterMode: "llm",
        roleFilterModel: "claude:sonnet",
        maxParallelFamilies: 3,
        crawlUserAgentProduct: "JobCtrlResearch",
        crawlUserAgentContact: "ops@example.test",
        schedulingEnabled: true,
        scheduleCron: "0 8 * * 1-5",
      },
      effectiveSettings: {
        roleFilterMode: { source: "persisted", activation: "next_source_family", editable: true },
        maxParallelFamilies: { source: "persisted", activation: "next_run", editable: true },
        schedulingEnabled: { source: "persisted", activation: "restart", editable: true },
      },
    });
    await app.close();
  });

  it("keeps discovery settings SQLite-owned when a legacy environment variable is present", async () => {
    vi.stubEnv("JOBCTRL_MAX_PARALLEL_DISCOVERY_FAMILIES", "4");
    const app = buildApp(options);
    const read = await app.inject({ method: "GET", url: "/v1/discovery/settings" });
    expect(read.json()).toMatchObject({
      settings: { maxParallelFamilies: 1 },
      effectiveSettings: {
        maxParallelFamilies: { source: "default", editable: true, activation: "next_run" },
      },
    });

    const write = await app.inject({
      method: "PATCH",
      url: "/v1/discovery/settings",
      payload: { maxParallelFamilies: 2 },
    });
    expect(write.statusCode, write.body).toBe(200);
    expect(write.json()).toMatchObject({
      settings: { maxParallelFamilies: 2 },
      effectiveSettings: {
        maxParallelFamilies: { source: "persisted", editable: true, activation: "next_run" },
      },
    });
    await app.close();
  });

  it("falls back to defaults when settings are missing", async () => {
    fs.rmSync(options.configPath);
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/settings" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      settings: {
        applyConcurrency: 1,
        workerActivitySlots: 4,
        dailyBudgetUsd: 25,
        analysisLegs: ["claude", "codex", "google"],
        tailoringGeneratorModels: null,
        tailoringJudgeModel: null,
        tailoringJudgeMinScore: 0.82,
        applyMaxBudgetUsd: 5,
        applyTimeoutSeconds: 900,
        scoreCriteria: "",
        targetCriteria: "",
        preferredModels: {},
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
        applyConcurrency: 2,
        workerActivitySlots: 6,
        dailyBudgetUsd: 19.75,
        analysisLegs: ["claude", "google"],
        tailoringGeneratorModels: ["claude:sonnet", "codex:gpt-5.5"],
        tailoringJudgeModel: "claude:opus",
        tailoringJudgeMinScore: 0.9,
        applyMaxBudgetUsd: 7.5,
        applyTimeoutSeconds: 1200,
        scoreCriteria: "Prioritize platform security, DevSecOps, and leadership scope.",
        targetCriteria: "Target senior engineering leadership roles.",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      settings: {
        applyConcurrency: 2,
        workerActivitySlots: 6,
        dailyBudgetUsd: 19.75,
        scoreCriteria: "Prioritize platform security, DevSecOps, and leadership scope.",
        targetCriteria: "Target senior engineering leadership roles.",
      },
    });
    expect(JSON.parse(fs.readFileSync(options.configPath, "utf8"))).toMatchObject({
      apply_concurrency: 2,
      worker_activity_slots: 6,
      daily_budget_usd: 19.75,
      analysis_legs: ["claude", "google"],
      tailoring_generator_models: ["claude:sonnet", "codex:gpt-5.5"],
      tailoring_judge_model: "claude:opus",
      tailoring_judge_min_score: 0.9,
      apply_max_budget_usd: 7.5,
      apply_timeout_seconds: 1200,
      score_criteria: "Prioritize platform security, DevSecOps, and leadership scope.",
      target_criteria: "Target senior engineering leadership roles.",
    });

    await app.close();
  });

  it("keeps worker activity slots config-owned when a legacy environment variable is present", async () => {
    vi.stubEnv("JOBCTRL_MAX_CONCURRENT_ACTIVITIES", "9");
    const app = buildApp(options);

    const read = await app.inject({ method: "GET", url: "/v1/settings" });
    expect(read.statusCode, read.body).toBe(200);
    expect(read.json()).toMatchObject({
      settings: { workerActivitySlots: 4 },
      effectiveSettings: {
        workerActivitySlots: {
          value: 4,
          source: "default",
          activation: "restart",
          editable: true,
        },
      },
    });

    const write = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { workerActivitySlots: 7 },
    });
    expect(write.statusCode, write.body).toBe(200);
    expect(JSON.parse(fs.readFileSync(options.configPath, "utf8"))).toMatchObject({
      worker_activity_slots: 7,
    });

    await app.close();
  });

  it("keeps AI and Apply policy config-owned when legacy environment variables are present", async () => {
    vi.stubEnv("JOBCTRL_ANALYSIS_LEGS", "claude,google");
    vi.stubEnv("JOBCTRL_APPLY_MAX_BUDGET_USD", "0");
    const app = buildApp(options);
    const read = await app.inject({ method: "GET", url: "/v1/settings" });
    expect(read.json()).toMatchObject({
      settings: {
        analysisLegs: ["claude", "codex", "google"],
        applyMaxBudgetUsd: 5,
      },
      effectiveSettings: {
        analysisLegs: { source: "default", activation: "next_analysis", editable: true },
        applyMaxBudgetUsd: { source: "default", activation: "next_apply_job", editable: true },
      },
    });
    const write = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { applyMaxBudgetUsd: 9 },
    });
    expect(write.statusCode, write.body).toBe(200);
    expect(JSON.parse(fs.readFileSync(options.configPath, "utf8"))).toMatchObject({
      apply_max_budget_usd: 9,
    });
    await app.close();
  });

  it("rejects worker activity slots outside the public settings contract", async () => {
    const app = buildApp(options);
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { workerActivitySlots: 65 },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(JSON.parse(fs.readFileSync(options.configPath, "utf8"))).not.toHaveProperty(
      "worker_activity_slots",
    );
    await app.close();
  });

  it("stores credential configuration through the injected credential store", async () => {
    const stored = new Map<CredentialKey, string>();
    const credentialStore = {
      list: vi.fn(async () => ({
        ok: true as const,
        store: {
          kind: "config_and_macos_keychain" as const,
          available: true,
          unavailableReason: null,
          requiresWorkerRestart: true as const,
        },
        credentials: CredentialKeys.map((key) => ({
          key,
          label: key,
          configured: stored.has(key),
          storage: "keychain" as const,
          effectiveSource: stored.has(key) ? "keychain" as const : "absent" as const,
          editable: true,
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
      applyBatch: vi.fn(async (operations: readonly CredentialBatchOperation[]) => {
        for (const operation of operations) {
          if (operation.operation === "set") {
            stored.set(operation.key, operation.value);
          } else {
            stored.delete(operation.key);
          }
        }
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

  it("applies an allowlisted credential batch without returning values", async () => {
    const values = new Map<CredentialKey, string>([
      ["CLAUDE_CODE_USE_VERTEX", "1"],
    ]);
    const response = () => ({
      ok: true as const,
      store: {
        kind: "config_and_macos_keychain" as const,
        available: true,
        unavailableReason: null,
        requiresWorkerRestart: true as const,
      },
      credentials: CredentialKeys.map((key) => ({
        key,
        label: key,
        configured: values.has(key),
        storage: "keychain" as const,
        effectiveSource: values.has(key) ? "keychain" as const : "absent" as const,
        editable: true,
      })),
    });
    const credentialStore = {
      list: vi.fn(async () => response()),
      set: vi.fn(),
      delete: vi.fn(),
      applyBatch: vi.fn(async (operations: readonly CredentialBatchOperation[]) => {
        for (const operation of operations) {
          if (operation.operation === "set") {
            values.set(operation.key, operation.value);
          } else {
            values.delete(operation.key);
          }
        }
        return response();
      }),
    };
    const app = buildApp({ ...options, credentialStore });

    const save = await app.inject({
      method: "PATCH",
      url: "/v1/credentials/batch",
      payload: {
        operations: [
          { operation: "set", key: "ANTHROPIC_API_KEY", value: "batch-secret" },
          { operation: "delete", key: "CLAUDE_CODE_USE_VERTEX" },
        ],
      },
    });

    expect(save.statusCode, save.body).toBe(200);
    expect(credentialStore.applyBatch).toHaveBeenCalledTimes(1);
    expect(save.body).not.toContain("batch-secret");
    expect(save.json().credentials).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "ANTHROPIC_API_KEY", configured: true }),
        expect.objectContaining({ key: "CLAUDE_CODE_USE_VERTEX", configured: false }),
      ]),
    );

    const invalid = await app.inject({
      method: "PATCH",
      url: "/v1/credentials/batch",
      payload: {
        operations: [
          {
            operation: "set",
            key: "AWS_SECRET_ACCESS_KEY",
            value: REJECTED_CREDENTIAL_VALUE_MARKER,
          },
        ],
      },
    });
    expect(invalid.statusCode, invalid.body).toBe(400);
    expect(invalid.body).not.toContain(REJECTED_CREDENTIAL_VALUE_MARKER);
    expect(credentialStore.applyBatch).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns an explicit sanitized partial-failure state when batch recovery is incomplete", async () => {
    const secret = "partial-batch-secret-must-not-appear";
    const credentialStore = {
      list: vi.fn(),
      set: vi.fn(),
      delete: vi.fn(),
      applyBatch: vi.fn(async () => {
        throw new CredentialStoreUnavailableError("partial_failure");
      }),
    };
    const app = buildApp({ ...options, credentialStore });
    const logError = vi.spyOn(app.log, "error");

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/credentials/batch",
      payload: {
        operations: [
          { operation: "set", key: "ANTHROPIC_API_KEY", value: secret },
          { operation: "delete", key: "CLAUDE_CODE_USE_VERTEX" },
        ],
      },
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "credential_store_unavailable",
      reason: "partial_failure",
      message:
        "Credential update failed and Keychain recovery was incomplete. Provider credentials may be partially updated; inspect Keychain before retrying.",
    });
    expect(response.body).not.toContain(secret);
    expect(logError).not.toHaveBeenCalled();

    await app.close();
  });

  it("dispatches sanitized provider status and Codex verification responses", async () => {
    const call = vi.fn<JsonRpcDispatcher["call"]>(async (method) => {
      if (method === "provider_status") {
        return {
          jsonrpc: "2.0" as const,
          id: 1,
          result: {
            providers: [
              {
                provider: "codex",
                configured: true,
                ready: true,
                mode: "subscription",
              },
            ],
          },
        };
      }
      return {
        jsonrpc: "2.0" as const,
        id: 2,
        result: {
          provider: "codex",
          ok: true,
          status: "connected",
          message: "Codex CLI authentication is ready.",
        },
      };
    });
    const providerDispatcher: JsonRpcDispatcher = {
      call,
      close: vi.fn(async () => undefined),
    };
    const app = buildApp({ ...options, providerDispatcher });

    const status = await app.inject({ method: "GET", url: "/v1/providers/status" });
    const verify = await app.inject({ method: "POST", url: "/v1/providers/codex/verify" });

    expect(status.statusCode, status.body).toBe(200);
    expect(status.json()).toMatchObject({
      ok: true,
      providers: [{ provider: "codex", ready: true, mode: "subscription" }],
    });
    expect(verify.statusCode, verify.body).toBe(200);
    expect(verify.json()).toMatchObject({
      ok: true,
      verification: { provider: "codex", status: "connected" },
    });
    expect(call).toHaveBeenNthCalledWith(1, "provider_status", {});
    expect(call).toHaveBeenNthCalledWith(2, "provider_verify", { provider: "codex" });

    await app.close();
  });

  it("lists detected browsers and forwards explicit browser and profile selections", async () => {
    const browserResult = {
      capabilities: [
        {
          id: "core-browser",
          status: "ready",
          detail: "Managed browser is ready.",
          mutable: false,
          enabled: true,
          profileCopyReady: false,
        },
        {
          id: "auto-apply-browser",
          status: "disabled",
          detail: "Disabled by default.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
        {
          id: "authenticated-linkedin-browser",
          status: "disabled",
          detail: "Disabled by default.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
      ],
      detectedBrowsers: [
        {
          id: "google-chrome",
          label: "Google Chrome",
          defaultProfileAvailable: true,
          profiles: [
            {
              id: "profile-0123456789abcdef0123456789abcdef",
              label: "Signed in",
            },
          ],
        },
        {
          id: "chromium",
          label: "Chromium",
          defaultProfileAvailable: false,
          profiles: [],
        },
      ],
    };
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: browserResult,
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const listed = await app.inject({ method: "GET", url: "/v1/browser-capabilities" });
    const enabled = await app.inject({
      method: "POST",
      url: "/v1/browser-capabilities/auto-apply-browser/enable",
      payload: { detectedBrowserId: "google-chrome" },
    });
    const manuallyEnabled = await app.inject({
      method: "POST",
      url: "/v1/browser-capabilities/auto-apply-browser/enable",
      payload: { executablePath: "/Applications/Chromium" },
    });
    const copiedProfile = await app.inject({
      method: "POST",
      url: "/v1/browser-capabilities/authenticated-linkedin-browser/profile-copy",
      payload: {
        detectedBrowserId: "google-chrome",
        detectedProfileId: "profile-0123456789abcdef0123456789abcdef",
        consent: true,
        consentMethod: "explicit-ui-v1",
      },
    });

    expect(listed.statusCode, listed.body).toBe(200);
    expect(listed.json()).toMatchObject({ ok: true, detectedBrowsers: browserResult.detectedBrowsers });
    expect(enabled.statusCode, enabled.body).toBe(200);
    expect(manuallyEnabled.statusCode, manuallyEnabled.body).toBe(200);
    expect(copiedProfile.statusCode, copiedProfile.body).toBe(200);
    expect(call).toHaveBeenNthCalledWith(1, "browser_capabilities_list", {});
    expect(call).toHaveBeenNthCalledWith(2, "browser_capability_enable", {
      capabilityId: "auto-apply-browser",
      detectedBrowserId: "google-chrome",
    });
    expect(call).toHaveBeenNthCalledWith(3, "browser_capability_enable", {
      capabilityId: "auto-apply-browser",
      executablePath: "/Applications/Chromium",
    });
    expect(call).toHaveBeenNthCalledWith(4, "browser_profile_copy", {
      detectedBrowserId: "google-chrome",
      detectedProfileId: "profile-0123456789abcdef0123456789abcdef",
      consent: true,
      consentMethod: "explicit-ui-v1",
    });

    await app.close();
  });

  it("continues pending preparation when the authenticated browser becomes ready", async () => {
    const typedBlockedUrl = "https://www.linkedin.com/jobs/view/condition-blocked";
    const legacyBlockedUrl = "https://linkedin.com/jobs/view/legacy-condition-blocked";
    const unrelatedBlockedUrl = "https://example.com/jobs/robots-blocked";
    const pendingLinkedInUrl = "https://www.linkedin.com/jobs/view/still-pending";
    const db = new Database(options.dbPath);
    for (const [url, site] of [
      [typedBlockedUrl, "linkedin"],
      [legacyBlockedUrl, "linkedin"],
      [unrelatedBlockedUrl, "example"],
      [pendingLinkedInUrl, "linkedin"],
    ] as const) {
      insertJob(db, { url, title: "Recovery target", site });
    }
    insertStage(db, typedBlockedUrl, "enrich", "blocked", "ENRICH_ROBOTS_DISALLOWED");
    insertStage(db, legacyBlockedUrl, "enrich", "blocked", "ENRICH_ROBOTS_DISALLOWED");
    insertStage(db, unrelatedBlockedUrl, "enrich", "blocked", "ENRICH_ROBOTS_DISALLOWED");
    insertStage(db, pendingLinkedInUrl, "enrich", "pending");
    db.prepare(
      `UPDATE job_stage_states
          SET retryable = 1,
              metadata_json = ?
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).run(
      JSON.stringify({ blockedConditions: ["authenticated_linkedin_browser_unavailable"] }),
      jobIdFor(typedBlockedUrl),
    );
    db.prepare(
      `UPDATE job_stage_states
          SET retryable = 1,
              metadata_json = ?
        WHERE tenant_id = 'local' AND job_id IN (?, ?) AND stage = 'enrich'`,
    ).run(
      JSON.stringify({ blockedConditions: ["authenticated_linkedin_browser_unavailable"] }),
      jobIdFor(legacyBlockedUrl),
      jobIdFor(unrelatedBlockedUrl),
    );
    db.prepare(
      `UPDATE job_stage_states
          SET metadata_json = NULL
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).run(jobIdFor(legacyBlockedUrl));
    db.close();

    const readyResult = {
      capabilities: [
        {
          id: "core-browser",
          status: "ready",
          detail: "Managed browser is ready.",
          mutable: false,
          enabled: true,
          profileCopyReady: false,
        },
        {
          id: "auto-apply-browser",
          status: "disabled",
          detail: "Disabled by default.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
        {
          id: "authenticated-linkedin-browser",
          status: "ready",
          detail: "Authenticated browser is ready.",
          mutable: true,
          enabled: true,
          profileCopyReady: true,
        },
      ],
      detectedBrowsers: [],
    };
    const providerDispatcher: JsonRpcDispatcher = {
      call: vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: readyResult })),
      close: vi.fn(async () => undefined),
    };
    const dispatch = vi.fn(async (): Promise<ActionDispatchResult> => ({
      status: "queued",
      runId: "run-browser-ready-continuation",
    }));
    const app = buildApp({ ...options, providerDispatcher, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/browser-capabilities/authenticated-linkedin-browser/profile-copy",
      payload: {
        detectedBrowserId: "google-chrome",
        consent: true,
        consentMethod: "explicit-ui-v1",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "run_stage",
        jobKey: "pipeline",
        jobIds: [jobIdFor(typedBlockedUrl), jobIdFor(legacyBlockedUrl)].sort(),
        stage: "enrich",
        stages: ["enrich", "score", "tailor", "cover"],
        dryRun: false,
        limit: 2,
        minScore: 6,
        reason: "condition_resolved:authenticated_linkedin_browser_unavailable",
      }),
      { appDir: tempDir, configPath: options.configPath, dbPath: options.dbPath },
    );

    await app.close();
  });

  it("recovers browser-triggered preparation on API startup after the readiness request was interrupted", async () => {
    const blockedUrl = "https://www.linkedin.com/jobs/view/startup-condition-recovery";
    const db = new Database(options.dbPath);
    insertJob(db, { url: blockedUrl, title: "Startup recovery target", site: "linkedin" });
    insertStage(db, blockedUrl, "enrich", "blocked", "ENRICH_ROBOTS_DISALLOWED");
    db.prepare(
      `UPDATE job_stage_states
          SET retryable = 1,
              metadata_json = ?
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).run(
      JSON.stringify({ blockedConditions: ["authenticated_linkedin_browser_unavailable"] }),
      jobIdFor(blockedUrl),
    );
    db.close();

    const providerDispatcher: JsonRpcDispatcher = {
      call: vi.fn(async () => ({
        jsonrpc: "2.0" as const,
        id: 1,
        result: {
          capabilities: [
            {
              id: "core-browser",
              status: "ready",
              detail: "Managed browser is ready.",
              mutable: false,
              enabled: true,
              profileCopyReady: false,
            },
            {
              id: "auto-apply-browser",
              status: "disabled",
              detail: "Disabled by default.",
              mutable: true,
              enabled: false,
              profileCopyReady: false,
            },
            {
              id: "authenticated-linkedin-browser",
              status: "ready",
              detail: "Authenticated browser is ready.",
              mutable: true,
              enabled: true,
              profileCopyReady: true,
            },
          ],
          detectedBrowsers: [],
        },
      })),
      close: vi.fn(async () => undefined),
    };
    const dispatched = deferred<ActionDispatchResult>();
    const dispatch = vi.fn<ActionDispatcher>(() => dispatched.promise);
    const app = buildApp({ ...options, providerDispatcher, actionDispatcher: dispatch });

    await app.listen({ host: "127.0.0.1", port: 0 });
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    const command = dispatch.mock.calls[0]?.[0];
    expect(command).toMatchObject({
      action: "run_stage",
      jobIds: [jobIdFor(blockedUrl)],
      stages: ["enrich", "score", "tailor", "cover"],
      reason: "condition_resolved:authenticated_linkedin_browser_unavailable",
    });

    const claimedDb = new Database(options.dbPath, { readonly: true });
    const metadata = JSON.parse(String(claimedDb.prepare(
      `SELECT metadata_json
         FROM job_stage_states
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).pluck().get(jobIdFor(blockedUrl)))) as Record<string, unknown>;
    claimedDb.close();
    expect(metadata.conditionRecoveryKey).toMatch(/^[0-9a-f]{24}$/);

    dispatched.resolve({ status: "queued", runId: "run-startup-condition-recovery" });
    await app.close();
  });

  it("coalesces concurrent browser-ready recovery requests into one dispatch", async () => {
    const blockedUrl = "https://www.linkedin.com/jobs/view/concurrent-condition-recovery";
    const db = new Database(options.dbPath);
    insertJob(db, { url: blockedUrl, title: "Concurrent recovery target", site: "linkedin" });
    insertStage(db, blockedUrl, "enrich", "blocked", "ENRICH_ROBOTS_DISALLOWED");
    db.prepare(
      `UPDATE job_stage_states
          SET retryable = 1,
              metadata_json = ?
        WHERE tenant_id = 'local' AND job_id = ? AND stage = 'enrich'`,
    ).run(
      JSON.stringify({ blockedConditions: ["authenticated_linkedin_browser_unavailable"] }),
      jobIdFor(blockedUrl),
    );
    db.close();
    const readyResult = {
      capabilities: [
        {
          id: "core-browser",
          status: "ready",
          detail: "Managed browser is ready.",
          mutable: false,
          enabled: true,
          profileCopyReady: false,
        },
        {
          id: "auto-apply-browser",
          status: "disabled",
          detail: "Disabled by default.",
          mutable: true,
          enabled: false,
          profileCopyReady: false,
        },
        {
          id: "authenticated-linkedin-browser",
          status: "ready",
          detail: "Authenticated browser is ready.",
          mutable: true,
          enabled: true,
          profileCopyReady: true,
        },
      ],
      detectedBrowsers: [],
    };
    const providerDispatcher: JsonRpcDispatcher = {
      call: vi.fn(async () => ({ jsonrpc: "2.0" as const, id: 1, result: readyResult })),
      close: vi.fn(async () => undefined),
    };
    const dispatched = deferred<ActionDispatchResult>();
    const dispatch = vi.fn<ActionDispatcher>(() => dispatched.promise);
    const app = buildApp({ ...options, providerDispatcher, actionDispatcher: dispatch });
    const request = () => app.inject({
      method: "POST",
      url: "/v1/browser-capabilities/authenticated-linkedin-browser/profile-copy",
      payload: {
        detectedBrowserId: "google-chrome",
        consent: true,
        consentMethod: "explicit-ui-v1",
      },
    });

    const responses = Promise.all([request(), request()]);
    await vi.waitFor(() => expect(dispatch).toHaveBeenCalledTimes(1));
    dispatched.resolve({ status: "queued", runId: "run-concurrent-condition-recovery" });
    expect((await responses).map((response) => response.statusCode)).toEqual([200, 200]);
    expect(dispatch).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it("returns the worker's sanitized detected-browser validation reason", async () => {
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      error: {
        code: JsonRpcErrorCodes.InvalidParams,
        message: "The selected detected browser is no longer available.",
      },
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/browser-capabilities/auto-apply-browser/enable",
      payload: { detectedBrowserId: "google-chrome" },
    });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toEqual({
      ok: false,
      error: "browser_capability_failed",
      message: "The selected detected browser is no longer available.",
    });
    await app.close();
  });

  it("returns a sanitized provider model catalog in stable provider order", async () => {
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        providers: [
          {
            provider: "codex",
            configured: true,
            ready: true,
            source: "live",
            models: [{ id: "gpt-test", displayName: "GPT Test", isDefault: true }],
          },
          {
            provider: "claude",
            configured: true,
            ready: true,
            source: "live",
            models: [{ id: "sonnet", displayName: "Sonnet" }],
          },
          {
            provider: "google",
            configured: false,
            ready: false,
            source: "live",
            models: [],
            message: "Provider is not configured.",
          },
        ],
      },
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const response = await app.inject({ method: "GET", url: "/v1/providers/models" });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      providers: [
        { provider: "codex", source: "live" },
        { provider: "claude", source: "live" },
        { provider: "google", models: [] },
      ],
    });
    expect(call).toHaveBeenCalledWith("provider_models", {});
    await app.close();
  });

  it("validates, merges, and clears preferred models without persisting credentials", async () => {
    const currentSettings = JSON.parse(fs.readFileSync(options.configPath, "utf8"));
    currentSettings.preferred_models.google = "gemini-test";
    fs.writeFileSync(options.configPath, JSON.stringify(currentSettings));
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        providers: [
          {
            provider: "codex",
            configured: true,
            ready: true,
            source: "live",
            models: [{ id: "gpt-test", displayName: "GPT Test" }],
          },
          {
            provider: "claude",
            configured: false,
            ready: false,
            source: "live",
            models: [],
            message: "Provider is not configured.",
          },
          {
            provider: "google",
            configured: true,
            ready: true,
            source: "live",
            models: [{ id: "gemini-test", displayName: "Gemini Test" }],
          },
        ],
      },
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const save = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { preferredModels: { codex: "gpt-test", claude: null } },
    });

    expect(save.statusCode, save.body).toBe(200);
    expect(save.json().settings.preferredModels).toEqual({ codex: "gpt-test", google: "gemini-test" });
    const persisted = JSON.parse(fs.readFileSync(options.configPath, "utf8"));
    expect(persisted.preferred_models).toEqual({ codex: "gpt-test", google: "gemini-test" });
    expect(JSON.stringify(persisted)).not.toMatch(/credential|api[_-]?key|token/i);
    expect(call).toHaveBeenCalledTimes(1);
    await app.close();
  });

  it("clears a preferred model without provider readiness or catalog access", async () => {
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => {
      throw new Error("catalog must not be called for a clear");
    });
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { preferredModels: { claude: null } },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().settings.preferredModels).toEqual({});
    expect(JSON.parse(fs.readFileSync(options.configPath, "utf8")).preferred_models).toEqual({});
    expect(call).not.toHaveBeenCalled();
    await app.close();
  });

  it("rejects unavailable providers and unoffered preferred models before persistence", async () => {
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        providers: [
          { provider: "codex", configured: true, ready: true, source: "live", models: [{ id: "gpt-test", displayName: "GPT Test" }] },
          { provider: "claude", configured: false, ready: false, source: "live", models: [], message: "Provider is not configured." },
          { provider: "google", configured: true, ready: true, source: "live", models: [{ id: "gemini-test", displayName: "Gemini Test" }] },
        ],
      },
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });
    const before = fs.readFileSync(options.configPath, "utf8");

    const unavailable = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { preferredModels: { claude: "sonnet" } },
    });
    const invalid = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { preferredModels: { google: "gemini-unknown" } },
    });

    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json().error).toBe("provider_not_ready");
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json().error).toBe("invalid_preferred_model");
    expect(fs.readFileSync(options.configPath, "utf8")).toBe(before);
    await app.close();
  });

  it("returns 503 when a ready provider's live catalog cannot be listed", async () => {
    const marker = "secret-live-catalog-error";
    const call = vi.fn<JsonRpcDispatcher["call"]>(async () => ({
      jsonrpc: "2.0" as const,
      id: 1,
      result: {
        providers: [
          {
            provider: "codex",
            configured: true,
            ready: true,
            source: "live",
            models: [],
            message: "Live model catalog is temporarily unavailable.",
          },
          { provider: "claude", configured: true, ready: true, source: "live", models: [{ id: "sonnet", displayName: "Sonnet" }] },
          { provider: "google", configured: false, ready: false, source: "live", models: [], message: "Provider is not configured." },
        ],
      },
    }));
    const app = buildApp({
      ...options,
      providerDispatcher: { call, close: vi.fn(async () => undefined) },
    });

    const response = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { preferredModels: { codex: marker } },
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "provider_models_failed",
      message: "Provider models are temporarily unavailable.",
    });
    expect(response.body).not.toContain(marker);
    await app.close();
  });

  it("sanitizes provider dispatcher failures", async () => {
    const marker = "secret-provider-token";
    const providerDispatcher: JsonRpcDispatcher = {
      call: vi.fn(async () => ({
        jsonrpc: "2.0" as const,
        id: 1,
        error: { code: -32603, message: marker, data: { token: marker } },
      })),
      close: vi.fn(async () => undefined),
    };
    const app = buildApp({ ...options, providerDispatcher });

    const status = await app.inject({ method: "GET", url: "/v1/providers/status" });
    const verify = await app.inject({ method: "POST", url: "/v1/providers/codex/verify" });
    const models = await app.inject({ method: "GET", url: "/v1/providers/models" });
    const preferredModel = await app.inject({
      method: "PATCH",
      url: "/v1/settings",
      payload: { preferredModels: { codex: "gpt-test" } },
    });

    expect(status.statusCode, status.body).toBe(502);
    expect(verify.statusCode, verify.body).toBe(502);
    expect(models.statusCode, models.body).toBe(503);
    expect(preferredModel.statusCode, preferredModel.body).toBe(503);
    expect(`${status.body}${verify.body}${models.body}${preferredModel.body}`).not.toContain(marker);

    await app.close();
  });

  it.each([
    ["empty", ""],
    [
      "over 8,000 characters",
      `${REJECTED_CREDENTIAL_VALUE_MARKER}${"x".repeat(
        CREDENTIAL_VALUE_MAX_LENGTH +
          1 -
          REJECTED_CREDENTIAL_VALUE_MARKER.length,
      )}`,
    ],
    ["carriage return", `${REJECTED_CREDENTIAL_VALUE_MARKER}\rrest`],
    ["line feed", `${REJECTED_CREDENTIAL_VALUE_MARKER}\nrest`],
    ["NUL", `${REJECTED_CREDENTIAL_VALUE_MARKER}\0rest`],
  ])(
    "rejects a credential containing %s before invoking the store",
    async (_label, value) => {
      const runSecurity = vi.fn();
      const credentialStore = new KeychainCredentialStore({
        platform: "darwin",
        runSecurity,
      });
      const setCredential = vi.spyOn(credentialStore, "set");
      const app = buildApp({ ...options, credentialStore });
      const logError = vi.spyOn(app.log, "error");

      const save = await app.inject({
        method: "PATCH",
        url: "/v1/credentials",
        payload: { key: "OPENAI_API_KEY", value },
      });

      expect(save.statusCode, save.body).toBe(400);
      expect(save.body).not.toContain(REJECTED_CREDENTIAL_VALUE_MARKER);
      expect(setCredential).not.toHaveBeenCalled();
      expect(runSecurity).not.toHaveBeenCalled();
      expect(logError).not.toHaveBeenCalled();

      await app.close();
    },
  );

  it.each([
    ["one character", "x"],
    ["8,000 characters", "x".repeat(CREDENTIAL_VALUE_MAX_LENGTH)],
  ])("accepts a valid credential at the %s boundary", async (_label, value) => {
    const response = {
      ok: true as const,
      store: {
        kind: "config_and_macos_keychain" as const,
        available: true,
        unavailableReason: null,
        requiresWorkerRestart: true as const,
      },
      credentials: CredentialKeys.map((key) => ({
        key,
        label: key,
        configured: true,
        storage: "keychain" as const,
        effectiveSource: "keychain" as const,
        editable: true,
      })),
    };
    const credentialStore = {
      list: vi.fn(async () => response),
      set: vi.fn(async (_key: CredentialKey, _value: string) => response),
      delete: vi.fn(async () => response),
      applyBatch: vi.fn(async () => response),
    };
    const app = buildApp({ ...options, credentialStore });

    const save = await app.inject({
      method: "PATCH",
      url: "/v1/credentials",
      payload: { key: "OPENAI_API_KEY", value },
    });

    expect(save.statusCode, save.body).toBe(200);
    expect(credentialStore.set).toHaveBeenCalledTimes(1);
    expect(credentialStore.set.mock.calls[0]?.[0]).toBe("OPENAI_API_KEY");
    expect(credentialStore.set.mock.calls[0]?.[1]).toHaveLength(value.length);

    await app.close();
  });

  it.each(["linux", "win32"] as const)(
    "reports unsupported Keychain storage on %s without spawning or failing credential reads",
    async (platform) => {
      const runSecurity = vi.fn();
      const credentialStore = new KeychainCredentialStore({
        platform,
        runSecurity,
        configPath: options.configPath,
      });
      const app = buildApp({ ...options, credentialStore });

      const initial = await app.inject({ method: "GET", url: "/v1/credentials" });
      expect(initial.statusCode, initial.body).toBe(200);
      expect(initial.json()).toMatchObject({
        ok: true,
        store: {
          kind: "config_and_macos_keychain",
          available: false,
          unavailableReason: "unsupported_platform",
          requiresWorkerRestart: true,
        },
      });
      const byKey = new Map<string, { key: string; configured: boolean | null }>(
        initial.json().credentials.map(
          (credential: { key: string; configured: boolean | null }) => [credential.key, credential] as const,
        ),
      );
      expect(SecretCredentialKeys.every((key) => byKey.get(key)?.configured === null)).toBe(true);
      expect(ProviderConfigurationKeys.every((key) => byKey.get(key)?.configured === false)).toBe(true);
      expect(runSecurity).not.toHaveBeenCalled();

      const save = await app.inject({
        method: "PATCH",
        url: "/v1/credentials",
        payload: { key: "OPENAI_API_KEY", value: "test-secret" },
      });
      expect(save.statusCode, save.body).toBe(409);
      expect(save.json()).toMatchObject({
        ok: false,
        error: "credential_store_unavailable",
        reason: "unsupported_platform",
      });

      const remove = await app.inject({ method: "DELETE", url: "/v1/credentials/OPENAI_API_KEY" });
      expect(remove.statusCode, remove.body).toBe(409);
      expect(remove.json()).toMatchObject({
        ok: false,
        error: "credential_store_unavailable",
        reason: "unsupported_platform",
      });
      expect(runSecurity).not.toHaveBeenCalled();

      await app.close();
    },
  );

  it("keeps failed Keychain inspection unknown and returns sanitized 503 mutation errors", async () => {
    const secret = "server-secret-and-raw-stderr-must-not-appear";
    const runSecurity = vi.fn(async () => {
      throw new Error(secret);
    });
    const credentialStore = new KeychainCredentialStore({
      platform: "darwin",
      runSecurity,
      configPath: options.configPath,
    });
    const app = buildApp({ ...options, credentialStore });
    const logError = vi.spyOn(app.log, "error");

    const initial = await app.inject({ method: "GET", url: "/v1/credentials" });
    expect(initial.statusCode, initial.body).toBe(200);
    expect(initial.json()).toMatchObject({
      ok: true,
      store: {
        available: false,
        unavailableReason: "inspection_failed",
      },
    });
    const byKey = new Map<string, { key: string; configured: boolean | null }>(
      initial.json().credentials.map(
        (credential: { key: string; configured: boolean | null }) => [credential.key, credential] as const,
      ),
    );
    expect(SecretCredentialKeys.every((key) => byKey.get(key)?.configured === null)).toBe(true);
    expect(ProviderConfigurationKeys.every((key) => byKey.get(key)?.configured === false)).toBe(true);
    expect(initial.body).not.toContain(secret);

    const save = await app.inject({
      method: "PATCH",
      url: "/v1/credentials",
      payload: { key: "OPENAI_API_KEY", value: secret },
    });
    expect(save.statusCode, save.body).toBe(503);
    expect(save.json()).toEqual({
      ok: false,
      error: "credential_store_unavailable",
      reason: "operational_failure",
      message: "macOS Keychain is temporarily unavailable. Unlock Keychain Access and retry.",
    });
    expect(save.body).not.toContain(secret);

    const remove = await app.inject({
      method: "DELETE",
      url: "/v1/credentials/OPENAI_API_KEY",
    });
    expect(remove.statusCode, remove.body).toBe(503);
    expect(remove.json()).toMatchObject({
      ok: false,
      error: "credential_store_unavailable",
      reason: "operational_failure",
    });
    expect(remove.body).not.toContain(secret);
    expect(logError).not.toHaveBeenCalled();

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

function seedExactV7CompensationDatabase(
  dbPath: string,
  job?: { jobId: string; postingUrl: string },
): void {
  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  seedBuiltInResumeTemplate(db);
  if (job) {
    db.prepare(
      `INSERT INTO jobs (
        tenant_id, job_id, url, title, site, strategy, location, discovered_at, application_url
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "local",
      job.jobId,
      job.postingUrl,
      "Platform Engineer",
      "example",
      "test",
      "Remote",
      "2026-04-29T10:00:00+00:00",
      `${job.postingUrl}/apply`,
    );
  }
  db.close();
}

function seedBuiltInResumeTemplate(db: Database.Database): void {
  const now = "2026-04-29T10:00:00+00:00";
  db.prepare(
    `INSERT INTO resume_templates (
       tenant_id, template_id, display_name, status, built_in, created_at, updated_at
     ) VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO resume_template_versions (
       tenant_id, version_id, template_id, version_number, display_name, status,
       theme_json, layout_json, content_hash, created_at
     ) VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1,
               'Modern HTML', 'active', ?, '{}', 'server-seed-hash', ?)`,
  ).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), now);
}

function insertLearningRecommendationFixture(
  db: Database.Database,
  options: {
    tenantId: string;
    recommendationId: string;
    tombstoned: boolean;
  },
): void {
  const jobIds = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
  ] as const;
  db.transaction(() => {
    for (const index of [1, 2, 3] as const) {
      const signalId = `signal-${options.tenantId}-${index}`;
      db.prepare(
        `INSERT INTO learning_recommendation_evidence (
           tenant_id, recommendation_id, signal_id, evidence_role,
           source_kind, source_id, source_revision, recorded_at
         ) VALUES (?, ?, ?, 'supporting', 'tailoring_feedback_signal', ?, ?, ?)`,
      ).run(
        options.tenantId,
        options.recommendationId,
        signalId,
        `source-${options.tenantId}-${index}`,
        index,
        `2026-08-01T10:00:0${index}Z`,
      );
      db.prepare(
        `INSERT INTO learning_recommendation_evidence_jobs (
           tenant_id, recommendation_id, signal_id, job_id
         ) VALUES (?, ?, ?, ?)`,
      ).run(
        options.tenantId,
        options.recommendationId,
        signalId,
        index === 3 ? jobIds[1] : jobIds[0],
      );
    }
    const contradictionId = `contradiction-${options.tenantId}`;
    db.prepare(
      `INSERT INTO learning_recommendation_evidence (
         tenant_id, recommendation_id, signal_id, evidence_role,
         source_kind, source_id, source_revision, recorded_at
       ) VALUES (?, ?, ?, 'contradicting', 'tailoring_feedback_signal', ?, 4, ?)`,
    ).run(
      options.tenantId,
      options.recommendationId,
      contradictionId,
      options.tenantId === "local"
        ? "private resume, prompt, note, and job description"
        : `source-${contradictionId}`,
      "2026-08-01T10:00:04Z",
    );
    db.prepare(
      `INSERT INTO learning_recommendation_evidence_jobs (
         tenant_id, recommendation_id, signal_id, job_id
       ) VALUES (?, ?, ?, '33333333-3333-4333-8333-333333333333')`,
    ).run(options.tenantId, options.recommendationId, contradictionId);
    for (const jobId of jobIds) {
      db.prepare(
        `INSERT INTO learning_recommendation_jobs (
           tenant_id, recommendation_id, job_id
         ) VALUES (?, ?, ?)`,
      ).run(options.tenantId, options.recommendationId, jobId);
    }
    db.prepare(
      `INSERT INTO learning_recommendations (
         tenant_id, recommendation_id, derivation_version,
         evaluation_fixture_version, context, policy_kind, signal_kind,
         rule_key, rule_value, allowlist_version, status,
         observed_signal_count, observed_job_count, minimum_signal_count,
         minimum_job_count, confidence_limit, input_fingerprint, derived_at
       ) VALUES (
         ?, ?, 1, 1, 'materials', 'tailoring_rule', 'factual_correction',
         'fact_handling', 'require_source_match', 1, 'pending', 3, 2, 3, 2,
         'sample_gated_no_population_inference', ?, '2026-08-01T10:01:00Z'
       )`,
    ).run(
      options.tenantId,
      options.recommendationId,
      options.recommendationId.replace("learning-recommendation:", ""),
    );
    if (options.tombstoned) {
      db.prepare(
        `INSERT INTO learning_recommendation_tombstones (
           tenant_id, tombstone_id, recommendation_id, affected_signal_id,
           affected_source_revision, reason_code, derivation_version,
           tombstoned_at, rederived_at, replacement_recommendation_id
         ) VALUES (?, ?, ?, ?, 1, 'source_deleted', 1, ?, ?, NULL)`,
      ).run(
        options.tenantId,
        `learning-recommendation-tombstone:${"c".repeat(64)}`,
        options.recommendationId,
        `signal-${options.tenantId}-1`,
        "2026-08-01T10:02:00Z",
        "2026-08-01T10:02:01Z",
      );
    }
  })();
}

function insertTailoringPolicyFixture(
  db: Database.Database,
  options: {
    tenantId: string;
    version: number;
    learnedRules: Record<string, string>;
    createdAt: string;
    rollbackOfVersion?: number;
    rollbackReason?: string;
  },
): void {
  db.prepare(
    `INSERT INTO tailoring_policies (
       tenant_id, version, prompt_version, schema_version, judge_schema_version,
       prompt_fingerprint, config_fingerprint, profile_policy_fingerprint,
       custom_prompt_fingerprint, generator_settings_json, judge_settings_json,
       runtime_settings_json, rollback_of_version, rollback_reason, created_at,
       created_from_event_id
     ) VALUES (?, ?, 'tailor.v2', 'resume.v1', 'judge.v1', ?, ?, ?, ?, '{}', '{}',
               ?, ?, ?, ?, NULL)`,
  ).run(
    options.tenantId,
    options.version,
    "sha256:private-prompt",
    `sha256:config-${options.version}`,
    "sha256:private-profile",
    "sha256:private-custom",
    JSON.stringify({
      validation_mode: "normal",
      learned_tailoring_rules: options.learnedRules,
    }),
    options.rollbackOfVersion ?? null,
    options.rollbackReason ?? "",
    options.createdAt,
  );
}

function learningAuditSnapshot(db: Database.Database): string {
  return JSON.stringify(
    [
      "learning_recommendations",
      "learning_recommendation_evidence",
      "learning_recommendation_evidence_jobs",
      "learning_recommendation_jobs",
      "learning_recommendation_tombstones",
    ].map((table) => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]),
  );
}

function seedDatabase(dbPath: string): void {
  const artifactPath = path.join(path.dirname(dbPath), "ready-resume.txt");
  fs.writeFileSync(artifactPath, "hello world!");

  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  seedBuiltInResumeTemplate(db);

  insertJob(db, {
    url: "https://example.com/jobs/ready",
    title: "Platform Engineer",
    site: "ExampleCo",
    company: "ExampleCo",
    fitScore: 9,
    tailoredPath: artifactPath,
  });
  insertJob(db, {
    url: "https://example.com/jobs/failed-score",
    title: "Backend Engineer",
    site: "ExampleCo",
    company: "ExampleCo",
    fitScore: 8,
  });
  insertJob(db, {
    url: "https://example.com/jobs/blocked-tailor",
    title: "Frontend Engineer",
    site: "Acme",
    company: "Acme",
    fitScore: 6,
  });
  insertScore(db, "https://example.com/jobs/ready", 1, 9);
  insertScore(db, "https://example.com/jobs/failed-score", 1, 8);
  insertScore(db, "https://example.com/jobs/blocked-tailor", 1, 6);

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
    "INSERT INTO job_artifacts (tenant_id, job_id, stage, artifact_type, status, path, created_at, size_bytes) VALUES ('local', ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    jobIdFor("https://example.com/jobs/ready"),
    "tailor",
    "tailored_resume_txt",
    "active",
    artifactPath,
    "2026-04-29T10:05:00+00:00",
    12,
  );
  db.prepare(
    "INSERT INTO job_artifacts (tenant_id, job_id, stage, artifact_type, status, path, created_at, size_bytes) VALUES ('local', ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    jobIdFor("https://example.com/jobs/ready"),
    "tailor",
    "tailored_resume_pdf",
    "active",
    artifactPath,
    "2026-04-29T10:05:00+00:00",
    12,
  );
  db.prepare(
    "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at) VALUES ('local', ?, 1, ?, ?, ?, ?, ?)",
  ).run(
    jobIdFor("https://example.com/jobs/failed-score"),
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
    jobIdFor("https://example.com/jobs/ready"),
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
  // The unified Workflow Runs list reads `workflow_run_projections` (all
  // workflow types); apply runs are enriched with job context via the LEFT
  // JOIN to `apply_run_projections`. Seed the matching workflow row so the
  // apply run surfaces in the list with its job title/company/dry-run.
  db.prepare(
    "INSERT INTO workflow_run_projections (workflow_id, workflow_type, status, started_at, finished_at, temporal_run_id) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(
    "run-1",
    "ApplyWorkflow",
    "succeeded",
    "2026-04-29T10:15:00+00:00",
    "2026-04-29T10:20:00+00:00",
    "temporal-run-1",
  );
  db.close();
}

const DISCOVER_OLD_START = "2026-07-04T07:57:11.751+00:00";
const DISCOVER_TERMINATE_AT = "2026-07-04T11:16:55.314+00:00";
const DISCOVER_NEW_START = "2026-07-04T12:13:38.757+00:00";
const DISCOVER_NEW_START_DUP = "2026-07-04T12:13:38.776+00:00";
const DISCOVER_FAILED_AT = "2026-07-04T14:08:43.547+00:00";
const DISCOVER_OLD_TEMPORAL_RUN = "temporal-run-old-0001";
const DISCOVER_NEW_TEMPORAL_RUN = "019f2d0c-7441-7641-ae61-b7f6f5b1127d";
const RECONCILED_MESSAGE =
  "The reconciler closed this run: its Temporal execution no longer exists on the server (dev-server history loss).";

function insertPipelineWorkflowEvent(
  db: Database.Database,
  event: {
    eventType: string;
    occurredAt: string;
    workflowId: string;
    temporalRunId?: string;
    status?: string;
    message?: string;
    errorCode?: string;
    errorMessage?: string;
    retryable?: boolean;
    startedAt?: string;
    finishedAt?: string;
    durationMs?: number;
    inputSummary?: Record<string, unknown>;
    recoveredFromMissingHistory?: boolean;
  },
): void {
  const payload: Record<string, unknown> = {
    workflowId: event.workflowId,
    workflowType: "DiscoverWorkflow",
  };
  for (const [key, value] of Object.entries(event)) {
    if (key === "eventType" || key === "occurredAt" || key === "workflowId" || key === "message") continue;
    if (value !== undefined) payload[key] = value;
  }
  db.prepare(
    "INSERT INTO job_events (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json) VALUES ('local', NULL, 1, ?, ?, ?, ?, ?, ?)",
  ).run("workflow", event.eventType, "info", event.message ?? null, event.occurredAt, JSON.stringify(payload));
}

function insertDiscoverWorkflowRunRow(
  db: Database.Database,
  row: {
    workflowId?: string;
    workflowType?: string;
    status: string;
    errorCode?: string | null;
    errorMessage?: string | null;
    retryable?: boolean;
    startedAt?: string | null;
    finishedAt?: string | null;
    durationMs?: number | null;
    temporalRunId?: string | null;
    eventsJson?: string;
    inputSummary?: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO workflow_run_projections (
       workflow_id, tenant_id, workflow_type, status, input_summary_json,
       error_code, error_message, retryable, started_at, finished_at,
       duration_ms, temporal_run_id, events_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.workflowId ?? "discover-local",
    "local",
    row.workflowType ?? "DiscoverWorkflow",
    row.status,
    JSON.stringify(row.inputSummary ?? { limit: 1000 }),
    row.errorCode ?? null,
    row.errorMessage ?? null,
    row.retryable ? 1 : 0,
    row.startedAt ?? null,
    row.finishedAt ?? null,
    row.durationMs ?? null,
    row.temporalRunId ?? DISCOVER_NEW_TEMPORAL_RUN,
    row.eventsJson ?? "[]",
  );
}

function insertWorkerHeartbeat(
  dbPath: string,
  heartbeat: {
    workerId: string;
    appDir: string;
    dbPath: string;
    lastSeenAt: string;
    maxConcurrentActivities?: number | null;
    activityExecutorMaxWorkers?: number | null;
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
      last_seen_at TEXT NOT NULL,
      max_concurrent_activities INTEGER,
      activity_executor_max_workers INTEGER
    );
  `);
  db.prepare(
    `INSERT INTO worker_runtime_heartbeats
      (worker_id, component, pid, hostname, app_dir, db_path, task_queue, started_at, last_seen_at,
       max_concurrent_activities, activity_executor_max_workers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    heartbeat.workerId,
    "temporal-worker",
    1234,
    "localhost",
    heartbeat.appDir,
    heartbeat.dbPath,
    "jobctrl-default",
    "2026-05-20T10:00:00.000Z",
    heartbeat.lastSeenAt,
    heartbeat.maxConcurrentActivities ?? 8,
    heartbeat.activityExecutorMaxWorkers ?? 10,
  );
  db.close();
}

function insertJob(
  db: Database.Database,
  job: {
    url: string;
    title: string;
    site: string;
    company?: string;
    fitScore?: number | null;
    scoredAt?: string | null;
    tailoredPath?: string;
    description?: string;
    fullDescription?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (
      tenant_id, job_id, url, title, site, company, strategy, location, salary, discovered_at, application_url,
      description, full_description, detail_scraped_at, fit_score, score_reasoning,
      scored_at, tailored_resume_path, tailored_at
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobIdFor(job.url),
    job.url,
    job.title,
    job.site,
    job.company ?? null,
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

function jobIdFor(jobUrl: string): string {
  const digest = createHash("sha256").update(jobUrl).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function insertEnrichment(
  db: Database.Database,
  jobUrl: string,
  fullDescription = "Canonical enriched description",
): void {
  db.prepare(
    `INSERT INTO job_enrichments (
       tenant_id, job_id, current_status, full_description, application_url,
       enriched_at, extraction_tier, attempts_json, updated_at
     ) VALUES ('local', ?, 'enriched', ?, ?, ?, 'css_selectors', '[]', ?)`,
  ).run(
    jobIdFor(jobUrl),
    fullDescription,
    jobUrl,
    "2026-04-29T10:01:00+00:00",
    "2026-04-29T10:01:00+00:00",
  );
}

function insertPostedCompensationFact(db: Database.Database, jobUrl: string): void {
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
      tenant_id, job_id, source_field, source_text, legacy_raw_salary,
      parse_state, currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
      confidence, warnings_json, parser_version, source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobIdFor(jobUrl),
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

function insertUnannualizedPostedCompensationFact(db: Database.Database, jobUrl: string): void {
  db.prepare(
    `INSERT INTO job_posted_compensation_facts (
      tenant_id, job_id, source_field, source_text, legacy_raw_salary,
      parse_state, currency, period, component, minimum_amount, maximum_amount,
      annualized_minimum_amount, annualized_maximum_amount, annualization_assumption,
      confidence, warnings_json, parser_version, source_hash, parsed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobIdFor(jobUrl),
    "jobs.full_description",
    "EUR 120000-130000",
    "EUR 120000-130000",
    "parsed_range",
    "EUR",
    "unknown",
    "base_salary",
    120_000,
    130_000,
    null,
    null,
    null,
    "low",
    "[]",
    "posted-compensation-v1",
    "c".repeat(64),
    "2026-06-19T10:00:30Z",
  );
}

function insertMarketCompensationEstimate(db: Database.Database, jobUrl: string): void {
  db.prepare(
    `INSERT INTO job_market_compensation_estimates (
      tenant_id, job_id, estimate_state, currency, period, component,
      minimum_amount, maximum_amount, confidence_band, confidence_score,
      source_count, sample_count, aggregate_bucket, geography_scope,
      occupation_code, occupation_label, seniority_label, source_snapshot_json,
      factor_reasons_json, insufficient_reasons_json, unsupported_reasons_json,
      source_unavailable_reasons_json, warnings_json, estimator_version, estimated_at,
      company_name, normalized_company, role_title, normalized_role, company_tier, match_scope
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    jobIdFor(jobUrl),
    "estimated_range",
    "EUR",
    "year",
    "total_compensation",
    112_000,
    142_000,
    "medium",
    0.82,
    2,
    7,
    "reported company-role compensation",
    "Europe",
    "example",
    "platform engineer",
    "senior",
    JSON.stringify([
      {
        source_id: "levels_fyi",
        display_name: "Levels.fyi",
        source_type: "reported_compensation",
        release_year: 2026,
        snapshot_version: "reported-compensation-import-v1",
        geography_scope: "Europe",
        aggregate_bucket: "reported company-role compensation",
        attribution: "Levels.fyi reported compensation data",
        sample_count: 4,
      },
      {
        source_id: "glassdoor",
        display_name: "Glassdoor",
        source_type: "reported_compensation",
        release_year: 2026,
        snapshot_version: "reported-compensation-import-v1",
        geography_scope: "Europe",
        aggregate_bucket: "reported company-role compensation",
        attribution: "Glassdoor reported compensation data",
        sample_count: 3,
      },
    ]),
    JSON.stringify([
      { name: "company", score: 1, band: "high", reason: "Company matched." },
      { name: "role", score: 1, band: "high", reason: "Role matched." },
    ]),
    "[]",
    "[]",
    "[]",
    JSON.stringify(["reported_compensation_sample"]),
    "company-role-reported-compensation-v1",
    "2026-06-19T10:00:00Z",
    "Example",
    "example",
    "Senior Platform Engineer",
    "platform engineer",
    "tier_2_ambitious",
    "exact_company_role",
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
      tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
    scored_at, correction_json, criteria_json, trace_json
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobIdFor(jobUrl),
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

function insertScoreKeyword(
  db: Database.Database,
  jobUrl: string,
  scoreVersion: number,
  normalizedKeyword: string,
  displayKeyword: string,
  position: number,
): void {
  db.prepare(
    `INSERT INTO job_score_keywords (
       tenant_id, job_id, score_version, normalized_keyword, display_keyword, position
     ) VALUES ('local', ?, ?, ?, ?, ?)`,
  ).run(jobIdFor(jobUrl), scoreVersion, normalizedKeyword, displayKeyword, position);
}

function createScoreStalenessTable(db: Database.Database): void {
  void db;
}

function createMaterialsTables(db: Database.Database): void {
  void db;
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
       tenant_id, job_id, generation, bullet_id, artifact_id, section, source_id,
       evidence_ids_json, requirement_ids_json, matched_keywords_json,
       transform_type, control, rationale, generated_text, position, created_at,
       coverage_json, voice_json
     ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobIdFor(row.jobUrl),
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
       tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
     ) VALUES ('local', ?, 1, ?, ?, ?, ?)`,
  ).run(
    jobIdFor(artifact.jobUrl),
    artifact.status === "suppressed" ? "suppressed" : "resume_approved",
    "2026-05-26T10:00:00+00:00",
    "2026-05-26T10:00:00+00:00",
    "{}",
  );
  db.prepare(
    `INSERT OR REPLACE INTO job_materials_artifacts (
       tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
       render_format, size_bytes, metadata_json, created_at
     ) VALUES ('local', ?, 1, ?, ?, ?, ?, 'text', ?, ?, ?)`,
  ).run(
    jobIdFor(artifact.jobUrl),
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
      tenant_id, job_id, stage, state, attempt_count, max_attempts, updated_at,
      error_code, error_message, retryable, blocked_by_json
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobIdFor(jobUrl),
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
