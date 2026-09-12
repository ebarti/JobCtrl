import { expect, test } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const PREFIX = "qa-cache-890-";
const COMPANY = "Cache Context Labs";

test("JobUpdated patches a filtered second page without losing selection, order or scroll", async ({
  page,
  request,
}, testInfo) => {
  const db = new Database(loadE2eDbPath());
  db.pragma("foreign_keys = ON");
  const seededJobIds: string[] = [];
  const baselineResponse = await request.get("/v1/jobs");
  expect(baselineResponse.ok()).toBe(true);
  const baseline = await baselineResponse.json();
  const errors: string[] = [];
  const streamEvents: string[] = [];
  let listReads = 0;
  let connections = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (pathname === "/v1/jobs") listReads += 1;
    if (pathname === "/v1/events/stream") connections += 1;
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Network.enable");
  cdp.on("Network.eventSourceMessageReceived", (event) =>
    streamEvents.push(event.eventName),
  );
  try {
    // This database belongs to the guarded, disposable E2E workspace. Populate
    // enough canonical jobs for a real second page and a nonzero scroll offset.
    const insertJob = db.prepare(`INSERT INTO jobs
      (tenant_id, job_id, url, title, company, site, discovered_at)
      VALUES ('local', ?, ?, ?, ?, 'cache-890', ?)`);
    const insertEvent = db.prepare(`INSERT INTO job_events
      (tenant_id, job_id, identity_version, stage, event_type, level, message, occurred_at, payload_json)
      VALUES ('local', ?, 1, 'discover', ?, 'info', ?, ?, ?)`);
    db.transaction(() => {
      for (let index = 0; index < 60; index += 1) {
        const digest = createHash("sha256")
          .update(`${PREFIX}${index}`)
          .digest("hex");
        const jobId = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-8${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
        const title = `Cache Engineer ${String(index).padStart(3, "0")}`;
        const url = `https://example.com/${jobId}`;
        const timestamp = new Date(
          Date.UTC(2026, 8, 12, 10, index),
        ).toISOString();
        insertJob.run(jobId, url, title, COMPANY, timestamp);
        seededJobIds.push(jobId);
        insertEvent.run(
          jobId,
          "JobDiscovered",
          "Synthetic cache regression job",
          timestamp,
          JSON.stringify({
            jobId,
            postingUrl: url,
            source: "cache-890",
            employer: COMPANY,
            metadata: {},
            discoveredAt: timestamp,
          }),
        );
      }
    })();

    const initialResponse = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/v1/jobs",
    );
    await page.goto(
      "/jobs?discoveredSince=2026-09-12T10%3A00%3A00.000Z&page=2&pageSize=20&sort=discovered_at&dir=desc",
    );
    const response = await initialResponse;
    expect(response.ok(), await response.text()).toBe(true);
    const initial = (await response.json()) as {
      items: Array<{ jobKey: string; title: string }>;
      pagination: { page: number; total: number };
    };
    expect(initial.pagination).toMatchObject({ page: 2, total: 60 });
    await expect(page.locator(".connection-pill")).toContainText("Live", {
      timeout: 30_000,
    });
    const target = initial.items[8]!;
    const selected = page.getByRole("checkbox", {
      name: `Select ${target.title}`,
      exact: true,
    });
    await selected.click();
    await expect(selected).toBeChecked();
    await expect(page.getByText("1 selected", { exact: true })).toBeVisible();
    await page.evaluate(() => window.scrollTo(0, 350));
    const scrollBefore = await page.evaluate(() => window.scrollY);
    expect(scrollBefore).toBeGreaterThan(0);
    const urlBefore = page.url();
    const labelsBefore = await page
      .locator("[role='checkbox'][aria-label^='Select Cache Engineer']")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      );
    const readsBefore = listReads;
    const connectionsBefore = connections;
    const title = "Cache Engineer updated";
    const occurredAt = new Date().toISOString();
    // Persist the same canonical field written by discovery, then emit only
    // JobUpdated. No navigation, focus or manual refresh drives the new label.
    db.transaction(() => {
      db.prepare(
        "UPDATE jobs SET title = ? WHERE tenant_id = 'local' AND job_id = ?",
      ).run(title, target.jobKey);
      insertEvent.run(
        target.jobKey,
        "JobUpdated",
        "Synthetic title update",
        occurredAt,
        JSON.stringify({ jobId: target.jobKey, changedFields: { title } }),
      );
    })();
    const updated = page.getByRole("checkbox", {
      name: `Select ${title}`,
      exact: true,
    });
    await expect(updated).toBeChecked({ timeout: 5000 });
    await expect.poll(() => streamEvents.includes("JobUpdated")).toBe(true);
    expect(listReads).toBe(readsBefore);
    expect(connections).toBe(connectionsBefore);
    expect(page.url()).toBe(urlBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
    const labelsAfter = await page
      .locator("[role='checkbox'][aria-label^='Select Cache Engineer']")
      .evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("aria-label")),
      );
    expect(labelsAfter).toEqual(
      labelsBefore.map((label) =>
        label === `Select ${target.title}` ? `Select ${title}` : label,
      ),
    );
    expect(errors).toEqual([]);
    await expect(page.locator("vite-error-overlay")).toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath("realtime-context.png"),
    });
    await testInfo.attach("realtime-context", {
      path: testInfo.outputPath("realtime-context.png"),
      contentType: "image/png",
    });

    // An event with unknown derived fields must still refetch this exact page.
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/v1/jobs" && response.ok(),
    );
    insertEvent.run(
      target.jobKey,
      "JobUpdated",
      "Synthetic unknown update",
      new Date().toISOString(),
      JSON.stringify({ jobId: target.jobKey, changedFields: { metadata: {} } }),
    );
    expect((await refreshed).ok()).toBe(true);
    await expect(updated).toBeChecked();
    expect(page.url()).toBe(urlBefore);
    expect(await page.evaluate(() => window.scrollY)).toBe(scrollBefore);
  } finally {
    try {
      // Other specs share this disposable workspace. Remove our canonical rows
      // and derived rows, then replay the remaining canonical history so totals
      // and dashboard activity no longer include the synthetic fixture.
      await page.close();
      db.transaction(() => {
        for (const jobId of seededJobIds) {
          for (const table of [
            "job_events",
            "job_list_projections",
            "job_detail_projections",
            "artifact_list_projections",
            "jobs",
          ]) {
            db.prepare(
              `DELETE FROM ${table} WHERE tenant_id = 'local' AND job_id = ?`,
            ).run(jobId);
          }
        }
        db.prepare(
          "UPDATE event_watermarks SET last_event_id = 0 WHERE projection_name = ?",
        ).run("typescript:operations_projections:local");
      })();
      const lastEvent = db
        .prepare(
          "SELECT COALESCE(MAX(event_id), 0) AS id FROM job_events WHERE tenant_id = 'local'",
        )
        .get() as { id: number };
      await expect
        .poll(async () => {
          const response = await request.get("/v1/jobs");
          expect(response.ok()).toBe(true);
          const watermark = db
            .prepare(
              "SELECT last_event_id AS id FROM event_watermarks WHERE projection_name = ?",
            )
            .get("typescript:operations_projections:local") as { id: number };
          return watermark.id;
        })
        .toBeGreaterThanOrEqual(lastEvent.id);
      const restored = await (await request.get("/v1/jobs")).json();
      expect(restored.pagination.total).toBe(baseline.pagination.total);
      expect(
        restored.items.map((item: { jobKey: string }) => item.jobKey),
      ).toEqual(baseline.items.map((item: { jobKey: string }) => item.jobKey));
      for (const table of [
        "jobs",
        "job_events",
        "job_list_projections",
        "job_detail_projections",
        "artifact_list_projections",
      ]) {
        const remaining = db
          .prepare(
            `SELECT COUNT(*) AS count FROM ${table} WHERE tenant_id = 'local' AND job_id IN (${seededJobIds.map(() => "?").join(",")})`,
          )
          .get(...seededJobIds) as { count: number };
        expect(remaining.count).toBe(0);
      }
    } finally {
      db.close();
    }
  }
});
