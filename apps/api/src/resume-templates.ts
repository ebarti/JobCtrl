import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { JobId } from "@jobctrl/domain-types";

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
import { allRows, getRow, type SqliteDatabase } from "./db.js";
import { defaultResumeHtmlPdfRenderer, type ResumeHtmlPdfRenderer } from "./resume-pdf-render.js";

const DEFAULT_TENANT = "local";
const DEFAULT_PROFILE_ID = "default";
const BUILT_IN_TEMPLATE_ID = "built_in:modern-html";
const BUILT_IN_VERSION_ID = "built_in:modern-html:v1";
const TEMPLATE_METADATA_KEY = "resume_template";
const TEMPLATE_REFRESH_SOURCE = "resume_template_lazy_refresh";
const TEXT_BYTE_LIMIT = 128_000;
const CANONICAL_JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

export function listResumeTemplates(db: SqliteDatabase): ResumeTemplateListResponse {
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
  const template = templateSummaryFromRow(db, getTemplateRow(db, templateId));
  return template ? { ok: true, template } : null;
}

export function createResumeTemplateVersion(
  db: SqliteDatabase,
  request: ResumeTemplateVersionSaveRequest,
): ResumeTemplateVersionSaveResponse {
  const normalized = normalizeTemplateVersionRequest(request);
  assertTemplatePayloadSafe(db, normalized);

  const now = new Date().toISOString();
  const templateId = normalized.templateId ?? `resume_template_${crypto.randomUUID()}`;
  const existing = getTemplateRow(db, templateId);
  const versionNumber = nextTemplateVersionNumber(db, templateId);
  const versionId = `${templateId}:v${versionNumber}:${crypto.randomUUID().slice(0, 8)}`;
  const contentHash = templateContentHash(normalized.theme, normalized.layout);

  db.prepare(
    `INSERT INTO resume_templates (
       tenant_id, template_id, display_name, status, built_in, created_at, updated_at
     ) VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT(tenant_id, template_id) DO UPDATE SET
       display_name = excluded.display_name,
       status = excluded.status,
       built_in = excluded.built_in,
       updated_at = excluded.updated_at`,
  ).run(
    DEFAULT_TENANT,
    templateId,
    normalized.displayName,
    existing?.built_in ?? 0,
    existing?.created_at ?? now,
    now,
  );
  db.prepare(
    `INSERT INTO resume_template_versions (
       tenant_id, version_id, template_id, version_number, display_name, status,
       theme_json, layout_json, content_hash, created_at
     ) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    versionId,
    templateId,
    versionNumber,
    normalized.displayName,
    JSON.stringify(normalized.theme),
    JSON.stringify(normalized.layout),
    contentHash,
    now,
  );
  recordTemplateEvent(db, {
    jobId: null,
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
  const effective = resolveTemplateByRequest(db, request.templateId, request.versionId, "profile_default");
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO resume_template_defaults (
       tenant_id, profile_id, template_id, version_id, updated_at
     ) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tenant_id, profile_id) DO UPDATE SET
       template_id = excluded.template_id,
       version_id = excluded.version_id,
       updated_at = excluded.updated_at`,
  ).run(
    DEFAULT_TENANT,
    DEFAULT_PROFILE_ID,
    effective.metadata.templateId,
    effective.metadata.templateVersionId,
    now,
  );
  recordTemplateEvent(db, {
    jobId: null,
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
  jobId: string,
  request: JobResumeTemplateAssignmentRequest,
): JobResumeTemplateAssignmentResponse {
  const stableJobId = requireJobId(jobId);
  assertJobExists(db, stableJobId);
  const now = new Date().toISOString();
  let overrideTemplate: ResumeTemplateMetadata | null = null;

  if (request.templateId === null) {
    db.prepare(
      "DELETE FROM job_resume_template_assignments WHERE tenant_id = ? AND job_id = ?",
    ).run(DEFAULT_TENANT, stableJobId);
  } else if (request.templateId) {
    const effective = resolveTemplateByRequest(db, request.templateId, request.versionId ?? undefined, "job_override");
    db.prepare(
      `INSERT INTO job_resume_template_assignments (
         tenant_id, job_id, template_id, version_id, updated_at
       ) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(tenant_id, job_id) DO UPDATE SET
         template_id = excluded.template_id,
         version_id = excluded.version_id,
         updated_at = excluded.updated_at`,
    ).run(
      DEFAULT_TENANT,
      stableJobId,
      effective.metadata.templateId,
      effective.metadata.templateVersionId,
      now,
    );
    overrideTemplate = effective.metadata;
  }

  const effectiveTemplate = resolveEffectiveResumeTemplateForJob(db, stableJobId);
  recordTemplateEvent(db, {
    jobId: stableJobId,
    eventType: "JobResumeTemplateAssigned",
    message: overrideTemplate
      ? `Job resume template set to ${overrideTemplate.templateName}`
      : "Job resume template override cleared",
    payload: {
      jobId: stableJobId,
      templateId: overrideTemplate?.templateId ?? null,
      templateVersionId: overrideTemplate?.templateVersionId ?? null,
      assignedAt: now,
    },
  });
  return {
    ok: true,
    jobKey: stableJobId,
    effectiveTemplate: effectiveTemplate.metadata,
    overrideTemplate,
    templateState: resumeTemplateStateForJobId(db, stableJobId),
  };
}

export function resolveEffectiveResumeTemplate(db: SqliteDatabase, jobId?: string | null): EffectiveTemplate {
  return resolveEffectiveResumeTemplateForJob(db, jobId ? requireJobId(jobId) : null);
}

function resolveEffectiveResumeTemplateForJob(db: SqliteDatabase, jobId?: JobId | null): EffectiveTemplate {
  if (jobId) {
    const assignment = getRow<AssignmentRow>(
      db,
      `SELECT template_id, version_id, updated_at
         FROM job_resume_template_assignments
        WHERE tenant_id = ? AND job_id = ?`,
      [DEFAULT_TENANT, jobId],
    );
    if (assignment?.template_id && assignment.version_id) {
      return resolveTemplateByRequest(db, assignment.template_id, assignment.version_id, "job_override");
    }
  }
  const defaultTemplate = readDefaultTemplate(db);
  if (defaultTemplate) return defaultTemplate;
  return resolveBuiltInTemplate(db);
}

export function resumeTemplateStateForJob(db: SqliteDatabase, jobId: string): ResumeTemplateState | null {
  return resumeTemplateStateForJobId(db, requireJobId(jobId));
}

function resumeTemplateStateForJobId(db: SqliteDatabase, jobId: JobId): ResumeTemplateState | null {
  const effective = resolveEffectiveResumeTemplateForJob(db, jobId).metadata;
  const material = latestResumeMaterial(db, jobId);
  const lastRefreshAttempt = latestRefreshAttempt(db, jobId);
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
  jobId: string,
  artifactMetadataJson: string | null,
): ResumeTemplateState | null {
  const stableJobId = requireJobId(jobId);
  const effective = resolveEffectiveResumeTemplateForJob(db, stableJobId).metadata;
  const snapshot = snapshotFromMetadata(parseJsonRecord(artifactMetadataJson)) ?? null;
  if (!snapshot) return resumeTemplateStateForJobId(db, stableJobId);
  const stale = !sameTemplateSnapshot(snapshot, effective);
  return {
    effective,
    snapshot,
    state: stale ? "template_stale" : "template_current",
    reason: stale ? "Artifact was rendered with a different resume template version." : null,
    lastRefreshAttempt: latestRefreshAttempt(db, stableJobId),
  };
}

export function templateMetadataForMaterial(db: SqliteDatabase, jobId: string): ResumeTemplateMetadata {
  return resolveEffectiveResumeTemplateForJob(db, requireJobId(jobId)).metadata;
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

export async function ensureCurrentResumeTemplateMaterials(
  db: SqliteDatabase,
  jobId: string,
  options: { force?: boolean } = {},
  renderPdf: ResumeHtmlPdfRenderer = defaultResumeHtmlPdfRenderer,
): Promise<EnsureCurrentResumeMaterialsResponse> {
  const stableJobId = requireJobId(jobId);
  assertJobExists(db, stableJobId);

  const initialState = resumeTemplateStateForJobId(db, stableJobId);
  if (!initialState) {
    return noRefreshResponse(stableJobId, "not_required", null, null, "No resume template state is available.");
  }
  if (!options.force && initialState.state === "template_current") {
    return noRefreshResponse(stableJobId, "not_required", initialState, null, "Resume materials already use the effective template.");
  }

  const material = latestResumeMaterial(db, stableJobId);
  const reusableMaterial =
    material && material.text
      ? { generation: material.generation, text: material.text, pdf: material.pdf }
      : null;
  if (!reusableMaterial) {
    const attempt = recordRefreshAttempt(db, {
      jobId: stableJobId,
      status: "unavailable",
      fromGeneration: material?.generation ?? null,
      toGeneration: null,
      effective: initialState.effective,
      errorMessage: "Latest accepted resume has no reusable text source for render-only refresh.",
    });
    recordTemplateEvent(db, {
      jobId: stableJobId,
      eventType: "ResumeTemplateRefreshFailed",
      message: "Resume template refresh unavailable",
      payload: {
        jobId: stableJobId,
        attemptId: attempt.attemptId,
        status: "unavailable",
        errorMessage: attempt.errorMessage ?? "",
        failedAt: attempt.completedAt ?? attempt.createdAt,
      },
    });
    return {
      ok: true,
      jobKey: stableJobId,
      status: "unavailable",
      templateState: resumeTemplateStateForJobId(db, stableJobId),
      attempt,
      generation: null,
      message: attempt.errorMessage,
    };
  }

  recordRefreshAttempt(db, {
    jobId: stableJobId,
    status: "queued",
    fromGeneration: reusableMaterial.generation,
    toGeneration: null,
    effective: initialState.effective,
    errorMessage: null,
  });

  try {
    const refreshed = await persistRenderOnlyRefresh(db, stableJobId, reusableMaterial, initialState.effective, renderPdf);
    const attempt = recordRefreshAttempt(db, {
      jobId: stableJobId,
      status: "completed",
      fromGeneration: reusableMaterial.generation,
      toGeneration: refreshed.generation,
      effective: initialState.effective,
      errorMessage: null,
    });
    recordTemplateEvent(db, {
      jobId: stableJobId,
      eventType: "ResumeTemplateRefreshCompleted",
      message: "Resume template refresh completed",
      payload: {
        jobId: stableJobId,
        attemptId: attempt.attemptId,
        generation: refreshed.generation,
        templateId: initialState.effective.templateId,
        templateVersionId: initialState.effective.templateVersionId,
        completedAt: attempt.completedAt ?? attempt.createdAt,
      },
    });
    return {
      ok: true,
      jobKey: stableJobId,
      status: "completed",
      templateState: resumeTemplateStateForJobId(db, stableJobId),
      attempt,
      generation: refreshed.generation,
      message: "Resume materials were refreshed with the effective template.",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Template refresh failed.";
    const attempt = recordRefreshAttempt(db, {
      jobId: stableJobId,
      status: "failed",
      fromGeneration: reusableMaterial.generation,
      toGeneration: null,
      effective: initialState.effective,
      errorMessage: message,
    });
    recordTemplateEvent(db, {
      jobId: stableJobId,
      eventType: "ResumeTemplateRefreshFailed",
      message: "Resume template refresh failed",
      payload: {
        jobId: stableJobId,
        attemptId: attempt.attemptId,
        status: "failed",
        errorMessage: message,
        failedAt: attempt.completedAt ?? attempt.createdAt,
      },
    });
    return {
      ok: true,
      jobKey: stableJobId,
      status: "failed",
      templateState: resumeTemplateStateForJobId(db, stableJobId),
      attempt,
      generation: null,
      message,
    };
  }
}

export async function resolveCurrentResumeArtifactIdForOpen(
  db: SqliteDatabase,
  artifactId: string,
  renderPdf: ResumeHtmlPdfRenderer = defaultResumeHtmlPdfRenderer,
): Promise<string> {
  const row = getRow<{
    job_id: string;
    artifact_type: string;
    generation: number | string | null;
  }>(
    db,
    `SELECT job_id, artifact_type, generation
       FROM job_materials_artifacts
      WHERE tenant_id = ? AND artifact_id = ?`,
    [DEFAULT_TENANT, artifactId],
  );
  if (!row || (row.artifact_type !== "tailored_resume" && row.artifact_type !== "resume_pdf")) {
    return artifactId;
  }

  const jobId = requireJobId(row.job_id);
  const refresh = await ensureCurrentResumeTemplateMaterials(db, jobId, {}, renderPdf);
  if (refresh.status !== "completed" && refresh.status !== "not_required") {
    return artifactId;
  }
  const latest = getRow<{ artifact_id: string }>(
    db,
    `SELECT artifact_id
       FROM job_materials_artifacts
      WHERE tenant_id = ? AND job_id = ?
        AND artifact_type = ?
        AND status IN ('approved', 'active')
      ORDER BY generation DESC, datetime(created_at) DESC, artifact_id DESC
      LIMIT 1`,
    [DEFAULT_TENANT, jobId, row.artifact_type],
  );
  return latest?.artifact_id ?? artifactId;
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
  const profile = getRow<Record<string, unknown>>(
    db,
    `SELECT personal_full_name, personal_email, personal_phone,
            personal_linkedin_url, personal_github_url,
            personal_portfolio_url, personal_website_url
       FROM candidate_profiles
      WHERE tenant_id = ? AND profile_id = ?`,
    [DEFAULT_TENANT, DEFAULT_PROFILE_ID],
  );
  for (const value of Object.values(profile ?? {})) addSensitiveFact(facts, value);
  const jobs = allRows<Record<string, unknown>>(
    db,
    `SELECT title, company, application_url
       FROM jobs
      WHERE tenant_id = ?
      ORDER BY discovered_at DESC
      LIMIT 25`,
    [DEFAULT_TENANT],
  );
  for (const job of jobs) {
    for (const value of Object.values(job)) addSensitiveFact(facts, value);
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
  jobId: JobId,
): { generation: number; text: MaterialArtifactRow | null; pdf: MaterialArtifactRow | null } | null {
  const rows = allRows<MaterialArtifactRow>(
    db,
    `SELECT artifact_id, artifact_type, generation, path, render_format,
            metadata_json, created_at
       FROM job_materials_artifacts
      WHERE tenant_id = ? AND job_id = ?
        AND artifact_type IN ('tailored_resume', 'resume_pdf')
        AND status IN ('approved', 'active')
      ORDER BY generation DESC, CASE artifact_type WHEN 'resume_pdf' THEN 0 ELSE 1 END`,
    [DEFAULT_TENANT, jobId],
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

function latestRefreshAttempt(db: SqliteDatabase, jobId: JobId): ResumeTemplateRefreshAttempt | null {
  const row = getRow<RefreshAttemptRow>(
    db,
    `SELECT *
       FROM resume_template_refresh_attempts
      WHERE tenant_id = ? AND job_id = ?
      ORDER BY created_at DESC,
               CASE WHEN completed_at IS NULL THEN 1 ELSE 0 END,
               attempt_id DESC
      LIMIT 1`,
    [DEFAULT_TENANT, jobId],
  );
  return row ? refreshAttemptFromRow(row, jobId) : null;
}

function recordRefreshAttempt(
  db: SqliteDatabase,
  input: {
    jobId: JobId;
    status: ResumeTemplateRefreshStatus;
    fromGeneration: number | null;
    toGeneration: number | null;
    effective: ResumeTemplateMetadata;
    errorMessage: string | null;
  },
): ResumeTemplateRefreshAttempt {
  const now = new Date().toISOString();
  const attemptId = `template_refresh_${crypto.randomUUID()}`;
  db.prepare(
    `INSERT INTO resume_template_refresh_attempts (
       tenant_id, attempt_id, job_id, status, from_generation, to_generation,
       template_id, template_version_id, template_hash, error_message,
       metadata_json, created_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    attemptId,
    input.jobId,
    input.status,
    input.fromGeneration,
    input.toGeneration,
    input.effective.templateId,
    input.effective.templateVersionId,
    input.effective.templateHash,
    input.errorMessage,
    JSON.stringify({ source: TEMPLATE_REFRESH_SOURCE }),
    now,
    input.status === "queued" ? null : now,
  );
  const row = getRow<RefreshAttemptRow>(
    db,
    "SELECT * FROM resume_template_refresh_attempts WHERE tenant_id = ? AND attempt_id = ?",
    [DEFAULT_TENANT, attemptId],
  );
  if (!row) throw new Error("Template refresh attempt was not persisted.");
  return refreshAttemptFromRow(row, input.jobId);
}

function refreshAttemptFromRow(row: RefreshAttemptRow, jobId: JobId): ResumeTemplateRefreshAttempt {
  const status = stringValue(row.status);
  return {
    attemptId: row.attempt_id,
    jobKey: jobId,
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

async function persistRenderOnlyRefresh(
  db: SqliteDatabase,
  jobId: JobId,
  material: { generation: number; text: MaterialArtifactRow; pdf: MaterialArtifactRow | null },
  effective: ResumeTemplateMetadata,
  renderPdf: ResumeHtmlPdfRenderer,
): Promise<{ generation: number }> {
  if (!material.text.path || !fs.existsSync(material.text.path) || !fs.statSync(material.text.path).isFile()) {
    throw new ResumeTemplateInputError("Latest accepted resume text artifact is not readable.");
  }
  const text = readTextFileLimited(material.text.path);
  if (!text.trim()) {
    throw new ResumeTemplateInputError("Latest accepted resume text artifact is empty.");
  }

  const outputDir = path.dirname(material.pdf?.path || material.text.path);
  fs.mkdirSync(outputDir, { recursive: true });
  const generation = nextMaterialGeneration(db, jobId);
  const suffix = stableHash([jobId, generation, effective.templateVersionId, effective.templateHash]).slice(0, 16);
  const textArtifactId = `template_refresh_text_${suffix}`;
  const pdfArtifactId = `template_refresh_pdf_${suffix}`;
  const baseName = `resume-template-refresh-${suffix}`;
  const textPath = path.join(outputDir, `${baseName}.txt`);
  const htmlPath = path.join(outputDir, `${baseName}.html`);
  const pdfPath = path.join(outputDir, `${baseName}.pdf`);
  const attemptId = crypto.randomUUID().slice(0, 8);
  const tmpTextPath = `${textPath}.${attemptId}.tmp`;
  const tmpHtmlPath = `${htmlPath}.${attemptId}.tmp`;
  const tmpPdfPath = `${pdfPath}.${attemptId}.tmp`;
  const layoutBoxes = layoutBoxesForText(text);
  const now = new Date().toISOString();
  const templateMetadata = templateMetadataPayload(effective);

  fs.writeFileSync(tmpTextPath, text, "utf8");
  fs.writeFileSync(tmpHtmlPath, htmlForTemplateRefresh(text, effective), "utf8");
  try {
    await renderPdf({ htmlPath: tmpHtmlPath, pdfPath: tmpPdfPath });
  } catch (error) {
    for (const orphan of [tmpTextPath, tmpHtmlPath, tmpPdfPath]) {
      try {
        fs.rmSync(orphan, { force: true });
      } catch {
        // Best-effort cleanup only; the render error is what matters.
      }
    }
    throw error;
  }

  // Generation, source material, and effective template were captured before
  // the awaited render; a concurrent material write, refresh, or template
  // assignment can land in that gap. Revalidate and persist in one short
  // transaction, promoting this attempt's temp files only after the guards.
  let promoted = false;
  try {
    const tx = db.transaction(() => {
      if (nextMaterialGeneration(db, jobId) !== generation) {
        throw new ResumeTemplateInputError("Job materials changed while refreshing; retry the refresh.");
      }
      const currentMaterial = latestResumeMaterial(db, jobId);
      if (!currentMaterial || currentMaterial.generation !== material.generation) {
        throw new ResumeTemplateInputError("The source resume changed while refreshing; retry the refresh.");
      }
      const currentState = resumeTemplateStateForJobId(db, jobId);
      if (
        !currentState ||
        currentState.effective.templateVersionId !== effective.templateVersionId ||
        currentState.effective.templateHash !== effective.templateHash
      ) {
        throw new ResumeTemplateInputError("The effective template changed while refreshing; retry the refresh.");
      }
      promoted = true;
      fs.renameSync(tmpTextPath, textPath);
      fs.renameSync(tmpHtmlPath, htmlPath);
      fs.renameSync(tmpPdfPath, pdfPath);
      persistRefreshRows(db, {
        jobId,
        generation,
        now,
        textPath,
        htmlPath,
        pdfPath,
        textArtifactId,
        pdfArtifactId,
        layoutBoxes,
        material,
        templateMetadata,
      });
    });
    tx();
  } catch (error) {
    const orphans = [tmpTextPath, tmpHtmlPath, tmpPdfPath];
    if (promoted) {
      orphans.push(textPath, htmlPath, pdfPath);
    }
    for (const orphan of orphans) {
      try {
        fs.rmSync(orphan, { force: true });
      } catch {
        // Best-effort cleanup only; the original error is what matters.
      }
    }
    throw error;
  }
  return { generation };
}

function persistRefreshRows(
  db: SqliteDatabase,
  input: {
    jobId: JobId;
    generation: number;
    now: string;
    textPath: string;
    htmlPath: string;
    pdfPath: string;
    textArtifactId: string;
    pdfArtifactId: string;
    layoutBoxes: ReturnType<typeof layoutBoxesForText>;
    material: { generation: number; text: MaterialArtifactRow; pdf: MaterialArtifactRow | null };
    templateMetadata: unknown;
  },
): void {
  const {
    jobId,
    generation,
    now,
    textPath,
    htmlPath,
    pdfPath,
    textArtifactId,
    pdfArtifactId,
    layoutBoxes,
    material,
    templateMetadata,
  } = input;
  db.prepare(
    `INSERT INTO job_materials (
       tenant_id, job_id, generation, status, created_at, updated_at,
       last_validation_json, last_verdict_json, metadata_json
     ) VALUES (?, ?, ?, 'resume_approved', ?, ?, ?, ?, ?)`,
  ).run(
    DEFAULT_TENANT,
    jobId,
    generation,
    now,
    now,
    JSON.stringify({ passed: true, errors: [], warnings: [] }),
    JSON.stringify({ approved: true, source: TEMPLATE_REFRESH_SOURCE }),
    JSON.stringify({
      source: TEMPLATE_REFRESH_SOURCE,
      base_generation: material.generation,
      [TEMPLATE_METADATA_KEY]: templateMetadata,
    }),
  );
  insertMaterialArtifact(db, {
    jobId,
    generation,
    artifactType: "tailored_resume",
    artifactId: textArtifactId,
    path: textPath,
    renderFormat: "text",
    sizeBytes: fs.statSync(textPath).size,
    metadata: {
      source: TEMPLATE_REFRESH_SOURCE,
      base_resume_text_artifact_id: material.text.artifact_id,
      [TEMPLATE_METADATA_KEY]: templateMetadata,
    },
    createdAt: now,
  });
  insertMaterialArtifact(db, {
    jobId,
    generation,
    artifactType: "resume_pdf",
    artifactId: pdfArtifactId,
    path: pdfPath,
    renderFormat: "html_pdf",
    sizeBytes: fs.statSync(pdfPath).size,
    metadata: {
      source: TEMPLATE_REFRESH_SOURCE,
      html_path: htmlPath,
      base_resume_pdf_artifact_id: material.pdf?.artifact_id ?? null,
      layout_box_count: layoutBoxes.length,
      [TEMPLATE_METADATA_KEY]: templateMetadata,
    },
    createdAt: now,
  });
  replaceLayoutBoxes(db, jobId, generation, pdfArtifactId, layoutBoxes, now);
}

function insertMaterialArtifact(
  db: SqliteDatabase,
  input: {
    jobId: JobId;
    generation: number;
    artifactType: "tailored_resume" | "resume_pdf";
    artifactId: string;
    path: string;
    renderFormat: "text" | "html_pdf";
    sizeBytes: number;
    metadata: Record<string, unknown>;
    createdAt: string;
  },
): void {
  db.prepare(
    `INSERT INTO job_materials_artifacts (
       tenant_id, job_id, generation, artifact_type, artifact_id, status,
       path, render_format, size_bytes, metadata_json, created_at, superseded_at
     ) VALUES (?, ?, ?, ?, ?, 'approved', ?, ?, ?, ?, ?, NULL)`,
  ).run(
    DEFAULT_TENANT,
    input.jobId,
    input.generation,
    input.artifactType,
    input.artifactId,
    input.path,
    input.renderFormat,
    input.sizeBytes,
    JSON.stringify(input.metadata),
    input.createdAt,
  );
}

function nextMaterialGeneration(db: SqliteDatabase, jobId: JobId): number {
  const row = getRow<{ max_generation: number | null }>(
    db,
    `SELECT MAX(generation) AS max_generation
       FROM job_materials
      WHERE tenant_id = ? AND job_id = ?`,
    [DEFAULT_TENANT, jobId],
  );
  return Math.max(0, Number(row?.max_generation ?? 0)) + 1;
}

function replaceLayoutBoxes(
  db: SqliteDatabase,
  jobId: JobId,
  generation: number,
  artifactId: string,
  boxes: readonly ResumeLayoutBox[],
  createdAt: string,
): void {
  db.prepare(
    "DELETE FROM job_material_layout_boxes WHERE tenant_id = ? AND job_id = ? AND generation = ? AND artifact_id = ?",
  ).run(DEFAULT_TENANT, jobId, generation, artifactId);
  for (const [index, box] of boxes.entries()) {
    db.prepare(
      `INSERT INTO job_material_layout_boxes (
         tenant_id, job_id, generation, artifact_id, box_index, semantic_id,
         page_number, line_number, text_excerpt, left_pct, top_pct, width_pct,
         height_pct, audit_target_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      DEFAULT_TENANT,
      jobId,
      generation,
      artifactId,
      index,
      box.semanticId,
      box.pageNumber,
      box.lineNumber,
      box.textExcerpt,
      box.leftPct,
      box.topPct,
      box.widthPct,
      box.heightPct,
      JSON.stringify({
        source: TEMPLATE_REFRESH_SOURCE,
        semanticId: box.semanticId,
        lineNumber: box.lineNumber,
      }),
      createdAt,
    );
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
  jobId: JobId,
  status: ResumeTemplateRefreshStatus,
  templateState: ResumeTemplateState | null,
  attempt: ResumeTemplateRefreshAttempt | null,
  message: string,
): EnsureCurrentResumeMaterialsResponse {
  return {
    ok: true,
    jobKey: jobId,
    status,
    templateState,
    attempt,
    generation: null,
    message,
  };
}

function requireJobId(value: string): JobId {
  if (!CANONICAL_JOB_ID.test(value)) {
    throw new ResumeTemplateInputError("jobId must be a canonical lowercase UUID");
  }
  return value as JobId;
}

function assertJobExists(db: SqliteDatabase, jobId: JobId): void {
  const row = getRow<{ job_id: string }>(
    db,
    "SELECT job_id FROM jobs WHERE tenant_id = ? AND job_id = ?",
    [DEFAULT_TENANT, jobId],
  );
  if (!row) throw new ResumeTemplateInputError(`Job not found: ${jobId}`);
}

function recordTemplateEvent(
  db: SqliteDatabase,
  event: {
    jobId: JobId | null;
    eventType: string;
    message: string;
    payload: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO job_events (
       tenant_id, job_id, identity_version, stage, event_type, level,
       message, occurred_at, payload_json, entity_kind, entity_ref, idempotency_key
     ) VALUES (?, ?, 1, 'tailor', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
  ).run(
    DEFAULT_TENANT,
    event.jobId,
    event.eventType,
    event.eventType.endsWith("Failed") ? "warn" : "info",
    event.message,
    new Date().toISOString(),
    JSON.stringify({
      tenantId: DEFAULT_TENANT,
      ...(event.jobId ? { jobId: event.jobId } : {}),
      ...event.payload,
    }),
  );
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
