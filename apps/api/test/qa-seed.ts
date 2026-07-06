import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { writeProfileConfig } from "../src/profile-store.js";

export interface QaWorkspace {
  appDir: string;
  dbPath: string;
  settingsPath: string;
}

interface QaJobSeed {
  url: string;
  title: string;
  site: string;
  strategy?: string;
  location?: string;
  fitScore?: number | null;
  applicationUrl?: string;
  description?: string;
  fullDescription?: string;
}

const QA_NOW = "2026-05-04T12:00:00+00:00";
const QA_PLATFORM_JOB_URL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const QA_RESUME_TEMPLATE = String.raw`\documentclass[11pt,a4paper,sans]{moderncv}

\moderncvstyle{banking}
\moderncvcolor{black}

\usepackage[utf8]{inputenc}
\usepackage[english]{babel}
\usepackage[scale=0.85]{geometry}
\usepackage{enumitem}

\setlength{\hintscolumnwidth}{3cm}

{{ personal_data }}

\begin{document}

\makecvtitle
\vspace*{-1.5em}

{{ resume_body }}

\end{document}
`;

const QA_PROFILE = {
  schema_version: 2,
  personal: {
    full_name: "QA Candidate",
    preferred_name: "QA",
    email: "qa@example.local",
    phone: "+1 555-0100",
    city: "Remote City",
    country: "Remote",
  },
  resume: {
    executive_profile: {
      baseline_text: "Platform and security engineering leader for QA validation.",
    },
    experience_entries: [
      {
        id: "qa_platform",
        title: "Director of Platform Engineering",
        company: "QA Systems",
        date_range: "2024 -- Present",
        bullets: ["Led platform reliability and security validation programs."],
        achievement_evidence: [
          {
            id: "ev-platform",
            source_text: "Led platform reliability and security validation programs.",
            scope: "Platform reliability program",
            action: "Owned platform reliability improvements for incident response.",
            tools: ["Kubernetes", "Security"],
            metrics: ["critical services"],
            outcome: "Improved incident-response readiness across platform teams.",
            seniority_signal: "director",
            evidence_strength: "verified",
            claim_confidence: 0.95,
            user_confirmed: true,
            tags: ["reliability", "incident response"],
          },
          {
            id: "ev-incident",
            source_text: "Led incident response and platform operations programs.",
            scope: "Incident response",
            action: "Coordinated platform operations improvements across teams.",
            tools: ["Incident response", "Developer Experience"],
            metrics: ["cross-team"],
            outcome: "Reduced operational friction for engineering teams.",
            seniority_signal: "director",
            evidence_strength: "supported",
            claim_confidence: 0.82,
            user_confirmed: true,
            tags: ["operations"],
          },
        ],
      },
    ],
    skill_categories: [
      {
        id: "platform",
        label: "Platform",
        items: ["Kubernetes", "Security", "Developer Experience"],
      },
    ],
    education_entries: [],
    tailoring_rules: {
      required_experience_entry_ids: ["qa_platform"],
    },
  },
};

const QA_RESUME_STYLE = {
  document_font_size: "11pt",
  font_family: "sans",
  moderncv_style: "banking",
  moderncv_color: "black",
  paper_size: "a4paper",
};

