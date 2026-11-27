import type { APIRequestContext } from "@playwright/test";
import { indeedPage } from "./indeed-data.js";
import { createHash } from "node:crypto";
import { test, expect, json, action, completed, modelCall, terminal, type ApplicationStack } from "../harness/fixtures.js";
import { acceptReuseRequirements, captureReusePosting, type CapturedPosting } from "./reuse-data.js";
import { createBaseline, type Profile } from "./core-data.js";
import { createScoredFit, type FitState } from "./fit-data.js";
import { servePostingAssessment } from "./search-assessment-data.js";
import { readCatalog, type NormalizedSnapshot } from "./consolidation-data.js";
import { catalogContext, catalogMatching, memberRoots, normalizationFingerprint, typedExtraction } from "./requirements-data.js";
import { COMMON_DEMAND, posting, respondProducer, type CohortPosting } from "./preparation-cohort-data.js";
import { qualificationBatchDecision, qualificationBindings } from "./qualification-data.js";

test.describe("accepted posting and run history migration", () => {
  test.use({ sqlitePredecessor: true });

  test("SQLite import retains accepted posting detail and original search history before rediscovery", async ({ api, app }) => {
    const { posting, fit } = await createScoredFit(api, app, "preserve-imported-detail", { postingUrl: "https://www.indeed.com/viewjob?jk=preserve-imported-detail" });
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1 });
    const jobPath = `/v1/jobs/${posting.job_id}`;
    const detail = await json<{ revision: number; source_hash: string; description: string; content_state: string }>(api, "get", jobPath);
    expect(detail.content_state).toBe("accepted_detail");
    const savedRequirements = await json<NormalizedSnapshot>(api, "get", `${jobPath}/requirements`);
    const payload = { queries: ["Synthetic engineer"], locations: [{ location: "Madrid", remote: true }] };

    async function serveListing() {
      const source = await app.external.next();
      expect(source.path).toBe("/jobstreaming/indeed");
      source.respond(indeedPage({ complete: true, cursor: null, jobs: [{
        job_key: "preserve-imported-detail", url: posting.url, title: posting.title, company: posting.company,
        location: "Madrid", description: "A short search result summary.",
      }] }));
    }

    // The supported SQLite predecessor still exposes the public synchronous
    // action CLI. It writes canonical history without recreating Temporal.
    const predecessor = app.cli(["action", "discovery.search", "--data", JSON.stringify(payload)]);
    await serveListing();
    const previous = await predecessor;
    expect(previous.exitCode, previous.stderr).toBe(0);
    const previousResult = JSON.parse(previous.stdout) as { runId: string; newJobs: number };
    expect(previousResult).toMatchObject({ runId: expect.any(String), newJobs: 0 });
    const actionPath = `/v1/action-runs/${previousResult.runId}`;
    const before = await json<{ runId: string; workflowId: string; status: string; result: unknown }>(api, "get", actionPath);
    expect(before).toMatchObject({ status: "succeeded", result: previousResult });
    const previousPreparation = await json<{ jobIds: string[]; steps: unknown[] }>(api, "get", `/v1/preparation/runs/${before.runId}`);
    const lastObservations = await json<{ snapshots: unknown[]; observations: { run_id: string | null; posting_revision: number }[] }>(api, "get", `${jobPath}/snapshots`);
    expect(lastObservations.observations).toContainEqual(expect.objectContaining({ run_id: before.runId, posting_revision: detail.revision }));
    expect(await json(api, "get", jobPath)).toEqual(detail);

    const callsBeforeImport = app.external.calls.length;
    const imported = await app.upgradeSqliteToPostgres();
    expect(imported.first.state).toBe("active");
    expect(imported.repeated).toEqual(imported.first);
    expect(await json(api, "get", actionPath)).toMatchObject({ runId: before.runId, workflowId: before.workflowId, status: before.status, result: before.result });
    expect(await json(api, "get", `/v1/preparation/runs/${before.runId}`)).toMatchObject({
      jobIds: previousPreparation.jobIds,
      steps: previousPreparation.steps,
    });
    expect(await json(api, "get", `${jobPath}/snapshots`)).toEqual(lastObservations);
    expect(await json(api, "get", jobPath)).toEqual(detail);
    expect(await json(api, "get", `${jobPath}/requirements`)).toEqual(savedRequirements);
    expect(await json<FitState>(api, "get", `${jobPath}/fit`)).toMatchObject({
      current: true, requirements_current: true, stale_reasons: [], score: fit.score,
    });
    expect(app.external.calls).toHaveLength(callsBeforeImport);

    const next = await action(api, "discovery.search", payload);
    await serveListing();
    expect((await completed(api, next.runId)).result).toMatchObject({ newJobs: 0, observedJobs: 1 });
    expect(await json(api, "get", jobPath)).toEqual(detail);
    const observed = await json<typeof lastObservations>(api, "get", `${jobPath}/snapshots`);
    expect(observed.snapshots).toEqual(lastObservations.snapshots);
    expect(observed.observations.filter((row) => row.run_id !== null)).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: before.runId, posting_revision: detail.revision }),
      expect.objectContaining({ run_id: next.runId, posting_revision: detail.revision }),
    ]));
    expect(app.external.calls.slice(callsBeforeImport).map((call) => call.path)).toEqual(["/jobstreaming/indeed"]);
  });
});

