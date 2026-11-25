import { indeedPage } from "./indeed-data.js";
import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { test, expect, json, action, completed, modelCall, terminal, type ApplicationStack } from "../harness/fixtures.js";
import { createBaseline, type Profile } from "./core-data.js";
import { createScoredFit, type FitState } from "./fit-data.js";
import { servePostingAssessment, serveQualification } from "./search-assessment-data.js";
import { authoredPartition, readCatalog, retainedCapability, type NormalizedSnapshot } from "./consolidation-data.js";
import { catalogMatching, memberRoots, modelSources, V6_NORMALIZATION_PROMPT_VERSION, normalizationFingerprint, typedExtraction, type CatalogContext } from "./requirements-data.js";
import { COMMON_DEMAND, posting, respondProducer, untilNormalization, type CohortPosting } from "./preparation-cohort-data.js";
import { cohortCitationSelection, qualificationBatchDecision, qualificationBindings } from "./qualification-data.js";

const SERIAL_PREDECESSOR = "38ef94613ebb7c0413d8d5ee89987ef860f53b13";

test.describe("saved posting detail upgrade", () => {
  test.use({ sourceRevision: SERIAL_PREDECESSOR });

  test("rediscovery preserves accepted detail and recovers earlier listing downgrades", async ({ api, app }) => {
    const { posting, fit } = await createScoredFit(api, app, "preserve-rediscovered-detail", { postingUrl: "https://www.indeed.com/viewjob?jk=preserve-rediscovered-detail" });
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 1 });
    const path = `/v1/jobs/${posting.job_id}`;
    const detail = await json<{ revision: number; source_hash: string; description: string; content_state: string }>(api, "get", path);
    const savedRequirements = await json<NormalizedSnapshot>(api, "get", `${path}/requirements`);
    async function rediscover() {
      const run = await action(api, "discovery.search", {
        queries: ["Synthetic engineer"], locations: [{ location: "Madrid", remote: true }],
      });
      const source = await app.external.next();
      expect(source.path).toBe("/jobstreaming/indeed");
      source.respond(indeedPage({ complete: true, cursor: null, jobs: [{ job_key: "preserve-rediscovered-detail",
        url: posting.url, title: posting.title, company: posting.company, location: "Madrid", description: "A short search result summary." }] }));
      const result = await completed(api, run.runId);
      expect(result["result"]).toMatchObject({ newJobs: 0 });
      return run.runId;
    }

    const firstRun = await rediscover();
    const downgraded = await json<typeof detail>(api, "get", path);
    expect(downgraded).toMatchObject({ revision: detail.revision + 1, content_state: "listing_only", description: "A short search result summary." });
    expect((await json<FitState>(api, "get", `${path}/fit`)).current).toBe(false);

    const callsBeforeUpgrade = app.external.calls.length;
    const upgrade = await app.upgradeSource();
    expect(upgrade.current).not.toBe(upgrade.previous);
    const recovered = await json<typeof detail>(api, "get", path);
    expect(recovered).toMatchObject({ revision: downgraded.revision + 1, source_hash: detail.source_hash,
      description: detail.description, content_state: "accepted_detail" });
    expect(await json<NormalizedSnapshot>(api, "get", `${path}/requirements`)).toEqual(savedRequirements);
    expect(await json<FitState>(api, "get", `${path}/fit`)).toMatchObject({
      current: true, requirements_current: true, stale_reasons: [], score: fit.score,
    });
    expect(app.external.calls).toHaveLength(callsBeforeUpgrade);

    const secondRun = await rediscover();
    expect(await json<typeof detail>(api, "get", path)).toEqual(recovered);
    const history = await json<{ snapshots: { revision: number }[]; observations: { run_id: string | null; posting_revision: number }[] }>(api, "get", `${path}/snapshots`);
    expect(history.snapshots.map((row) => row.revision)).toEqual([recovered.revision, downgraded.revision, detail.revision]);
    expect(history.observations.filter((row) => row.run_id !== null)).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: firstRun, posting_revision: downgraded.revision }),
      expect.objectContaining({ run_id: secondRun, posting_revision: recovered.revision }),
    ]));
    expect(app.external.calls.slice(callsBeforeUpgrade).map((call) => call.path)).toEqual(["/jobstreaming/indeed"]);
  });
});

