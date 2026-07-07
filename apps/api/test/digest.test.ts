import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

import { ensureApplicationFeedbackTables, listApplyReviewQueue } from "../src/application-feedback.js";
import { ensureProjectionTables } from "../src/projections.js";
import { buildDigest, readDigestState } from "../src/read-model.js";
import { buildApp } from "../src/server.js";
import { describe, expect, it } from "vitest";

interface FixtureJob {
  jobId: string;
  title: string;
  employer: string;
  source: string;
  discoveredAt: string;
  scoredAt: string;
  fitScore: number;
  currentStage: string;
  currentState: string;
  hasResume: boolean;
  hasCoverLetter: boolean;
  hasPdf: boolean;
  applicationUrl: string;
  eligibilityStatus?: "eligible" | "warning" | "blocked" | "unknown";
  hidden?: boolean;
  activeState?: string;
}

interface DigestParityFixture {
  now: string;
  since: string;
  minFitScore: number;
  budget: {
    day: string;
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number;
    dailyBudgetUsd: number;
  };
  jobs: FixtureJob[];
  sourceQuality: Array<{
    sourceId: string;
    recommendedState: string;
    consecutiveFailures: number;
  }>;
  operationalAttempts: Array<{
    sourceId: string;
    stage: string;
    outcome: string;
    occurredAt: string;
  }>;
  applicationReviewDecisions: Array<{
    decisionId: string;
    jobKey: string;
    decision: string;
    decidedAt: string;
  }>;
  applyRuns: Array<{
    runId: string;
    jobId: string;
    status: string;
    result: string | null;
    dryRun: boolean;
    startedAt: string;
    finishedAt: string;
  }>;
  scoreStaleness: Array<{
    jobUrl: string;
    scoreVersion: number;
  }>;
  applicationOutcomes: Array<{
    outcomeId: string;
    jobKey: string;
    kind: string;
    occurredAt: string;
  }>;
  expected: {
    since: string;
    generatedAt: string;
    highFitThreshold: number;
    newMatches: { count: number; highFitCount: number };
    blockedSources: {
      count: number;
      sources: Array<{
        sourceId: string;
        recommendedState: string;
        consecutiveFailures: number;
      }>;
    };
    reviewNeededMaterials: { count: number };
    staleScores: { count: number };
    pendingApprovals: { count: number };
    followUpsDue: { count: number; thresholdDays: number; dayBoundary: "UTC" };
    budget: {
      status: "ok" | "over_budget";
      estimatedUsd: number;
      dailyBudgetUsd: number;
      remainingUsd: number | null;
      unlimited: boolean;
    };
  };
}

const fixturePath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/domain-types/test/fixtures/daily_digest_parity.json",
);
const fixture = JSON.parse(fs.readFileSync(fixturePath, "utf8")) as DigestParityFixture;

