import { createHash } from "node:crypto";
import { test, expect, json, modelCall, action, terminal, completed } from "../harness/fixtures.js";
import { createBaseline, type Profile } from "./core-data.js";
import { qualificationBatchDecision, type QualificationBinding } from "./qualification-data.js";
import { captureReusePosting, acceptReuseRequirements, type CapturedPosting, type RequirementSnapshot } from "./reuse-data.js";
import { citeSources, modelSources } from "./requirements-data.js";
import { createScoredFit, impactPartition, refreshPayload, startRefresh, type PendingRefresh, type RefreshOperation } from "./fit-data.js";

const definitions = [
  { localId: "recovery", text: "Implement durable workflow recovery." },
  { localId: "ownership", text: "Establish review ownership for operational changes." },
];
const choices = { recovery: { verdict: "new" as const }, ownership: { verdict: "new" as const } };
type Assessment = {
  assessment_id: string; requirement_id: string; requirement_revision: number; determination_id: string;
  kind: string; rationale: string; requirement_citations: { source_id: string; quote: string }[];
  provenance: { receipt_id: string; prompt_version: string; accepted_result_fingerprint: string; qualification_result_fingerprint: string; provider: string; model: string; lane: string };
};
type Fit = { current: boolean; score: null | { revision: number; score: number; assessments: Assessment[] }; reused_qualifications?: number };
const fitPath = (job: CapturedPosting) => `/v1/jobs/${job.job_id}/fit`;
const assessBody = { expected_revision: 0, prepare_wording: false, prepare_coverage: false };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");

async function cold(api: Parameters<typeof json>[0], app: Parameters<typeof modelCall>[0], slug: string) {
  const { library } = await createBaseline(api);
  const posting = await captureReusePosting(api, slug, definitions.map((row) => row.text).join("\n"));
  const { snapshot } = await acceptReuseRequirements(api, app, posting, definitions, choices);
  const achievement = library.roles[0]!.achievements[0]!;
  return { posting, snapshot, library, choose: (_binding: QualificationBinding) => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] }) };
}

