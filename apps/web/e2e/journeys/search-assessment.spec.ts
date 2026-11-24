import { indeedPage } from "./indeed-data.js";
import { test, expect, json, action, completed, terminal } from "../harness/fixtures.js";
import { baseline, createBaseline, createPosting } from "./core-data.js";
import { serveRoleTarget } from "./discovery-role-scope-data.js";
import type { FitState } from "./fit-data.js";
import { servePostingAssessment, serveSavedAssessment, serveQualification } from "./search-assessment-data.js";
import { authoredPartition, retainedCapability, type NormalizedSnapshot } from "./consolidation-data.js";
import { modelSources, NORMALIZATION_PROMPT_VERSION, type CatalogContext } from "./requirements-data.js";
import { qualificationBindings } from "./qualification-data.js";
import { respondProducer, untilNormalization } from "./preparation-cohort-data.js";

function linkedinCard(id: number) {
  return `<div class="base-search-card"><a class="base-card__full-link" href="https://www.linkedin.com/jobs/view/synthetic-engineer-${id}"><span class="sr-only">Synthetic Systems Engineer</span></a><h4 class="base-search-card__subtitle">Synthetic Board Company</h4></div>`;
}

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
  const secondDetail = await app.external.next();
  expect(secondDetail.path).toBe("/jobstreaming/linkedin/jobs/view/1235");
  secondDetail.raw("Private synthetic response", { status: 429, headers: { "Retry-After": "601" } });
  await serveSavedAssessment(app, library);

  const result = (await completed(api, started.runId)).result as { newJobIds: string[] };
  expect(result).toMatchObject({ status: "partial", newJobs: 1, observedJobs: 1,
    failures: [{ boards: ["linkedin"], code: "discovery_provider_rate_limited" }],
    preparation: { status: "succeeded", assessedJobs: 1, failedJobs: 0 } });
  const job = result.newJobIds[0]!;
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
    board: "linkedin", unitId: expect.any(String), phase: "detail", httpStatus: 429,
    leaseEpoch: 1, responses: { listing: 1, detail: 2, other: 0 }, elapsedMs: expect.any(Number),
    receivedAt: expect.any(String), retryAfterSeconds: 601,
  } }));
});