describe("daily digest read model", () => {
  it("builds the shared local digest fixture without advancing the acknowledge watermark", () => {
    const { dbPath, tempDir, cleanup } = makeTempDb();
    try {
      seedDigestDatabase(dbPath, tempDir);
      const db = new Database(dbPath);
      const before = readDigestState(db);

      const digest = buildDigest(db, {
        applyReviewQueue: listApplyReviewQueue(db),
        budget: {
          status: "over_budget",
          estimatedUsd: fixture.budget.estimatedUsd,
          dailyBudgetUsd: fixture.budget.dailyBudgetUsd,
          remainingUsd: 0,
          unlimited: false,
        },
        minFitScore: fixture.minFitScore,
        now: new Date(fixture.now),
      });

      expect(digest.ok).toBe(true);
      expect(digest.generatedAt).toBe(fixture.expected.generatedAt);
      expect(digest.since).toBe(fixture.expected.since);
      expect(digest.highFitThreshold).toBe(fixture.expected.highFitThreshold);
      expect(digest.newMatches).toEqual(fixture.expected.newMatches);
      expect(digest.blockedSources).toEqual(fixture.expected.blockedSources);
      expect(digest.reviewNeededMaterials).toEqual(fixture.expected.reviewNeededMaterials);
      expect(digest.staleScores).toEqual(fixture.expected.staleScores);
      expect(digest.pendingApprovals).toEqual(fixture.expected.pendingApprovals);
      expect(digest.followUpsDue).toEqual({ ...fixture.expected.followUpsDue, derived: true });
      expect(digest.budget).toEqual(fixture.expected.budget);
      expect(digest.deepLinks.newMatches).toContain(encodeURIComponent(fixture.since));
      expect(digest.deepLinks.newMatches).toContain("scoredSince=");
      expect(digest.deepLinks.budget).toBe("/settings");
      expect(readDigestState(db)).toEqual(before);
    } finally {
      cleanup();
    }
  });

  it("exposes GET /v1/digest as a passive read", async () => {
    const { dbPath, settingsPath, tempDir, cleanup } = makeTempDb();
    try {
      seedDigestDatabase(dbPath, tempDir);
      fs.writeFileSync(settingsPath, JSON.stringify({ min_fit_score: fixture.minFitScore }));
      const app = buildApp({ dbPath, settingsPath });

      const response = await app.inject({ method: "GET", url: "/v1/digest" });
      expect(response.statusCode).toBe(200);
      const digest = response.json() as { ok: true; since: string | null; newMatches: { count: number } };

      expect(digest.ok).toBe(true);
      expect(digest.since).toBe(fixture.expected.since);
      expect(digest.newMatches.count).toBe(fixture.expected.newMatches.count);

      const jobsResponse = await app.inject({
        method: "GET",
        url: `/v1/jobs?deleted=active&discoveredSince=${encodeURIComponent(
          fixture.since,
        )}&scoredSince=${encodeURIComponent(fixture.since)}`,
      });
      expect(jobsResponse.statusCode).toBe(200);
      const jobs = jobsResponse.json() as { items: Array<{ jobKey: string }> };
      expect(jobs.items).toHaveLength(fixture.expected.newMatches.count);
      expect(jobs.items.some((job) => job.jobKey === "https://example.com/jobs/post-watermark-scored")).toBe(
        true,
      );

      const db = new Database(dbPath);
      expect(readDigestState(db).lastAcknowledgedAt).toBe(fixture.since);
    } finally {
      cleanup();
    }
  });

  it("advances the watermark only through POST /v1/digest/acknowledge", async () => {
    const { dbPath, settingsPath, tempDir, cleanup } = makeTempDb();
    try {
      seedDigestDatabase(dbPath, tempDir);
      fs.writeFileSync(settingsPath, JSON.stringify({ min_fit_score: fixture.minFitScore }));
      const app = buildApp({ dbPath, settingsPath });

      const response = await app.inject({
        method: "POST",
        url: "/v1/digest/acknowledge",
        payload: { acknowledgedAt: fixture.now },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        ok: true,
        state: { lastAcknowledgedAt: fixture.now },
      });

      const db = new Database(dbPath);
      expect(readDigestState(db).lastAcknowledgedAt).toBe(fixture.now);
      const event = db
        .prepare(
          "SELECT event_type, payload_json FROM job_events WHERE event_type = 'DigestReviewed' ORDER BY event_id DESC LIMIT 1",
        )
        .get() as { event_type: string; payload_json: string } | undefined;
      expect(event?.event_type).toBe("DigestReviewed");
      expect(JSON.parse(event?.payload_json ?? "{}")).toMatchObject({
        tenantId: "local",
        acknowledgedAt: fixture.now,
        previousAcknowledgedAt: fixture.since,
      });

      const staleResponse = await app.inject({
        method: "POST",
        url: "/v1/digest/acknowledge",
        payload: { acknowledgedAt: fixture.since },
      });
      expect(staleResponse.statusCode).toBe(200);
      expect(staleResponse.json()).toMatchObject({
        ok: true,
        state: { lastAcknowledgedAt: fixture.now },
      });
      expect(readDigestState(db).lastAcknowledgedAt).toBe(fixture.now);
      db.close();
    } finally {
      cleanup();
    }
  });
});

