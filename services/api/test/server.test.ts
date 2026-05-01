import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildApp, type BuildAppOptions } from "../src/server.js";

let tempDir = "";
let options: BuildAppOptions;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-api-"));
  options = {
    dbPath: path.join(tempDir, "jobhunter.db"),
    profilePath: path.join(tempDir, "profile.json"),
    resumeStylePath: path.join(tempDir, "resume_style.json"),
    resumeTemplatePath: path.join(tempDir, "resume_template.tex"),
  };
  seedDatabase(options.dbPath);
  fs.writeFileSync(options.profilePath, JSON.stringify({ personal: { full_name: "Jordan Candidate" } }));
  fs.writeFileSync(options.resumeStylePath, JSON.stringify({ font_family: "moderncv" }));
  fs.writeFileSync(options.resumeTemplatePath, "\\documentclass{article}");
});

afterEach(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("local TypeScript API", () => {
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
    expect(body.activity[0]).toMatchObject({ stage: "score", level: "error" });
    expect(body.applyRuns[0]).toMatchObject({ runId: "run-1", dryRun: true });

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

  it("rejects malformed job detail routes before lookup", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/jobs/%E0%A4%A" });

    expect(response.statusCode, response.body).toBe(400);
    expect(response.json()).toMatchObject({ code: "FST_ERR_BAD_URL" });

    await app.close();
  });

  it("returns local profile, style, and template configuration", async () => {
    const app = buildApp(options);
    const response = await app.inject({ method: "GET", url: "/v1/profile" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      profile: { personal: { full_name: "Jordan Candidate" } },
      style: { font_family: "moderncv" },
      templateText: "\\documentclass{article}",
    });

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
    CREATE TABLE apply_runs (
      run_id TEXT,
      job_url TEXT,
      title TEXT,
      site TEXT,
      status TEXT,
      result TEXT,
      dry_run INTEGER,
      started_at TEXT
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
    "INSERT INTO apply_runs (run_id, job_url, title, site, status, result, dry_run, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
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
