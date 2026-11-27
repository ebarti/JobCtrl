import { indeedPage } from "./indeed-data.js";
import { linkedinCard } from "./linkedin-data.js";
import { test, expect, json, action, completed, terminal, modelCall, type ApplicationStack, type ExternalCall } from "../harness/fixtures.js";
import { baseline, createBaseline, createPosting } from "./core-data.js";
import { serveRoleTarget } from "./discovery-role-scope-data.js";
import type { FitState } from "./fit-data.js";
import { servePostingAssessment, serveSavedAssessment } from "./search-assessment-data.js";
import type { NormalizedSnapshot } from "./consolidation-data.js";
import { catalogMatching, NORMALIZATION_PROMPT_VERSION } from "./requirements-data.js";
import { respondProducer } from "./preparation-cohort-data.js";

// Source pages and independent Fit actions may be at external boundaries simultaneously.
function externalStream(app: ApplicationStack, match: (call: ExternalCall) => boolean): ApplicationStack {
  return { ...app, external: { ...app.external, next: (options) => app.external.next({ ...options, match }) } };
}

const assessments = (app: ApplicationStack) => externalStream(app,
  (call) => !call.path.startsWith("/jobstreaming/") && call.body["operation"] !== "discovery.role_target_match");
const boardPage = (app: ApplicationStack) => app.external.next({ match: (call) => call.path === "/jobstreaming/indeed" });
const roleMatches = (app: ApplicationStack) => externalStream(app, (call) => call.body["operation"] === "discovery.role_target_match");

test("saved-role LinkedIn discovery fetches details only for new postings", async ({ api, app }) => {
  const { profile, library } = await createBaseline(api, { ...baseline,
    experience: { target_role: "Synthetic systems engineer", target_locations: "Madrid" } });
  const saved = await json<{ job_id: string; revision: number }>(api, "post", "/v1/jobs/capture", {
    url: "https://www.linkedin.com/jobs/view/1234", title: "Saved Synthetic Engineer",
    company: "Synthetic Board Company", description: "Previously accepted posting details.",
  });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 1 });

  const search = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  const listing = await app.external.next();
  expect(listing.path).toContain("/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search?");
  listing.raw(linkedinCard(1234) + linkedinCard(1235));
  const detail = await app.external.next();
  expect(detail.path).toBe("/jobstreaming/linkedin/jobs/view/1235");
  detail.raw('<div class="show-more-less-html__markup"><p>Maintain durable workflow recovery.</p></div>');
  await serveRoleTarget(app, "match");
  await serveSavedAssessment(app, library);

  const result = (await completed(api, search.runId)).result as { newJobIds: string[] };
  expect(result).toMatchObject({
    status: "completed", newJobs: 1, observedJobs: 2,
    jobIds: expect.arrayContaining([saved.job_id]),
    roleTargetObservations: { match: 1 },
    preparation: { status: "succeeded", assessedJobs: 1 },
  });
  expect(result.newJobIds).toHaveLength(1);
  expect(result.newJobIds).not.toContain(saved.job_id);
  expect(await json(api, "get", `/v1/jobs/${saved.job_id}`)).toMatchObject({
    revision: saved.revision, title: "Saved Synthetic Engineer", description: "Previously accepted posting details.",
  });
  expect((await app.discoveryCheckpoint(search.runId)).receipts).toEqual({ accepted: 2 });
  expect(app.external.calls.filter((call) => call.path.includes("/jobstreaming/linkedin/jobs/view/")).map((call) => call.path))
    .toEqual(["/jobstreaming/linkedin/jobs/view/1235"]);
  expect(app.external.calls.filter((call) => call.path === "/model" && call.body?.["operation"] === "discovery.role_target_match")).toHaveLength(1);
});