function makeTempDb(): { dbPath: string; settingsPath: string; tempDir: string; cleanup: () => void } {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-api-digest-"));
  return {
    dbPath: path.join(tempDir, "jobctrl.db"),
    settingsPath: path.join(tempDir, "dashboard.json"),
    tempDir,
    cleanup: () => fs.rmSync(tempDir, { recursive: true, force: true }),
  };
}

function seedDigestDatabase(dbPath: string, tempDir: string): void {
  const db = new Database(dbPath);
  createDigestSchema(db);
  ensureProjectionTables(db);
  ensureApplicationFeedbackTables(db);
  seedJobs(db, tempDir);
  seedSourceQuality(db);
  seedOperationalAttempts(db);
  seedReviewDecisions(db);
  seedApplyRuns(db);
  seedScoreStaleness(db);
  seedApplicationOutcomes(db);
  db.prepare(
    "INSERT INTO digest_state (tenant_id, last_acknowledged_at, updated_at) VALUES ('local', ?, ?)",
  ).run(fixture.since, fixture.since);
  db.close();
}

function createDigestSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      company TEXT,
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
      apply_status TEXT,
      apply_error TEXT,
      applied_at TEXT
    );
    CREATE TABLE job_stage_states (
      job_url TEXT NOT NULL,
      stage TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER,
      started_at TEXT,
      updated_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT,
      duration_ms INTEGER,
      error_code TEXT,
      error_message TEXT,
      retryable INTEGER DEFAULT 1,
      blocked_by_json TEXT,
      next_action TEXT,
      metadata_json TEXT,
      version INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_url, stage)
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
    CREATE TABLE job_score_staleness (
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
    );
    CREATE TABLE job_materials (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (job_url, generation)
    );
    CREATE TABLE job_materials_artifacts (
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
    CREATE TABLE jobctrl_hidden_jobs (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      hidden_at TEXT NOT NULL,
      unhidden_at TEXT
    );
    CREATE TABLE posting_snapshot_sets (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      latest_active_state TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_url)
    );
    CREATE TABLE operational_attempt_metrics (
      metric_id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      occurred_at TEXT NOT NULL,
      stage TEXT NOT NULL,
      source_id TEXT,
      source_kind TEXT,
      source_priority TEXT,
      source_role TEXT,
      adapter TEXT,
      attempt_kind TEXT NOT NULL,
      outcome TEXT NOT NULL,
      failure_category TEXT,
      is_operational_failure INTEGER NOT NULL DEFAULT 0,
      is_scrape_failure INTEGER NOT NULL DEFAULT 0,
      is_retryable INTEGER NOT NULL DEFAULT 1,
      run_id TEXT,
      duration_ms INTEGER,
      error_class TEXT
    );
  `);
}

function seedJobs(db: Database.Database, tempDir: string): void {
  const insertJob = db.prepare(
    `INSERT INTO jobs (
       url, title, company, site, strategy, location, salary, discovered_at,
       application_url, description, full_description, detail_scraped_at,
       detail_error, fit_score, score_reasoning, scored_at, tailored_resume_path
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertScore = db.prepare(
    `INSERT INTO job_scores (
       job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
       scored_at, correction_json, criteria_json, trace_json
     ) VALUES (?, 1, 'local', ?, ?, ?, ?, NULL, '{}', '{}')`,
  );

  for (const job of fixture.jobs) {
    insertJob.run(
      job.jobId,
      job.title,
      job.employer,
      job.source,
      "digest-fixture",
      "Remote",
      "",
      job.discoveredAt,
      job.applicationUrl,
      "Digest fixture description.",
      "Digest fixture full description.",
      job.discoveredAt,
      null,
      job.fitScore,
      "Digest fixture score.",
      job.scoredAt,
      null,
    );
    const eligibilityStatus = job.eligibilityStatus ?? "eligible";
    const scoreBreakdown = {
      technical_fit: job.fitScore,
      experience_fit: job.fitScore,
      role_fit: job.fitScore,
      reasoning: "Digest fixture score.",
      eligibility: {
        status: eligibilityStatus,
        hardBlockers:
          eligibilityStatus === "blocked"
            ? ["Fixture eligibility blocker."]
            : [],
        warnings:
          eligibilityStatus === "warning"
            ? ["Fixture eligibility warning."]
            : [],
      },
      matched_signals: ["typescript"],
      missing_signals: [],
      transferable_signals: [],
    };
    insertScore.run(
      job.jobId,
      job.fitScore,
      JSON.stringify(scoreBreakdown),
      JSON.stringify(["typescript"]),
      job.scoredAt,
    );
    if (job.hidden) {
      db.prepare(
        "INSERT INTO jobctrl_hidden_jobs (tenant_id, job_url, hidden_at, unhidden_at) VALUES ('local', ?, ?, NULL)",
      ).run(job.jobId, fixture.now);
    }
    if (job.activeState) {
      db.prepare(
        "INSERT INTO posting_snapshot_sets (tenant_id, job_url, latest_active_state, updated_at) VALUES ('local', ?, ?, ?)",
      ).run(job.jobId, job.activeState, fixture.now);
    }
  }

  for (const job of fixture.jobs) {
    if (job.currentStage === "apply") {
      seedApplyStages(db, job.jobId);
    } else if (job.currentStage === "score") {
      seedScoreStages(db, job.jobId, job.currentState);
    } else {
      seedStage(db, job.jobId, "discover", job.currentState);
    }
    if (job.hasResume || job.hasPdf) {
      seedMaterials(db, tempDir, job);
    }
  }
}

