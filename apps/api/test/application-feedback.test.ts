import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureApplicationFeedbackTables } from "../src/application-feedback.js";
import { GmailFeedbackScanError, type GmailFeedbackScanner } from "../src/gmail-feedback-worker.js";
import { type ActionDispatcher, type ActionDispatchResult } from "../src/local-actions.js";
import { type BuildAppOptions, buildApp } from "../src/server.js";

const READY_JOB = "https://example.com/jobs/apply-ready";
const DRY_RUN_JOB = "https://example.com/jobs/apply-dry-run";
const APPLIED_JOB = "https://example.com/jobs/already-applied";
const NOW = "2026-06-01T10:00:00.000Z";

let tempDir = "";
let options: BuildAppOptions;
let actionDispatcher: ReturnType<typeof vi.fn> & ActionDispatcher;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-feedback-api-"));
  actionDispatcher = vi.fn(async (): Promise<ActionDispatchResult> => ({
    status: "queued",
    runId: "unexpected-run",
  })) as ReturnType<typeof vi.fn> & ActionDispatcher;
  options = {
    dbPath: path.join(tempDir, "jobhunter.db"),
    profilePath: path.join(tempDir, "profile.json"),
    resumeStylePath: path.join(tempDir, "resume_style.json"),
    resumeTemplatePath: path.join(tempDir, "resume_template.tex"),
    settingsPath: path.join(tempDir, "dashboard.json"),
    actionDispatcher,
  };
  seedDatabase(options.dbPath);
});

afterEach(() => {
  fs.rmSync(tempDir, { force: true, recursive: true });
});

