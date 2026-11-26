import { createHash } from "node:crypto";
import { test, expect, json, modelCall, completed, terminal, type ApplicationStack } from "../harness/fixtures.js";
import { baseline, createBaseline, type Profile } from "./core-data.js";
import { createScoredFit, impactPartition, refreshPayload, startRefresh, type FitState, type ImpactContext, type PendingRefresh, type RefreshOperation } from "./fit-data.js";
import { qualificationBatchDecision, qualificationBindings } from "./qualification-data.js";
import { captureReusePosting, acceptReuseRequirements, type CapturedPosting } from "./reuse-data.js";
import { catalogMatching, typedExtraction, type ReusableDemand } from "./requirements-data.js";

const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, entry]) => [key, canonical(entry)])) : value;
const fingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
const operations = (app: ApplicationStack, since: number) => app.external.calls.slice(since).map((call) => call.body["operation"]);
const fit = (api: Parameters<typeof json>[0], jobId: string) => json<FitState>(api, "get", `/v1/jobs/${jobId}/fit`);
const pending = (api: Parameters<typeof json>[0]) => json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
const scoreOnly = (value: PendingRefresh, ids = value.available_job_ids) => ({ ...refreshPayload(value, ids, { max_model_calls: 2 }), prepare_wording: false, prepare_coverage: false });