async function requirementAttempts(app: ApplicationStack, runId: string) {
  const owner = JSON.parse((await app.file(".jobctrl-e2e-owned.json")).toString());
  expect(owner.workspace).toBe(app.workspace);
  const file = path.join(app.workspace, "jobctrl.db");
  expect(await realpath(file)).toBe(file);
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db.prepare(`SELECT a.job_id, a.attempt_id, a.state, a.failure_code, a.completed_at,
      json_extract(o.state_json,'$.model_request.input_fingerprint') AS extraction_fingerprint,
      g.receipt_id AS refused_receipt_id, g.status AS refused_receipt_status FROM preparation_steps s
      JOIN requirements_attempts a ON a.job_id=s.job_id AND a.attempt_id=json_extract(s.input_json,'$._operation_id')
      JOIN requirements_cohort_operations o ON o.operation_id=a.attempt_id
      LEFT JOIN app_model_calls g ON g.receipt_id=json_extract(o.state_json,'$.refused_extraction_receipt_id')
        AND g.input_fingerprint=json_extract(o.state_json,'$.model_request.input_fingerprint')
      WHERE s.run_id=? AND s.stage='requirements_extract' ORDER BY a.started_at, a.attempt_id`).all(runId);
  } finally {
    db.close();
  }
}

test("a refused cohort extraction and an explicit cancellation settle only the corresponding Requirements attempts", async ({ api, app }) => {
  await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 3 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  const first = posting(101);
  const postings = [first, { ...posting(102), description: first.description }, posting(103)];
  source.respond(indeedPage({ jobs: postings, cursor: null, complete: true }));
  let extracted = 0;
  let current = first;
  for (;;) {
    const call = await app.external.next();
    if (call.path === "/posting-page") {
      const page = postings.find((row) => row.url === call.body["url"]);
      expect(page).toBeDefined();
      current = page!;
    }
    if (call.body?.["operation"] === "requirements.extract") {
      extracted++;
      if (extracted === 3) break;
      if (extracted === 1) {
        const response = typedExtraction(call, { requirements: [{ localId: "r1", text: COMMON_DEMAND }] });
        response.requirements[0]!.evidence_refs = ["not-in-the-quote-inventory"];
        call.reply(response);
        continue;
      }
    }
    respondProducer(call, [current]);
  }
  const run = await json<{ jobIds: string[]; steps: { jobId: string; stage: string; status: string; errorCode: string | null }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(run.steps.find((step) => step.jobId === run.jobIds[0] && step.stage === "requirements_extract"))
    .toMatchObject({ status: "failed", errorCode: "foreign_or_duplicate_evidence_id" });
  const refused = { job_id: run.jobIds[0], state: "blocked", failure_code: "foreign_or_duplicate_evidence_id",
    completed_at: expect.any(String), refused_receipt_id: expect.any(String), refused_receipt_status: "succeeded" };
  const running = (job_id: string) => ({ job_id, state: "running", failure_code: null, completed_at: null });
  const attempts = await requirementAttempts(app, started.runId);
  expect(attempts).toMatchObject([refused, running(run.jobIds[1]!), running(run.jobIds[2]!)]);
  expect(attempts[0]!["extraction_fingerprint"]).toEqual(expect.any(String));
  expect(attempts[1]!["extraction_fingerprint"]).toBe(attempts[0]!["extraction_fingerprint"]);
  await json(api, "post", `/v1/action-runs/${started.runId}/cancel`, {});
  expect(await terminal(api, started.runId)).toMatchObject({ status: "cancelled" });
  const cancelled = (job_id: string) => ({ job_id, state: "cancelled", failure_code: "action_cancelled", completed_at: expect.any(String) });
  expect(await requirementAttempts(app, started.runId)).toMatchObject([refused, cancelled(run.jobIds[1]!), cancelled(run.jobIds[2]!)]);
  for (const id of run.jobIds) expect(await json(api, "get", `/v1/jobs/${id}/requirements`)).toBeNull();
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.extract")).toHaveLength(3);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(0);

  // The retry revalidates the exact refused receipt and reuses the staged
  // sibling. The unresolved provider spend still prevents normalization.
  const retry = await action(api, "preparation.retry", { run_id: started.runId });
  expect(await terminal(api, retry.runId)).toMatchObject({ status: "failed", errorCode: "preparation_partial", cancellationRequested: false });
  const after = await requirementAttempts(app, retry.runId);
  expect(after).toMatchObject([{ ...refused, refused_receipt_id: attempts[0]!["refused_receipt_id"] },
    { job_id: run.jobIds[1], state: "blocked", failure_code: "spend_accounting_unresolved", completed_at: expect.any(String) },
    { job_id: run.jobIds[2], state: "blocked", failure_code: "requirements_cohort_interrupted", completed_at: expect.any(String), refused_receipt_id: null }]);
  expect(after.map((row) => row["attempt_id"])).toEqual(attempts.map((row) => row["attempt_id"]));
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.extract")).toHaveLength(3);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(0);
});

test("a new search normalizes repeated local IDs together and shares one qualification before reusing it exactly", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const modelSettings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: modelSettings.revision, dailyBudgetUsd: 0 });
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2 });
  const payload = { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] };
  const first = [posting(1), posting(2)];
  const started = await action(api, "discovery.search", payload);
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: first, cursor: null, complete: true }));
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
  expect(nextSource.path).toBe("/jobstreaming/indeed");
  const third = posting(3);
  nextSource.respond(indeedPage({ jobs: [third], cursor: null, complete: true }));
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

