import type Database from "better-sqlite3";

/** Seed a target without claiming successful enrichment. */
export function seedApplicationUrl(db: Database.Database, tenantId: string, jobId: string, applicationUrl: string | null): void {
  db.prepare(`INSERT INTO job_enrichments (tenant_id, job_id, current_status, application_url, updated_at)
    VALUES (?, ?, 'pending', ?, '2026-08-01T00:00:00Z')
    ON CONFLICT (tenant_id, job_id) DO UPDATE SET application_url = excluded.application_url`).run(
    tenantId, jobId, applicationUrl,
  );
}
