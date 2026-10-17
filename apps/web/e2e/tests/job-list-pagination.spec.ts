import { expect, test, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STAGES } from "@jobctrl/contracts";
import { loadE2eDbPath } from "../fixtures/e2e-state.js";

const PREFIX = "qa-bounded-1003";
const COUNT = 5001;
// Unique, canonical UUIDs; expected order is the numeric input sequence.
const id = (index: number) =>
  `10031003-1003-4000-8000-${String(index).padStart(12, "0")}`;
const expectedIds = (offset: number, count: number) =>
  Array.from({ length: count }, (_, i) => id(offset + i));

async function stageCheckbox(page: Page, stage: string) {
  return page
    .getByRole("dialog", { name: "Stage filter", exact: true })
    .getByRole("checkbox", { name: stage, exact: true });
}

test("Jobs view requests one bounded combined deep page with exact adjacent, clamped and empty boundaries", async ({
  page,
  request,
}, testInfo) => {
  test.setTimeout(120_000);
  const db = new Database(loadE2eDbPath());
  db.pragma("foreign_keys = ON");
  const owned: string[] = [];
  const reads: Array<{
    url: string;
    query: Record<string, string>;
    status: number;
    body: unknown;
  }> = [];
  const pendingReads: Promise<void>[] = [];
  // Count requests independently: an aborted/failed preceding-page download
  // must not disappear merely because it produced no JSON response.
  const requests: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/v1/jobs") requests.push(url.pathname + url.search);
  });
  page.on("response", (response) => {
    const url = new URL(response.url());
    if (url.pathname !== "/v1/jobs") return;
    pendingReads.push(
      (async () => {
        reads.push({
          url: url.pathname + url.search,
          query: Object.fromEntries(url.searchParams),
          status: response.status(),
          body: await response.json(),
        });
      })(),
    );
  });
  const baseline = await (await request.get("/v1/jobs")).json();
  try {
    const job =
      db.prepare(`INSERT INTO jobs (tenant_id, job_id, url, title, company, site, discovered_at)
      VALUES ('local', ?, ?, ?, 'Bounded Synthetic Labs', 'bounded-1003', '2026-01-01T00:00:00.000Z')`);
    const state =
      db.prepare(`INSERT INTO job_stage_states (tenant_id, job_id, stage, state, updated_at, version)
      VALUES ('local', ?, ?, ?, '2026-01-01T00:00:00.000Z', 1)`);
    db.transaction(() => {
      for (let i = 0; i < COUNT; i++) {
        const jobId = id(i);
        job.run(
          jobId,
          `https://synthetic.invalid/${PREFIX}/${i}`,
          `${PREFIX} Engineer ${String(i).padStart(5, "0")}`,
        );
        owned.push(jobId);
        for (const stage of STAGES) {
          state.run(
            jobId,
            stage,
            i % 2 && stage !== "apply" ? "succeeded" : "pending",
          );
        }
      }
    })();

    const route = (pageNumber: number, q = PREFIX) =>
      `/jobs?q=${encodeURIComponent(q)}&stage=all&page=${pageNumber}&pageSize=50&sort=discovered_at&dir=desc`;
    const responseFor = () =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/v1/jobs" && response.ok(),
      );
    const capture = async (name: string) => {
      const image = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path: image, fullPage: true });
      await testInfo.attach(name, { path: image, contentType: "image/png" });
    };
    const assertRows = async (ids: string[]) => {
      await expect(
        page.locator(
          "[role='checkbox'][aria-label^='Select qa-bounded-1003 Engineer']",
        ),
      ).toHaveCount(ids.length);
      const titles = ids.map(
        (jobId) =>
          `${PREFIX} Engineer ${String(Number(jobId.slice(-12))).padStart(5, "0")}`,
      );
      await expect
        .poll(() =>
          page
            .locator(
              "[role='checkbox'][aria-label^='Select qa-bounded-1003 Engineer']",
            )
            .evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("aria-label")),
            ),
        )
        .toEqual(titles.map((title) => `Select ${title}`));
    };
    // Start in the ordinary list, then use the actual grid and save its selection.
    let response = responseFor();
    await page.goto(route(1));
    let body = await (await response).json();
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 50,
      total: COUNT,
      pages: 101,
    });
    expect(body.items.map((row: { jobKey: string }) => row.jobKey)).toEqual(
      expectedIds(0, 50),
    );
    await assertRows(expectedIds(0, 50));
    await capture("ordinary-first");
    await page.getByRole("button", { name: /filter stage column/i }).click();
    await (await stageCheckbox(page, "discover")).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("stage"))
      .toBe("discover");
    const combinedReady = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === "/v1/jobs" &&
        url.searchParams.get("stages") === "discover,apply" &&
        url.searchParams.get("page") === "1" && response.ok();
    });
    await (await stageCheckbox(page, "apply")).click();
    await combinedReady;
    await assertRows(expectedIds(0, 50));
    await page
      .getByRole("dialog", { name: "Stage filter", exact: true })
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await expect(
      page.getByRole("button", { name: "Select all matching" }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "Save as view" }).click();
    const save = page.getByRole("dialog", { name: "Save view", exact: true });
    await save
      .getByLabel("Name", { exact: true })
      .fill("Bounded combined stages");
    await save.getByRole("button", { name: "Save", exact: true }).click();
    await expect(save).toBeHidden();
    await Promise.all(pendingReads);
    const beforeDeep = reads.length;
    const beforeDeepRequests = requests.length;

    response = responseFor();
    await page.goto(route(100));
    await response;
    await assertRows(expectedIds(4950, 50));
    await expect(
      page.getByText(`Page 100 of 101 · ${COUNT} rows`, { exact: true }),
    ).toBeVisible();
    await Promise.all(pendingReads);
    const deepReads = reads.slice(beforeDeep);
    const deepRequests = requests.slice(beforeDeepRequests);
    await capture("combined-deep");
    expect(deepRequests).toHaveLength(1);
    expect(deepReads).toHaveLength(1);
    expect(deepRequests[0]).toBe(deepReads[0]!.url);
    expect(deepReads[0]!.status).toBe(200);
    expect(deepReads[0]!.query).toMatchObject({
      stages: "discover,apply",
      page: "100",
      pageSize: "50",
    });
    expect(deepReads[0]!.query).not.toHaveProperty("stage");
    body = deepReads[0]!.body as typeof body;
    expect(body.items.map((row: { jobKey: string }) => row.jobKey)).toEqual(
      expectedIds(4950, 50),
    );
    expect(
      body.items.every((row: { currentStage: string }) =>
        ["discover", "apply"].includes(row.currentStage),
      ),
    ).toBe(true);
    expect(body.pagination).toEqual({
      page: 100,
      pageSize: 50,
      total: COUNT,
      pages: 101,
    });
    expect(
      deepReads.every(
        (read) => read.query.page === "100" && read.query.pageSize === "50",
      ),
    ).toBe(true);
    await page
      .getByRole("button", { name: "Select page", exact: true })
      .click();
    await expect(page.getByText("50 selected", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "Select all matching", exact: true })
      .click();
    await expect(
      page.getByText(`${COUNT} selected`, { exact: true }),
    ).toBeVisible();

    const beforeAdjacent = reads.length;
    response = responseFor();
    await page.getByRole("button", { name: "Next", exact: true }).click();
    await response;
    await assertRows(expectedIds(5000, 1));
    await expect(
      page.getByText(`${COUNT} selected`, { exact: true }),
    ).toHaveCount(0);
    await Promise.all(pendingReads);
    expect(reads.slice(beforeAdjacent)).toHaveLength(1);
    body = reads.at(-1)!.body as typeof body;
    expect(body.pagination).toEqual({
      page: 101,
      pageSize: 50,
      total: COUNT,
      pages: 101,
    });
    expect(body.items.map((row: { jobKey: string }) => row.jobKey)).toEqual(
      expectedIds(5000, 1),
    );
    await expect(
      page.getByRole("button", { name: "Next", exact: true }),
    ).toBeDisabled();
    await capture("combined-adjacent");

    response = responseFor();
    await page.goto(route(999));
    body = await (await response).json();
    expect(body.pagination).toEqual({
      page: 101,
      pageSize: 50,
      total: COUNT,
      pages: 101,
    });
    expect(body.items.map((row: { jobKey: string }) => row.jobKey)).toEqual(
      expectedIds(5000, 1),
    );
    await expect(
      page.getByText(`Page 101 of 101 · ${COUNT} rows`, { exact: true }),
    ).toBeVisible();
    await assertRows(expectedIds(5000, 1));
    await capture("combined-clamped");

    response = responseFor();
    await page.goto(route(100, `${PREFIX}-no-match`));
    body = await (await response).json();
    expect(body.items).toEqual([]);
    expect(body.pagination).toEqual({
      page: 1,
      pageSize: 50,
      total: 0,
      pages: 1,
    });
    await expect(
      page.getByText("No jobs match.", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Select all matching", exact: true }),
    ).toBeDisabled();
    await capture("combined-empty");
    expect(errors).toEqual([]);
  } finally {
    try {
      try {
        await Promise.all(pendingReads);
        await testInfo.attach("job-list-requests-responses", {
          body: JSON.stringify({ requests, responses: reads, errors }, null, 2),
          contentType: "application/json",
        });
        const sources = [
          "src/contexts/operations/jobsListQuery.ts",
          "src/views/jobs/JobsView.tsx",
          "src/routes/jobs.tsx",
          "e2e/tests/job-list-pagination.spec.ts",
          "../../pnpm-lock.yaml",
        ];
        await testInfo.attach("job-list-inputs-provenance", {
          body: JSON.stringify(
            {
              utc: new Date().toISOString(),
              seed: PREFIX,
              count: COUNT,
              stages: ["discover", "apply"],
              page: 100,
              pageSize: 50,
              expectedDeepIds: expectedIds(4950, 50),
              sourceSha256: Object.fromEntries(
                sources.map((source) => [
                  source,
                  createHash("sha256")
                    .update(fs.readFileSync(path.resolve(source)))
                    .digest("hex"),
                ]),
              ),
            },
            null,
            2,
          ),
          contentType: "application/json",
        });
      } finally {
        await page.close();
        db.transaction(() => {
          for (const jobId of owned) {
            for (const table of [
              "job_events",
              "job_list_projections",
              "job_detail_projections",
              "artifact_list_projections",
              "job_stage_states",
              "jobs",
            ]) {
              db.prepare(
                `DELETE FROM ${table} WHERE tenant_id = 'local' AND job_id = ?`,
              ).run(jobId);
            }
          }
        })();
        const restored = await (await request.get("/v1/jobs")).json();
        expect(restored.pagination.total).toBe(baseline.pagination.total);
      }
    } finally {
      db.close();
    }
  }
});