const refreshJob = (api: APIRequestContext, job: CapturedPosting) => action(api, "requirements.refresh", {
  job_id: job.job_id, expected_posting_revision: job.revision, expected_revision: 0,
});
const requirementsAttempt = (api: APIRequestContext, jobId: string) =>
  json(api, "get", `/v1/jobs/${jobId}/requirements/attempts/latest`);
const firstFit = (api: APIRequestContext, jobId: string) =>
  api.post(`/v1/jobs/${jobId}/fit/assess`, { data: { expected_revision: 0, prepare_wording: false, prepare_coverage: false } });
const modelCount = (app: ApplicationStack, operation: string) =>
  app.external.calls.filter(call => call.body["operation"] === operation).length;

test("an unresolved posting demand retains its extraction receipt and blocks Fit", async ({ api, app }) => {
  await createBaseline(api);
  const source = { ...posting(1), description: "Review incident reports using the protocol named in the appendix." };
  const job = await json<CapturedPosting>(api, "post", "/v1/jobs/capture", {
    url: source.url, title: source.title, company: source.company, description: source.description,
  });
  const run = await action(api, "preparation.run", { recipe: "assess", job_ids: [job.job_id], scope: "selected" });
  respondProducer(await modelCall(app, "jobs.role_analysis"), [source]);
  const extraction = await modelCall(app, "requirements.extract");
  const decision = typedExtraction(extraction, { status: "needs_review" });
  extraction.reply({ ...decision, unresolved: [{
    question: "Which review protocol is required?", reason: "The source does not include the referenced appendix.",
    evidence_refs: decision.language.evidence_refs,
  }] });
  expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: "preparation_partial" });
  const preparation = await json(api, "get", `/v1/preparation/runs/${run.runId}`);
  expect(preparation).toMatchObject({ steps: expect.arrayContaining([
    expect.objectContaining({ jobId: job.job_id, stage: "requirements", status: "failed",
      postingRevision: job.revision, errorCode: "extraction_uncertain" }),
    expect.objectContaining({ jobId: job.job_id, stage: "fit", status: "blocked", errorCode: "upstream_stage_failed" }),
  ]) });
  const receipts = await app.requirementsExtractionReceipts();
  expect(receipts).toMatchObject([{ status: "succeeded", inputFingerprint: normalizationFingerprint(extraction.body) }]);
  const attempt = await requirementsAttempt(api, job.job_id);
  expect(attempt).toMatchObject({ job_id: job.job_id, posting_revision: job.revision,
    expected_revision: 0, state: "blocked", failure_code: "extraction_uncertain" });
  expect(attempt.failure_details).toEqual({ receiptId: receipts[0]!.receiptId });
  expect(await json(api, "get", `/v1/jobs/${job.job_id}/requirements`)).toBeNull();
  expect(await json(api, "get", `/v1/jobs/${job.job_id}/fit`)).toMatchObject({ score: null });
  expect(app.external.calls.filter(call => call.path === "/model").map(call => call.body["operation"]))
    .toEqual(["jobs.role_analysis", "requirements.extract"]);
});

