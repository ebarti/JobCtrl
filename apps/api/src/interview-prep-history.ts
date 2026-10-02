import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  InterviewPrepHistoryQuerySchema,
  InterviewPrepHistoryResponseSchema,
  InterviewPrepSchema,
  type InterviewCatalog,
  type InterviewGenerationContext,
  type InterviewPrepHistoryQuery,
  type InterviewPrepHistoryResponse,
  type InterviewStaleReason,
} from "./contracts.js";
import type { SqliteDatabase } from "./db.js";

type PrepReader = (db: SqliteDatabase, tenantId: string, jobId: string, generation: number) => Record<string, unknown> | null;

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
  catalog: InterviewCatalog | null, appDir: string,
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
    || (job.company ?? "").slice(0, 500) !== context.jobContext.company) reasons.push("job_changed");
  const analysis = db.prepare("SELECT generation, snapshot_hash FROM job_employer_analysis WHERE tenant_id = ? AND job_id = ? ORDER BY generation DESC LIMIT 1")
    .get(tenantId, jobId) as { generation: number; snapshot_hash: string } | undefined;
  if ((analysis?.generation ?? null) !== (context.employerAnalysis?.generation ?? null)
    || (analysis?.snapshot_hash ?? null) !== (context.employerAnalysis?.snapshotHash ?? null)) reasons.push("employer_analysis_changed");
  const materials = currentApprovedMaterialBindings(db, tenantId, jobId, appDir);
  if (materials === null || JSON.stringify(materials) !== JSON.stringify(context.approvedMaterials)) reasons.push("approved_materials_changed");
  return reasons;
}

function currentApprovedMaterialBindings(db: SqliteDatabase, tenantId: string, jobId: string, appDir: string) {
  const row = db.prepare(`SELECT artifact_id, generation, path FROM job_materials_artifacts
    WHERE tenant_id = ? AND job_id = ? AND artifact_type = 'tailored_resume' AND status = 'approved'
    ORDER BY generation DESC LIMIT 1`).get(tenantId, jobId) as { artifact_id: string; generation: number; path: string } | undefined;
  if (!row) return [];
  try {
    const root = fs.realpathSync(appDir);
    const artifactPath = fs.realpathSync(path.isAbsolute(row.path) ? row.path : path.join(root, row.path));
    const relative = path.relative(root, artifactPath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
    const stat = fs.statSync(artifactPath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null;
    const raw = fs.readFileSync(artifactPath);
    if (raw.length > 1024 * 1024) return null;
    return [{ materialId: row.artifact_id, generation: row.generation, sha256: createHash("sha256").update(raw).digest("hex") }];
  } catch {
    return null;
  }
}
