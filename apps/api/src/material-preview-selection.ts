import fs from "node:fs";
import { allRows, getRow, type SqliteDatabase } from "./db.js";

const DEFAULT_TENANT = "local";
const MATERIAL_PREVIEW_CHAR_LIMIT = 4000;
const MATERIAL_PREVIEW_BYTE_LIMIT = 24_000;
const RESUME_AUDIT_TEXT_BYTE_LIMIT = 128_000;

export interface MaterialArtifactCandidate {
  readonly artifactId: string | null;
  readonly createdAt: string;
  readonly generation: number | null;
  readonly metadataJson: string | null;
  readonly path: string;
  readonly reviewRequired: boolean;
  readonly rowRank: number;
  readonly sourceRank: number;
}

export const RESUME_TEXT_ARTIFACT_TYPES = ["tailored_resume", "tailored_resume_txt", "resume_txt"] as const;
export const RESUME_PDF_ARTIFACT_TYPES = ["tailored_resume_pdf", "resume_pdf"] as const;
export interface ResumeMaterialSelection {
  readonly text: { candidate: MaterialArtifactCandidate; preview: string } | null;
  readonly pdf: MaterialArtifactCandidate | null;
}

/** The exact resume pair displayed in Apply Review, including legacy fallbacks. */
export function selectResumeMaterial(db: SqliteDatabase, jobId: string): ResumeMaterialSelection {
  const textCandidates = materialArtifactCandidates(db, {
    artifactTypes: RESUME_TEXT_ARTIFACT_TYPES, binary: false,
    includeLegacyJobColumn: "tailored_resume_path", jobId,
  });
  const pdfCandidates = materialArtifactCandidates(db, {
    artifactTypes: RESUME_PDF_ARTIFACT_TYPES, binary: true, jobId,
  }).filter(candidate => candidate.artifactId);
  const options = { byteLimit: RESUME_AUDIT_TEXT_BYTE_LIMIT, charLimit: null };
  const reviewRequired = textCandidates.find(candidate => candidate.reviewRequired);
  if (reviewRequired) {
    const text = firstReadableTextCandidate([reviewRequired], options);
    if (text) return { text, pdf: null };
  }
  for (const pdf of pdfCandidates) {
    const text = firstReadableTextCandidate(textCandidates.filter(candidate => candidate.generation === pdf.generation), options);
    if (text) return { text, pdf };
  }
  if (pdfCandidates[0]) return { text: null, pdf: pdfCandidates[0] };
  return { text: firstReadableTextCandidate(textCandidates, options), pdf: null };
}

function firstReadableTextCandidate(
  candidates: readonly MaterialArtifactCandidate[],
  options: ReadTextOptions = {},
): { candidate: MaterialArtifactCandidate; preview: string } | null {
  for (const candidate of candidates) {
    const preview = readTextPreview(candidate.path, options);
    if (preview) {
      return { candidate, preview };
    }
  }
  return null;
}

