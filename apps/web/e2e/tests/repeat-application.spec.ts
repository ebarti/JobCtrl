import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import {
  loadE2eDbPath,
  refreshE2eWorkerHeartbeat,
} from "../fixtures/e2e-state.js";

const TARGET = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const PRIOR = "https://alternate.example.test/gitlab/qa-platform-director";
const CANONICAL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director-canonical";
const CONFIRMED_AT = "2026-07-20T08:00:00.000Z";
type DatabaseRow = Record<string, unknown>;
type RepeatApplicationTable =
  | "application_repeat_overrides"
  | "application_repeat_override_consumptions"
  | "application_repeat_audit";

function repeatApplicationTablesExist(db: Database.Database): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("application_repeat_overrides"),
  );
}

function clearRepeatApplicationState(db: Database.Database): void {
  db.prepare(
    `DELETE FROM application_repeat_override_consumptions
      WHERE tenant_id = 'local'
        AND override_id IN (
          SELECT override_id
            FROM application_repeat_overrides
           WHERE tenant_id = 'local'
             AND target_job_id = (
               SELECT job_id FROM jobs
                WHERE tenant_id = 'local' AND url = ?
             )
        )`,
  ).run(TARGET);
  db.prepare(
    `DELETE FROM application_repeat_audit
      WHERE tenant_id = 'local'
        AND target_job_id = (
          SELECT job_id FROM jobs
           WHERE tenant_id = 'local' AND url = ?
        )`,
  ).run(TARGET);
  db.prepare(
    `DELETE FROM application_repeat_overrides
      WHERE tenant_id = 'local'
        AND target_job_id = (
          SELECT job_id FROM jobs
           WHERE tenant_id = 'local' AND url = ?
        )`,
  ).run(TARGET);
}