function seedApplyStages(db: Database.Database, jobUrl: string): void {
  for (const stage of ["discover", "enrich", "score", "tailor", "cover"]) {
    seedStage(db, jobUrl, stage, "succeeded");
  }
  seedStage(db, jobUrl, "apply", "pending");
}

function seedScoreStages(db: Database.Database, jobUrl: string, scoreState: string): void {
  for (const stage of ["discover", "enrich"]) {
    seedStage(db, jobUrl, stage, "succeeded");
  }
  seedStage(db, jobUrl, "score", scoreState);
}

function seedStage(db: Database.Database, jobUrl: string, stage: string, state: string): void {
  db.prepare(
    `INSERT INTO job_stage_states (
       job_url, stage, state, attempt_count, max_attempts, updated_at, retryable
     ) VALUES (?, ?, ?, 1, 3, ?, 1)`,
  ).run(jobUrl, stage, state, fixture.now);
}

function seedMaterials(db: Database.Database, tempDir: string, job: FixtureJob): void {
  const generation = 1;
  db.prepare(
    `INSERT INTO job_materials (
       job_url, generation, tenant_id, status, created_at, updated_at
     ) VALUES (?, ?, 'local', 'approved', ?, ?)`,
  ).run(job.jobId, generation, fixture.now, fixture.now);

  if (job.hasResume) {
    const resumePath = path.join(tempDir, `${slug(job.jobId)}-resume.txt`);
    fs.writeFileSync(resumePath, `${job.title}\nDigest fixture resume.`);
    insertMaterialArtifact(db, job.jobId, generation, "tailored_resume", "text", resumePath);
  }
  if (job.hasPdf) {
    const pdfPath = path.join(tempDir, `${slug(job.jobId)}-resume.pdf`);
    fs.writeFileSync(pdfPath, "%PDF-1.4\nfixture\n");
    insertMaterialArtifact(db, job.jobId, generation, "resume_pdf", "pdf", pdfPath);
  }
}