const QA_RESUME_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>QA Candidate Resume</title>
    <style>
      body { font-family: Inter, system-ui, sans-serif; margin: 48px; color: #111827; }
      main { max-width: 760px; margin: 0 auto; }
      h1 { font-size: 28px; margin: 0 0 4px; }
      h2 { font-size: 15px; margin: 28px 0 8px; text-transform: uppercase; letter-spacing: 0.08em; }
      p, li { font-size: 14px; line-height: 1.5; }
    </style>
  </head>
  <body>
    <main class="resume-page">
      <h1 data-resume-layout-target="personal:full_name" data-resume-line-number="1">QA Candidate</h1>
      <p data-resume-layout-target="personal:contact" data-resume-line-number="2">qa@example.local | Remote City</p>
      <h2>Profile</h2>
      <p data-resume-layout-target="summary" data-resume-line-number="3">Platform and security engineering leader for QA validation.</p>
      <h2>Experience</h2>
      <p data-resume-layout-target="experience:qa_platform" data-resume-line-number="4"><strong>Director of Platform Engineering, QA Systems</strong></p>
      <ul>
        <li data-resume-layout-target="experience:qa_platform:bullet:1" data-resume-line-number="5">Led platform reliability and security validation programs.</li>
      </ul>
      <h2>Skills</h2>
      <p data-resume-layout-target="skills:platform" data-resume-line-number="6">Kubernetes, Security, Developer Experience</p>
    </main>
  </body>
</html>
`;

export function createQaWorkspace(targetDir?: string): QaWorkspace {
  const appDir = targetDir ? path.resolve(targetDir) : fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-qa-"));
  fs.mkdirSync(appDir, { recursive: true });
  const workspace = {
    appDir,
    dbPath: path.join(appDir, "jobhunter.db"),
    settingsPath: path.join(appDir, "dashboard.json"),
  };
  seedQaWorkspace(workspace);
  return workspace;
}

export function removeQaWorkspace(workspace: QaWorkspace): void {
  fs.rmSync(workspace.appDir, { force: true, recursive: true });
}

export function seedQaWorkspace(workspace: QaWorkspace): void {
  fs.mkdirSync(workspace.appDir, { recursive: true });
  seedQaDatabase(workspace.dbPath);
  fs.writeFileSync(
    workspace.settingsPath,
    JSON.stringify(
      {
        target_role: "Director of Platform Engineering",
        location_filter: "Remote",
        min_fit_score: 7,
        auto_apply: false,
        apply_concurrency: 1,
        score_criteria: "Prioritize platform reliability, security, and engineering leadership.",
        target_criteria: "Remote-friendly senior engineering leadership roles.",
      },
      null,
      2,
    ),
  );
}

export function seedQaDatabase(dbPath: string): void {
  fs.rmSync(dbPath, { force: true });
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const artifactDir = path.join(path.dirname(dbPath), "artifacts");
  fs.mkdirSync(artifactDir, { recursive: true });

  const resumeTxt = path.join(artifactDir, "gitlab-platform-resume.txt");
  const resumePdf = path.join(artifactDir, "gitlab-platform-resume.pdf");
  const resumeHtml = path.join(artifactDir, "gitlab-platform-resume.html");
  const coverTxt = path.join(artifactDir, "gitlab-platform-cover.txt");
  const coverPdf = path.join(artifactDir, "gitlab-platform-cover.pdf");
  fs.writeFileSync(resumeTxt, "QA tailored resume");
  fs.writeFileSync(resumePdf, "%PDF-1.4\n% QA resume\n");
  fs.writeFileSync(resumeHtml, QA_RESUME_HTML);
  fs.writeFileSync(coverTxt, "QA cover letter");
  fs.writeFileSync(coverPdf, "%PDF-1.4\n% QA cover\n");

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
    CREATE TABLE workflow_run_projections (
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
    );
    CREATE TABLE worker_runtime_heartbeats (
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
    CREATE TABLE job_scores (
      job_url TEXT,
      version INTEGER,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      fit_score INTEGER,
      breakdown_json TEXT,
      keywords_json TEXT,
      scored_at TEXT,
      correction_json TEXT,
      criteria_json TEXT,
      trace_json TEXT,
      PRIMARY KEY (job_url, version, tenant_id)
    );
    CREATE TABLE job_materials (
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
    CREATE TABLE job_material_layout_boxes (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      artifact_id TEXT NOT NULL,
      box_index INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      semantic_id TEXT NOT NULL,
      page_number INTEGER NOT NULL,
      line_number INTEGER,
      text_excerpt TEXT NOT NULL,
      left_pct REAL NOT NULL,
      top_pct REAL NOT NULL,
      width_pct REAL NOT NULL,
      height_pct REAL NOT NULL,
      audit_target_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_url, generation, artifact_id, box_index)
    );
    CREATE TABLE job_bullet_provenance (
      job_url TEXT,
      generation INTEGER,
      bullet_id TEXT,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      artifact_id TEXT,
      section TEXT,
      source_id TEXT,
      evidence_ids_json TEXT,
      requirement_ids_json TEXT,
      matched_keywords_json TEXT,
      transform_type TEXT,
      control TEXT,
      rationale TEXT,
      generated_text TEXT,
      position INTEGER,
      created_at TEXT,
      coverage_json TEXT,
      voice_json TEXT
    );
    CREATE TABLE job_employer_analysis (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      snapshot_hash TEXT NOT NULL DEFAULT '',
      prompt_version TEXT NOT NULL DEFAULT '',
      sdk_set_version TEXT NOT NULL DEFAULT '',
      cache_key TEXT NOT NULL DEFAULT '',
      role_framing TEXT NOT NULL DEFAULT '',
      inferred_seniority TEXT NOT NULL DEFAULT '',
      ideal_candidate_narrative TEXT NOT NULL DEFAULT '',
      requirements_json TEXT NOT NULL DEFAULT '[]',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      agreement_json TEXT NOT NULL DEFAULT '{}',
      eeo_screen_json TEXT NOT NULL DEFAULT '[]',
      legs_attempted INTEGER NOT NULL,
      legs_succeeded INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (job_url, generation)
    );
    CREATE TABLE job_employer_analysis_sub_analyses (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      analysis_json TEXT NOT NULL,
      PRIMARY KEY (job_url, generation, model_id)
    );
    CREATE TABLE job_employer_analysis_failures (
      job_url TEXT NOT NULL,
      generation INTEGER NOT NULL,
      model_id TEXT NOT NULL,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      error TEXT NOT NULL,
      raw_output TEXT,
      PRIMARY KEY (job_url, generation, model_id)
    );
    CREATE TABLE job_requirement_fit_reports (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      score_version INTEGER NOT NULL,
      employer_analysis_generation INTEGER NOT NULL,
      profile_snapshot_version INTEGER NOT NULL,
      scoring_policy_version INTEGER NOT NULL,
      formula_version TEXT NOT NULL,
      resolved_fit_score INTEGER,
      fit_band TEXT NOT NULL,
      confidence TEXT NOT NULL,
      summary_json TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (job_url, score_version, tenant_id)
    );
    CREATE TABLE job_requirement_fit_items (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_url TEXT NOT NULL,
      score_version INTEGER NOT NULL,
      requirement_id TEXT NOT NULL,
      requirement_text TEXT NOT NULL,
      tier TEXT NOT NULL,
      weight REAL NOT NULL,
      job_evidence_span TEXT NOT NULL DEFAULT '',
      fit_json TEXT NOT NULL DEFAULT '{}',
      contribution_json TEXT NOT NULL DEFAULT '{}',
      tailoring_json TEXT NOT NULL DEFAULT '{}',
      artifact_coverage_json TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (job_url, score_version, tenant_id, requirement_id)
    );
  `);
  writeProfileConfig(db, {
    profile: QA_PROFILE,
    style: QA_RESUME_STYLE,
    templateText: QA_RESUME_TEMPLATE,
  });

  // INSPECT-01: a current worker heartbeat so the generate-materials route's
  // worker-readiness gate passes in E2E. ``app_dir``/``db_path`` must match the
  // API runtime (resolved paths) and ``last_seen_at`` must be within the 45s
  // staleness window, so it is written relative to "now" at seed time.
  seedWorkerHeartbeat(db, dbPath);

  insertJob(db, {
    url: "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director",
    applicationUrl: "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director",
    title: "Director of Platform Engineering",
    site: "Greenhouse",
    strategy: "qa",
    location: "Remote, United States",
    fitScore: 9,
    description: "GitLab platform leadership role.",
    fullDescription: "Lead platform security, reliability, and developer experience programs.",
  });
  insertJob(db, {
    url: "https://talent.com/view?id=qa-marketing-director",
    title: "Director of Marketing",
    site: "Talent.com",
    strategy: "qa",
    location: "Remote, Louisiana",
    fitScore: null,
    description: "Marketing role intentionally below target.",
  });
  insertJob(db, {
    url: "https://linkedin.com/jobs/view/qa-risk-manager",
    title: "Senior Engineering Manager - Risk",
    site: "linkedin",
    strategy: "qa",
    location: "USA, Remote",
    fitScore: 8,
    description: "Risk platform leadership role.",
  });
  insertJob(db, {
    url: "https://motorolasolutions.com/careers/qa-command-center",
    title: "Command Center Solutions Project Manager",
    site: "Motorola Solutions",
    strategy: "qa",
    location: "Florida Remote Work",
    fitScore: 5,
    description: "Project management role.",
  });

  for (const stage of ["discover", "enrich", "score", "tailor", "cover"]) {
    insertStage(db, "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director", stage, "succeeded");
  }
  insertStage(db, "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director", "apply", "pending");
  insertStage(db, "https://talent.com/view?id=qa-marketing-director", "discover", "succeeded");
  insertStage(db, "https://talent.com/view?id=qa-marketing-director", "enrich", "pending");
  insertStage(db, "https://linkedin.com/jobs/view/qa-risk-manager", "discover", "succeeded");
  insertStage(db, "https://linkedin.com/jobs/view/qa-risk-manager", "enrich", "succeeded");
  insertStage(db, "https://linkedin.com/jobs/view/qa-risk-manager", "score", "failed", "LLM_ERROR");
  insertStage(db, "https://motorolasolutions.com/careers/qa-command-center", "discover", "succeeded");
  insertStage(db, "https://motorolasolutions.com/careers/qa-command-center", "enrich", "succeeded");
  insertStage(db, "https://motorolasolutions.com/careers/qa-command-center", "score", "succeeded");
  insertStage(db, "https://motorolasolutions.com/careers/qa-command-center", "tailor", "blocked", "MIN_SCORE");

  insertArtifact(db, "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director", "tailored_resume_txt", resumeTxt);
  insertArtifact(db, "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director", "tailored_resume_pdf", resumePdf);
  insertArtifact(db, "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director", "cover_letter_txt", coverTxt);
  insertArtifact(db, "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director", "cover_letter_pdf", coverPdf);
  insertArtifact(db, "https://linkedin.com/jobs/view/qa-risk-manager", "tailored_resume_pdf", path.join(artifactDir, "missing.pdf"));
  insertRequirementFitAuditFixture(db, {
    coverPdf,
    coverTxt,
    resumeHtml,
    resumePdf,
    resumeTxt,
  });

  insertEvent(db, "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director", "apply", "info", "QA apply run queued");
  insertEvent(db, "https://linkedin.com/jobs/view/qa-risk-manager", "score", "error", "QA score action failed");
  insertEvent(db, "https://motorolasolutions.com/careers/qa-command-center", "tailor", "info", "QA tailor blocked by fit score");
  db.prepare(
    "INSERT INTO apply_run_projections (run_id, job_id, job_title, job_employer, status, result, dry_run, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "qa-run-1",
    "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director",
    "Director of Platform Engineering",
    "Greenhouse",
    "finished",
    "succeeded",
    1,
    QA_NOW,
  );

  // `listWorkflowRuns` now reads the unified `workflow_run_projections` table
  // (Python-sole-writer at runtime, folded from the `Workflow*` lifecycle
  // events). `qa-run-1` therefore needs a row here to appear on /runs; the
  // job title/employer/model/mode are hydrated via the LEFT JOIN to the
  // `apply_run_projections` row seeded above. These direct INSERTs simulate
  // the Python writer inside the QA test database — the sole-writer rule
  // governs runtime code, not test seeds.
  const qaRunTemporalRunId = "qa-run-1-temporal-0001";
  const qaRunFinishedAt = "2026-05-04T12:00:04+00:00";
  const qaRunInputSummary = {
    jobUrl: QA_PLATFORM_JOB_URL,
    dryRun: true,
    continuous: false,
    limit: 1,
  };
  db.prepare(
    `INSERT INTO workflow_run_projections (
      workflow_id, tenant_id, workflow_type, status, input_summary_json,
      retryable, started_at, finished_at, duration_ms, temporal_run_id, events_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "qa-run-1",
    "local",
    "ApplyWorkflow",
    "succeeded",
    JSON.stringify(qaRunInputSummary),
    0,
    QA_NOW,
    qaRunFinishedAt,
    4000,
    qaRunTemporalRunId,
    JSON.stringify([
      {
        eventType: "WorkflowStarted",
        occurredAt: QA_NOW,
        status: "in_progress",
        message: "Apply workflow started (dry-run)",
      },
      {
        eventType: "WorkflowCompleted",
        occurredAt: qaRunFinishedAt,
        status: "succeeded",
        message: "Apply workflow completed",
      },
    ]),
  );

  // Canonical lifecycle events behind the projection above. Workflow events
  // carry no job_url (stage "workflow"); identity travels in the camelCase
  // payload, matching `infrastructure/temporal/finalize.py`. Seeding these
  // keeps the run drawer timeline and the activity/SSE stream consistent with
  // a real finalize + reconcile.
  const insertWorkflowEvent = db.prepare(
    "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  insertWorkflowEvent.run(
    null,
    "workflow",
    "WorkflowStarted",
    "info",
    "Apply workflow started (dry-run)",
    QA_NOW,
    JSON.stringify({
      workflowId: "qa-run-1",
      workflowType: "ApplyWorkflow",
      status: "in_progress",
      inputSummary: qaRunInputSummary,
      startedAt: QA_NOW,
      temporalRunId: qaRunTemporalRunId,
    }),
  );
  insertWorkflowEvent.run(
    null,
    "workflow",
    "WorkflowCompleted",
    "info",
    "Apply workflow completed",
    qaRunFinishedAt,
    JSON.stringify({
      workflowId: "qa-run-1",
      workflowType: "ApplyWorkflow",
      status: "succeeded",
      finishedAt: qaRunFinishedAt,
      durationMs: 4000,
      temporalRunId: qaRunTemporalRunId,
    }),
  );
  db.close();
}

function insertRequirementFitAuditFixture(
  db: Database.Database,
  paths: {
    coverPdf: string;
    coverTxt: string;
    resumeHtml: string;
    resumePdf: string;
    resumeTxt: string;
  },
): void {
  insertScore(db, QA_PLATFORM_JOB_URL, 9);
  insertCanonicalMaterials(db, paths);
  insertEmployerAnalysis(db);
  insertRequirementFitReport(db);
  insertBulletProvenance(db);
}

function insertCanonicalMaterials(
  db: Database.Database,
  paths: {
    coverPdf: string;
    coverTxt: string;
    resumeHtml: string;
    resumePdf: string;
    resumeTxt: string;
  },
): void {
  const requirementLedMetadata = JSON.stringify(requirementLedAuditMetadata());
  db.prepare(
    `INSERT INTO job_materials (
      job_url, generation, tenant_id, status, created_at, updated_at, metadata_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(QA_PLATFORM_JOB_URL, 1, "local", "approved", QA_NOW, QA_NOW, requirementLedMetadata);
  const insert = db.prepare(
    `INSERT INTO job_materials_artifacts (
      job_url, generation, artifact_type, artifact_id, status, path,
      render_format, size_bytes, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    QA_PLATFORM_JOB_URL,
    1,
    "tailored_resume",
    "qa-platform-resume-text",
    "approved",
    paths.resumeTxt,
    "text",
    localFileSize(paths.resumeTxt),
    requirementLedMetadata,
    QA_NOW,
  );
  insert.run(
    QA_PLATFORM_JOB_URL,
    1,
    "resume_pdf",
    "qa-platform-resume-pdf",
    "approved",
    paths.resumePdf,
    "html_pdf",
    localFileSize(paths.resumePdf),
    JSON.stringify({ ...requirementLedAuditMetadata(), html_path: paths.resumeHtml }),
    QA_NOW,
  );
  insert.run(
    QA_PLATFORM_JOB_URL,
    1,
    "cover_letter",
    "qa-platform-cover-text",
    "approved",
    paths.coverTxt,
    "text",
    localFileSize(paths.coverTxt),
    "{}",
    QA_NOW,
  );
  insert.run(
    QA_PLATFORM_JOB_URL,
    1,
    "cover_letter_pdf",
    "qa-platform-cover-pdf",
    "approved",
    paths.coverPdf,
    "html_pdf",
    localFileSize(paths.coverPdf),
    "{}",
    QA_NOW,
  );
  const insertBox = db.prepare(
    `INSERT INTO job_material_layout_boxes (
      job_url, generation, artifact_id, box_index, tenant_id, semantic_id,
      page_number, line_number, text_excerpt, left_pct, top_pct, width_pct,
      height_pct, audit_target_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertBox.run(
    QA_PLATFORM_JOB_URL,
    1,
    "qa-platform-resume-pdf",
    0,
    "local",
    "experience:qa_platform:bullet:1",
    1,
    5,
    "Led platform reliability and security validation programs.",
    12.5,
    35.0,
    68.0,
    3.0,
    "{}",
    QA_NOW,
  );
}

function requirementLedAuditMetadata(): Record<string, unknown> {
  return {
    system_prompt: "RAW PROMPT SECRET",
    full_profile: "FULL PROFILE SECRET",
    local_path: "/private/secret-resume.pdf",
    quality_plan: {
      target_profile: {
        requirements: [
          {
            requirement_id: "r1",
            text_excerpt: "Lead platform reliability improvements across critical services.",
            tier: "must_have",
          },
          {
            requirement_id: "r2",
            text_excerpt: "Improve developer experience and incident-response practices.",
            tier: "nice_to_have",
          },
        ],
      },
      coverage_graph: {
        requirement_count: 2,
        achievement_count: 2,
        coverage_edge_count: 2,
        covered_requirement_ids: ["r1"],
        uncovered_requirements: [
          {
            requirement_id: "r2",
            reason: "Adjacent developer-experience language needs review before approval.",
          },
        ],
        unused_achievement_ids: ["ev-unused"],
      },
    },
    change_annotations: [
      {
        section: "experience",
        label: "Director of Platform Engineering",
        source_text: ["FULL PROFILE SECRET source bullet"],
        tailored_text: ["Owned platform reliability improvements for incident response."],
        evidence_ids: ["ev-platform"],
        requirement_ids: ["r1"],
        coverage_edge_ids: ["edge-r1-ev-platform"],
        claim_labels: ["evidence_reframed"],
        positioning_reasons: ["Emphasized direct platform reliability ownership."],
        review_required: false,
      },
      {
        section: "summary",
        label: "Professional summary",
        tailored_text: ["Draft developer-experience translation requires confirmation."],
        evidence_ids: ["ev-incident"],
        requirement_ids: ["r2"],
        coverage_edge_ids: ["edge-r2-ev-incident"],
        claim_labels: ["draft_requires_confirmation"],
        positioning_reasons: ["Manual confirmation required before approving adjacent developer-experience language."],
        review_required: true,
      },
    ],
    post_generation_fit: {
      fit_score: {
        score: 7,
        must_have_coverage: 0.5,
        covered_requirement_ids: ["r1"],
        uncovered_requirement_ids: ["r2"],
        prioritized_fixes: ["Add direct developer experience proof."],
        review_blockers: ["claim-draft: draft_requires_confirmation"],
      },
      revision_decision: {
        threshold_failed: true,
        should_revise: false,
        review_blocked: true,
        enhancement_allowed: true,
        reason: "review_blocked_claims",
        attempt: 1,
        max_revision_attempts: 1,
        prioritized_fixes: ["Add direct developer experience proof."],
        review_blockers: ["claim-draft: draft_requires_confirmation"],
      },
    },
    bullet_limit_overflows: [
      {
        experience_entry_id: "qa_platform",
        max_bullets: 1,
        actual_bullets: 2,
        reason: "requirement_coverage",
        evidence_ids: ["ev-platform"],
      },
    ],
  };
}

function insertEmployerAnalysis(db: Database.Database): void {
  db.prepare(
    `INSERT INTO job_employer_analysis (
      job_url, generation, tenant_id, snapshot_hash, prompt_version, sdk_set_version,
      cache_key, role_framing, inferred_seniority, ideal_candidate_narrative,
      requirements_json, keywords_json, agreement_json, eeo_screen_json,
      legs_attempted, legs_succeeded, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    QA_PLATFORM_JOB_URL,
    1,
    "local",
    "qa-snapshot",
    "employer-analysis-v1",
    "qa-sdk-set",
    "qa-cache-key",
    "Platform engineering leader",
    "Director / senior engineering leadership",
    "A senior platform leader who improves developer experience, reliability, and incident response across teams.",
    JSON.stringify([
      {
        id: "r1",
        text: "Lead platform reliability improvements across critical services.",
        tier: "must_have",
        weight: 0.9,
        evidence_span: "Lead platform security, reliability, and developer experience programs.",
      },
      {
        id: "r2",
        text: "Improve developer experience and incident-response practices.",
        tier: "nice_to_have",
        weight: 0.7,
        evidence_span: "developer experience programs",
      },
    ]),
    JSON.stringify([
      {
        keyword: "platform reliability",
        requirement_id: "r1",
        evidence_span: "Lead platform security, reliability",
        rationale: "Critical operating domain for the role.",
      },
      {
        keyword: "developer experience",
        requirement_id: "r2",
        evidence_span: "developer experience programs",
        rationale: "The posting asks for developer-experience improvements.",
      },
    ]),
    JSON.stringify({
      score: 1,
      rationale: "Single seeded QA analysis.",
      flagged_requirements: [],
    }),
    "[]",
    1,
    1,
    QA_NOW,
  );
}

function insertRequirementFitReport(db: Database.Database): void {
  db.prepare(
    `INSERT INTO job_requirement_fit_reports (
      tenant_id, job_url, score_version, employer_analysis_generation,
      profile_snapshot_version, scoring_policy_version, formula_version,
      resolved_fit_score, fit_band, confidence, summary_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    QA_PLATFORM_JOB_URL,
    1,
    1,
    4,
    3,
    "requirement-fit-v1",
    9,
    "strong",
    "high",
    JSON.stringify({
      weighted_fit: 0.86,
      must_have_coverage: 1,
      blocker_count: 0,
      missing_high_weight_count: 0,
    }),
    QA_NOW,
  );
  const insertItem = db.prepare(
    `INSERT INTO job_requirement_fit_items (
      tenant_id, job_url, score_version, requirement_id, requirement_text,
      tier, weight, job_evidence_span, fit_json, contribution_json,
      tailoring_json, artifact_coverage_json, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertItem.run(
    "local",
    QA_PLATFORM_JOB_URL,
    1,
    "r1",
    "Lead platform reliability improvements across critical services.",
    "must_have",
    0.9,
    "Lead platform security, reliability, and developer experience programs.",
    JSON.stringify({ kind: "matched", evidence_ids: ["ev-platform"], strength: "direct" }),
    JSON.stringify({
      max_points: 1.125,
      awarded_points: 1.125,
      weighted_impact: 1.125,
      rationale: "Direct platform reliability evidence covers the requirement.",
    }),
    JSON.stringify({
      action: "double_down",
      priority: 0.9,
      allowed_evidence_ids: ["ev-platform"],
      target_keywords: ["platform reliability"],
      prohibited_claims: [],
      instruction: "Keep platform reliability ownership prominent.",
    }),
    JSON.stringify({
      state: "covered",
      source: "tailored_resume_bullet_provenance",
      bullet_count: 1,
      examples: ["Owned platform reliability improvements for incident response."],
    }),
    1,
  );
  insertItem.run(
    "local",
    QA_PLATFORM_JOB_URL,
    1,
    "r2",
    "Improve developer experience and incident-response practices.",
    "nice_to_have",
    0.7,
    "developer experience programs",
    JSON.stringify({
      kind: "transferable",
      evidence_ids: ["ev-incident"],
      gap: "No direct developer-experience ownership evidence was recorded.",
      bridge: "Incident leadership can support adjacent developer-experience expectations.",
    }),
    JSON.stringify({
      max_points: 0.7,
      awarded_points: 0.42,
      weighted_impact: 0.42,
      rationale: "Transferable incident leadership partially covers the requirement.",
    }),
    JSON.stringify({
      action: "bridge_gap",
      priority: 0.7,
      allowed_evidence_ids: ["ev-incident"],
      target_keywords: ["incident response", "developer experience"],
      prohibited_claims: ["owned developer experience end to end"],
      instruction: "Bridge from incident leadership without claiming direct developer-experience ownership.",
    }),
    JSON.stringify({
      state: "missing_from_resume",
      source: "tailored_resume_bullet_provenance",
      bullet_count: 0,
      examples: [],
    }),
    2,
  );
}

function insertBulletProvenance(db: Database.Database): void {
  db.prepare(
    `INSERT INTO job_bullet_provenance (
      job_url, generation, bullet_id, tenant_id, artifact_id, section, source_id,
      evidence_ids_json, requirement_ids_json, matched_keywords_json,
      transform_type, control, rationale, generated_text, position, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    QA_PLATFORM_JOB_URL,
    1,
    "summary-1",
    "local",
    "qa-platform-resume-text",
    "summary",
    "qa_platform",
    JSON.stringify(["ev-platform"]),
    JSON.stringify(["r1"]),
    JSON.stringify(["platform reliability"]),
    "rephrased",
    "rephrase_allowed",
    "Reframed the bullet toward platform reliability.",
    "Owned platform reliability improvements for incident response.",
    1,
    QA_NOW,
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
    JSON.stringify(["platform", "leadership", "reliability"]),
    QA_NOW,
    "{}",
    JSON.stringify({
      min_fit_score: 7,
      criteria_text: "Platform leadership and incident response.",
      target_criteria: "Senior platform leader.",
      criteria_version: "criteria-test",
    }),
    JSON.stringify({
      prompt_version: "score-fit-assessment-v1",
      schema_version: "score-fit-assessment-v1",
      model: "fake-model",
      criteria_version: "criteria-test",
      profile_snapshot_version: 4,
      scoring_policy_id: "local:scoring-policy-v3",
      scoring_policy_version: 3,
      rubric_version: "default-scoring-rubric-v1",
      raw_weighted_score: 8.6,
      calibration_adjustment: 0,
      resolved_fit_band: "strong",
      resolution_reason: "requirement_fit_report",
      parser_warnings: [],
    }),
  );
}

function seedWorkerHeartbeat(db: Database.Database, dbPath: string): void {
  db.prepare(
    `INSERT INTO worker_runtime_heartbeats
      (worker_id, component, pid, hostname, app_dir, db_path, task_queue, started_at, last_seen_at,
       max_concurrent_activities, activity_executor_max_workers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "qa-worker-1",
    "temporal-worker",
    1234,
    "localhost",
    path.resolve(path.dirname(dbPath)),
    path.resolve(dbPath),
    "jobhunter-default",
    new Date().toISOString(),
    new Date().toISOString(),
    4,
    6,
  );
}

function insertJob(db: Database.Database, job: QaJobSeed): void {
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
    job.strategy ?? "qa",
    job.location ?? "Remote",
    "",
    QA_NOW,
    job.applicationUrl ?? job.url,
    job.description ?? "QA job description",
    job.fullDescription ?? job.description ?? "QA job description",
    QA_NOW,
    job.fitScore ?? null,
    "QA score reasoning with keywords: platform, security, reliability.",
    job.fitScore === null ? null : QA_NOW,
    null,
    null,
  );
}

function insertStage(db: Database.Database, jobUrl: string, stage: string, state: string, errorCode: string | null = null): void {
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
    QA_NOW,
    errorCode,
    errorCode ? `${stage} failed` : null,
    state === "blocked" ? 0 : 1,
    "[]",
  );
}

function insertArtifact(db: Database.Database, jobUrl: string, type: string, filePath: string): void {
  db.prepare(
    "INSERT INTO job_artifacts (job_url, stage, artifact_type, status, path, created_at, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(jobUrl, artifactStage(type), type, "active", filePath, QA_NOW, localFileSize(filePath));
}

function insertEvent(db: Database.Database, jobUrl: string, stage: string, level: string, message: string): void {
  // ``event_type`` defaults to '' in the schema, but the SSE writer
  // (``apps/api/src/event-stream.ts``) skips rows where the column is
  // empty — without this column being set, every QA-seeded event is
  // silently dropped from /v1/events/stream and any test that depends
  // on the SSE pipeline against qa-seed data sees nothing.
  db.prepare(
    "INSERT INTO job_events (job_url, stage, event_type, level, message, occurred_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(jobUrl, stage, "QaInfo", level, message, QA_NOW);
}

function artifactStage(type: string): string {
  if (type.startsWith("cover_letter")) {
    return "cover";
  }
  return "tailor";
}

function localFileSize(filePath: string): number | null {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const workspace = createQaWorkspace(process.argv[2]);
  process.stdout.write(
    `${JSON.stringify(
      {
        appDir: workspace.appDir,
        dbPath: workspace.dbPath,
        settingsPath: workspace.settingsPath,
      },
      null,
      2,
    )}\n`,
  );
}
