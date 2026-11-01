import crypto from "node:crypto";
import fs from "node:fs";
import { allRows, getRow, type SqliteDatabase } from "./db.js";

// Fixed-position arrays encoded as compact UTF-8 JSON are shared with the
// worker. Only fingerprints enter the decision event, never message/file bytes.
export function emailCandidateSha256(candidate: {
  recipient: string; subject: string; body: string;
  attachmentArtifactId: string; attachmentName: string;
}): string {
  return digest([
    candidate.recipient, candidate.subject, candidate.body,
    candidate.attachmentArtifactId, candidate.attachmentName,
  ]);
}

export function emailApprovalBinding(
  db: SqliteDatabase,
  jobId: string,
  candidate: Parameters<typeof emailCandidateSha256>[0],
  options: { allowUnmatchedAttachment?: boolean } = {},
) {
  const inputs = getRow<{
    url: string; title: string | null; site: string | null;
    description: string | null; full_description: string | null;
  }>(db, `SELECT j.url,j.title,j.site,j.description,e.full_description FROM jobs j
    LEFT JOIN job_enrichments e ON e.tenant_id=j.tenant_id AND e.job_id=j.job_id
    WHERE j.tenant_id='local' AND j.job_id=?`, [jobId]);
  if (!inputs) return null;
  const artifacts = allRows<{
    generation: number; artifact_type: string; artifact_id: string;
    path: string; metadata_json: string | null;
  }>(db, `SELECT generation,artifact_type,artifact_id,path,metadata_json
    FROM job_materials_artifacts WHERE tenant_id='local' AND job_id=?
      AND status='approved' AND superseded_at IS NULL
    ORDER BY generation,artifact_type,artifact_id`, [jobId]);
  const rows = artifacts.map(row => [
    row.generation, row.artifact_type, row.artifact_id, row.path,
    row.metadata_json, fileSha256(row.path),
  ]);
  // A missing accepted file cannot become authority for a future replacement.
  if (!rows.length || rows.some(row => row[5] === null) ||
    (!options.allowUnmatchedAttachment && !artifacts.some(row =>
      row.artifact_id === candidate.attachmentArtifactId &&
      ["resume_pdf", "tailored_resume_pdf"].includes(row.artifact_type)))) return null;
  return {
    version: 1,
    candidateSha256: emailCandidateSha256(candidate),
    materialsSha256: digest(rows),
    postingUrlSha256: digest([inputs.url]),
    postingInputsSha256: digest([inputs.title, inputs.site, inputs.description, inputs.full_description]),
  };
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

function fileSha256(filename: string): string | null {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(filename, "r");
    const digest = crypto.createHash("sha256");
    const buffer = Buffer.alloc(1024 * 1024);
    let size = 0;
    let count: number;
    while ((count = fs.readSync(descriptor, buffer)) > 0) {
      digest.update(buffer.subarray(0, count));
      size += count;
    }
    return size ? digest.digest("hex") : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
