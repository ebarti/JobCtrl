import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { jobReferencePredicateForUrl } from "../src/db.js";
import { permanentlyDeleteJob } from "../src/write-model.js";

describe("schema-v14 artifact-registry writes", () => {
  it("deletes only the URL owner's stable artifact registrations", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.pragma("user_version = 14");
    db.exec(`
      CREATE TABLE jobs (
        url TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_id TEXT NOT NULL,
        application_url TEXT,
        apply_status TEXT,
        apply_error TEXT,
        applied_at TEXT,
        UNIQUE (tenant_id, job_id)
      );
      CREATE TABLE job_artifacts (
        artifact_id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL DEFAULT 'local',
        job_id TEXT NOT NULL,
        stage TEXT NOT NULL,
        artifact_type TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'candidate',
        path TEXT NOT NULL,
        created_at TEXT NOT NULL,
        size_bytes INTEGER,
        metadata_json TEXT,
        FOREIGN KEY (tenant_id, job_id)
          REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
      );
      CREATE UNIQUE INDEX idx_job_artifacts_registry_key
        ON job_artifacts(
          tenant_id, job_id, stage, artifact_type, path
        );
    `);

    const uuidShapedUrl = "11111111-1111-4111-8111-111111111111";
    const urlOwnerJobId = "22222222-2222-4222-8222-222222222222";
    const idTextOwnerUrl = "https://example.com/jobs/id-text-owner";
    db.prepare(
      `INSERT INTO jobs (url, tenant_id, job_id)
       VALUES (?, 'local', ?), (?, 'local', ?)`,
    ).run(
      uuidShapedUrl,
      urlOwnerJobId,
      idTextOwnerUrl,
      uuidShapedUrl,
    );
    db.prepare(
      `INSERT INTO job_artifacts (
         tenant_id, job_id, stage, artifact_type, status, path, created_at
       ) VALUES
         ('local', ?, 'apply', 'apply_log', 'active', '/tmp/url-owner.log',
          '2026-07-29T10:00:00.000Z'),
         ('local', ?, 'apply', 'apply_log', 'active', '/tmp/id-owner.log',
          '2026-07-29T10:00:00.000Z')`,
    ).run(urlOwnerJobId, uuidShapedUrl);

    expect(
      jobReferencePredicateForUrl(db, "job_artifacts", uuidShapedUrl),
    ).toEqual({
      sql: "tenant_id = ? AND job_id = ?",
      params: ["local", urlOwnerJobId],
    });

    expect(permanentlyDeleteJob(db, uuidShapedUrl)).toEqual({
      ok: true,
      count: 1,
      jobKeys: [uuidShapedUrl],
    });
    expect(
      db.prepare("SELECT url FROM jobs ORDER BY url").all(),
    ).toEqual([{ url: idTextOwnerUrl }]);
    expect(
      db.prepare(
        "SELECT job_id, path FROM job_artifacts ORDER BY path",
      ).all(),
    ).toEqual([
      {
        job_id: uuidShapedUrl,
        path: "/tmp/id-owner.log",
      },
    ]);

    db.close();
  });
});
