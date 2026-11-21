import { indeedPage } from "./indeed-data.js";
import type { Request, Response } from "@playwright/test";
import { completed, expect, json, modelCall, test } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { serveRoleTarget } from "./discovery-role-scope-data.js";
import { respondProducer } from "./preparation-cohort-data.js";
import { qualificationBatchDecision } from "./qualification-data.js";
import { modelSources, typedExtraction } from "./requirements-data.js";

test("Start search for 100 keeps Jobs current while a URL import waits for enrichment", async ({ api, app, page }, info) => {
  test.setTimeout(180_000);
  const { profile } = await createBaseline(api, {
    ...baseline, experience: { target_role: "Reliability Engineer", target_locations: "Madrid", target_work_models: "remote" },
  });
  const { sources } = await json<{ sources: { path?: string[]; source_id: string }[] }>(api, "get", "/v1/profile/sources");
  const educationId = sources.find((row) => row.path?.[1] === "education_entries")!.source_id;
  const userSettings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: userSettings.revision, dailyBudgetUsd: 0 });
  const discoverySettings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", {
    expectedRevision: discoverySettings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 100, resultsPerSite: 100,
  });
  const degree = "Synthetic Engineering Degree";
  const requirement = "A Synthetic Engineering Degree is required.";
  const positions = Array.from({ length: 100 }, (_, index) => {
    const id = String(index + 1).padStart(3, "0");
    return { job_key: "search-stress-" + id, url: "https://www.indeed.com/viewjob?jk=search-stress-" + id,
      title: "Reliability Engineer, Team " + id, company: "Example Systems " + id, location: "Madrid",
      description: "This is the reliability engineering position for Team " + id + ". " + requirement };
  });
  const importedPosition = { job_key: "separate-import", url: "https://example.com/jobs/reliability-lead-import",
    title: "Reliability Lead, Platform Operations", location: "Madrid", company: "Example Platform Operations",
    description: "The platform reliability lead directs operational recovery for the platform team." };
  const postings = [...positions, importedPosition];
  const browserReads = new Map<string, number>();
  const inFlight = new Map<string, number>();
  const peaks = new Map<string, number>();
  const projections = new Map<string, Response>();
  const browserWrites: string[] = [];
  const projectionPaths = ["/v1/jobs", "/v1/jobs/query", "/v1/preparation/runs", "/v1/digest", "/v1/jobs/url-imports", "/v1/health"];
  const firstRequest = Date.now();
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && projectionPaths.includes(path)) {
      browserReads.set(path, (browserReads.get(path) ?? 0) + 1);
      const active = (inFlight.get(path) ?? 0) + 1;
      inFlight.set(path, active);
      peaks.set(path, Math.max(peaks.get(path) ?? 0, active));
    } else if (request.method() === "POST") {
      browserWrites.push(path);
    }
  });
  const settled = (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && inFlight.has(path)) inFlight.set(path, inFlight.get(path)! - 1);
  };
  page.on("requestfinished", settled);
  page.on("requestfailed", settled);
  page.on("response", (response) => {
    const path = new URL(response.url()).pathname;
    if (response.ok() && projectionPaths.includes(path)) projections.set(path, response);
  });
  await page.setViewportSize({ width: 1500, height: 1120 });
  await page.goto("/jobs");
  const start = page.getByRole("button", { name: "Start search", exact: true });
  const progress = page.getByRole("region", { name: "Job search progress", exact: true });
  await expect(start).toBeEnabled();
  const admitted = page.waitForResponse(response => response.request().method() === "POST" &&
    new URL(response.url()).pathname === "/v1/actions/discovery.search");
  await start.click();
  const response = await admitted;
  expect(response.ok()).toBe(true);
  expect(response.request().postDataJSON()).toEqual({ queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  const { runId } = await response.json();
  const board = await app.external.next();
  expect(board.path).toBe("/jobstreaming/indeed");
  board.respond(indeedPage({ jobs: positions, cursor: null, complete: true }));
  for (let index = 0; index < positions.length; index++) await serveRoleTarget(app, "match");
  const firstPage = await app.external.next();
  expect(firstPage.path).toBe("/posting-page");
  expect(firstPage.body["url"]).toBe(positions[0]!.url);
  respondProducer(firstPage, postings);
  const searchLane = await modelCall(app, "page_interpretation");
  expect(searchLane.body["lane"]).toBe("enrichment");
  try {
    await expect(progress).toContainText(/100 new jobs/i);
    const checkpoint = progress.getByLabel("Fit preparation progress", { exact: true });
    await expect(checkpoint).toHaveText("0 of 100 postings checked. Fit scoring waits for posting and requirements checks across this search.");
    await expect(start).toBeDisabled();
    const frozen = await json<{ targetRoute: string; jobIds: string[] }>(api, "get", "/v1/preparation/runs/" + runId);
    expect(frozen.targetRoute).toBe("per_job");
    expect(new Set(frozen.jobIds).size).toBe(100);
    await expect(page.getByRole("row").filter({ hasText: positions.at(-1)!.title }).getByRole("link", { name: "Waiting for search checks" }))
      .toHaveAttribute("href", `/runs/${runId}`);
    await page.getByText("Add a job by URL or text", { exact: true }).click();
    await page.getByText("Import posting URL", { exact: true }).click();
    const form = page.locator("form.jobs-capture__url");
    await form.locator("input").fill(importedPosition.url);
    const importAdmission = page.waitForResponse(response => response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/v1/actions/jobs.capture_url");
    await form.getByRole("button", { name: "Import job", exact: true }).click();
    const importResponse = await importAdmission;
    expect(importResponse.ok()).toBe(true);
    expect(importResponse.request().postDataJSON()).toEqual({ url: importedPosition.url });
    const importId = (await importResponse.json()).runId;
    const importPage = await app.external.next();
    expect(importPage.path).toBe("/posting-page");
    expect(importPage.body["url"]).toBe(importedPosition.url);
    respondProducer(importPage, [importedPosition]);
    const imports = page.getByRole("region", { name: "Recent URL imports" });
    await expect(imports).toContainText("Queued for model capacity");
    await expect(imports).toContainText(importedPosition.url);
    await expect(progress).toBeInViewport();
    await expect(imports).toBeInViewport();
    expect((await json<{ imports: unknown[] }>(api, "get", "/v1/jobs/url-imports")).imports).toContainEqual(
      expect.objectContaining({ runId: importId, url: importedPosition.url, status: "waiting_for_capacity" }));
    expect(app.external.calls.filter(call => call.body?.["operation"] === "page_interpretation")).toHaveLength(1);
    await info.attach("queued-url-and-search", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
    respondProducer(searchLane, [positions[0]!]);
    const importModelCalls: string[] = [];
    let qualificationCalls = 0;
    while (qualificationCalls < positions.length || importModelCalls.length < 3) {
      const call = await app.external.next();
      if (call.path === "/posting-page") {
        respondProducer(call, postings);
        continue;
      }
      expect(call.path).toBe("/model");
      const operation = call.body["operation"];
      if (operation === "requirements.extract") {
        call.reply(typedExtraction(call, { education: [{ qualification: degree, text: requirement }] }));
      } else if (operation === "fit.qualification-batch") {
        qualificationCalls += 1;
        call.reply(qualificationBatchDecision(call, binding => {
          expect(binding.category).toBe("education");
          return { evidenceRoute: "education", evidenceSourceIds: ["evidence:" + educationId] };
        }));
      } else {
        const fromImport = modelSources(call).some((source) => source.text === importedPosition.description || source.text.includes(importedPosition.title));
        respondProducer(call, postings);
        if (fromImport) {
          importModelCalls.push(String(operation));
          if (operation === "description_quality") {
            await completed(api, importId);
            expect((await json(api, "get", "/v1/action-runs/" + runId))["status"]).toBe("running");
          }
        }
      }
    }
    expect(importModelCalls).toEqual(["page_interpretation", "posting_extraction", "description_quality"]);
    const search = await completed(api, runId);
    const result = search["result"] as { newJobIds: string[] };
    expect(result).toMatchObject({ newJobs: 100, preparation: { assessedJobs: 100, failedJobs: 0, skippedJobs: 0 } });
    expect(new Set(result.newJobIds)).toEqual(new Set(frozen.jobIds));
    const imported = (await completed(api, importId))["result"] as { job_id: string };
    expect(imported).toMatchObject({ url: importedPosition.url, title: importedPosition.title });
    expect(frozen.jobIds).not.toContain(imported.job_id);
    const history = await json<{ observations: unknown[] }>(api, "get", `/v1/jobs/${imported.job_id}/snapshots`);
    expect(history.observations).toHaveLength(1);
    const jobs = await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs?limit=150");
    expect(new Set(jobs.jobs.map((row) => row.job_id)).size).toBe(101);
    expect(browserWrites.filter((path) => path === "/v1/actions/discovery.search")).toHaveLength(1);
    expect(browserWrites.filter((path) => path === "/v1/actions/jobs.capture_url")).toHaveLength(1);
    expect(browserWrites).not.toContain("/v1/jobs/capture");
    await expect(imports.getByRole("link", { name: "Open job" })).toHaveAttribute("href", new RegExp(imported.job_id));
    await expect(progress).toContainText(/100(?: of 100)? jobs assessed · 0 failed/);
    await expect(checkpoint).toHaveCount(0);
    await expect(page.getByText("50 shown / 101 total", { exact: true })).toBeVisible();
    await expect(page.locator(".connection-pill")).toHaveText("Live");
    await expect.poll(async () => (await projections.get("/v1/digest")?.json())?.newMatches)
      .toEqual({ count: 101, highFitCount: 100 });
    await expect.poll(async () => (await projections.get("/v1/health")?.json())?.llmSpend.activeCalls).toBe(0);
    type Run = { runId: string; status: string };
    const preparation = (await json<{ runs: Run[] }>(api, "get", "/v1/preparation/runs")).runs.find((run) => run.runId === runId)!;
    expect(preparation.status).not.toBe("running");
    await expect.poll(async () => {
      const runs: Run[] = (await projections.get("/v1/preparation/runs")?.json())?.runs ?? [];
      return runs.find((run) => run.runId === runId)?.status;
    }).toBe(preparation.status);
    await info.attach("completed-search-and-import", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
    // Under a sustained burst each watched projection needs only a few reads
    // a second. Allow additional independent route, mutation and polling reads.
    const elapsedSeconds = (Date.now() - firstRequest) / 1000;
    for (const path of projectionPaths) {
      const count = browserReads.get(path) ?? 0;
      expect(count, path).toBeGreaterThan(0);
      expect(count, path).toBeLessThan(12 + 6 * elapsedSeconds);
      // Health also serves independent action-recovery observers. Each other
      // projection may overlap a direct user write's settlement.
      if (path !== "/v1/health") expect(peaks.get(path), path).toBeLessThanOrEqual(2);
    }
    await info.attach("projection-reads", { contentType: "application/json", body: JSON.stringify({
      elapsedSeconds, reads: Object.fromEntries(browserReads), peakConcurrentReads: Object.fromEntries(peaks),
    }) });
  } finally {
    if (!searchLane.closed) searchLane.disconnect();
  }
});