export function materialArtifactCandidates(
  db: SqliteDatabase,
  {
    artifactTypes,
    binary,
    includeLegacyJobColumn,
    jobId,
  }: {
    readonly artifactTypes: readonly string[];
    readonly binary: boolean;
    readonly includeLegacyJobColumn?: "tailored_resume_path" | "cover_letter_path";
    readonly jobId: string;
  },
): MaterialArtifactCandidate[] {
  const candidates: MaterialArtifactCandidate[] = [];
  const placeholders = artifactTypes.map(() => "?").join(", ");

  const projectedRows = allRows<{
    artifact_id: string | null;
    created_at: string | null;
    generation: number | null;
    local_path: string | null;
    metadata_json: string | null;
    status: string | null;
  }>(
    db,
    `SELECT artifact_id, local_path, generation, created_at, status, metadata_json
     FROM artifact_list_projections
     WHERE tenant_id = ?
       AND job_id = ?
       AND artifact_type IN (${placeholders})
       AND COALESCE(status, 'active') IN ('approved', 'active', 'candidate')
       AND local_path IS NOT NULL
       AND local_path != ''
     ORDER BY COALESCE(generation, -1) DESC, COALESCE(created_at, '') DESC, artifact_id DESC
     LIMIT 16`,
    [DEFAULT_TENANT, jobId, ...artifactTypes],
  );
  for (const [index, row] of projectedRows.entries()) {
    const reviewRequired = row.status === "candidate" && isReviewRequiredMaterialMetadata(row.metadata_json);
    if (row.status === "candidate" && !reviewRequired) continue;
    pushMaterialCandidate(candidates, {
      artifactId: row.artifact_id,
      binary,
      createdAt: row.created_at,
      generation: row.generation,
      metadataJson: row.metadata_json,
      path: row.local_path,
      reviewRequired,
      rowRank: index,
      sourceRank: 0,
    });
  }

  const materialRows = allRows<{
    artifact_id: string | null;
    created_at: string | null;
    generation: number | null;
    metadata_json: string | null;
    path: string | null;
    status: string | null;
  }>(
    db,
    `SELECT artifact_id, path, generation, created_at, status, metadata_json
     FROM job_materials_artifacts
     WHERE tenant_id = ?
       AND job_id = ?
       AND artifact_type IN (${placeholders})
       AND COALESCE(status, 'approved') IN ('approved', 'active', 'candidate')
       AND path IS NOT NULL
       AND path != ''
     ORDER BY COALESCE(generation, -1) DESC, COALESCE(created_at, '') DESC, artifact_id DESC, rowid DESC
     LIMIT 16`,
    [DEFAULT_TENANT, jobId, ...artifactTypes],
  );
  for (const [index, row] of materialRows.entries()) {
    const reviewRequired = row.status === "candidate" && isReviewRequiredMaterialMetadata(row.metadata_json);
    if (row.status === "candidate" && !reviewRequired) continue;
    pushMaterialCandidate(candidates, {
      artifactId: row.artifact_id,
      binary,
      createdAt: row.created_at,
      generation: row.generation,
      metadataJson: row.metadata_json,
      path: row.path,
      reviewRequired,
      rowRank: index,
      sourceRank: 1,
    });
  }

  const artifactRows = allRows<{
    created_at: string | null;
    path: string | null;
    artifact_id: string | number | null;
  }>(
    db,
    `SELECT artifact_id, path, created_at
     FROM job_artifacts
     WHERE tenant_id = ?
       AND job_id = ?
       AND artifact_type IN (${placeholders})
       AND COALESCE(status, 'active') NOT IN ('missing', 'failed', 'superseded', 'suppressed')
       AND path IS NOT NULL
       AND path != ''
     ORDER BY COALESCE(created_at, '') DESC, artifact_id DESC
     LIMIT 16`,
    [DEFAULT_TENANT, jobId, ...artifactTypes],
  );
  for (const [index, row] of artifactRows.entries()) {
    pushMaterialCandidate(candidates, {
      artifactId: row.artifact_id === null || row.artifact_id === undefined ? null : String(row.artifact_id),
      binary,
      createdAt: row.created_at,
      generation: null,
      metadataJson: null,
      path: row.path,
      reviewRequired: false,
      rowRank: index,
      sourceRank: 2,
    });
  }

  if (includeLegacyJobColumn) {
    const legacyRow = getRow<{ path: string | null }>(
      db,
      `SELECT ${includeLegacyJobColumn} AS path FROM jobs WHERE tenant_id = ? AND job_id = ?`,
      [DEFAULT_TENANT, jobId],
    );
    pushMaterialCandidate(candidates, {
      artifactId: null,
      binary,
      createdAt: "",
      generation: null,
      metadataJson: null,
      path: legacyRow?.path ?? null,
      reviewRequired: false,
      rowRank: 0,
      sourceRank: 3,
    });
  }

  return candidates.sort(compareMaterialCandidates);
}