test("Fit batches cold requirements once, shares exact receipts and reuses only current authority across Jobs", async ({ api, app }) => {
  const seed = await cold(api, app, "batch-cold");
  const before = app.external.calls.length;
  const pending = api.post(`${fitPath(seed.posting)}/assess`, { data: assessBody });
  const batch = await modelCall(app, "fit.qualification-batch");
  const context = batch.body["context"] as { requirements: QualificationBinding[]; achievements: unknown[] };
  expect(context.requirements.map((row) => row.requirement_id).sort()).toEqual(seed.snapshot.requirements.map((row) => row.requirement_id).sort());
  const response = qualificationBatchDecision(batch, seed.choose);
  // Ordering is not authority: the complete reversed partition is still valid.
  response.requirements.reverse();
  batch.reply(response);
  const accepted = await pending;
  expect(accepted.status(), await accepted.text()).toBe(200);
  const first = await accepted.json() as Fit;
  expect(first.current).toBe(true);
  expect(first.score!.assessments).toHaveLength(2);
  expect(first.score!.score).toBe(10);
  expect(new Set(first.score!.assessments.map((row) => row.determination_id)).size).toBe(1);
  expect(new Set(first.score!.assessments.map((row) => row.assessment_id)).size).toBe(2);
  for (const row of first.score!.assessments) {
    const decision = response.requirements.find((item) => item.requirement_id === row.requirement_id)!;
    expect(row.provenance).toMatchObject({ receipt_id: row.determination_id, prompt_version: "fit-qualification-batch-v1", lane: "scoring", accepted_result_fingerprint: fingerprint(response), qualification_result_fingerprint: fingerprint(decision) });
    expect(row.requirement_revision).toBe(Number(decision.requirement_revision));
    expect(row.requirement_citations).toEqual(decision.requirement_citations);
    expect(row.requirement_citations[0]!.source_id).toBe(`requirement:${row.requirement_id}`);
  }
  expect(app.external.calls.slice(before).map((call) => call.body["operation"])).toEqual(["fit.qualification-batch"]);
  const factualSources = modelSources(batch).filter((row) => row.source_id.startsWith("evidence:"));
  expect(factualSources.length).toBeGreaterThan(1);
  expect(new Set(factualSources.map((row) => row.source_id)).size).toBe(factualSources.length);

  const equivalent = Object.fromEntries(definitions.map((row, index) => [row.localId, { verdict: "equivalent" as const, requirementId: seed.snapshot.requirements[index]!.requirement_id }]));
  const second = await captureReusePosting(api, "batch-exact-peer", definitions.map((row) => row.text).join("\n"));
  await acceptReuseRequirements(api, app, second, definitions, equivalent, { extract: false });
  const beforeExact = app.external.calls.length;
  const reused = await json<Fit>(api, "post", `${fitPath(second)}/assess`, assessBody);
  expect(reused.score!.assessments.map((row) => row.assessment_id).sort()).toEqual(first.score!.assessments.map((row) => row.assessment_id).sort());
  expect(reused.score!.assessments.map((row) => row.provenance)).toEqual(first.score!.assessments.map((row) => row.provenance));
  expect(app.external.calls).toHaveLength(beforeExact);

  const extra = { localId: "import", text: "Build a versioned data import tool." };
  const mixedDefinitions = [...definitions, extra];
  const mixed = await captureReusePosting(api, "batch-mixed-peer", mixedDefinitions.map((row) => row.text).join("\n"));
  const mixedRequirements = await acceptReuseRequirements(api, app, mixed, mixedDefinitions, { ...equivalent, import: { verdict: "new" } });
  const missingId = mixedRequirements.snapshot.requirements[2]!.requirement_id;
  const beforeMixed = app.external.calls.length;
  const assessingMixed = api.post(`${fitPath(mixed)}/assess`, { data: assessBody });
  const onlyMissing = await modelCall(app, "fit.qualification-batch");
  expect((onlyMissing.body["context"] as { requirements: QualificationBinding[] }).requirements.map((row) => row.requirement_id)).toEqual([missingId]);
  onlyMissing.reply(qualificationBatchDecision(onlyMissing, () => ({ kind: "missing" })));
  expect((await assessingMixed).status()).toBe(200);
  const mixedFit = await json<Fit>(api, "get", fitPath(mixed));
  for (const row of first.score!.assessments) expect(mixedFit.score!.assessments.find((item) => item.requirement_id === row.requirement_id)).toMatchObject({ assessment_id: row.assessment_id, provenance: row.provenance });
  expect(mixedFit.score!.assessments.find((row) => row.requirement_id === missingId)).toMatchObject({ kind: "missing" });
  expect(app.external.calls.slice(beforeMixed).map((call) => call.body["operation"])).toEqual(["fit.qualification-batch"]);
});

async function saveChangedPreference(api: Parameters<typeof json>[0]) {
  const profile = await json<Profile>(api, "get", "/v1/profile");
  return json<Profile>(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion,
    profile: { ...profile.profile, experience: { target_work_models: "remote", target_locations: "Synthetic City" } },
  });
}