test("search assesses the exact saved LinkedIn detail after a later posting is throttled", async ({ api, app }) => {
  const { profile, library } = await createBaseline(api, { ...baseline,
    experience: { target_role: "Synthetic systems engineer", target_locations: "Madrid" } });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 2 });
  const started = await action(api, "discovery.search", { queries: [], locations: [], expectedProfileVersion: profile.profileVersion });
  const listing = await app.external.next();
  expect(listing.path).toContain("/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search?");
  listing.raw(linkedinCard(1234) + linkedinCard(1235));
  const firstDetail = await app.external.next();
  expect(firstDetail.path).toBe("/jobstreaming/linkedin/jobs/view/1234");
  const description = "Maintain durable workflow recovery.";
  firstDetail.raw(`<div class="show-more-less-html__markup"><p>${description}</p></div>`);
  await serveRoleTarget(app, "match");
  const secondDetail = await app.external.next({ match: (call) => call.path === "/jobstreaming/linkedin/jobs/view/1235" });
  expect(secondDetail.path).toBe("/jobstreaming/linkedin/jobs/view/1235");
  secondDetail.raw("Private synthetic response", { status: 429, headers: { "Retry-After": "601" } });
  await serveSavedAssessment(app, library);

  const jobs = await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs");
  expect(jobs.jobs).toHaveLength(1);
  const job = jobs.jobs[0]!.job_id;
  await expect.poll(async () => (await json<FitState>(api, "get", `/v1/jobs/${job}/fit`)).current).toBe(true);
  expect(await json(api, "get", `/v1/action-runs/${started.runId}`)).toMatchObject({ status: "running" });
  const posting = await json<{ revision: number }>(api, "get", `/v1/jobs/${job}`);
  expect(posting).toMatchObject({ content_state: "provider_detail", needs_enrichment: true, full_description: description });
  const run = await json<{ steps: unknown[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(run.steps).toContainEqual(expect.objectContaining({ jobId: job, stage: "enrich", status: "skipped",
    result: { skip: "saved_provider_detail", revision: posting.revision } }));
  const fit = await json<FitState>(api, "get", `/v1/jobs/${job}/fit`);
  expect(fit).toMatchObject({ current: true, score: { score: 10 } });
  expect(fit.score.assessments[0]!.provenance).toMatchObject({ receipt_id: expect.any(String), lane: "scoring" });
  expect(app.external.calls.filter((call) => call.path === "/posting-page")).toHaveLength(0);
  const throttle = await json<{ events: { occurredAt: string; payload: unknown }[] }>(api, "get",
    `/v1/events?aggregateId=${started.runId}&type=DiscoverySourceRateLimited`);
  expect(throttle.events).toHaveLength(1);
  expect(throttle.events[0]).toEqual(expect.objectContaining({ occurredAt: expect.any(String), payload: {
    board: "linkedin", unitId: expect.any(String), receiptKey: expect.stringMatching(/^jobstreaming:/), phase: "detail", httpStatus: 429,
    leaseEpoch: 1, responses: { listing: 1, detail: 2, other: 0 }, elapsedMs: expect.any(Number),
    receivedAt: expect.any(String), retryAfterSeconds: 601, retryAtEpochSeconds: expect.any(Number),
  } }));
  await json(api, "post", `/v1/action-runs/${started.runId}/cancel`, {});
  expect((await terminal(api, started.runId)).status).toBe("cancelled");
  expect((await json<FitState>(api, "get", `/v1/jobs/${job}/fit`)).score).toEqual(fit.score);
});

test("saved search checks each LinkedIn page before requesting the next with literal roles", async ({ api, app, page }) => {
  const { profile, library } = await createBaseline(api, { ...baseline, experience: {
    target_role: "Synthetic systems engineer", target_functions: "Synthetic workflow reliability",
    target_locations: "Madrid", target_work_models: "remote",
  } });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 100 });
  await page.goto("/jobs");
  const admitted = page.waitForResponse((response) => new URL(response.url()).pathname === "/v1/actions/discovery.search" && response.request().method() === "POST");
  await page.getByRole("button", { name: "Start search", exact: true }).click();
  const actionResponse = await admitted;
  expect(actionResponse.status()).toBe(202);
  const started = await actionResponse.json() as { runId: string };
  const listing = await app.external.next();
  const listingStart = performance.now();
  const listingParams = new URL(listing.path, "http://localhost").searchParams;
  expect(listingParams.get("keywords")).toBe("Synthetic systems engineer");
  expect(listingParams.get("location")).toBe("Madrid");
  expect(listingParams.get("f_WT")).toBe("2");
  listing.raw(linkedinCard(1237) + linkedinCard(1238) + '<div class="base-search-card"></div>'.repeat(8));
  const detail = await app.external.next();
  const detailStart = performance.now();
  expect(detail.path).toBe("/jobstreaming/linkedin/jobs/view/1237");
  expect(detailStart - listingStart).toBeGreaterThan(3500);
  detail.raw('<div class="show-more-less-html__markup"><p>Maintain durable workflow recovery.</p></div>');
  await serveRoleTarget(roleMatches(app), "match");
  const scoring = serveSavedAssessment(assessments(app), library);
  const secondDetail = await app.external.next({ match: (call) => call.path === "/jobstreaming/linkedin/jobs/view/1238" });
  expect(secondDetail.path).toBe("/jobstreaming/linkedin/jobs/view/1238");
  secondDetail.raw('<div class="show-more-less-html__markup"><p>Review supplier contracts.</p></div>');
  await serveRoleTarget(roleMatches(app), "mismatch");
  const continuation = await app.external.next({ match: (call) => call.path.includes("/seeMoreJobPostings/search") });
  expect(new URL(continuation.path, "http://localhost").searchParams.get("start")).toBe("10");
  expect(performance.now() - detailStart).toBeGreaterThan(3500);
  continuation.raw("Too many requests", { status: 429 });
  const throttles = () => json<{ events: { payload: unknown }[] }>(api, "get", `/v1/events?aggregateId=${started.runId}&type=DiscoverySourceRateLimited`);
  await expect.poll(async () => (await throttles()).events.map((event) => event.payload)).toEqual([expect.objectContaining({
    phase: "listing", responses: { listing: 2, detail: 2, other: 0 }, retryAfterSeconds: null,
  })]);
  await scoring;
  const resumed = await app.external.next();
  expect(resumed.path).toBe(continuation.path);
  resumed.raw(linkedinCard(1237));
  expect((await completed(api, started.runId)).result).toMatchObject({ status: "completed", newJobs: 1,
    roleTargetObservations: { match: 1, mismatch: 1 },
    failures: [], preparation: { assessedJobs: 1 } });
  const plan = await json<{ accepted: { queries: unknown[]; provenance: unknown } }>(api, "get", "/v1/discovery/target-search");
  expect(plan.accepted).toMatchObject({ profileRevision: profile.profileVersion, provenance: null,
    queries: [{ query: "Synthetic systems engineer", authority: "literal_authored_target" }] });
  expect(app.external.calls.filter((call) => call.path.startsWith("/jobstreaming/linkedin"))).toHaveLength(5);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "discovery.query_plan")).toHaveLength(0);
});

