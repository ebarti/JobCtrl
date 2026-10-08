import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  EMPLOYER_ANALYSIS_PROMPT_VERSION,
  InterviewPrepHistoryQuerySchema,
  InterviewPrepHistoryResponseSchema,
  InterviewPrepSchema,
  type InterviewCatalog,
  type InterviewGenerationContext,
  type InterviewPrep,
  type InterviewPrepHistoryQuery,
  type InterviewPrepHistoryResponse,
  type InterviewStaleReason,
} from "./contracts.js";
import type { SqliteDatabase } from "./db.js";

type PrepReader = (db: SqliteDatabase, tenantId: string, jobId: string, generation: number) => Record<string, unknown> | null;

/** Current preparation comes from accepted storage, independently of projection/history lag. */
export function loadLatestAcceptedInterviewPrep(
  db: SqliteDatabase, tenantId: string, jobId: string, loadPrep: PrepReader,
): InterviewPrep | null {
  return db.transaction(() => {
    const row = db.prepare("SELECT generation FROM job_interview_prep WHERE tenant_id=? AND job_id=? AND status='accepted' ORDER BY generation DESC LIMIT 1")
      .get(tenantId, jobId) as { generation: number } | undefined;
    return row ? InterviewPrepSchema.parse(loadPrep(db, tenantId, jobId, row.generation)) : null;
  })();
}

export function listInterviewPrepHistory(
  db: SqliteDatabase, tenantId: string, jobId: string, input: InterviewPrepHistoryQuery,
  catalog: InterviewCatalog | null, appDir: string, loadPrep: PrepReader,
): InterviewPrepHistoryResponse {
  const query = InterviewPrepHistoryQuerySchema.parse(input);
  return db.transaction(() => {
    const predicate = `tenant_id = ? AND job_id = ?${query.generation ? " AND generation = ?" : ""}`;
    const params = [tenantId, jobId, ...(query.generation ? [query.generation] : [])];
    const total = (db.prepare(`SELECT COUNT(*) AS count FROM job_interview_prep WHERE ${predicate}`).get(...params) as { count: number }).count;
    const rows = db.prepare(`SELECT generation FROM job_interview_prep WHERE ${predicate} ORDER BY generation DESC LIMIT ? OFFSET ?`)
      .all(...params, query.pageSize, (query.page - 1) * query.pageSize) as { generation: number }[];
    const generations = rows.map(({ generation }) => {
      const prep = InterviewPrepSchema.parse(loadPrep(db, tenantId, jobId, generation));
      return { ...prep, staleReasons: interviewPrepStaleReasons(db, tenantId, jobId, prep.generationContext ?? null, catalog, appDir) };
    });
    return InterviewPrepHistoryResponseSchema.parse({ ok: true, jobId, generations, page: query.page, pageSize: query.pageSize, total });
  })();
}

export function interviewPrepStaleReasons(
  db: SqliteDatabase, tenantId: string, jobId: string, context: InterviewGenerationContext | null,
  catalog: InterviewCatalog | null, _appDir: string,
): InterviewStaleReason[] {
  if (!context) return ["legacy_unbound"];
  const reasons: InterviewStaleReason[] = [];
  if (!catalog || catalog.catalogRevision !== context.catalogBinding.catalogRevision
    || catalog.catalogDigest !== context.catalogBinding.catalogDigest) reasons.push("catalog_changed");
  const profile = db.prepare("SELECT version FROM candidate_profiles WHERE tenant_id = ? AND profile_id = ?")
    .get(tenantId, context.profile.profileId) as { version: number } | undefined;
  if (profile?.version !== context.profile.version) reasons.push("profile_changed");
  const job = db.prepare(`SELECT job.title, job.company, job.description, enrichment.full_description
    FROM jobs AS job LEFT JOIN job_enrichments AS enrichment
      ON enrichment.tenant_id = job.tenant_id AND enrichment.job_id = job.job_id
    WHERE job.tenant_id = ? AND job.job_id = ?`).get(tenantId, jobId) as {
      title: string | null; company: string | null; description: string | null; full_description: string | null;
    } | undefined;
  const title = job?.title?.trim() ?? "";
  const description = (job?.full_description || job?.description || "").trim();
  const jobHash = createHash("sha256").update(title ? `${title}\n\n${description}` : description).digest("hex");
  if (!job || context.jobContext.jobId !== jobId || jobHash !== context.jobContext.snapshotHash
    || (job.company ?? "").trim() !== context.jobContext.company) reasons.push("job_changed");
  const analysis = db.prepare("SELECT generation, snapshot_hash FROM job_employer_analysis WHERE tenant_id = ? AND job_id = ? AND prompt_version = ? ORDER BY generation DESC LIMIT 1")
    .get(tenantId, jobId, EMPLOYER_ANALYSIS_PROMPT_VERSION) as { generation: number; snapshot_hash: string } | undefined;
  if ((analysis?.generation ?? null) !== (context.employerAnalysis?.generation ?? null)
    || (analysis?.snapshot_hash ?? null) !== (context.employerAnalysis?.snapshotHash ?? null)) reasons.push("employer_analysis_changed");
  const materials = currentApprovedMaterialBindings(db, tenantId, jobId);
  if (materials === null || JSON.stringify(materials) !== JSON.stringify(context.approvedMaterials)) reasons.push("approved_materials_changed");
  return reasons;
}

function currentApprovedMaterialBindings(db: SqliteDatabase, tenantId: string, jobId: string) {
  const row = db.prepare(`SELECT artifact_id, generation, path FROM job_materials_artifacts
    WHERE tenant_id = ? AND job_id = ? AND artifact_type = 'tailored_resume' AND status = 'approved'
    ORDER BY generation DESC LIMIT 1`).get(tenantId, jobId) as { artifact_id: string; generation: number; path: string } | undefined;
  if (!row) return [];
  let descriptor: number | undefined;
  try {
    if (!path.isAbsolute(row.path)) return null;
    // Match generation's registered absolute-path rule, including every parent.
    let cursor = path.parse(row.path).root;
    for (const component of row.path.slice(cursor.length).split(path.sep).filter(Boolean)) {
      cursor = path.join(cursor, component);
      if (fs.lstatSync(cursor).isSymbolicLink()) return null;
    }
    descriptor = fs.openSync(row.path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const buffer = Buffer.alloc(1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(descriptor, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > 1024 * 1024) return null;
    return [{ materialId: row.artifact_id, generation: row.generation,
      sha256: createHash("sha256").update(buffer.subarray(0, length)).digest("hex") }];
  } catch {
    return null;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