test("a new Job initially batches historical and unseen qualifications after a preference edit without refreshing old scores", async ({ api, app }) => {
  const seed = await createScoredFit(api, app, "historical-initial-old");
  const oldJob = seed.posting as CapturedPosting;
  const oldFit = await json<Fit>(api, "get", fitPath(oldJob));
  const oldHistory = await json(api, "get", `${fitPath(oldJob)}/history`);
  const sharedId = seed.requirements.requirements[0]!.requirement_id;
  const beforeSave = app.external.calls.length;
  const changed = await saveChangedPreference(api);
  expect(changed.profileVersion).toBeGreaterThan(seed.profile.profileVersion);
  expect((await json<Fit>(api, "get", fitPath(oldJob))).current).toBe(false);
  await json(api, "get", "/v1/fit/refresh/pending");
  expect(app.external.calls).toHaveLength(beforeSave);
  expect((await json<{ runs: unknown[] }>(api, "get", "/v1/action-runs?action=fit.refresh")).runs).toEqual([]);

  // A current unrelated Job makes the fixed-set boundary observable: the new
  // Job may not reassess this catalog authority or rewrite its accepted score.
  const unrelatedDefinitions = [{ localId: "checklists", text: "Document operational release checklists." }];
  const unrelated = await captureReusePosting(api, "historical-initial-unrelated", unrelatedDefinitions[0]!.text);
  const unrelatedRequirements = await acceptReuseRequirements(api, app, unrelated, unrelatedDefinitions, { checklists: { verdict: "new" } });
  const unrelatedRun = await action(api, "fit.assess", { job_id: unrelated.job_id, ...assessBody });
  const unrelatedBatch = await modelCall(app, "fit.qualification-batch");
  unrelatedBatch.reply(qualificationBatchDecision(unrelatedBatch, () => ({ kind: "missing" })));
  await completed(api, unrelatedRun.runId);
  const unrelatedFit = await json<Fit>(api, "get", fitPath(unrelated));
  expect(unrelatedFit.current).toBe(true);

  const incoming = [{ localId: "recovery", text: "Implement and maintain durable workflow recovery." },
    { localId: "import", text: "Build a versioned data import tool." }];
  const newJob = await captureReusePosting(api, "historical-initial-new", incoming.map((row) => row.text).join("\n"));
  const requirements = await acceptReuseRequirements(api, app, newJob, incoming, {
    recovery: { verdict: "equivalent", requirementId: sharedId }, import: { verdict: "new" },
  });
  expect((await json<Fit>(api, "get", fitPath(newJob))).score).toBeNull();
  const beforeInitial = app.external.calls.length;
  const initial = await action(api, "fit.assess", { job_id: newJob.job_id, ...assessBody });
  const batch = await modelCall(app, "fit.qualification-batch");
  const ids = (batch.body["context"] as { requirements: QualificationBinding[] }).requirements.map((row) => row.requirement_id).sort();
  expect(ids).toEqual(requirements.snapshot.requirements.map((row) => row.requirement_id).sort());
  expect(ids).toContain(sharedId);
  expect(ids).not.toContain(unrelatedRequirements.snapshot.requirements[0]!.requirement_id);
  batch.reply(qualificationBatchDecision(batch, (binding) => {
    const achievement = binding.requirement_id === sharedId ? seed.library.roles[0]!.achievements[0]! : seed.library.roles[1]!.achievements[0]!;
    return { achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] };
  }));
  const accepted = await completed(api, initial.runId);
  expect(accepted.result).toMatchObject({ reuse: { reused_qualifications: 0, assessed_qualifications: 2, score_reused: false } });
  const current = await json<Fit>(api, "get", fitPath(newJob));
  expect(current.current).toBe(true);
  expect(current.score!.revision).toBe(1);
  expect(current.score!.assessments).toHaveLength(2);
  expect(current.score!.assessments.find((row) => row.requirement_id === sharedId)!.assessment_id).not.toBe(oldFit.score!.assessments[0]!.assessment_id);
  expect(new Set(current.score!.assessments.map((row) => row.determination_id)).size).toBe(1);
  expect(app.external.calls.slice(beforeInitial).map((call) => call.body["operation"])).toEqual(["fit.qualification-batch"]);

  const beforeOldRetry = app.external.calls.length;
  for (const force of [false, true]) {
    const refused = await api.post(`${fitPath(oldJob)}/assess`, { data: { ...assessBody, expected_revision: oldFit.score!.revision, force } });
    expect(refused.status()).toBe(409);
    expect(await refused.json()).toMatchObject({ error: { code: "fit_refresh_required" } });
  }
  expect(app.external.calls).toHaveLength(beforeOldRetry);
  expect((await json<Fit>(api, "get", fitPath(oldJob)))).toMatchObject({ current: false, score: oldFit.score });
  expect(await json(api, "get", `${fitPath(oldJob)}/history`)).toEqual(oldHistory);
  expect(await json<Fit>(api, "get", fitPath(unrelated))).toEqual(unrelatedFit);

  const beforeExact = app.external.calls.length;
  const retry = await action(api, "fit.assess", { job_id: newJob.job_id, ...assessBody, expected_revision: current.score!.revision });
  const reused = await completed(api, retry.runId);
  expect(reused.result).toMatchObject({ reuse: { reused_qualifications: 2, assessed_qualifications: 0, score_reused: true }, score: current.score });
  expect(await json<Fit>(api, "get", fitPath(newJob))).toEqual(current);
  expect(app.external.calls).toHaveLength(beforeExact);
});

