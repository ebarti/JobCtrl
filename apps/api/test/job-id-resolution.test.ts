import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { resolveJobId } from "../src/write-model.js";

const LOCAL_JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const SHARED_POSTING_URL = "https://example.test/jobs/platform";

describe("canonical job identity resolution", () => {
  it("resolves an external locator once without crossing tenant boundaries", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE jobs (
        tenant_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        url TEXT NOT NULL,
        application_url TEXT,
        PRIMARY KEY (tenant_id, job_id)
      );
      CREATE TABLE job_locators (
        tenant_id TEXT NOT NULL,
        job_id TEXT NOT NULL,
        locator_kind TEXT NOT NULL,
        locator_value TEXT NOT NULL,
        is_current INTEGER NOT NULL DEFAULT 1,
        PRIMARY KEY (tenant_id, locator_kind, locator_value)
      );
    `);
    const insert = db.prepare(
      `INSERT INTO jobs (tenant_id, job_id, url, application_url)
       VALUES (?, ?, ?, ?)`,
    );
    insert.run("local", LOCAL_JOB_ID, SHARED_POSTING_URL, `${SHARED_POSTING_URL}/apply`);
    insert.run("other", OTHER_JOB_ID, SHARED_POSTING_URL, `${SHARED_POSTING_URL}/apply`);

    expect(resolveJobId(db, "local", LOCAL_JOB_ID)).toBe(LOCAL_JOB_ID);
    expect(resolveJobId(db, "local", SHARED_POSTING_URL)).toBe(LOCAL_JOB_ID);
    expect(resolveJobId(db, "local", `${SHARED_POSTING_URL}/apply`)).toBe(LOCAL_JOB_ID);
    expect(resolveJobId(db, "local", OTHER_JOB_ID)).toBeNull();
    expect(resolveJobId(db, "other", SHARED_POSTING_URL)).toBe(OTHER_JOB_ID);

    db.close();
  });
});
