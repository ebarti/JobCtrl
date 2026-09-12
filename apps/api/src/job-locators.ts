import type { SqliteDatabase } from "./db.js";

export type LocatedJob = { jobId: string; jobUrl: string };

/** Posting identity wins; a shared application endpoint cannot select a job. */
export function resolveJobLocator(db: SqliteDatabase, tenantId: string, locator: string): LocatedJob | null {
  const posting = db.prepare(`
    SELECT job_id, url FROM jobs j
    WHERE tenant_id = ? AND (job_id = ? OR url = ? OR EXISTS (
      SELECT 1 FROM job_locators l WHERE l.tenant_id = j.tenant_id
        AND l.job_id = j.job_id AND l.locator_value = ?
    )) LIMIT 2
  `).all(tenantId, locator, locator, locator) as Array<{ job_id: string; url: string }>;
  if (posting.length > 0) return uniqueJob(posting);
  const application = db.prepare(`
    SELECT job_id, url FROM jobs j
    WHERE tenant_id = ? AND (EXISTS (
      SELECT 1 FROM job_enrichments e WHERE e.tenant_id = j.tenant_id
        AND e.job_id = j.job_id AND e.application_url = ?
    ) OR EXISTS (
      SELECT 1 FROM job_application_locators l WHERE l.tenant_id = j.tenant_id
        AND l.job_id = j.job_id AND l.application_url = ?
    )) LIMIT 2
  `).all(tenantId, locator, locator) as Array<{ job_id: string; url: string }>;
  return uniqueJob(application);
}

function uniqueJob(rows: Array<{ job_id: string; url: string }>): LocatedJob | null {
  return rows.length === 1 ? { jobId: rows[0]!.job_id, jobUrl: rows[0]!.url } : null;
}
