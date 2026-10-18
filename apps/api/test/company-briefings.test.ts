import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { readCompanyBriefing, companyBriefingSummaries } from "../src/company-briefings.js";
import { buildApp } from "../src/server.js";

const root = path.resolve(fileURLToPath(new URL("../../..", import.meta.url)));
const job = "90000000-0000-4000-8000-000000000021";
const second = "90000000-0000-4000-8000-000000000022";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true }); });

// The real Python writer produces both the accepted snapshot and its determination.
// Only public transport and model decisions are synthetic. No recorded-output replay.
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "jobctrl-company-briefing-"));
  directories.push(directory);
  const dbPath = path.join(directory, "jobctrl.db");
  const result = spawnSync(process.env["JOBCTRL_MIGRATION_TEST_PYTHON"] ?? path.join(root, "workers/automation/.venv/bin/python"), [path.join(root, "workers/automation/tests/company_briefing_fixture.py"), dbPath], {
    cwd: root, encoding: "utf8", env: { ...process.env, JOBCTRL_DIR: directory, LANGFUSE_DISABLE: "1", PYTHONPATH: path.join(root, "workers/automation/src") },
  });
  expect(result.status, result.stderr).toBe(0);
  return { directory, dbPath, python: JSON.parse(result.stdout) };
}

describe("company briefings from the canonical writer", () => {
  it("joins the same accepted snapshot across jobs and digest, with Python/TS stale-state parity", async () => {
    const { dbPath, directory, python } = fixture();
    const db = new Database(dbPath);
    const before = db.prepare("SELECT count(*) AS n FROM job_events").get();
    const view = readCompanyBriefing(db, "local", job);
    expect(view).toEqual(python);
    expect(readCompanyBriefing(db, "local", second)?.accepted).toEqual(view?.accepted);
    expect(view?.staleReasons).toEqual(["sources_older_than_seven_days"]);
    expect(companyBriefingSummaries(db, "local")).toHaveLength(1);
    expect(readCompanyBriefing(db, "another-tenant", job)).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM job_events").get()).toEqual(before);
    db.close();
    const app = buildApp({ dbPath, configPath: path.join(directory, "config.json"), appDir: directory });
    try {
      const detail = await app.inject({ method: "GET", url: `/v1/jobs/${job}` });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json().companyBriefing).toEqual(view);
      const digest = await app.inject({ method: "GET", url: "/v1/digest" });
      expect(digest.statusCode, digest.body).toBe(200);
      expect(digest.json().companyBriefings[0].status).toBe("stale");
    } finally { await app.close(); }
  });

  it("retains accepted context after failure, requires identity review, and rejects corrupted citation bindings", () => {
    const { dbPath } = fixture();
    const db = new Database(dbPath);
    try {
      const before = readCompanyBriefing(db, "local", job)!;
      const companyId = before.company!.companyId;
      db.prepare("INSERT INTO job_events(tenant_id,identity_version,event_type,occurred_at,payload_json,entity_kind,entity_ref) VALUES('local',1,'CompanyBriefingRecorded',?,?, 'company_briefing_attempt',?)")
        .run(new Date().toISOString(), JSON.stringify({ startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), failureCode: "provider_error" }), companyId);
      expect(readCompanyBriefing(db, "local", job)?.accepted).toEqual(before.accepted);
      expect(readCompanyBriefing(db, "local", job)?.lastAttempt?.failureCode).toBe("provider_error");
      db.prepare("UPDATE jobs SET company='Different employer' WHERE job_id=?").run(job);
      expect(readCompanyBriefing(db, "local", job)?.status).toBe("needs_review");
      const accepted = { ...before.accepted!, sources: [{ ...before.accepted!.sources[0], text: "corrupted" }] };
      const { revision: _revision, ...payload } = accepted;
      db.prepare("UPDATE job_events SET payload_json=? WHERE entity_kind='company_briefing_accepted'").run(JSON.stringify(payload));
      expect(readCompanyBriefing(db, "local", second)?.status).toBe("unavailable");
    } finally { db.close(); }
  });
});
