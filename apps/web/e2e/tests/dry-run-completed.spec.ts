import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";

import { loadE2eDbPath, QA_PLATFORM_JOB_ID } from "../fixtures/e2e-state.js";

const FINISHED_AT = "2026-09-11T11:00:04.000Z";

test("DryRunCompleted alone refreshes apply history without submitting the job", async ({
  page,
}) => {
  const db = new Database(loadE2eDbPath());
  const runId = `qa-dry-run-completed-${randomUUID()}`;
  let completionEventId: number | bigint | undefined;
  const mutations: string[] = [];
  const streamEvents: string[] = [];
  const dryRunPayloads: unknown[] = [];
  let dashboardReads = 0;
  let streamConnections = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/dashboard/summary") dashboardReads += 1;
    if (pathname === "/v1/events/stream") streamConnections += 1;
    if (
      pathname.startsWith("/v1/") &&
      !["GET", "HEAD", "OPTIONS"].includes(request.method())
    ) {
      mutations.push(`${request.method()} ${pathname}`);
    }
  });
  // Observe the real Chromium EventSource connection without replacing its transport.
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    cdp.on("Network.eventSourceMessageReceived", (event) => {
      streamEvents.push(event.eventName);
      if (event.eventName === "DryRunCompleted") {
        dryRunPayloads.push(JSON.parse(event.data).payload);
      }
    });

    db.prepare(
      `INSERT INTO apply_run_projections
      (tenant_id, run_id, job_id, job_title, job_employer, status, dry_run, started_at)
      VALUES ('local', ?, ?, 'Director of Platform Engineering', 'Greenhouse', 'in_progress', 1, ?)`,
    ).run(runId, QA_PLATFORM_JOB_ID, "2026-09-11T11:00:00.000Z");
    const initialJob = db
      .prepare(
        "SELECT apply_status, applied_at FROM jobs WHERE tenant_id = 'local' AND job_id = ?",
      )
      .get(QA_PLATFORM_JOB_ID) as {
      apply_status: string | null;
      applied_at: string | null;
    };
    expect(initialJob.applied_at).toBeNull();
    expect(initialJob.apply_status).not.toBe("applied");

    const run = page.locator(".apply-history-row").filter({ hasText: runId });
    await test.step("Open job and establish the live apply-history baseline", async () => {
      await page.goto(`/jobs/${QA_PLATFORM_JOB_ID}`, {
        waitUntil: "domcontentloaded",
      });
      await expect(page.locator(".connection-pill")).toContainText("Live", {
        timeout: 10_000,
      });
      await expect(run.getByText("in_progress", { exact: true })).toBeVisible();
    });
    const originalUrl = page.url();
    const navigations = await page.evaluate(
      () => performance.getEntriesByType("navigation").length,
    );
    const readsBefore = dashboardReads;
    const connectionsBefore = streamConnections;
    const watermark = (
      db.prepare("SELECT MAX(event_id) AS id FROM job_events").get() as {
        id: number;
      }
    ).id;

    // Simulate only the worker-owned projection write. No stage/lifecycle event,
    // reload, focus action or polling hook can refresh this apply-history query.
    db.prepare(
      `UPDATE apply_run_projections SET status = 'dry_run_complete', result = 'dry_run_complete',
      finished_at = ?, duration_ms = 4000 WHERE tenant_id = 'local' AND run_id = ?`,
    ).run(FINISHED_AT, runId);
    await expect(
      run.getByText("dry_run_complete", { exact: true }),
    ).not.toBeVisible();
    expect(dashboardReads).toBe(readsBefore);

    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/dashboard/summary" &&
        response.ok(),
      { timeout: 5000 },
    );
    // Exact launcher shape after record_job_event adds canonical job identity.
    completionEventId = db
      .prepare(
        `INSERT INTO job_events
      (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES ('local', ?, 1, 'apply', 'DryRunCompleted', 'info', ?, ?, ?)`,
      )
      .run(
        QA_PLATFORM_JOB_ID,
        "Dry run completed without submitting",
        FINISHED_AT,
        JSON.stringify({
          jobId: QA_PLATFORM_JOB_ID,
          run_id: runId,
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
          stage: "apply",
          level: "info",
          message: "Dry run completed without submitting",
        }),
      ).lastInsertRowid;
    const response =
      await test.step("Receive the dashboard refresh from DryRunCompleted", () =>
        refreshed);
    expect((await response.json()).applyRuns).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          runId: runId,
          status: "dry_run_complete",
          dryRun: true,
        }),
      ]),
    );
    await expect(
      run.getByText("dry_run_complete", { exact: true }),
    ).toBeVisible({ timeout: 5000 });
    expect(streamEvents).toContain("DryRunCompleted");
    expect(dryRunPayloads).toEqual([
      expect.objectContaining({ run_id: runId, worker_id: 0 }),
    ]);
    expect(streamConnections).toBe(connectionsBefore);
    expect(page.url()).toBe(originalUrl);
    expect(
      await page.evaluate(
        () => performance.getEntriesByType("navigation").length,
      ),
    ).toBe(navigations);
    expect(
      db
        .prepare("SELECT event_type FROM job_events WHERE event_id > ?")
        .all(watermark),
    ).toEqual([{ event_type: "DryRunCompleted" }]);
    expect(
      db
        .prepare(
          "SELECT apply_status, applied_at FROM jobs WHERE tenant_id = 'local' AND job_id = ?",
        )
        .get(QA_PLATFORM_JOB_ID),
    ).toEqual(initialJob);
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM job_events WHERE job_id = ?
      AND event_type IN ('ApplicationSubmitted', 'ApplySubmitIntended')`,
        )
        .get(QA_PLATFORM_JOB_ID),
    ).toEqual({ count: 0 });
    expect(mutations).toEqual([]);
  } finally {
    // Playwright owns the page and its CDP session. Explicitly detaching after
    // a test timeout can throw against the closed page and mask the real error.
    try {
      db.transaction(() => {
        if (completionEventId !== undefined) {
          db.prepare("DELETE FROM job_events WHERE event_id = ?").run(
            completionEventId,
          );
        }
        db.prepare(
          "DELETE FROM apply_run_projections WHERE tenant_id = 'local' AND run_id = ?",
        ).run(runId);
      })();
    } finally {
      db.close();
    }
  }
});
