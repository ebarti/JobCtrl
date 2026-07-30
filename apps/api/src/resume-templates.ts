import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type {
  EnsureCurrentResumeMaterialsResponse,
  JobResumeTemplateAssignmentRequest,
  JobResumeTemplateAssignmentResponse,
  ResumeLayoutBox,
  ResumeTemplateDefaultSelectionRequest,
  ResumeTemplateDefaultSelectionResponse,
  ResumeTemplateDetailResponse,
  ResumeTemplateLayout,
  ResumeTemplateListResponse,
  ResumeTemplateMetadata,
  ResumeTemplateRefreshAttempt,
  ResumeTemplateRefreshStatus,
  ResumeTemplateState,
  ResumeTemplateStaleState,
  ResumeTemplateSummary,
  ResumeTemplateTheme,
  ResumeTemplateVersionSaveRequest,
  ResumeTemplateVersionSaveResponse,
  ResumeTemplateVersionSummary,
} from "./contracts.js";
import {
  ResumeTemplateLayoutSchema,
  ResumeTemplateThemeSchema,
} from "./contracts.js";
import {
  allRows,
  getRow,
  jobReferenceColumn,
  jobReferenceForUrl,
  jobReferenceJoinToJobs,
  jobReferencePredicateForUrl,
  tableExists,
  type SqliteDatabase,
  type SqliteValue,
} from "./db.js";
import { defaultResumeHtmlPdfRenderer, type ResumeHtmlPdfRenderer } from "./resume-pdf-render.js";

const DEFAULT_TENANT = "local";
const DEFAULT_PROFILE_ID = "default";
const BUILT_IN_TEMPLATE_ID = "built_in:modern-html";
const BUILT_IN_VERSION_ID = "built_in:modern-html:v1";
const TEMPLATE_METADATA_KEY = "resume_template";
const TEMPLATE_REFRESH_SOURCE = "resume_template_lazy_refresh";
const TEXT_BYTE_LIMIT = 128_000;

export class ResumeTemplateInputError extends Error {}

interface TemplateRow extends Record<string, unknown> {
  template_id: string;
  tenant_id: string;
  display_name: string;
  status: string;
  built_in: number;
  created_at: string;
  updated_at: string;
}

interface TemplateVersionRow extends Record<string, unknown> {
  version_id: string;
  template_id: string;
  tenant_id: string;
  version_number: number;
  display_name: string;
  status: string;
  theme_json: string;
  layout_json: string;
  content_hash: string;
  created_at: string;
}

interface AssignmentRow extends Record<string, unknown> {
  template_id: string | null;
  version_id: string | null;
  updated_at: string;
}

interface MaterialArtifactRow extends Record<string, unknown> {
  artifact_id: string | null;
  artifact_type: string;
  generation: number;
  path: string | null;
  render_format: string | null;
  metadata_json: string | null;
  created_at: string | null;
}

interface RefreshAttemptRow extends Record<string, unknown> {
  attempt_id: string;
  job_url: string;
  status: string;
  from_generation: number | null;
  to_generation: number | null;
  template_id: string | null;
  template_version_id: string | null;
  template_hash: string | null;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
}

interface EffectiveTemplate {
  readonly metadata: ResumeTemplateMetadata;
  readonly version: ResumeTemplateVersionSummary;
}

export const BUILT_IN_RESUME_TEMPLATE_THEME: ResumeTemplateTheme =
  ResumeTemplateThemeSchema.parse({
    pageSize: "a4",
    fontFamily: "sans",
    fontScale: 1,
    density: "balanced",
    marginMm: { top: 16.5, right: 17.5, bottom: 18, left: 17.5 },
    headerLayout: "centered",
    sectionHeadingStyle: "rule",
    alignment: "justified",
    bulletSpacing: "normal",
    accentColor: "#111111",
    sectionOrder: ["summary", "experience", "education", "skills"],
    hiddenSections: [],
  });

const EMPTY_LAYOUT: ResumeTemplateLayout = ResumeTemplateLayoutSchema.parse({});