test("a refused extraction and cancellation settle only the corresponding Requirements attempts", async ({ api, app }) => {
  await createBaseline(api);
  const rejectedJob = await captureReusePosting(api, "refused-extraction", COMMON_DEMAND);
  const rejected = await refreshJob(api, rejectedJob);
  const extraction = await modelCall(app, "requirements.extract");
  const decision = typedExtraction(extraction, { requirements: [{ localId: "r1", text: COMMON_DEMAND }] });
  decision.requirements[0]!.evidence_refs = ["not-in-the-quote-inventory"];
  extraction.reply(decision);
  expect(await terminal(api, rejected.runId)).toMatchObject({ status: "failed", errorCode: "foreign_or_duplicate_evidence_id" });
  const refusal = await requirementsAttempt(api, rejectedJob.job_id);
  expect(refusal).toMatchObject({ attempt_id: rejected.runId, job_id: rejectedJob.job_id, state: "blocked",
    failure_code: "foreign_or_duplicate_evidence_id", completed_at: expect.any(String) });

  const acceptedJob = await captureReusePosting(api, "accepted-extraction-sibling", `${COMMON_DEMAND}\nReview the saved record monthly.`);
  const { snapshot } = await acceptReuseRequirements(api, app, acceptedJob,
    [{ localId: "r1", text: COMMON_DEMAND }], { r1: { verdict: "new" } });
  const accepted = await json(api, "get", `/v1/jobs/${acceptedJob.job_id}/requirements`);

  const cancelledJob = await captureReusePosting(api, "cancelled-extraction", "Run controlled operational reviews.");
  const stopped = await refreshJob(api, cancelledJob);
  const held = await modelCall(app, "requirements.extract");
  expect(await requirementsAttempt(api, cancelledJob.job_id)).toMatchObject({ attempt_id: stopped.runId,
    state: "running", failure_code: null, completed_at: null });
  await json(api, "post", `/v1/action-runs/${stopped.runId}/cancel`, {});
  expect(await terminal(api, stopped.runId)).toMatchObject({ status: "cancelled" });
  await expect.poll(() => held.closed).toBe(true);
  expect(await requirementsAttempt(api, cancelledJob.job_id)).toMatchObject({ attempt_id: stopped.runId, state: "cancelled",
    failure_code: "cancelled", completed_at: expect.any(String) });
  expect(await requirementsAttempt(api, rejectedJob.job_id)).toEqual(refusal);
  for (const job of [rejectedJob, cancelledJob]) expect(await json(api, "get", `/v1/jobs/${job.job_id}/requirements`)).toBeNull();
  expect(await json(api, "get", `/v1/jobs/${acceptedJob.job_id}/requirements`)).toEqual(accepted);
  const paid = await app.requirementsExtractionReceipts();
  expect(paid).toHaveLength(3);
  expect(paid).toEqual(expect.arrayContaining([
    expect.objectContaining({ status: "succeeded", inputFingerprint: normalizationFingerprint(extraction.body) }),
    expect.objectContaining({ status: "succeeded", receiptId: snapshot.requirements[0]!.extraction_determination_id }),
    expect.objectContaining({ status: "uncertain", inputFingerprint: normalizationFingerprint(held.body), costUsd: null }),
  ]));
  expect(modelCount(app, "requirements.extract")).toBe(3);
  expect(modelCount(app, "requirements.match_catalog")).toBe(1);
});

test("independent postings keep distinct occurrence IDs and share the canonical qualification receipt", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const achievement = library.roles[0]!.achievements[0]!;
  const scores: FitState["score"][] = [];
  const requirements: NormalizedSnapshot["requirements"][number][] = [];
  for (const index of [1, 2, 3]) {
    const job = await captureReusePosting(api, `independent-demand-${index}`, posting(index).description);
    const started = await refreshJob(api, job);
    const extraction = await modelCall(app, "requirements.extract");
    extraction.reply(typedExtraction(extraction, { requirements: [{ localId: "r1", text: COMMON_DEMAND }] }));
    const matching = await modelCall(app, "requirements.match_catalog");
    const input = catalogContext(matching);
    expect(input.incoming).toHaveLength(1);
    expect(input.incoming[0]).toMatchObject({ job_id: job.job_id, local_id: "r1" });
    const retained = requirements[0];
    const decision = catalogMatching(matching, {
      r1: retained ? { verdict: "equivalent", requirementId: retained.requirement_id } : { verdict: "new" },
    });
    matching.reply(decision);
    await completed(api, started.runId);
    const snapshot = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${job.job_id}/requirements`);
    const occurrence = snapshot.requirements[0]!;
    expect(snapshot.requirements).toHaveLength(1);
    expect(occurrence).toMatchObject({ local_id: "r1", job_id: job.job_id, source_hash: job.source_hash });
    if (retained) expect(occurrence).toMatchObject({ requirement_id: retained.requirement_id,
      normalized_demand: { demand_fingerprint: retained.normalized_demand.demand_fingerprint } });
    requirements.push(occurrence);
    const audit = await app.requirementsReconciliation(started.runId);
    expect(audit.selection).toEqual(decision);
    expect(audit.authority_receipt.value).toEqual(decision);
    expect(audit.stored_report.partition_binding).toMatchObject({ raw_selection_fingerprint: normalizationFingerprint(decision) });
    const pending = firstFit(api, job.job_id);
    if (!retained) {
      const qualification = await modelCall(app, "fit.qualification-batch");
      expect(qualificationBindings(qualification)).toMatchObject([{ requirement_id: occurrence.requirement_id,
        demand_fingerprint: occurrence.normalized_demand.demand_fingerprint }]);
      qualification.reply(qualificationBatchDecision(qualification, () => ({
        achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`],
      })));
    }
    const response = await pending;
    expect(response.status(), await response.text()).toBe(200);
    const fit = await json<FitState>(api, "get", `/v1/jobs/${job.job_id}/fit`);
    expect(fit).toMatchObject({ current: true, stale_reasons: [], score: { score: 10 } });
    scores.push(fit.score);
  }
  expect(new Set(requirements.map(row => row.occurrence_id)).size).toBe(3);
  expect(new Set(scores.map(row => row.assessments[0]!.assessment_id)).size).toBe(1);
  const receipts = await app.fitProviderReceipts();
  expect(receipts).toMatchObject([{ receiptId: scores[0]!.assessments[0]!.provenance.receipt_id, status: "succeeded" }]);
  for (const [index, row] of requirements.entries()) {
    expect((await json<FitState>(api, "get", `/v1/jobs/${row.job_id}/fit`)).score).toEqual(scores[index]);
  }
  expect(modelCount(app, "requirements.match_catalog")).toBe(3);
  expect(modelCount(app, "fit.qualification-batch")).toBe(1);
});