test("search retains a listing and defers its posting check while LinkedIn is throttling", async ({ api, app }) => {
  await createBaseline(api);
  const started = await action(api, "discovery.search", { queries: ["Synthetic systems engineer"], locations: ["Madrid"],
    boards: ["linkedin"], hoursOld: 0, newJobLimit: 2, resultsPerSite: 2 });
  const listing = await app.external.next();
  expect(listing.path).toContain("/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search?");
  listing.raw(linkedinCard(1236) + '<div class="base-search-card"></div>'.repeat(9));
  let next = await app.external.next({ timeout: 20_000 });
  const earlierPostingCheck = next.path === "/posting-page";
  if (earlierPostingCheck) {
    // An independent child can reach its external read while the source is healthy.
    next.respond({}, 503);
    next = await app.external.next({ timeout: 20_000 });
  }
  expect(new URL(next.path, "http://localhost").searchParams.get("start")).toBe("10");
  next.raw("Too many requests", { status: 429, headers: { "Retry-After": "0" } });
  const resumed = await app.external.next();
  expect(resumed.path).toBe(next.path);
  resumed.raw(linkedinCard(1236));
  const result = (await completed(api, started.runId)).result as { newJobIds: string[] };
  const job = result.newJobIds[0]!;
  expect(result).toMatchObject({ status: "partial", acquisitionStatus: "completed", failures: [], newJobs: 1,
    preparation: { assessedJobs: 0, failedJobs: 1, failures: [
      { jobId: job, stage: "enrich", code: earlierPostingCheck ? "posting_fetch_unavailable" : "posting_check_deferred_source_rate_limited" },
    ] } });
  const run = await json<{ steps: unknown[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(run.steps).toContainEqual(expect.objectContaining({ jobId: job, stage: "enrich", status: "failed", postingRevision: 1 }));
  expect(app.external.calls.filter((call) => call.path === "/posting-page")).toHaveLength(Number(earlierPostingCheck));
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(0);
  const throttle = await json<{ events: { payload: unknown }[] }>(api, "get",
    `/v1/events?aggregateId=${started.runId}&type=DiscoverySourceRateLimited`);
  expect(throttle.events.map((event) => event.payload)).toEqual([expect.objectContaining({
    phase: "listing", responses: { listing: 2, detail: 0, other: 0 }, retryAfterSeconds: 0,
  })]);
  await expect.poll(async () => {
    const state = await json<{ runs: { runId: string; cooldowns: unknown[] }[] }>(api, "get", "/v1/discovery/runs");
    return state.runs.find((row) => row.runId === started.runId)?.cooldowns;
  }, { timeout: 15_000 }).toEqual([]);
  const retry = await action(api, "preparation.retry", { run_id: started.runId, job_ids: [job] });
  const manual = await app.external.next();
  expect(manual.path).toBe("/posting-page");
  manual.respond({}, 503);
  expect(await terminal(api, retry.runId)).toMatchObject({ status: "failed", errorCode: "preparation_partial" });
});

test("search reports a saved job's refused person fit separately from successful source acquisition", async ({ api, app, page }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1, resultsPerSite: 1 });
  await page.goto("/jobs");
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  const posting = { job_key: "refused-fit", url: "https://www.indeed.com/viewjob?jk=refused-fit", title: "Synthetic Refused Fit Engineer", company: "Synthetic Refusal Company", description: "Maintain durable workflow recovery.", location: "Madrid" };
  source.respond(indeedPage({ jobs: [posting], cursor: null, complete: true }));
  await servePostingAssessment(app, library, posting, { invalidEvidence: true });
  const settled = await completed(api, started.runId);
  const result = settled["result"] as { jobIds: string[]; preparation: { failures: { jobId: string; stage: string; code: string }[] } };
  expect(settled["result"]).toMatchObject({ ok: false, status: "partial", acquisitionStatus: "completed", newJobs: 1, observedJobs: 1, failures: [], preparationAvailable: true, preparation: { status: "partial", assessedJobs: 0, failedJobs: 1, failures: [{ jobId: result.jobIds[0], stage: "fit", code: expect.any(String) }] } });
  const fit = await json<{ score: null }>(api, "get", `/v1/jobs/${result.jobIds[0]}/fit`);
  expect(fit.score).toBeNull();
  const acquired = await json<{ runs: { runId: string; status: string }[] }>(api, "get", "/v1/discovery/runs");
  expect(acquired.runs.find((run) => run.runId === started.runId)?.status).toBe("completed");
  const preparation = await json<{ steps: { stage: string; status: string; errorCode: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(preparation.steps.find((step) => step.stage === "fit")).toMatchObject({ status: "failed", errorCode: result.preparation.failures[0]!.code });
  const progress = page.getByRole("region", { name: "Job search progress", exact: true });
  await expect(progress.getByRole("heading", { name: "Search completed · some fit assessments unavailable", exact: true })).toBeVisible();
  await expect(progress).toContainText(/0 (?:of 1 )?jobs assessed · 1 failed/);
  const row = page.getByRole("row").filter({ hasText: posting.title });
  await expect(row.getByRole("link", { name: "Fit assessment failed" })).toHaveAttribute("href", `/runs/${started.runId}`);
  await row.getByRole("link", { name: posting.title, exact: true }).click();
  const panel = page.getByRole("region", { name: "Person fit", exact: true });
  await expect(panel).toContainText(result.preparation.failures[0]!.code);
  await expect(panel.getByRole("link", { name: "View preparation run" })).toHaveAttribute("href", `/runs/${started.runId}`);
});

test("a refused first posting check explains unassessed Fit only for the revision submitted to the run", async ({ api, app, page }) => {
  await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1, resultsPerSite: 1 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  const job = { job_key: "refused-first-check", url: "https://www.indeed.com/viewjob?jk=refused-first-check",
    title: "Synthetic Posting Check Engineer", company: "Synthetic Company", description: "An original posting.", location: "Madrid" };
  source.respond(indeedPage({ jobs: [job], complete: true, cursor: null }));
  const fetch = await app.external.next();
  expect(fetch.path).toBe("/posting-page");
  fetch.respond({}, 503);
  const outcome = (await completed(api, started.runId))["result"] as { jobIds: string[] };
  const id = outcome.jobIds[0]!;
  const run = await json<{ steps: { jobId: string; stage: string; status: string; postingRevision?: number }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(run.steps).toContainEqual(expect.objectContaining({ jobId: id, stage: "enrich", status: "failed", postingRevision: 1, errorCode: "posting_fetch_unavailable" }));
  await page.goto("/jobs");
  const row = page.getByRole("row").filter({ hasText: job.title });
  await expect(row.getByRole("link", { name: "Posting check failed" })).toHaveAttribute("href", `/runs/${started.runId}`);
  await row.getByRole("link", { name: job.title, exact: true }).click();
  const panel = page.getByRole("region", { name: "Person fit", exact: true });
  await expect(panel).toContainText("Posting check failed (posting_fetch_unavailable).");
  const revised = await json<{ job_id: string; revision: number }>(api, "post", "/v1/jobs/capture", {
    url: job.url, title: job.title, company: job.company, description: "A different posting replaces the earlier content.",
  });
  expect(revised.job_id).toBe(id);
  expect(revised.revision).toBeGreaterThan(1);
  await expect(panel).toContainText("No person-fit assessment has been recorded yet.");
  expect(app.external.calls.filter((call) => call.path === "/model")).toHaveLength(0);
});

test("explicit saved-job assessment recovers fit without acquisition and preserves accepted scores at the manual-refresh fence", async ({ api, app, page }, testInfo) => {
  const { library } = await createBaseline(api);
  const posting = await createPosting(api, "explicit-assessment");
  const missingSelection = await action(api, "preparation.run", { recipe: "assess", scope: "pending" });
  expect(await terminal(api, missingSelection.runId)).toMatchObject({ status: "failed", errorCode: "explicit_job_selection_required" });
  expect(app.external.calls.filter((call) => call.path !== "/catalog")).toEqual([]);

  const started = await action(api, "preparation.run", { recipe: "assess", job_ids: [posting.job_id], scope: "selected" });
  await serveSavedAssessment(app, library, { beforeQualification: async () => {
    await page.goto(`/jobs/${posting.job_id}`);
    const assessment = page.getByRole("region", { name: "Assess fit", exact: true });
    await expect(assessment).toBeVisible();
    await expect(assessment.getByRole("button", { name: "Assessing fit…", exact: true })).toBeDisabled();
    await expect(assessment.getByRole("combobox", { name: "Resume to prepare", exact: true })).toHaveCount(0);
    await expect(assessment).toContainText("Fit assessment running · fit.");
    await expect(assessment).toContainText("No resume is generated by this task.");
    await expect(page.getByRole("region", { name: "Prepare resume", exact: true })).toHaveCount(0);
    await testInfo.attach("selected-job-assessing-fit", { contentType: "image/png", body: await page.screenshot() });
  } });
  await completed(api, started.runId);
  const preparation = page.getByRole("region", { name: "Prepare resume", exact: true });
  await expect(preparation.getByRole("button", { name: "Prepare resume", exact: true })).toBeEnabled();
  await expect(preparation.getByRole("combobox", { name: "Resume to prepare", exact: true })).toBeVisible();
  await expect(preparation).toContainText("Fit assessment complete.");
  await preparation.locator("summary").filter({ hasText: /^Preparation options and history$/ }).click();
  const history = preparation.getByRole("region", { name: "Preparation runs", exact: true });
  await expect(history.getByText("Assess selected jobs", { exact: true })).toBeVisible();
  await history.getByRole("button", { name: /^Assess selected jobs/ }).click();
  const outcomes = history.locator(".preparation-run-row__outcomes");
  await expect(outcomes.getByText("fit", { exact: true })).toBeVisible();
  const fitStep = outcomes.locator(".preparation-run-outcomes__steps > li").filter({ has: page.getByText("fit", { exact: true }) });
  await expect(fitStep).toHaveCount(1);
  await expect(fitStep.getByText("Succeeded", { exact: true })).toBeVisible();
  await expect(outcomes.getByText("Job 1 · fit 10", { exact: true })).toBeVisible();
  await outcomes.locator("summary").filter({ hasText: /^Technical details$/ }).click();
  await expect(outcomes.getByRole("link", { name: posting.job_id, exact: true })).toBeVisible();
  const accepted = await json<FitState>(api, "get", `/v1/jobs/${posting.job_id}/fit`);
  expect(accepted.current).toBe(true);
  expect(accepted.score.score).toBe(10);
  expect(accepted.score.assessments[0]!.provenance).toMatchObject({ receipt_id: expect.any(String), provider: "codex", model: expect.any(String), lane: "scoring" });
  const requirements = await json<{ requirements: { requirement_id: string }[] }>(api, "get", `/v1/jobs/${posting.job_id}/requirements`);

  const refresh = await action(api, "preparation.run", { recipe: "assess", job_ids: [posting.job_id], scope: "selected", force: true });
  await serveSavedAssessment(app, library, { requirementId: requirements.requirements[0]!.requirement_id, qualificationExpected: false });
  expect(await terminal(api, refresh.runId)).toMatchObject({ status: "failed", errorCode: "preparation_partial" });
  const retained = await json<FitState>(api, "get", `/v1/jobs/${posting.job_id}/fit`);
  expect(retained.score).toEqual(accepted.score);
  const refused = await json<{ steps: { stage: string; status: string; errorCode: string }[] }>(api, "get", `/v1/preparation/runs/${refresh.runId}`);
  expect(refused.steps.find((step) => step.stage === "fit")).toMatchObject({ status: "failed", errorCode: "fit_refresh_required" });
  const runRows = history.locator(".preparation-run-row");
  await expect(runRows).toHaveCount(2);
  await history.locator('.preparation-run-row__toggle[aria-expanded="true"]').click();
  await runRows.nth(0).getByRole("button", { name: /^Assess selected jobs/ }).click();
  await expect(history.locator('.preparation-run-row__toggle[aria-expanded="true"]')).toHaveCount(1);
  await runRows.nth(1).getByRole("button", { name: /^Assess selected jobs/ }).click();
  await expect(history.locator('.preparation-run-row__toggle[aria-expanded="true"]')).toHaveCount(1);
  await expect(history.locator(".preparation-run-row__outcomes")).toHaveCount(1);
  await expect(runRows.nth(0).getByRole("button", { name: /^Assess selected jobs/ })).toHaveAttribute("aria-expanded", "false");
  expect(app.external.calls.some((call) => call.path === "/jobstreaming/indeed" || call.path === "/posting-page")).toBe(false);
  expect(app.external.calls.filter(call => call.body["operation"] === "requirements.match_catalog")
    .map(call => call.body["prompt_version"])).toEqual([NORMALIZATION_PROMPT_VERSION, NORMALIZATION_PROMPT_VERSION]);
  const operations = app.external.calls.filter((call) => call.path === "/model").map((call) => String(call.body["operation"]));
  expect(operations.filter((operation) => operation === "fit.qualification-batch")).toHaveLength(1);
  expect(operations.some((operation) => operation.startsWith("fit.coverage") || operation.startsWith("profile.wording") || operation.startsWith("resumes."))).toBe(false);
  expect((await json<{ runs: unknown[] }>(api, "get", "/v1/action-runs?action=fit.refresh")).runs).toEqual([]);
  expect((await json<{ resumes: unknown[] }>(api, "get", `/v1/resumes?jobId=${posting.job_id}`)).resumes).toEqual([]);

  const cohort: { job_id: string }[] = [];
  for (const index of [1, 2]) cohort.push(await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
    url: `https://www.indeed.com/viewjob?jk=completed-cohort-${index}`, title: `Synthetic Cohort Engineer ${index}`,
    company: "Synthetic Cohort Company", description: `Maintain synthetic cohort ${index} recovery ownership.`,
  }));
  const cohortRun = await action(api, "preparation.run", { recipe: "assess", job_ids: cohort.map((row) => row.job_id), scope: "selected" });
  await serveSavedAssessment(app, library);
  await serveSavedAssessment(app, library, { beforeQualification: async () => {
    await page.goto(`/jobs/${cohort[0]!.job_id}`);
    const assessment = page.getByRole("region", { name: "Assess fit", exact: true });
    await expect(assessment.getByRole("button", { name: "Fit assessed for this job", exact: true })).toBeDisabled();
    await expect(assessment).toContainText("This job’s fit assessment is complete. Other jobs in this run are still being assessed.");
    await expect(assessment.getByRole("button", { name: "Stop fit assessment for 2 jobs", exact: true })).toBeVisible();
    await testInfo.attach("completed-job-active-fit-cohort", { contentType: "image/png", body: await assessment.screenshot({ animations: "disabled" }) });
  } });
  await completed(api, cohortRun.runId);
});

test("search cancellation after a worker kill during fit seals preparation and retains the exact saved cohort", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1, resultsPerSite: 1 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  const posting = { job_key: "cancelled-fit", url: "https://www.indeed.com/viewjob?jk=cancelled-fit", title: "Synthetic Cancelled Fit Engineer", company: "Synthetic Cancellation Company", description: "Maintain durable workflow recovery.", location: "Madrid" };
  source.respond(indeedPage({ jobs: [posting], cursor: null, complete: true }));
  let cohort: string[] = [];
  await servePostingAssessment(app, library, posting, { beforeQualification: async (call) => {
    const preparing = await json<{ cohortFrozen: boolean; jobIds: string[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
    expect(preparing.cohortFrozen).toBe(true);
    expect(preparing.jobIds).toHaveLength(1);
    cohort = preparing.jobIds;
    // Once restarted, the worker can immediately settle the lost provider reply.
    // Request cancellation while the old worker has exited and the search is still active.
    const replacement = await app.restartWorker(undefined, async () => {
      await expect.poll(() => call.closed).toBe(true);
      expect(await json(api, "post", `/v1/action-runs/${started.runId}/cancel`, {})).toMatchObject({ runId: started.runId, cancellationRequested: true });
    });
    expect(replacement.current).not.toBe(replacement.previous);
    expect(await terminal(api, started.runId)).toMatchObject({ status: "cancelled" });
  } });
  const retained = await json<{ status: string; jobIds: string[]; steps: { stage: string; status: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(retained.status).toBe("cancelled");
  expect(retained.jobIds).toEqual(cohort);
  expect(retained.steps.find((step) => step.stage === "requirements")).toMatchObject({ status: "succeeded" });
  expect((await json<{ score: null }>(api, "get", `/v1/jobs/${cohort[0]}/fit`)).score).toBeNull();
  expect((await json<{ requirements: unknown[] }>(api, "get", `/v1/jobs/${cohort[0]}/requirements`)).requirements).toHaveLength(1);
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(1);
  const spend = (await json<{ llmSpend: { costStatus: string; unresolvedCalls: number; costUsd: number | null } }>(api, "get", "/v1/health")).llmSpend;
  expect(spend).toMatchObject({ costStatus: "unresolved", unresolvedCalls: 1, costUsd: null });
});

test("search replay preserves a failed job while a replacement worker finishes the frozen later job", async ({ api, app, page }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2, resultsPerSite: 2 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const first = { job_key: "replay-failed", url: "https://www.indeed.com/viewjob?jk=replay-failed", title: "Synthetic First Replay Engineer", company: "Synthetic Replay Company", description: "Maintain first-job workflow recovery.", location: "Madrid" };
  const second = { job_key: "replay-later", url: "https://www.indeed.com/viewjob?jk=replay-later", title: "Synthetic Later Replay Engineer", company: "Synthetic Replay Company", description: "Maintain later-job workflow recovery.", location: "Madrid" };
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: [first, second], cursor: null, complete: true }));
  const authored = [{ ...first, demand: first.description, foreignExtractionSource: true }, { ...second, demand: second.description }];
  const held = await app.external.next({ match: (call) => call.path === "/posting-page" && call.body["url"] === second.url });
  for (;;) {
    const call = await assessments(app).external.next();
    respondProducer(call, authored);
    if (call.body["operation"] === "requirements.extract") break;
  }
  const state = () => json<{ jobIds: string[]; executionPolicy: unknown; steps: { jobId: string; stage: string; status: string; errorCode: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  await expect.poll(async () => (await state()).steps.find((step) => step.stage === "requirements" && step.status === "failed")?.errorCode).toBeTruthy();
  const frozen = await state();
  expect(frozen.executionPolicy).toMatchObject({ version: "search-jobs-v1" });
  expect(frozen.jobIds).toHaveLength(2);
  const failed = frozen.steps.find((step) => step.stage === "requirements" && step.status === "failed")!;
  expect(failed.jobId).toBeTruthy();
  await page.goto("/jobs");
  const failedRow = page.getByRole("row").filter({ hasText: first.title });
  await expect(failedRow.getByRole("link", { name: "Requirements check failed" })).toHaveAttribute("href", `/runs/${started.runId}`);
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect.poll(() => held.closed).toBe(true);
  const resumed = await app.external.next({ timeout: 45_000 });
  expect(resumed.path).toBe("/posting-page");
  expect(resumed.body).toEqual({ url: second.url });
  await servePostingAssessment(assessments(app), library, second, { pageRequest: resumed });
  const finished = await completed(api, started.runId);
  expect(finished["result"]).toMatchObject({ ok: false, status: "partial", preparation: { assessedJobs: 1, failedJobs: 1, failures: [{ jobId: failed.jobId, stage: "requirements", code: failed.errorCode }] } });
  const retained = await json<{ jobIds: string[]; steps: unknown[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(retained.jobIds).toEqual(frozen.jobIds);
  expect(retained.steps).toContainEqual(failed);
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(1);
  const sibling = frozen.jobIds.find((id) => id !== failed.jobId)!;
  expect((await json<FitState>(api, "get", `/v1/jobs/${sibling}/fit`)).current).toBe(true);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(1);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

test("search reuses an already checked demand and reports a source edit before final settlement", async ({ api, app, page }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number; settings: { newJobLimit: number } }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: ["Madrid"], newJobLimit: 3 });
  const first = { job_key: "demand-first", url: "https://www.indeed.com/viewjob?jk=demand-first", title: "First Synthetic Engineer",
    company: "Synthetic Company", description: "Maintain durable workflow recovery.", location: "Madrid" };
  const second = { ...first, job_key: "demand-second", url: "https://www.indeed.com/viewjob?jk=demand-second", title: "Second Synthetic Engineer" };
  const saved = async (url: string) => {
    const state = await json<{ jobs: { job_id: string; url: string }[] }>(api, "get", "/v1/jobs");
    return state.jobs.find((job) => job.url === url)!.job_id;
  };
  (await boardPage(app)).respond(indeedPage({ jobs: [first], cursor: "owned-next", complete: false }));
  const next = await boardPage(app);
  const worker = assessments(app);
  await servePostingAssessment(worker, library, first);
  const firstId = await saved(first.url);
  await expect.poll(async () => (await json<FitState>(api, "get", `/v1/jobs/${firstId}/fit`)).current).toBe(true);
  const original = await json<FitState>(api, "get", `/v1/jobs/${firstId}/fit`);
  const requirement = (await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${firstId}/requirements`)).requirements[0]!;
  expect(await json(api, "get", `/v1/action-runs/${started.runId}`)).toMatchObject({ status: "running" });

  next.respond(indeedPage({ jobs: [second], cursor: "owned-final", complete: false }));
  const finalPage = await boardPage(app);
  for (const expected of ["/posting-page", "page_interpretation", "posting_extraction", "description_quality"]) {
    const call = await worker.external.next();
    expect(call.path === "/model" ? call.body["operation"] : call.path).toBe(expected);
    respondProducer(call, [second]);
  }
  const matching = await modelCall(worker, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { capability: { verdict: "equivalent", requirementId: requirement.requirement_id } }));
  const secondId = await saved(second.url);
  await expect.poll(async () => (await json<FitState>(api, "get", `/v1/jobs/${secondId}/fit`)).current).toBe(true);
  const peer = await json<FitState>(api, "get", `/v1/jobs/${secondId}/fit`);
  expect(peer.score.assessments[0]).toMatchObject({
    assessment_id: original.score.assessments[0]!.assessment_id,
    provenance: { receipt_id: original.score.assessments[0]!.provenance.receipt_id },
  });
  const peerRequirement = (await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${secondId}/requirements`)).requirements[0]!;
  expect(peerRequirement.requirement_id).toBe(requirement.requirement_id);
  expect(peerRequirement.normalized_demand.demand_fingerprint).toBe(requirement.normalized_demand.demand_fingerprint);
  await page.goto("/jobs");
  for (const posting of [first, second]) {
    const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: posting.title, exact: true }) });
    await expect(row.getByText("10/10", { exact: true })).toBeVisible();
  }

  // Both scores are accepted while the source still holds its final page.
  // The ordinary completion guard must observe this concurrent posting edit.
  const revision = (await json<{ revision: number }>(api, "get", `/v1/jobs/${firstId}`)).revision;
  await json(api, "patch", `/v1/jobs/${firstId}`, { expectedRevision: revision,
    description: "The current posting now requires separately reviewed incident-command ownership." });
  finalPage.respond(indeedPage({ jobs: [], cursor: null, complete: true }));
  expect((await completed(api, started.runId)).result).toMatchObject({ status: "partial", acquisitionStatus: "completed", newJobs: 2,
    preparation: { assessedJobs: 1, failedJobs: 1, failures: [{ jobId: firstId, stage: "fit", code: expect.any(String) }] } });
  const retained = await json<FitState>(api, "get", `/v1/jobs/${firstId}/fit`);
  expect(retained.requirements_current).toBe(false);
  expect(retained.score).toEqual(original.score);
  expect((await json<FitState>(api, "get", `/v1/jobs/${secondId}/fit`)).score).toEqual(peer.score);
  expect(app.external.calls.filter((call) => call.body["operation"] === "fit.qualification-batch")).toHaveLength(1);
  expect((await json<{ settings: { newJobLimit: number } }>(api, "get", "/v1/discovery/settings")).settings.newJobLimit).toBe(settings.settings.newJobLimit);
});