test("a held initial Job batch cannot replace a concurrently published historical qualification head", async ({ api, app }) => {
  const seed = await createScoredFit(api, app, "historical-head-old");
  const oldHistory = await json(api, "get", `/v1/jobs/${seed.posting.job_id}/fit/history`);
  await saveChangedPreference(api);
  const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0, laneConcurrency: { scoring: 2 } });
  const sharedId = seed.requirements.requirements[0]!.requirement_id;
  const requirement = [{ localId: "recovery", text: "Implement and maintain durable workflow recovery." }];
  const jobs = [];
  for (const suffix of ["first", "second"]) {
    const posting = await captureReusePosting(api, `historical-head-${suffix}`, `${requirement[0]!.text}\nAuthored ${suffix} source context.`);
    await acceptReuseRequirements(api, app, posting, requirement, { recovery: { verdict: "equivalent", requirementId: sharedId } });
    jobs.push(posting);
  }
  const before = app.external.calls.length;
  const first = await action(api, "fit.assess", { job_id: jobs[0]!.job_id, ...assessBody });
  const firstBatch = await modelCall(app, "fit.qualification-batch");
  const second = await action(api, "fit.assess", { job_id: jobs[1]!.job_id, ...assessBody });
  const secondBatch = await modelCall(app, "fit.qualification-batch");
  for (const batch of [firstBatch, secondBatch]) expect((batch.body["context"] as { requirements: QualificationBinding[] }).requirements.map((row) => row.requirement_id)).toEqual([sharedId]);
  const achievement = seed.library.roles[0]!.achievements[0]!;
  firstBatch.reply(qualificationBatchDecision(firstBatch, () => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] })));
  await completed(api, first.runId);
  const winner = await json<Fit>(api, "get", fitPath(jobs[0]!));
  expect(winner.current).toBe(true);
  secondBatch.reply(qualificationBatchDecision(secondBatch, () => ({ kind: "missing" })));
  expect(await terminal(api, second.runId)).toMatchObject({ status: "failed", errorCode: "revision_conflict" });
  expect((await json<Fit>(api, "get", fitPath(jobs[1]!))).score).toBeNull();
  expect(await json<Fit>(api, "get", fitPath(jobs[0]!))).toEqual(winner);
  const library = await json<{ requirements: { requirement_id: string; assessment: Assessment | null }[] }>(api, "get", "/v1/fit/requirement-library");
  expect(library.requirements.find((row) => row.requirement_id === sharedId)!.assessment).toMatchObject({ assessment_id: winner.score!.assessments[0]!.assessment_id, determination_id: winner.score!.assessments[0]!.determination_id, current: true });
  expect(await json(api, "get", `/v1/jobs/${seed.posting.job_id}/fit/history`)).toEqual(oldHistory);
  expect((await json<Fit>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).current).toBe(false);
  expect(app.external.calls.slice(before).map((call) => call.body["operation"])).toEqual(["fit.qualification-batch", "fit.qualification-batch"]);
});

