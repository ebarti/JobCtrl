import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  COVER_LETTER_RENDERER_VERSION, DEFAULT_COVER_LETTER_SETTINGS,
  CoverLetterPreviewSchema, CoverLetterSettingsSchema,
  type CoverLetterAccepted, type CoverLetterPreview, type CoverLetterRenderRequest,
} from "@jobctrl/contracts";
import { allRows, getRow, type SqliteDatabase } from "./db.js";
import { InputError, resolveJobId } from "./write-model.js";

const TENANT = "local";
const MAX_SOURCE_BYTES = 512_000;
const hash = (value: crypto.BinaryLike) => crypto.createHash("sha256").update(value).digest("hex");
export class CoverLetterReviewError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}
interface ArtifactRow extends Record<string, unknown> {
  tenant_id: string; job_id: string; generation: number; artifact_type: string;
  artifact_id: string; path: string; status: string; metadata_json: string | null;
}
function metadata(raw: string | null): Record<string, unknown> {
  try { return JSON.parse(raw ?? "{}") as Record<string, unknown>; } catch { return {}; }
}
function approved(db: SqliteDatabase, jobId: string, types: string[]): ArtifactRow | undefined {
  return getRow<ArtifactRow>(db, `SELECT * FROM job_materials_artifacts
    WHERE tenant_id=? AND job_id=? AND artifact_type IN (${types.map(() => "?").join(",")})
      AND status='approved' AND superseded_at IS NULL ORDER BY generation DESC, created_at DESC, rowid DESC LIMIT 1`,
  [TENANT, jobId, ...types]);
}
function sourceBytes(file: string): Buffer {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const raw = Buffer.alloc(MAX_SOURCE_BYTES + 1);
      const length = fs.readSync(fd, raw, 0, raw.length, 0);
      if (!length || length > MAX_SOURCE_BYTES) throw new Error();
      const bytes = raw.subarray(0, length);
      if (!new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()) throw new Error();
      return bytes;
    } finally { fs.closeSync(fd); }
  } catch { throw new CoverLetterReviewError("cover_letter_source_unreadable_or_oversized", 422); }
}
function pdfBytes(file: string): Buffer {
  try {
    if (fs.statSync(file).size > 32_000_000) throw new Error();
    const bytes = fs.readFileSync(file);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || !bytes.includes(Buffer.from("%%EOF"))) throw new Error();
    return bytes;
  } catch { throw new CoverLetterReviewError("cover_letter_pdf_missing_or_invalid", 422); }
}
function generation(db: SqliteDatabase, jobId: string): number {
  return getRow<{ value: number }>(db, "SELECT max(generation) AS value FROM job_materials WHERE tenant_id=? AND job_id=?", [TENANT, jobId])?.value ?? 0;
}
export function coverLetterAccepted(db: SqliteDatabase, jobId: string): CoverLetterAccepted | null {
  const text = approved(db, jobId, ["cover_letter", "cover_letter_txt"]);
  if (!text) return null;
  const pdf = approved(db, jobId, ["cover_letter_pdf"]);
  const pdfMetadata = metadata(pdf?.metadata_json ?? null);
  const print = pdfMetadata["cover_letter_review"] as CoverLetterPreview | undefined;
  const settings = CoverLetterSettingsSchema.parse(print?.settings ?? pdfMetadata["cover_letter_settings"] ?? DEFAULT_COVER_LETTER_SETTINGS);
  const originalGeneration = getRow<{ value: number }>(db, `SELECT min(generation) AS value FROM job_materials_artifacts
    WHERE tenant_id=? AND job_id=? AND artifact_id=?`, [TENANT, jobId, text.artifact_id])?.value ?? text.generation;
  let textSha256: string;
  let sourceReadable = true;
  try { textSha256 = hash(sourceBytes(text.path)); }
  catch (error) {
    // Retain the last accepted source identity and PDF when its source file
    // becomes unreadable. This receipt is historical authority, never permission
    // to render/save: requireSnapshot independently checks the canonical bytes.
    if (!print || print.source.tenantId !== TENANT || print.source.jobId !== jobId
      || print.source.artifactId !== text.artifact_id || print.source.generation !== originalGeneration) throw error;
    textSha256 = print.source.textSha256;
    sourceReadable = false;
  }
  const source = { tenantId: TENANT, jobId, artifactId: text.artifact_id, generation: originalGeneration, textSha256 };
  // Missing/corrupt PDFs remain visible as an error in the viewer, while a new
  // valid preview can repair them. Their identity still changes on corruption.
  let pdfSha256: string | null = null;
  if (pdf) { try { if (fs.statSync(pdf.path).size <= 32_000_000) pdfSha256 = hash(fs.readFileSync(pdf.path)); } catch { /* unavailable */ } }
  const rendererVersion = print?.rendererVersion ?? (typeof pdfMetadata["cover_letter_renderer_version"] === "string" ? pdfMetadata["cover_letter_renderer_version"] : null);
  const pdfSourceCurrent = Boolean(sourceReadable && pdf && pdfSha256 && (print
    ? print.source.artifactId === source.artifactId && print.source.textSha256 === source.textSha256
    : pdf.generation === text.generation));
  // Allocation includes rejected attempts; acceptance is owned only by the
  // selected source and PDF. Unaccepted work must not invalidate approval.
  const acceptedVersion = hash(JSON.stringify([source, pdf?.artifact_id ?? null, pdfSha256, settings, rendererVersion]));
  return { source, acceptedVersion, pdfArtifactId: pdf?.artifact_id ?? null, pdfSha256, pdfSourceCurrent, settings, rendererVersion };
}
export function requireCoverLetterApproval(db: SqliteDatabase, jobId: string): CoverLetterAccepted | null {
  const accepted = coverLetterAccepted(db, jobId);
  if (!accepted) return null;
  const pdf = approved(db, jobId, ["cover_letter_pdf"]);
  if (!accepted.pdfSourceCurrent || !pdf) throw new InputError("approval_stale_materials");
  pdfBytes(pdf.path);
  return accepted;
}
export function safeCoverLetterAccepted(db: SqliteDatabase, jobId: string): CoverLetterAccepted | null {
  try { return coverLetterAccepted(db, jobId); } catch { return null; }
}
export function coverLetterJobId(db: SqliteDatabase, locator: string): string {
  const jobId = resolveJobId(db, TENANT, locator);
  if (!jobId || !getRow(db, "SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=?", [TENANT, jobId])) throw new InputError("Job not found");
  return jobId;
}
function requireSnapshot(db: SqliteDatabase, jobId: string, version: string, source?: CoverLetterPreview["source"]): CoverLetterAccepted {
  const accepted = coverLetterAccepted(db, jobId);
  const canonicalText = approved(db, jobId, ["cover_letter", "cover_letter_txt"]);
  if (canonicalText && accepted && hash(sourceBytes(canonicalText.path)) !== accepted.source.textSha256) {
    throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
  }
  if (!accepted || accepted.acceptedVersion !== version || (source && JSON.stringify(accepted.source) !== JSON.stringify(source))) {
    throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
  }
  return accepted;
}
function attemptPath(appDir: string, previewId: string): string {
  if (!/^[a-f0-9-]{36}$/.test(previewId)) throw new CoverLetterReviewError("cover_letter_preview_not_found", 404);
  return path.join(appDir, "generated", "cover-letter-previews", previewId);
}
function readPreview(appDir: string, jobId: string, previewId: string): CoverLetterPreview {
  try {
    const preview = CoverLetterPreviewSchema.parse(JSON.parse(fs.readFileSync(path.join(attemptPath(appDir, previewId), "preview.json"), "utf8")));
    if (preview.previewId !== previewId || preview.source.tenantId !== TENANT || preview.source.jobId !== jobId) throw new Error();
    return preview;
  } catch { throw new CoverLetterReviewError("cover_letter_preview_not_found", 404); }
}
export function coverLetterPreviewBytes(appDir: string, jobId: string, previewId: string): Buffer {
  const preview = readPreview(appDir, jobId, previewId);
  const bytes = pdfBytes(path.join(attemptPath(appDir, previewId), "letter.pdf"));
  if (hash(bytes) !== preview.pdfSha256) throw new CoverLetterReviewError("cover_letter_preview_corrupt", 422);
  return bytes;
}
export type CoverLetterPdfRenderer = (input: {
  sourcePath: string; pdfPath: string; textSha256: string;
  settings: CoverLetterRenderRequest["settings"]; rendererVersion: typeof COVER_LETTER_RENDERER_VERSION;
}) => Promise<void>;
export async function renderCoverLetterPreview(db: SqliteDatabase, appDir: string, jobId: string,
  request: CoverLetterRenderRequest, render: CoverLetterPdfRenderer): Promise<{ ok: true; preview: CoverLetterPreview }> {
  const settings = CoverLetterSettingsSchema.parse(request.settings);
  const accepted = requireSnapshot(db, jobId, request.expectedAcceptedVersion, request.source);
  const source = approved(db, jobId, ["cover_letter", "cover_letter_txt"])!;
  const previewId = crypto.randomUUID();
  const directory = attemptPath(appDir, previewId);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    // The worker reads this immutable full-text snapshot. The canonical source
    // is checked again after rendering and inside the save transaction.
    const bytes = sourceBytes(source.path);
    if (hash(bytes) !== accepted.source.textSha256) throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
    const sourcePath = path.join(directory, "source.txt");
    const pdfPath = path.join(directory, "letter.pdf");
    fs.writeFileSync(sourcePath, bytes, { flag: "wx", mode: 0o600 });
    await render({ sourcePath, pdfPath, textSha256: accepted.source.textSha256, settings, rendererVersion: COVER_LETTER_RENDERER_VERSION });
    requireSnapshot(db, jobId, request.expectedAcceptedVersion, request.source);
    const preview: CoverLetterPreview = { previewId, source: accepted.source, expectedAcceptedVersion: accepted.acceptedVersion,
      settings, rendererVersion: COVER_LETTER_RENDERER_VERSION, pdfSha256: hash(pdfBytes(pdfPath)) };
    fs.writeFileSync(path.join(directory, "preview.json"), JSON.stringify(preview), { flag: "wx", mode: 0o600 });
    return { ok: true, preview };
  } catch (error) {
    fs.rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Copy unchanged material slots and their source-bound records, retaining IDs.
 * History is append-only; neither files nor previous-generation rows are edited.
 */
export function copyMaterialSlots(db: SqliteDatabase, jobId: string, targetGeneration: number, excluded: readonly string[]): void {
  const rows = allRows<ArtifactRow>(db, `SELECT * FROM (
    SELECT *, row_number() OVER (PARTITION BY artifact_type ORDER BY generation DESC) AS rank
    FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND generation<? AND status='approved' AND superseded_at IS NULL
  ) WHERE rank=1`, [TENANT, jobId, targetGeneration]);
  for (const row of rows) {
    if (excluded.includes(row.artifact_type)) continue;
    db.prepare(`INSERT INTO job_materials_artifacts
      (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,size_bytes,metadata_json,created_at,superseded_at)
      SELECT tenant_id, job_id, ?, artifact_type, artifact_id, status, path, render_format, size_bytes, metadata_json, created_at, superseded_at
      FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND generation=? AND artifact_type=?`)
      .run(targetGeneration, TENANT, jobId, row.generation, row.artifact_type);
    db.prepare(`INSERT OR IGNORE INTO job_material_layout_boxes
      (tenant_id,job_id,generation,artifact_id,box_index,semantic_id,page_number,line_number,text_excerpt,left_pct,top_pct,width_pct,height_pct,audit_target_json,created_at)
      SELECT tenant_id, job_id, ?, artifact_id, box_index, semantic_id, page_number, line_number, text_excerpt,
        left_pct, top_pct, width_pct, height_pct, audit_target_json, created_at
      FROM job_material_layout_boxes WHERE tenant_id=? AND job_id=? AND generation=? AND artifact_id=?`)
      .run(targetGeneration, TENANT, jobId, row.generation, row.artifact_id);
    db.prepare(`INSERT OR IGNORE INTO job_bullet_provenance
      (tenant_id,job_id,generation,bullet_id,artifact_id,section,source_id,evidence_ids_json,requirement_ids_json,matched_keywords_json,transform_type,control,rationale,generated_text,position,created_at,coverage_json,voice_json)
      SELECT tenant_id,job_id,?,bullet_id,artifact_id,section,source_id,evidence_ids_json,requirement_ids_json,matched_keywords_json,transform_type,control,rationale,generated_text,position,created_at,coverage_json,voice_json
      FROM job_bullet_provenance WHERE tenant_id=? AND job_id=? AND generation=? AND artifact_id=?`)
      .run(targetGeneration, TENANT, jobId, row.generation, row.artifact_id);
    copyArtifactProvenance(db, jobId, row, row.artifact_id, targetGeneration);
  }
}
function copyArtifactProvenance(db: SqliteDatabase, jobId: string, row: ArtifactRow, artifactId: string, targetGeneration: number): void {
  db.prepare(`INSERT OR IGNORE INTO artifact_line_anchors
    SELECT tenant_id, ?, ?, ?, line_id, evidence_ids_json, requirement_ids_json, transform_type, reason, determination_id
    FROM artifact_line_anchors WHERE tenant_id=? AND artifact_kind=? AND artifact_id=? AND generation=?`)
    .run(artifactId === row.artifact_id ? row.artifact_type : "cover_letter_pdf", artifactId, targetGeneration, TENANT, row.artifact_type, row.artifact_id, row.generation);
  db.prepare(`INSERT OR IGNORE INTO semantic_entity_bindings
    SELECT tenant_id, entity_kind, ?, ?, determination_kind, determination_id FROM semantic_entity_bindings
    WHERE tenant_id=? AND entity_kind='artifact' AND entity_id=? AND entity_version=?`)
    .run(artifactId, String(targetGeneration), TENANT, row.artifact_id, String(row.generation));
}
export function acceptCoverLetterPreview(db: SqliteDatabase, appDir: string, jobId: string,
  request: { previewId: string; expectedAcceptedVersion: string }): { ok: true; accepted: CoverLetterAccepted } {
  const preview = readPreview(appDir, jobId, request.previewId);
  if (preview.expectedAcceptedVersion !== request.expectedAcceptedVersion) throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
  return db.transaction(() => {
    // A committed save can be reconciled after a lost acknowledgement without
    // creating another generation, but only while that save is still current.
    const currentPdf = approved(db, jobId, ["cover_letter_pdf"]);
    const saved = metadata(currentPdf?.metadata_json ?? null)["cover_letter_review"] as CoverLetterPreview | undefined;
    if (saved?.previewId === preview.previewId) {
      const accepted = coverLetterAccepted(db, jobId)!;
      if (accepted.pdfSourceCurrent && JSON.stringify(accepted.source) === JSON.stringify(preview.source) && accepted.pdfSha256 === preview.pdfSha256
        && JSON.stringify(accepted.settings) === JSON.stringify(preview.settings)
        && accepted.rendererVersion === preview.rendererVersion) return { ok: true as const, accepted };
    }
    requireSnapshot(db, jobId, request.expectedAcceptedVersion, preview.source);
    const bytes = coverLetterPreviewBytes(appDir, jobId, preview.previewId);
    const previousGeneration = generation(db, jobId);
    const next = previousGeneration + 1;
    const baseGeneration = approved(db, jobId, ["tailored_resume", "tailored_resume_txt", "resume_txt", "resume_pdf", "tailored_resume_pdf"])?.generation ?? previousGeneration;
    const base = getRow<{ metadata_json: string | null }>(db, "SELECT metadata_json FROM job_materials WHERE tenant_id=? AND job_id=? AND generation=?", [TENANT, jobId, baseGeneration]);
    const now = new Date().toISOString();
    const meta = { ...metadata(base?.metadata_json ?? null), __jobctrl_materials_lineage_id: crypto.randomUUID().replaceAll("-", ""), cover_letter_review: preview };
    db.prepare(`INSERT INTO job_materials
      (tenant_id,job_id,generation,status,created_at,updated_at,last_validation_json,last_verdict_json,metadata_json)
      SELECT tenant_id, job_id, ?, status, ?, ?, last_validation_json, last_verdict_json, ?
      FROM job_materials WHERE tenant_id=? AND job_id=? AND generation=?`)
      .run(next, now, now, JSON.stringify(meta), TENANT, jobId, baseGeneration);
    copyMaterialSlots(db, jobId, next, ["cover_letter_pdf"]);
    const artifactId = `cover_pdf_${preview.previewId}`;
    const text = approved(db, jobId, ["cover_letter", "cover_letter_txt"])!;
    db.prepare(`INSERT INTO job_materials_artifacts
      (tenant_id,job_id,generation,artifact_type,artifact_id,status,path,render_format,size_bytes,metadata_json,created_at,superseded_at)
      VALUES (?,?,?,'cover_letter_pdf',?,'approved',?,'html_pdf',?,?,?,NULL)`)
      .run(TENANT, jobId, next, artifactId, path.join(attemptPath(appDir, preview.previewId), "letter.pdf"), bytes.length,
        JSON.stringify({ ...metadata(text.metadata_json), cover_letter_review: preview }), now);
    // Formatting preserves content provenance; the new PDF derives from the
    // accepted text, rather than inventing new semantic determinations.
    copyArtifactProvenance(db, jobId, text, artifactId, next);
    // Publish through the existing Materials event after durable acceptance.
    // The event commits with the artifacts so warm projections and SSE readers
    // discover this PDF; preview-only and rolled-back attempts emit nothing.
    db.prepare(`INSERT INTO job_events
      (tenant_id,job_id,identity_version,stage,event_type,level,message,occurred_at,payload_json)
      VALUES (?,?,1,'pdf','PdfRendered','info','Accepted cover-letter PDF',?,?)`)
      .run(TENANT, jobId, now, JSON.stringify({tenantId:TENANT,jobId,artifactType:"cover_letter_pdf",artifactId,renderedAt:now}));
    return { ok: true as const, accepted: coverLetterAccepted(db, jobId)! };
  }).immediate();
}
