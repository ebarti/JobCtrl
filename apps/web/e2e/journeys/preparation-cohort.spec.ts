import { test, expect, json, action, completed, terminal } from "../harness/fixtures.js";
import { createBaseline } from "./core-data.js";
import { createScoredFit, type FitState } from "./fit-data.js";
import { servePostingAssessment, serveQualification } from "./search-assessment-data.js";
import { authoredPartition, readCatalog, retainedCapability, type NormalizedSnapshot } from "./consolidation-data.js";
import { catalogMatching, memberRoots, modelSources, normalizationFingerprint, type CatalogContext } from "./requirements-data.js";
import { COMMON_DEMAND, posting, untilNormalization, type CohortPosting } from "./preparation-cohort-data.js";
import { cohortCitationSelection, qualificationBatchDecision, qualificationBindings } from "./qualification-data.js";

const SERIAL_PREDECESSOR = "38ef94613ebb7c0413d8d5ee89987ef860f53b13";

test("a new search normalizes repeated local IDs together and shares one qualification before reusing it exactly", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const modelSettings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: modelSettings.revision, dailyBudgetUsd: 0 });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 2 });
  const payload = { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] };
  const first = [posting(1), posting(2)];
  const started = await action(api, "discovery.search", payload);
  const source = await app.external.next();
  expect(source.path).toBe("/discovery");
  source.respond({ jobs: first, cursor: null, complete: true });
  const matching = await untilNormalization(app, first, { proveOverlap: true });
  const frozen = await json<{ cohortFrozen: boolean; jobIds: string[]; jobConcurrency: number; executionPolicy: unknown; steps: { jobId: string | null; stage: string; status: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(frozen).toMatchObject({ cohortFrozen: true, jobConcurrency: 3, executionPolicy: { version: "search-cohort-v1", producer_mode: "cross_lane" } });
  expect(frozen.jobIds).toHaveLength(2);
  const input = matching.body["context"] as CatalogContext;
  expect(input.incoming).toHaveLength(2);
  expect(input.incoming.map((row) => row.local_id)).toEqual(["r1", "r1"]);
  expect(new Set(input.incoming.map((row) => row.member_id)).size).toBe(2);
  expect(input.incoming.map((row) => row.job_id).sort()).toEqual([...frozen.jobIds].sort());
  expect(frozen.steps.filter((step) => step.stage === "requirements_extract" && step.status === "succeeded")).toHaveLength(2);
  expect(frozen.steps.filter((step) => step.stage === "fit" && step.status === "succeeded")).toHaveLength(0);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(0);
  matching.reply(authoredPartition(matching, [{ groupId: "shared-recovery", memberIds: input.incoming.map((row) => row.member_id),
    category: "professional_experience", name: COMMON_DEMAND, definition: COMMON_DEMAND }],
  [{ groupId: "shared-recovery", definition: COMMON_DEMAND, jobIds: frozen.jobIds }]));

  const qualification = await app.external.next();
  expect(qualification.path).toBe("/model");
  expect(qualification.body["operation"]).toBe("fit.qualification-batch");
  const requirements = await Promise.all(frozen.jobIds.map((id) => json<NormalizedSnapshot>(api, "get", `/v1/jobs/${id}/requirements`)));
  for (const snapshot of requirements) expect(snapshot.requirements).toHaveLength(1);
  const requirement = requirements[0]!.requirements[0]!;
  const sibling = requirements[1]!.requirements[0]!;
  for (const occurrence of [requirement, sibling])
    expect((occurrence.provenance as { matching_local_id?: string }).matching_local_id).toBe("r1");
  expect(sibling.requirement_id).toBe(requirement.requirement_id);
  expect(sibling.occurrence_id).not.toBe(requirement.occurrence_id);
  expect(sibling.normalized_demand.demand_fingerprint).toBe(requirement.normalized_demand.demand_fingerprint);
  expect(qualificationBindings(qualification)).toMatchObject([{ requirement_id: requirement.requirement_id,
    demand_fingerprint: requirement.normalized_demand.demand_fingerprint }]);
  const achievement = library.roles[0]!.achievements[0]!;
  const literal = qualificationBatchDecision(qualification, () => ({ achievementIds: [achievement.achievement_id],
    evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] }));
  const evidence = literal.requirements[0]!.evidence[0]!;
  const requirementCitation = literal.requirements[0]!.requirement_citations[0]!;
  const raw = { requirements: literal.requirements.map((row) => ({ ...row,
    evidence: [cohortCitationSelection(qualification, evidence.source_id, 1)],
    requirement_citations: [cohortCitationSelection(qualification, requirementCitation.source_id, null)] })) };
  const expanded = structuredClone(literal);
  expanded.requirements[0]!.evidence[0]!.quote = modelSources(qualification).find((row) => row.source_id === evidence.source_id)!.text.split(/\r?\n/)[0]!;
  expanded.requirements[0]!.requirement_citations[0]!.quote = modelSources(qualification).find((row) => row.source_id === requirementCitation.source_id)!.text;
  qualification.reply(raw);
  const firstOutcome = await completed(api, started.runId);
  expect(firstOutcome["result"]).toMatchObject({ ok: true, status: "completed", newJobIds: frozen.jobIds,
    preparation: { status: "succeeded", assessedJobs: 2, failedJobs: 0 } });
  const scores = await Promise.all(frozen.jobIds.map((id) => json<FitState>(api, "get", `/v1/jobs/${id}/fit`)));
  for (const score of scores) expect(score).toMatchObject({ current: true, stale_reasons: [], score: { score: 10 } });
  expect(scores[0]!.score.assessments[0]!.assessment_id).toBe(scores[1]!.score.assessments[0]!.assessment_id);
  const provenance = scores[0]!.score.assessments[0]!.provenance as unknown as { cohort_citation_binding: Record<string, unknown> };
  expect(provenance.cohort_citation_binding).toMatchObject({ version: "fit-qualification-citation-refs-v1",
    raw_batch_fingerprint: normalizationFingerprint(raw), expanded_batch_fingerprint: normalizationFingerprint(expanded) });

  // A third independently acquired posting establishes the same demand. The
  // model explicitly retains the accepted capability and demand identity.
  const next = await action(api, "discovery.search", { ...payload, newJobLimit: 1 });
  const nextSource = await app.external.next();
  expect(nextSource.path).toBe("/discovery");
  const third = posting(3);
  nextSource.respond({ jobs: [third], cursor: null, complete: true });
  const nextMatching = await untilNormalization(app, [third]);
  const nextRun = await json<{ jobIds: string[] }>(api, "get", `/v1/preparation/runs/${next.runId}`);
  expect(nextRun.jobIds).toHaveLength(1);
  const context = nextMatching.body["context"] as CatalogContext;
  const retained = retainedCapability(nextMatching, requirement.requirement_id, "shared-recovery");
  retained.memberIds.push(...context.incoming.map((row) => row.member_id));
  const full = authoredPartition(nextMatching, [retained], [{ groupId: "shared-recovery", definition: COMMON_DEMAND,
    jobIds: [...frozen.jobIds, ...nextRun.jobIds], reuseDemandFingerprint: requirement.normalized_demand.demand_fingerprint }]);
  // Explicit reuse selects the offered retained definitions; assignments and
  // source-bound citations remain the complete independently authored graph.
  const compact = { ...full,
    capability_groups: Object.fromEntries(Object.entries(full.capability_groups).map(([id, slot]) => [id,
      slot === null ? null : { kind: "reuse", reuse_requirement_id: slot.reuse_requirement_id, reason: slot.reason, citations: slot.citations }])),
    demand_groups: Object.fromEntries(Object.entries(full.demand_groups).map(([id, slot]) => [id,
      slot === null ? null : { kind: "reuse", reuse_demand_fingerprint: slot.reuse_demand_fingerprint, citations: slot.citations }])),
  };
  nextMatching.reply(compact);
  expect((await completed(api, next.runId))["result"]).toMatchObject({ ok: true, status: "completed",
    preparation: { status: "succeeded", assessedJobs: 1, failedJobs: 0 } });
  const reused = await json<FitState>(api, "get", `/v1/jobs/${nextRun.jobIds[0]}/fit`);
  expect(reused).toMatchObject({ current: true, stale_reasons: [], score: { score: 10 } });
  expect(reused.score.assessments[0]!.assessment_id).toBe(scores[0]!.score.assessments[0]!.assessment_id);
  const nextRecorded = await json<{ steps: { stage: string; result: { operation_id?: string } | null }[] }>(api, "get", `/v1/preparation/runs/${next.runId}`);
  const reconciliationId = nextRecorded.steps.find((step) => step.stage === "requirements_normalize")?.result?.operation_id;
  expect(reconciliationId).toBeTruthy();
  const audit = await app.requirementsReconciliation(reconciliationId!);
  expect(audit.selection).toEqual(compact);
  expect(audit.authority_receipt.value).toEqual(compact);
  expect(audit.stored_report.partition_binding).toMatchObject({ raw_selection_fingerprint: normalizationFingerprint(compact) });
  for (const [index, id] of frozen.jobIds.entries()) expect((await json<FitState>(api, "get", `/v1/jobs/${id}/fit`)).score).toEqual(scores[index]!.score);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(2);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

for (const fault of ["missing member", "foreign member", "foreign citation"] as const) {
  test(`cohort normalization refuses a ${fault} without publishing partial authority`, async ({ api, app }) => {
    const seed = await createScoredFit(api, app, `cohort-normalization-${fault.replaceAll(" ", "-")}`);
    const accepted = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`);
    const priorScore = await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`);
    const catalogBefore = await readCatalog(api);
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 2 });
    const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
    const source = await app.external.next();
    expect(source.path).toBe("/discovery");
    const incoming = [posting(21), posting(22)];
    source.respond({ jobs: incoming, cursor: null, complete: true });
    const matching = await untilNormalization(app, incoming);
    const run = await json<{ jobIds: string[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
    expect(run.jobIds).toHaveLength(2);
    const context = matching.body["context"] as CatalogContext;
    const old = accepted.requirements[0]!;
    const retained = retainedCapability(matching, old.requirement_id, "retained");
    const invalid = authoredPartition(matching, [retained, { groupId: "incoming", memberIds: context.incoming.map((row) => row.member_id),
      category: "professional_experience", name: COMMON_DEMAND, definition: COMMON_DEMAND }], [
      { groupId: "retained", definition: old.normalized_demand.definition, jobIds: [seed.posting.job_id], reuseDemandFingerprint: old.normalized_demand.demand_fingerprint },
      { groupId: "incoming", definition: COMMON_DEMAND, jobIds: run.jobIds },
    ]);
    if (fault === "missing member") delete invalid.member_slots[context.incoming[0]!.member_id];
    if (fault === "foreign member") invalid.member_slots["incoming:foreign-job:r1"] = structuredClone(invalid.member_slots[context.incoming[0]!.member_id]!);
    if (fault === "foreign citation") memberRoots(invalid)[0]!.slot.citations.push({ source_id: "foreign-source", segment_id: "foreign-segment" });
    matching.reply(invalid);
    expect((await completed(api, started.runId))["result"]).toMatchObject({ ok: false, status: "partial",
      preparation: { status: "partial", assessedJobs: 0, failedJobs: 2 } });
    const recorded = await json<{ steps: { jobId: string | null; stage: string; status: string; errorCode: string | null }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
    expect(recorded.steps.find((step) => step.stage === "requirements_normalize")).toMatchObject({ status: "failed", errorCode: "model_schema_violation" });
    expect(recorded.steps.filter((step) => step.stage === "requirements" && step.status === "failed")).toHaveLength(2);
    for (const id of run.jobIds) expect((await json<{ score: null }>(api, "get", `/v1/jobs/${id}/fit`)).score).toBeNull();
    expect(await readCatalog(api)).toEqual(catalogBefore);
    expect(await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`)).toEqual(accepted);
    expect((await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(priorScore.score);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
  });
}

for (const fault of ["missing row", "foreign requirement", "foreign citation"] as const) {
  test(`cohort qualification refuses a ${fault} without publishing partial scores`, async ({ api, app }) => {
    const seed = await createScoredFit(api, app, `cohort-qualification-${fault.replaceAll(" ", "-")}`);
    const accepted = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`);
    const priorScore = await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`);
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 2 });
    const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
    const source = await app.external.next();
    expect(source.path).toBe("/discovery");
    const incoming = [posting(31), posting(32)];
    source.respond({ jobs: incoming, cursor: null, complete: true });
    const matching = await untilNormalization(app, incoming);
    const run = await json<{ jobIds: string[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
    const context = matching.body["context"] as CatalogContext;
    const old = accepted.requirements[0]!;
    const retained = retainedCapability(matching, old.requirement_id, "retained");
    matching.reply(authoredPartition(matching, [retained, { groupId: "incoming", memberIds: context.incoming.map((row) => row.member_id),
      category: "professional_experience", name: COMMON_DEMAND, definition: COMMON_DEMAND }], [
      { groupId: "retained", definition: old.normalized_demand.definition, jobIds: [seed.posting.job_id], reuseDemandFingerprint: old.normalized_demand.demand_fingerprint },
      { groupId: "incoming", definition: COMMON_DEMAND, jobIds: run.jobIds },
    ]));
    const batch = await app.external.next();
    expect(batch.body["operation"]).toBe("fit.qualification-batch");
    const normalized = await Promise.all(run.jobIds.map((id) => json<NormalizedSnapshot>(api, "get", `/v1/jobs/${id}/requirements`)));
    for (const snapshot of normalized) expect(snapshot.requirements).toHaveLength(1);
    const achievement = seed.library.roles[0]!.achievements[0]!;
    const invalid = qualificationBatchDecision(batch, () => ({ achievementIds: [achievement.achievement_id],
      evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] }));
    expect(invalid.requirements).toHaveLength(1);
    if (fault === "missing row") invalid.requirements.pop();
    if (fault === "foreign requirement") invalid.requirements[0]!.requirement_id = "unrequested-canonical-requirement";
    if (fault === "foreign citation") invalid.requirements[0]!.evidence = [{ source_id: "foreign-unowned-evidence", quote: "A source that was never supplied." }];
    batch.reply(invalid);
    expect((await completed(api, started.runId))["result"]).toMatchObject({ ok: false, status: "partial",
      preparation: { status: "partial", assessedJobs: 0, failedJobs: 2 } });
    const recorded = await json<{ steps: { stage: string; status: string; errorCode: string | null }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
    expect(recorded.steps.find((step) => step.stage === "fit_qualify")).toMatchObject({ status: "failed", errorCode: {
      "missing row": "model_schema_violation", "foreign requirement": "fit_qualification_partition_invalid", "foreign citation": "fit_foreign_source_id",
    }[fault] });
    expect(recorded.steps.filter((step) => step.stage === "fit" && step.status === "failed")).toHaveLength(2);
    for (const [index, id] of run.jobIds.entries()) {
      expect(await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${id}/requirements`)).toEqual(normalized[index]);
      expect((await json<{ score: null }>(api, "get", `/v1/jobs/${id}/fit`)).score).toBeNull();
    }
    expect((await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(priorScore.score);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(2);
  });
}