export function ensureResumeTemplateTables(db: SqliteDatabase): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS resume_templates (
      tenant_id    TEXT NOT NULL DEFAULT 'local',
      template_id  TEXT NOT NULL,
      display_name TEXT NOT NULL,
      status       TEXT NOT NULL DEFAULT 'active',
      built_in     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL,
      PRIMARY KEY (tenant_id, template_id)
    );
    CREATE TABLE IF NOT EXISTS resume_template_versions (
      tenant_id      TEXT NOT NULL DEFAULT 'local',
      version_id     TEXT NOT NULL,
      template_id    TEXT NOT NULL,
      version_number INTEGER NOT NULL,
      display_name   TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'active',
      theme_json     TEXT NOT NULL,
      layout_json    TEXT NOT NULL DEFAULT '{}',
      content_hash   TEXT NOT NULL,
      created_at     TEXT NOT NULL,
      PRIMARY KEY (tenant_id, version_id),
      UNIQUE (tenant_id, template_id, version_number)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_template_versions_template
      ON resume_template_versions(tenant_id, template_id, version_number DESC);

    CREATE TABLE IF NOT EXISTS resume_template_defaults (
      tenant_id   TEXT NOT NULL DEFAULT 'local',
      profile_id  TEXT NOT NULL DEFAULT 'default',
      template_id TEXT NOT NULL,
      version_id  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (tenant_id, profile_id)
    );

    CREATE TABLE IF NOT EXISTS job_resume_template_assignments (
      tenant_id   TEXT NOT NULL DEFAULT 'local',
      job_url     TEXT NOT NULL,
      template_id TEXT NOT NULL,
      version_id  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_url)
    );
    CREATE INDEX IF NOT EXISTS idx_job_resume_template_assignments_template
      ON job_resume_template_assignments(tenant_id, template_id, version_id);

    CREATE TABLE IF NOT EXISTS resume_template_refresh_attempts (
      tenant_id           TEXT NOT NULL DEFAULT 'local',
      attempt_id          TEXT NOT NULL,
      job_url             TEXT NOT NULL,
      status              TEXT NOT NULL,
      from_generation     INTEGER,
      to_generation       INTEGER,
      template_id         TEXT,
      template_version_id TEXT,
      template_hash       TEXT,
      error_message       TEXT,
      metadata_json       TEXT NOT NULL DEFAULT '{}',
      created_at          TEXT NOT NULL,
      completed_at        TEXT,
      PRIMARY KEY (tenant_id, attempt_id)
    );
    CREATE INDEX IF NOT EXISTS idx_resume_template_refresh_attempts_job
      ON resume_template_refresh_attempts(tenant_id, job_url, created_at DESC);
  `);
  seedBuiltInResumeTemplate(db);
}

export function listResumeTemplates(db: SqliteDatabase): ResumeTemplateListResponse {
  ensureResumeTemplateTables(db);
  const rows = allRows<TemplateRow>(
    db,
    `SELECT *
       FROM resume_templates
      WHERE tenant_id = ?
      ORDER BY built_in DESC, LOWER(display_name), template_id`,
    [DEFAULT_TENANT],
  );
  const templates = rows.map((row) => templateSummaryFromRow(db, row)).filter(isPresent);
  const defaultTemplate = readDefaultTemplate(db);
  const builtInDefault = resolveBuiltInTemplate(db);
  return {
    ok: true,
    templates,
    defaultTemplate: defaultTemplate?.metadata ?? null,
    builtInDefault: builtInDefault.metadata,
    effectiveDefaultVersion: (defaultTemplate ?? builtInDefault).version,
  };
}

export function getResumeTemplateDetail(db: SqliteDatabase, templateId: string): ResumeTemplateDetailResponse | null {
  ensureResumeTemplateTables(db);
  const template = templateSummaryFromRow(db, getTemplateRow(db, templateId));
  return template ? { ok: true, template } : null;
}

export function createResumeTemplateVersion(
  db: SqliteDatabase,
  request: ResumeTemplateVersionSaveRequest,
): ResumeTemplateVersionSaveResponse {
  ensureResumeTemplateTables(db);
  const normalized = normalizeTemplateVersionRequest(request);
  assertTemplatePayloadSafe(db, normalized);

  const now = new Date().toISOString();
  const templateId = normalized.templateId ?? `resume_template_${crypto.randomUUID()}`;
  const existing = getTemplateRow(db, templateId);
  const versionNumber = nextTemplateVersionNumber(db, templateId);
  const versionId = `${templateId}:v${versionNumber}:${crypto.randomUUID().slice(0, 8)}`;
  const contentHash = templateContentHash(normalized.theme, normalized.layout);

  insertDynamicRow(db, "resume_templates", {
    tenant_id: DEFAULT_TENANT,
    template_id: templateId,
    display_name: normalized.displayName,
    status: "active",
    built_in: existing?.built_in ?? 0,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  });
  insertDynamicRow(db, "resume_template_versions", {
    tenant_id: DEFAULT_TENANT,
    version_id: versionId,
    template_id: templateId,
    version_number: versionNumber,
    display_name: normalized.displayName,
    status: "active",
    theme_json: JSON.stringify(normalized.theme),
    layout_json: JSON.stringify(normalized.layout),
    content_hash: contentHash,
    created_at: now,
  });
  recordTemplateEvent(db, {
    jobUrl: null,
    eventType: "ResumeTemplateVersionSaved",
    message: `Resume template saved: ${normalized.displayName}`,
    payload: {
      templateId,
      templateVersionId: versionId,
      versionNumber,
      displayName: normalized.displayName,
      savedAt: now,
    },
  });

  const template = templateSummaryFromRow(db, getTemplateRow(db, templateId));
  if (!template) {
    throw new Error("Resume template version was not persisted.");
  }
  return { ok: true, template };
}

export function setDefaultResumeTemplate(
  db: SqliteDatabase,
  request: ResumeTemplateDefaultSelectionRequest,
): ResumeTemplateDefaultSelectionResponse {
  ensureResumeTemplateTables(db);
  const effective = resolveTemplateByRequest(db, request.templateId, request.versionId, "profile_default");
  const now = new Date().toISOString();
  insertDynamicRow(db, "resume_template_defaults", {
    tenant_id: DEFAULT_TENANT,
    profile_id: DEFAULT_PROFILE_ID,
    template_id: effective.metadata.templateId,
    version_id: effective.metadata.templateVersionId,
    updated_at: now,
  });
  recordTemplateEvent(db, {
    jobUrl: null,
    eventType: "ResumeTemplateDefaultChanged",
    message: `Default resume template changed to ${effective.metadata.templateName}`,
    payload: {
      templateId: effective.metadata.templateId,
      templateVersionId: effective.metadata.templateVersionId,
      changedAt: now,
    },
  });
  return { ok: true, defaultTemplate: effective.metadata };
}

export function setJobResumeTemplateAssignment(
  db: SqliteDatabase,
  jobKey: string,
  request: JobResumeTemplateAssignmentRequest,
): JobResumeTemplateAssignmentResponse {
  ensureResumeTemplateTables(db);
  assertJobExists(db, jobKey);
  const now = new Date().toISOString();
  let overrideTemplate: ResumeTemplateMetadata | null = null;

  if (request.templateId === null) {
    db.prepare(
      "DELETE FROM job_resume_template_assignments WHERE tenant_id = ? AND job_url = ?",
    ).run(DEFAULT_TENANT, jobKey);
  } else if (request.templateId) {
    const effective = resolveTemplateByRequest(db, request.templateId, request.versionId ?? undefined, "job_override");
    insertDynamicRow(db, "job_resume_template_assignments", {
      tenant_id: DEFAULT_TENANT,
      job_url: jobKey,
      template_id: effective.metadata.templateId,
      version_id: effective.metadata.templateVersionId,
      updated_at: now,
    });
    overrideTemplate = effective.metadata;
  }

  const effectiveTemplate = resolveEffectiveResumeTemplate(db, jobKey);
  recordTemplateEvent(db, {
    jobUrl: jobKey,
    eventType: "JobResumeTemplateAssigned",
    message: overrideTemplate
      ? `Job resume template set to ${overrideTemplate.templateName}`
      : "Job resume template override cleared",
    payload: {
      jobId: jobKey,
      templateId: overrideTemplate?.templateId ?? null,
      templateVersionId: overrideTemplate?.templateVersionId ?? null,
      assignedAt: now,
    },
  });
  return {
    ok: true,
    jobKey,
    effectiveTemplate: effectiveTemplate.metadata,
    overrideTemplate,
    templateState: resumeTemplateStateForJob(db, jobKey),
  };
}

export function resolveEffectiveResumeTemplate(db: SqliteDatabase, jobKey?: string | null): EffectiveTemplate {
  ensureResumeTemplateTables(db);
  if (jobKey) {
    const assignment = getRow<AssignmentRow>(
      db,
      `SELECT template_id, version_id, updated_at
         FROM job_resume_template_assignments
        WHERE tenant_id = ? AND job_url = ?`,
      [DEFAULT_TENANT, jobKey],
    );
    if (assignment?.template_id && assignment.version_id) {
      return resolveTemplateByRequest(db, assignment.template_id, assignment.version_id, "job_override");
    }
  }
  const defaultTemplate = readDefaultTemplate(db);
  if (defaultTemplate) return defaultTemplate;
  return resolveBuiltInTemplate(db);
}

export function resumeTemplateStateForJob(db: SqliteDatabase, jobKey: string): ResumeTemplateState | null {
  ensureResumeTemplateTables(db);
  const effective = resolveEffectiveResumeTemplate(db, jobKey).metadata;
  const material = latestResumeMaterial(db, jobKey);
  const lastRefreshAttempt = latestRefreshAttempt(db, jobKey);
  const snapshot = material ? snapshotFromMaterial(db, effective, material) : null;
  const stale = snapshot !== null && !sameTemplateSnapshot(snapshot, effective);
  const state = stateFromRefreshAttempt(lastRefreshAttempt, stale, material);
  return {
    effective,
    snapshot,
    state,
    reason: reasonForTemplateState(state, snapshot, effective, material),
    lastRefreshAttempt,
  };
}

export function resumeTemplateStateForArtifact(
  db: SqliteDatabase,
  jobKey: string,
  artifactMetadataJson: string | null,
): ResumeTemplateState | null {
  ensureResumeTemplateTables(db);
  const effective = resolveEffectiveResumeTemplate(db, jobKey).metadata;
  const snapshot = snapshotFromMetadata(parseJsonRecord(artifactMetadataJson)) ?? null;
  if (!snapshot) return resumeTemplateStateForJob(db, jobKey);
  const stale = !sameTemplateSnapshot(snapshot, effective);
  return {
    effective,
    snapshot,
    state: stale ? "template_stale" : "template_current",
    reason: stale ? "Artifact was rendered with a different resume template version." : null,
    lastRefreshAttempt: latestRefreshAttempt(db, jobKey),
  };
}

export function templateMetadataForMaterial(db: SqliteDatabase, jobKey: string): ResumeTemplateMetadata {
  return resolveEffectiveResumeTemplate(db, jobKey).metadata;
}

export function templateMetadataPayload(metadata: ResumeTemplateMetadata): Record<string, unknown> {
  return {
    templateId: metadata.templateId,
    templateVersionId: metadata.templateVersionId,
    templateVersionNumber: metadata.templateVersionNumber,
    templateName: metadata.templateName,
    templateHash: metadata.templateHash,
    assignmentSource: metadata.assignmentSource,
  };
}

export function ensureCurrentResumeTemplateMaterials(
  db: SqliteDatabase,
  jobKey: string,
  options: { force?: boolean } = {},
  renderPdf: ResumeHtmlPdfRenderer = defaultResumeHtmlPdfRenderer,
): EnsureCurrentResumeMaterialsResponse {
  ensureResumeTemplateTables(db);
  assertJobExists(db, jobKey);

  const initialState = resumeTemplateStateForJob(db, jobKey);
  if (!initialState) {
    return noRefreshResponse(jobKey, "not_required", null, null, "No resume template state is available.");
  }
  if (!options.force && initialState.state === "template_current") {
    return noRefreshResponse(jobKey, "not_required", initialState, null, "Resume materials already use the effective template.");
  }

  const material = latestResumeMaterial(db, jobKey);
  const reusableMaterial =
    material && material.text
      ? { generation: material.generation, text: material.text, pdf: material.pdf }
      : null;
  if (!reusableMaterial) {
    const attempt = recordRefreshAttempt(db, {
      jobKey,
      status: "unavailable",
      fromGeneration: material?.generation ?? null,
      toGeneration: null,
      effective: initialState.effective,
      errorMessage: "Latest accepted resume has no reusable text source for render-only refresh.",
    });
    recordTemplateEvent(db, {
      jobUrl: jobKey,
      eventType: "ResumeTemplateRefreshFailed",
      message: "Resume template refresh unavailable",
      payload: {
        jobId: jobKey,
        attemptId: attempt.attemptId,
        status: "unavailable",
        errorMessage: attempt.errorMessage ?? "",
        failedAt: attempt.completedAt ?? attempt.createdAt,
      },
    });
    return {
      ok: true,
      jobKey,
      status: "unavailable",
      templateState: resumeTemplateStateForJob(db, jobKey),
      attempt,
      generation: null,
      message: attempt.errorMessage,
    };
  }

  recordRefreshAttempt(db, {
    jobKey,
    status: "queued",
    fromGeneration: reusableMaterial.generation,
    toGeneration: null,
    effective: initialState.effective,
    errorMessage: null,
  });

  try {
    const refreshed = persistRenderOnlyRefresh(db, jobKey, reusableMaterial, initialState.effective, renderPdf);
    const attempt = recordRefreshAttempt(db, {
      jobKey,
      status: "completed",
      fromGeneration: reusableMaterial.generation,
      toGeneration: refreshed.generation,
      effective: initialState.effective,
      errorMessage: null,
    });
    recordTemplateEvent(db, {
      jobUrl: jobKey,
      eventType: "ResumeTemplateRefreshCompleted",
      message: "Resume template refresh completed",
      payload: {
        jobId: jobKey,
        attemptId: attempt.attemptId,
        generation: refreshed.generation,
        templateId: initialState.effective.templateId,
        templateVersionId: initialState.effective.templateVersionId,
        completedAt: attempt.completedAt ?? attempt.createdAt,
      },
    });
    return {
      ok: true,
      jobKey,
      status: "completed",
      templateState: resumeTemplateStateForJob(db, jobKey),
      attempt,
      generation: refreshed.generation,
      message: "Resume materials were refreshed with the effective template.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Template refresh failed.";
    const attempt = recordRefreshAttempt(db, {
      jobKey,
      status: "failed",
      fromGeneration: reusableMaterial.generation,
      toGeneration: null,
      effective: initialState.effective,
      errorMessage: message,
    });
    recordTemplateEvent(db, {
      jobUrl: jobKey,
      eventType: "ResumeTemplateRefreshFailed",
      message: "Resume template refresh failed",
      payload: {
        jobId: jobKey,
        attemptId: attempt.attemptId,
        status: "failed",
        errorMessage: message,
        failedAt: attempt.completedAt ?? attempt.createdAt,
      },
    });
    return {
      ok: true,
      jobKey,
      status: "failed",
      templateState: resumeTemplateStateForJob(db, jobKey),
      attempt,
      generation: null,
      message,
    };
  }
}

export function resolveCurrentResumeArtifactIdForOpen(
  db: SqliteDatabase,
  artifactId: string,
  renderPdf: ResumeHtmlPdfRenderer = defaultResumeHtmlPdfRenderer,
): string {
  ensureResumeTemplateTables(db);
  if (!tableExists(db, "job_materials_artifacts")) return artifactId;
  const columns = tableColumnSet(db, "job_materials_artifacts");
  if (
    (!columns.includes("job_url") && !columns.includes("job_id")) ||
    !columns.includes("artifact_type") ||
    !columns.includes("artifact_id") ||
    !columns.includes("generation")
  ) {
    return artifactId;
  }
  const row = getRow<{
    job_url: string;
    artifact_type: string;
    generation: number | string | null;
  }>(
    db,
    jobReferenceColumn(db, "job_materials_artifacts") === "job_id"
      ? `SELECT jobs.url AS job_url, artifacts.artifact_type, artifacts.generation
           FROM job_materials_artifacts AS artifacts
           JOIN jobs
             ON ${jobReferenceJoinToJobs(
               db,
               "job_materials_artifacts",
               "artifacts",
               "jobs",
             )}
          WHERE artifacts.artifact_id = ?`
      : `SELECT job_url, artifact_type, generation
           FROM job_materials_artifacts
          WHERE artifact_id = ?`,
    [artifactId],
  );
  if (!row || (row.artifact_type !== "tailored_resume" && row.artifact_type !== "resume_pdf")) {
    return artifactId;
  }

  const refresh = ensureCurrentResumeTemplateMaterials(db, row.job_url, {}, renderPdf);
  if (refresh.status !== "completed" && refresh.status !== "not_required") {
    return artifactId;
  }
  const statusWhere = columns.includes("status") ? "AND COALESCE(status, 'approved') IN ('approved', 'active')" : "";
  const orderBy = columns.includes("created_at")
    ? "generation DESC, datetime(created_at) DESC, artifact_id DESC"
    : "generation DESC, artifact_id DESC";
  const artifactReference = jobReferencePredicateForUrl(
    db,
    "job_materials_artifacts",
    row.job_url,
    DEFAULT_TENANT,
  );
  const latest = getRow<{ artifact_id: string }>(
    db,
    `SELECT artifact_id
       FROM job_materials_artifacts
      WHERE ${artifactReference.sql}
        AND artifact_type = ?
        ${statusWhere}
      ORDER BY ${orderBy}
      LIMIT 1`,
    [...artifactReference.params, row.artifact_type],
  );
  return latest?.artifact_id ?? artifactId;
}

function seedBuiltInResumeTemplate(db: SqliteDatabase): void {
  const now = new Date().toISOString();
  const theme = BUILT_IN_RESUME_TEMPLATE_THEME;
  const layout = EMPTY_LAYOUT;
  const hash = templateContentHash(theme, layout);
  insertDynamicRow(db, "resume_templates", {
    tenant_id: DEFAULT_TENANT,
    template_id: BUILT_IN_TEMPLATE_ID,
    display_name: "Modern HTML",
    status: "active",
    built_in: 1,
    created_at: now,
    updated_at: now,
  });
  insertDynamicRow(db, "resume_template_versions", {
    tenant_id: DEFAULT_TENANT,
    version_id: BUILT_IN_VERSION_ID,
    template_id: BUILT_IN_TEMPLATE_ID,
    version_number: 1,
    display_name: "Modern HTML",
    status: "active",
    theme_json: JSON.stringify(theme),
    layout_json: JSON.stringify(layout),
    content_hash: hash,
    created_at: now,
  });
}

function normalizeTemplateVersionRequest(
  request: ResumeTemplateVersionSaveRequest,
): ResumeTemplateVersionSaveRequest {
  return {
    templateId: request.templateId?.trim() || undefined,
    displayName: request.displayName.trim(),
    theme: ResumeTemplateThemeSchema.parse(request.theme),
    layout: ResumeTemplateLayoutSchema.parse(request.layout ?? {}),
  };
}

function assertTemplatePayloadSafe(db: SqliteDatabase, request: ResumeTemplateVersionSaveRequest): void {
  const payload = JSON.stringify(request).toLowerCase();
  const unsafePatterns = [
    /<\s*script\b/,
    /javascript:/,
    /\bdata:/,
    /\bfile:/,
    /\/users\//,
    /\/private\//,
    /\b[a-z]:\\/,
    /begin\s+(?:rsa\s+)?private key/,
  ];
  if (unsafePatterns.some((pattern) => pattern.test(payload))) {
    throw new ResumeTemplateInputError("Resume template contains unsupported markup, executable content, or local paths.");
  }
  for (const fact of sensitiveFactSentinels(db)) {
    if (payload.includes(fact.toLowerCase())) {
      throw new ResumeTemplateInputError("Resume template payload contains profile or job facts. Save style/layout data only.");
    }
  }
}

function sensitiveFactSentinels(db: SqliteDatabase): string[] {
  const facts = new Set<string>();
  if (tableExists(db, "candidate_profiles")) {
    const columns = tableColumnSet(db, "candidate_profiles");
    const selected = [
      "personal_full_name",
      "personal_email",
      "personal_phone",
      "personal_linkedin_url",
      "personal_github_url",
      "personal_portfolio_url",
      "personal_website_url",
    ].filter((column) => columns.includes(column));
    if (selected.length) {
      const row = getRow<Record<string, unknown>>(
        db,
        `SELECT ${selected.join(", ")} FROM candidate_profiles WHERE tenant_id = ? AND profile_id = ?`,
        [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
      );
      for (const value of Object.values(row ?? {})) addSensitiveFact(facts, value);
    }
  }
  if (tableExists(db, "jobs")) {
    const columns = tableColumnSet(db, "jobs");
    const selected = ["title", "company", "employer", "application_url"].filter((column) =>
      columns.includes(column),
    );
    if (selected.length) {
      const rows = allRows<Record<string, unknown>>(
        db,
        `SELECT ${selected.join(", ")} FROM jobs ORDER BY discovered_at DESC LIMIT 25`,
      );
      for (const row of rows) {
        for (const value of Object.values(row)) addSensitiveFact(facts, value);
      }
    }
  }
  return [...facts];
}

function addSensitiveFact(facts: Set<string>, value: unknown): void {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  if (text.length >= 8) facts.add(text);
}

function getTemplateRow(db: SqliteDatabase, templateId: string): TemplateRow | undefined {
  return getRow<TemplateRow>(
    db,
    "SELECT * FROM resume_templates WHERE tenant_id = ? AND template_id = ?",
    [DEFAULT_TENANT, templateId],
  );
}

function nextTemplateVersionNumber(db: SqliteDatabase, templateId: string): number {
  const row = getRow<{ max_version: number | null }>(
    db,
    "SELECT MAX(version_number) AS max_version FROM resume_template_versions WHERE tenant_id = ? AND template_id = ?",
    [DEFAULT_TENANT, templateId],
  );
  return Number(row?.max_version ?? 0) + 1;
}

function resolveTemplateByRequest(
  db: SqliteDatabase,
  templateId: string,
  versionId: string | undefined,
  assignmentSource: ResumeTemplateMetadata["assignmentSource"],
): EffectiveTemplate {
  const template = getTemplateRow(db, templateId);
  if (!template) throw new ResumeTemplateInputError(`Resume template not found: ${templateId}`);
  const version = versionId
    ? getRow<TemplateVersionRow>(
        db,
        "SELECT * FROM resume_template_versions WHERE tenant_id = ? AND template_id = ? AND version_id = ?",
        [DEFAULT_TENANT, templateId, versionId],
      )
    : latestVersionRow(db, templateId);
  if (!version) {
    throw new ResumeTemplateInputError(`Resume template version not found for template: ${templateId}`);
  }
  const summary = versionSummaryFromRows(template, version);
  return {
    version: summary,
    metadata: metadataFromVersion(summary, assignmentSource),
  };
}

function readDefaultTemplate(db: SqliteDatabase): EffectiveTemplate | null {
  const assignment = getRow<AssignmentRow>(
    db,
    "SELECT template_id, version_id, updated_at FROM resume_template_defaults WHERE tenant_id = ? AND profile_id = ?",
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  if (!assignment?.template_id || !assignment.version_id) return null;
  try {
    return resolveTemplateByRequest(db, assignment.template_id, assignment.version_id, "profile_default");
  } catch {
    return null;
  }
}

function resolveBuiltInTemplate(db: SqliteDatabase): EffectiveTemplate {
  return resolveTemplateByRequest(db, BUILT_IN_TEMPLATE_ID, BUILT_IN_VERSION_ID, "built_in");
}

function latestVersionRow(db: SqliteDatabase, templateId: string): TemplateVersionRow | undefined {
  return getRow<TemplateVersionRow>(
    db,
    `SELECT *
       FROM resume_template_versions
      WHERE tenant_id = ? AND template_id = ?
      ORDER BY version_number DESC, created_at DESC
      LIMIT 1`,
    [DEFAULT_TENANT, templateId],
  );
}

function templateSummaryFromRow(
  db: SqliteDatabase,
  row: TemplateRow | undefined,
): ResumeTemplateSummary | null {
  if (!row) return null;
  const version = latestVersionRow(db, row.template_id);
  if (!version) return null;
  return {
    templateId: row.template_id,
    displayName: row.display_name,
    status: row.status === "archived" ? "archived" : "active",
    builtIn: Boolean(row.built_in),
    activeVersion: versionSummaryFromRows(row, version),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function versionSummaryFromRows(
  template: TemplateRow,
  version: TemplateVersionRow,
): ResumeTemplateVersionSummary {
  return {
    templateId: template.template_id,
    versionId: version.version_id,
    versionNumber: Number(version.version_number),
    displayName: version.display_name || template.display_name,
    status: version.status === "archived" ? "archived" : "active",
    theme: ResumeTemplateThemeSchema.parse(parseJsonRecord(version.theme_json)),
    layout: ResumeTemplateLayoutSchema.parse(parseJsonRecord(version.layout_json)),
    contentHash: version.content_hash,
    createdAt: version.created_at,
  };
}

function metadataFromVersion(
  version: ResumeTemplateVersionSummary,
  assignmentSource: ResumeTemplateMetadata["assignmentSource"],
): ResumeTemplateMetadata {
  return {
    templateId: version.templateId,
    templateVersionId: version.versionId,
    templateVersionNumber: version.versionNumber,
    templateName: version.displayName,
    templateHash: version.contentHash,
    assignmentSource,
  };
}

function latestResumeMaterial(
  db: SqliteDatabase,
  jobKey: string,
): { generation: number; text: MaterialArtifactRow | null; pdf: MaterialArtifactRow | null } | null {
  if (!tableExists(db, "job_materials_artifacts")) return null;
  const columns = tableColumnSet(db, "job_materials_artifacts");
  if (!columns.includes("artifact_type") || !columns.includes("generation")) return null;
  const selectColumns = [
    columns.includes("artifact_id") ? "artifact_id" : "NULL AS artifact_id",
    "artifact_type",
    "generation",
    columns.includes("path") ? "path" : "NULL AS path",
    columns.includes("render_format") ? "render_format" : "NULL AS render_format",
    columns.includes("metadata_json") ? "metadata_json" : "NULL AS metadata_json",
    columns.includes("created_at") ? "created_at" : "NULL AS created_at",
  ].join(", ");
  if (!columns.includes("job_url") && !columns.includes("job_id")) return null;
  const artifactReference = jobReferencePredicateForUrl(
    db,
    "job_materials_artifacts",
    jobKey,
    DEFAULT_TENANT,
  );
  const statusWhere = columns.includes("status") ? "AND COALESCE(status, 'approved') IN ('approved', 'active')" : "";
  const rows = allRows<MaterialArtifactRow>(
    db,
    `SELECT ${selectColumns}
       FROM job_materials_artifacts
      WHERE ${artifactReference.sql}
        AND artifact_type IN ('tailored_resume', 'resume_pdf')
        ${statusWhere}
      ORDER BY generation DESC, CASE artifact_type WHEN 'resume_pdf' THEN 0 ELSE 1 END`,
    artifactReference.params,
  );
  const generation = rows[0]?.generation === undefined ? null : Number(rows[0].generation);
  if (!generation) return null;
  return {
    generation,
    text: rows.find((row) => Number(row.generation) === generation && row.artifact_type === "tailored_resume") ?? null,
    pdf: rows.find((row) => Number(row.generation) === generation && row.artifact_type === "resume_pdf") ?? null,
  };
}

function snapshotFromMaterial(
  db: SqliteDatabase,
  effective: ResumeTemplateMetadata,
  material: { text: MaterialArtifactRow | null; pdf: MaterialArtifactRow | null },
): ResumeTemplateMetadata | null {
  const pdfSnapshot = snapshotFromMetadata(parseJsonRecord(material.pdf?.metadata_json ?? null));
  if (pdfSnapshot) return pdfSnapshot;
  const textSnapshot = snapshotFromMetadata(parseJsonRecord(material.text?.metadata_json ?? null));
  if (textSnapshot) return textSnapshot;
  if (effective.assignmentSource === "built_in") return effective;
  return metadataFromVersion(resolveBuiltInTemplate(db).version, "built_in");
}

function snapshotFromMetadata(metadata: Record<string, unknown>): ResumeTemplateMetadata | null {
  const raw = metadata[TEMPLATE_METADATA_KEY];
  if (!isRecord(raw)) return null;
  const templateId = stringValue(raw.templateId);
  const templateVersionId = stringValue(raw.templateVersionId);
  const templateName = stringValue(raw.templateName);
  const templateHash = stringValue(raw.templateHash);
  const versionNumber = numberValue(raw.templateVersionNumber);
  const source = stringValue(raw.assignmentSource);
  if (!templateId || !templateVersionId || !templateName || !templateHash || versionNumber === null) return null;
  return {
    templateId,
    templateVersionId,
    templateVersionNumber: versionNumber,
    templateName,
    templateHash,
    assignmentSource:
      source === "job_override" || source === "profile_default" || source === "built_in"
        ? source
        : "built_in",
  };
}

function sameTemplateSnapshot(
  left: ResumeTemplateMetadata,
  right: ResumeTemplateMetadata,
): boolean {
  return left.templateVersionId === right.templateVersionId && left.templateHash === right.templateHash;
}

function stateFromRefreshAttempt(
  attempt: ResumeTemplateRefreshAttempt | null,
  stale: boolean,
  material: unknown,
): ResumeTemplateStaleState {
  if (attempt?.status === "queued") return "refresh_queued";
  if (attempt?.status === "failed") return "refresh_failed";
  if (attempt?.status === "unavailable") return "refresh_unavailable";
  if (!material) return "template_current";
  return stale ? "template_stale" : "template_current";
}

function reasonForTemplateState(
  state: ResumeTemplateStaleState,
  snapshot: ResumeTemplateMetadata | null,
  effective: ResumeTemplateMetadata,
  material: unknown,
): string | null {
  if (!material) return null;
  if (state === "template_current") return null;
  if (state === "refresh_failed") return "The last render-only template refresh failed; the prior accepted artifact remains visible.";
  if (state === "refresh_unavailable") return "The latest accepted material cannot be refreshed without re-tailoring or migration.";
  if (state === "refresh_queued") return "A render-only template refresh is pending.";
  if (!snapshot) return "The latest accepted material has no template snapshot.";
  return `Rendered with ${snapshot.templateName}; current effective template is ${effective.templateName}.`;
}

function latestRefreshAttempt(db: SqliteDatabase, jobKey: string): ResumeTemplateRefreshAttempt | null {
  if (!tableExists(db, "resume_template_refresh_attempts")) return null;
  const row = getRow<RefreshAttemptRow>(
    db,
    `SELECT *
       FROM resume_template_refresh_attempts
      WHERE tenant_id = ? AND job_url = ?
      ORDER BY created_at DESC, attempt_id DESC
      LIMIT 1`,
    [DEFAULT_TENANT, jobKey],
  );
  return row ? refreshAttemptFromRow(row) : null;
}

function recordRefreshAttempt(
  db: SqliteDatabase,
  input: {
    jobKey: string;
    status: ResumeTemplateRefreshStatus;
    fromGeneration: number | null;
    toGeneration: number | null;
    effective: ResumeTemplateMetadata;
    errorMessage: string | null;
  },
): ResumeTemplateRefreshAttempt {
  const now = new Date().toISOString();
  const attemptId = `template_refresh_${crypto.randomUUID()}`;
  insertDynamicRow(db, "resume_template_refresh_attempts", {
    tenant_id: DEFAULT_TENANT,
    attempt_id: attemptId,
    job_url: input.jobKey,
    status: input.status,
    from_generation: input.fromGeneration,
    to_generation: input.toGeneration,
    template_id: input.effective.templateId,
    template_version_id: input.effective.templateVersionId,
    template_hash: input.effective.templateHash,
    error_message: input.errorMessage,
    metadata_json: JSON.stringify({ source: TEMPLATE_REFRESH_SOURCE }),
    created_at: now,
    completed_at: input.status === "queued" ? null : now,
  });
  const row = getRow<RefreshAttemptRow>(
    db,
    "SELECT * FROM resume_template_refresh_attempts WHERE tenant_id = ? AND attempt_id = ?",
    [DEFAULT_TENANT, attemptId],
  );
  if (!row) throw new Error("Template refresh attempt was not persisted.");
  return refreshAttemptFromRow(row);
}

function refreshAttemptFromRow(row: RefreshAttemptRow): ResumeTemplateRefreshAttempt {
  const status = stringValue(row.status);
  return {
    attemptId: row.attempt_id,
    jobKey: row.job_url,
    status:
      status === "queued" ||
      status === "completed" ||
      status === "failed" ||
      status === "unavailable"
        ? status
        : "not_required",
    fromGeneration: nullableNumber(row.from_generation),
    toGeneration: nullableNumber(row.to_generation),
    templateId: row.template_id,
    templateVersionId: row.template_version_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function persistRenderOnlyRefresh(
  db: SqliteDatabase,
  jobKey: string,
  material: { generation: number; text: MaterialArtifactRow; pdf: MaterialArtifactRow | null },
  effective: ResumeTemplateMetadata,
  renderPdf: ResumeHtmlPdfRenderer,
): { generation: number } {
  if (!material.text.path || !fs.existsSync(material.text.path) || !fs.statSync(material.text.path).isFile()) {
    throw new ResumeTemplateInputError("Latest accepted resume text artifact is not readable.");
  }
  const text = readTextFileLimited(material.text.path);
  if (!text.trim()) {
    throw new ResumeTemplateInputError("Latest accepted resume text artifact is empty.");
  }

  const outputDir = path.dirname(material.pdf?.path || material.text.path);
  fs.mkdirSync(outputDir, { recursive: true });
  const generation = nextMaterialGeneration(db, jobKey);
  const suffix = stableHash([jobKey, generation, effective.templateVersionId, effective.templateHash]).slice(0, 16);
  const textArtifactId = `template_refresh_text_${suffix}`;
  const pdfArtifactId = `template_refresh_pdf_${suffix}`;
  const baseName = `resume-template-refresh-${suffix}`;
  const textPath = path.join(outputDir, `${baseName}.txt`);
  const htmlPath = path.join(outputDir, `${baseName}.html`);
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);
  const layoutBoxes = layoutBoxesForText(text);
  const now = new Date().toISOString();
  const templateMetadata = templateMetadataPayload(effective);

  fs.writeFileSync(textPath, text, "utf8");
  fs.writeFileSync(htmlPath, htmlForTemplateRefresh(text, effective), "utf8");
  renderPdf({ htmlPath, pdfPath });

  insertDynamicRow(db, "job_materials", {
    ...materialIdentityValues(db, "job_materials", jobKey),
    generation,
    status: "resume_approved",
    created_at: now,
    updated_at: now,
    last_validation_json: JSON.stringify({ passed: true, errors: [], warnings: [] }),
    last_verdict_json: JSON.stringify({ approved: true, source: TEMPLATE_REFRESH_SOURCE }),
    metadata_json: JSON.stringify({
      source: TEMPLATE_REFRESH_SOURCE,
      base_generation: material.generation,
      [TEMPLATE_METADATA_KEY]: templateMetadata,
    }),
  });
  insertDynamicRow(db, "job_materials_artifacts", {
    ...materialIdentityValues(db, "job_materials_artifacts", jobKey),
    generation,
    artifact_type: "tailored_resume",
    artifact_id: textArtifactId,
    status: "approved",
    path: textPath,
    render_format: "text",
    size_bytes: fs.statSync(textPath).size,
    metadata_json: JSON.stringify({
      source: TEMPLATE_REFRESH_SOURCE,
      base_resume_text_artifact_id: material.text.artifact_id,
      [TEMPLATE_METADATA_KEY]: templateMetadata,
    }),
    created_at: now,
    superseded_at: null,
  });
  insertDynamicRow(db, "job_materials_artifacts", {
    ...materialIdentityValues(db, "job_materials_artifacts", jobKey),
    generation,
    artifact_type: "resume_pdf",
    artifact_id: pdfArtifactId,
    status: "approved",
    path: pdfPath,
    render_format: "html_pdf",
    size_bytes: fs.statSync(pdfPath).size,
    metadata_json: JSON.stringify({
      source: TEMPLATE_REFRESH_SOURCE,
      html_path: htmlPath,
      base_resume_pdf_artifact_id: material.pdf?.artifact_id ?? null,
      layout_box_count: layoutBoxes.length,
      [TEMPLATE_METADATA_KEY]: templateMetadata,
    }),
    created_at: now,
    superseded_at: null,
  });
  replaceLayoutBoxes(db, jobKey, generation, pdfArtifactId, layoutBoxes, now);
  return { generation };
}

function nextMaterialGeneration(db: SqliteDatabase, jobKey: string): number {
  const values: number[] = [];
  for (const table of ["job_materials", "job_materials_artifacts"]) {
    if (!tableExists(db, table)) continue;
    const materialReference = jobReferencePredicateForUrl(
      db,
      table,
      jobKey,
      DEFAULT_TENANT,
    );
    const row = getRow<{ max_generation: number | null }>(
      db,
      `SELECT MAX(generation) AS max_generation
         FROM ${table}
        WHERE ${materialReference.sql}`,
      materialReference.params,
    );
    if (row?.max_generation !== null && row?.max_generation !== undefined) values.push(Number(row.max_generation));
  }
  return Math.max(0, ...values.filter(Number.isFinite)) + 1;
}

function replaceLayoutBoxes(
  db: SqliteDatabase,
  jobKey: string,
  generation: number,
  artifactId: string,
  boxes: readonly ResumeLayoutBox[],
  createdAt: string,
): void {
  if (!tableExists(db, "job_material_layout_boxes")) return;
  const layoutReference = jobReferencePredicateForUrl(
    db,
    "job_material_layout_boxes",
    jobKey,
    DEFAULT_TENANT,
  );
  db.prepare(
    `DELETE FROM job_material_layout_boxes
      WHERE ${layoutReference.sql} AND generation = ? AND artifact_id = ?`,
  ).run(...layoutReference.params, generation, artifactId);
  for (const [index, box] of boxes.entries()) {
    insertDynamicRow(db, "job_material_layout_boxes", {
      ...materialIdentityValues(db, "job_material_layout_boxes", jobKey),
      generation,
      artifact_id: artifactId,
      box_index: index,
      semantic_id: box.semanticId,
      page_number: box.pageNumber,
      line_number: box.lineNumber,
      text_excerpt: box.textExcerpt,
      left_pct: box.leftPct,
      top_pct: box.topPct,
      width_pct: box.widthPct,
      height_pct: box.heightPct,
      audit_target_json: JSON.stringify({
        source: TEMPLATE_REFRESH_SOURCE,
        semanticId: box.semanticId,
        lineNumber: box.lineNumber,
      }),
      created_at: createdAt,
    });
  }
}

function layoutBoxesForText(text: string): ResumeLayoutBox[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 80)
    .map((line, index) => ({
      semanticId: `template-refresh:line:${index + 1}`,
      pageNumber: Math.floor(index / 42) + 1,
      lineNumber: index + 1,
      textExcerpt: boundedText(line, 240),
      leftPct: 10,
      topPct: 8 + (index % 42) * 2.1,
      widthPct: 80,
      heightPct: 1.7,
    }));
}

function readTextFileLimited(filePath: string): string {
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(TEXT_BYTE_LIMIT);
    const bytesRead = fs.readSync(fd, buffer, 0, TEXT_BYTE_LIMIT, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function htmlForTemplateRefresh(text: string, effective: ResumeTemplateMetadata): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const tag = index === 0 ? "h1" : /^[-*]\s+|^•\s+/.test(line) ? "li" : sectionHeadingLine(line) ? "h2" : "p";
      const clean = escapeHtml(line.replace(/^[-*]\s+|^•\s+/, ""));
      return `<${tag} data-resume-line-number="${index + 1}" data-resume-layout-target="template-refresh:line:${index + 1}">${clean}</${tag}>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(effective.templateName)}</title>
    <style>
      body { margin: 0; font: 12px Arial, sans-serif; color: #111111; background: white; }
      .resume-document { box-sizing: border-box; width: 8.5in; min-height: 11in; padding: 0.65in; }
      h1 { font-size: 22px; margin: 0 0 10px; text-align: center; font-weight: 400; }
      h2 { font-size: 13px; margin: 14px 0 6px; text-transform: uppercase; letter-spacing: 0; border-bottom: 1px solid #111111; }
      p, li { font-size: 11px; line-height: 1.35; margin: 0 0 5px; }
      li { margin-left: 18px; }
    </style>
  </head>
  <body><main class="resume-document" data-resume-page="1">${lines}</main></body>
</html>
`;
}

function noRefreshResponse(
  jobKey: string,
  status: ResumeTemplateRefreshStatus,
  templateState: ResumeTemplateState | null,
  attempt: ResumeTemplateRefreshAttempt | null,
  message: string,
): EnsureCurrentResumeMaterialsResponse {
  return {
    ok: true,
    jobKey,
    status,
    templateState,
    attempt,
    generation: null,
    message,
  };
}

function assertJobExists(db: SqliteDatabase, jobKey: string): void {
  if (!tableExists(db, "jobs")) return;
  const row = getRow<{ url: string }>(
    db,
    "SELECT url FROM jobs WHERE url = ? OR application_url = ? LIMIT 1",
    [jobKey, jobKey],
  );
  if (!row) throw new ResumeTemplateInputError(`Job not found: ${jobKey}`);
}

function recordTemplateEvent(
  db: SqliteDatabase,
  event: {
    jobUrl: string | null;
    eventType: string;
    message: string;
    payload: Record<string, unknown>;
  },
): void {
  if (!tableExists(db, "job_events")) return;
  const columns = tableColumnSet(db, "job_events");
  const values = {
    job_url: event.jobUrl,
    stage: "tailor",
    event_type: event.eventType,
    level: event.eventType.endsWith("Failed") ? "warn" : "info",
    message: event.message,
    occurred_at: new Date().toISOString(),
    payload_json: JSON.stringify({
      tenantId: DEFAULT_TENANT,
      ...(event.jobUrl ? { jobId: event.jobUrl } : {}),
      ...event.payload,
    }),
  };
  const entries = Object.entries(values).filter(([name]) => columns.includes(name));
  if (!entries.length) return;
  db.prepare(
    `INSERT INTO job_events (${entries.map(([name]) => name).join(", ")}) VALUES (${entries.map(() => "?").join(", ")})`,
  ).run(...entries.map(([, value]) => value));
}

function insertDynamicRow(
  db: SqliteDatabase,
  tableName: string,
  values: Record<string, SqliteValue>,
): void {
  const columns = tableColumnSet(db, tableName).filter((column) => Object.hasOwn(values, column));
  if (!columns.length) return;
  const placeholders = columns.map(() => "?").join(", ");
  db.prepare(
    `INSERT OR REPLACE INTO ${tableName} (${columns.join(", ")}) VALUES (${placeholders})`,
  ).run(...columns.map((column) => values[column] ?? null));
}

function materialIdentityValues(
  db: SqliteDatabase,
  tableName: string,
  jobKey: string,
): Record<string, SqliteValue> {
  const referenceColumn = jobReferenceColumn(db, tableName);
  return {
    tenant_id: DEFAULT_TENANT,
    [referenceColumn]: jobReferenceForUrl(
      db,
      tableName,
      jobKey,
      DEFAULT_TENANT,
    ),
  };
}

function tableColumnSet(db: SqliteDatabase, tableName: string): string[] {
  return allRows<{ name: string }>(db, `PRAGMA table_info(${tableName})`).map((row) => row.name);
}

function templateContentHash(theme: ResumeTemplateTheme, layout: ResumeTemplateLayout): string {
  return stableHash([theme, layout]);
}

function stableHash(parts: readonly unknown[]): string {
  return crypto.createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

function parseJsonRecord(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  return numberValue(value);
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value !== null && value !== undefined;
}

function boundedText(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit - 3).trimEnd()}...` : value;
}

function sectionHeadingLine(line: string): boolean {
  return /^(?:summary|profile|experience|education|skills|projects|certifications|languages)$/i.test(line.trim());
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
