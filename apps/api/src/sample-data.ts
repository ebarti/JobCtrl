import fs from "node:fs";
import path from "node:path";

import type {
  SampleDataJob,
  SampleDataMutationResponse,
  SampleDataStatus,
  SampleDataTtfvProbeResponse,
} from "./contracts.js";
import { allRows, getRow, tableExists, type SqliteDatabase } from "./db.js";
import { refreshProjections } from "./projections.js";

const DEFAULT_TENANT = "local";
const SAMPLE_DATASET_ID = "first-run-ttfv-v1";
const SAMPLE_SOURCE = "jobhunter-sample";
const SAMPLE_LOADED_BY = "first-run-sample-data";

export const SAMPLE_JOB_URLS = [
  "https://sample.jobhunter.local/jobs/platform-engineering-director",
  "https://sample.jobhunter.local/jobs/support-operations-manager",
] as const;

interface SampleJobFixture {
  readonly url: (typeof SAMPLE_JOB_URLS)[number];
  readonly title: string;
  readonly company: string;
  readonly location: string;
  readonly salary: string;
  readonly description: string;
  readonly fullDescription: string;
  readonly fitScore: number;
  readonly scoreReasoning: string;
  readonly matchedSignals: readonly string[];
  readonly missingSignals: readonly string[];
  readonly transferableSignals: readonly string[];
  readonly keywords: readonly string[];
  readonly stages: Readonly<Record<string, string>>;
  readonly nextAction: string | null;
}

const SAMPLE_JOBS: readonly SampleJobFixture[] = [
  {
    url: SAMPLE_JOB_URLS[0],
    title: "Director of Platform Engineering",
    company: "Northstar Robotics",
    location: "Remote, Europe",
    salary: "EUR 120000-145000/year",
    description:
      "Synthetic leadership role for a platform team improving reliability, developer experience, and incident response.",
    fullDescription:
      "Northstar Robotics is a fictitious employer used only for JobHunter first-run sample data. "
      + "The role asks for platform reliability leadership, developer tooling, incident review habits, "
      + "and measurable improvements across product engineering teams.",
    fitScore: 9,
    scoreReasoning:
      "Strong synthetic fit: platform reliability, developer experience, and incident leadership all match the sample profile.",
    matchedSignals: ["platform reliability leadership", "developer experience programs", "incident review practice"],
    missingSignals: ["public company scale"],
    transferableSignals: ["cross-functional delivery"],
    keywords: ["platform", "reliability", "developer experience", "incident response"],
    stages: {
      discover: "succeeded",
      enrich: "succeeded",
      score: "succeeded",
      tailor: "succeeded",
      cover: "succeeded",
      apply: "pending",
    },
    nextAction: "Review the synthetic resume PDF before clearing sample data.",
  },
  {
    url: SAMPLE_JOB_URLS[1],
    title: "Support Operations Manager",
    company: "Harborlight Systems",
    location: "Hybrid, Barcelona",
    salary: "EUR 62000-78000/year",
    description:
      "Synthetic operations role with a lower fit score so the first-run list shows ranking and filtering behavior.",
    fullDescription:
      "Harborlight Systems is a fictitious employer used only for JobHunter first-run sample data. "
      + "The role emphasizes support process design, tooling hygiene, and customer escalation reporting.",
    fitScore: 5,
    scoreReasoning:
      "Partial synthetic fit: operational leadership is relevant, but the role is less aligned with platform engineering.",
    matchedSignals: ["process leadership"],
    missingSignals: ["support operations ownership", "customer escalation ownership"],
    transferableSignals: ["cross-functional reporting"],
    keywords: ["support operations", "process", "customer escalations"],
    stages: {
      discover: "succeeded",
      enrich: "succeeded",
      score: "succeeded",
      tailor: "blocked",
      cover: "pending",
      apply: "pending",
    },
    nextAction: "Clear sample data before starting real discovery.",
  },
];

interface SampleRecordRow extends Record<string, unknown> {
  job_key: string;
  loaded_at: string;
}

