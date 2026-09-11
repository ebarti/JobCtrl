import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

const RUN_ID = "qa-dry-run-completed-896";
const FINISHED_AT = "2026-09-11T11:00:04.000Z";

test("DryRunCompleted alone refreshes apply history without submitting the job", async ({ page }) => {
  const db = new Database(loadE2eDbPath());
  const mutations: string[] = [];
  const streamEvents: string[] = [];
  const dryRunPayloads: unknown[] = [];
  let dashboardReads = 0;
  let streamConnections = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/dashboard/summary") dashboardReads += 1;
    if (pathname === "/v1/events/stream") streamConnections += 1;
    if (pathname.startsWith("/v1/") && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      mutations.push(`${request.method()} ${pathname}`);
    }
  });
  // Observe the real Chromium EventSource connection without replacing its transport.
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (event) => {
    streamEvents.push(event.eventName);
    if (event.eventName === "DryRunCompleted") {
      dryRunPayloads.push(JSON.parse(event.data).payload);
    }
  });

  try {
    db.prepare(`INSERT INTO apply_run_projections
      (tenant_id, run_id, job_id, job_title, job_employer, status, dry_run, started_at)
      VALUES ('local', ?, ?, 'Director of Platform Engineering', 'Greenhouse', 'in_progress', 1, ?)`)
      .run(RUN_ID, QA_PLATFORM_JOB_ID, "2026-09-11T11:00:00.000Z");
    const initialJob = db.prepare("SELECT apply_status, applied_at FROM jobs WHERE tenant_id = 'local' AND job_id = ?")
      .get(QA_PLATFORM_JOB_ID) as { apply_status: string | null; applied_at: string | null };
    expect(initialJob.applied_at).toBeNull();
    expect(initialJob.apply_status).not.toBe("applied");

    await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`);
    await expect(page.locator(".connection-pill")).toContainText("Live", { timeout: 30_000 });
    const run = page.locator(".apply-history-row").filter({ hasText: RUN_ID });
    await expect(run.getByText("in_progress", { exact: true })).toBeVisible();
    const originalUrl = page.url();
    const navigations = await page.evaluate(() => performance.getEntriesByType("navigation").length);
    const readsBefore = dashboardReads;
    const connectionsBefore = streamConnections;
    const watermark = (db.prepare("SELECT MAX(event_id) AS id FROM job_events").get() as { id: number }).id;

    // Simulate only the worker-owned projection write. No stage/lifecycle event,
    // reload, focus action or polling hook can refresh this apply-history query.
    db.prepare(`UPDATE apply_run_projections SET status = 'dry_run_complete', result = 'dry_run_complete',
      finished_at = ?, duration_ms = 4000 WHERE tenant_id = 'local' AND run_id = ?`)
      .run(FINISHED_AT, RUN_ID);
    await expect(run.getByText("dry_run_complete", { exact: true })).not.toBeVisible();
    expect(dashboardReads).toBe(readsBefore);

    const refreshed = page.waitForResponse((response) =>
      new URL(response.url()).pathname === "/v1/dashboard/summary" && response.ok(), { timeout: 5000 });
    // Exact launcher shape after record_job_event adds canonical job identity.
    db.prepare(`INSERT INTO job_events
      (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES ('local', ?, 1, 'apply', 'DryRunCompleted', 'info', ?, ?, ?)`)
      .run(QA_PLATFORM_JOB_ID, "Dry run completed without submitting", FINISHED_AT, JSON.stringify({
        jobId: QA_PLATFORM_JOB_ID,
        run_id: RUN_ID,
        result: "dry_run_complete",
        finished_at: FINISHED_AT,
        duration_ms: 4000,
        worker_id: 0,
        model: "synthetic-model",
        dry_run: true,
        coverage: "partial",
        blocked_channels: ["form_submit"],
        allowed_navigations: [],
        materials_generation: null,
        application_url: "https://example.com/apply/synthetic",
        profile_version: null,
        stage: "apply", level: "info", message: "Dry run completed without submitting",
      }));
    const response = await refreshed;
    expect((await response.json()).applyRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: RUN_ID, status: "dry_run_complete", dryRun: true }),
    ]));
    await expect(run.getByText("dry_run_complete", { exact: true })).toBeVisible({ timeout: 5000 });
    expect(streamEvents).toContain("DryRunCompleted");
    expect(dryRunPayloads).toEqual([expect.objectContaining({ run_id: RUN_ID, worker_id: 0 })]);
    expect(streamConnections).toBe(connectionsBefore);
    expect(page.url()).toBe(originalUrl);
    expect(await page.evaluate(() => performance.getEntriesByType("navigation").length)).toBe(navigations);
    expect(db.prepare("SELECT event_type FROM job_events WHERE event_id > ?").all(watermark))
      .toEqual([{ event_type: "DryRunCompleted" }]);
    expect(db.prepare("SELECT apply_status, applied_at FROM jobs WHERE tenant_id = 'local' AND job_id = ?")
      .get(QA_PLATFORM_JOB_ID)).toEqual(initialJob);
    expect(db.prepare(`SELECT COUNT(*) AS count FROM job_events WHERE job_id = ?
      AND event_type IN ('ApplicationSubmitted', 'ApplySubmitIntended')`).get(QA_PLATFORM_JOB_ID))
      .toEqual({ count: 0 });
    expect(mutations).toEqual([]);
  } finally {
    db.close();
    await cdp.detach();
  }
});