describe("application feedback API", () => {
  it("lists only apply-review eligible jobs with readiness and latest run context", async () => {
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json();
    expect(body.items.map((item: { jobKey: string }) => item.jobKey)).toEqual([
      READY_JOB,
      DRY_RUN_JOB,
    ]);
    expect(body.items[0]).toMatchObject({
      jobKey: READY_JOB,
      title: "Principal Platform Engineer",
      currentStage: "apply",
      currentState: "pending",
      materials: {
        hasResume: true,
        ready: true,
      },
      position: {
        descriptionPreview: "Full description",
        requirements: ["platform leadership", "public company scale", "incident leadership"],
        matched: ["platform leadership"],
        missing: ["public company scale"],
        transferable: ["incident leadership"],
        keywords: ["platform", "leadership"],
      },
      materialsPreview: {
        resumeText: "tailored resume",
        resumePdfArtifactId: "apply-ready-resume-pdf",
        coverLetterText: null,
      },
      latestApplyRun: {
        runId: "dry-run-ready",
        dryRun: true,
      },
      review: {
        state: "pending",
      },
      blockers: [],
    });

    await app.close();
  });

  it("uses stage error messages instead of generic blocker codes in the review queue", async () => {
    const db = new Database(options.dbPath);
    db.prepare(
      `
      UPDATE job_stage_states
         SET state = 'failed',
             error_code = 'FAILED',
             error_message = 'SKIPPED: process killed by signal'
       WHERE job_url = ?
         AND stage = 'apply'
      `,
    ).run(READY_JOB);
    db.close();
    const app = buildApp(options);

    const response = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });

    expect(response.statusCode, response.body).toBe(200);
    expect(queueItem(response.json(), READY_JOB)).toMatchObject({
      currentStage: "apply",
      currentState: "failed",
      blockers: ["SKIPPED: process killed by signal"],
    });

    await app.close();
  });

  it("records approve, defer, reset, and decline review decisions without dispatching apply", async () => {
    const app = buildApp(options);
    const readyKey = encodeURIComponent(READY_JOB);
    const dryRunKey = encodeURIComponent(DRY_RUN_JOB);

    const approve = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: { decision: "approve_submit", reason: "Looks complete." },
    });
    expect(approve.statusCode, approve.body).toBe(200);
    expect(approve.json()).toMatchObject({
      ok: true,
      decision: {
        jobKey: READY_JOB,
        decision: "approve_submit",
      },
    });
    expect(actionDispatcher).not.toHaveBeenCalled();

    const afterApprove = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
    expect(queueItem(afterApprove.json(), READY_JOB)).toMatchObject({
      review: { state: "approved_submit", decision: "approve_submit" },
    });

    const defer = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: { decision: "defer", reason: "Wait for salary details." },
    });
    expect(defer.statusCode, defer.body).toBe(200);
    const afterDefer = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
    expect(queueItem(afterDefer.json(), READY_JOB)).toBeUndefined();

    const reset = await app.inject({
      method: "POST",
      url: `/v1/jobs/${readyKey}/apply-review/decision`,
      payload: { decision: "reset" },
    });
    expect(reset.statusCode, reset.body).toBe(200);
    const afterReset = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
    expect(queueItem(afterReset.json(), READY_JOB)).toMatchObject({
      review: { state: "pending", decision: "reset" },
    });

    const approveDryRun = await app.inject({
      method: "POST",
      url: `/v1/jobs/${dryRunKey}/apply-review/decision`,
      payload: { decision: "approve_dry_run" },
    });
    expect(approveDryRun.statusCode, approveDryRun.body).toBe(200);

    const decline = await app.inject({
      method: "POST",
      url: `/v1/jobs/${dryRunKey}/apply-review/decision`,
      payload: { decision: "decline" },
    });
    expect(decline.statusCode, decline.body).toBe(200);
    const afterDecline = await app.inject({ method: "GET", url: "/v1/apply/review-queue" });
    expect(queueItem(afterDecline.json(), DRY_RUN_JOB)).toBeUndefined();

    await app.close();
  });

  it("writes manual outcomes and reads job/global outcome timelines", async () => {
    const app = buildApp(options);
    const note = "private outcome note that should stay out of event payloads";

    const write = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
      payload: {
        kind: "interview",
        occurredAt: "2026-06-01T11:00:00.000Z",
        note,
      },
    });

    expect(write.statusCode, write.body).toBe(200);
    const outcome = write.json().outcome;
    expect(outcome).toMatchObject({
      jobKey: READY_JOB,
      kind: "interview",
      source: "manual",
      note,
    });

    const jobOutcomes = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
    });
    expect(jobOutcomes.statusCode, jobOutcomes.body).toBe(200);
    expect(jobOutcomes.json()).toMatchObject({
      ok: true,
      jobKey: READY_JOB,
      outcomes: [expect.objectContaining({ outcomeId: outcome.outcomeId, note })],
    });

    const allOutcomes = await app.inject({ method: "GET", url: "/v1/outcomes" });
    expect(allOutcomes.statusCode, allOutcomes.body).toBe(200);
    expect(allOutcomes.json().outcomes).toEqual([
      expect.objectContaining({ outcomeId: outcome.outcomeId, jobKey: READY_JOB }),
    ]);

    expect(eventPayloadText(options.dbPath)).not.toContain(note);
    await app.close();
  });

  it("runs Gmail outcome scan through the worker and returns only safe summary fields", async () => {
    const rawBody = "raw private Gmail body must not leave the worker boundary";
    const gmailFeedbackScanner = vi.fn(async () => ({
      ok: true,
      scannedAnchorCount: 1,
      searchedMessageCount: 2,
      linkedEvidenceCount: 1,
      suggestionsCreatedCount: 1,
      duplicateMessageCount: 0,
      unlinkedCandidateCount: 1,
      evidence: [
        {
          evidenceId: "evidence-1",
          jobKey: READY_JOB,
          providerMessageId: "gmail-message-1",
          linkConfidence: 0.94,
          bodyText: rawBody,
        },
      ],
      suggestions: [
        {
          suggestionId: "suggestion-1",
          evidenceId: "evidence-1",
          jobKey: READY_JOB,
          kind: "interview",
          confidence: 0.9,
          bodyText: rawBody,
        },
      ],
    })) as ReturnType<typeof vi.fn> & GmailFeedbackScanner;
    const app = buildApp({ ...options, gmailFeedbackScanner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/outcomes/gmail/scan",
      payload: {
        recipientEmail: "candidate@example.com",
        limit: 2,
        maxResultsPerAnchor: 3,
        windowDays: 14,
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(gmailFeedbackScanner).toHaveBeenCalledWith(
      {
        recipientEmail: "candidate@example.com",
        limit: 2,
        maxResultsPerAnchor: 3,
        windowDays: 14,
      },
      { appDir: tempDir, dbPath: options.dbPath },
    );
    expect(response.json()).toEqual({
      ok: true,
      scannedAnchorCount: 1,
      searchedMessageCount: 2,
      linkedEvidenceCount: 1,
      suggestionsCreatedCount: 1,
      duplicateMessageCount: 0,
      unlinkedCandidateCount: 1,
      evidence: [
        {
          evidenceId: "evidence-1",
          jobKey: READY_JOB,
          providerMessageId: "gmail-message-1",
          linkConfidence: 0.94,
        },
      ],
      suggestions: [
        {
          suggestionId: "suggestion-1",
          evidenceId: "evidence-1",
          jobKey: READY_JOB,
          kind: "interview",
          confidence: 0.9,
        },
      ],
    });
    expect(response.body).not.toContain(rawBody);

    await app.close();
  });

  it("maps Gmail outcome worker errors without exposing raw body fields", async () => {
    const gmailFeedbackScanner = vi.fn(async () => {
      throw new GmailFeedbackScanError("missing Gmail token at local auth path", 503);
    }) as ReturnType<typeof vi.fn> & GmailFeedbackScanner;
    const app = buildApp({ ...options, gmailFeedbackScanner });

    const response = await app.inject({
      method: "POST",
      url: "/v1/outcomes/gmail/scan",
      payload: { limit: 1 },
    });

    expect(response.statusCode, response.body).toBe(503);
    expect(response.json()).toEqual({
      ok: false,
      error: "gmail_feedback_scan_failed",
      message: "missing Gmail token at local auth path",
    });

    await app.close();
  });

  it("rejects non-timestamp outcome dates before they reach event payloads", async () => {
    seedOutcomeSuggestion(options.dbPath);
    const app = buildApp(options);
    const privateTimestampText = "confidential recruiter feedback in a timestamp field";

    const manual = await app.inject({
      method: "POST",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
      payload: {
        kind: "interview",
        occurredAt: privateTimestampText,
        note: "manual note",
      },
    });
    expect(manual.statusCode, manual.body).toBe(400);

    const suggestion = await app.inject({
      method: "POST",
      url: "/v1/outcome-suggestions/suggestion-1/decision",
      payload: {
        decision: "accept",
        occurredAt: privateTimestampText,
      },
    });
    expect(suggestion.statusCode, suggestion.body).toBe(400);

    expect(eventPayloadText(options.dbPath)).not.toContain(privateTimestampText);
    expect(eventPayloadText(options.dbPath)).not.toContain("manual note");

    await app.close();
  });

  it("returns not found for outcome reads on missing jobs", async () => {
    const app = buildApp(options);

    const response = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent("https://example.com/jobs/missing")}/outcomes`,
    });

    expect(response.statusCode, response.body).toBe(404);
    expect(response.json()).toEqual({ ok: false, error: "job_not_found" });

    await app.close();
  });

  it("accepts outcome suggestions without copying raw note or email body text into events", async () => {
    seedOutcomeSuggestion(options.dbPath);
    const app = buildApp(options);
    const privateNote = "private accepted suggestion note";
    const rawBody = "raw confidential email body";

    const response = await app.inject({
      method: "POST",
      url: "/v1/outcome-suggestions/suggestion-1/decision",
      payload: {
        decision: "accept",
        note: privateNote,
        reason: "Confirmation looks linked.",
      },
    });

    expect(response.statusCode, response.body).toBe(200);
    const acceptedOutcomeId = response.json().outcome.outcomeId;
    expect(response.json()).toMatchObject({
      ok: true,
      suggestion: {
        suggestionId: "suggestion-1",
        status: "accepted",
        decidedOutcomeId: expect.any(String),
      },
      outcome: {
        jobKey: READY_JOB,
        kind: "applied_confirmation",
        source: "email_suggestion",
        note: privateNote,
      },
    });

    const repeated = await app.inject({
      method: "POST",
      url: "/v1/outcome-suggestions/suggestion-1/decision",
      payload: {
        decision: "accept",
        note: "second private note must not create a second outcome",
      },
    });

    expect(repeated.statusCode, repeated.body).toBe(200);
    expect(repeated.json()).toMatchObject({
      ok: true,
      suggestion: {
        suggestionId: "suggestion-1",
        status: "accepted",
        decidedOutcomeId: acceptedOutcomeId,
      },
      outcome: {
        outcomeId: acceptedOutcomeId,
      },
    });

    const jobOutcomes = await app.inject({
      method: "GET",
      url: `/v1/jobs/${encodeURIComponent(READY_JOB)}/outcomes`,
    });
    expect(jobOutcomes.json().outcomes).toHaveLength(1);
    expect(jobOutcomes.json().suggestions).toEqual([
      expect.objectContaining({ suggestionId: "suggestion-1", status: "accepted" }),
    ]);

    const payloads = eventPayloadText(options.dbPath);
    expect(payloads).not.toContain(privateNote);
    expect(payloads).not.toContain(rawBody);

    await app.close();
  });
});

function queueItem(body: unknown, jobKey: string): unknown {
  const items = (body as { items?: Array<{ jobKey: string }> }).items ?? [];
  return items.find((item) => item.jobKey === jobKey);
}

function seedDatabase(dbPath: string): void {
  const resumePath = path.join(path.dirname(dbPath), "resume.txt");
  const resumePdfPath = path.join(path.dirname(dbPath), "resume.pdf");
  const rejectedResumePdfPath = path.join(path.dirname(dbPath), "rejected-resume.pdf");
  fs.writeFileSync(resumePath, "tailored resume");
  fs.writeFileSync(resumePdfPath, "%PDF-1.4\n% test\n");
  fs.writeFileSync(rejectedResumePdfPath, "%PDF-1.4\n% rejected test\n");
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
    CREATE TABLE job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
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
    CREATE TABLE job_scores (
      job_url TEXT NOT NULL,
      version INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      fit_score INTEGER NOT NULL,
      breakdown_json TEXT NOT NULL,
      keywords_json TEXT NOT NULL,
      scored_at TEXT,
      correction_json TEXT NOT NULL DEFAULT '{}',
      criteria_json TEXT NOT NULL DEFAULT '{}',
      trace_json TEXT NOT NULL DEFAULT '{}',
      PRIMARY KEY (job_url, version)
    );
    CREATE TABLE job_materials (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL
    );
    CREATE TABLE job_materials_artifacts (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_id TEXT,
      artifact_type TEXT,
      status TEXT,
      path TEXT,
      created_at TEXT,
      size_bytes INTEGER
    );
  `);

  insertJob(db, {
    url: READY_JOB,
    title: "Principal Platform Engineer",
    site: "ExampleCo",
    fitScore: 9,
    resumePath,
    resumePdfPath,
    rejectedResumePdfPath,
    applyState: "pending",
  });
  insertJob(db, {
    url: DRY_RUN_JOB,
    title: "Staff Backend Engineer",
    site: "ExampleCo",
    fitScore: 8,
    resumePath,
    resumePdfPath,
    rejectedResumePdfPath,
    applyState: "pending",
  });
  insertJob(db, {
    url: APPLIED_JOB,
    title: "Already Applied Engineer",
    site: "ExampleCo",
    fitScore: 8,
    resumePath,
    resumePdfPath,
    rejectedResumePdfPath,
    applyState: "succeeded",
    appliedAt: "2026-05-31T10:00:00.000Z",
  });
  db.prepare(
    `INSERT INTO apply_run_projections (
       run_id, job_id, job_title, job_employer, status, result, dry_run, started_at, finished_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "dry-run-ready",
    READY_JOB,
    "Principal Platform Engineer",
    "ExampleCo",
    "dry_run_complete",
    "dry_run_complete",
    1,
    "2026-05-31T09:00:00.000Z",
    "2026-05-31T09:01:00.000Z",
  );
  db.close();
}

function insertJob(
  db: Database.Database,
  job: {
    url: string;
    title: string;
    site: string;
    fitScore: number;
    resumePath: string;
    resumePdfPath: string;
    rejectedResumePdfPath: string;
    applyState: string;
    appliedAt?: string;
  },
): void {
  db.prepare(
    `INSERT INTO jobs (
       url, title, site, strategy, location, salary, discovered_at, application_url,
       description, full_description, detail_scraped_at, fit_score, score_reasoning,
       scored_at, tailored_resume_path, tailored_at, apply_status, applied_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.url,
    job.title,
    job.site,
    "test",
    "Remote",
    "",
    NOW,
    job.url,
    "Short description",
    "Full description",
    NOW,
    job.fitScore,
    "Strong fit.",
    NOW,
    job.resumePath,
    NOW,
    job.appliedAt ? "applied" : null,
    job.appliedAt ?? null,
  );
  for (const stage of ["discover", "enrich", "score", "tailor", "cover"]) {
    insertStage(db, job.url, stage, "succeeded");
  }
  insertStage(db, job.url, "apply", job.applyState);
  insertScore(db, job.url, job.fitScore);
  insertMaterials(db, job.url, job.resumePath, job.resumePdfPath, job.rejectedResumePdfPath);
}

function insertMaterials(
  db: Database.Database,
  jobUrl: string,
  resumePath: string,
  resumePdfPath: string,
  rejectedResumePdfPath: string,
): void {
  const artifactPrefix =
    jobUrl === READY_JOB ? "apply-ready" : jobUrl === DRY_RUN_JOB ? "dry-run" : "already-applied";
  db.prepare("INSERT INTO job_materials (job_url, generation) VALUES (?, ?)").run(jobUrl, 1);
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobUrl, 1, `${artifactPrefix}-resume-text`, "tailored_resume", "approved", resumePath, NOW, 15);
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobUrl, 1, `${artifactPrefix}-resume-pdf`, "resume_pdf", "approved", resumePdfPath, NOW, 15);
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_url, generation, artifact_id, artifact_type, status, path, created_at, size_bytes
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobUrl,
    1,
    `${artifactPrefix}-rejected-resume-pdf`,
    "resume_pdf",
    "rejected",
    rejectedResumePdfPath,
    "2026-06-01T11:00:00.000Z",
    22,
  );
}