for (const fault of ["missing member", "foreign member", "foreign citation", "worker interruption"] as const) {
  const title = fault === "worker interruption" ? "worker interruption during normalization preserves accepted authority"
    : `per-job normalization refuses a ${fault} without publishing partial authority`;
  test(title, async ({ api, app }) => {
    const seed = await createScoredFit(api, app, `normalization-${fault.replaceAll(" ", "-")}`);
    const accepted = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`);
    const catalogBefore = await readCatalog(api);
    const job = await captureReusePosting(api, "normalization-refusal", COMMON_DEMAND);
    const started = await refreshJob(api, job);
    const extraction = await modelCall(app, "requirements.extract");
    extraction.reply(typedExtraction(extraction, { requirements: [{ localId: "r1", text: COMMON_DEMAND }] }));
    const matching = await modelCall(app, "requirements.match_catalog");
    const input = catalogContext(matching);
    expect(input.incoming).toHaveLength(1);
    expect(input.members).toEqual(expect.arrayContaining([expect.objectContaining({ requirement_id: accepted.requirements[0]!.requirement_id })]));
    const incoming = input.incoming[0]!.member_id;
    const invalid = catalogMatching(matching, { r1: { verdict: "new" } });
    if (fault === "missing member") delete invalid.member_slots[incoming];
    if (fault === "foreign member") invalid.member_slots["incoming:foreign-job:r1"] = structuredClone(invalid.member_slots[incoming]!);
    if (fault === "foreign citation") memberRoots(invalid)[0]!.slot.citations.push({ source_id: "foreign-source", segment_id: "foreign-segment" });
    const refusal = fault === "worker interruption" ? "requirements_consolidation_call_unsettled" : "model_schema_violation";
    if (fault === "worker interruption") {
      expect(await requirementsAttempt(api, job.job_id)).toMatchObject({ attempt_id: started.runId, state: "running" });
      const replacement = await app.restartWorker();
      expect(replacement.current).not.toBe(replacement.previous);
      await expect.poll(() => matching.closed).toBe(true);
    } else matching.reply(invalid);
    expect(await terminal(api, started.runId)).toMatchObject({ status: "failed", errorCode: refusal, cancellationRequested: false });
    expect(await requirementsAttempt(api, job.job_id)).toMatchObject({ attempt_id: started.runId, state: "blocked",
      failure_code: refusal, completed_at: expect.any(String) });
    expect(await json(api, "get", `/v1/jobs/${job.job_id}/requirements`)).toBeNull();
    expect((await json<{ score: null }>(api, "get", `/v1/jobs/${job.job_id}/fit`)).score).toBeNull();
    expect(await readCatalog(api)).toEqual(catalogBefore);
    expect(await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`)).toEqual(accepted);
    expect((await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(seed.fit.score);
    expect(modelCount(app, "requirements.match_catalog")).toBe(2);
    expect(modelCount(app, "fit.qualification-batch")).toBe(1);
  });
}

