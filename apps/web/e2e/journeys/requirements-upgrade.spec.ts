import { test, expect, json, modelCall, completed, type ExternalCall } from "../harness/fixtures.js";
import { baseline, createBaseline, acceptBaseline, getResume, type Profile } from "./core-data.js";
import { captureReusePosting, type RequirementSnapshot } from "./reuse-data.js";
import { catalogMatching, typedExtraction, citeSources, modelSources } from "./requirements-data.js";
import { groupedCoverageDecision, impactPartition, refreshPayload, startRefresh, type PendingRefresh } from "./fit-data.js";
import { qualificationBatchDecision } from "./qualification-data.js";

// This exact public predecessor writes its own real state. CI fetches this Git
// object; the harness archives source only into the newly owned temporary run.
test.use({ sourceRevision: "8ab86e9232d66fff9795906e061d208e7a057d8b" });

function legacyQualification(call: ExternalCall, achievementId: string, sourceId: string) {
  expect(call.body["prompt_version"]).toBe("fit-qualification-batch-v1");
  const context = call.body["context"] as { requirements: { requirement_id: string; requirement_revision: string; source_id: string }[] };
  return { requirements: context.requirements.map((row) => ({
    requirement_id: row.requirement_id, requirement_revision: row.requirement_revision,
    kind: "matched", strength: "direct", confidence: "high",
    rationale: "The explicitly cited authored achievement establishes this qualification.",
    evidence: citeSources(call, [sourceId]), requirement_citations: citeSources(call, [row.source_id]),
    achievement_ids: [achievementId], keywords: [], eligibility: "unknown", blocker_category: null, warning_category: null,
  })) };
}