for (const fault of ["missing member", "foreign member", "foreign citation", "worker interruption"] as const) {
  const title = fault === "worker interruption" ? "worker interruption during cohort normalization preserves accepted authority"
    : `cohort normalization refuses a ${fault} without publishing partial authority`;
  test(title, async ({ api, app }) => {
    const seed = await createScoredFit(api, app, `cohort-normalization-${fault.replaceAll(" ", "-")}`);
    const accepted = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`);
    const priorScore = await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`);
    const catalogBefore = await readCatalog(api);
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2 });
    const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
    const source = await app.external.next();
    expect(source.path).toBe("/jobstreaming/indeed");
    const incoming = [posting(21), posting(22)];
    source.respond(indeedPage({ jobs: incoming, cursor: null, complete: true }));
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
    const refusal = fault === "worker interruption" ? "requirements_cohort_interrupted" : "model_schema_violation";
    const calls = app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog").length;
    if (fault === "worker interruption") {
      expect(await requirementAttempts(app, started.runId)).toMatchObject(run.jobIds.map((job_id) => ({
        job_id, state: "running", failure_code: null, completed_at: null,
      })));
      const replacement = await app.restartWorker();
      expect(replacement.current).not.toBe(replacement.previous);
    } else matching.reply(invalid);
    const outcome = await completed(api, started.runId);
    expect(outcome["cancellationRequested"]).toBe(false);
    expect(outcome["result"]).toMatchObject({ ok: false, status: "partial",
      preparation: { status: "partial", assessedJobs: 0, failedJobs: 2 } });
    const recorded = await json<{ steps: { jobId: string | null; stage: string; status: string; errorCode: string | null }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
    expect(recorded.steps.find((step) => step.stage === "requirements_normalize")).toMatchObject({ status: "failed", errorCode: refusal });
    expect(recorded.steps.filter((step) => step.stage === "requirements" && step.status === "failed")).toHaveLength(2);
    expect(await requirementAttempts(app, started.runId)).toMatchObject(run.jobIds.map((job_id) => ({
      job_id, state: "blocked", failure_code: refusal, completed_at: expect.any(String),
    })));
    for (const id of run.jobIds) expect((await json<{ score: null }>(api, "get", `/v1/jobs/${id}/fit`)).score).toBeNull();
    expect(await readCatalog(api)).toEqual(catalogBefore);
    expect(await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`)).toEqual(accepted);
    expect((await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(priorScore.score);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(calls);
    expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
  });
}

for (const fault of ["missing row", "foreign requirement", "foreign citation"] as const) {
  test(`cohort qualification refuses a ${fault} without publishing partial scores`, async ({ api, app }) => {
    const seed = await createScoredFit(api, app, `cohort-qualification-${fault.replaceAll(" ", "-")}`);
    const accepted = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`);
    const priorScore = await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`);
    const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2 });
    const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
    const source = await app.external.next();
    expect(source.path).toBe("/jobstreaming/indeed");
    const incoming = [posting(31), posting(32)];
    source.respond(indeedPage({ jobs: incoming, cursor: null, complete: true }));
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

test("an unsupported-language posting is skipped while its English cohort sibling is assessed", async ({ api, app, page }) => {
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
  expect(updated.job_id).toBe(run.jobIds[1]);
  await expect(fitPanel).toContainText("No person-fit assessment has been recorded yet.");
  await page.goto("/jobs?fit_state=unassessed");
  await expect(row.getByRole("cell", { name: "Not assessed", exact: true })).toBeVisible();
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(1);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

test("cancelling an unsettled cohort qualification preserves its manifest and cannot spend a new retry allowance", async ({ api, app }) => {
  await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  const postings = [posting(51), posting(52)];
  source.respond(indeedPage({ jobs: postings, cursor: null, complete: true }));
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
    await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2, resultsPerSite: 2 });
    const first = { job_key: "legacy-cohort-first", url: "https://www.indeed.com/viewjob?jk=legacy-cohort-first", title: "Synthetic Legacy First Engineer", company: "Synthetic Legacy Company", description: "Maintain durable workflow recovery, including operational readiness.", location: "Madrid" };
    const second = { job_key: "legacy-cohort-second", url: "https://www.indeed.com/viewjob?jk=legacy-cohort-second", title: "Synthetic Legacy Second Engineer", company: "Synthetic Legacy Company", description: "Maintain operational readiness for durable workflow recovery.", location: "Madrid" };
    const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
    const source = await app.external.next();
    expect(source.path).toBe("/jobstreaming/indeed");
    source.respond(indeedPage({ jobs: [first, second], cursor: null, complete: true }));
    await servePostingAssessment(app, library, first, { qualificationExpected: false });

    // The predecessor has committed the first producer's Requirements while
    // the second job waits at an actual recoverable page transport boundary.
    const held = await app.external.next();
    expect(held.path).toBe("/posting-page");
    expect(held.body).toEqual({ url: second.url });
    const before = await json<{ jobIds: string[]; jobConcurrency: number; executionPolicy?: unknown; steps: {
      jobId: string | null; stage: string; status: string; result: unknown; postingRevision?: number
    }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
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
      expect(call.body["prompt_version"]).toBe(V6_NORMALIZATION_PROMPT_VERSION);
      expect(call.body["context"]).not.toHaveProperty("cohort_texts");
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
    for (const step of before.steps.filter((row) => row.status === "succeeded")) {
      const matches = after.steps.filter(row => row.jobId === step.jobId && row.stage === step.stage);
      expect(matches).toHaveLength(1);
      const { postingRevision, ...originalFields } = matches[0]!;
      expect(originalFields).toEqual(step);
      if (step.stage === "role_analysis" || step.stage === "requirements") expect(postingRevision).toBe(accepted.posting_revision);
      else if (step.stage === "enrich") expect(postingRevision).toBe(1); // The original discovered listing.
      else expect(postingRevision).toBeUndefined();
    }
    const retained = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${before.jobIds[0]}/requirements`);
    expect(retained.requirements[0]!.requirement_id).toBe(accepted.requirements[0]!.requirement_id);
    expect(retained.requirements[0]!.extraction_determination_id).toBe(accepted.requirements[0]!.extraction_determination_id);
    expect((await json<FitState>(api, "get", `/v1/jobs/${before.jobIds[0]}/fit`)).current).toBe(true);
    expect((await json<FitState>(api, "get", `/v1/jobs/${before.jobIds[1]}/fit`)).current).toBe(true);
    const calls = app.external.calls.filter((call) => call.path === "/model").map((call) => call.body["operation"]);
    expect(calls.slice(0, priorCalls.length)).toEqual(priorCalls);
    expect(calls.filter((operation) => operation === "requirements.match_catalog")).toHaveLength(2);
    expect(calls.filter((operation) => operation === "fit.qualification-batch")).toHaveLength(1);
    expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(1);
    expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=discovery.search")).runs.map((run) => run.runId)).toEqual([started.runId]);
  });
});

