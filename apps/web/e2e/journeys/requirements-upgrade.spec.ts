import { test, expect, json, modelCall, completed } from "../harness/fixtures.js";
import { acceptBaseline, getResume } from "./core-data.js";
import { acceptedPdf, fitPath, readCatalog, requirementsPath, type NormalizedSnapshot } from "./consolidation-data.js";
import { createScoredFit, refreshPayload, startRefresh, type FitState, type PendingRefresh, type RefreshOperation } from "./fit-data.js";
import { qualificationBatchDecision } from "./qualification-data.js";
import { acceptReuseRequirements, type CapturedPosting } from "./reuse-data.js";

test("a new posting demand keeps prior Fit and accepted PDF history until an explicit update assesses the new source", async ({ api, app, page }, testInfo) => {
  const { profile, library, posting, requirements } = await createScoredFit(api, app, "requirements-demand-change");
  const jobId = posting.job_id;
  const fit = () => json<FitState>(api, "get", fitPath(jobId));
  const history = () => json<{ versions: FitState["score"][] }>(api, "get", `${fitPath(jobId)}/history`);
  const original = await json<NormalizedSnapshot>(api, "get", requirementsPath(jobId));
  const originalId = original.requirements[0]!.requirement_id;
  const meaningPath = `/v1/requirements/${originalId}`;
  const { active_in_library, occurrences, ...originalMeaning } = await json<
    Record<string, unknown> & { active_in_library: boolean; occurrences: NormalizedSnapshot["requirements"] }
  >(api, "get", `${meaningPath}?revision=1`);
  expect(active_in_library).toBe(true);
  expect(occurrences).toEqual(original.requirements);
  const oldFit = await fit();
  expect(oldFit).toMatchObject({ current: true, score: { score: 10 } });
  const oldHistory = await history();
  const resume = await acceptBaseline(api, jobId, profile.profileVersion);
  const pdf = await acceptedPdf(api, resume.resume_id);
  await json(api, "post", "/v1/digest/acknowledge", {});

  const beforeSave = app.external.calls.length;
  const demand = "Establish explicit review ownership for operational changes.";
  const edited = await json<CapturedPosting>(api, "patch", `/v1/jobs/${jobId}`, {
    expectedRevision: posting.revision, description: demand,
  });
  expect(await json(api, "get", requirementsPath(jobId))).toMatchObject({
    revision: requirements.revision, stale: true, requirements: original.requirements,
  });
  expect((await fit()).score).toEqual(oldFit.score);
  expect(await history()).toEqual(oldHistory);
  expect(app.external.calls).toHaveLength(beforeSave);

  const { snapshot } = await acceptReuseRequirements(api, app, edited,
    [{ localId: "ownership", text: demand }], { ownership: { verdict: "new" } },
    { expectedRevision: requirements.revision });
  const requirementId = snapshot.requirements[0]!.requirement_id;
  expect(requirementId).toMatch(/^requirements-v2:/);
  expect(requirementId).not.toBe(originalId);
  expect(snapshot).toMatchObject({ contract_version: "requirements-v2", revision: original.revision + 1,
    posting_revision: edited.revision, posting_hash: edited.source_hash, stale: false });
  const catalog = await readCatalog(api);
  expect(catalog.requirements.map(row => row.requirement_id)).toEqual([requirementId]);
  const historical = await json(api, "get", `${meaningPath}?revision=1`);
  expect(historical).toEqual({ ...originalMeaning, active_in_library: false, occurrences: [] });
  const occurrenceHistory = await json<{ rows: unknown[] }>(api, "get", `${meaningPath}/history?kind=occurrences`);
  expect(occurrenceHistory.rows).toMatchObject([{ ...occurrences[0], accepted: false, current: false,
    stale_reasons: expect.arrayContaining(["snapshot_superseded", "posting_changed_or_unavailable"]) }]);
  expect(await fit()).toMatchObject({ current: false, stale_reasons: ["requirements_changed"], score: oldFit.score });
  expect(await history()).toEqual(oldHistory);
  expect(await json(api, "get", "/v1/digest")).toMatchObject({ staleScores: { count: 1 } });
  expect(await json(api, "get", "/v1/jobs/query?minFitScore=1&fit_state=current")).toMatchObject({ total: 0, rows: [] });
  expect(await json(api, "get", "/v1/jobs/query?minFitScore=1&fit_state=stale")).toMatchObject({ total: 1, rows: [{
    fit: { job_id: jobId, current: false, score: { revision: oldFit.score.revision, score: oldFit.score.score },
      stale_reasons: ["requirements_changed"] },
    scalars: { fit_score: oldFit.score.score },
  }] });
  const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
  expect(pending.stale_job_ids).toContain(jobId);
  expect((await json<{ runs: unknown[] }>(api, "get", "/v1/action-runs?action=fit.refresh")).runs).toEqual([]);
  expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);
  expect(app.external.calls.slice(beforeSave).map(row => row.body["operation"])).toEqual(["requirements.extract", "requirements.match_catalog"]);

  const beforeRefresh = app.external.calls.length;
  const key = "requirements-demand-change";
  const refresh = { ...refreshPayload(pending, [jobId], { max_model_calls: 1, max_requirements: 1 }),
    prepare_wording: false, prepare_coverage: false };
  const run = await startRefresh(api, refresh, key);
  const achievement = library.roles[0]!.achievements[1]!;
  const qualification = await modelCall(app, "fit.qualification-batch");
  qualification.reply(qualificationBatchDecision(qualification, binding => {
    expect(binding.requirement_id).toBe(requirementId);
    return { achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] };
  }));
  const completedRun = await completed(api, run.runId);
  const operation = await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${run.runId}`);
  expect(operation).toMatchObject({ operation_id: run.runId, status: "completed",
    factual_published: true, counters: { model_calls: 1, requirements_assessed: 1 } });
  const currentFit = await fit();
  expect(currentFit).toMatchObject({ current: true, score: {
    contract_version: "requirements-v2", revision: oldFit.score.revision + 1, score: 10,
    assessments: [{ requirement_id: requirementId, impact_selection_kind: "initial_qualification",
      impact_selection_receipt_id: null, impact_selection_provenance: { kind: "structural", basis: "all_prior_assessment_ids_absent" } }],
  } });
  expect((await history()).versions).toEqual(expect.arrayContaining(oldHistory.versions));

  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  expect(await startRefresh(api, refresh, key)).toEqual(completedRun);
  expect((await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending")).latest_operation).toEqual(operation);
  expect((await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=fit.refresh")).runs.map(row => row.runId)).toEqual([run.runId]);
  const retained = await getResume(api, resume.resume_id);
  expect(retained.accepted_revision_id).toBe(resume.accepted_revision_id);
  expect(retained.revisions).toEqual(resume.revisions);
  expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);

  await page.goto(`/jobs/${jobId}`);
  await page.locator("summary").filter({ hasText: /^Update affected matches$/ }).click();
  const panel = page.getByRole("region", { name: "Affected matches", exact: true });
  await expect(panel.getByRole("alert")).toHaveCount(0);
  await expect(panel.getByRole("button", { name: "Request cancellation", exact: true })).toHaveCount(0);
  await panel.locator("summary").filter({ hasText: /^Run details$/ }).click();
  await expect(panel.getByRole("link", { name: "View full run", exact: true })).toHaveAttribute("href", `/runs/${run.runId}`);
  expect(app.external.calls.slice(beforeRefresh).map(row => row.body["operation"])).toEqual(["fit.qualification-batch"]);
  await testInfo.attach("updated-source-authority", { contentType: "application/json", body: JSON.stringify({
    runId: run.runId, originalId, requirementId, oldFitRevision: oldFit.score.revision, fitRevision: currentFit.score.revision,
    receiptId: currentFit.score.assessments[0]!.provenance.receipt_id, acceptedRevision: resume.accepted_revision_id, acceptedBytes: pdf.byteLength,
  }) });
});