function insertMaterialArtifact(
  db: Database.Database,
  jobUrl: string,
  generation: number,
  artifactType: string,
  renderFormat: string,
  artifactPath: string,
): void {
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       job_url, generation, artifact_type, artifact_id, status, path,
       render_format, size_bytes, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, 'approved', ?, ?, ?, '{}', ?)`,
  ).run(
    jobUrl,
    generation,
    artifactType,
    `${slug(jobUrl)}-${artifactType}`,
    artifactPath,
    renderFormat,
    fs.statSync(artifactPath).size,
    fixture.now,
  );
}

function seedSourceQuality(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO source_quality_stats (
       tenant_id, source_id, window_start, window_end, run_count,
       failed_run_count, consecutive_failures, observed_jobs, new_jobs,
       existing_jobs, duplicate_jobs, active_jobs, stale_jobs,
       detail_success_count, detail_failure_count, recommended_state, updated_at
     ) VALUES (
       'local', ?, ?, ?, 3, 3, ?, 3, 0, 0, 0, 0, 0, 0, 3, ?, ?
     )`,
  );
  for (const source of fixture.sourceQuality) {
    insert.run(
      source.sourceId,
      fixture.since,
      fixture.now,
      source.consecutiveFailures,
      source.recommendedState,
      fixture.now,
    );
  }
}

function seedOperationalAttempts(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO operational_attempt_metrics (
       tenant_id, occurred_at, stage, source_id, source_kind, source_priority,
       source_role, adapter, attempt_kind, outcome, failure_category,
       is_operational_failure, is_scrape_failure, is_retryable, run_id,
       duration_ms, error_class
     ) VALUES (
       'local', ?, ?, ?, 'ats', 'primary', 'discovery', 'fixture',
       'digest_fixture', ?, 'fixture_failure', 1, 1, 1, 'digest-fixture-run',
       100, 'FixtureError'
     )`,
  );
  for (const attempt of fixture.operationalAttempts) {
    insert.run(
      attempt.occurredAt,
      attempt.stage,
      attempt.sourceId,
      attempt.outcome,
    );
  }
}

function seedReviewDecisions(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO application_review_decisions (
       tenant_id, decision_id, job_key, decision, reason, decided_by, decided_at
     ) VALUES ('local', ?, ?, ?, NULL, 'user', ?)`,
  );
  for (const decision of fixture.applicationReviewDecisions) {
    insert.run(decision.decisionId, decision.jobKey, decision.decision, decision.decidedAt);
  }
}

function seedApplyRuns(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO apply_run_projections (
       run_id, tenant_id, job_id, job_title, job_employer, status, result,
       dry_run, started_at, finished_at, events_json
     ) VALUES (?, 'local', ?, '', '', ?, ?, ?, ?, ?, '[]')`,
  );
  for (const run of fixture.applyRuns) {
    insert.run(
      run.runId,
      run.jobId,
      run.status,
      run.result,
      run.dryRun ? 1 : 0,
      run.startedAt,
      run.finishedAt,
    );
  }
}

function seedScoreStaleness(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO job_score_staleness (
       tenant_id, job_url, stale_reason, old_policy_id, old_policy_version,
       new_policy_id, new_policy_version, marked_at, resolved
     ) VALUES (
       'local', ?, 'scoring_policy_changed', 'local:scoring-policy-v1', ?,
       'local:scoring-policy-v2', ?, ?, 0
     )`,
  );
  for (const stale of fixture.scoreStaleness) {
    insert.run(stale.jobUrl, stale.scoreVersion, stale.scoreVersion + 1, fixture.now);
  }
}

function seedApplicationOutcomes(db: Database.Database): void {
  const insert = db.prepare(
    `INSERT INTO application_outcomes (
       tenant_id, outcome_id, job_key, kind, source, note, occurred_at, recorded_at
     ) VALUES ('local', ?, ?, ?, 'manual', NULL, ?, ?)`,
  );
  for (const outcome of fixture.applicationOutcomes) {
    insert.run(outcome.outcomeId, outcome.jobKey, outcome.kind, outcome.occurredAt, outcome.occurredAt);
  }
}

function slug(value: string): string {
  return value.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
}