test("search retains a listing and makes no automatic posting fetch after LinkedIn throttles", async ({ api, app }) => {
  await createBaseline(api);
  const started = await action(api, "discovery.search", { queries: ["Synthetic systems engineer"], locations: ["Madrid"],
    boards: ["linkedin"], hoursOld: 0, newJobLimit: 2, resultsPerSite: 2 });
  const listing = await app.external.next();
  expect(listing.path).toContain("/jobstreaming/linkedin/jobs-guest/jobs/api/seeMoreJobPostings/search?");
  listing.raw(linkedinCard(1236) + '<div class="base-search-card"></div>'.repeat(9));
  for (let attempt = 0; attempt < 3; attempt++) {
    const next = await app.external.next({ timeout: 20_000 });
    expect(new URL(next.path, "http://localhost").searchParams.get("start")).toBe("10");
    next.raw("Too many requests", { status: 429, headers: { "Retry-After": "0" } });
  }
  const result = (await completed(api, started.runId)).result as { newJobIds: string[] };
  const job = result.newJobIds[0]!;
  expect(result).toMatchObject({ status: "partial", newJobs: 1,
    preparation: { assessedJobs: 0, failedJobs: 1, failures: [
      { jobId: job, stage: "enrich", code: "posting_check_deferred_source_rate_limited" },
    ] } });
  const run = await json<{ steps: unknown[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(run.steps).toContainEqual(expect.objectContaining({ jobId: job, stage: "enrich", status: "failed", postingRevision: 1 }));
  expect(app.external.calls.filter((call) => call.path === "/posting-page" || call.path === "/model")).toHaveLength(0);
  const throttle = await json<{ events: { payload: unknown }[] }>(api, "get",
    `/v1/events?aggregateId=${started.runId}&type=DiscoverySourceRateLimited`);
  expect(throttle.events.map((event) => event.payload)).toEqual([4, 3, 2].map((listing) => expect.objectContaining({
    phase: "listing", responses: { listing, detail: 0, other: 0 }, retryAfterSeconds: 0,
  })));

  const retry = await action(api, "preparation.retry", { run_id: started.runId });
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
    const replacement = await app.restartWorker();
    expect(replacement.current).not.toBe(replacement.previous);
    await expect.poll(() => call.closed).toBe(true);
    expect(await json(api, "post", `/v1/action-runs/${started.runId}/cancel`, {})).toMatchObject({ runId: started.runId, cancellationRequested: true });
    expect(await terminal(api, started.runId)).toMatchObject({ status: "cancelled" });
    await expect.poll(() => call.closed).toBe(true);
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
  for (;;) {
    const call = await app.external.next();
    respondProducer(call, authored);
    if (call.body?.["operation"] === "requirements.extract") break;
  }
  // Under the frozen positive-budget policy each producer settles serially.
  // A foreign extraction source refuses the first producer before the held,
  // safely recoverable second posting fetch.
  const held = await app.external.next();
  expect(held.path).toBe("/posting-page");
  expect(held.body).toEqual({ url: second.url });
  const frozen = await json<{ jobIds: string[]; executionPolicy: unknown; steps: { jobId: string; stage: string; status: string; errorCode: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(frozen.executionPolicy).toMatchObject({ version: "search-cohort-v1", producer_mode: "serial" });
  expect(frozen.jobIds).toHaveLength(2);
  const failed = frozen.steps.find((step) => step.stage === "requirements_extract")!;
  expect(failed).toMatchObject({ jobId: frozen.jobIds[0], status: "failed", errorCode: expect.any(String) });
  await page.goto("/jobs");
  const failedRow = page.getByRole("row").filter({ hasText: first.title });
  await expect(failedRow.getByRole("link", { name: "Requirements extraction failed" })).toHaveAttribute("href", `/runs/${started.runId}`);
  await expect(page.getByRole("row").filter({ hasText: second.title }).getByRole("link", { name: "Waiting for search checks" }))
    .toHaveAttribute("href", `/runs/${started.runId}`);
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect.poll(() => held.closed).toBe(true);
  const resumed = await app.external.next({ timeout: 45_000 });
  expect(resumed.path).toBe("/posting-page");
  expect(resumed.body).toEqual({ url: second.url });
  respondProducer(resumed, authored);
  for (;;) {
    const call = await app.external.next();
    if (call.body?.["operation"] === "requirements.match_catalog") {
      const input = call.body["context"] as CatalogContext;
      expect(input.incoming).toHaveLength(1);
      expect(input.incoming[0]!.job_id).toBe(frozen.jobIds[1]);
      call.reply(authoredPartition(call, [{ groupId: "later", memberIds: [input.incoming[0]!.member_id], category: "professional_experience", name: second.description, definition: second.description }],
        [{ groupId: "later", definition: second.description, jobIds: [frozen.jobIds[1]!] }]));
      break;
    }
    respondProducer(call, authored);
  }
  await serveQualification(app, library);
  const finished = await completed(api, started.runId);
  expect(finished["result"]).toMatchObject({ ok: false, status: "partial", preparation: { assessedJobs: 1, failedJobs: 1, failures: [{ jobId: failed.jobId, stage: "requirements_extract", code: failed.errorCode }] } });
  const retained = await json<{ jobIds: string[]; steps: unknown[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(retained.jobIds).toEqual(frozen.jobIds);
  expect(retained.steps).toContainEqual(failed);
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(1);
  expect((await json<FitState>(api, "get", `/v1/jobs/${frozen.jobIds[1]}/fit`)).current).toBe(true);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(1);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

test.describe("cohort final currentness guard", () => {
  test.use({ cohortBoundaryDebugger: true });

  test("search settles cohort consolidation before Fit, reuses identical demands and reports concurrent changes without replacing accepted scores", async ({ api, app, page }) => {
    const { library } = await createBaseline(api);
    const settings = await json<{ revision: number; settings: { newJobLimit: number } }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0 });
    const payload = { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }], newJobLimit: 2 };
    const started = await action(api, "discovery.search", payload);
    const first = { job_key: "cohort-first", url: "https://www.indeed.com/viewjob?jk=cohort-first", title: "Synthetic First Cohort Engineer", company: "Synthetic Cohort Company", description: "Maintain durable workflow recovery, including operational readiness.", location: "Madrid" };
    const second = { job_key: "cohort-second", url: "https://www.indeed.com/viewjob?jk=cohort-second", title: "Synthetic Second Cohort Engineer", company: "Synthetic Cohort Company", description: "Maintain operational readiness for durable workflow recovery.", location: "Madrid" };
    const source = await app.external.next();
    expect(source.path).toBe("/jobstreaming/indeed");
    source.respond(indeedPage({ jobs: [first, second], cursor: null, complete: true }));
    const matching = await untilNormalization(app, [first, second].map((row) => ({ ...row, demand: row.description })));
    const frozen = await json<{ cohortFrozen: boolean; jobIds: string[]; steps: { jobId: string; stage: string; status: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
    expect(frozen.cohortFrozen).toBe(true);
    expect(frozen.jobIds).toHaveLength(2);
    const cohort = frozen.jobIds;
    expect(frozen.steps.filter((step) => step.stage === "requirements_extract" && step.status === "succeeded")).toHaveLength(2);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(0);
    await page.goto("/jobs");
    const checkpoint = page.getByRole("region", { name: "Job search progress", exact: true }).getByLabel("Fit preparation progress", { exact: true });
    await expect(checkpoint).toHaveText("2 of 2 postings checked. Requirements checked for 2 of 2 jobs. Reconciling requirements across these jobs before Fit scoring.");
    const normalizedDemand = "Maintain operational readiness for durable workflow recovery.";
    const input = matching.body["context"] as CatalogContext;
    expect(input.incoming.map((row) => row.job_id).sort()).toEqual([...cohort].sort());
    matching.reply(authoredPartition(matching, [{ groupId: "recovery", memberIds: input.incoming.map((row) => row.member_id), category: "professional_experience", name: normalizedDemand, definition: normalizedDemand }],
      [{ groupId: "recovery", definition: normalizedDemand, jobIds: cohort }]));
    await serveQualification(app, library, { beforeQualification: async (call) => {
      // The actual qualification request follows both source-bound publications.
      await expect(checkpoint).toContainText("Checking your evidence against the requirements before publishing Fit scores.");
      const consolidated = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${cohort[0]}/requirements`);
      const sibling = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${cohort[1]}/requirements`);
      expect(consolidated.requirements[0]!.normalized_demand.definition).toBe(normalizedDemand);
      expect(sibling.requirements[0]!.requirement_id).toBe(consolidated.requirements[0]!.requirement_id);
      expect(sibling.requirements[0]!.normalized_demand.demand_fingerprint).toBe(consolidated.requirements[0]!.normalized_demand.demand_fingerprint);
      const bindings = qualificationBindings(call);
      expect(bindings).toMatchObject([{ requirement_id: consolidated.requirements[0]!.requirement_id,
        demand_fingerprint: consolidated.requirements[0]!.normalized_demand.demand_fingerprint }]);
      expect(modelSources(call).find((row) => row.source_id === bindings[0]!.source_id)?.text).toContain(normalizedDemand);
      const preparing = await json<{ steps: { jobId: string; stage: string; status: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
      expect(preparing.steps.filter((step) => step.stage === "requirements" && step.status === "succeeded")).toHaveLength(2);
      expect(preparing.steps.find((step) => step.jobId === cohort[1] && step.stage === "fit")?.status).toBe("pending");
    } });
    const settled = await completed(api, started.runId);
    expect(settled["result"]).toMatchObject({ ok: true, status: "completed", newJobIds: cohort,
      preparation: { status: "succeeded", assessedJobs: 2, failedJobs: 0, skippedJobs: 0 } });
    const accepted = await Promise.all(cohort.map((jobId) => json<FitState>(api, "get", `/v1/jobs/${jobId}/fit`)));
    for (const fit of accepted) expect(fit).toMatchObject({ current: true, stale_reasons: [], score: { score: 10 } });
    expect(accepted[0]!.score.assessments[0]!.assessment_id).toBe(accepted[1]!.score.assessments[0]!.assessment_id);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
    const afterSettings = await json<{ settings: { newJobLimit: number } }>(api, "get", "/v1/discovery/settings");
    expect(afterSettings.settings.newJobLimit).toBe(settings.settings.newJobLimit);
    await page.goto("/jobs");
    await expect(checkpoint).toHaveCount(0);
    for (const posting of [first, second]) {
      const row = page.getByRole("row").filter({ has: page.getByRole("link", { name: posting.title, exact: true }) });
      await expect(row.getByText("10/10", { exact: true })).toBeVisible();
    }

    // Observe the real final guard after both scores publish. A source edit in
    // this durable gap must leave the score tied to the last analyzed requirements.
    const changed = await action(api, "discovery.search", payload);
    const third = { job_key: "cohort-concurrent-first", url: "https://www.indeed.com/viewjob?jk=cohort-concurrent-first", title: "Synthetic Source Change Engineer", company: "Synthetic Cohort Company", description: "Operate source-owned incident response.", location: "Madrid" };
    const fourth = { job_key: "cohort-concurrent-second", url: "https://www.indeed.com/viewjob?jk=cohort-concurrent-second", title: "Synthetic Concurrent Sibling Engineer", company: "Synthetic Cohort Company", description: "Maintain documented deployment ownership.", location: "Madrid" };
    const laterSource = await app.external.next();
    expect(laterSource.path).toBe("/jobstreaming/indeed");
    laterSource.respond(indeedPage({ jobs: [third, fourth], cursor: null, complete: true }));
    const laterMatching = await untilNormalization(app, [third, fourth].map((row) => ({ ...row, demand: row.description })));
    const changedCohort = (await json<{ jobIds: string[] }>(api, "get", `/v1/preparation/runs/${changed.runId}`)).jobIds;
    expect(changedCohort).toHaveLength(2);
    const laterInput = laterMatching.body["context"] as CatalogContext;
    const originalRequirement = (await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${cohort[0]}/requirements`)).requirements[0]!;
    const retained = retainedCapability(laterMatching, originalRequirement.requirement_id, "recovery");
    const incoming = [third, fourth].map((row, index) => {
      const member = laterInput.incoming.find((entry) => entry.job_id === changedCohort[index]);
      expect(member).toBeTruthy();
      return { groupId: `new-${index}`, memberIds: [member!.member_id], category: "professional_experience" as const, name: row.description, definition: row.description };
    });
    laterMatching.reply(authoredPartition(laterMatching, [retained, ...incoming], [
      { groupId: "recovery", definition: normalizedDemand, jobIds: cohort, reuseDemandFingerprint: originalRequirement.normalized_demand.demand_fingerprint },
      ...[third, fourth].map((row, index) => ({ groupId: `new-${index}`, definition: row.description, jobIds: [changedCohort[index]!] })),
    ]));
    await serveQualification(app, library, { beforeQualification: async () => { await app.armCohortBoundaryPause(); } });
    await app.waitForCohortBoundaryPause();
    let beforeChange: FitState | undefined;
    try {
      beforeChange = await json<FitState>(api, "get", `/v1/jobs/${changedCohort[0]}/fit`);
      expect(beforeChange.current).toBe(true);
      expect((await json<FitState>(api, "get", `/v1/jobs/${changedCohort[1]}/fit`)).current).toBe(true);
      const posting = await json<{ revision: number }>(api, "get", `/v1/jobs/${changedCohort[0]}`);
      await json(api, "patch", `/v1/jobs/${changedCohort[0]}`, { expectedRevision: posting.revision, description: "The current posting now requires separately reviewed incident-command ownership." });
    } finally {
      await app.resumeCohortBoundary();
    }
    const partial = await completed(api, changed.runId);
    expect(partial["result"]).toMatchObject({ ok: false, status: "partial", acquisitionStatus: "completed",
      preparation: { status: "partial", assessedJobs: 1, failedJobs: 1, failures: [{ jobId: changedCohort[0], stage: "fit", code: expect.any(String) }] } });
    const after = await json<FitState>(api, "get", `/v1/jobs/${changedCohort[0]}/fit`);
    expect(after).toMatchObject({ current: true, requirements_current: false, stale_reasons: [] });
    expect(after.score).toEqual(beforeChange!.score);
    expect((await json<FitState>(api, "get", `/v1/jobs/${changedCohort[1]}/fit`)).current).toBe(true);
    for (const [index, jobId] of cohort.entries()) {
      const prior = await json<FitState>(api, "get", `/v1/jobs/${jobId}/fit`);
      expect(prior.current).toBe(true);
      expect(prior.score).toEqual(accepted[index]!.score);
    }
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(2);
    expect((await json<{ runs: unknown[] }>(api, "get", "/v1/action-runs?action=fit.refresh")).runs).toEqual([]);
  });
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
  const failing = await app.external.next();
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