interface SampleProjectionRow extends Record<string, unknown> {
  job_id: string;
  title: string;
  employer: string;
  fit_score: number | null;
  has_pdf: number;
}

interface SampleArtifactRow extends Record<string, unknown> {
  artifact_id: string | null;
  path: string | null;
  size_bytes: number | null;
}

export function missingDatabaseSampleDataStatus(): SampleDataStatus {
  return {
    ok: true,
    state: "not_initialized",
    dbExists: false,
    canLoad: false,
    canClear: false,
    jobCount: 0,
    sampleJobCount: 0,
    loadedAt: null,
    sampleJobs: [],
    message: "Initialize a JobHunter workspace before loading sample data.",
  };
}

export function readSampleDataStatus(db: SqliteDatabase): SampleDataStatus {
  if (!tableExists(db, "jobs")) {
    return {
      ...missingDatabaseSampleDataStatus(),
      dbExists: true,
      message: "The JobHunter database exists but has not been initialized.",
    };
  }
  const sampleKeys = sampleJobKeySet(db);
  const jobCount = countRows(db, "jobs");
  const sampleJobCount = sampleKeys.size;
  const realJobCount = Math.max(0, jobCount - sampleJobCount);
  const loadedAt = latestSampleLoadedAt(db);
  const sampleJobs = sampleDataJobs(db, sampleKeys);
  if (sampleJobCount > 0) {
    return {
      ok: true,
      state: "loaded",
      dbExists: true,
      canLoad: false,
      canClear: true,
      jobCount,
      sampleJobCount,
      loadedAt,
      sampleJobs,
      message: "Sample data is loaded. Clear it before starting real job discovery.",
    };
  }
  if (realJobCount > 0) {
    return {
      ok: true,
      state: "blocked",
      dbExists: true,
      canLoad: false,
      canClear: false,
      jobCount,
      sampleJobCount,
      loadedAt: null,
      sampleJobs: [],
      message: "Sample data can only be loaded into an empty workspace.",
    };
  }
  return {
    ok: true,
    state: "empty",
    dbExists: true,
    canLoad: true,
    canClear: false,
    jobCount,
    sampleJobCount,
    loadedAt: null,
    sampleJobs: [],
    message: "This empty workspace can load JobHunter sample data.",
  };
}

