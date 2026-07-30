import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import {
  permanentlyDeleteJob,
  restoreJob,
  softDeleteJob,
} from "../src/write-model.js";

const JOB_URL = "https://example.test/jobs/platform";
const JOB_ID = "22222222-2222-4222-8222-222222222222";

function createV29Database(
  foreignKeys: "ON" | "OFF",
): Database.Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE jobs (
      url TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      application_url TEXT,
      UNIQUE (tenant_id, job_id)
    );
    INSERT INTO jobs (
      url, tenant_id, job_id, application_url
    ) VALUES (
      '${JOB_URL}', 'local', '${JOB_ID}', '${JOB_URL}'
    );
    PRAGMA user_version = 29;
    PRAGMA foreign_keys = ${foreignKeys};
  `);
  return db;
}

describe("schema-v29 soft-delete tombstones", () => {
  it.each(["ON", "OFF"] as const)(
    "permanent delete explicitly purges the stable tombstone with foreign keys %s",
    (foreignKeys) => {
      const db = createV29Database(foreignKeys);

      expect(
        softDeleteJob(db, JOB_URL, {
          reason: "not relevant",
        }),
      ).toMatchObject({
        ok: true,
        count: 1,
        jobKeys: [JOB_URL],
      });
      expect(
        db.prepare(
          `SELECT tenant_id, job_id, reason
           FROM jobctrl_deleted_jobs`,
        ).get(),
      ).toMatchObject({
        tenant_id: "local",
        job_id: JOB_ID,
        reason: "not relevant",
      });

      expect(
        permanentlyDeleteJob(db, JOB_URL),
      ).toMatchObject({
        ok: true,
        count: 1,
        jobKeys: [JOB_URL],
      });
      expect(
        db.prepare(
          "SELECT COUNT(*) AS count FROM jobctrl_deleted_jobs",
        ).get(),
      ).toMatchObject({ count: 0 });
      expect(
        db.prepare(
          "SELECT COUNT(*) AS count FROM jobs",
        ).get(),
      ).toMatchObject({ count: 0 });

      db.close();
    },
  );

  it("fails closed instead of writing into a URL-era table stamped as v29", () => {
    const db = createV29Database("ON");
    db.exec(`
      CREATE TABLE jobctrl_deleted_jobs (
        job_url TEXT PRIMARY KEY,
        deleted_at TEXT NOT NULL,
        reason TEXT,
        restored_at TEXT
      );
    `);

    expect(() => softDeleteJob(db, JOB_URL)).toThrow(
      /requires stable soft-delete tombstone JobId references/,
    );
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM jobctrl_deleted_jobs",
      ).get(),
    ).toMatchObject({ count: 0 });

    db.close();
  });

  it("keeps URL semantics when a UUID-shaped posting alias equals another JobId", () => {
    const collidingAlias = "33333333-3333-4333-8333-333333333333";
    const otherUrl = "https://example.test/jobs/other";
    const db = createV29Database("ON");
    db.exec(`
      CREATE TABLE job_identity_aliases (
        tenant_id TEXT NOT NULL,
        alias_kind TEXT NOT NULL,
        alias_value TEXT NOT NULL,
        job_id TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, alias_kind, alias_value),
        FOREIGN KEY (tenant_id, job_id)
          REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
      );
    `);
    db.prepare(
      `INSERT INTO jobs (url, tenant_id, job_id, application_url)
       VALUES (?, 'local', ?, ?)`,
    ).run(otherUrl, collidingAlias, otherUrl);
    db.prepare(
      `INSERT INTO job_identity_aliases (
         tenant_id, alias_kind, alias_value, job_id, created_at
       ) VALUES ('local', 'posting_url', ?, ?, ?)`,
    ).run(
      collidingAlias,
      JOB_ID,
      "2026-07-30T10:00:00+00:00",
    );

    expect(softDeleteJob(db, collidingAlias)).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [JOB_URL],
    });
    expect(
      db.prepare(
        "SELECT job_id FROM jobctrl_deleted_jobs",
      ).get(),
    ).toMatchObject({ job_id: JOB_ID });

    expect(restoreJob(db, collidingAlias)).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [JOB_URL],
    });
    expect(softDeleteJob(db, collidingAlias).count).toBe(1);
    expect(permanentlyDeleteJob(db, collidingAlias)).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [JOB_URL],
    });
    expect(
      db.prepare(
        "SELECT url FROM jobs WHERE tenant_id = 'local' AND job_id = ?",
      ).get(collidingAlias),
    ).toMatchObject({ url: otherUrl });

    db.close();
  });
});