test.describe("large mixed refresh", () => {
  test("manual Fit retains a structurally oversized current catalog and qualifies only mandatory items with bounded inputs", async ({ api, app }, testInfo) => {
    const authored = structuredClone(baseline);
    authored.resume.language_entries = [{ id: "english", language: "English", proficiency: "Fluent" }];
    authored.resume.experience_entries = authored.resume.experience_entries.map((row, role) => ({ ...row,
      bullets: Array.from({ length: 40 }, (_, index) => `Documented synthetic operational responsibility ${role + 1}.${index + 1} with retained recovery and review records.`) }));
    const { library } = await createBaseline(api, authored);
    const achievement = library.roles[0]!.achievements[0]!;
    const clauses: ReusableDemand[] = Array.from({ length: 52 }, (_, index) => ({ localId: `practice-${index + 1}`,
      category: "professional_experience", text: `Maintain independently requested synthetic operational practice ${index + 1} with source-bound recovery records.` }));
    const job = await captureReusePosting(api, "large-frozen-current", clauses.map((row) => row.text).join("\n"));
    const { snapshot } = await acceptReuseRequirements(api, app, job, clauses, Object.fromEntries(clauses.map((row) => [row.localId, { verdict: "new" as const }])));
    const assessing = api.post(`/v1/jobs/${job.job_id}/fit/assess`, { data: { expected_revision: 0, prepare_wording: false, prepare_coverage: false } });
    const firstBatch = await modelCall(app, "fit.qualification-batch");
    const response = qualificationBatchDecision(firstBatch, () => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] }));
    response.requirements.forEach((row) => { row.rationale = "The explicitly selected current facts support this independently requested synthetic operational responsibility. ".repeat(30); });
    firstBatch.reply(response);
    expect((await assessing).status()).toBe(200);
    const original = await fit(api, job.job_id);
    // The accepted public output is intentionally large; no recorded fixture is used.
    expect(Buffer.byteLength(JSON.stringify(original.score.assessments))).toBeGreaterThan(1024 * 1024);
    const peers: CapturedPosting[] = [];
    const peerScores: FitState[] = [];
    for (let index = 0; index < 3; index++) {
      const peer = await captureReusePosting(api, `large-current-peer-${index}`, clauses[0]!.text);
      await acceptReuseRequirements(api, app, peer, [clauses[0]!], { [clauses[0]!.localId]: { verdict: "equivalent", requirementId: snapshot.requirements[0]!.requirement_id } }, { extract: index === 0 });
      peers.push(peer);
      peerScores.push(await json<FitState>(api, "post", `/v1/jobs/${peer.job_id}/fit/assess`, { expected_revision: 0, prepare_wording: false, prepare_coverage: false }));
    }
    const updated = await json<CapturedPosting>(api, "patch", `/v1/jobs/${job.job_id}`, { expectedRevision: job.revision, description: `${clauses.map((row) => row.text).join("\n")}\nEnglish fluency.` });
    const refreshing = api.post(`/v1/jobs/${job.job_id}/requirements`, { data: { expected_posting_revision: updated.revision, expected_revision: snapshot.revision } });
    const extract = await modelCall(app, "requirements.extract");
    extract.reply(typedExtraction(extract, { requirements: clauses, languages: [{ text: "English fluency.", language: "English", proficiency: "Fluent" }] }));
    const matching = await modelCall(app, "requirements.match_catalog");
    matching.reply(catalogMatching(matching, Object.fromEntries(clauses.map((row, index) => [row.localId, { verdict: "equivalent", requirementId: snapshot.requirements[index]!.requirement_id }]))));
    expect((await refreshing).status()).toBe(200);
    const missing: ReusableDemand[] = Array.from({ length: 6 }, (_, index) => ({ localId: `new-${index + 1}`, category: "professional_experience", text: `Retain separate synthetic operations handover responsibility ${index + 1}.` }));
    const newJob = await captureReusePosting(api, "large-new-unqualified", missing.map((row) => row.text).join("\n"));
    await acceptReuseRequirements(api, app, newJob, missing, Object.fromEntries(missing.map((row) => [row.localId, { verdict: "new" as const }])));
    const ids = [job.job_id, ...peers.map((row) => row.job_id)];
    expect((await pending(api)).stale_job_ids).toEqual([job.job_id]);
    const before = app.external.calls.length;
    const run = await startRefresh(api, scoreOnly(await pending(api), ids), "large-scoped-successor");
    const batch = await modelCall(app, "fit.qualification-batch");
    const bindings = qualificationBindings(batch);
    expect(bindings).toHaveLength(7);
    expect(bindings.filter((row) => row.category === "language")).toHaveLength(1);
    const languageSource = (batch.body["sources"] as { source_id: string; text: string }[]).find((row) => row.source_id.startsWith("evidence:") && row.text.includes("English"))!;
    batch.reply(qualificationBatchDecision(batch, (binding) => binding.category === "language" ? { evidenceSourceIds: [languageSource.source_id], wordingSupport: "section" }
      : { achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] }));
    await completed(api, run.runId);
    const result = await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${run.runId}`);
    expect(result).toMatchObject({ factual_published: true, counters: { model_calls: 1, requirements_assessed: 7, qualifications_reused: 52 } });
    expect(operations(app, before)).toEqual(["fit.qualification-batch"]);
    for (const id of ids) expect((await fit(api, id)).current).toBe(true);
    for (const [index, peer] of peers.entries()) expect((await fit(api, peer.job_id)).score).toEqual(peerScores[index]!.score);
    expect((await fit(api, newJob.job_id)).score).toBeNull();
    const accepted = await fit(api, job.job_id);
    const language = accepted.score.assessments.find((row) => !row.demand_fingerprint)! as typeof accepted.score.assessments[number] & { impact_selection_kind: string; impact_selection_receipt_id: string | null };
    expect(language).toMatchObject({ impact_selection_kind: "mandatory_reassessment", impact_selection_receipt_id: null });
    const checkpoint = await app.fitRefreshCheckpoint(run.runId);
    const selection = checkpoint.checkpoints["selection"] as { decision: { requirements: unknown[] }; model_decision: { requirements: unknown[] }; scope_binding: { complete_partition_fingerprint: string } };
    expect(selection.decision.requirements).toHaveLength(59);
    expect(selection.model_decision.requirements).toEqual([]);
    expect(selection.scope_binding.complete_partition_fingerprint).toBe(fingerprint(selection.decision));
    const noCalls = app.external.calls.length;
    const exact = await startRefresh(api, scoreOnly(await pending(api), ids), "large-exact-zero-calls");
    await completed(api, exact.runId);
    expect((await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${exact.runId}`)).counters.model_calls).toBe(0);
    expect(operations(app, noCalls)).toEqual([]);
    expect((await fit(api, job.job_id)).score).toEqual(accepted.score);
    await testInfo.attach("large-refresh-scope-metrics", { contentType: "application/json", body: Buffer.from(JSON.stringify({ prior_assessment_bytes: Buffer.byteLength(JSON.stringify(original.score.assessments)), fixed_current: 52, mandatory: 7, semantic: 0, transmitted_qualification_items: bindings.length })) });
  });
});

