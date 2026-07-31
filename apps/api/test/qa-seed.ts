import fs from "node:fs";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";

import { writeProfileConfig } from "../src/profile-store.js";
import { BUILT_IN_RESUME_TEMPLATE_THEME } from "../src/resume-templates.js";
import { initializeExactV7Database } from "./v7-schema.js";

export interface QaWorkspace {
  appDir: string;
  dbPath: string;
  configPath: string;
}

export interface QaSeedOptions {
  /** Adds the larger applied-job cohort used to make analytics screenshots meaningful. */
  includeDocumentationAnalytics?: boolean;
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
export const QA_PLATFORM_JOB_URL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
export const QA_PLATFORM_JOB_ID = qaJobId(QA_PLATFORM_JOB_URL);
export const QA_RISK_JOB_URL = "https://linkedin.com/jobs/view/qa-risk-manager";
export const QA_RISK_JOB_ID = qaJobId(QA_RISK_JOB_URL);
const QA_RESUME_TEMPLATE = "{{ personal_data }}\n\n{{ resume_body }}\n";

export function createQaPdfBytes(title: string): Buffer {
  const safeTitle = title
    .replaceAll("\\", "\\\\")
    .replaceAll("(", "\\(")
    .replaceAll(")", "\\)")
    .replace(/[^\x20-\x7e]/g, "?")
    .slice(0, 120);
  const pageContent = `BT\n/F1 18 Tf\n72 720 Td\n(${safeTitle}) Tj\nET\n`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(pageContent, "ascii")} >>\nstream\n${pageContent}endstream`,
  ];

  let pdf = "%PDF-1.4\n% JobCtrl synthetic QA fixture\n";
  const offsets: number[] = [];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }

  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, "ascii");
}

const QA_PROFILE = {
  schema_version: 2,
  personal: {
    full_name: "John Doe",
    preferred_name: "John",
    email: "john.doe@example.com",
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
    <title>John Doe Resume</title>
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
      <h1 data-resume-layout-target="personal:full_name" data-resume-line-number="1">John Doe</h1>
      <p data-resume-layout-target="personal:contact" data-resume-line-number="2">john.doe@example.com | Remote City</p>
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

export function createQaWorkspace(targetDir?: string, options: QaSeedOptions = {}): QaWorkspace {
  const appDir = targetDir ? path.resolve(targetDir) : fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-qa-"));
  fs.mkdirSync(appDir, { recursive: true });
  const workspace = {
    appDir,
    dbPath: path.join(appDir, "jobctrl.db"),
    configPath: path.join(appDir, "config.json"),
  };
  seedQaWorkspace(workspace, options);
  return workspace;
}

export function removeQaWorkspace(workspace: QaWorkspace): void {
  fs.rmSync(workspace.appDir, { force: true, recursive: true });
}

export function seedQaWorkspace(workspace: QaWorkspace, options: QaSeedOptions = {}): void {
  fs.mkdirSync(workspace.appDir, { recursive: true });
  seedQaDatabase(workspace.dbPath, options);
  fs.writeFileSync(
    workspace.configPath,
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

export function seedQaDatabase(dbPath: string, options: QaSeedOptions = {}): void {
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
  fs.writeFileSync(resumePdf, createQaPdfBytes("QA tailored resume"));
  fs.writeFileSync(resumeHtml, QA_RESUME_HTML);
  fs.writeFileSync(coverTxt, "QA cover letter");
  fs.writeFileSync(coverPdf, createQaPdfBytes("QA cover letter"));

  initializeExactV7Database(dbPath);
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  writeProfileConfig(db, {
    profile: QA_PROFILE,
    style: QA_RESUME_STYLE,
    templateText: QA_RESUME_TEMPLATE,
  });
  seedBuiltInResumeTemplate(db);

  // INSPECT-01: a current worker heartbeat so the generate-materials route's
  // worker-readiness gate passes in E2E. ``app_dir``/``db_path`` must match the
  // API runtime (resolved paths) and ``last_seen_at`` must be within the 45s
  // staleness window, so it is written relative to "now" at seed time.
  seedWorkerHeartbeat(db, dbPath);

  insertJob(db, {
    url: QA_PLATFORM_JOB_URL,
    applicationUrl: QA_PLATFORM_JOB_URL,
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
    url: QA_RISK_JOB_URL,
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

  seedPipelineOperations(db, dbPath);
  seedContacts(db);
  if (options.includeDocumentationAnalytics) {
    seedOutcomeAnalytics(db);
  }
  seedDiscoverySources(db);
  seedOutreachThread(db);

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
  seedResumeReviewDraft(db);

  insertEvent(db, "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director", "apply", "info", "QA apply run queued");
  insertEvent(db, "https://linkedin.com/jobs/view/qa-risk-manager", "score", "error", "QA score action failed");
  insertEvent(db, "https://motorolasolutions.com/careers/qa-command-center", "tailor", "info", "QA tailor blocked by fit score");
  db.prepare(
    "INSERT INTO apply_run_projections (run_id, job_id, job_title, job_employer, status, result, dry_run, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).run(
    "qa-run-1",
    QA_PLATFORM_JOB_ID,
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
  // carry no job_id (stage "workflow"); identity travels in the camelCase
  // payload, matching `infrastructure/temporal/finalize.py`. Seeding these
  // keeps the run drawer timeline and the activity/SSE stream consistent with
  // a real finalize + reconcile.
  const insertWorkflowEvent = db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json
     ) VALUES ('local', ?, 1, ?, ?, ?, ?, ?, ?)`,
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

function seedBuiltInResumeTemplate(db: Database.Database): void {
  db.prepare(
    `INSERT INTO resume_templates (
       tenant_id, template_id, display_name, status, built_in, created_at, updated_at
     ) VALUES ('local', 'built_in:modern-html', 'Modern HTML', 'active', 1, ?, ?)`,
  ).run(QA_NOW, QA_NOW);
  db.prepare(
    `INSERT INTO resume_template_versions (
       tenant_id, version_id, template_id, version_number, display_name, status,
       theme_json, layout_json, content_hash, created_at
     ) VALUES ('local', 'built_in:modern-html:v1', 'built_in:modern-html', 1,
               'Modern HTML', 'active', ?, '{}', 'qa-seed-template', ?)`,
  ).run(JSON.stringify(BUILT_IN_RESUME_TEMPLATE_THEME), QA_NOW);
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
      tenant_id, job_id, generation, status, created_at, updated_at, metadata_json
    ) VALUES ('local', ?, ?, ?, ?, ?, ?)`,
  ).run(QA_PLATFORM_JOB_ID, 1, "approved", QA_NOW, QA_NOW, requirementLedMetadata);
  const insert = db.prepare(
    `INSERT INTO job_materials_artifacts (
      tenant_id, job_id, generation, artifact_type, artifact_id, status, path,
      render_format, size_bytes, metadata_json, created_at
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(
    QA_PLATFORM_JOB_ID,
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
    QA_PLATFORM_JOB_ID,
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
    QA_PLATFORM_JOB_ID,
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
    QA_PLATFORM_JOB_ID,
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
      tenant_id, job_id, generation, artifact_id, box_index, semantic_id,
      page_number, line_number, text_excerpt, left_pct, top_pct, width_pct,
      height_pct, audit_target_json, created_at
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertBox.run(
    QA_PLATFORM_JOB_ID,
    1,
    "qa-platform-resume-pdf",
    0,
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
      tenant_id, job_id, generation, snapshot_hash, prompt_version, sdk_set_version,
      cache_key, role_framing, inferred_seniority, ideal_candidate_narrative,
      requirements_json, keywords_json, agreement_json, eeo_screen_json,
      legs_attempted, legs_succeeded, created_at
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    QA_PLATFORM_JOB_ID,
    1,
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
      tenant_id, job_id, score_version, employer_analysis_generation,
      profile_snapshot_version, scoring_policy_version, formula_version,
      resolved_fit_score, fit_band, confidence, summary_json, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    "local",
    QA_PLATFORM_JOB_ID,
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
      tenant_id, job_id, score_version, requirement_id, requirement_text,
      tier, weight, job_evidence_span, fit_json, contribution_json,
      tailoring_json, artifact_coverage_json, position
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertItem.run(
    "local",
    QA_PLATFORM_JOB_ID,
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
    QA_PLATFORM_JOB_ID,
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
      tenant_id, job_id, generation, bullet_id, artifact_id, section, source_id,
      evidence_ids_json, requirement_ids_json, matched_keywords_json,
      transform_type, control, rationale, generated_text, position, created_at
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    QA_PLATFORM_JOB_ID,
    1,
    "summary-1",
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
      tenant_id, job_id, version, fit_score, breakdown_json, keywords_json,
      scored_at, correction_json, criteria_json, trace_json
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    qaJobId(jobUrl),
    1,
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

function seedPipelineOperations(db: Database.Database, dbPath: string): void {
  const now = new Date();
  const nowIso = now.toISOString();
  // Keep the synthetic worker inside the 45-second clock-skew allowance while
  // the documentation capture walks the full route matrix.
  const telemetrySeenAt = new Date(now.getTime() + 30_000).toISOString();
  const startedAt = new Date(now.getTime() - 5 * 60_000).toISOString();
  const discoverWorkflowId = "discover-local";
  const discoverRunId = "00000000-0000-4000-8000-000000000101";
  const platformPreparationWorkflowId = `prep-preparation:${"a".repeat(64)}`;
  const marketingPreparationWorkflowId = `prep-preparation:${"b".repeat(64)}`;
  const riskPreparationWorkflowId = `prep-preparation:${"c".repeat(64)}`;

  db.prepare(
    `INSERT INTO workflow_run_projections (
      workflow_id, tenant_id, workflow_type, status, input_summary_json,
      retryable, started_at, temporal_run_id, events_json
    ) VALUES (?, 'local', 'DiscoverWorkflow', 'in_progress', ?, 0, ?, ?, ?)`,
  ).run(
    discoverWorkflowId,
    JSON.stringify({ limit: 50, workers: 4, source: "all", dryRun: true }),
    startedAt,
    discoverRunId,
    JSON.stringify([
      {
        eventType: "WorkflowStarted",
        occurredAt: startedAt,
        status: "in_progress",
        message: "Synthetic Discover workflow started",
      },
    ]),
  );

  const insertMember = db.prepare(
    `INSERT INTO discovery_execution_jobs (
      tenant_id, discover_workflow_id, discover_run_id, job_id, cohort_kind,
      source_family, source_run_id, preparation_workflow_id, work_plan_state,
      required_steps_json, work_plan_reason, linked_at
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertMember.run(
    discoverWorkflowId,
    discoverRunId,
    QA_PLATFORM_JOB_ID,
    "observed_this_run",
    "greenhouse",
    "qa-greenhouse-run",
    platformPreparationWorkflowId,
    "planned",
    JSON.stringify(["score", "tailor", "cover"]),
    "Strong match selected for preparation",
    nowIso,
  );
  insertMember.run(
    discoverWorkflowId,
    discoverRunId,
    qaJobId("https://talent.com/view?id=qa-marketing-director"),
    "observed_this_run",
    "talent",
    "qa-talent-run",
    marketingPreparationWorkflowId,
    "planned",
    JSON.stringify(["score", "tailor"]),
    "Queued for scoring after enrichment",
    nowIso,
  );
  insertMember.run(
    discoverWorkflowId,
    discoverRunId,
    qaJobId("https://linkedin.com/jobs/view/qa-risk-manager"),
    "existing_backlog",
    "linkedin",
    "qa-linkedin-run",
    riskPreparationWorkflowId,
    "planned",
    JSON.stringify(["score", "tailor"]),
    "Existing backlog item included in this sweep",
    nowIso,
  );
  insertMember.run(
    discoverWorkflowId,
    discoverRunId,
    qaJobId("https://motorolasolutions.com/careers/qa-command-center"),
    "observed_this_run",
    "greenhouse",
    "qa-greenhouse-run",
    null,
    "not_eligible",
    JSON.stringify([]),
    "Below the configured fit threshold",
    nowIso,
  );

  const insertStep = db.prepare(
    `INSERT INTO pipeline_step_projections (
      tenant_id, discover_workflow_id, discover_run_id, step_kind, item_key,
      state, attempt, queued_at, started_at, finished_at, duration_ms,
      retryable, detail_count, last_event_id, last_updated_at
    ) VALUES ('local', ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 0, ?, ?, ?)`,
  );
  const completedAt = new Date(now.getTime() - 2 * 60_000).toISOString();
  insertStep.run(
    discoverWorkflowId,
    discoverRunId,
    "source_planning",
    "plan",
    "succeeded",
    startedAt,
    startedAt,
    completedAt,
    30_000,
    3,
    101,
    completedAt,
  );
  insertStep.run(
    discoverWorkflowId,
    discoverRunId,
    "source_family",
    "greenhouse",
    "succeeded",
    startedAt,
    startedAt,
    completedAt,
    75_000,
    2,
    102,
    completedAt,
  );
  insertStep.run(
    discoverWorkflowId,
    discoverRunId,
    "source_family",
    "linkedin",
    "running",
    startedAt,
    new Date(now.getTime() - 90_000).toISOString(),
    null,
    null,
    null,
    103,
    nowIso,
  );
  insertStep.run(
    discoverWorkflowId,
    discoverRunId,
    "source_family",
    "talent",
    "queued",
    nowIso,
    null,
    null,
    null,
    null,
    104,
    nowIso,
  );
  insertStep.run(
    discoverWorkflowId,
    discoverRunId,
    "enrichment_pass",
    "observed-jobs",
    "succeeded",
    startedAt,
    startedAt,
    completedAt,
    60_000,
    4,
    105,
    completedAt,
  );
  insertStep.run(
    discoverWorkflowId,
    discoverRunId,
    "existing_backlog_sweep",
    "existing-backlog",
    "running",
    startedAt,
    new Date(now.getTime() - 60_000).toISOString(),
    null,
    null,
    1,
    106,
    nowIso,
  );
  insertStep.run(
    discoverWorkflowId,
    discoverRunId,
    "preparation_fanout",
    "selected-jobs",
    "running",
    startedAt,
    new Date(now.getTime() - 45_000).toISOString(),
    null,
    null,
    3,
    107,
    nowIso,
  );

  const recoveryMemberships = (
    db
      .prepare(
        `SELECT job_id FROM discovery_execution_jobs
          WHERE tenant_id = 'local' AND discover_workflow_id = ? AND discover_run_id = ?
          ORDER BY job_id`,
      )
      .all(discoverWorkflowId, discoverRunId) as Array<{ job_id: string }>
  ).map((row) => row.job_id);
  const recoverySteps = (
    db
      .prepare(
        `SELECT step_kind, item_key FROM pipeline_step_projections
          WHERE tenant_id = 'local' AND discover_workflow_id = ? AND discover_run_id = ?
          ORDER BY step_kind, item_key`,
      )
      .all(discoverWorkflowId, discoverRunId) as Array<{
        step_kind: string;
        item_key: string;
      }>
  ).map((row): [string, string] => [row.step_kind, row.item_key]);
  db.prepare(
    `INSERT INTO discovery_execution_recoveries (
      tenant_id, discover_workflow_id, discover_run_id, state, mode,
      decoder_version, history_event_id, expected_membership_count,
      persisted_membership_count, expected_step_count, persisted_step_count,
      key_digest, last_error_code, updated_at
    ) VALUES ('local', ?, ?, 'ready', 'native', 2, 107, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    discoverWorkflowId,
    discoverRunId,
    recoveryMemberships.length,
    recoveryMemberships.length,
    recoverySteps.length,
    recoverySteps.length,
    recoveryKeyDigest(recoveryMemberships, recoverySteps),
    nowIso,
  );

  const insertMetric = db.prepare(
    `INSERT INTO operational_attempt_metrics (
      tenant_id, occurred_at, stage, attempt_kind, outcome, is_retryable,
      run_id, duration_ms, metadata_json
    ) VALUES ('local', ?, ?, 'worker', 'succeeded', 0, ?, ?, '{}')`,
  );
  for (const [stage, durationMs] of [
    ["discover", 75_000],
    ["score", 55_000],
    ["tailor", 80_000],
    ["cover", 45_000],
  ] as const) {
    for (let sample = 0; sample < 5; sample += 1) {
      insertMetric.run(
        new Date(now.getTime() - (sample + 1) * 60_000).toISOString(),
        stage,
        discoverRunId,
        durationMs + sample * 1_000,
      );
    }
  }

  const queueStats = {
    pollerCount: 2,
    approximateBacklogCount: 0,
    approximateBacklogAgeSeconds: 0,
    tasksAddRate: 1.4,
    tasksDispatchRate: 1.3,
  };
  const activeDetails = [
    {
      activityType: "discovery_source_family",
      operationalRef: { kind: "discovery-source-family", opaqueId: "op_000000000000000000000101" },
      workflowRef: discoverWorkflowId,
      executionRef: discoverRunId,
      attempt: 1,
      startedAt: new Date(now.getTime() - 90_000).toISOString(),
    },
    {
      activityType: "score_job",
      operationalRef: { kind: "job-scoring", opaqueId: "op_000000000000000000000102" },
      workflowRef: marketingPreparationWorkflowId,
      executionRef: discoverRunId,
      attempt: 1,
      startedAt: new Date(now.getTime() - 45_000).toISOString(),
    },
  ];
  db.prepare(
    `UPDATE worker_runtime_heartbeats SET
      app_dir = ?, db_path = ?, last_seen_at = ?, active_activity_count = 2,
      active_activity_counts_json = ?, active_activity_details_json = ?,
      active_activity_details_total = 2, active_activity_details_truncated = 0,
      activity_duration_summary_json = ?, task_queue_observation_json = ?,
      heartbeat_schema_version = 2
    WHERE worker_id = 'qa-worker-1'`,
  ).run(
    path.resolve(path.dirname(dbPath)),
    path.resolve(dbPath),
    telemetrySeenAt,
    JSON.stringify({ discovery_source_family: 1, score_job: 1 }),
    JSON.stringify(activeDetails),
    JSON.stringify({
      discovery_source_family: { completedCount: 6, totalDurationMs: 450_000, maxDurationMs: 90_000 },
      score_job: { completedCount: 8, totalDurationMs: 440_000, maxDurationMs: 70_000 },
    }),
    JSON.stringify({
      status: "available",
      observedAt: telemetrySeenAt,
      workflow: queueStats,
      activity: queueStats,
    }),
  );
}

function recoveryKeyDigest(
  membershipKeys: readonly string[],
  stepKeys: ReadonlyArray<readonly [string, string]>,
): string {
  const memberships = membershipKeys
    .map((value) => Buffer.from(value, "utf8").toString("hex"))
    .sort();
  const steps = stepKeys
    .map((value) => Buffer.from(JSON.stringify(value), "utf8").toString("hex"))
    .sort();
  return createHash("sha256")
    .update(JSON.stringify({ memberships, steps }))
    .digest("hex");
}

function seedResumeReviewDraft(db: Database.Database): void {
  db.prepare(
    `INSERT INTO resume_review_drafts (
      tenant_id, draft_id, job_id, base_generation,
      base_resume_text_artifact_id, base_resume_pdf_artifact_id,
      renderer_format, state, current_revision_id, latest_revision_number,
      created_at, updated_at
    ) VALUES ('local', ?, ?, 1, ?, ?, 'html_pdf', 'active', NULL, 0, ?, ?)`,
  ).run(
    "qa-platform-resume-draft",
    QA_PLATFORM_JOB_ID,
    "qa-platform-resume-text",
    "qa-platform-resume-pdf",
    QA_NOW,
    QA_NOW,
  );
}

function seedContacts(db: Database.Database): void {
  const insertContact = db.prepare(
    `INSERT INTO contacts (
      tenant_id, contact_id, employer, job_id, role, created_at, updated_at
    ) VALUES ('local', ?, ?, ?, ?, ?, ?)`,
  );
  insertContact.run(
    "qa-contact-hiring-manager",
    "GitLab",
    QA_PLATFORM_JOB_ID,
    "hiring_manager",
    QA_NOW,
    QA_NOW,
  );
  insertContact.run(
    "qa-contact-recruiter",
    "GitLab",
    QA_PLATFORM_JOB_ID,
    "recruiter",
    QA_NOW,
    QA_NOW,
  );

  const insertAttribute = db.prepare(
    `INSERT INTO contact_attributes (
      tenant_id, attribute_id, contact_id, attribute_kind, value_json,
      source_kind, source_ref, capture_method, confidence, user_confirmed, recorded_at
    ) VALUES ('local', ?, ?, ?, ?, 'user_entered', 'synthetic_qa_fixture', 'manual', 1, 1, ?)`,
  );
  for (const [attributeId, contactId, kind, value] of [
    ["qa-contact-hm-name", "qa-contact-hiring-manager", "name", "Morgan Lee"],
    ["qa-contact-hm-title", "qa-contact-hiring-manager", "title", "VP, Platform Engineering"],
    ["qa-contact-hm-note", "qa-contact-hiring-manager", "note", "Synthetic hiring-manager contact for route QA."],
    ["qa-contact-rec-name", "qa-contact-recruiter", "name", "Taylor Chen"],
    ["qa-contact-rec-title", "qa-contact-recruiter", "title", "Senior Technical Recruiter"],
    ["qa-contact-rec-email", "qa-contact-recruiter", "email", "taylor.chen@example.invalid"],
  ] as const) {
    insertAttribute.run(attributeId, contactId, kind, JSON.stringify(value), QA_NOW);
  }
}

function seedOutcomeAnalytics(db: Database.Database): void {
  const applications = [
    {
      url: "https://boards.greenhouse.io/northstarlabs/jobs/qa-analytics-platform-manager",
      title: "Platform Engineering Manager",
      site: "greenhouse",
      location: "Remote, United States",
      fitScore: 8,
      appliedAt: "2026-04-01T09:00:00+00:00",
      outcomeId: "qa-outcome-greenhouse-1",
      outcomeKind: "recruiter_reply",
      outcomeAt: "2026-04-03T15:30:00+00:00",
      suggestion: {
        id: "qa-suggestion-greenhouse-1",
        suggestedKind: "recruiter_reply",
        status: "accepted",
        decision: "accept",
      },
    },
    {
      url: "https://boards.greenhouse.io/northstarlabs/jobs/qa-analytics-sre-director",
      title: "Director, Site Reliability Engineering",
      site: "greenhouse",
      location: "Remote, Canada",
      fitScore: 8,
      appliedAt: "2026-04-02T09:00:00+00:00",
      outcomeId: "qa-outcome-greenhouse-2",
      outcomeKind: "interview",
      outcomeAt: "2026-04-07T13:00:00+00:00",
      suggestion: {
        id: "qa-suggestion-greenhouse-2",
        suggestedKind: "interview",
        status: "accepted",
        decision: "accept",
      },
    },
    {
      url: "https://boards.greenhouse.io/northstarlabs/jobs/qa-analytics-devex-manager",
      title: "Engineering Manager, Developer Experience",
      site: "greenhouse",
      location: "Remote, Europe",
      fitScore: 8,
      appliedAt: "2026-04-03T09:00:00+00:00",
      outcomeId: "qa-outcome-greenhouse-3",
      outcomeKind: "offer",
      outcomeAt: "2026-04-15T10:00:00+00:00",
      suggestion: {
        id: "qa-suggestion-greenhouse-3",
        suggestedKind: "offer",
        status: "accepted",
        decision: "accept",
      },
    },
    {
      url: "https://boards.greenhouse.io/northstarlabs/jobs/qa-analytics-cloud-manager",
      title: "Senior Manager, Cloud Platform",
      site: "greenhouse",
      location: "Remote, United Kingdom",
      fitScore: 8,
      appliedAt: "2026-04-04T09:00:00+00:00",
      outcomeId: "qa-outcome-greenhouse-4",
      outcomeKind: "rejection",
      outcomeAt: "2026-04-10T11:45:00+00:00",
      suggestion: {
        id: "qa-suggestion-greenhouse-4",
        suggestedKind: "recruiter_reply",
        status: "corrected",
        decision: "correct",
      },
    },
    {
      url: "https://boards.greenhouse.io/northstarlabs/jobs/qa-analytics-security-director",
      title: "Director, Infrastructure Security",
      site: "greenhouse",
      location: "Remote, United States",
      fitScore: 8,
      appliedAt: "2026-04-05T09:00:00+00:00",
      outcomeId: "qa-outcome-greenhouse-5",
      outcomeKind: "no_response",
      outcomeAt: "2026-05-05T09:00:00+00:00",
      suggestion: {
        id: "qa-suggestion-greenhouse-5",
        suggestedKind: "recruiter_reply",
        status: "ignored",
        decision: "ignore",
      },
    },
    {
      url: "https://www.linkedin.com/jobs/view/qa-analytics-platform-operations",
      title: "Head of Platform Operations",
      site: "linkedin",
      location: "Remote, Spain",
      fitScore: 6,
      appliedAt: "2026-04-06T09:00:00+00:00",
      outcomeId: "qa-outcome-linkedin-1",
      outcomeKind: "interview",
      outcomeAt: "2026-04-09T16:00:00+00:00",
      suggestion: null,
    },
    {
      url: "https://www.linkedin.com/jobs/view/qa-analytics-reliability-manager",
      title: "Engineering Manager, Reliability",
      site: "linkedin",
      location: "Remote, Germany",
      fitScore: 6,
      appliedAt: "2026-04-07T09:00:00+00:00",
      outcomeId: "qa-outcome-linkedin-2",
      outcomeKind: "recruiter_reply",
      outcomeAt: "2026-04-09T12:00:00+00:00",
      suggestion: null,
    },
    {
      url: "https://www.linkedin.com/jobs/view/qa-analytics-infrastructure-programs",
      title: "Director, Infrastructure Programs",
      site: "linkedin",
      location: "Remote, France",
      fitScore: 6,
      appliedAt: "2026-04-08T09:00:00+00:00",
      outcomeId: "qa-outcome-linkedin-3",
      outcomeKind: "no_response",
      outcomeAt: "2026-05-08T09:00:00+00:00",
      suggestion: null,
    },
  ] as const;
  const markApplied = db.prepare(
    "UPDATE jobs SET apply_status = 'applied', applied_at = ? WHERE tenant_id = 'local' AND job_id = ?",
  );
  const insertOutcome = db.prepare(
    `INSERT INTO application_outcomes (
      tenant_id, outcome_id, job_id, kind, source, note, occurred_at,
      recorded_at, suggestion_id, evidence_id, interview_prep_generation
    ) VALUES ('local', ?, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL)`,
  );
  const insertSuggestion = db.prepare(
    `INSERT INTO application_outcome_suggestions (
      tenant_id, suggestion_id, job_id, evidence_id, suggested_kind,
      confidence, rationale, status, created_at, decided_at, decision,
      decision_reason, decided_outcome_id
    ) VALUES ('local', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  for (const application of applications) {
    insertJob(db, {
      url: application.url,
      title: application.title,
      site: application.site,
      location: application.location,
      fitScore: application.fitScore,
      description: "Lead reliable platform systems and cross-functional engineering programs.",
    });
    for (const stage of ["discover", "enrich", "score", "tailor", "cover", "apply"]) {
      insertStage(db, application.url, stage, "succeeded");
    }
    const jobId = qaJobId(application.url);
    markApplied.run(application.appliedAt, jobId);
    const suggestionId =
      application.suggestion?.status === "ignored" ? null : application.suggestion?.id ?? null;
    insertOutcome.run(
      application.outcomeId,
      jobId,
      application.outcomeKind,
      suggestionId ? "email_suggestion" : "manual",
      application.outcomeAt,
      application.outcomeAt,
      suggestionId,
    );
    if (application.suggestion) {
      const createdAt = new Date(Date.parse(application.outcomeAt) - 30 * 60_000).toISOString();
      insertSuggestion.run(
        application.suggestion.id,
        jobId,
        application.suggestion.suggestedKind,
        0.9,
        "Synthetic email signal matched to this application for documentation QA.",
        application.suggestion.status,
        createdAt,
        application.outcomeAt,
        application.suggestion.decision,
        "Reviewed against the synthetic application timeline.",
        application.suggestion.status === "ignored" ? null : application.outcomeId,
      );
    }
  }
}

function seedDiscoverySources(db: Database.Database): void {
  const insertSource = db.prepare(
    `INSERT INTO source_registry_entries (
      tenant_id, source_id, kind, display_name, owner, priority, state,
      policy_id, seed_url, created_at, updated_at
    ) VALUES ('local', ?, ?, ?, 'system', ?, 'active', ?, ?, ?, ?)`,
  );
  insertSource.run(
    "greenhouse:northstar-labs",
    "ats_api",
    "Northstar Labs",
    "canonical",
    "local:greenhouse:northstar-labs",
    "https://boards.greenhouse.io/northstarlabs",
    "2026-06-12T09:00:00+00:00",
    "2026-07-12T09:00:00+00:00",
  );
  insertSource.run(
    "lever:orbit-systems",
    "ats_api",
    "Orbit Systems",
    "preferred",
    "local:lever:orbit-systems",
    "https://jobs.lever.co/orbit-systems",
    "2026-06-12T09:00:00+00:00",
    "2026-07-12T09:05:00+00:00",
  );

  const insertQuality = db.prepare(
    `INSERT INTO source_quality_stats (
      tenant_id, source_id, window_start, window_end, run_count,
      failed_run_count, consecutive_failures, observed_jobs, new_jobs,
      existing_jobs, duplicate_jobs, active_jobs, stale_jobs,
      detail_success_count, detail_failure_count, active_verification_rate,
      duplicate_rate, full_description_success_rate, apply_url_success_rate,
      last_run_id, last_error_class, recommended_state, updated_at
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  insertQuality.run(
    "greenhouse:northstar-labs",
    "2026-06-12T09:00:00+00:00",
    "2026-07-12T09:00:00+00:00",
    12,
    1,
    0,
    48,
    17,
    31,
    2,
    42,
    6,
    44,
    4,
    0.875,
    0.0417,
    0.9167,
    0.9375,
    "discover-local",
    null,
    "normal",
    "2026-07-12T09:00:00+00:00",
  );
  insertQuality.run(
    "lever:orbit-systems",
    "2026-06-12T09:00:00+00:00",
    "2026-07-12T09:05:00+00:00",
    9,
    4,
    3,
    20,
    6,
    14,
    7,
    8,
    12,
    9,
    11,
    0.4,
    0.35,
    0.45,
    0.55,
    "discover-local",
    "HTTP_429",
    "quarantined",
    "2026-07-12T09:05:00+00:00",
  );
  db.prepare(
    `INSERT INTO operational_attempt_metrics (
      tenant_id, occurred_at, stage, source_id, source_kind, source_priority,
      adapter, attempt_kind, outcome, failure_category, is_operational_failure,
      is_scrape_failure, is_retryable, run_id, duration_ms, metadata_json
    ) VALUES (
      'local', ?, 'discover', ?, 'ats_api', 'preferred', 'lever_api',
      'politeness_gate', 'blocked', 'rate_limited', 0, 0, 1, ?, 0, '{}'
    )`,
  ).run(
    "2026-07-12T09:04:00+00:00",
    "lever:orbit-systems",
    "discover-local",
  );
}

function seedOutreachThread(db: Database.Database): void {
  const threadId = "qa-outreach-hiring-manager";
  const approvedDraftId = "qa-outreach-approved-intro";
  const gateResults = JSON.stringify({
    passed: true,
    computedAgainst: "rendered_draft_text",
    fabrications: [],
    validation: {
      passed: true,
      errors: [],
      warnings: ["Keep the final recipient and send timing user-controlled."],
    },
    judge: {
      approved: true,
      score: 0.94,
      criterionScores: { truthfulness: 0.98, relevance: 0.93, tone: 0.91 },
      issues: [],
      notes: "Every claim is grounded in confirmed contact facts or synthetic profile evidence.",
    },
  });
  const provenance = JSON.stringify([
    {
      claimId: "qa-outreach-claim-contact",
      section: "opening",
      generatedText: "I noticed you lead Platform Engineering at GitLab.",
      contactFactIds: ["qa-contact-hm-name", "qa-contact-hm-title"],
      profileGrounded: false,
      rationale: "Uses the confirmed synthetic contact name and title facts.",
    },
    {
      claimId: "qa-outreach-claim-profile",
      section: "body",
      generatedText: "My background includes leading platform reliability and incident-response programs.",
      contactFactIds: [],
      profileGrounded: true,
      rationale: "Grounded in the synthetic candidate profile evidence ev-platform and ev-incident.",
    },
  ]);

  db.prepare(
    `INSERT INTO outreach_threads (
      tenant_id, thread_id, contact_id, job_id, created_at, updated_at,
      follow_up_due_at, follow_up_basis, follow_up_state
    ) VALUES ('local', ?, 'qa-contact-hiring-manager', NULL, ?, ?, ?, 'manual', 'scheduled')`,
  ).run(
    threadId,
    "2026-07-08T09:00:00+00:00",
    "2026-07-10T14:00:00+00:00",
    "2026-07-17T09:00:00+00:00",
  );
  const insertDraft = db.prepare(
    `INSERT INTO outreach_drafts (
      tenant_id, draft_id, thread_id, generation, kind, status, body_text,
      gate_results_json, provenance_json, created_at, approved_at, rejected_at, reason
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '')`,
  );
  insertDraft.run(
    approvedDraftId,
    threadId,
    1,
    "intro_request",
    "approved",
    "Hi Morgan,\n\nI am exploring the Director of Platform Engineering role at GitLab. My background leading platform reliability and incident-response programs seems closely aligned with the team. Would you be open to a brief conversation about the role's priorities?\n\nThank you,\nJohn",
    gateResults,
    provenance,
    "2026-07-08T09:00:00+00:00",
    "2026-07-08T09:20:00+00:00",
  );
  insertDraft.run(
    "qa-outreach-follow-up-candidate",
    threadId,
    2,
    "follow_up",
    "candidate",
    "Hi Morgan,\n\nI wanted to follow up on my note about the Director of Platform Engineering role. I would value your perspective on the team's reliability and developer-experience priorities.\n\nThank you,\nJohn",
    gateResults,
    provenance,
    "2026-07-10T14:00:00+00:00",
    null,
  );
  db.prepare(
    `INSERT INTO outreach_send_logs (
      tenant_id, send_log_id, thread_id, draft_id, channel, sent_at, logged_at
    ) VALUES ('local', ?, ?, ?, 'linkedin_message', ?, ?)`,
  ).run(
    "qa-outreach-send-log",
    threadId,
    approvedDraftId,
    "2026-07-09T10:00:00+00:00",
    "2026-07-09T10:05:00+00:00",
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
    "jobctrl-default",
    new Date().toISOString(),
    new Date().toISOString(),
    4,
    6,
  );
}

function insertJob(db: Database.Database, job: QaJobSeed): void {
  db.prepare(
    `INSERT INTO jobs (
      url, tenant_id, job_id, title, site, strategy, location, salary, discovered_at, application_url,
      description, full_description, detail_scraped_at, fit_score, score_reasoning,
      scored_at, tailored_resume_path, tailored_at
    ) VALUES (?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    job.url,
    qaJobId(job.url),
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

function qaJobId(jobUrl: string): string {
  const digest = createHash("sha256").update(jobUrl).digest("hex");
  return `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
}

function insertStage(db: Database.Database, jobUrl: string, stage: string, state: string, errorCode: string | null = null): void {
  db.prepare(
    `INSERT INTO job_stage_states (
      tenant_id, job_id, stage, state, attempt_count, max_attempts, updated_at,
      error_code, error_message, retryable, blocked_by_json
    ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    qaJobId(jobUrl),
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
    `INSERT INTO job_artifacts (
       tenant_id, job_id, stage, artifact_type, status, path, created_at, size_bytes
     ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?)`,
  ).run(qaJobId(jobUrl), artifactStage(type), type, "active", filePath, QA_NOW, localFileSize(filePath));
}

function insertEvent(db: Database.Database, jobUrl: string, stage: string, level: string, message: string): void {
  // ``event_type`` defaults to '' in the schema, but the SSE writer
  // (``apps/api/src/event-stream.ts``) skips rows where the column is
  // empty — without this column being set, every QA-seeded event is
  // silently dropped from /v1/events/stream and any test that depends
  // on the SSE pipeline against qa-seed data sees nothing.
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at
     ) VALUES ('local', ?, 1, ?, ?, ?, ?, ?)`,
  ).run(qaJobId(jobUrl), stage, "QaInfo", level, message, QA_NOW);
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
  const workspace = createQaWorkspace(process.argv[2], {
    includeDocumentationAnalytics: true,
  });
  process.stdout.write(
    `${JSON.stringify(
      {
        appDir: workspace.appDir,
        dbPath: workspace.dbPath,
        configPath: workspace.configPath,
      },
      null,
      2,
    )}\n`,
  );
}