function restoreRows(
  db: Database.Database,
  table: RepeatApplicationTable,
  rows: readonly DatabaseRow[],
): void {
  for (const row of rows) {
    const columns = Object.keys(row);
    db.prepare(
      `INSERT INTO ${table} (${columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((column) => row[column]));
  }
}

test("repeat application block and reasoned override reach only the simulated submit boundary", async ({
  page,
  request,
}) => {
  const dbPath = loadE2eDbPath();
  const db = new Database(dbPath);
  const hadCanonicalIdentityTable = Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get("job_canonical_identities"),
  );
  db.exec(`
    CREATE TABLE IF NOT EXISTS job_canonical_identities (
      tenant_id TEXT NOT NULL DEFAULT 'local',
      job_id TEXT NOT NULL,
      canonical_url TEXT NOT NULL,
      ats_kind TEXT NOT NULL,
      source_native_id TEXT NOT NULL,
      confidence REAL NOT NULL,
      resolved_at TEXT NOT NULL,
      PRIMARY KEY (tenant_id, job_id),
      FOREIGN KEY (tenant_id, job_id)
        REFERENCES jobs(tenant_id, job_id) ON DELETE CASCADE
    )
  `);
  const originalIdentity = hadCanonicalIdentityTable
    ? (db
        .prepare(
          `SELECT c.*
             FROM job_canonical_identities c
             JOIN jobs j
               ON j.tenant_id = c.tenant_id
              AND j.job_id = c.job_id
            WHERE c.tenant_id = 'local' AND j.url = ?`,
        )
        .get(TARGET) as Record<string, unknown> | undefined)
    : undefined;
  const originalApplyStage = db
    .prepare("SELECT * FROM job_stage_states WHERE job_url = ? AND stage = 'apply'")
    .get(TARGET) as Record<string, unknown> | undefined;
  const hasRepeatApplicationTables = repeatApplicationTablesExist(db);
  const originalRepeatOverrides = hasRepeatApplicationTables
    ? (db
        .prepare(
          `SELECT *
             FROM application_repeat_overrides
            WHERE tenant_id = 'local'
              AND target_job_id = (
                SELECT job_id FROM jobs
                 WHERE tenant_id = 'local' AND url = ?
              )`,
        )
        .all(TARGET) as Array<Record<string, unknown>>)
    : [];
  const originalRepeatOverrideConsumptions = hasRepeatApplicationTables
    ? (db
        .prepare(
          `SELECT c.*
             FROM application_repeat_override_consumptions c
            JOIN application_repeat_overrides o
               ON o.tenant_id = c.tenant_id AND o.override_id = c.override_id
            WHERE o.tenant_id = 'local'
              AND o.target_job_id = (
                SELECT job_id FROM jobs
                 WHERE tenant_id = 'local' AND url = ?
              )`,
        )
        .all(TARGET) as Array<Record<string, unknown>>)
    : [];
  const originalRepeatAudit = hasRepeatApplicationTables
    ? (db
        .prepare(
          `SELECT *
             FROM application_repeat_audit
            WHERE tenant_id = 'local'
              AND target_job_id = (
                SELECT job_id FROM jobs
                 WHERE tenant_id = 'local' AND url = ?
              )`,
        )
        .all(TARGET) as Array<Record<string, unknown>>)
    : [];
  let originalTargetApplication: Record<string, unknown> | undefined;
  let targetJobId = "";
  let priorJobId = "";

  try {
    if (hasRepeatApplicationTables) clearRepeatApplicationState(db);
    const target = db.prepare("SELECT * FROM jobs WHERE url = ?").get(TARGET) as Record<
      string,
      unknown
    >;
    if (!target) throw new Error("QA target job is missing");
    targetJobId = String(target.job_id);
    originalTargetApplication = {
      apply_status: target.apply_status,
      applied_at: target.applied_at,
    };
    db.prepare("UPDATE jobs SET apply_status = 'applied', applied_at = ? WHERE url = ?").run(
      CONFIRMED_AT,
      TARGET,
    );
    const prior: Record<string, unknown> = {
      ...target,
      url: PRIOR,
      job_id: randomUUID(),
      application_url: `${PRIOR}/apply`,
      apply_status: "applied",
      applied_at: CONFIRMED_AT,
    };
    const columns = Object.keys(prior);
    db.prepare(
      `INSERT OR REPLACE INTO jobs (${columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((column) => prior[column]));
    priorJobId = String(prior.job_id);
    db.prepare(
      `INSERT INTO job_events
       (job_url, stage, event_type, level, message, occurred_at, payload_json)
       VALUES (?, 'apply', 'ApplicationSubmitted', 'info',
               'Simulated prior application confirmation', ?, ?)`,
    ).run(PRIOR, CONFIRMED_AT, JSON.stringify({ run_id: "e2e-prior-run" }));
    const targetProjection = db
      .prepare("SELECT * FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?")
      .get(TARGET) as Record<string, unknown> | undefined;
    if (targetProjection) {
      const priorProjection: Record<string, unknown> = {
        ...targetProjection,
        job_id: PRIOR,
      };
      const columns = Object.keys(priorProjection);
      db.prepare(
        `INSERT OR REPLACE INTO job_list_projections
         (${columns.map((column) => `"${column}"`).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => priorProjection[column]));
    }
    const identity = db.prepare(
      `INSERT OR REPLACE INTO job_canonical_identities
       (tenant_id, job_id, canonical_url, ats_kind, source_native_id, confidence, resolved_at)
       VALUES ('local', ?, ?, 'greenhouse', 'qa-platform-director', 1, ?)`,
    );
    identity.run(targetJobId, CANONICAL, CONFIRMED_AT);
    identity.run(priorJobId, CANONICAL, CONFIRMED_AT);

    await page.goto(`/apply-review?jobKey=${encodeURIComponent(TARGET)}`);
    await expect(page.getByText("Repeat application blocked", { exact: true })).toBeVisible();
    await expect(
      page.getByText("matching canonical ATS identity", { exact: true }),
    ).toBeVisible();
    const priorApplicationLink = page.getByRole("link", {
      name: `Inspect prior application: ${PRIOR}`,
    });
    await expect(priorApplicationLink).toHaveAttribute(
      "href",
      `/jobs/${encodeURIComponent(PRIOR)}`,
    );
    await expect(page.getByRole("button", { name: /Authorize live submit/i })).toBeDisabled();
    const trustedMutationHeaders = {
      origin: new URL(page.url()).origin,
      "sec-fetch-site": "same-origin",
    };

    const blocked = await request.post(
      `/v1/jobs/${encodeURIComponent(TARGET)}/actions/apply`,
      { data: { dryRun: false }, headers: trustedMutationHeaders },
    );
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "repeat_application_blocked" });

    await page.getByLabel("Reason for another live attempt").fill(
      "The prior application was withdrawn before review; this retry is intentional.",
    );
    await page.getByRole("radio", { name: `Confirm prior application: ${PRIOR}` }).check();
    await page.getByRole("button", { name: "Confirm one live attempt" }).click();
    await expect(
      page.getByText("Repeat application confirmation recorded", { exact: true }),
    ).toBeVisible();
    await page.getByText("Recorded confirmation", { exact: true }).click();
    await expect(
      page.getByText(
        "The prior application was withdrawn before review; this retry is intentional.",
        { exact: true },
      ),
    ).toBeVisible();

    // The accepted live-submit path enforces the real worker-readiness gate.
    // Renew this test-owned fixture because the serial E2E suite can outlive
    // the seeded heartbeat's freshness window before reaching this request.
    refreshE2eWorkerHeartbeat();
    const acceptedBySimulation = await request.post(
      `/v1/jobs/${encodeURIComponent(TARGET)}/actions/apply`,
      { data: { dryRun: false }, headers: trustedMutationHeaders },
    );
    expect(acceptedBySimulation.status()).toBe(202);
    expect(await acceptedBySimulation.json()).toMatchObject({ status: "queued" });

    const repositoryRoot = path.resolve(process.cwd(), "../..");
    const pythonExecutable = path.join(
      repositoryRoot,
      "workers/automation/.venv/bin/python",
    );
    const workerSource = path.join(repositoryRoot, "workers/automation/src");
    const workerClaimScript = `
import sys
from jobctrl.apply.launcher import acquire_job
from jobctrl.database import get_connection, init_db
from jobctrl.state import set_stage_state

target = sys.argv[1]
init_db()
run_ctx = {
    "dry_run": False,
    "run_id": "e2e-worker-repeat-claim",
    "workflow_id": "e2e-repeat-application",
}
job = acquire_job(
    target_url=target,
    worker_id=91,
    run_ctx=run_ctx,
    approval_required=False,
)
if job is None:
    raise SystemExit("authoritative worker claim was refused unexpectedly")
conn = get_connection()
set_stage_state(conn, target, "apply", "pending", validate_transition=False)
conn.commit()
print(job["url"])
`;
    const workerOutput = execFileSync(
      pythonExecutable,
      ["-c", workerClaimScript, TARGET],
      {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: {
          ...process.env,
          JOBCTRL_DIR: path.dirname(dbPath),
          PYTHONPATH: workerSource,
        },
      },
    );
    expect(workerOutput.trim()).toBe(TARGET);

    await page.reload();
    await expect(page.getByText("Review prior application before live submit", { exact: true })).toBeVisible();
    await expect(page.getByText(/already used; another live attempt requires/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Authorize live submit/i })).toBeDisabled();

    const refusedAfterConsumption = await request.post(
      `/v1/jobs/${encodeURIComponent(TARGET)}/actions/apply`,
      { data: { dryRun: false }, headers: trustedMutationHeaders },
    );
    expect(refusedAfterConsumption.status()).toBe(409);
    expect(await refusedAfterConsumption.json()).toMatchObject({
      error: "repeat_application_override_consumed",
    });

    const override = db
      .prepare(
        `SELECT overrides.override_id,
                target_jobs.url AS target_job_key,
                prior_jobs.url AS prior_job_key,
                overrides.evidence_fingerprint,
                overrides.reason,
                overrides.confirmed_by,
                overrides.confirmed_at
           FROM application_repeat_overrides AS overrides
           JOIN jobs AS target_jobs
             ON target_jobs.tenant_id = overrides.tenant_id
            AND target_jobs.job_id = overrides.target_job_id
           JOIN jobs AS prior_jobs
             ON prior_jobs.tenant_id = overrides.tenant_id
            AND prior_jobs.job_id = overrides.prior_job_id
          WHERE overrides.tenant_id = 'local'
            AND overrides.target_job_id = (
              SELECT job_id FROM jobs
               WHERE tenant_id = 'local' AND url = ?
            )
          ORDER BY confirmed_at DESC LIMIT 1`,
      )
      .get(TARGET) as Record<string, unknown>;
    expect(override).toMatchObject({
      target_job_key: TARGET,
      prior_job_key: PRIOR,
      confirmed_by: "user",
    });
    expect(String(override.reason)).toContain("withdrawn before review");
    const auditRows = db
      .prepare(
        `SELECT action, evidence_fingerprint, override_id
           FROM application_repeat_audit
          WHERE tenant_id = 'local'
            AND target_job_id = (
              SELECT job_id FROM jobs
               WHERE tenant_id = 'local' AND url = ?
            )
            AND evidence_fingerprint = ?
            AND action IN ('blocked', 'override_recorded', 'override_consumed')
          ORDER BY CASE action
            WHEN 'blocked' THEN 1
            WHEN 'override_recorded' THEN 2
            WHEN 'override_consumed' THEN 3
          END`,
      )
      .all(TARGET, override.evidence_fingerprint) as Array<Record<string, unknown>>;
    expect(auditRows).toEqual([
      {
        action: "blocked",
        evidence_fingerprint: override.evidence_fingerprint,
        override_id: null,
      },
      {
        action: "override_recorded",
        evidence_fingerprint: override.evidence_fingerprint,
        override_id: override.override_id,
      },
      {
        action: "override_consumed",
        evidence_fingerprint: override.evidence_fingerprint,
        override_id: override.override_id,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT c.run_id, a.action, a.evidence_json
             FROM application_repeat_override_consumptions c
             JOIN application_repeat_audit a
               ON a.override_id = c.override_id AND a.action = 'override_consumed'
            WHERE c.override_id = ?`,
        )
        .get(override.override_id),
    ).toMatchObject({
      run_id: "e2e-worker-repeat-claim",
      action: "override_consumed",
    });
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM job_events
            WHERE job_url = ? AND event_type = 'ApplicationSubmitted'`,
        )
        .get(TARGET),
    ).toMatchObject({ count: 0 });
  } finally {
    db.prepare(
      "DELETE FROM job_events WHERE job_url = ? AND payload_json LIKE '%e2e-worker-repeat-claim%'",
    ).run(TARGET);
    db.prepare("DELETE FROM job_stage_states WHERE job_url = ? AND stage = 'apply'").run(TARGET);
    if (originalApplyStage) {
      const columns = Object.keys(originalApplyStage);
      db.prepare(
        `INSERT INTO job_stage_states (${columns.map((column) => `"${column}"`).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => originalApplyStage[column]));
    }
    if (repeatApplicationTablesExist(db)) {
      clearRepeatApplicationState(db);
      restoreRows(db, "application_repeat_overrides", originalRepeatOverrides);
      restoreRows(
        db,
        "application_repeat_override_consumptions",
        originalRepeatOverrideConsumptions,
      );
      restoreRows(db, "application_repeat_audit", originalRepeatAudit);
    }
    db.prepare(
      "DELETE FROM job_canonical_identities WHERE tenant_id = 'local' AND job_id IN (?, ?)",
    ).run(targetJobId, priorJobId);
    if (originalIdentity) {
      const columns = Object.keys(originalIdentity);
      db.prepare(
        `INSERT INTO job_canonical_identities (${columns.map((column) => `"${column}"`).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => originalIdentity[column]));
    }
    if (!hadCanonicalIdentityTable) {
      db.exec("DROP TABLE job_canonical_identities");
    }
    db.prepare("DELETE FROM job_events WHERE job_url = ?").run(PRIOR);
    db.prepare("DELETE FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?").run(
      PRIOR,
    );
    db.prepare("DELETE FROM jobs WHERE url = ?").run(PRIOR);
    if (originalTargetApplication) {
      db.prepare("UPDATE jobs SET apply_status = ?, applied_at = ? WHERE url = ?").run(
        originalTargetApplication.apply_status,
        originalTargetApplication.applied_at,
        TARGET,
      );
    }
    db.close();
  }
});