test("a real predecessor upgrade preserves history and accepted bytes, starts an empty generation and rejects old durable replay without automatic calls", async ({ api, app, page }, testInfo) => {
  const { language_entries: _newDefault, ...oldResume } = baseline.resume;
  const { profile, library } = await createBaseline(api, { ...baseline, resume: oldResume });
  const posting = await captureReusePosting(api, "legacy-upgrade", "Implement and maintain durable workflow recovery.");
  await json(api, "post", "/v1/digest/acknowledge", {});
  const extracting = api.post(`/v1/jobs/${posting.job_id}/requirements`, { data: { expected_posting_revision: posting.revision, expected_revision: 0 } });
  const oldExtraction = await modelCall(app, "requirements.extract");
  expect(oldExtraction.body["prompt_version"]).toBe("requirements-extract-v3-content-bound");
  const source = modelSources(oldExtraction)[0]!;
  oldExtraction.reply({
    status: "complete", requirements: [{ local_id: "recovery", text: source.text, definition: "Implement durable workflow recovery", qualifiers: [], scope: "resume", tier: "must_have", weight: 1, support: "supported", spans: [{ source_id: source.source_id, quote: source.text }] }],
    reason: "Explicit legacy source-bound synthetic demand.", citations: citeSources(oldExtraction, [source.source_id]),
  });
  const oldMatching = await modelCall(app, "requirements.match_catalog");
  const { status: _newStatus, ...legacyMatching } = catalogMatching(oldMatching, { recovery: { verdict: "new" } });
  oldMatching.reply(legacyMatching);
  const extracted = await extracting;
  expect(extracted.status(), await extracted.text()).toBe(200);
  const oldRequirements = await extracted.json() as RequirementSnapshot;
  expect(oldRequirements).not.toHaveProperty("contract_version");
  const achievement = library.roles[0]!.achievements[0]!;
  const evidenceId = `evidence:${achievement.source_refs[0]!.source_id}`;
  const assessing = api.post(`/v1/jobs/${posting.job_id}/fit/assess`, { data: { expected_revision: 0, prepare_wording: false, prepare_coverage: false } });
  const oldQualification = await modelCall(app, "fit.qualification-batch");
  oldQualification.reply(legacyQualification(oldQualification, achievement.achievement_id, evidenceId));
  expect((await assessing).status()).toBe(200);
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: { ...profile.profile, personal: { ...profile.profile.personal, full_name: "Synthetic Upgrade Candidate" } } });
  const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
  const refresh = { ...refreshPayload(pending, [posting.job_id], { max_model_calls: 3, max_requirements: 1 }), prepare_wording: false };
  const key = "legacy-upgrade-refresh";
  const oldRun = await startRefresh(api, refresh, key);
  const impact = await modelCall(app, "fit.catalog-impact");
  impact.reply(impactPartition(impact, { [oldRequirements.requirements[0]!.requirement_id]: "affected" }));
  const refreshedQualification = await modelCall(app, "fit.qualification-batch");
  refreshedQualification.reply(legacyQualification(refreshedQualification, achievement.achievement_id, evidenceId));
  const oldCoverage = await modelCall(app, "fit.wording-coverage-grouped");
  oldCoverage.reply(groupedCoverageDecision(oldCoverage, { evidenceSourceId: evidenceId, status: "covered", action: "reuse_approved", reusableVariantId: achievement.baseline_variant_id }));
  const oldAction = await completed(api, oldRun.runId);
  const oldProfile = await json<Profile>(api, "get", "/v1/profile");
  const acceptedResume = await acceptBaseline(api, posting.job_id, oldProfile.profileVersion);
  const oldPdf = await api.get(`/v1/resumes/${acceptedResume.resume_id}/export?format=pdf&accepted=true`);
  expect(oldPdf.status(), await oldPdf.text()).toBe(200);
  const acceptedBytes = await oldPdf.body();
  type Fit = { current: boolean; stale_reasons: string[]; selection: { ready_for_materials: boolean }; score: { revision: number; score: number } };
  const oldFit = await json<Fit>(api, "get", `/v1/jobs/${posting.job_id}/fit`);
  const oldHistory = await json(api, "get", `/v1/jobs/${posting.job_id}/fit/history`);
  const oldSchema = await app.databaseSchemaFingerprint();
  expect(oldFit.score.score).toBe(10);
  const callsBeforeUpgrade = app.external.calls.length;
  const replacement = await app.upgradeSource();
  expect(replacement.current).not.toBe(replacement.previous);
  expect(await app.databaseSchemaFingerprint()).toBe(oldSchema);
  const currentProfile = await json<Profile>(api, "get", "/v1/profile");
  expect(currentProfile).toMatchObject({ profileVersion: oldProfile.profileVersion, profile: { resume: { language_entries: [] } } });
  const noOp = await json<Profile>(api, "patch", "/v1/profile", { expectedProfileVersion: currentProfile.profileVersion, profile: currentProfile.profile });
  expect(noOp.profileVersion).toBe(oldProfile.profileVersion);
  const catalog = await json<{ total: number; requirements: unknown[] }>(api, "get", "/v1/requirements");
  expect(catalog).toMatchObject({ total: 0, requirements: [] });
  expect((await json<{ requirements: unknown[] }>(api, "get", "/v1/fit/requirement-library")).requirements).toEqual([]);
  const historicRequirements = await json<RequirementSnapshot & { stale_reasons: string[] }>(api, "get", `/v1/jobs/${posting.job_id}/requirements`);
  expect(historicRequirements).toMatchObject({ revision: oldRequirements.revision, stale: true, stale_reasons: ["contract_changed"] });
  expect(historicRequirements.requirements).toEqual(oldRequirements.requirements);
  const historicFit = await json<Fit>(api, "get", `/v1/jobs/${posting.job_id}/fit`);
  expect(historicFit).toMatchObject({ current: false, stale_reasons: ["contract_changed"], selection: { ready_for_materials: false }, score: oldFit.score });
  expect(await json(api, "get", `/v1/jobs/${posting.job_id}/fit/history`)).toEqual(oldHistory);
  expect(await json(api, "get", `/v1/action-runs/${oldRun.runId}`)).toEqual(oldAction);
  const historicOperation = await json(api, "get", `/v1/fit/refresh/operations/${oldRun.runId}`);
  expect(historicOperation).toMatchObject({ contract_version: null, current: false, stale_reasons: ["contract_changed"], operation_id: oldRun.runId, status: "completed" });
  expect((await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending")).latest_operation).toEqual(historicOperation);
  await page.goto(`/jobs/${posting.job_id}`);
  await page.locator("summary").filter({ hasText: /^Update affected matches$/ }).click();
  const historyPanel = page.getByRole("region", { name: "Affected matches", exact: true });
  await expect(historyPanel).toContainText("Historical update: the requirements contract changed. Its recorded results remain available for inspection; this update cannot be resumed under the current contract.");
  await expect(historyPanel.getByRole("alert")).toHaveCount(0);
  await expect(historyPanel.getByRole("button", { name: "Retry previous update", exact: true })).toHaveCount(0);
  await expect(historyPanel.getByRole("button", { name: "Request cancellation", exact: true })).toHaveCount(0);
  await historyPanel.locator("summary").filter({ hasText: /^Run details$/ }).click();
  await expect(historyPanel.getByRole("link", { name: "View full run", exact: true })).toHaveAttribute("href", `/runs/${oldRun.runId}`);
  expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=fit.refresh")).runs.map((row) => row.runId)).toEqual([oldRun.runId]);
  const digest = await json(api, "get", "/v1/digest");
  expect(digest).toMatchObject({ newMatches: { count: 0, highFitCount: 0 }, staleScores: { count: 1 } });
  expect(await json(api, "get", "/v1/jobs/query?minFitScore=1")).toMatchObject({ total: 0, rows: [] });
  const ranking = await json<{ rows: { scalars: { fit_score: number | null } }[] }>(api, "get", "/v1/jobs/query?sort=fit_score&direction=desc");
  expect(ranking.rows[0]!.scalars.fit_score).toBeNull();
  const retainedResume = await getResume(api, acceptedResume.resume_id);
  expect(retainedResume.accepted_revision_id).toBe(acceptedResume.accepted_revision_id);
  expect(retainedResume.revisions.map((row) => row.document)).toEqual(acceptedResume.revisions.map((row) => row.document));
  const retainedPdf = await api.get(`/v1/resumes/${acceptedResume.resume_id}/export?format=pdf&accepted=true`);
  expect(retainedPdf.status(), await retainedPdf.text()).toBe(200);
  expect(await retainedPdf.body()).toEqual(acceptedBytes);
  const replay = await api.post("/v1/actions/fit.refresh", { headers: { "idempotency-key": key }, data: refresh });
  expect(replay.status(), await replay.text()).toBe(409);
  expect(await replay.json()).toMatchObject({ error: { code: "action_contract_changed" } });
  expect(app.external.calls).toHaveLength(callsBeforeUpgrade);

  const newExtractionRequest = api.post(`/v1/jobs/${posting.job_id}/requirements`, { data: { expected_posting_revision: posting.revision, expected_revision: oldRequirements.revision } });
  const newExtraction = await modelCall(app, "requirements.extract");
  newExtraction.reply(typedExtraction(newExtraction, { requirements: [{ localId: "recovery", text: source.text, name: "Durable workflow recovery" }] }));
  const newMatching = await modelCall(app, "requirements.match_catalog");
  expect((newMatching.body["context"] as { candidates: unknown[] }).candidates).toEqual([]);
  newMatching.reply(catalogMatching(newMatching, { recovery: { verdict: "new" } }));
  const newResponse = await newExtractionRequest;
  expect(newResponse.status(), await newResponse.text()).toBe(200);
  const currentRequirements = await newResponse.json() as RequirementSnapshot;
  expect(currentRequirements).toMatchObject({ contract_version: "requirements-v2", revision: oldRequirements.revision + 1, stale: false });
  expect(currentRequirements.requirements[0]!.requirement_id).toMatch(/^requirements-v2:/);
  expect(currentRequirements.requirements[0]!.requirement_id).not.toBe(oldRequirements.requirements[0]!.requirement_id);
  const newPending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
  const beforeInitial = app.external.calls.length;
  const newRun = await startRefresh(api, { ...refreshPayload(newPending, [posting.job_id], { max_model_calls: 1, max_requirements: 1 }), prepare_wording: false, prepare_coverage: false }, "current-generation-refresh");
  const sectionSource = (await json<{ sources: { source_id: string; kind: string }[] }>(api, "get", "/v1/profile/sources")).sources.find((row) => row.kind === "role")!;
  const newAssessment = await modelCall(app, "fit.qualification-batch");
  newAssessment.reply(qualificationBatchDecision(newAssessment, () => ({ evidenceSourceIds: [`evidence:${sectionSource.source_id}`] })));
  await completed(api, newRun.runId);
  expect(await json(api, "get", `/v1/jobs/${posting.job_id}/fit`)).toMatchObject({ current: true, score: {
    contract_version: "requirements-v2", revision: oldFit.score.revision + 1, score: 10,
    assessments: [{ impact_selection_kind: "initial_qualification", impact_selection_receipt_id: null,
      impact_selection_provenance: { kind: "structural", basis: "all_prior_assessment_ids_absent" } }],
  } });
  expect(app.external.calls.slice(beforeInitial).filter((row) => row.path === "/model").map((row) => row.body["operation"])).toEqual(["fit.qualification-batch"]);
  expect((await getResume(api, acceptedResume.resume_id)).accepted_revision_id).toBe(acceptedResume.accepted_revision_id);
  await testInfo.attach("workspace-generation-upgrade", { contentType: "application/json", body: JSON.stringify({ predecessor: "8ab86e9232d66fff9795906e061d208e7a057d8b", candidateOrigin: replacement.candidateOrigin, candidateMode: replacement.mode, schemaFingerprint: oldSchema, oldRunId: oldRun.runId, oldRequirementId: oldRequirements.requirements[0]!.requirement_id, newRequirementId: currentRequirements.requirements[0]!.requirement_id, oldRevision: oldFit.score.revision, newRevision: oldFit.score.revision + 1, acceptedRevision: acceptedResume.accepted_revision_id, acceptedBytes: acceptedBytes.byteLength }) });
});