test("manual Fit composes exact, mandatory and semantic-subset authority without cross-authorizing the fixed rows", async ({ api, app }) => {
  const { library } = await createBaseline(api);
  const achievement = library.roles[0]!.achievements[0]!;
  const definitions: ReusableDemand[] = [
    { localId: "skill", category: "skill", text: "Operate a source-bound recovery toolchain." },
    { localId: "experience", category: "professional_experience", text: "Retain a factual production operations background." },
  ];
  const job = await captureReusePosting(api, "mixed-selector", definitions.map((row) => row.text).join("\n"));
  const { snapshot } = await acceptReuseRequirements(api, app, job, definitions, { skill: { verdict: "new" }, experience: { verdict: "new" } });
  const assessing = api.post(`/v1/jobs/${job.job_id}/fit/assess`, { data: { expected_revision: 0, prepare_wording: false, prepare_coverage: false } });
  const first = await modelCall(app, "fit.qualification-batch");
  first.reply(qualificationBatchDecision(first, () => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] })));
  expect((await assessing).status()).toBe(200);
  const original = await fit(api, job.job_id);
  const skillId = snapshot.requirements[0]!.requirement_id;
  const exactId = snapshot.requirements[1]!.requirement_id;
  const currentProfile = await json<Profile>(api, "get", "/v1/profile");
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: currentProfile.profileVersion,
    profile: { ...currentProfile.profile, resume: { ...currentProfile.profile.resume, skill_categories: [{ ...currentProfile.profile.resume.skill_categories[0]!, items: ["Python", "SQLite", "Temporal", "Rust"] }] } } });
  const extra = await captureReusePosting(api, "mixed-mandatory", "Maintain a separate operations handover responsibility.");
  const { snapshot: extraRequirements } = await acceptReuseRequirements(api, app, extra,
    [{ localId: "handover", text: extra.description }], { handover: { verdict: "new" } });
  const mandatoryId = extraRequirements.requirements[0]!.requirement_id;
  const before = app.external.calls.length;
  const run = await startRefresh(api, scoreOnly(await pending(api), [job.job_id]), "mixed-three-authorities");
  const impact = await modelCall(app, "fit.catalog-impact");
  expect(impact.body["prompt_version"]).toBe("fit-impact-selection-scope-v1");
  const context = impact.body["context"] as ImpactContext & { selection_scope: { frozen_requirement_count: number; fixed_requirement_count: number } };
  expect(context.requirements.map((row) => row.requirement_id)).toEqual([skillId]);
  expect(context.selection_scope).toMatchObject({ frozen_requirement_count: 3, fixed_requirement_count: 2 });
  const sources = impact.body["sources"] as { source_id: string; text: string }[];
  expect(sources.filter((row) => row.source_id.startsWith("assessment:")).map((row) => row.source_id)).toEqual([context.requirements[0]!.saved_assessment_source_id]);
  expect(sources.some((row) => row.source_id.startsWith("current:") && row.text.includes("Rust"))).toBe(true);
  const raw = impactPartition(impact, { [skillId]: "unchanged" });
  impact.reply(raw);
  const batch = await modelCall(app, "fit.qualification-batch");
  expect(qualificationBindings(batch).map((row) => row.requirement_id)).toEqual([mandatoryId]);
  batch.reply(qualificationBatchDecision(batch, () => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] })));
  await completed(api, run.runId);
  const accepted = await fit(api, job.job_id);
  expect(accepted.current).toBe(true);
  expect(accepted.score.assessments.find((row) => row.requirement_id === exactId)).toEqual(original.score.assessments.find((row) => row.requirement_id === exactId));
  const revalidated = accepted.score.assessments.find((row) => row.requirement_id === skillId)! as typeof accepted.score.assessments[number] & { revalidation_provenance: Record<string, unknown> };
  expect(revalidated.revalidation_provenance["accepted_result_fingerprint"]).toBe(fingerprint(raw));
  const recorded = await app.fitRefreshCheckpoint(run.runId);
  const selection = recorded.checkpoints["selection"] as { model_decision: unknown; decision: { requirements: unknown[] }; provenance: Record<string, unknown>; scope_binding: { complete_partition_fingerprint: string } };
  expect(selection.model_decision).toEqual(raw);
  expect(selection.decision.requirements).toHaveLength(3);
  expect(selection.scope_binding.complete_partition_fingerprint).toBe(fingerprint(selection.decision));
  expect(selection.provenance["accepted_result_fingerprint"]).toBe(fingerprint(raw));
  expect(Object.values(recorded.calls).find((row) => row.kind === "fit.catalog-impact")!.result!.value).toEqual(raw);
  expect(operations(app, before)).toEqual(["fit.catalog-impact", "fit.qualification-batch"]);
  const read = await json<{ requirements: { requirement_id: string; assessment: { impact_selection_kind?: string; impact_selection_receipt_id?: string | null } | null }[] }>(api, "get", "/v1/fit/requirement-library");
  expect(read.requirements.find((row) => row.requirement_id === mandatoryId)!.assessment).toMatchObject({ impact_selection_kind: "mandatory_reassessment", impact_selection_receipt_id: null });
  // A returned fixed row cannot enlarge the unresolved model partition.
  const changed = await json<Profile>(api, "get", "/v1/profile");
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: changed.profileVersion,
    profile: { ...changed.profile, resume: { ...changed.profile.resume, skill_categories: [{ ...changed.profile.resume.skill_categories[0]!, items: [...changed.profile.resume.skill_categories[0]!.items, "Go"] }] } } });
  const invalid = await startRefresh(api, scoreOnly(await pending(api), [job.job_id]), "mixed-foreign-fixed-row");
  const held = await modelCall(app, "fit.catalog-impact");
  const value = impactPartition(held, { [skillId]: "unchanged" });
  held.reply({ requirements: [...value.requirements, { ...value.requirements[0]!, requirement_id: exactId }] });
  expect(await terminal(api, invalid.runId)).toMatchObject({ status: "failed", errorCode: "fit_refresh_partition_invalid" });
  expect((await fit(api, job.job_id)).score).toEqual(accepted.score);
  // Replay must reverify the new composed selection before recovering a call-only batch.
  const restartStart = app.external.calls.length;
  const restarting = await startRefresh(api, scoreOnly(await pending(api), [job.job_id]), "mixed-retained-selection");
  const selected = await modelCall(app, "fit.catalog-impact");
  selected.reply(impactPartition(selected, { [skillId]: "affected" }));
  await modelCall(app, "fit.qualification-batch");
  const checkpointBefore = await app.fitRefreshCheckpoint(restarting.runId);
  expect(checkpointBefore.checkpoints["selection"]).toMatchObject({ model_decision: { requirements: [{ requirement_id: skillId }] } });
  expect(checkpointBefore.checkpoints["qualification_batch"]).toBeUndefined();
  await app.restartWorker();
  expect(await terminal(api, restarting.runId)).toMatchObject({ status: "failed", errorCode: "fit_refresh_interrupted" });
  const checkpointAfter = await app.fitRefreshCheckpoint(restarting.runId);
  expect(checkpointAfter.checkpoints["selection"]).toEqual(checkpointBefore.checkpoints["selection"]);
  expect(checkpointAfter.calls).toEqual(checkpointBefore.calls);
  expect((await fit(api, job.job_id)).score).toEqual(accepted.score);
  expect(operations(app, restartStart)).toEqual(["fit.catalog-impact", "fit.qualification-batch"]);
});