test("an unsupported-language posting is skipped while its English cohort sibling is assessed", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 2 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/discovery");
  const english = posting(41);
  const spanish: CohortPosting = { ...posting(42), description: "Mantener la recuperación de los flujos de trabajo.", unsupported: true };
  const { unsupported: _fixtureOnly, ...spanishSource } = spanish;
  source.respond({ jobs: [english, spanishSource], cursor: null, complete: true });
  const matching = await untilNormalization(app, [english, spanish]);
  const run = await json<{ jobIds: string[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(run.jobIds).toHaveLength(2);
  const context = matching.body["context"] as CatalogContext;
  expect(context.incoming).toHaveLength(1);
  expect(context.incoming[0]).toMatchObject({ job_id: run.jobIds[0] });
  matching.reply(authoredPartition(matching, [{ groupId: "english", memberIds: [context.incoming[0]!.member_id],
    category: "professional_experience", name: COMMON_DEMAND, definition: COMMON_DEMAND }],
  [{ groupId: "english", definition: COMMON_DEMAND, jobIds: [run.jobIds[0]!] }]));
  const batch = await app.external.next();
  expect(batch.body["operation"]).toBe("fit.qualification-batch");
  const achievement = library.roles[0]!.achievements[0]!;
  batch.reply(qualificationBatchDecision(batch, () => ({ achievementIds: [achievement.achievement_id],
    evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] })));
  expect((await completed(api, started.runId))["result"]).toMatchObject({ ok: true, status: "completed", preparation: {
    status: "succeeded", assessedJobs: 1, failedJobs: 0, skippedJobs: 1,
    skipped: [{ jobId: run.jobIds[1], reason: "unsupported_posting_language" }],
  } });
  expect((await json<FitState>(api, "get", `/v1/jobs/${run.jobIds[0]}/fit`)).current).toBe(true);
  expect((await json<{ score: null }>(api, "get", `/v1/jobs/${run.jobIds[1]}/fit`)).score).toBeNull();
  expect(await json(api, "get", `/v1/jobs/${run.jobIds[1]}/requirements`)).toMatchObject({ status: "unsupported_language" });
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(1);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

test("cancelling an unsettled cohort qualification preserves its manifest and cannot spend a new retry allowance", async ({ api, app }) => {
  await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 2 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/discovery");
  const postings = [posting(51), posting(52)];
  source.respond({ jobs: postings, cursor: null, complete: true });
  const matching = await untilNormalization(app, postings);
  const run = await json<{ jobIds: string[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(run.jobIds).toHaveLength(2);
  const input = matching.body["context"] as CatalogContext;
  matching.reply(authoredPartition(matching, [{ groupId: "recovery", memberIds: input.incoming.map((row) => row.member_id),
    category: "professional_experience", name: COMMON_DEMAND, definition: COMMON_DEMAND }],
  [{ groupId: "recovery", definition: COMMON_DEMAND, jobIds: run.jobIds }]));
  const held = await app.external.next();
  expect(held.path).toBe("/model");
  expect(held.body["operation"]).toBe("fit.qualification-batch");
  const accepted = await Promise.all(run.jobIds.map((id) => json<NormalizedSnapshot>(api, "get", `/v1/jobs/${id}/requirements`)));
  expect(await json(api, "post", `/v1/action-runs/${started.runId}/cancel`, {})).toMatchObject({ cancellationRequested: true });
  expect(await terminal(api, started.runId)).toMatchObject({ status: "cancelled" });
  await expect.poll(() => held.closed).toBe(true);
  const cancelled = await json<{ status: string; jobIds: string[]; steps: { stage: string; status: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(cancelled.status).toBe("cancelled");
  expect(cancelled.jobIds).toEqual(run.jobIds);
  expect(cancelled.steps.filter((step) => step.status === "pending" || step.status === "running")).toEqual([]);
  for (const [index, id] of run.jobIds.entries()) {
    expect(await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${id}/requirements`)).toEqual(accepted[index]);
    expect((await json<{ score: null }>(api, "get", `/v1/jobs/${id}/fit`)).score).toBeNull();
  }
  const beforeRetry = app.external.calls.filter((call) => call.path !== "/catalog").length;
  const retryRows = await json(api, "get", "/v1/action-runs?action=preparation.retry");
  const narrowed = await api.post("/v1/actions/preparation.retry", { data: { run_id: started.runId, job_ids: [run.jobIds[0]] } });
  expect(narrowed.status()).toBe(409);
  expect(await narrowed.json()).toMatchObject({ error: { code: "preparation_cohort_retry_scope_required" } });
  expect(await json(api, "get", "/v1/action-runs?action=preparation.retry")).toEqual(retryRows);
  const retry = await action(api, "preparation.retry", { run_id: started.runId });
  expect(await terminal(api, retry.runId)).toMatchObject({ status: "failed", errorCode: "preparation_partial" });
  const replay = await json<{ parentRunId: string; jobIds: string[]; steps: { stage: string; status: string; errorCode: string | null }[] }>(api, "get", `/v1/preparation/runs/${retry.runId}`);
  expect(replay.parentRunId).toBe(started.runId);
  expect(replay.jobIds).toEqual(run.jobIds);
  expect(replay.steps.find((step) => step.stage === "fit_qualify")).toMatchObject({ status: "failed", errorCode: "fit_cohort_interrupted" });
  expect(app.external.calls.filter((call) => call.path !== "/catalog")).toHaveLength(beforeRetry);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

test.describe("actual serial preparation predecessor", () => {
  test.use({ sourceRevision: SERIAL_PREDECESSOR });

  test("an interrupted search resumes its original serial cohort and preserves accepted Requirements after upgrade", async ({ api, app }) => {
    const { library } = await createBaseline(api);
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 2, resultsPerSite: 2 });
    const first = { job_key: "legacy-cohort-first", url: "https://example.com/jobs/legacy-cohort-first", title: "Synthetic Legacy First Engineer", company: "Synthetic Legacy Company", description: "Maintain durable workflow recovery, including operational readiness.", location: "Madrid" };
    const second = { job_key: "legacy-cohort-second", url: "https://example.com/jobs/legacy-cohort-second", title: "Synthetic Legacy Second Engineer", company: "Synthetic Legacy Company", description: "Maintain operational readiness for durable workflow recovery.", location: "Madrid" };
    const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
    const source = await app.external.next();
    expect(source.path).toBe("/discovery");
    source.respond({ jobs: [first, second], cursor: null, complete: true });
    await servePostingAssessment(app, library, first, { qualificationExpected: false });

    // The predecessor has committed the first producer's Requirements while
    // the second job waits at an actual recoverable page transport boundary.
    const held = await app.external.next();
    expect(held.path).toBe("/posting-page");
    expect(held.body).toEqual({ url: second.url });
    const before = await json<{ jobIds: string[]; jobConcurrency: number; executionPolicy?: unknown; steps: { jobId: string; stage: string; status: string; result: unknown }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
    expect(before.executionPolicy).toBeUndefined();
    expect(before.jobConcurrency).toBe(1);
    expect(before.jobIds).toHaveLength(2);
    expect(before.steps.find((step) => step.jobId === before.jobIds[0] && step.stage === "requirements")).toMatchObject({ status: "succeeded" });
    const accepted = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${before.jobIds[0]}/requirements`);
    expect(accepted.requirements).toHaveLength(1);
    expect((await json<{ score: null }>(api, "get", `/v1/jobs/${before.jobIds[0]}/fit`)).score).toBeNull();
    const priorCalls = app.external.calls.filter((call) => call.path === "/model").map((call) => call.body["operation"]);
    expect(priorCalls.filter((operation) => operation === "requirements.match_catalog")).toHaveLength(1);
    expect(priorCalls.filter((operation) => operation === "fit.qualification-batch")).toHaveLength(0);

    const upgrade = await app.upgradeSource();
    expect(upgrade.current).not.toBe(upgrade.previous);
    await expect.poll(() => held.closed).toBe(true);
    const resumed = await app.external.next({ timeout: 45_000 });
    expect(resumed.path).toBe("/posting-page");
    expect(resumed.body).toEqual({ url: second.url });
    await servePostingAssessment(app, library, second, { pageRequest: resumed, qualificationExpected: false, catalogDecision: (call) => {
      const group = retainedCapability(call, accepted.requirements[0]!.requirement_id, "recovery");
      group.memberIds.push(...(call.body["context"] as CatalogContext).incoming.map((row) => row.member_id));
      return authoredPartition(call, [group], [{ groupId: group.groupId, definition: second.description, jobIds: before.jobIds }]);
    } });
    await serveQualification(app, library, { beforeQualification: async () => {
      // The real next qualification request proves normalization publication,
      // whereas returning from the provider reply alone does not.
      const advanced = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${before.jobIds[0]}/requirements`);
      expect(advanced.revision).toBeGreaterThan(accepted.revision);
      expect(advanced.requirements[0]!.requirement_id).toBe(accepted.requirements[0]!.requirement_id);
      expect(advanced.requirements[0]!.normalized_demand.demand_fingerprint).not.toBe(accepted.requirements[0]!.normalized_demand.demand_fingerprint);
      expect(advanced.requirements[0]!.normalized_demand.definition).toBe(second.description);
      const sibling = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${before.jobIds[1]}/requirements`);
      expect(sibling.requirements[0]!.normalized_demand.demand_fingerprint).toBe(advanced.requirements[0]!.normalized_demand.demand_fingerprint);
    } });
    const outcome = await completed(api, started.runId);
    expect(outcome["result"]).toMatchObject({ ok: true, status: "completed", newJobIds: before.jobIds,
      preparation: { status: "succeeded", assessedJobs: 2, failedJobs: 0 } });
    const after = await json<typeof before>(api, "get", `/v1/preparation/runs/${started.runId}`);
    expect(after.executionPolicy).toBeUndefined();
    expect(after.jobConcurrency).toBe(1);
    expect(after.jobIds).toEqual(before.jobIds);
    for (const step of before.steps.filter((row) => row.status === "succeeded")) expect(after.steps).toContainEqual(step);
    const retained = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${before.jobIds[0]}/requirements`);
    expect(retained.requirements[0]!.requirement_id).toBe(accepted.requirements[0]!.requirement_id);
    expect(retained.requirements[0]!.extraction_determination_id).toBe(accepted.requirements[0]!.extraction_determination_id);
    expect((await json<FitState>(api, "get", `/v1/jobs/${before.jobIds[0]}/fit`)).current).toBe(true);
    expect((await json<FitState>(api, "get", `/v1/jobs/${before.jobIds[1]}/fit`)).current).toBe(true);
    const calls = app.external.calls.filter((call) => call.path === "/model").map((call) => call.body["operation"]);
    expect(calls.slice(0, priorCalls.length)).toEqual(priorCalls);
    expect(calls.filter((operation) => operation === "requirements.match_catalog")).toHaveLength(2);
    expect(calls.filter((operation) => operation === "fit.qualification-batch")).toHaveLength(1);
    expect(app.external.calls.filter((call) => call.path === "/discovery")).toHaveLength(1);
    expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=discovery.search")).runs.map((run) => run.runId)).toEqual([started.runId]);
  });
});

test.describe("failed serial predecessor recovery", () => {
  test.use({ sourceRevision: SERIAL_PREDECESSOR });

test("an actual predecessor upgrade preserves a failed job while a replacement worker finishes the frozen later job", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["linkedin"], hoursOld: 0, newJobLimit: 2, resultsPerSite: 2 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const first = { job_key: "replay-failed", url: "https://example.com/jobs/replay-failed", title: "Synthetic First Replay Engineer", company: "Synthetic Replay Company", description: "Maintain first-job workflow recovery.", location: "Madrid" };
  const second = { job_key: "replay-later", url: "https://example.com/jobs/replay-later", title: "Synthetic Later Replay Engineer", company: "Synthetic Replay Company", description: "Maintain later-job workflow recovery.", location: "Madrid" };
  const source = await app.external.next();
  expect(source.path).toBe("/discovery");
  source.respond({ jobs: [first, second], cursor: null, complete: true });
  await servePostingAssessment(app, library, first, { qualificationExpected: false,
    catalogDecision: (call) => catalogMatching(call, { capability: { verdict: "uncertain" } }) });
  // All model receipts are settled. A held posting fetch is recoverable without
  // authorizing another call against unknown model usage after the worker dies.
  const held = await app.external.next();
  expect(held.path).toBe("/posting-page");
  expect(held.body).toEqual({ url: second.url });
  const frozen = await json<{ jobIds: string[]; steps: { jobId: string; stage: string; status: string; errorCode: string }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(frozen.jobIds).toHaveLength(2);
  const failed = frozen.steps.find((step) => step.stage === "requirements")!;
  expect(failed.status).toBe("failed");
  const replacement = await app.upgradeSource();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect.poll(() => held.closed).toBe(true);
  const resumed = await app.external.next({ timeout: 45_000 });
  expect(resumed.path).toBe("/posting-page");
  expect(resumed.body).toEqual({ url: second.url });
  expect(resumed).not.toBe(held);
  await servePostingAssessment(app, library, second, { pageRequest: resumed });
  const finished = await completed(api, started.runId);
  expect(finished["result"]).toMatchObject({ ok: false, status: "partial", preparation: { assessedJobs: 1, failedJobs: 1, failures: [{ jobId: failed.jobId, stage: "requirements", code: failed.errorCode }] } });
  const retained = await json<{ jobIds: string[]; steps: unknown[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(retained.jobIds).toEqual(frozen.jobIds);
  expect(retained.steps).toContainEqual(failed);
  expect(app.external.calls.filter((call) => call.path === "/discovery")).toHaveLength(1);
  expect((await json<FitState>(api, "get", `/v1/jobs/${frozen.jobIds[1]}/fit`)).current).toBe(true);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(2);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

});
