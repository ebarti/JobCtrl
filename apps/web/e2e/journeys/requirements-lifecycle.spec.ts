import { randomUUID } from "node:crypto";
import { test, expect, json, modelCall, completed } from "../harness/fixtures.js";
import { acceptBaseline, type Profile } from "./core-data.js";
import { createScoredFit, groupedCoverageDecision, qualificationBatchDecision, refreshPayload, startRefresh, type GroupedCoverageContext, type PendingRefresh } from "./fit-data.js";
import { catalogContext, citeSources, modelSources } from "./requirements-data.js";
import { acceptReuseRequirements, captureReusePosting, type RequirementSnapshot } from "./reuse-data.js";

type Meaning = { requirement_id: string; revision: number; name: string; definition: string };
type Catalog = { catalog_revision: number; total: number; requirements: Meaning[] };
type Library = { requirements: (Meaning & { assessment: unknown; associations: unknown[] })[] };
type Detail = Meaning & { active_in_library: boolean; occurrences: unknown[] };
type History = { active_in_library: boolean; total: number; rows: { occurrence_id: string; current: boolean; stale_reasons: string[] }[] };

test("Requirements library follows deleted and restored job roots while retaining shared meanings history Profile links and accepted bytes", async ({ api, app, page }, testInfo) => {
  const seed = await createScoredFit(api, app, "library-lifecycle-first", { twoRequirements: true });
  const initial = await json<Catalog>(api, "get", "/v1/requirements");
  const shared = initial.requirements.find((row) => row.requirement_id === seed.requirements.requirements[0]!.requirement_id)!;
  const unique = initial.requirements.find((row) => row.requirement_id === seed.requirements.requirements[1]!.requirement_id)!;
  expect(initial.total).toBe(2);

  const second = await captureReusePosting(api, "library-lifecycle-second", "Implement and maintain durable workflow recovery.");
  await acceptReuseRequirements(api, app, second,
    [{ localId: "recovery", text: second.description }],
    { recovery: { verdict: "equivalent", requirementId: shared.requirement_id } });
  const achievement = seed.library.roles[0]!.achievements[1]!;
  const association = await json<{ association_id: string }>(api, "post", "/v1/fit/associations", {
    association_id: randomUUID(), profile_id: "default", expected_profile_revision: seed.profile.profileVersion,
    requirement_id: unique.requirement_id, requirement_revision: unique.revision,
    achievement_id: achievement.achievement_id, achievement_source_refs: achievement.source_refs, wording: null,
  });
  const associationPath = `/v1/fit/associations/${association.association_id}/history`;
  const associationHistory = await json(api, "get", associationPath);
  const requirementsBefore = await json<RequirementSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`);
  const fitHistoryBefore = await json(api, "get", `/v1/jobs/${seed.posting.job_id}/fit/history`);
  const profileBefore = await json<Profile>(api, "get", "/v1/profile");
  const resume = await acceptBaseline(api, seed.posting.job_id, seed.profile.profileVersion);
  const pdfPath = `/v1/resumes/${resume.resume_id}/export?format=pdf&accepted=true`;
  const pdfBefore = await api.get(pdfPath);
  expect(pdfBefore.status(), await pdfBefore.text()).toBe(200);
  const acceptedBytes = await pdfBefore.body();
  const detailBefore = await json<Detail>(api, "get", `/v1/requirements/${unique.requirement_id}`);
  const historyPath = `/v1/requirements/${unique.requirement_id}/history?kind=occurrences`;
  const historyBefore = await json<History>(api, "get", historyPath);
  expect(detailBefore.active_in_library).toBe(true);
  expect(historyBefore.rows).toHaveLength(1);
  const epochBeforeVisibility = (await json<Catalog>(api, "get", "/v1/requirements")).catalog_revision;
  const callsBeforeVisibility = app.external.calls.length;

  await page.goto(`/requirements?requirement=${encodeURIComponent(unique.requirement_id)}`);
  const library = page.getByRole("region", { name: "Requirements library", exact: true });
  await expect(library).toContainText(unique.name);
  await expect(library).toContainText(shared.name);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);

  async function membership(expected: string[], expectedEpoch = epochBeforeVisibility) {
    const [catalog, composed] = await Promise.all([
      json<Catalog>(api, "get", "/v1/requirements"),
      json<Library>(api, "get", "/v1/fit/requirement-library"),
    ]);
    expect(catalog.requirements.map((row) => row.requirement_id).sort()).toEqual([...expected].sort());
    expect(catalog.total).toBe(expected.length);
    expect(composed.requirements.map((row) => row.requirement_id).sort()).toEqual([...expected].sort());
    expect(catalog.catalog_revision).toBe(expectedEpoch);
  }

  await json(api, "post", `/v1/jobs/${seed.posting.job_id}/hide`, {});
  await membership([shared.requirement_id, unique.requirement_id]);
  await json(api, "post", `/v1/jobs/${seed.posting.job_id}/delete`, {});
  await membership([shared.requirement_id]);
  await expect(library).not.toContainText(unique.name);
  await expect(library).toContainText(shared.name);
  const filtered = await json<Catalog>(api, "get", `/v1/requirements?q=${encodeURIComponent(unique.definition)}&limit=1&offset=0`);
  expect(filtered).toMatchObject({ total: 0, requirements: [] });
  const retired = await json<Detail>(api, "get", `/v1/requirements/${unique.requirement_id}?revision=${unique.revision}`);
  expect(retired).toEqual({ ...detailBefore, active_in_library: false });
  const retiredHistory = await json<History>(api, "get", historyPath);
  expect(retiredHistory.active_in_library).toBe(false);
  expect(retiredHistory.rows.map((row) => row.occurrence_id)).toEqual(historyBefore.rows.map((row) => row.occurrence_id));
  expect(retiredHistory.rows[0]).toMatchObject({ current: false, stale_reasons: ["posting_changed_or_unavailable"] });
  expect(await json(api, "get", associationPath)).toEqual(associationHistory);
  expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(profileBefore);
  const retainedPdf = await api.get(pdfPath);
  expect(retainedPdf.status(), await retainedPdf.text()).toBe(200);
  expect(await retainedPdf.body()).toEqual(acceptedBytes);

  await json(api, "post", `/v1/jobs/${second.job_id}/delete`, {});
  await membership([]);
  await expect(library).not.toContainText(shared.name);
  expect((await json<Detail>(api, "get", `/v1/requirements/${shared.requirement_id}`)).active_in_library).toBe(false);
  await json(api, "post", `/v1/jobs/${seed.posting.job_id}/restore`, {});
  await membership([shared.requirement_id, unique.requirement_id]);
  await expect(library).toContainText(unique.name);
  await expect(library).toContainText(shared.name);
  expect(await json<RequirementSnapshot>(api, "get", `/v1/jobs/${seed.posting.job_id}/requirements`)).toEqual(requirementsBefore);
  expect(await json(api, "get", `/v1/jobs/${seed.posting.job_id}/fit/history`)).toEqual(fitHistoryBefore);
  expect(await json(api, "get", historyPath)).toEqual(historyBefore);
  expect(await json(api, "get", associationPath)).toEqual(associationHistory);
  await json(api, "post", `/v1/jobs/${second.job_id}/restore`, {});
  await membership([shared.requirement_id, unique.requirement_id]);
  await json(api, "post", `/v1/jobs/${seed.posting.job_id}/delete`, {});
  await membership([shared.requirement_id]);
  await json(api, "post", `/v1/jobs/${seed.posting.job_id}/restore`, {});
  await membership([shared.requirement_id, unique.requirement_id]);
  await expect(library).toContainText(unique.name);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  expect(app.external.calls).toHaveLength(callsBeforeVisibility);

  // Retirement is library membership, not removal from the semantic inventory.
  await json(api, "post", `/v1/jobs/${seed.posting.job_id}/delete`, {});
  await json(api, "post", `/v1/jobs/${second.job_id}/delete`, {});
  await membership([]);
  const later = await captureReusePosting(api, "library-lifecycle-later", "Establish explicit review ownership for operational changes.");
  const reused = await acceptReuseRequirements(api, app, later,
    [{ localId: "ownership", text: later.description }],
    { ownership: { verdict: "equivalent", requirementId: unique.requirement_id } });
  const matching = catalogContext(reused.matching!);
  expect(matching.candidates.map((row) => row.requirement_id).sort()).toEqual([shared.requirement_id, unique.requirement_id].sort());
  expect(reused.snapshot.requirements[0]!.requirement_id).toBe(unique.requirement_id);
  const epochAfterRediscovery = (await json<Catalog>(api, "get", "/v1/requirements")).catalog_revision;
  expect(epochAfterRediscovery).toBeGreaterThan(epochBeforeVisibility);
  await membership([unique.requirement_id], epochAfterRediscovery);
  await expect(library).toContainText(unique.name);
  expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(profileBefore);
  expect(await json(api, "get", associationPath)).toEqual(associationHistory);
  await testInfo.attach("requirements-library-lifecycle", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
});

for (const [position, decision, status] of [["leading", "reject", "rejected"], ["non-leading", "defer", "deferred"]] as const) {
  test(`permanent ${position} grouped requirement deletion preserves ${status} wording intent for the surviving job`, async ({ api, app }) => {
    const seed = await createScoredFit(api, app, `group-purge-${position}-recovery`, { sameAchievement: true });
    const achievement = seed.library.roles[0]!.achievements[0]!;
    const firstId = seed.requirements.requirements[0]!.requirement_id;
    const second = await captureReusePosting(api, `group-purge-${position}-ownership`, "Establish explicit review ownership for operational changes.");
    const secondRequirements = await acceptReuseRequirements(api, app, second,
      [{ localId: "ownership", text: second.description }], { ownership: { verdict: "new" } });
    const secondId = secondRequirements.snapshot.requirements[0]!.requirement_id;
    const assessing = api.post(`/v1/jobs/${second.job_id}/fit/assess`, {
      data: { expected_revision: 0, prepare_wording: false, prepare_coverage: false },
    });
    const qualification = await modelCall(app, "fit.qualification-batch");
    qualification.reply(qualificationBatchDecision(qualification, () => ({
      achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`],
    })));
    const assessed = await assessing;
    expect(assessed.status(), await assessed.text()).toBe(200);

    const orderedIds = [firstId, secondId].toSorted();
    const purgedId = orderedIds[position === "leading" ? 0 : 1]!;
    const survivorId = orderedIds[position === "leading" ? 1 : 0]!;
    const jobs = new Map([[firstId, seed.posting.job_id], [secondId, second.job_id]]);
    const original = await startRefresh(api,
      refreshPayload(await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending")), `group-purge-${position}-proposal`);
    const grouped = await modelCall(app, "fit.wording-coverage-grouped");
    expect((grouped.body["context"] as GroupedCoverageContext).binding.requirements.map((row) => row.requirement_id)).toEqual(orderedIds);
    grouped.reply(groupedCoverageDecision(grouped, {
      evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`, status: "not_covered",
      action: "propose_wording", gapRequirementIds: orderedIds,
    }));
    const authoring = await modelCall(app, "profile.wording_authoring");
    const proposedText = "Built durable workflow recovery with explicit review ownership for operational changes.";
    authoring.reply({ support: "supported", text: proposedText,
      rationale: "One expression preserves this achievement's two explicitly supported capabilities.",
      citations: citeSources(authoring, modelSources(authoring).map((row) => row.source_id)),
    });
    await completed(api, original.runId);
    type Wording = { profileVersion: number; variants: { variant_id: string; revision: number; text: string; status: string;
      provenance: { determination_id: string; intended_requirement_ids: string[] } }[];
      proposals: { proposal_id: string; origin_key: string; status: string; variant_id: string; gap_requirement_ids: string[] }[] };
    const proposed = await json<Wording>(api, "get", "/v1/profile/wording");
    const variant = proposed.variants.find((row) => row.text === proposedText)!;
    expect(variant.status).toBe("pending");
    const reviewed = await json<Wording>(api, "post", `/v1/profile/wording/${variant.variant_id}/decision`, {
      expectedProfileVersion: proposed.profileVersion, expectedVariantRevision: variant.revision, exactText: variant.text, decision,
    });
    const proposal = reviewed.proposals.find((row) => row.variant_id === variant.variant_id)!;
    expect(proposal.status).toBe(status);
    expect(proposal.gap_requirement_ids.toSorted()).toEqual(orderedIds);
    expect(variant.provenance.intended_requirement_ids.toSorted()).toEqual(orderedIds);
    const receiptPath = `/v1/profile/determinations/${variant.provenance.determination_id}`;
    const immutableReceipt = await json(api, "get", receiptPath);
    const profileBefore = await json<Profile>(api, "get", "/v1/profile");
    const beforePurge = app.external.calls.length;
    await json(api, "post", `/v1/jobs/${jobs.get(purgedId)!}/delete`, {});
    const selection = await json<{ selectionId: string }>(api, "post", "/v1/jobs/permanent-delete-selection", { jobIds: [jobs.get(purgedId)!] });
    await json(api, "post", "/v1/jobs/bulk-delete-permanent", { jobIds: [jobs.get(purgedId)!], selectionId: selection.selectionId });
    expect((await api.get(`/v1/requirements/${purgedId}`)).status()).toBe(404);
    expect((await json<Library>(api, "get", "/v1/fit/requirement-library")).requirements.map((row) => row.requirement_id)).toEqual([survivorId]);
    expect(await json<Wording>(api, "get", "/v1/profile/wording")).toEqual(reviewed);
    expect(await json(api, "get", receiptPath)).toEqual(immutableReceipt);
    expect(app.external.calls).toHaveLength(beforePurge);

    const refresh = await startRefresh(api,
      refreshPayload(await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending"), [jobs.get(survivorId)!]),
      `group-purge-${position}-survivor`);
    const survivingGroup = await modelCall(app, "fit.wording-coverage-grouped");
    const context = survivingGroup.body["context"] as GroupedCoverageContext & {
      retained_requirement_ids: string[];
      retained_requests: { proposal_id: string; origin_key: string; status: string; requirement_ids: string[] }[];
    };
    expect(context.binding.requirements.map((row) => row.requirement_id)).toEqual([survivorId]);
    expect(context.retained_requirement_ids).toEqual([survivorId]);
    expect(context.retained_requests).toHaveLength(1);
    expect(context.retained_requests[0]).toMatchObject({
      proposal_id: proposal.proposal_id, origin_key: proposal.origin_key, status, requirement_ids: [survivorId],
    });
    survivingGroup.reply(groupedCoverageDecision(survivingGroup, {
      evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`, status: "not_covered", action: "no_meaningful_gap",
    }));
    await completed(api, refresh.runId);
    expect(await json(api, "get", `/v1/fit/refresh/operations/${refresh.runId}`)).toMatchObject({
      status: "completed", counters: { model_calls: 1, wording_proposals: 0, requirements_assessed: 0 },
    });
    expect(app.external.calls.slice(beforePurge).map((call) => call.body["operation"])).toEqual(["fit.wording-coverage-grouped"]);
    expect(await json<Wording>(api, "get", "/v1/profile/wording")).toEqual(reviewed);
    expect(await json<Profile>(api, "get", "/v1/profile")).toEqual(profileBefore);
    expect(await json(api, "get", receiptPath)).toEqual(immutableReceipt);
  });
}