function insertScore(db: Database.Database, jobUrl: string, fitScore: number): void {
  db.prepare(
    `INSERT INTO job_scores (
       job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
       scored_at, correction_json, criteria_json, trace_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    jobUrl,
    1,
    "local",
    fitScore,
    JSON.stringify({
      reasoning: "Strong platform leadership fit.",
      technical_fit: 9,
      experience_fit: 8,
      role_fit: 8,
      fit_band: "strong",
      confidence: "high",
      eligibility: { status: "eligible", hard_blockers: [], warnings: [] },
      matched_signals: ["platform leadership"],
      missing_signals: ["public company scale"],
      transferable_signals: ["incident leadership"],
    }),
    JSON.stringify(["platform", "leadership"]),
    NOW,
    "{}",
    "{}",
    "{}",
  );
}

function insertStage(db: Database.Database, jobUrl: string, stage: string, state: string): void {
  db.prepare(
    `INSERT INTO job_stage_states (
       job_url, stage, state, attempt_count, max_attempts, updated_at,
       error_code, error_message, retryable, blocked_by_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(jobUrl, stage, state, 0, 3, NOW, null, null, 1, "[]");
}

function seedOutcomeSuggestion(dbPath: string): void {
  const db = new Database(dbPath);
  ensureApplicationFeedbackTables(db);
  db.prepare(
    `INSERT INTO application_email_evidence (
       tenant_id, evidence_id, job_key, provider, provider_message_id,
       provider_thread_id, from_address, to_addresses_json, subject, snippet,
       received_at, linked_at, link_confidence, link_signals_json,
       body_text, body_sha256, body_stored_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    "evidence-1",
    READY_JOB,
    "gmail",
    "gmail-message-1",
    "gmail-thread-1",
    "recruiting@example.com",
    JSON.stringify(["candidate@example.com"]),
    "Application received",
    "Thanks for applying.",
    "2026-06-01T09:00:00.000Z",
    "2026-06-01T09:05:00.000Z",
    0.94,
    JSON.stringify(["company", "title", "time_window"]),
    "raw confidential email body",
    "body-sha",
    "2026-06-01T09:05:00.000Z",
  );
  db.prepare(
    `INSERT INTO application_outcome_suggestions (
       tenant_id, suggestion_id, job_key, evidence_id, suggested_kind,
       confidence, rationale, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    "suggestion-1",
    READY_JOB,
    "evidence-1",
    "applied_confirmation",
    0.91,
    "Gmail subject and snippet look like an application confirmation.",
    "pending",
    "2026-06-01T09:06:00.000Z",
  );
  db.close();
}

function eventPayloadText(dbPath: string): string {
  const db = new Database(dbPath);
  try {
    const rows = db
      .prepare("SELECT payload_json FROM job_events ORDER BY event_id ASC")
      .all() as Array<{ payload_json: string | null }>;
    return rows.map((row) => row.payload_json ?? "").join("\n");
  } finally {
    db.close();
  }
}