function pushMaterialCandidate(
  candidates: MaterialArtifactCandidate[],
  input: {
    readonly artifactId: string | null | undefined;
    readonly binary: boolean;
    readonly createdAt: string | null | undefined;
    readonly generation: number | null | undefined;
    readonly metadataJson: string | null | undefined;
    readonly path: string | null | undefined;
    readonly reviewRequired?: boolean;
    readonly rowRank: number;
    readonly sourceRank: number;
  },
): void {
  const path = String(input.path ?? "").trim();
  if (!path || !artifactPathExists(path, { binary: input.binary })) {
    return;
  }
  candidates.push({
    artifactId: input.artifactId ? String(input.artifactId) : null,
    createdAt: String(input.createdAt ?? ""),
    generation: nullableNumber(input.generation),
    metadataJson: input.metadataJson ? String(input.metadataJson) : null,
    path,
    reviewRequired: Boolean(input.reviewRequired),
    rowRank: input.rowRank,
    sourceRank: input.sourceRank,
  });
}

function compareMaterialCandidates(a: MaterialArtifactCandidate, b: MaterialArtifactCandidate): number {
  const generation = (b.generation ?? -1) - (a.generation ?? -1);
  if (generation !== 0) return generation;
  const createdAt = b.createdAt.localeCompare(a.createdAt);
  if (createdAt !== 0) return createdAt;
  const source = a.sourceRank - b.sourceRank;
  if (source !== 0) return source;
  return a.rowRank - b.rowRank;
}

function artifactPathExists(artifactPath: string, { binary }: { readonly binary: boolean }): boolean {
  try {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
      return false;
    }
    return binary || !isBinaryPreviewPath(artifactPath);
  } catch {
    // Artifact files can disappear while the local projection still exists.
    // In that case the review UI should fall back to the next available source.
    return false;
  }
}

function isBinaryPreviewPath(artifactPath: string): boolean {
  return /\.(pdf|docx?|png|jpe?g|webp|gif|zip)$/i.test(artifactPath);
}

interface ReadTextOptions {
  readonly byteLimit?: number;
  readonly charLimit?: number | null;
}

function readTextPreview(artifactPath: string, options: ReadTextOptions = {}): string | null {
  let fd: number | null = null;
  try {
    const stats = fs.statSync(artifactPath);
    if (!stats.isFile()) {
      return null;
    }
    const byteCount = Math.min(stats.size, options.byteLimit ?? MATERIAL_PREVIEW_BYTE_LIMIT);
    if (byteCount <= 0) {
      return null;
    }
    const buffer = Buffer.alloc(byteCount);
    fd = fs.openSync(artifactPath, "r");
    const bytesRead = fs.readSync(fd, buffer, 0, byteCount, 0);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    if (!text.trim() || text.includes("\u0000")) {
      return null;
    }
    return options.charLimit === null ? previewText(text, text.length) : previewText(text, options.charLimit ?? MATERIAL_PREVIEW_CHAR_LIMIT);
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      fs.closeSync(fd);
    }
  }
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function previewText(value: string | null | undefined, limit: number): string {
  const text = String(value ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").trim();
  if (!text) {
    return "";
  }
  return text.length > limit ? `${text.slice(0, limit).trim()}...` : text;
}

function isReviewRequiredMaterialMetadata(value: string | null): boolean {
  let metadata: Record<string, unknown> | null;
  try { metadata = asRecord(JSON.parse(value ?? "null")); } catch { return false; }
  if (!metadata) return false;
  if (Boolean(recordValue(metadata, "reviewRequired", "review_required"))) return true;
  const fit = asRecord(recordValue(metadata, "postGenerationFit", "post_generation_fit"));
  const decision = asRecord(recordValue(fit, "revisionDecision", "revision_decision"));
  if (Boolean(recordValue(decision, "reviewBlocked", "review_blocked"))) return true;
  const fitScore = asRecord(recordValue(fit, "fitScore", "fit_score"));
  const blockers = recordValue(fitScore, "reviewBlockers", "review_blockers");
  return Array.isArray(blockers) && blockers.some(value => String(value ?? "").trim().length > 0);
}
function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function recordValue(record: Record<string, unknown> | null, camelKey: string, snakeKey: string): unknown {
  return record?.[camelKey] ?? record?.[snakeKey];
}