for (const fault of ["missing row", "foreign requirement", "foreign citation"] as const) {
  test(`qualification refuses a ${fault} without publishing a partial score`, async ({ api, app }) => {
    const seed = await createScoredFit(api, app, `qualification-${fault.replaceAll(" ", "-")}`);
    const secondDemand = "Check the assigned reviewer before authorizing a change.";
    const job = await captureReusePosting(api, "qualification-refusal", `${COMMON_DEMAND}\n${secondDemand}`);
    await acceptReuseRequirements(api, app, job,
      [{ localId: "r1", text: COMMON_DEMAND }, { localId: "r2", text: secondDemand }],
      { r1: { verdict: "new" }, r2: { verdict: "new" } });
    const normalized = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${job.job_id}/requirements`);
    expect(normalized.requirements).toHaveLength(2);
    const pending = firstFit(api, job.job_id);
    const batch = await modelCall(app, "fit.qualification-batch");
    const achievement = seed.library.roles[0]!.achievements[0]!;
    const invalid = qualificationBatchDecision(batch, () => ({ achievementIds: [achievement.achievement_id],
      evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] }));
    expect(invalid.requirements).toHaveLength(2);
    if (fault === "missing row") invalid.requirements.pop();
    if (fault === "foreign requirement") invalid.requirements[1]!.requirement_id = "unrequested-canonical-requirement";
    if (fault === "foreign citation") invalid.requirements[1]!.evidence = [{ source_id: "foreign-unowned-evidence", quote: "A source that was never supplied." }];
    const errors = {
      "missing row": "fit_qualification_partition_invalid", "foreign requirement": "fit_qualification_partition_invalid",
      "foreign citation": "fit_foreign_source_id",
    };
    batch.reply(invalid);
    const result = await pending;
    expect(result.ok(), await result.text()).toBe(false);
    expect(await result.json()).toMatchObject({ error: { code: errors[fault] } });
    expect(await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${job.job_id}/requirements`)).toEqual(normalized);
    expect((await json<{ score: null }>(api, "get", `/v1/jobs/${job.job_id}/fit`)).score).toBeNull();
    expect((await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(seed.fit.score);
    expect(modelCount(app, "fit.qualification-batch")).toBe(2);
  });
}

