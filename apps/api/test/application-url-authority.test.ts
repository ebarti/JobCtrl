import fs from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { refreshProjections } from "../src/projections.js";
import { resolveJobId } from "../src/write-model.js";
import { EXACT_V10_SCHEMA_MANIFEST, schemaManifest } from "../src/schema-manifest.js";

const fixture = JSON.parse(fs.readFileSync(new URL(
  "../../../packages/domain-types/test/fixtures/application_url_authority.json", import.meta.url,
), "utf8")) as { cases: Array<{
  name: string; jobId: string; legacy: string | null;
  enrichment: { applicationUrl: string | null; status: string } | null; expected: string | null;
}> };

function sql(version: number): string {
  return fs.readFileSync(new URL(
    `../../../workers/automation/src/jobctrl/infrastructure/migrations/schema_v${version}.sql`, import.meta.url,
  ), "utf8");
}

function migratedDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  for (const version of [7, 8, 9]) db.exec(sql(version));
  for (const tenant of ["local", "other"]) {
    for (const row of fixture.cases) {
      db.prepare(`INSERT INTO jobs (tenant_id, job_id, url, application_url, title, discovered_at)
        VALUES (?, ?, ?, ?, ?, '2026-08-01T00:00:00Z')`).run(
        tenant, row.jobId, `https://jobs.example.test/${row.name}`, row.legacy, row.name,
      );
      if (row.enrichment) db.prepare(`INSERT INTO job_enrichments (
        tenant_id, job_id, current_status, application_url, updated_at
      ) VALUES (?, ?, ?, ?, '2026-08-01T00:00:00Z')`).run(
        tenant, row.jobId, row.enrichment.status, row.enrichment.applicationUrl,
      );
    }
  }
  // Existing exact-v9 projections may already have consumed every event.
  db.prepare(`INSERT INTO job_list_projections (tenant_id, job_id, application_url)
    VALUES ('local', ?, '')`).run(fixture.cases[2]!.jobId);
  db.exec(sql(10));
  db.pragma("user_version = 10");
  return db;
}

describe("canonical application URL authority", () => {
  it("matches the Python migration/projection fixture and never projects lookup aliases", () => {
    const db = migratedDatabase();
    try {
      expect(schemaManifest(db, 10)).toEqual(EXACT_V10_SCHEMA_MANIFEST);
      refreshProjections(db, "local");
      expect(db.prepare("SELECT COUNT(*) AS n FROM job_list_projections WHERE tenant_id = 'other'").get()).toEqual({ n: 0 });
      for (const row of fixture.cases) {
        expect(db.prepare("SELECT application_url FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?").get(row.jobId))
          .toEqual({ application_url: row.expected });
        for (const url of [row.legacy, row.enrichment?.applicationUrl].filter(Boolean)) {
          expect(resolveJobId(db, "local", url!)).toBe(row.jobId);
          expect(resolveJobId(db, "other", url!)).toBe(row.jobId);
        }
      }
      const conflict = fixture.cases[1]!;
      db.prepare("UPDATE job_enrichments SET application_url = NULL WHERE tenant_id = 'local' AND job_id = ?").run(conflict.jobId);
      refreshProjections(db, "local");
      expect(db.prepare("SELECT application_url FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?").get(conflict.jobId))
        .toEqual({ application_url: null });
      expect(resolveJobId(db, "local", conflict.legacy!)).toBe(conflict.jobId);
      const settled = db.prepare("SELECT total_changes() AS changes").get();
      refreshProjections(db, "local");
      expect(db.prepare("SELECT total_changes() AS changes").get()).toEqual(settled);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });

  it("refuses shared application endpoints and gives posting identity priority", () => {
    const db = migratedDatabase();
    try {
      const first = fixture.cases[0]!;
      const second = fixture.cases[1]!;
      const shared = "https://apply.example.test/shared";
      const insert = db.prepare("INSERT INTO job_application_locators VALUES (?, ?, ?)");
      insert.run("local", first.jobId, shared);
      insert.run("local", second.jobId, shared);
      insert.run("other", first.jobId, shared);
      expect(resolveJobId(db, "local", shared)).toBeNull();
      expect(resolveJobId(db, "other", shared)).toBe(first.jobId);
      insert.run("local", second.jobId, `https://jobs.example.test/${first.name}`);
      expect(resolveJobId(db, "local", `https://jobs.example.test/${first.name}`)).toBe(first.jobId);
      db.prepare("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?").run(first.jobId);
      expect(resolveJobId(db, "local", shared)).toBe(second.jobId);
      expect(resolveJobId(db, "other", shared)).toBe(first.jobId);
      expect(db.pragma("foreign_key_check")).toEqual([]);
    } finally { db.close(); }
  });
});