for (const defect of ["incomplete", "duplicate", "foreign requirement", "cross-row citation", "non-verbatim evidence", "stale revision"] as const) {
  test(`Fit qualification batch ${defect} publishes no partial authority and keeps accepted scores`, async ({ api, app }) => {
    const seed = await createScoredFit(api, app, `batch-guard-${defect.replaceAll(" ", "-")}`, { twoRequirements: true });
    const original = await json<Fit>(api, "get", fitPath(seed.posting as CapturedPosting));
    const profile = await json<Profile>(api, "get", "/v1/profile");
    await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: { ...profile.profile, personal: { ...profile.profile.personal, full_name: "Synthetic Batch Guard Change" } } });
    const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
    const before = app.external.calls.length;
    const run = await startRefresh(api, { ...refreshPayload(pending), prepare_wording: false }, `batch-invalid-${defect}`);
    const impact = await modelCall(app, "fit.catalog-impact");
    impact.reply(impactPartition(impact, Object.fromEntries(seed.requirements.requirements.map((row) => [row.requirement_id, "affected" as const]))));
    const batch = await modelCall(app, "fit.qualification-batch");
    const achievement = seed.library.roles[0]!.achievements[0]!;
    const response = qualificationBatchDecision(batch, () => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] }));
    const first = response.requirements[0]!;
    if (defect === "incomplete") response.requirements.pop();
    if (defect === "duplicate") response.requirements[1] = structuredClone(first);
    if (defect === "foreign requirement") response.requirements[1]!.requirement_id = "unrequested-canonical-requirement";
    if (defect === "cross-row citation") response.requirements[1]!.requirement_citations = structuredClone(first.requirement_citations);
    if (defect === "non-verbatim evidence") response.requirements[1]!.evidence[0]!.quote = "This factual quote never occurred in any supplied source.";
    if (defect === "stale revision") response.requirements[1]!.requirement_revision = "999";
    batch.reply(response);
    const expectedCode = { incomplete: "fit_qualification_partition_invalid", duplicate: "fit_qualification_partition_invalid", "foreign requirement": "fit_qualification_partition_invalid", "cross-row citation": "fit_foreign_source_id", "non-verbatim evidence": "fit_non_verbatim_quote", "stale revision": "fit_requirement_binding_invalid" }[defect];
    expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: expectedCode });
    const retained = await json<Fit>(api, "get", fitPath(seed.posting as CapturedPosting));
    expect(retained.score).toEqual(original.score);
    expect(retained.current).toBe(false);
    const result = await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${run.runId}`);
    expect(result.factual_published).toBe(false);
    expect(result.counters.model_calls).toBe(2);
    expect(result.counters.requirements_assessed).toBe(0);
    expect(app.external.calls.slice(before).map((call) => call.body["operation"])).toEqual(["fit.catalog-impact", "fit.qualification-batch"]);
    const library = await json<{ requirements: { requirement_id: string; assessment?: Assessment | null }[] }>(api, "get", "/v1/fit/requirement-library");
    for (const row of original.score!.assessments) {
      const current = library.requirements.find((item) => item.requirement_id === row.requirement_id);
      expect(current?.assessment).toMatchObject({ assessment_id: row.assessment_id, determination_id: row.determination_id, current: false });
    }
  });
}

for (const changedSource of ["Profile", "requirement binding"] as const) {
  test(`Fit qualification batch rejects an in-flight ${changedSource} change before current publication`, async ({ api, app }) => {
    const seed = await cold(api, app, `batch-stale-${changedSource.replaceAll(" ", "-")}`);
    if (changedSource === "requirement binding") {
      // The concurrency probe needs two admitted external calls. A finite
      // monetary budget deliberately serializes unsettled calls instead.
      const settings = await json<{ revision: number }>(api, "get", "/v1/settings");
      await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision, dailyBudgetUsd: 0 });
    }
    const run = await action(api, "fit.assess", { job_id: seed.posting.job_id, ...assessBody });
    const batch = await modelCall(app, "fit.qualification-batch");
    if (changedSource === "Profile") {
      const profile = await json<Profile>(api, "get", "/v1/profile");
      await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: { ...profile.profile, personal: { ...profile.profile.personal, full_name: "Synthetic In-flight Profile" } } });
    } else {
      const occurrence = seed.snapshot.requirements[0]!;
      const correcting = api.post(`/v1/jobs/${seed.posting.job_id}/requirements/${occurrence.occurrence_id}/binding`, { data: {
        expected_posting_revision: seed.posting.revision, expected_revision: seed.snapshot.revision,
        requirement_id: occurrence.requirement_id, requirement_revision: occurrence.requirement_revision,
        reason: "Explicitly confirm this occurrence's qualified canonical meaning.",
      } });
      const correction = await modelCall(app, "requirements.correct_binding");
      expect(correction.body["prompt_version"]).toBe("requirements-binding-correction-v1");
      expect((correction.body["context"] as { posting: { job_id: string } }).posting.job_id).toBe(seed.posting.job_id);
      expect(modelSources(correction).some((row) => row.source_id.startsWith(`posting:${seed.posting.job_id}:`))).toBe(true);
      correction.reply({ decisions: [{ requirement_id: occurrence.requirement_id, requirement_revision: occurrence.requirement_revision, relation: "equivalent", reason: "The exact current posting supports the selected canonical meaning.", citations: citeSources(correction, modelSources(correction).map((row) => row.source_id)) }] });
      const corrected = await correcting;
      expect(corrected.status(), await corrected.text()).toBe(200);
      expect((await corrected.json()).revision).toBe(seed.snapshot.revision + 1);
    }
    batch.reply(qualificationBatchDecision(batch, seed.choose));
    expect((await terminal(api, run.runId)).status).toBe("failed");
    expect((await json<Fit>(api, "get", fitPath(seed.posting))).score).toBeNull();
    const library = await json<{ requirements: { assessment: unknown }[] }>(api, "get", "/v1/fit/requirement-library");
    expect(library.requirements.map((row) => row.assessment)).toEqual([null, null]);
    expect(app.external.calls.filter((call) => call.body["operation"] === "fit.qualification-batch")).toHaveLength(1);
  });
}

test("Fit qualification batch cancellation through the durable public action publishes no rows", async ({ api, app }) => {
  const seed = await cold(api, app, "batch-cancel");
  const run = await action(api, "fit.assess", { job_id: seed.posting.job_id, ...assessBody });
  const batch = await modelCall(app, "fit.qualification-batch");
  expect(await json(api, "post", `/v1/action-runs/${run.runId}/cancel`, {})).toMatchObject({ cancellationRequested: true });
  batch.reply(qualificationBatchDecision(batch, seed.choose));
  expect((await terminal(api, run.runId)).status).toBe("cancelled");
  expect((await json<Fit>(api, "get", fitPath(seed.posting))).score).toBeNull();
  expect((await json<{ requirements: { assessment: unknown }[] }>(api, "get", "/v1/fit/requirement-library")).requirements.map((row) => row.assessment)).toEqual([null, null]);
  expect(app.external.calls.filter((call) => call.body["operation"] === "fit.qualification-batch")).toHaveLength(1);
});

test("manual Fit batches two selected items within two persisted calls and exact replay adds no work", async ({ api, app }) => {
  const seed = await createScoredFit(api, app, "batch-manual-bounds", { twoRequirements: true });
  const profile = await json<Profile>(api, "get", "/v1/profile");
  const revised = structuredClone(profile.profile);
  revised.resume.experience_entries[0]!.bullets = ["Reviewed service dashboards.", "Recorded routine status updates."];
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: revised });
  const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
  const payload = { ...refreshPayload(pending, undefined, { max_model_calls: 2, max_requirements: 2 }), prepare_wording: false };
  const before = app.external.calls.length;
  const run = await startRefresh(api, payload, "batch-manual-two-calls");
  const selector = await modelCall(app, "fit.catalog-impact");
  selector.reply(impactPartition(selector, Object.fromEntries(seed.requirements.requirements.map((row) => [row.requirement_id, "affected" as const]))));
  const batch = await modelCall(app, "fit.qualification-batch");
  expect((batch.body["context"] as { requirements: unknown[] }).requirements).toHaveLength(2);
  batch.reply(qualificationBatchDecision(batch, () => ({ kind: "missing" })));
  await completed(api, run.runId);
  const result = await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${run.runId}`);
  expect(result).toMatchObject({ status: "completed", factual_published: true, counters: { model_calls: 2, requirements_assessed: 2 } });
  expect((result as RefreshOperation & { limits: unknown }).limits).toEqual(payload.limits);
  expect((await startRefresh(api, payload, "batch-manual-two-calls")).runId).toBe(run.runId);
  expect(await json(api, "get", `/v1/fit/refresh/operations/${run.runId}`)).toEqual(result);
  expect(app.external.calls.slice(before).map((call) => call.body["operation"])).toEqual(["fit.catalog-impact", "fit.qualification-batch"]);
});