test("an unsupported-language posting is skipped while its English sibling is assessed", async ({ api, app, page }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  const english = posting(41);
  const spanish: CohortPosting = { ...posting(42), description: "Mantener la recuperación de los flujos de trabajo.", unsupported: true };
  const { unsupported: _fixtureOnly, ...spanishSource } = spanish;
  source.respond(indeedPage({ jobs: [english, spanishSource], cursor: null, complete: true }));
  const spanishPage = await app.external.next({ match: call => call.path === "/posting-page" && call.body["url"] === spanish.url });
  await servePostingAssessment(app, library, english);
  respondProducer(spanishPage, [spanish]);
  for (const operation of ["page_interpretation", "posting_extraction", "description_quality", "jobs.role_analysis", "requirements.extract"]) {
    respondProducer(await modelCall(app, operation), [spanish]);
  }
  const { jobs } = await json<{ jobs: { job_id: string; url: string }[] }>(api, "get", "/v1/jobs");
  expect(jobs).toHaveLength(2);
  const englishId = jobs.find(job => job.url === english.url)!.job_id;
  const spanishId = jobs.find(job => job.url === spanish.url)!.job_id;
  expect((await completed(api, started.runId))["result"]).toMatchObject({ ok: true, status: "completed", preparation: {
    status: "succeeded", assessedJobs: 1, failedJobs: 0, skippedJobs: 1,
    skipped: [{ jobId: spanishId, reason: "unsupported_posting_language" }],
  } });
  expect((await json<FitState>(api, "get", `/v1/jobs/${englishId}/fit`)).current).toBe(true);
  expect((await json<{ score: null }>(api, "get", `/v1/jobs/${spanishId}/fit`)).score).toBeNull();
  expect(await json(api, "get", `/v1/jobs/${spanishId}/requirements`)).toMatchObject({ status: "unsupported_language" });
  await page.goto("/jobs?fit_state=unassessed");
  const row = page.getByRole("row").filter({ hasText: spanish.title });
  await expect(row.getByRole("link", { name: "Skipped · non-English posting" })).toHaveAttribute("href", `/runs/${started.runId}`);
  await row.getByRole("link", { name: spanish.title, exact: true }).click();
  const fitPanel = page.getByRole("region", { name: "Person fit", exact: true });
  await expect(fitPanel).toContainText("Person fit was skipped because this posting was identified as non-English");
  await expect(fitPanel.getByRole("link", { name: "View preparation run" })).toHaveAttribute("href", `/runs/${started.runId}`);
  const updated = await json<{ job_id: string }>(api, "post", "/v1/jobs/capture", {
    url: spanish.url, title: spanish.title, company: spanish.company, description: "A new English-language posting describes a different position.",
  });
  expect(updated.job_id).toBe(spanishId);
  await expect(fitPanel).toContainText("No person-fit assessment has been recorded yet.");
  await page.goto("/jobs?fit_state=unassessed");
  await expect(row.getByRole("cell", { name: "Not assessed", exact: true })).toBeVisible();
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(1);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

test("cancelling unsettled initial Fit preserves the preparation manifest and spends no retry allowance", async ({ api, app }, testInfo) => {
  const { library } = await createBaseline(api);
  const posted = posting(51);
  const started = await action(api, "discovery.search", {
    boards: ["indeed"], newJobLimit: 1, hoursOld: 0,
    queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }],
  });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: [posted], cursor: null, complete: true }));
  await servePostingAssessment(app, library, posted, { qualificationExpected: false });
  const held = await modelCall(app, "fit.qualification-batch");
  const { jobs } = await json<{ jobs: { job_id: string }[] }>(api, "get", "/v1/jobs");
  expect(jobs).toHaveLength(1);
  const jobId = jobs[0]!.job_id;
  const requirements = () => json<NormalizedSnapshot>(api, "get", `/v1/jobs/${jobId}/requirements`);
  const accepted = await requirements();
  expect(accepted.requirements).toHaveLength(1);
  expect(await json(api, "post", `/v1/action-runs/${started.runId}/cancel`, {})).toMatchObject({ cancellationRequested: true });
  const stopped = await terminal(api, started.runId);
  expect(stopped).toMatchObject({ status: "cancelled" });
  await expect.poll(() => held.closed).toBe(true);
  const cancelled = await json<{ status: string; jobIds: string[]; steps: { stage: string; status: string }[] }>(
    api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(cancelled).toMatchObject({ status: "cancelled", jobIds: [jobId] });
  expect(cancelled.steps.filter(step => step.status === "pending" || step.status === "running")).toEqual([]);
  expect(await requirements()).toEqual(accepted);
  const paid = await app.fitProviderReceipts();
  expect(paid).toMatchObject([{ status: "uncertain", inputFingerprint: normalizationFingerprint(held.body), costUsd: null }]);
  const beforeRetry = app.external.calls.filter(call => call.path !== "/catalog").length;

  const retryRuns = () => json(api, "get", "/v1/action-runs?action=preparation.retry");
  const beforeAdmission = await retryRuns();
  const retry = await api.post("/v1/actions/preparation.retry", { data: { run_id: started.runId } });
  expect(retry.status(), await retry.text()).toBe(409);
  const refusal = await retry.json();
  expect(refusal).toMatchObject({ error: { code: "model_operation_unsettled" } });
  expect(await retryRuns()).toEqual(beforeAdmission);
  expect(await app.fitProviderReceipts()).toEqual(paid);
  expect(await requirements()).toEqual(accepted);
  expect((await json<{ score: null }>(api, "get", `/v1/jobs/${jobId}/fit`)).score).toBeNull();
  expect(app.external.calls.filter(call => call.path !== "/catalog")).toHaveLength(beforeRetry);
  expect(modelCount(app, "fit.qualification-batch")).toBe(1);
  expect(await json(api, "get", `/v1/action-runs/${started.runId}`)).toEqual(stopped);
  await testInfo.attach("cancelled-search-fit-receipt", { contentType: "application/json", body: JSON.stringify({
    searchId: started.runId, status: stopped.status, disconnected: held.closed, receipt: paid[0],
    retryStatus: retry.status(), retryError: refusal.error.code, providerCalls: modelCount(app, "fit.qualification-batch"),
  }) });
});