test("permanent job deletion removes only orphaned canonical meanings and Fit links while preserving soft-deleted shared meanings and Profile wording", async ({ api, app }) => {
  const seed = await createScoredFit(api, app, "library-permanent-first", { twoRequirements: true });
  const sharedId = seed.requirements.requirements[0]!.requirement_id;
  const uniqueId = seed.requirements.requirements[1]!.requirement_id;
  const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
  const prime = await startRefresh(api, refreshPayload(pending), "library-permanent-prime");
  for (let index = 0; index < 2; index += 1) {
    const call = await modelCall(app, "fit.wording-coverage-grouped");
    const binding = call.body["context"] as GroupedCoverageContext;
    const achievement = seed.library.roles.flatMap((role) => role.achievements)
      .find((row) => row.achievement_id === binding.binding.achievement_id)!;
    call.reply(groupedCoverageDecision(call, {
      evidenceSourceId: `evidence:${achievement.source_refs[0]!.source_id}`, status: "covered",
      action: "reuse_approved", reusableVariantId: achievement.baseline_variant_id,
    }));
  }
  await completed(api, prime.runId);
  const second = await captureReusePosting(api, "library-permanent-second", "Implement and maintain durable workflow recovery.");
  await acceptReuseRequirements(api, app, second,
    [{ localId: "recovery", text: second.description }],
    { recovery: { verdict: "equivalent", requirementId: sharedId } });
  const achievement = seed.library.roles[0]!.achievements[1]!;
  const association = await json<{ association_id: string }>(api, "post", "/v1/fit/associations", {
    association_id: randomUUID(), profile_id: "default", expected_profile_revision: seed.profile.profileVersion,
    requirement_id: uniqueId, requirement_revision: 1, achievement_id: achievement.achievement_id,
    achievement_source_refs: achievement.source_refs, wording: null,
  });
  type RetainedLibrary = { requirements: (Meaning & { assessment: unknown; coverage: unknown[]; current_wordings: { assignment_id: string }[];
    demand_assessments: ({ job_ids: string[] } & Record<string, unknown>)[] })[] };
  const libraryBefore = await json<RetainedLibrary>(api, "get", "/v1/fit/requirement-library");
  const sharedBefore = libraryBefore.requirements.find((row) => row.requirement_id === sharedId)!;
  const uniqueBefore = libraryBefore.requirements.find((row) => row.requirement_id === uniqueId)!;
  expect(uniqueBefore.current_wordings).toHaveLength(1);
  expect(uniqueBefore.coverage.length).toBeGreaterThan(0);
  const profileBefore = await json(api, "get", "/v1/profile");
  const wordingBefore = await json(api, "get", "/v1/profile/wording");
  const callsBeforeDelete = app.external.calls.length;
  const epochBefore = (await json<Catalog>(api, "get", "/v1/requirements")).catalog_revision;

  await json(api, "post", `/v1/jobs/${seed.posting.job_id}/delete`, {});
  await json(api, "post", `/v1/jobs/${second.job_id}/delete`, {});
  expect((await json<Catalog>(api, "get", "/v1/requirements")).requirements).toEqual([]);
  const selection = await json<{ selectionId: string }>(api, "post", "/v1/jobs/permanent-delete-selection", { jobIds: [seed.posting.job_id] });
  const permanent = await json<{ deletionCommitted: boolean }>(api, "post", "/v1/jobs/bulk-delete-permanent", {
    jobIds: [seed.posting.job_id], selectionId: selection.selectionId,
  });
  expect(permanent.deletionCommitted).toBe(true);
  expect((await api.get(`/v1/requirements/${uniqueId}`)).status()).toBe(404);
  expect((await api.get(`/v1/requirements/${uniqueId}/history?kind=revisions`)).status()).toBe(404);
  expect((await api.get(`/v1/fit/associations/${association.association_id}/history`)).status()).toBe(404);
  expect((await api.get(`/v1/fit/current-wordings/${uniqueBefore.current_wordings[0]!.assignment_id}/history`)).status()).toBe(404);
  expect((await api.post(`/v1/jobs/${seed.posting.job_id}/restore`, { data: {} })).status()).toBe(404);
  const retained = await json<Detail>(api, "get", `/v1/requirements/${sharedId}`);
  expect(retained.active_in_library).toBe(false);
  expect(retained.occurrences).toHaveLength(1);
  expect((await json<{ fresh: boolean; meaning_count: number }>(api, "get", "/v1/requirements/index"))).toMatchObject({ fresh: true, meaning_count: 1 });
  expect((await json<Catalog>(api, "get", "/v1/requirements")).catalog_revision).toBeGreaterThan(epochBefore);
  expect(await json(api, "get", "/v1/profile")).toEqual(profileBefore);
  expect(await json(api, "get", "/v1/profile/wording")).toEqual(wordingBefore);
  await json(api, "post", `/v1/jobs/${second.job_id}/restore`, {});
  const restored = await json<RetainedLibrary>(api, "get", "/v1/fit/requirement-library");
  expect(restored.requirements).toEqual([{ ...sharedBefore,
    demand_assessments: sharedBefore.demand_assessments.map((demand) => ({ ...demand,
      job_ids: demand.job_ids.filter((jobId) => jobId !== seed.posting.job_id),
    })),
  }]);
  expect(app.external.calls).toHaveLength(callsBeforeDelete);

  const later = await captureReusePosting(api, "library-after-permanent", "Implement and maintain durable workflow recovery.\nEstablish explicit review ownership for operational changes.");
  const replacement = await acceptReuseRequirements(api, app, later,
    [{ localId: "recovery", text: "Implement and maintain durable workflow recovery." },
      { localId: "ownership", text: "Establish explicit review ownership for operational changes." }],
    { recovery: { verdict: "equivalent", requirementId: sharedId }, ownership: { verdict: "new" } }, { extract: false });
  const matching = catalogContext(replacement.matching!);
  expect(matching.candidates.map((row) => row.requirement_id)).toEqual([sharedId]);
  const replacementId = replacement.snapshot.requirements.find((row) => row.requirement_id !== sharedId)!.requirement_id;
  expect(replacementId).not.toBe(uniqueId);
  const replacementLibrary = await json<Library>(api, "get", "/v1/fit/requirement-library");
  expect(replacementLibrary.requirements.find((row) => row.requirement_id === replacementId))
    .toMatchObject({ assessment: null, associations: [] });
  expect(await json(api, "get", "/v1/profile/wording")).toEqual(wordingBefore);

  // The first deletion in one transaction must preserve a shared meaning until
  // the final selected Job's occurrences are removed in that same transaction.
  const remainingJobs = [second.job_id, later.job_id];
  await json(api, "post", "/v1/jobs/bulk-delete", { jobIds: remainingJobs });
  const bulkSelection = await json<{ selectionId: string }>(api, "post", "/v1/jobs/permanent-delete-selection", { jobIds: remainingJobs });
  await json(api, "post", "/v1/jobs/bulk-delete-permanent", { jobIds: remainingJobs, selectionId: bulkSelection.selectionId });
  expect((await api.get(`/v1/requirements/${sharedId}`)).status()).toBe(404);
  expect((await api.get(`/v1/requirements/${replacementId}`)).status()).toBe(404);
  expect(await json(api, "get", "/v1/requirements/index")).toMatchObject({ fresh: true, meaning_count: 0, indexed_count: 0 });
  expect((await json<Library>(api, "get", "/v1/fit/requirement-library")).requirements).toEqual([]);
  expect(await json(api, "get", "/v1/profile/wording")).toEqual(wordingBefore);
});