test("manual Fit retains its completed batch and fixed allowance across a real worker replacement", async ({ api, app }) => {
  const seed = await createScoredFit(api, app, "batch-retained-restart", { twoRequirements: true });
  const profile = await json<Profile>(api, "get", "/v1/profile");
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: { ...profile.profile, personal: { ...profile.profile.personal, full_name: "Synthetic Batch Checkpoint" } } });
  const payload = refreshPayload(await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending"), undefined, { max_model_calls: 3, max_requirements: 2 });
  const before = app.external.calls.length;
  const run = await startRefresh(api, payload, "batch-retained-before-restart");
  const selector = await modelCall(app, "fit.catalog-impact");
  selector.reply(impactPartition(selector, Object.fromEntries(seed.requirements.requirements.map((row) => [row.requirement_id, "affected" as const]))));
  const batch = await modelCall(app, "fit.qualification-batch");
  batch.reply(qualificationBatchDecision(batch, (binding) => {
    const index = seed.requirements.requirements.findIndex((row) => row.requirement_id === binding.requirement_id);
    const achievement = seed.library.roles[0]!.achievements[index]!;
    return { achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] };
  }));
  const held = await modelCall(app, "fit.wording-coverage-grouped");
  const beforeRestart = await json<Fit>(api, "get", fitPath(seed.posting as CapturedPosting));
  expect(beforeRestart.current).toBe(true);
  expect(new Set(beforeRestart.score!.assessments.map((row) => row.determination_id)).size).toBe(1);
  const recorded = await json<RefreshOperation & { limits: unknown; deadline_at: string }>(api, "get", `/v1/fit/refresh/operations/${run.runId}`);
  expect(recorded).toMatchObject({ factual_published: true, counters: { model_calls: 3, requirements_assessed: 2 } });
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  await expect.poll(() => held.closed).toBe(true);
  expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: "fit_refresh_interrupted" });
  const afterRestart = await json<RefreshOperation & { limits: unknown; deadline_at: string }>(api, "get", `/v1/fit/refresh/operations/${run.runId}`);
  expect(afterRestart).toMatchObject({ factual_published: true, counters: { model_calls: 3, requirements_assessed: 2 }, limits: recorded.limits, deadline_at: recorded.deadline_at });
  expect((await json<Fit>(api, "get", fitPath(seed.posting as CapturedPosting))).score).toEqual(beforeRestart.score);
  expect((await startRefresh(api, payload, "batch-retained-before-restart")).runId).toBe(run.runId);
  expect(app.external.calls.slice(before).map((call) => call.body["operation"])).toEqual(["fit.catalog-impact", "fit.qualification-batch", "fit.wording-coverage-grouped"]);
});