test("search assesses retained new jobs after every source fails and preserves the canonical failed acquisition", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 5, resultsPerSite: 5 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const posting = { job_key: "retained-after-source-failure", url: "https://www.indeed.com/viewjob?jk=retained-after-source-failure", title: "Synthetic Retained Engineer", company: "Synthetic Retained Company", description: "Maintain retained-job workflow recovery.", location: "Madrid" };
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: [posting], cursor: "unfinished-source", complete: false }));
  const failing = await boardPage(app);
  expect(failing.path).toBe("/jobstreaming/indeed");
  failing.respond({ error: "controlled_external_provider_unavailable" }, 401);
  await servePostingAssessment(app, library, posting);
  const finished = await completed(api, started.runId);
  const outcome = finished["result"] as { jobIds: string[]; failures: { code: string }[] };
  expect(outcome).toMatchObject({ ok: false, status: "partial", acquisitionStatus: "failed", newJobs: 1, preparation: { status: "succeeded", assessedJobs: 1, failedJobs: 0, failures: [] } });
  expect(outcome.failures).toHaveLength(1);
  const recorded = await json<{ runs: { runId: string; status: string; failures: { code: string }[] }[] }>(api, "get", "/v1/discovery/runs");
  expect(recorded.runs.find((run) => run.runId === started.runId)).toMatchObject({ status: "failed", failures: outcome.failures });
  expect((await json<FitState>(api, "get", `/v1/jobs/${outcome.jobIds[0]}/fit`)).score.score).toBe(10);
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(2);
});
