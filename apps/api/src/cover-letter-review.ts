import crypto from "node:crypto";
import path from "node:path";
import {
  COVER_LETTER_RENDERER_VERSION, DEFAULT_COVER_LETTER_SETTINGS,
  CoverLetterPreviewSchema, CoverLetterSettingsSchema,
  type CoverLetterAccepted, type CoverLetterPreview, type CoverLetterRenderRequest,
} from "@jobctrl/contracts";
import { allRows, getRow, type SqliteDatabase } from "./db.js";
import { InputError, resolveJobId } from "./write-model.js";
import { CoverLetterPathError, createCoverLetterAttempt, ownedCoverLetterPath, readOwnedCoverLetterFile, removeCoverLetterAttempt, writeOwnedCoverLetterFile } from "./cover-letter-files.js";
import { selectResumeMaterial, RESUME_TEXT_ARTIFACT_TYPES, RESUME_PDF_ARTIFACT_TYPES, type ResumeMaterialSelection } from "./material-preview-selection.js";

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
  try { const value: unknown = JSON.parse(raw ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; } catch { return {}; }
}
function approved(db: SqliteDatabase, jobId: string, types: string[]): ArtifactRow | undefined {
  return getRow<ArtifactRow>(db, `SELECT * FROM job_materials_artifacts
    WHERE tenant_id=? AND job_id=? AND artifact_type IN (${types.map(() => "?").join(",")})
      AND status='approved' AND superseded_at IS NULL ORDER BY generation DESC, created_at DESC, rowid DESC LIMIT 1`,
  [TENANT, jobId, ...types]);
}
export function coverLetterSourceBytes(appDir: string, file: string): Buffer {
  try {
    const bytes = readOwnedCoverLetterFile(appDir, file, MAX_SOURCE_BYTES);
    if (!new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim()) throw new Error();
    return bytes;
  } catch (error) {
    if (error instanceof CoverLetterPathError) throw new CoverLetterReviewError("cover_letter_path_forbidden", 403);
    throw new CoverLetterReviewError("cover_letter_source_unreadable_or_oversized", 422);
  }
}
/** Read only the source recorded by the canonical cover identity, never an alias fallback. */
export function coverLetterTextForSource(db: SqliteDatabase, appDir: string, source: CoverLetterAccepted["source"]): string {
  const row = getRow<ArtifactRow>(db, `SELECT * FROM job_materials_artifacts
    WHERE tenant_id=? AND job_id=? AND artifact_id=? AND generation>=?
      AND artifact_type IN ('cover_letter','cover_letter_txt') AND status='approved' AND superseded_at IS NULL
    ORDER BY generation DESC, created_at DESC, rowid DESC LIMIT 1`,
  [source.tenantId, source.jobId, source.artifactId, source.generation]);
  if (!row) throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
  const bytes = coverLetterSourceBytes(appDir, row.path);
  if (hash(bytes) !== source.textSha256) throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
  return bytes.toString("utf8");
}
function pdfBytes(appDir: string, file: string): Buffer {
  try {
    const bytes = readOwnedCoverLetterFile(appDir, file, 32_000_000);
    if (!bytes.subarray(0, 5).equals(Buffer.from("%PDF-")) || !bytes.includes(Buffer.from("%%EOF"))) throw new Error();
    return bytes;
  } catch (error) {
    if (error instanceof CoverLetterPathError) throw new CoverLetterReviewError("cover_letter_path_forbidden", 403);
    throw new CoverLetterReviewError("cover_letter_pdf_missing_or_invalid", 422);
  }
}
function generation(db: SqliteDatabase, jobId: string): number {
  return getRow<{ value: number }>(db, "SELECT max(generation) AS value FROM job_materials WHERE tenant_id=? AND job_id=?", [TENANT, jobId])?.value ?? 0;
}
export function coverLetterAccepted(db: SqliteDatabase, jobId: string, appDir = path.dirname(path.resolve(db.name))): CoverLetterAccepted | null {
  const text = approved(db, jobId, ["cover_letter", "cover_letter_txt"]);
  if (!text) return null;
  const pdf = approved(db, jobId, ["cover_letter_pdf"]);
  const pdfMetadata = metadata(pdf?.metadata_json ?? null);
  const print = CoverLetterPreviewSchema.safeParse(pdfMetadata["cover_letter_review"]).data;
  const settings = CoverLetterSettingsSchema.parse(print?.settings ?? pdfMetadata["cover_letter_settings"] ?? DEFAULT_COVER_LETTER_SETTINGS);
  const originalGeneration = getRow<{ value: number }>(db, `SELECT min(generation) AS value FROM job_materials_artifacts
    WHERE tenant_id=? AND job_id=? AND artifact_id=?`, [TENANT, jobId, text.artifact_id])?.value ?? text.generation;
  let textSha256: string;
  let sourceReadable = true;
  try { textSha256 = hash(coverLetterSourceBytes(appDir, text.path)); }
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
  // Acceptance is persisted authority. A replaced/missing file must not mint a
  // new accepted identity or turn its current bytes into approval evidence.
  const recordedHash = print?.pdfSha256 ?? pdfMetadata["cover_letter_pdf_sha256"];
  const pdfSha256 = typeof recordedHash === "string" && /^[a-f0-9]{64}$/.test(recordedHash) ? recordedHash : null;
  let currentPdfSha256: string | null = null;
  if (pdf) { try { currentPdfSha256 = hash(pdfBytes(appDir, pdf.path)); } catch { /* preserve durable identity, block approval */ } }
  const rendererVersion = print?.rendererVersion ?? (typeof pdfMetadata["cover_letter_renderer_version"] === "string" ? pdfMetadata["cover_letter_renderer_version"] : null);
  const generatedSourceGeneration = pdfMetadata["source_generation"];
  const generatedSourceCurrent = pdfMetadata["source_artifact_id"] === source.artifactId
    && pdfMetadata["cover_letter_text_sha256"] === source.textSha256
    && pdfMetadata["cover_letter_renderer_version"] === COVER_LETTER_RENDERER_VERSION
    && CoverLetterSettingsSchema.safeParse(pdfMetadata["cover_letter_settings"]).success
    && typeof generatedSourceGeneration === "number" && Number.isSafeInteger(generatedSourceGeneration)
    && Boolean(getRow(db, "SELECT 1 FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND artifact_id=? AND generation=?",
      [TENANT, jobId, source.artifactId, generatedSourceGeneration]));
  const pdfSourceCurrent = Boolean(sourceReadable && pdf && pdfSha256 && pdfSha256 === currentPdfSha256 && (print
    ? JSON.stringify(print.source) === JSON.stringify(source)
    : pdfMetadata["cover_letter_review"] === undefined && generatedSourceCurrent));
  // Allocation includes rejected attempts; acceptance is owned only by the
  // selected source and PDF. Unaccepted work must not invalidate approval.
  const acceptedVersion = hash(JSON.stringify([source, pdf?.artifact_id ?? null, pdfSha256, settings, rendererVersion]));
  return { source, acceptedVersion, pdfArtifactId: pdf?.artifact_id ?? null, pdfSha256, pdfSourceCurrent, settings, rendererVersion };
}
export function requireCoverLetterApproval(db: SqliteDatabase, jobId: string, appDir?: string): CoverLetterAccepted | null {
  const accepted = coverLetterAccepted(db, jobId, appDir);
  if (!accepted) return null;
  const pdf = approved(db, jobId, ["cover_letter_pdf"]);
  if (!accepted.pdfSourceCurrent || !pdf) throw new InputError("approval_stale_materials");
  return accepted;
}
export function safeCoverLetterAccepted(db: SqliteDatabase, jobId: string, appDir?: string): CoverLetterAccepted | null {
  try { return coverLetterAccepted(db, jobId, appDir); } catch { return null; }
}
export function coverLetterJobId(db: SqliteDatabase, locator: string): string {
  const jobId = resolveJobId(db, TENANT, locator);
  if (!jobId || !getRow(db, "SELECT 1 FROM jobs WHERE tenant_id=? AND job_id=?", [TENANT, jobId])) throw new InputError("Job not found");
  return jobId;
}
function requireSnapshot(db: SqliteDatabase, appDir: string, jobId: string, version: string, source?: CoverLetterPreview["source"]): CoverLetterAccepted {
  const accepted = coverLetterAccepted(db, jobId, appDir);
  const canonicalText = approved(db, jobId, ["cover_letter", "cover_letter_txt"]);
  if (canonicalText && accepted && hash(coverLetterSourceBytes(appDir, canonicalText.path)) !== accepted.source.textSha256) {
    throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
  }
  if (!accepted || accepted.acceptedVersion !== version || (source && JSON.stringify(accepted.source) !== JSON.stringify(source))) {
    throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
  }
  return accepted;
}
function attemptPath(appDir: string, previewId: string): string {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(previewId)) throw new CoverLetterReviewError("cover_letter_preview_not_found", 404);
  return ownedCoverLetterPath(appDir, path.join(appDir, "generated", "cover-letter-previews", previewId));
}
function readPreview(appDir: string, jobId: string, previewId: string): CoverLetterPreview {
  try {
    const preview = CoverLetterPreviewSchema.parse(JSON.parse(readOwnedCoverLetterFile(appDir, path.join(attemptPath(appDir, previewId), "preview.json"), 128_000).toString("utf8")));
    if (preview.previewId !== previewId || preview.source.tenantId !== TENANT || preview.source.jobId !== jobId) throw new Error();
    return preview;
  } catch { throw new CoverLetterReviewError("cover_letter_preview_not_found", 404); }
}
export function coverLetterPreviewBytes(appDir: string, jobId: string, previewId: string): Buffer {
  const preview = readPreview(appDir, jobId, previewId);
  const bytes = pdfBytes(appDir, path.join(attemptPath(appDir, previewId), "letter.pdf"));
  if (hash(bytes) !== preview.pdfSha256) throw new CoverLetterReviewError("cover_letter_preview_corrupt", 422);
  return bytes;
}
export function coverLetterArtifactPdfBytes(db: SqliteDatabase, appDir: string, artifactId: string): Buffer {
  const row = getRow<ArtifactRow>(db, "SELECT * FROM job_materials_artifacts WHERE tenant_id=? AND artifact_id=? AND artifact_type='cover_letter_pdf' ORDER BY generation DESC LIMIT 1", [TENANT, artifactId]);
  if (!row) throw new CoverLetterReviewError("artifact_not_found", 404);
  const bytes = pdfBytes(appDir, row.path);
  const meta = metadata(row.metadata_json);
  const review = CoverLetterPreviewSchema.safeParse(meta["cover_letter_review"]).data;
  if (meta["cover_letter_review"] !== undefined && !review) throw new CoverLetterReviewError("cover_letter_pdf_missing_or_invalid", 422);
  const expected = review?.pdfSha256 ?? meta["cover_letter_pdf_sha256"];
  if (expected !== undefined && hash(bytes) !== expected) throw new CoverLetterReviewError("cover_letter_pdf_changed", 422);
  return bytes;
}
export type CoverLetterPdfRenderer = (input: {
  sourcePath: string; pdfPath: string; textSha256: string;
  settings: CoverLetterRenderRequest["settings"]; rendererVersion: typeof COVER_LETTER_RENDERER_VERSION;
}) => Promise<void>;
export async function renderCoverLetterPreview(db: SqliteDatabase, appDir: string, jobId: string,
  request: CoverLetterRenderRequest, render: CoverLetterPdfRenderer): Promise<{ ok: true; preview: CoverLetterPreview }> {
  const settings = CoverLetterSettingsSchema.parse(request.settings);
  const accepted = requireSnapshot(db, appDir, jobId, request.expectedAcceptedVersion, request.source);
  const source = approved(db, jobId, ["cover_letter", "cover_letter_txt"])!;
  const previewId = crypto.randomUUID();
  const { directory, stat } = createCoverLetterAttempt(appDir, previewId);
  try {
    // The worker reads this immutable full-text snapshot. The canonical source
    // is checked again after rendering and inside the save transaction.
    const bytes = coverLetterSourceBytes(appDir, source.path);
    if (hash(bytes) !== accepted.source.textSha256) throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
    const sourcePath = path.join(directory, "source.txt");
    const pdfPath = ownedCoverLetterPath(appDir, path.join(directory, "letter.pdf"), true);
    writeOwnedCoverLetterFile(appDir, sourcePath, bytes);
    await render({ sourcePath, pdfPath, textSha256: accepted.source.textSha256, settings, rendererVersion: COVER_LETTER_RENDERER_VERSION });
    if (hash(coverLetterSourceBytes(appDir, sourcePath)) !== accepted.source.textSha256) throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
    requireSnapshot(db, appDir, jobId, request.expectedAcceptedVersion, request.source);
    const preview: CoverLetterPreview = { previewId, source: accepted.source, expectedAcceptedVersion: accepted.acceptedVersion,
      settings, rendererVersion: COVER_LETTER_RENDERER_VERSION, pdfSha256: hash(pdfBytes(appDir, pdfPath)) };
    writeOwnedCoverLetterFile(appDir, path.join(directory, "preview.json"), JSON.stringify(preview));
    return { ok: true, preview };
  } catch (error) {
    removeCoverLetterAttempt(appDir, directory, stat);
    throw error;
  }
}