export function loadSampleData(db: SqliteDatabase, appDir: string): SampleDataMutationResponse {
  ensureSampleDataDependencies(db);
  const before = readSampleDataStatus(db);
  if (before.state === "loaded") {
    return {
      ok: true,
      loaded: false,
      cleared: false,
      status: before,
      message: "Sample data is already loaded.",
    };
  }
  if (!before.canLoad) {
    return {
      ok: true,
      loaded: false,
      cleared: false,
      status: before,
      message: before.message,
    };
  }

  const loadedAt = new Date().toISOString();
  const artifactDir = path.join(appDir, "sample-data", SAMPLE_DATASET_ID, "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });
  const files = writeSampleArtifacts(artifactDir);

  db.transaction(() => {
    ensureSampleDataDependencies(db);
    for (const job of SAMPLE_JOBS) {
      upsertSampleJob(db, job, files, loadedAt);
    }
  })();
  refreshProjections(db, DEFAULT_TENANT);
  const status = readSampleDataStatus(db);
  return {
    ok: true,
    loaded: true,
    cleared: false,
    status,
    message: "Sample data loaded.",
  };
}

export function clearSampleData(db: SqliteDatabase, appDir: string): SampleDataMutationResponse {
  ensureSampleDataTable(db);
  const loadedSampleKeys = sampleJobKeySet(db);
  const sampleKeys = new Set<string>([...SAMPLE_JOB_URLS, ...loadedSampleKeys]);
  db.transaction(() => {
    deleteSampleRows(db, sampleKeys);
  })();
  const sampleDir = path.join(appDir, "sample-data", SAMPLE_DATASET_ID);
  fs.rmSync(sampleDir, { force: true, recursive: true });
  const status = readSampleDataStatus(db);
  return {
    ok: true,
    loaded: false,
    cleared: loadedSampleKeys.size > 0,
    status,
    message: loadedSampleKeys.size > 0 ? "Sample data cleared." : "No sample data was loaded.",
  };
}

export function sampleJobKeySet(db: SqliteDatabase): Set<string> {
  if (!tableExists(db, "sample_data_records")) {
    return new Set();
  }
  return new Set(
    allRows<SampleRecordRow>(
      db,
      "SELECT job_key FROM sample_data_records WHERE tenant_id = ? AND dataset_id = ?",
      [DEFAULT_TENANT, SAMPLE_DATASET_ID],
    )
      .map((row) => String(row.job_key || ""))
      .filter(Boolean),
  );
}

export function isSampleJob(db: SqliteDatabase, jobKey: string): boolean {
  if (!tableExists(db, "sample_data_records")) {
    return false;
  }
  const row = getRow<{ one: number }>(
    db,
    `SELECT 1 AS one
       FROM sample_data_records
      WHERE tenant_id = ?
        AND dataset_id = ?
        AND job_key = ?
      LIMIT 1`,
    [DEFAULT_TENANT, SAMPLE_DATASET_ID, jobKey],
  );
  return Boolean(row);
}

export function sampleDataTtfvProbe(db: SqliteDatabase): SampleDataTtfvProbeResponse {
  refreshProjections(db, DEFAULT_TENANT);
  const sampleKeys = sampleJobKeySet(db);
  const firstScored = sampleDataJobs(db, sampleKeys).find((job) => job.fitScore !== null) ?? null;
  const pdf = firstSampleResumePdf(db, sampleKeys);
  const pdfBytes = pdf?.path && fs.existsSync(pdf.path) ? fs.statSync(pdf.path).size : null;
  const pdfJob = firstScored && pdf ? { ...firstScored, hasPdf: true } : null;
  return {
    ok: true,
    mode: "synthetic_sample",
    checkedAt: new Date().toISOString(),
    ttfv1: {
      passed: Boolean(firstScored),
      job: firstScored,
    },
    ttfv2: {
      passed: Boolean(pdf && pdfBytes && pdfBytes > 0),
      job: pdfJob,
      artifactId: pdf?.artifact_id ?? null,
      artifactBytes: pdfBytes,
    },
  };
}

function ensureSampleDataDependencies(db: SqliteDatabase): void {
  ensureSampleDataTable(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS jobs (
      url TEXT PRIMARY KEY,
      title TEXT,
      company TEXT,
      salary TEXT,
      description TEXT,
      location TEXT,
      site TEXT,
      strategy TEXT,
      discovered_at TEXT,
      full_description TEXT,
      application_url TEXT,
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
      applied_at TEXT,
      apply_status TEXT,
      apply_error TEXT,
      apply_attempts INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS job_stage_states (
      job_url TEXT NOT NULL,
      stage TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      attempt_count INTEGER DEFAULT 0,
      max_attempts INTEGER,
      started_at TEXT,
      updated_at TEXT NOT NULL,
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
    CREATE TABLE IF NOT EXISTS job_events (
      event_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT,
      stage TEXT,
      event_type TEXT NOT NULL DEFAULT '',
      level TEXT NOT NULL DEFAULT 'info',
      message TEXT,
      occurred_at TEXT NOT NULL,
      payload_json TEXT
    );
    CREATE TABLE IF NOT EXISTS job_scores (
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
    CREATE TABLE IF NOT EXISTS job_artifacts (
      artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_url TEXT NOT NULL,
      stage TEXT NOT NULL,
      artifact_type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      size_bytes INTEGER,
      metadata_json TEXT
    );
  `);
  ensureColumn(db, "jobs", "company", "TEXT");
  ensureColumn(db, "jobs", "full_description", "TEXT");
  ensureColumn(db, "job_stage_states", "metadata_json", "TEXT");
  ensureColumn(db, "job_stage_states", "version", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "job_materials", "metadata_json", "TEXT");
  ensureColumn(db, "job_materials_artifacts", "metadata_json", "TEXT");
}

function ensureSampleDataTable(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sample_data_records (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      dataset_id TEXT NOT NULL,
      job_key TEXT NOT NULL,
      loaded_by TEXT NOT NULL,
      loaded_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, dataset_id, job_key)
    );
  `);
}

function ensureColumn(db: SqliteDatabase, tableName: string, columnName: string, definition: string): void {
  if (!tableExists(db, tableName)) return;
  const columns = new Set(allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name));
  if (!columns.has(columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

interface SampleFiles {
  readonly resumeText: string;
  readonly resumePdf: string;
  readonly resumeHtml: string;
  readonly coverText: string;
}

function writeSampleArtifacts(artifactDir: string): SampleFiles {
  const resumeText = path.join(artifactDir, "platform-engineering-director-resume.txt");
  const resumePdf = path.join(artifactDir, "platform-engineering-director-resume.pdf");
  const resumeHtml = path.join(artifactDir, "platform-engineering-director-resume.html");
  const coverText = path.join(artifactDir, "platform-engineering-director-cover-letter.txt");
  fs.writeFileSync(
    resumeText,
    [
      "Sample Candidate",
      "Director of Platform Engineering",
      "",
      "Led synthetic platform reliability programs across developer tooling, incident review, and service ownership.",
      "Reduced repeat incidents in the synthetic scenario by standardizing incident reviews and ownership follow-up.",
      "Built sample developer-experience dashboards that made reliability work visible to engineering leaders.",
    ].join("\n"),
  );
  fs.writeFileSync(
    resumeHtml,
    "<!doctype html><html><head><meta charset=\"utf-8\"><title>Sample Resume</title></head>"
      + "<body><h1>Sample Candidate</h1><p>Director of Platform Engineering</p>"
      + "<ul><li>Led synthetic platform reliability programs.</li>"
      + "<li>Improved developer tooling and incident response.</li></ul></body></html>",
  );
  fs.writeFileSync(
    resumePdf,
    [
      "%PDF-1.4",
      "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
      "2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj",
      "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >> endobj",
      "4 0 obj << /Length 74 >> stream",
      "BT /F1 12 Tf 72 720 Td (Sample Candidate - Platform Engineering Resume) Tj ET",
      "endstream endobj",
      "xref",
      "0 5",
      "0000000000 65535 f ",
      "trailer << /Root 1 0 R /Size 5 >>",
      "startxref",
      "0",
      "%%EOF",
    ].join("\n"),
  );
  fs.writeFileSync(
    coverText,
    "Sample cover letter for the fictitious Northstar Robotics platform engineering role.\n",
  );
  return { resumeText, resumePdf, resumeHtml, coverText };
}

function upsertSampleJob(
  db: SqliteDatabase,
  job: SampleJobFixture,
  files: SampleFiles,
  loadedAt: string,
): void {
  db.prepare(
    `INSERT INTO jobs (
       url, title, company, site, strategy, location, salary, discovered_at,
       application_url, description, full_description, detail_scraped_at,
       fit_score, score_reasoning, scored_at, tailored_resume_path, tailored_at,
       cover_letter_path, cover_letter_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(url) DO UPDATE SET
       title = excluded.title,
       company = excluded.company,
       site = excluded.site,
       strategy = excluded.strategy,
       location = excluded.location,
       salary = excluded.salary,
       discovered_at = excluded.discovered_at,
       application_url = excluded.application_url,
       description = excluded.description,
       full_description = excluded.full_description,
       detail_scraped_at = excluded.detail_scraped_at,
       fit_score = excluded.fit_score,
       score_reasoning = excluded.score_reasoning,
       scored_at = excluded.scored_at,
       tailored_resume_path = excluded.tailored_resume_path,
       tailored_at = excluded.tailored_at,
       cover_letter_path = excluded.cover_letter_path,
       cover_letter_at = excluded.cover_letter_at`,
  ).run(
    job.url,
    job.title,
    job.company,
    SAMPLE_SOURCE,
    "sample",
    job.location,
    job.salary,
    loadedAt,
    null,
    job.description,
    job.fullDescription,
    loadedAt,
    job.fitScore,
    job.scoreReasoning,
    loadedAt,
    job.url === SAMPLE_JOB_URLS[0] ? files.resumeText : null,
    job.url === SAMPLE_JOB_URLS[0] ? loadedAt : null,
    job.url === SAMPLE_JOB_URLS[0] ? files.coverText : null,
    job.url === SAMPLE_JOB_URLS[0] ? loadedAt : null,
  );
  upsertSampleScore(db, job, loadedAt);
  upsertSampleStages(db, job, loadedAt);
  if (job.url === SAMPLE_JOB_URLS[0]) {
    upsertSampleMaterials(db, job, files, loadedAt);
  }
  db.prepare(
    `INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.url,
    "score",
    "SampleDataLoaded",
    "info",
    "First-run sample data loaded",
    loadedAt,
    JSON.stringify({ datasetId: SAMPLE_DATASET_ID, sample: true }),
  );
  db.prepare(
    `INSERT INTO sample_data_records (tenant_id, dataset_id, job_key, loaded_by, loaded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, dataset_id, job_key) DO UPDATE SET
       loaded_by = excluded.loaded_by,
       loaded_at = excluded.loaded_at`,
  ).run(DEFAULT_TENANT, SAMPLE_DATASET_ID, job.url, SAMPLE_LOADED_BY, loadedAt);
}

function upsertSampleScore(db: SqliteDatabase, job: SampleJobFixture, loadedAt: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO job_scores (
       job_url, version, tenant_id, fit_score, breakdown_json, keywords_json,
       scored_at, correction_json, criteria_json, trace_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.url,
    1,
    DEFAULT_TENANT,
    job.fitScore,
    JSON.stringify({
      reasoning: job.scoreReasoning,
      technical_fit: job.fitScore,
      experience_fit: Math.max(1, job.fitScore - 1),
      role_fit: job.fitScore,
      fit_band: job.fitScore >= 8 ? "strong" : "plausible",
      confidence: "high",
      eligibility: { status: "eligible", hard_blockers: [], warnings: [] },
      matched_signals: job.matchedSignals,
      missing_signals: job.missingSignals,
      transferable_signals: job.transferableSignals,
    }),
    JSON.stringify(job.keywords),
    loadedAt,
    "{}",
    JSON.stringify({
      min_fit_score: 7,
      criteria_text: "Synthetic first-run platform leadership criteria.",
      target_criteria: "Synthetic target profile for first-run sample data.",
      criteria_version: SAMPLE_DATASET_ID,
    }),
    JSON.stringify({
      prompt_version: "synthetic-sample-data",
      schema_version: "score-fit-assessment-v1",
      model: "synthetic-fixture",
      criteria_version: SAMPLE_DATASET_ID,
      raw_weighted_score: job.fitScore,
      calibration_adjustment: 0,
      resolved_fit_band: job.fitScore >= 8 ? "strong" : "plausible",
      resolution_reason: "synthetic_sample",
      parser_warnings: [],
    }),
  );
}

function upsertSampleStages(db: SqliteDatabase, job: SampleJobFixture, loadedAt: string): void {
  const maxAttempts: Record<string, number> = {
    discover: 1,
    enrich: 3,
    score: 3,
    tailor: 5,
    cover: 5,
    apply: 3,
  };
  const insert = db.prepare(
    `INSERT INTO job_stage_states (
       job_url, stage, state, attempt_count, max_attempts, updated_at,
       error_code, error_message, retryable, blocked_by_json, next_action, metadata_json, version
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(job_url, stage) DO UPDATE SET
       state = excluded.state,
       attempt_count = excluded.attempt_count,
       max_attempts = excluded.max_attempts,
       updated_at = excluded.updated_at,
       error_code = excluded.error_code,
       error_message = excluded.error_message,
       retryable = excluded.retryable,
       blocked_by_json = excluded.blocked_by_json,
       next_action = excluded.next_action,
       metadata_json = excluded.metadata_json,
       version = excluded.version`,
  );
  for (const [stage, state] of Object.entries(job.stages)) {
    insert.run(
      job.url,
      stage,
      state,
      state === "pending" ? 0 : 1,
      maxAttempts[stage] ?? 3,
      loadedAt,
      state === "blocked" ? "SAMPLE_MIN_SCORE" : null,
      state === "blocked" ? "Synthetic sample is below the tailoring threshold." : null,
      state === "blocked" ? 0 : 1,
      "[]",
      stage === "apply" ? job.nextAction : null,
      JSON.stringify({ datasetId: SAMPLE_DATASET_ID, sample: true }),
      1,
    );
  }
}

function upsertSampleMaterials(
  db: SqliteDatabase,
  job: SampleJobFixture,
  files: SampleFiles,
  loadedAt: string,
): void {
  const metadata = JSON.stringify({
    datasetId: SAMPLE_DATASET_ID,
    sample: true,
    qualityPlan: {
      targetProfile: {
        requirements: [
          { requirementId: "sample-r1", text: "Lead platform reliability improvements.", tier: "must_have" },
          { requirementId: "sample-r2", text: "Improve developer experience.", tier: "must_have" },
        ],
      },
      coverageGraph: {
        requirementCount: 2,
        achievementCount: 3,
        coverageEdgeCount: 2,
        coveredRequirementIds: ["sample-r1", "sample-r2"],
        uncoveredRequirements: [],
        unusedAchievementIds: [],
      },
    },
  });
  db.prepare(
    `INSERT OR REPLACE INTO job_materials (
       job_url, generation, tenant_id, status, created_at, updated_at, metadata_json
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(job.url, 1, DEFAULT_TENANT, "approved", loadedAt, loadedAt, metadata);
  const insert = db.prepare(
    `INSERT OR REPLACE INTO job_materials_artifacts (
       job_url, generation, artifact_type, artifact_id, status, path,
       render_format, size_bytes, metadata_json, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    job.url,
    1,
    "tailored_resume",
    "sample-platform-resume-text",
    "approved",
    files.resumeText,
    "text",
    fileSize(files.resumeText),
    metadata,
    loadedAt,
  );
  insert.run(
    job.url,
    1,
    "resume_pdf",
    "sample-platform-resume-pdf",
    "approved",
    files.resumePdf,
    "html_pdf",
    fileSize(files.resumePdf),
    JSON.stringify({ ...JSON.parse(metadata), html_path: files.resumeHtml }),
    loadedAt,
  );
  insert.run(
    job.url,
    1,
    "cover_letter",
    "sample-platform-cover-text",
    "approved",
    files.coverText,
    "text",
    fileSize(files.coverText),
    "{}",
    loadedAt,
  );
}

function deleteSampleRows(db: SqliteDatabase, sampleKeys: Set<string>): void {
  const keys = [...sampleKeys].filter(Boolean);
  if (!keys.length) return;
  deleteWhereIn(db, "application_review_decisions", "job_key", keys);
  deleteWhereIn(db, "application_outcomes", "job_key", keys);
  deleteWhereIn(db, "application_email_evidence", "job_key", keys);
  deleteWhereIn(db, "application_outcome_suggestions", "job_key", keys);
  deleteWhereIn(db, "job_materials_artifacts", "job_url", keys);
  deleteWhereIn(db, "job_materials", "job_url", keys);
  deleteWhereIn(db, "job_artifacts", "job_url", keys);
  deleteWhereIn(db, "job_stage_states", "job_url", keys);
  deleteWhereIn(db, "job_scores", "job_url", keys);
  deleteWhereIn(db, "job_score_staleness", "job_url", keys);
  deleteWhereIn(db, "job_requirement_fit_items", "job_url", keys);
  deleteWhereIn(db, "job_requirement_fit_reports", "job_url", keys);
  deleteWhereIn(db, "job_employer_analysis_sub_analyses", "job_url", keys);
  deleteWhereIn(db, "job_employer_analysis_failures", "job_url", keys);
  deleteWhereIn(db, "job_employer_analysis", "job_url", keys);
  deleteWhereIn(db, "job_interview_prep_items", "job_url", keys);
  deleteWhereIn(db, "job_interview_prep", "job_url", keys);
  deleteWhereIn(db, "job_bullet_provenance", "job_url", keys);
  deleteWhereIn(db, "job_material_layout_boxes", "job_url", keys);
  deleteWhereIn(db, "job_enrichments", "job_url", keys);
  deleteWhereIn(db, "posting_snapshot_sets", "job_url", keys);
  deleteWhereIn(db, "job_list_projections", "job_id", keys);
  deleteWhereIn(db, "job_detail_projections", "job_id", keys);
  deleteWhereIn(db, "artifact_list_projections", "job_id", keys);
  deleteWhereIn(db, "evidence_usage_projections", "projection_id", keys);
  deleteWhereIn(db, "jobs", "url", keys);
  if (tableExists(db, "sample_data_records")) {
    deleteWhereIn(db, "sample_data_records", "job_key", keys);
  }
  if (tableExists(db, "dashboard_projections")) {
    db.prepare("DELETE FROM dashboard_projections WHERE tenant_id = ?").run(DEFAULT_TENANT);
  }
}

function deleteWhereIn(db: SqliteDatabase, tableName: string, columnName: string, values: readonly string[]): void {
  if (!tableExists(db, tableName) || values.length === 0) return;
  const placeholders = values.map(() => "?").join(", ");
  db.prepare(`DELETE FROM ${tableName} WHERE ${columnName} IN (${placeholders})`).run(...values);
}

function countRows(db: SqliteDatabase, tableName: string): number {
  if (!tableExists(db, tableName)) return 0;
  return Number(getRow<{ c: number }>(db, `SELECT COUNT(*) AS c FROM ${tableName}`)?.c ?? 0);
}

function latestSampleLoadedAt(db: SqliteDatabase): string | null {
  if (!tableExists(db, "sample_data_records")) return null;
  const row = getRow<{ loaded_at: string }>(
    db,
    `SELECT MAX(loaded_at) AS loaded_at
       FROM sample_data_records
      WHERE tenant_id = ? AND dataset_id = ?`,
    [DEFAULT_TENANT, SAMPLE_DATASET_ID],
  );
  return row?.loaded_at ?? null;
}

function sampleDataJobs(db: SqliteDatabase, sampleKeys: Set<string>): SampleDataJob[] {
  if (!sampleKeys.size || !tableExists(db, "job_list_projections")) {
    return [];
  }
  const placeholders = [...sampleKeys].map(() => "?").join(", ");
  return allRows<SampleProjectionRow>(
    db,
    `SELECT job_id, title, employer, fit_score, has_pdf
       FROM job_list_projections
      WHERE tenant_id = ?
        AND job_id IN (${placeholders})
      ORDER BY fit_score DESC, title ASC`,
    [DEFAULT_TENANT, ...sampleKeys],
  ).map((row) => ({
    jobKey: row.job_id,
    title: row.title || "Untitled sample job",
    company: row.employer || "Sample company",
    fitScore: row.fit_score === null || row.fit_score === undefined ? null : Number(row.fit_score),
    hasPdf: Boolean(row.has_pdf),
  }));
}

function firstSampleResumePdf(
  db: SqliteDatabase,
  sampleKeys: Set<string>,
): SampleArtifactRow | null {
  if (!sampleKeys.size || !tableExists(db, "job_materials_artifacts")) {
    return null;
  }
  const placeholders = [...sampleKeys].map(() => "?").join(", ");
  return (
    getRow<SampleArtifactRow>(
      db,
      `SELECT artifact_id, path, size_bytes
         FROM job_materials_artifacts
        WHERE job_url IN (${placeholders})
          AND artifact_type IN ('resume_pdf', 'tailored_resume_pdf')
          AND status IN ('approved', 'active')
        ORDER BY generation DESC, created_at DESC
        LIMIT 1`,
      [...sampleKeys],
    ) ?? null
  );
}

function fileSize(filePath: string): number {
  return fs.statSync(filePath).size;
}