for (const firstFailed of [false, true]) {
  test(firstFailed
    ? "worker replacement retains a failed Requirements result and finishes the saved sibling"
    : "worker replacement keeps accepted Requirements and Fit while the saved sibling resumes", async ({ api, app }) => {
    const { library } = await createBaseline(api);
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", {
      expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2, resultsPerSite: 2,
    });
    const first = { ...posting(52), description: "Maintain first-job workflow recovery." };
    const second = { ...posting(53), description: "Document the later job’s operational handover." };
    const started = await action(api, "discovery.search", {
      queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }],
    });
    const source = await app.external.next();
    expect(source.path).toBe("/jobstreaming/indeed");
    source.respond(indeedPage({ jobs: [first, second], cursor: null, complete: true }));

    // The current search dispatches each saved job independently. Hold the
    // sibling on a real posting fetch while the first publishes its outcome.
    const held = await app.external.next({ match: (call) => call.path === "/posting-page" && call.body["url"] === second.url });
    await servePostingAssessment(app, library, first, firstFailed ? {
      qualificationExpected: false,
      catalogDecision: (call) => catalogMatching(call, { capability: { verdict: "uncertain" } }),
    } : {});

    type VisibleRun = { jobIds: string[]; executionPolicy: unknown; steps: {
      jobId: string | null; stage: string; status: string; errorCode: string | null; result: unknown;
    }[] };
    const state = () => json<VisibleRun>(api, "get", `/v1/preparation/runs/${started.runId}`);
    const { jobs } = await json<{ jobs: { job_id: string; url: string }[] }>(api, "get", "/v1/jobs");
    const firstId = jobs.find((row) => row.url === first.url)!.job_id;
    const secondId = jobs.find((row) => row.url === second.url)!.job_id;
    await expect.poll(async () => (await state()).steps.find((row) => row.jobId === firstId &&
      row.stage === (firstFailed ? "requirements" : "fit"))?.status).toBe(firstFailed ? "failed" : "succeeded");
    const before = await state();
    expect(before.jobIds).toEqual(expect.arrayContaining([firstId, secondId]));
    expect(before.jobIds).toHaveLength(2);
    expect(before.executionPolicy).toMatchObject({ version: "search-jobs-v1" });
    const stableSteps = before.steps.filter((row) => row.jobId === firstId && ["succeeded", "failed"].includes(row.status));
    const priorRequirements = await json<NormalizedSnapshot | null>(api, "get", `/v1/jobs/${firstId}/requirements`);
    const priorFit = await json<FitState | { score: null }>(api, "get", `/v1/jobs/${firstId}/fit`);
    if (firstFailed) {
      expect(priorRequirements).toBeNull();
      expect(priorFit.score).toBeNull();
    } else {
      expect(priorRequirements?.requirements).toHaveLength(1);
      expect(priorFit).toMatchObject({ current: true, score: { score: 10 } });
    }

    const replacement = await app.restartWorker();
    expect(replacement.current).not.toBe(replacement.previous);
    await expect.poll(() => held.closed).toBe(true);
    const resumed = await app.external.next({ timeout: 45_000 });
    expect(resumed.path).toBe("/posting-page");
    expect(resumed.body).toEqual({ url: second.url });
    await servePostingAssessment(app, library, second, { pageRequest: resumed });
    const outcome = await completed(api, started.runId);
    expect(outcome.result).toMatchObject({
      status: firstFailed ? "partial" : "completed",
      newJobIds: expect.arrayContaining([firstId, secondId]),
      preparation: { assessedJobs: firstFailed ? 1 : 2, failedJobs: firstFailed ? 1 : 0 },
    });
    const after = await state();
    expect(after.jobIds).toEqual(before.jobIds);
    expect(after.steps).toEqual(expect.arrayContaining(stableSteps));
    expect(await json(api, "get", `/v1/jobs/${firstId}/requirements`)).toEqual(priorRequirements);
    expect(await json(api, "get", `/v1/jobs/${firstId}/fit`)).toMatchObject({ score: priorFit.score });
    expect(await json(api, "get", `/v1/jobs/${secondId}/fit`)).toMatchObject({ current: true, score: { score: 10 } });
    const external = app.external.calls;
    expect(external.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(1);
    expect(external.filter((call) => call.path === "/posting-page" && call.body["url"] === first.url)).toHaveLength(1);
    expect(external.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(2);
    expect(external.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(firstFailed ? 1 : 2);
  });
}

