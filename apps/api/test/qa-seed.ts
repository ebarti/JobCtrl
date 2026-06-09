import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

export interface QaWorkspace {
  appDir: string;
  dbPath: string;
  profilePath: string;
  resumeStylePath: string;
  resumeTemplatePath: string;
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

export function createQaWorkspace(targetDir?: string): QaWorkspace {
  const appDir = targetDir ? path.resolve(targetDir) : fs.mkdtempSync(path.join(os.tmpdir(), "jobhunter-qa-"));
  fs.mkdirSync(appDir, { recursive: true });
  const workspace = {
    appDir,
    dbPath: path.join(appDir, "jobhunter.db"),
    profilePath: path.join(appDir, "profile.json"),
    resumeStylePath: path.join(appDir, "resume_style.json"),
    resumeTemplatePath: path.join(appDir, "resume_template.tex"),
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
    workspace.profilePath,
    JSON.stringify(
      {
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
              must_include: true,
            },
          ],
          skill_categories: [
            {
              id: "platform",
              label: "Platform",
              items: ["Kubernetes", "Security", "Developer Experience"],
            },
          ],
        },
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(
    workspace.resumeStylePath,
    JSON.stringify(
      {
        document_font_size: "11pt",
        font_family: "sans",
        moderncv_style: "banking",
        moderncv_color: "black",
        paper_size: "a4paper",
      },
      null,
      2,
    ),
  );
  fs.writeFileSync(workspace.resumeTemplatePath, QA_RESUME_TEMPLATE);
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
  const coverTxt = path.join(artifactDir, "gitlab-platform-cover.txt");
  const coverPdf = path.join(artifactDir, "gitlab-platform-cover.pdf");
  fs.writeFileSync(resumeTxt, "QA tailored resume");
  fs.writeFileSync(resumePdf, "%PDF-1.4\n% QA resume\n");
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
    CREATE TABLE worker_runtime_heartbeats (
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
  db.close();
}

function seedWorkerHeartbeat(db: Database.Database, dbPath: string): void {
  db.prepare(
    `INSERT INTO worker_runtime_heartbeats
      (worker_id, component, pid, hostname, app_dir, db_path, task_queue, started_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        profilePath: workspace.profilePath,
        resumeStylePath: workspace.resumeStylePath,
        resumeTemplatePath: workspace.resumeTemplatePath,
        settingsPath: workspace.settingsPath,
      },
      null,
      2,
    )}\n`,
  );
}
