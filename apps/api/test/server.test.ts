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
      dbPath: options.dbPath,
      dbExists: true,
    });

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
    const dispatch = vi.fn(async () => ({ status: "queued" }));
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
      failures: 1,
      blocked: 1,
      ready: 1,
      applied: 0,
      dryRuns: 1,
    });
    expect(body.funnel.find((stage: { stage: string }) => stage.stage === "score")).toMatchObject({
      failed: 1,
      succeeded: 2,
      blocked: 0,
    });
    expect(body.activity[0]).toMatchObject({
      eventId: "1",
      jobKey: "https://example.com/jobs/failed-score",
      title: "Backend Engineer",
      company: "ExampleCo",
      stage: "score",
      level: "error",
    });
    expect(body.applyRuns[0]).toMatchObject({ runId: "run-1", dryRun: true });

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
    });

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
      "pdf",
      "apply",
    ]);
    expect(body.artifacts[0]).toMatchObject({
      type: "tailored_resume_txt",
      status: "active",
      size: "12b",
    });

    await app.close();
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
      expect.objectContaining({ appDir: tempDir }),
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
      payload: { stage: "pdf", runAfter: true, dryRun: true },
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
    const pdfStage = db
      .prepare("SELECT state FROM job_stage_states WHERE job_url = ? AND stage = ?")
      .get("https://example.com/jobs/ready", "pdf") as { state: string };
    db.close();
    expect(pdfStage.state).toBe("succeeded");

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
        { appDir: tempDir },
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
        { appDir: tempDir },
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
      expect.objectContaining({ appDir: tempDir }),
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
        limit: 12,
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
    expect(response.json()).toMatchObject({
      ok: true,
      action: "run_stage",
      status: "queued",
      jobKey: "pipeline",
      count: 3,
      actions: [
        {
          action: "run_stage",
          status: "queued",
          jobKey: "pipeline",
          command: {
            action: "run_stage",
            jobKey: "pipeline",
            stage: "score",
            limit: 12,
            workers: 3,
            minScore: 8,
            validationMode: "strict",
            dryRun: true,
            rescore: true,
          },
        },
        {
          action: "run_stage",
          command: {
            stage: "tailor",
            retailor: true,
          },
        },
        {
          action: "apply",
          command: {
            action: "apply",
            stage: "apply",
            dryRun: true,
            headless: true,
            model: "sonnet",
            continuous: true,
          },
        },
      ],
    });
    await waitForExpectation(() => expect(dispatch).toHaveBeenCalledTimes(3));
    expect(dispatch).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ action: "run_stage", stage: "score", jobKey: "pipeline" }),
      expect.objectContaining({ appDir: tempDir }),
    );
    expect(dispatch).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({ action: "apply", stage: "apply", dryRun: true, jobKey: "pipeline" }),
      expect.objectContaining({ appDir: tempDir }),
    );

    await app.close();
  });

  it("returns synchronous non-apply global stage results as 200", async () => {
    const dispatch = vi.fn(async () => ({
      status: "dry_run",
      actionId: "act-worker-score",
      result: { planned: 4 },
    }));
    const app = buildApp({ ...options, actionDispatcher: dispatch });

    const response = await app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["score"], dryRun: true },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      status: "dry_run",
      count: 1,
      actions: [
        {
          action: "run_stage",
          actionId: "act-worker-score",
          runId: "act-worker-score",
          status: "dry_run",
          result: { planned: 4 },
          command: { action: "run_stage", stage: "score", dryRun: true },
        },
      ],
    });
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "run_stage", stage: "score", jobKey: "pipeline" }),
      expect.objectContaining({ appDir: tempDir }),
    );

    await app.close();
  });

  it("runs selected non-apply global stages sequentially before queuing apply", async () => {
    const dispatches = {
      score: deferred<ActionDispatchResult>(),
      tailor: deferred<ActionDispatchResult>(),
      apply: deferred<ActionDispatchResult>(),
    };
    const dispatch = vi.fn((command: ActionCommandPayload) => {
      if (command.stage === "score") return dispatches.score.promise;
      if (command.stage === "tailor") return dispatches.tailor.promise;
      if (command.stage === "apply") return dispatches.apply.promise;
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
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ action: "run_stage", stage: "score" });

      dispatches.score.resolve({ status: "dry_run", actionId: "act-score", result: { planned: 2 } });
      await waitForExpectation(() => expect(dispatch).toHaveBeenCalledTimes(2));
      expect(dispatch.mock.calls[1]?.[0]).toMatchObject({ action: "run_stage", stage: "tailor" });

      dispatches.tailor.resolve({ status: "succeeded", actionId: "act-tailor", result: { updated: 2 } });
      await waitForExpectation(() => expect(dispatch).toHaveBeenCalledTimes(3));
      expect(dispatch.mock.calls[2]?.[0]).toMatchObject({ action: "apply", stage: "apply", dryRun: true });

      dispatches.apply.resolve({ status: "queued", actionId: "act-apply", runId: "run-apply" });
      const response = await responsePromise;
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        ok: true,
        status: "accepted",
        count: 3,
        actions: [
          {
            action: "run_stage",
            actionId: "act-score",
            status: "dry_run",
            result: { planned: 2 },
            command: { action: "run_stage", stage: "score", dryRun: true },
          },
          {
            action: "run_stage",
            actionId: "act-tailor",
            status: "succeeded",
            result: { updated: 2 },
            command: { action: "run_stage", stage: "tailor", dryRun: true },
          },
          {
            action: "apply",
            actionId: "act-apply",
            runId: "run-apply",
            status: "queued",
            command: { action: "apply", stage: "apply", dryRun: true },
          },
        ],
      });
    } finally {
      dispatches.score.resolve({ status: "dry_run", actionId: "act-score" });
      dispatches.tailor.resolve({ status: "succeeded", actionId: "act-tailor" });
      dispatches.apply.resolve({ status: "queued", actionId: "act-apply", runId: "run-apply" });
      await responsePromise.catch(() => undefined);
      await app.close();
    }
  });

  it("queues apply only after preceding non-apply global stages resolve", async () => {
    const scoreDispatch = deferred<ActionDispatchResult>();
    const applyDispatch = deferred<ActionDispatchResult>();
    const dispatch = vi.fn((command: ActionCommandPayload) => {
      if (command.action === "run_stage") {
        return scoreDispatch.promise;
      }
      return applyDispatch.promise;
    });
    const app = buildApp({ ...options, actionDispatcher: dispatch });
    const responsePromise = app.inject({
      method: "POST",
      url: "/v1/pipeline/actions/run-stage",
      payload: { stages: ["score", "apply"], dryRun: true },
    });

    try {
      await waitForExpectation(() => expect(dispatch).toHaveBeenCalledTimes(1));
      expect(dispatch.mock.calls[0]?.[0]).toMatchObject({ action: "run_stage", stage: "score" });

      const earlyResponse = await Promise.race([
        responsePromise,
        new Promise<"not-yet">((resolve) => setTimeout(() => resolve("not-yet"), 50)),
      ]);
      expect(earlyResponse).toBe("not-yet");

      scoreDispatch.resolve({ status: "succeeded", actionId: "act-score", result: { updated: 1 } });
      await waitForExpectation(() => expect(dispatch).toHaveBeenCalledTimes(2));
      expect(dispatch.mock.calls[1]?.[0]).toMatchObject({ action: "apply", stage: "apply" });

      applyDispatch.resolve({ status: "queued", actionId: "act-apply", runId: "run-apply" });
      const response = await responsePromise;
      expect(response.statusCode, response.body).toBe(202);
      expect(response.json()).toMatchObject({
        ok: true,
        status: "accepted",
        count: 2,
        actions: [
          {
            action: "run_stage",
            actionId: "act-score",
            status: "succeeded",
            result: { updated: 1 },
            command: { action: "run_stage", stage: "score", dryRun: true },
          },
          {
            action: "apply",
            status: "queued",
            jobKey: "pipeline",
            actionId: "act-apply",
            runId: "run-apply",
            command: { action: "apply", stage: "apply", dryRun: true },
          },
        ],
      });
      expect(dispatch.mock.calls.map(([command]) => command.action)).toEqual(["run_stage", "apply"]);
    } finally {
      scoreDispatch.resolve({ status: "succeeded", actionId: "act-score" });
      applyDispatch.resolve({ status: "queued", actionId: "act-apply", runId: "run-apply" });
      await responsePromise.catch(() => undefined);
      await app.close();
    }
  });

  it("does not return accepted when mixed apply dispatch fails", async () => {
    const dispatch = vi.fn(async (command: ActionCommandPayload): Promise<ActionDispatchResult> => {
      if (command.action === "run_stage") {
        return { status: "succeeded", actionId: "act-score", result: { updated: 1 } };
      }
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
      count: 2,
      actions: [
        {
          action: "run_stage",
          actionId: "act-score",
          status: "succeeded",
          result: { updated: 1 },
          command: { action: "run_stage", stage: "score", dryRun: true },
        },
        {
          action: "apply",
          status: "failed",
          message: "Temporal workflow start failed.",
          result: { code: "TEMPORAL_UNAVAILABLE" },
          command: { action: "apply", stage: "apply", dryRun: true },
        },
      ],
    });
    expect(dispatch.mock.calls.map(([command]) => command.action)).toEqual(["run_stage", "apply"]);

    await app.close();
  });

  it("defaults global apply stage starts to dry-run when dryRun is omitted", async () => {
    const dispatch = vi.fn(async () => ({ status: "queued", actionId: "act-apply", runId: "run-apply" }));
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
          action: "apply",
          actionId: "act-apply",
          runId: "run-apply",
          status: "queued",
          command: { dryRun: true, limit: 25, workers: 1, minScore: 7 },
        },
      ],
    });
    await waitForExpectation(() => expect(dispatch).toHaveBeenCalled());
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ action: "apply", dryRun: true, jobKey: "pipeline" }),
      expect.objectContaining({ appDir: tempDir }),
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
      expect.objectContaining({ appDir: tempDir }),
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
      expect.objectContaining({ appDir: tempDir }),
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
      level TEXT,
      message TEXT,
      occurred_at TEXT
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

  for (const stage of ["discover", "enrich", "score", "tailor", "cover", "pdf"]) {
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
  db.prepare("INSERT INTO job_events (job_url, stage, level, message, occurred_at) VALUES (?, ?, ?, ?, ?)").run(
    "https://example.com/jobs/failed-score",
    "score",
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