/** Copy unchanged material slots and their source-bound records, retaining IDs.
 * History is append-only; neither files nor previous-generation rows are edited.
 */
export function copyMaterialSlots(db: SqliteDatabase, jobId: string, targetGeneration: number, excluded: readonly string[], selectedResume?: ResumeMaterialSelection): void {
  const rows = allRows<ArtifactRow>(db, `SELECT * FROM (
    SELECT *, rowid AS source_rowid, dense_rank() OVER (
      PARTITION BY CASE
        WHEN artifact_type IN ('cover_letter','cover_letter_txt') THEN 'cover_letter'
        ELSE artifact_type END
      ORDER BY generation DESC) AS rank
    FROM job_materials_artifacts WHERE tenant_id=? AND job_id=? AND generation<? AND status='approved' AND superseded_at IS NULL
      AND artifact_type NOT IN ('tailored_resume','tailored_resume_txt','resume_txt','resume_pdf','tailored_resume_pdf')
  ) WHERE rank=1 ORDER BY source_rowid`, [TENANT, jobId, targetGeneration]);
  const resumeTypes = [...RESUME_TEXT_ARTIFACT_TYPES, ...RESUME_PDF_ARTIFACT_TYPES];
  if (!resumeTypes.every(type => excluded.includes(type))) {
    const selection = selectedResume ?? selectResumeMaterial(db, jobId);
    for (const [candidate, types] of [[selection.text?.candidate, RESUME_TEXT_ARTIFACT_TYPES], [selection.pdf, RESUME_PDF_ARTIFACT_TYPES]] as const) {
      // Legacy/unaccepted selections remain in their existing stores. Do not
      // turn a review-required candidate into accepted material by copying it.
      if (!candidate?.artifactId || candidate.generation === null || candidate.reviewRequired) continue;
      const row = getRow<ArtifactRow>(db, `SELECT *, rowid AS source_rowid FROM job_materials_artifacts
        WHERE tenant_id=? AND job_id=? AND artifact_id=? AND generation=? AND generation<?
          AND status='approved' AND superseded_at IS NULL
          AND artifact_type IN (${types.map(() => "?").join(",")})`,
      [TENANT, jobId, candidate.artifactId, candidate.generation, targetGeneration, ...types]);
      if (row) rows.push(row);
    }
  }
  // Copy the exact coherent resume selection, never combine newer partial text
  // and PDF generations. Cover aliases retain their current generation/order.
  rows.sort((a, b) => Number(a["source_rowid"]) - Number(b["source_rowid"]));
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
function matchesPreview(accepted: CoverLetterAccepted | null, preview: CoverLetterPreview): accepted is CoverLetterAccepted {
  return Boolean(accepted?.pdfSourceCurrent && accepted.pdfArtifactId === `cover_pdf_${preview.previewId}`
    && JSON.stringify(accepted.source) === JSON.stringify(preview.source) && accepted.pdfSha256 === preview.pdfSha256
    && JSON.stringify(accepted.settings) === JSON.stringify(preview.settings) && accepted.rendererVersion === preview.rendererVersion);
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
      const accepted = coverLetterAccepted(db, jobId, appDir);
      if (matchesPreview(accepted, preview)) return { ok: true as const, accepted };
    }
    requireSnapshot(db, appDir, jobId, request.expectedAcceptedVersion, preview.source);
    const bytes = coverLetterPreviewBytes(appDir, jobId, preview.previewId);
    const previousGeneration = generation(db, jobId);
    const next = previousGeneration + 1;
    const selectedResume = selectResumeMaterial(db, jobId);
    const baseGeneration = selectedResume.text?.candidate.generation ?? selectedResume.pdf?.generation ?? previousGeneration;
    const base = getRow<{ metadata_json: string | null }>(db, "SELECT metadata_json FROM job_materials WHERE tenant_id=? AND job_id=? AND generation=?", [TENANT, jobId, baseGeneration]);
    const now = new Date().toISOString();
    const meta = { ...metadata(base?.metadata_json ?? null), __jobctrl_materials_lineage_id: crypto.randomUUID().replaceAll("-", ""), cover_letter_review: preview };
    db.prepare(`INSERT INTO job_materials
      (tenant_id,job_id,generation,status,created_at,updated_at,last_validation_json,last_verdict_json,metadata_json)
      SELECT tenant_id, job_id, ?, status, ?, ?, last_validation_json, last_verdict_json, ?
      FROM job_materials WHERE tenant_id=? AND job_id=? AND generation=?`)
      .run(next, now, now, JSON.stringify(meta), TENANT, jobId, baseGeneration);
    copyMaterialSlots(db, jobId, next, ["cover_letter_pdf"], selectedResume);
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
    // Files are outside SQLite's transaction. Recheck the submitted receipt and
    // the final canonical source/PDF binding after every promotion write, before
    // committing either materials or their event. A refused promotion rolls back
    // its rows, never a newer source file produced by another writer.
    const accepted = coverLetterAccepted(db, jobId, appDir);
    if (!matchesPreview(accepted, preview)
      || JSON.stringify(readPreview(appDir, jobId, preview.previewId)) !== JSON.stringify(preview)) {
      throw new CoverLetterReviewError("cover_letter_version_conflict", 409);
    }
    return { ok: true as const, accepted };
  }).immediate();
}
