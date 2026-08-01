import { execFileSync } from "node:child_process";
import path from "node:path";

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import {
  loadE2eDbPath,
  QA_PLATFORM_JOB_ID,
  refreshE2eWorkerHeartbeat,
} from "../fixtures/e2e-state.js";

const TARGET = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director";
const PRIOR = "https://alternate.example.test/gitlab/qa-platform-director";
const CANONICAL = "https://boards.greenhouse.io/gitlab/jobs/qa-platform-director-canonical";
const TARGET_JOB_ID = QA_PLATFORM_JOB_ID;
const PRIOR_JOB_ID = "10000000-0000-4000-8000-000000000045";
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
    "DELETE FROM application_repeat_override_consumptions WHERE override_id IN (SELECT override_id FROM application_repeat_overrides WHERE target_job_id = ?)",
  ).run(TARGET_JOB_ID);
  db.prepare("DELETE FROM application_repeat_audit WHERE target_job_id = ?").run(TARGET_JOB_ID);
  db.prepare("DELETE FROM application_repeat_overrides WHERE target_job_id = ?").run(TARGET_JOB_ID);
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
  const originalIdentity = db
    .prepare(
      "SELECT * FROM job_canonical_identities WHERE tenant_id = 'local' AND job_id = ?",
    )
    .get(TARGET_JOB_ID) as Record<string, unknown> | undefined;
  const originalApplyStage = db
    .prepare("SELECT * FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'apply'")
    .get(TARGET_JOB_ID) as Record<string, unknown> | undefined;
  const hasRepeatApplicationTables = repeatApplicationTablesExist(db);
  const originalRepeatOverrides = hasRepeatApplicationTables
    ? (db
        .prepare(
          "SELECT * FROM application_repeat_overrides WHERE tenant_id = 'local' AND target_job_id = ?",
        )
        .all(TARGET_JOB_ID) as Array<Record<string, unknown>>)
    : [];
  const originalRepeatOverrideConsumptions = hasRepeatApplicationTables
    ? (db
        .prepare(
          `SELECT c.*
             FROM application_repeat_override_consumptions c
            JOIN application_repeat_overrides o
              ON o.tenant_id = c.tenant_id AND o.override_id = c.override_id
            WHERE o.tenant_id = 'local' AND o.target_job_id = ?`,
        )
        .all(TARGET_JOB_ID) as Array<Record<string, unknown>>)
    : [];
  const originalRepeatAudit = hasRepeatApplicationTables
    ? (db
        .prepare(
          "SELECT * FROM application_repeat_audit WHERE tenant_id = 'local' AND target_job_id = ?",
        )
        .all(TARGET_JOB_ID) as Array<Record<string, unknown>>)
    : [];
  const originalTargetConfirmedEvents = db
    .prepare(
      `SELECT event_id, event_type FROM job_events
        WHERE tenant_id = 'local' AND job_id = ?
          AND event_type IN ('ApplicationSubmitted', 'ApplicationManuallyMarked')`,
    )
    .all(TARGET_JOB_ID) as Array<{ event_id: number; event_type: string }>;
  const originalTargetAppliedOutcomes = db
    .prepare(
      `SELECT outcome_id, kind FROM application_outcomes
        WHERE tenant_id = 'local' AND job_id = ? AND kind = 'applied_confirmation'`,
    )
    .all(TARGET_JOB_ID) as Array<{ outcome_id: string; kind: string }>;
  let originalTargetJob: Record<string, unknown> | undefined;
  try {
    if (hasRepeatApplicationTables) clearRepeatApplicationState(db);
    const target = db.prepare("SELECT * FROM jobs WHERE tenant_id = 'local' AND job_id = ?").get(TARGET_JOB_ID) as Record<
      string,
      unknown
    >;
    if (!target) throw new Error("QA target job is missing");
    originalTargetJob = target;
    db.prepare(
      `UPDATE job_events SET event_type = 'RepeatApplicationFixtureSuppressed'
        WHERE tenant_id = 'local' AND job_id = ?
          AND event_type IN ('ApplicationSubmitted', 'ApplicationManuallyMarked')`,
    ).run(TARGET_JOB_ID);
    db.prepare(
      `UPDATE application_outcomes SET kind = 'unknown'
        WHERE tenant_id = 'local' AND job_id = ? AND kind = 'applied_confirmation'`,
    ).run(TARGET_JOB_ID);
    db.prepare(
      `UPDATE jobs SET company = 'GitLab', apply_status = NULL, applied_at = NULL
        WHERE tenant_id = 'local' AND job_id = ?`,
    ).run(
      TARGET_JOB_ID,
    );
    const prior: Record<string, unknown> = {
      ...target,
      job_id: PRIOR_JOB_ID,
      url: PRIOR,
      application_url: `${PRIOR}/apply`,
      company: "GitLab",
      apply_status: "applied",
      applied_at: CONFIRMED_AT,
    };
    const columns = Object.keys(prior);
    db.prepare(
      `INSERT OR REPLACE INTO jobs (${columns.map((column) => `"${column}"`).join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    ).run(...columns.map((column) => prior[column]));
    db.prepare(
      `INSERT INTO job_events
       (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
       VALUES ('local', ?, 1, 'apply', 'ApplicationSubmitted', 'info',
               'Simulated prior application confirmation', ?, ?)`,
    ).run(PRIOR_JOB_ID, CONFIRMED_AT, JSON.stringify({ run_id: "e2e-prior-run" }));
    const identity = db.prepare(
      `INSERT OR REPLACE INTO job_canonical_identities
       (tenant_id, job_id, canonical_url, ats_kind, source_native_id, confidence, resolved_at)
       VALUES ('local', ?, ?, 'greenhouse', 'qa-platform-director', 1, ?)`,
    );
    identity.run(TARGET_JOB_ID, CANONICAL, CONFIRMED_AT);
    identity.run(PRIOR_JOB_ID, CANONICAL, CONFIRMED_AT);

    await page.goto(`/apply-review?jobKey=${encodeURIComponent(TARGET_JOB_ID)}`);
    await expect(page.getByText("Repeat application blocked", { exact: true })).toBeVisible();
    await expect(
      page.getByText("matching canonical ATS identity", { exact: true }),
    ).toBeVisible();
    const priorApplicationLink = page.getByRole("link", {
      name: `Inspect prior application: ${PRIOR_JOB_ID}`,
    });
    await expect(priorApplicationLink).toHaveAttribute(
      "href",
      `/jobs/${encodeURIComponent(PRIOR_JOB_ID)}`,
    );
    await expect(page.getByRole("button", { name: /Authorize live submit/i })).toBeDisabled();
    const trustedMutationHeaders = {
      origin: new URL(page.url()).origin,
      "sec-fetch-site": "same-origin",
    };

    const blocked = await request.post(
      `/v1/jobs/${encodeURIComponent(TARGET_JOB_ID)}/actions/apply`,
      { data: { dryRun: false }, headers: trustedMutationHeaders },
    );
    expect(blocked.status()).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "repeat_application_blocked" });
    await expect(page.getByLabel("Reason for another live attempt")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Confirm one live attempt" })).toHaveCount(0);

    db.prepare(
      "DELETE FROM job_canonical_identities WHERE tenant_id = 'local' AND job_id IN (?, ?)",
    ).run(TARGET_JOB_ID, PRIOR_JOB_ID);
    await page.reload();
    await expect(
      page.getByText("Review prior application before live submit", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("same employer and equivalent role", { exact: true })).toBeVisible();

    await page.getByLabel("Reason for another live attempt").fill(
      "The prior application was withdrawn before review; this retry is intentional.",
    );
    await page.getByRole("radio", { name: `Confirm prior application: ${PRIOR_JOB_ID}` }).check();
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
      `/v1/jobs/${encodeURIComponent(TARGET_JOB_ID)}/actions/apply`,
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

target_job_id = sys.argv[1]
init_db()
run_ctx = {
    "dry_run": False,
    "run_id": "e2e-worker-repeat-claim",
    "workflow_id": "e2e-repeat-application",
}
job = acquire_job(
    target_job_id=target_job_id,
    worker_id=91,
    run_ctx=run_ctx,
    approval_required=False,
)
if job is None:
    raise SystemExit("authoritative worker claim was refused unexpectedly")
conn = get_connection()
set_stage_state(conn, target_job_id, "apply", "pending", validate_transition=False)
conn.commit()
print(job["url"])
`;
    const workerOutput = execFileSync(
      pythonExecutable,
      ["-c", workerClaimScript, TARGET_JOB_ID],
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
      `/v1/jobs/${encodeURIComponent(TARGET_JOB_ID)}/actions/apply`,
      { data: { dryRun: false }, headers: trustedMutationHeaders },
    );
    expect(refusedAfterConsumption.status()).toBe(409);
    expect(await refusedAfterConsumption.json()).toMatchObject({
      error: "repeat_application_override_consumed",
    });

    const override = db
      .prepare(
        `SELECT override_id, target_job_id, prior_job_id, evidence_fingerprint, reason, confirmed_by, confirmed_at
           FROM application_repeat_overrides
          WHERE tenant_id = 'local' AND target_job_id = ?
          ORDER BY confirmed_at DESC LIMIT 1`,
      )
      .get(TARGET_JOB_ID) as Record<string, unknown>;
    expect(override).toMatchObject({
      target_job_id: TARGET_JOB_ID,
      prior_job_id: PRIOR_JOB_ID,
      confirmed_by: "user",
    });
    expect(String(override.reason)).toContain("withdrawn before review");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count
             FROM application_repeat_audit
            WHERE tenant_id = 'local' AND target_job_id = ? AND action = 'blocked'`,
        )
        .get(TARGET_JOB_ID),
    ).toMatchObject({ count: 1 });
    const auditRows = db
      .prepare(
        `SELECT action, evidence_fingerprint, override_id
           FROM application_repeat_audit
          WHERE tenant_id = 'local'
            AND target_job_id = ?
            AND evidence_fingerprint = ?
            AND action IN ('confirmation_required', 'override_recorded', 'override_consumed')
          ORDER BY CASE action
            WHEN 'confirmation_required' THEN 1
            WHEN 'override_recorded' THEN 2
            WHEN 'override_consumed' THEN 3
          END`,
      )
      .all(TARGET_JOB_ID, override.evidence_fingerprint) as Array<Record<string, unknown>>;
    expect(auditRows).toEqual([
      {
        action: "confirmation_required",
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
            WHERE tenant_id = 'local' AND job_id = ? AND event_type = 'ApplicationSubmitted'`,
        )
        .get(TARGET_JOB_ID),
    ).toMatchObject({ count: 0 });
  } finally {
    db.prepare(
      "DELETE FROM job_events WHERE tenant_id = 'local' AND job_id = ? AND payload_json LIKE '%e2e-worker-repeat-claim%'",
    ).run(TARGET_JOB_ID);
    db.prepare("DELETE FROM job_stage_states WHERE tenant_id = 'local' AND job_id = ? AND stage = 'apply'").run(TARGET_JOB_ID);
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
    ).run(TARGET_JOB_ID, PRIOR_JOB_ID);
    if (originalIdentity) {
      const columns = Object.keys(originalIdentity);
      db.prepare(
        `INSERT INTO job_canonical_identities (${columns.map((column) => `"${column}"`).join(", ")})
         VALUES (${columns.map(() => "?").join(", ")})`,
      ).run(...columns.map((column) => originalIdentity[column]));
    }
    db.prepare("DELETE FROM job_events WHERE tenant_id = 'local' AND job_id = ?").run(PRIOR_JOB_ID);
    db.prepare("DELETE FROM job_list_projections WHERE tenant_id = 'local' AND job_id = ?").run(
      PRIOR_JOB_ID,
    );
    db.prepare("DELETE FROM jobs WHERE tenant_id = 'local' AND job_id = ?").run(PRIOR_JOB_ID);
    if (originalTargetJob) {
      db.prepare(
        `UPDATE jobs SET company = ?, apply_status = ?, applied_at = ?
          WHERE tenant_id = 'local' AND job_id = ?`,
      ).run(
        originalTargetJob.company,
        originalTargetJob.apply_status,
        originalTargetJob.applied_at,
        TARGET_JOB_ID,
      );
    }
    for (const event of originalTargetConfirmedEvents) {
      db.prepare("UPDATE job_events SET event_type = ? WHERE event_id = ?").run(
        event.event_type,
        event.event_id,
      );
    }
    for (const outcome of originalTargetAppliedOutcomes) {
      db.prepare("UPDATE application_outcomes SET kind = ? WHERE outcome_id = ?").run(
        outcome.kind,
        outcome.outcome_id,
      );
    }
    db.close();
  }
});