test.describe("failed serial predecessor recovery", () => {
  test.use({ sourceRevision: SERIAL_PREDECESSOR });

test("an actual predecessor upgrade preserves a failed job while a replacement worker finishes the frozen later job", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2, resultsPerSite: 2 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const first = { job_key: "replay-failed", url: "https://www.indeed.com/viewjob?jk=replay-failed", title: "Synthetic First Replay Engineer", company: "Synthetic Replay Company", description: "Maintain first-job workflow recovery.", location: "Madrid" };
  const second = { job_key: "replay-later", url: "https://www.indeed.com/viewjob?jk=replay-later", title: "Synthetic Later Replay Engineer", company: "Synthetic Replay Company", description: "Maintain later-job workflow recovery.", location: "Madrid" };
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  source.respond(indeedPage({ jobs: [first, second], cursor: null, complete: true }));
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
  expect(retained.steps).toContainEqual(expect.objectContaining(failed));
  expect(app.external.calls.filter((call) => call.path === "/jobstreaming/indeed")).toHaveLength(1);
  expect((await json<FitState>(api, "get", `/v1/jobs/${frozen.jobIds[1]}/fit`)).current).toBe(true);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "requirements.match_catalog")).toHaveLength(2);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(1);
});
});

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

test("a Profile edit during shared qualification refuses stale authority and preserves prior scores", async ({ api, app }) => {
  const seed = await createScoredFit(api, app, "cohort-profile-race");
  const previous = await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`);
  const priorScore = await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`);
  const settings = await json<{ revision: number }>(api, "get", "/v1/discovery/settings");
  await json(api, "patch", "/v1/discovery/settings", { expectedRevision: settings.revision, boards: ["indeed"], hoursOld: 0, newJobLimit: 2 });
  const started = await action(api, "discovery.search", { queries: ["Synthetic recovery engineer"], locations: [{ location: "Madrid", remote: true }] });
  const source = await app.external.next();
  expect(source.path).toBe("/jobstreaming/indeed");
  const postings = [posting(71), posting(72)];
  source.respond(indeedPage({ jobs: postings, cursor: null, complete: true }));
  const matching = await untilNormalization(app, postings);
  const run = await json<{ jobIds: string[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(run.jobIds).toHaveLength(2);
  const input = matching.body["context"] as CatalogContext;
  const prior = previous.requirements[0]!;
  const retained = retainedCapability(matching, prior.requirement_id, "retained");
  matching.reply(authoredPartition(matching, [retained, { groupId: "incoming", memberIds: input.incoming.map((row) => row.member_id),
    category: "professional_experience", name: COMMON_DEMAND, definition: COMMON_DEMAND }], [
    { groupId: "retained", definition: prior.normalized_demand.definition, jobIds: [seed.posting.job_id], reuseDemandFingerprint: prior.normalized_demand.demand_fingerprint },
    { groupId: "incoming", definition: COMMON_DEMAND, jobIds: run.jobIds },
  ]));
  const batch = await app.external.next();
  expect(batch.body["operation"]).toBe("fit.qualification-batch");
  const requirements = await Promise.all(run.jobIds.map((id) => json<NormalizedSnapshot>(api, "get", `/v1/jobs/${id}/requirements`)));
  const profile = await json<Profile>(api, "get", "/v1/profile");
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: { ...profile.profile,
    resume: { ...profile.profile.resume, experience_entries: profile.profile.resume.experience_entries.map((row, index) => index ? row
      : { ...row, summary: "Maintained services with a newly reviewed operational summary." }) } } });
  const achievement = seed.library.roles[0]!.achievements[0]!;
  batch.reply(qualificationBatchDecision(batch, () => ({ achievementIds: [achievement.achievement_id],
    evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] })));
  expect((await completed(api, started.runId))["result"]).toMatchObject({ ok: false, status: "partial",
    preparation: { status: "partial", assessedJobs: 0, failedJobs: 2 } });
  const recorded = await json<{ steps: { stage: string; status: string; errorCode: string | null }[] }>(api, "get", `/v1/preparation/runs/${started.runId}`);
  expect(recorded.steps.find((step) => step.stage === "fit_qualify")).toMatchObject({ status: "failed", errorCode: "revision_conflict" });
  for (const [index, id] of run.jobIds.entries()) {
    expect(await json<NormalizedSnapshot>(api, "get", `/v1/jobs/${id}/requirements`)).toEqual(requirements[index]);
    expect((await json<{ score: null }>(api, "get", `/v1/jobs/${id}/fit`)).score).toBeNull();
  }
  expect((await json<FitState>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(priorScore.score);
  expect(app.external.calls.filter((call) => call.body?.["operation"] === "fit.qualification-batch")).toHaveLength(2);
});
