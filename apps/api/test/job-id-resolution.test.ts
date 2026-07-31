import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

import { resolveJobId } from "../src/write-model.js";
import { initializeExactV7Database } from "./v7-schema.js";

const LOCAL_JOB_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_JOB_ID = "22222222-2222-4222-8222-222222222222";
const SHARED_POSTING_URL = "https://example.test/jobs/platform";

describe("canonical job identity resolution", () => {
  it("resolves an external locator once without crossing tenant boundaries", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-job-id-resolution-"));
    const dbPath = path.join(directory, "jobctrl.db");
    initializeExactV7Database(dbPath);
    const db = new Database(dbPath);
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
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