test.describe("per-job Fit receipt recovery", () => {
  test.use({ modelReceiptDebugger: true });

  test("a settled Fit receipt survives worker loss and qualifies a second identical demand without a second bill", async ({ api, app }) => {
    const { library } = await createBaseline(api);
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1 });

    async function startSearch(row: CohortPosting) {
      const run = await action(api, "discovery.search", {
        queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }],
      });
      const source = await app.external.next();
      expect(source.path).toBe("/jobstreaming/indeed");
      source.respond(indeedPage({ jobs: [row], cursor: null, complete: true }));
      return run;
    }

    async function savedJob(url: string) {
      const { jobs } = await json<{ jobs: { job_id: string; url: string }[] }>(api, "get", "/v1/jobs");
      const saved = jobs.find((job) => job.url === url);
      expect(saved, "The acquired posting is already committed").toBeTruthy();
      return saved!.job_id;
    }

    const first = posting(61);
    const search = await startSearch(first);
    await servePostingAssessment(app, library, first, { beforeQualification: () => app.armModelReceiptPause() });
    const pausedReceiptId = await app.waitForModelReceiptPause();
    const jobId = await savedJob(first.url);
    const ownerKey = "prep:" + createHash("sha256").update(`${search.runId}\0${jobId}\0fit`).digest("hex");
    const before = await app.fitProviderReceipts();
    expect(before).toEqual([{
      receiptId: pausedReceiptId, ownerKey, status: "succeeded", inputFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      costUsd: 0.0001,
    }]);
    expect((await json<{ score: null }>(api, "get", `/v1/jobs/${jobId}/fit`)).score).toBeNull();
    const callsBeforeRestart = app.external.calls.length;
    const replacement = await app.restartWorker();
    expect(replacement.current).not.toBe(replacement.previous);
    expect((await completed(api, search.runId)).result).toMatchObject({
      ok: true, status: "completed", preparation: { assessedJobs: 1, failedJobs: 0 },
    });
    expect(await app.fitProviderReceipts()).toEqual(before);
    expect(app.external.calls).toHaveLength(callsBeforeRestart);

    const firstFit = await json<FitState>(api, "get", `/v1/jobs/${jobId}/fit`);
    expect(firstFit).toMatchObject({ current: true, score: { score: 10 } });
    expect(firstFit.score.assessments[0]!.provenance.receipt_id).toBe(pausedReceiptId);

    const requirements = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${jobId}/requirements`);
    const requirementId = requirements.requirements[0]!.requirement_id;
    const peer = { ...posting(62), description: first.description };
    const second = await startSearch(peer);
    for (const expected of ["/posting-page", "page_interpretation", "posting_extraction", "description_quality"]) {
      const call = await app.external.next();
      expect(call.path === "/model" ? call.body["operation"] : call.path).toBe(expected);
      respondProducer(call, [peer]);
    }
    // The matching retained inputs also allow the new job to reuse role analysis
    // and requirement extraction. The catalog decision still binds its occurrences.
    const matching = await modelCall(app, "requirements.match_catalog");
    matching.reply(catalogMatching(matching, { capability: { verdict: "equivalent", requirementId } }));
    expect((await completed(api, second.runId)).result).toMatchObject({
      ok: true, status: "completed", preparation: { assessedJobs: 1, failedJobs: 0 },
    });
    const secondJobId = await savedJob(peer.url);
    const secondFit = await json<FitState>(api, "get", `/v1/jobs/${secondJobId}/fit`);
    expect(secondFit).toMatchObject({ current: true, score: { score: 10 } });
    expect(secondFit.score.assessments[0]!.assessment_id).toBe(firstFit.score.assessments[0]!.assessment_id);
    expect(secondFit.score.assessments[0]!.provenance.receipt_id).toBe(pausedReceiptId);
    expect(await app.fitProviderReceipts()).toEqual(before);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
  });
});

test("a Profile edit during qualification refuses stale authority and preserves prior scores", async ({ api, app }) => {
  const seed = await createScoredFit(api, app, "initial-fit-profile-race");
  const job = await captureReusePosting(api, "new-job-profile-race", COMMON_DEMAND);
  await acceptReuseRequirements(api, app, job, [{ localId: "r1", text: COMMON_DEMAND }], { r1: { verdict: "new" } });
  const requirements = () => json<NormalizedSnapshot>(api, "get", `/v1/jobs/${job.job_id}/requirements`);
  const accepted = await requirements();
  const pending = firstFit(api, job.job_id);
  const batch = await modelCall(app, "fit.qualification-batch");
  const profile = await json<Profile>(api, "get", "/v1/profile");
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: { ...profile.profile,
    resume: { ...profile.profile.resume, experience_entries: profile.profile.resume.experience_entries.map((row, index) => index ? row
      : { ...row, summary: "Maintained services with a newly reviewed operational summary." }) } } });
  const achievement = seed.library.roles[0]!.achievements[0]!;
  batch.reply(qualificationBatchDecision(batch, () => ({ achievementIds: [achievement.achievement_id],
    evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] })));
  const refused = await pending;
  expect(refused.status(), await refused.text()).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "revision_conflict" } });
  expect(await requirements()).toEqual(accepted);
  expect((await json<{ score: null }>(api, "get", `/v1/jobs/${job.job_id}/fit`)).score).toBeNull();
  expect((await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(seed.fit.score);
  expect(modelCount(app, "fit.qualification-batch")).toBe(2);
});
