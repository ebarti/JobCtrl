import type { Page, TestInfo } from "@playwright/test";
import { test, expect, json, modelCall, action, completed, terminal } from "../harness/fixtures.js";
import { createBaseline, acceptBaseline, getResume } from "./core-data.js";
import { catalogMatching, typedExtraction, type CatalogContext } from "./requirements-data.js";
import { qualificationBatchDecision, legacyQualificationBatchDecision } from "./qualification-data.js";
import { createScoredFit, legacyGroupedCoverageDecision, refreshPayload, startRefresh, type PendingRefresh } from "./fit-data.js";
import { acceptReuseRequirements, captureReusePosting, type RequirementSnapshot } from "./reuse-data.js";
import { CONSOLIDATION_PREDECESSOR, NORMALIZATION_VERSION, acceptLegacyRequirements, acceptedPdf,
  authoredPartition, retainedCapability, readCatalog, requirementsPath, fitPath,
  type NormalizedSnapshot, type ReconciliationReport } from "./consolidation-data.js";

type Fit = { current: boolean; reused_qualifications?: number; selection: { ready_for_materials: boolean };
  score: { revision: number; score: number; summary: { assessed_count: number }; assessments: {
    assessment_id: string; determination_id: string; requirement_id: string; demand_fingerprint: string | null;
    kind: string; provenance: { receipt_id: string; prompt_version: string };
    contribution: { max_points: number; awarded_points: number };
  }[] } | null };

async function captureDetailTop(page: Page, testInfo: TestInfo, name: string) {
  const detail = page.getByRole("region", { name: "Requirement details", exact: true });
  await detail.scrollIntoViewIfNeeded();
  const box = await detail.boundingBox();
  expect(box).not.toBeNull();
  const height = await detail.evaluate((node) => node.scrollHeight);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);
  await page.mouse.wheel(0, -height);
  await expect.poll(() => detail.evaluate((node) => node.scrollTop)).toBe(0);
  await testInfo.attach(name, { contentType: "image/png", body: await page.screenshot() });
}

test("one capability preserves distinct job demands, reuses identical demand receipts and counts duplicate occurrences once", async ({ api, app, page }, testInfo) => {
  const { profile, library } = await createBaseline(api);
  const clauses = ["Implement durable workflow recovery.", "Maintain durable workflow recovery."];
  const sharedDemand = "Implement and maintain durable workflow recovery.";
  const constrainedDemand = "Implement durable workflow recovery for safety-critical aircraft control software.";
  const first = await captureReusePosting(api, "demand-general", clauses.join("\n"));
  const pending = api.post(requirementsPath(first.job_id), { data: { expected_posting_revision: first.revision, expected_revision: 0 } });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { requirements: clauses.map((text, index) => ({ localId: ["implement", "maintain"][index]!, text, category: "skill" })) }));
  const normalization = await modelCall(app, "requirements.match_catalog");
  normalization.reply(authoredPartition(normalization, [{ groupId: "recovery", memberIds: ["incoming:implement", "incoming:maintain"], category: "skill",
    name: "Workflow recovery", definition: sharedDemand }], [{ groupId: "recovery", definition: sharedDemand, jobIds: [first.job_id] }]));
  const response = await pending;
  expect(response.status(), await response.text()).toBe(200);
  const requirements = await response.json() as NormalizedSnapshot;
  expect(requirements.requirements).toHaveLength(2);
  expect(new Set(requirements.requirements.map((row) => row.requirement_id)).size).toBe(1);
  expect(new Set(requirements.requirements.map((row) => row.normalized_demand.demand_fingerprint)).size).toBe(1);
  const canonicalId = requirements.requirements[0]!.requirement_id;
  const sharedFingerprint = requirements.requirements[0]!.normalized_demand.demand_fingerprint;
  const achievement = library.roles[0]!.achievements[0]!;
  const assessBody = { expected_revision: 0, prepare_wording: false, prepare_coverage: false };
  const assessing = api.post(`${fitPath(first.job_id)}/assess`, { data: assessBody });
  const qualification = await modelCall(app, "fit.qualification-batch");
  expect((qualification.body["context"] as { requirements: unknown[] }).requirements).toHaveLength(1);
  qualification.reply(qualificationBatchDecision(qualification, () => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] })));
  expect((await assessing).status()).toBe(200);
  const firstFit = await json<Fit>(api, "get", fitPath(first.job_id));
  expect(firstFit).toMatchObject({ current: true, score: { score: 10, summary: { assessed_count: 1 }, assessments: [{ demand_fingerprint: sharedFingerprint }] } });
  expect(firstFit.score!.assessments).toHaveLength(1);
  expect(firstFit.score!.assessments[0]!.contribution.max_points).toBe(1);

  const second = await captureReusePosting(api, "demand-aircraft", constrainedDemand);
  const constrained = api.post(requirementsPath(second.job_id), { data: { expected_posting_revision: second.revision, expected_revision: 0 } });
  const secondExtraction = await modelCall(app, "requirements.extract");
  secondExtraction.reply(typedExtraction(secondExtraction, { requirements: [{ localId: "aircraft", text: constrainedDemand, category: "skill" }] }));
  const secondNormalization = await modelCall(app, "requirements.match_catalog");
  const existing = retainedCapability(secondNormalization, canonicalId, "recovery");
  secondNormalization.reply(authoredPartition(secondNormalization, [{ ...existing, memberIds: [canonicalId, "incoming:aircraft"] }], [
    { groupId: "recovery", definition: sharedDemand, jobIds: [first.job_id], reuseDemandFingerprint: sharedFingerprint },
    { groupId: "recovery", definition: constrainedDemand, jobIds: [second.job_id] },
  ]));
  expect((await constrained).status()).toBe(200);
  const secondRequirements = await json<NormalizedSnapshot>(api, "get", requirementsPath(second.job_id));
  const secondFingerprint = secondRequirements.requirements[0]!.normalized_demand.demand_fingerprint;
  expect(secondRequirements.requirements[0]!.requirement_id).toBe(canonicalId);
  expect(secondFingerprint).not.toBe(sharedFingerprint);
  const beforeSecondFit = app.external.calls.length;
  const assessingSecond = api.post(`${fitPath(second.job_id)}/assess`, { data: assessBody });
  const missing = await modelCall(app, "fit.qualification-batch");
  expect((missing.body["context"] as { requirements: { demand_fingerprint: string }[] }).requirements.map((row) => row.demand_fingerprint)).toEqual([secondFingerprint]);
  missing.reply(qualificationBatchDecision(missing, () => ({ kind: "missing" })));
  expect((await assessingSecond).status()).toBe(200);
  const secondFit = await json<Fit>(api, "get", fitPath(second.job_id));
  expect(secondFit).toMatchObject({ current: true, score: { score: 1, assessments: [{ kind: "missing", demand_fingerprint: secondFingerprint }] } });
  expect(secondFit.score!.assessments[0]!.assessment_id).not.toBe(firstFit.score!.assessments[0]!.assessment_id);
  expect(app.external.calls.slice(beforeSecondFit).map((call) => call.body["operation"])).toEqual(["fit.qualification-batch"]);

  const third = await captureReusePosting(api, "demand-identical-peer", sharedDemand);
  const peer = api.post(requirementsPath(third.job_id), { data: { expected_posting_revision: third.revision, expected_revision: 0 } });
  const peerExtraction = await modelCall(app, "requirements.extract");
  peerExtraction.reply(typedExtraction(peerExtraction, { requirements: [{ localId: "peer", text: sharedDemand, category: "skill" }] }));
  const peerNormalization = await modelCall(app, "requirements.match_catalog");
  peerNormalization.reply(authoredPartition(peerNormalization, [{ ...retainedCapability(peerNormalization, canonicalId, "recovery"), memberIds: [canonicalId, "incoming:peer"] }], [
    { groupId: "recovery", definition: sharedDemand, jobIds: [first.job_id, third.job_id], reuseDemandFingerprint: sharedFingerprint },
    { groupId: "recovery", definition: constrainedDemand, jobIds: [second.job_id], reuseDemandFingerprint: secondFingerprint },
  ]));
  expect((await peer).status()).toBe(200);
  const beforeReuse = app.external.calls.length;
  const thirdFit = await json<Fit>(api, "post", `${fitPath(third.job_id)}/assess`, assessBody);
  expect(thirdFit.score!.assessments[0]).toMatchObject({ assessment_id: firstFit.score!.assessments[0]!.assessment_id,
    determination_id: firstFit.score!.assessments[0]!.determination_id, demand_fingerprint: sharedFingerprint });
  expect(app.external.calls).toHaveLength(beforeReuse);

  await page.goto(`/requirements?requirement=${encodeURIComponent(canonicalId)}`);
  await expect(page.getByRole("cell", { name: "Varies by job", exact: true })).toBeVisible();
  const demandPanel = page.getByRole("region", { name: "Job-specific demands", exact: true });
  await expect(demandPanel).toBeVisible();
  await captureDetailTop(page, testInfo, "same-capability-distinct-demands-initial");
  const demandDetails = demandPanel.locator("ol.requirement-demands__list > li > details");
  for (const detail of await demandDetails.all()) {
    if (await detail.getAttribute("open") === null) await detail.locator(":scope > summary").click();
  }
  await expect(demandPanel.getByText(sharedDemand, { exact: true })).toBeVisible();
  await expect(demandPanel.getByText(constrainedDemand, { exact: true })).toBeVisible();
  await captureDetailTop(page, testInfo, "same-capability-different-demand-authority");
  const constrainedDetail = demandDetails.filter({ has: page.getByText(constrainedDemand, { exact: true }) });
  await constrainedDetail.locator("summary").filter({ hasText: /^Source jobs and demand identity$/ }).click();
  await constrainedDetail.getByText(constrainedDemand, { exact: true }).scrollIntoViewIfNeeded();
  await testInfo.attach("different-demand-expanded-source", { contentType: "image/png", body: await page.screenshot() });
  const callsBeforeSave = app.external.calls.length;
  const runsBefore = await json(api, "get", "/v1/action-runs?action=fit.refresh");
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: { ...profile.profile,
    personal: { ...profile.profile.personal, city: "Synthetic Updated City" } } });
  await json(api, "get", fitPath(first.job_id));
  await json(api, "get", "/v1/fit/requirement-library");
  await json(api, "get", "/v1/fit/refresh/pending");
  expect(await json(api, "get", "/v1/action-runs?action=fit.refresh")).toEqual(runsBefore);
  expect(app.external.calls).toHaveLength(callsBeforeSave);
});

test("catalog epoch and durable cancellation fences preserve accepted job snapshots scores and PDF bytes", async ({ api, app }) => {
  const seed = await createScoredFit(api, app, "consolidation-epoch-fence");
  // This owned race admits two Requirements operations. Production keeps the
  // configured lane/spend gates; the default single lane would refuse winner.
  const settings = await json<{ revision: number; laneConcurrency: Record<string, number> }>(api, "get", "/v1/settings");
  await json(api, "patch", "/v1/settings", { expectedRevision: settings.revision,
    dailyBudgetUsd: 0, laneConcurrency: { ...settings.laneConcurrency, requirements: 2 } });
  const resume = await acceptBaseline(api, seed.posting.job_id, seed.profile.profileVersion);
  const pdf = await acceptedPdf(api, resume.resume_id);
  const requirementsBefore = await json<RequirementSnapshot>(api, "get", requirementsPath(seed.posting.job_id));
  const fitBefore = await json<Fit>(api, "get", fitPath(seed.posting.job_id));
  const catalogBefore = await readCatalog(api);
  const held = api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: catalogBefore.catalog_revision } });
  const stale = await modelCall(app, "requirements.match_catalog");
  const other = await captureReusePosting(api, "consolidation-concurrent-import", "Build a versioned data import tool.");
  await acceptReuseRequirements(api, app, other, [{ localId: "import", text: other.description }], { import: { verdict: "new" } });
  const afterOther = await readCatalog(api);
  expect(afterOther.catalog_revision).toBeGreaterThan(catalogBefore.catalog_revision);
  stale.reply(catalogMatching(stale, {}));
  const refused = await held;
  expect(refused.status(), await refused.text()).toBe(409);
  let retained = await json<RequirementSnapshot>(api, "get", requirementsPath(seed.posting.job_id));
  expect(retained.requirements).toEqual(requirementsBefore.requirements);
  expect(retained.revision).toBe(requirementsBefore.revision);
  expect((await json<Fit>(api, "get", fitPath(seed.posting.job_id))).score).toEqual(fitBefore.score);
  expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);

  const run = await action(api, "requirements.consolidate", { expected_catalog_revision: afterOther.catalog_revision });
  const cancelled = await modelCall(app, "requirements.match_catalog");
  expect(await json(api, "post", `/v1/action-runs/${run.runId}/cancel`, {})).toMatchObject({ cancellationRequested: true });
  cancelled.reply(catalogMatching(cancelled, {}));
  expect((await terminal(api, run.runId))["status"]).toBe("cancelled");
  const afterCancellation = await readCatalog(api);
  expect(afterCancellation.catalog_revision).toBe(afterOther.catalog_revision);
  expect(afterCancellation.normalization).toEqual(afterOther.normalization);
  retained = await json<RequirementSnapshot>(api, "get", requirementsPath(seed.posting.job_id));
  expect(retained.requirements).toEqual(requirementsBefore.requirements);
  expect(retained.revision).toBe(requirementsBefore.revision);
  expect((await json<Fit>(api, "get", fitPath(seed.posting.job_id))).score).toEqual(fitBefore.score);
  expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);
});

test.describe("retained public predecessor capability authority", () => {
  test.use({ sourceRevision: CONSOLIDATION_PREDECESSOR });

  test("existing-only consolidation includes hidden retained meanings, merges ordinary facets and preserves independent technology and aliases", async ({ api, app, page }, testInfo) => {
    const { profile } = await createBaseline(api);
    const authored = [
      { localId: "improve", text: "Improve engineering processes through outcome measures.", name: "Engineering process improvement", definition: "Improve engineering processes through outcome measures." },
      { localId: "assess", text: "Assess engineering workflows to improve delivery.", name: "Engineering workflow assessment", definition: "Assess engineering workflows to improve delivery." },
      { localId: "temporal", text: "Orchestrate production workflows using Temporal.", name: "Temporal workflow orchestration", definition: "Orchestrate workflows using Temporal." },
    ];
    const saved = [];
    for (const row of authored) {
      const posting = await captureReusePosting(api, `legacy-${row.localId}`, row.text);
      const snapshot = await acceptLegacyRequirements(api, app, posting, [{ ...row, category: "skill" }], { [row.localId]: { verdict: "new" } });
      saved.push({ posting, snapshot, id: snapshot.requirements[0]!.requirement_id });
    }
    await json(api, "post", `/v1/jobs/${saved[1]!.posting.job_id}/delete`, {});
    const beforeUpgrade = app.external.calls.length;
    await app.upgradeSource();
    expect(app.external.calls).toHaveLength(beforeUpgrade);
    const legacy = await readCatalog(api);
    expect(legacy.normalization.ready).toBe(false);
    expect(legacy.requirements.map((row) => row.requirement_id).sort()).toEqual([saved[0]!.id, saved[2]!.id].sort());
    await page.goto("/requirements");
    const control = page.getByRole("region", { name: "Skill consolidation", exact: true });
    await expect(control.getByRole("button", { name: "Consolidate skills", exact: true })).toBeVisible();
    await control.getByRole("button", { name: "Consolidate skills", exact: true }).click();
    const call = await modelCall(app, "requirements.match_catalog");
    const context = call.body["context"] as CatalogContext;
    expect(context.incoming).toEqual([]);
    expect(context.members.map((row) => row.member_id).sort()).toEqual(saved.map((row) => row.id).sort());
    expect(context.occurrences.map((row) => row.job_id).sort()).toEqual(saved.map((row) => row.posting.job_id).sort());
    await expect(control.getByRole("button", { name: "Request cancellation", exact: true })).toBeVisible();
    const processDefinition = "Improve engineering processes.";
    call.reply(authoredPartition(call, [
      { groupId: "process", memberIds: [saved[0]!.id, saved[1]!.id], category: "skill", name: "Engineering process improvement", definition: processDefinition },
      retainedCapability(call, saved[2]!.id, "temporal"),
    ], [
      { groupId: "process", definition: processDefinition, jobIds: [saved[0]!.posting.job_id, saved[1]!.posting.job_id] },
      { groupId: "temporal", definition: authored[2]!.definition, jobIds: [saved[2]!.posting.job_id] },
    ]));
    const runs = await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=requirements.consolidate");
    expect(runs.runs).toHaveLength(1);
    const completedRun = await completed(api, runs.runs[0]!.runId);
    const report = completedRun["result"] as ReconciliationReport;
    expect(report).toMatchObject({ input_member_count: 3, root_count: 2, receipt: { prompt_version: NORMALIZATION_VERSION, lane: "requirements" } });
    const root = [saved[0]!.id, saved[1]!.id].sort()[0]!;
    const alias = [saved[0]!.id, saved[1]!.id].find((id) => id !== root)!;
    expect(report.mapping).toMatchObject({ [saved[0]!.id]: root, [saved[1]!.id]: root, [saved[2]!.id]: saved[2]!.id });
    const catalog = await readCatalog(api);
    expect(catalog).toMatchObject({ total: 2, normalization: { ready: true, normalization_version: NORMALIZATION_VERSION } });
    expect(catalog.aliases[alias]).toBe(root);
    expect(catalog.requirements.map((row) => row.requirement_id).sort()).toEqual([root, saved[2]!.id].sort());
    const current = await json<NormalizedSnapshot>(api, "get", requirementsPath(saved[0]!.posting.job_id));
    expect(current.requirements[0]).toMatchObject({ requirement_id: root, definition: authored[0]!.definition,
      previous_occurrence_id: saved[0]!.snapshot.requirements[0]!.occurrence_id,
      normalized_demand: { definition: processDefinition, normalization_version: NORMALIZATION_VERSION } });
    expect(current.requirements[0]!.spans).toEqual(saved[0]!.snapshot.requirements[0]!.spans);
    await page.goto(`/requirements?requirement=${encodeURIComponent(alias)}`);
    await expect(page.getByText("This saved link points to a consolidated requirement.", { exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "Job-specific demands", exact: true })).toBeVisible();
    await page.locator("summary").filter({ hasText: /^Earlier consolidated identities · 1$/ }).click();
    const earlierIdentity = page.getByRole("region", { name: "Earlier identity 1", exact: true });
    await expect(earlierIdentity).toContainText(`Recorded identity: ${alias}`);
    const aliasSeed = saved.find((row) => row.id === alias)!;
    const aliasDefinition = aliasSeed.snapshot.requirements[0]!.definition;
    await earlierIdentity.locator("summary").filter({ hasText: /^Definition history$/ }).click();
    await expect(earlierIdentity.getByText("Revision 1 · Recorded historical meaning", { exact: true })).toBeVisible();
    await expect(earlierIdentity.getByText(aliasDefinition, { exact: true })).toBeVisible();
    await earlierIdentity.locator("summary").filter({ hasText: /^Source history and posting references$/ }).click();
    await expect(earlierIdentity.getByText("Historical posting reference", { exact: true })).toBeVisible();
    const history = await json<{ rows: { occurrence_id: string; definition: string }[] }>(api, "get", `/v1/requirements/${encodeURIComponent(alias)}/history?kind=occurrences&limit=20&offset=0`);
    expect(history.rows).toEqual(expect.arrayContaining([expect.objectContaining({
      occurrence_id: aliasSeed.snapshot.requirements[0]!.occurrence_id, definition: aliasDefinition,
    })]));
    const rootHistory = await json<{ rows: { requirement_id: string; occurrence_id: string; stale_reasons: string[] }[] }>(api, "get", `/v1/requirements/${encodeURIComponent(root)}/history?kind=occurrences&limit=20&offset=0`);
    expect(rootHistory.rows).toEqual(expect.arrayContaining([expect.objectContaining({ requirement_id: alias,
      occurrence_id: aliasSeed.snapshot.requirements[0]!.occurrence_id,
      stale_reasons: expect.arrayContaining(["requirement_consolidated"]),
    })]));
    await earlierIdentity.locator("summary").filter({ hasText: /^Source and provenance$/ }).click();
    await expect(earlierIdentity.getByText(aliasSeed.snapshot.requirements[0]!.spans[0]!.quote, { exact: true }).last()).toBeVisible();
    await testInfo.attach("existing-only-hidden-retained-consolidation", { contentType: "image/png", body: await page.screenshot({ fullPage: true }) });
    const callsBeforeReads = app.external.calls.length;
    await json(api, "get", `/v1/requirements/${encodeURIComponent(alias)}`);
    await json(api, "get", "/v1/fit/requirement-library");
    await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: profile.profile });
    expect(app.external.calls).toHaveLength(callsBeforeReads);
    expect(app.external.calls.slice(beforeUpgrade).map((row) => row.body["operation"])).toEqual(["requirements.match_catalog"]);
  });

  test("redirects never inherit legacy approved coverage or scores and refused partitions preserve accepted snapshots and PDF bytes", async ({ api, app, page }, testInfo) => {
    const { profile, library } = await createBaseline(api);
    const clauses = ["Improve engineering processes through delivery review.", "Assess engineering process outcomes."];
    const core = "Improve engineering processes.";
    const posting = await captureReusePosting(api, "legacy-approved-split", clauses.join("\n"));
    const accepted = await acceptLegacyRequirements(api, app, posting, clauses.map((text, index) => ({
      localId: ["delivery", "outcomes"][index]!, text, category: "skill", name: "Engineering process improvement", definition: core,
    })), { delivery: { verdict: "new" }, outcomes: { verdict: "new" } });
    const achievement = library.roles[0]!.achievements[0]!;
    const aliasId = accepted.requirements.map((row) => row.requirement_id).sort()[1]!;
    const oldAssociationRequest = { association_id: "consolidation-legacy-alias-link", profile_id: "default",
      expected_profile_revision: profile.profileVersion, requirement_id: aliasId, requirement_revision: 1,
      achievement_id: achievement.achievement_id, achievement_source_refs: achievement.source_refs, wording: null };
    const oldAssociation = await json<{ association_id: string; revision: number; current: boolean }>(api, "post", "/v1/fit/associations", oldAssociationRequest);
    expect(oldAssociation.current).toBe(true);
    const evidenceSourceId = `evidence:${achievement.source_refs[0]!.source_id}`;
    const assessing = api.post(`${fitPath(posting.job_id)}/assess`, { data: { expected_revision: 0, prepare_wording: false, prepare_coverage: false } });
    const oldQualification = await modelCall(app, "fit.qualification-batch");
    oldQualification.reply(legacyQualificationBatchDecision(oldQualification, () => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [evidenceSourceId] })));
    expect((await assessing).status()).toBe(200);
    const covering = api.post(`${fitPath(posting.job_id)}/coverage/refresh`, { data: { prepare_wording: false } });
    const oldCoverage = await modelCall(app, "fit.wording-coverage-grouped");
    oldCoverage.reply(legacyGroupedCoverageDecision(oldCoverage, { evidenceSourceId, status: "covered", action: "reuse_approved", reusableVariantId: achievement.baseline_variant_id }));
    expect((await covering).status()).toBe(200);
    const oldFit = await json<Fit>(api, "get", fitPath(posting.job_id));
    expect(oldFit).toMatchObject({ current: true, score: { score: 10 }, selection: { ready_for_materials: true } });
    expect(oldFit.score!.assessments).toHaveLength(2);
    const oldLibrary = await json<{ requirements: { coverage: { relation_id: string }[]; wording_assignments: { assignment_id: string }[] }[] }>(api, "get", "/v1/fit/requirement-library");
    const oldHistory = await json(api, "get", `${fitPath(posting.job_id)}/history`);
    const oldWording = await json(api, "get", "/v1/profile/wording");
    const resume = await acceptBaseline(api, posting.job_id, profile.profileVersion);
    const pdf = await acceptedPdf(api, resume.resume_id);
    const callsBeforeUpgrade = app.external.calls.length;
    await app.upgradeSource();
    expect(app.external.calls).toHaveLength(callsBeforeUpgrade);
    const before = await json<RequirementSnapshot>(api, "get", requirementsPath(posting.job_id));
    const catalogBefore = await readCatalog(api);
    const faults = ["omitted member", "foreign member", "omitted occurrence", "foreign occurrence", "schema", "uncertain"] as const;
    for (const fault of faults) {
      const attempt = api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: catalogBefore.catalog_revision } });
      const call = await modelCall(app, "requirements.match_catalog");
      const valid = catalogMatching(call, {});
      const invalid = structuredClone(valid);
      if (fault === "omitted member") invalid.capabilities.shift();
      if (fault === "foreign member") invalid.capabilities[0]!.member_ids[0] = "foreign:unrecorded-member";
      if (fault === "omitted occurrence") invalid.demands.shift();
      if (fault === "foreign occurrence") invalid.demands[0]!.bindings[0]!.occurrence_ids[0] = "foreign:unrecorded-occurrence";
      if (fault === "uncertain") {
        invalid.status = "needs_review";
        invalid.unresolved = [{ member_ids: invalid.capabilities[0]!.member_ids, reason: "The supplied sources do not establish a complete normalized partition.", citations: invalid.capabilities[0]!.citations }];
      }
      if (fault === "schema") call.reply({ ...invalid, invented_authority: true });
      else call.reply(invalid);
      const response = await attempt;
      expect(response.status(), `${fault}: ${await response.text()}`).toBe(fault === "schema" ? 502 : 422);
      const retained = await json<RequirementSnapshot>(api, "get", requirementsPath(posting.job_id));
      expect(retained.requirements).toEqual(before.requirements);
      expect(retained.revision).toBe(before.revision);
      expect((await readCatalog(api)).catalog_revision).toBe(catalogBefore.catalog_revision);
      expect(await json(api, "get", `${fitPath(posting.job_id)}/history`)).toEqual(oldHistory);
      expect(await json(api, "get", "/v1/profile/wording")).toEqual(oldWording);
      expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);
    }
    const ids = accepted.requirements.map((row) => row.requirement_id).sort();
    const success = api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: catalogBefore.catalog_revision } });
    const merging = await modelCall(app, "requirements.match_catalog");
    const root = retainedCapability(merging, ids[0]!, "process");
    merging.reply(authoredPartition(merging, [{ ...root, memberIds: ids }], [{ groupId: "process", definition: core, jobIds: [posting.job_id] }]));
    const published = await success;
    expect(published.status(), await published.text()).toBe(200);
    const report = await published.json() as ReconciliationReport;
    expect(report.roots).toHaveLength(1);
    // The survivor's name/definition/revision stay exact. Its older positive
    // outcomes and approved wording still cannot acquire the new demand pins.
    expect(report.roots[0]).toMatchObject({ requirement_id: ids[0], revision: 1, definition: core });
    const stale = await json<Fit>(api, "get", fitPath(posting.job_id));
    expect(stale).toMatchObject({ current: false, score: oldFit.score, selection: { ready_for_materials: false } });
    type EarlierRecords = { requirement_id: string; root_requirement_id: string; current: false; stale_reasons: string[];
      assessments: { assessment_id: string; requirement_id: string; determination_id: string }[];
      coverage: { relation_id: string; requirement_id: string }[]; wording_assignments: { assignment_id: string; requirement_id: string }[] };
    const libraryAfter = await json<{ requirements: { requirement_id: string; assessment: unknown; current_wordings: unknown[]; coverage: unknown[];
      historical_alias_records: EarlierRecords[]; demand_assessments: { assessment: unknown; current: boolean }[] }[] }>(api, "get", "/v1/fit/requirement-library");
    expect(libraryAfter.requirements).toHaveLength(1);
    expect(libraryAfter.requirements[0]).toMatchObject({ requirement_id: ids[0], assessment: null, current_wordings: [], coverage: [] });
    expect(libraryAfter.requirements[0]!.demand_assessments).toHaveLength(1);
    expect(libraryAfter.requirements[0]!.demand_assessments[0]).toMatchObject({ assessment: null, current: false });
    const earlierRecords = libraryAfter.requirements[0]!.historical_alias_records;
    expect(earlierRecords.flatMap((group) => group.assessments.map((row) => row.assessment_id)).sort()).toEqual(oldFit.score!.assessments.map((row) => row.assessment_id).sort());
    expect(earlierRecords.flatMap((group) => group.coverage.map((row) => row.relation_id)).sort()).toEqual(oldLibrary.requirements.flatMap((row) => row.coverage.map((relation) => relation.relation_id)).sort());
    expect(earlierRecords.flatMap((group) => group.wording_assignments.map((row) => row.assignment_id)).sort()).toEqual(oldLibrary.requirements.flatMap((row) => row.wording_assignments.map((assignment) => assignment.assignment_id)).sort());
    for (const group of earlierRecords) {
      expect(group).toMatchObject({ root_requirement_id: ids[0], current: false });
      expect(group.stale_reasons).toContain(group.requirement_id === ids[0] ? "qualification_binding_historical" : "capability_consolidated");
      expect([...group.assessments, ...group.coverage, ...group.wording_assignments].every((row) => row.requirement_id === group.requirement_id)).toBe(true);
    }
    const aliasHistory = await json<{ current_revision: number; rows: { association_id: string; requirement_id: string; current: boolean; stale_reasons: string[] }[] }>(api, "get", `/v1/fit/associations/${oldAssociation.association_id}/history`);
    expect(aliasHistory).toMatchObject({ current_revision: oldAssociation.revision, rows: [{
      association_id: oldAssociation.association_id, requirement_id: aliasId, current: false,
      stale_reasons: expect.arrayContaining(["requirement_consolidated"]),
    }] });
    const callsBeforeAliasWrites = app.external.calls.length;
    const aliasCreate = await api.post("/v1/fit/associations", { data: { ...oldAssociationRequest, association_id: "consolidation-refused-alias-link" } });
    expect(aliasCreate.status(), await aliasCreate.text()).toBe(409);
    const aliasRevise = await api.post(`/v1/fit/associations/${oldAssociation.association_id}/revisions`, { data: { ...oldAssociationRequest, expected_revision: oldAssociation.revision } });
    expect(aliasRevise.status(), await aliasRevise.text()).toBe(409);
    expect(await json(api, "get", `/v1/fit/associations/${oldAssociation.association_id}/history`)).toEqual(aliasHistory);
    expect(app.external.calls).toHaveLength(callsBeforeAliasWrites);
    expect(await json(api, "get", "/v1/profile/wording")).toEqual(oldWording);
    expect(await json(api, "get", `${fitPath(posting.job_id)}/history`)).toEqual(oldHistory);
    expect((await getResume(api, resume.resume_id)).accepted_revision_id).toBe(resume.accepted_revision_id);
    expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);

    await page.goto(`/requirements?requirement=${encodeURIComponent(ids[0]!)}`);
    const detail = page.getByRole("region", { name: "Requirement details", exact: true });
    await expect(detail.getByText("No achievements linked.", { exact: true })).toBeVisible();
    await captureDetailTop(page, testInfo, "consolidated-current-demand-without-inherited-support");
    const earlierSummary = detail.locator("summary").filter({ hasText: /^Earlier links and assessments$/ });
    await expect(earlierSummary.locator("..")).toHaveJSProperty("open", false);
    await earlierSummary.click();
    for (const group of earlierRecords) {
      const region = detail.getByRole("region", { name: /^Earlier records / }).filter({ has: page.getByRole("heading", { name: `Recorded requirement: ${group.requirement_id}`, exact: true }) });
      await expect(region).toBeVisible();
      for (const summary of await region.locator("summary").filter({ hasText: /^Earlier (assessment|wording coverage) ·/ }).all()) await summary.click();
      for (const assessment of group.assessments) {
        await expect(region.getByText(`Assessment ${assessment.assessment_id} · determination ${assessment.determination_id}`, { exact: true })).toBeVisible();
      }
      for (const relation of group.coverage) await expect(region).toContainText(`Coverage ${relation.relation_id}`);
      if (group.requirement_id === aliasId) {
        await region.locator("summary").filter({ hasText: /^Earlier link · recorded as Active$/ }).click();
        await expect(region).toContainText(`Link ${oldAssociation.association_id} · revision ${oldAssociation.revision}`);
      }
    }
    await detail.getByRole("heading", { name: `Recorded requirement: ${earlierRecords[0]!.requirement_id}`, exact: true }).scrollIntoViewIfNeeded();
    await testInfo.attach("historical-coverage-discoverable-without-current-authority", { contentType: "image/png", body: await page.screenshot() });

    const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
    const run = await startRefresh(api, { ...refreshPayload(pending, [posting.job_id], { max_model_calls: 1, max_requirements: 1 }), prepare_wording: false, prepare_coverage: false }, "post-consolidation-demand-reassessment");
    const fresh = await modelCall(app, "fit.qualification-batch");
    expect((fresh.body["context"] as { requirements: unknown[] }).requirements).toHaveLength(1);
    fresh.reply(qualificationBatchDecision(fresh, () => ({ kind: "missing" })));
    await completed(api, run.runId);
    const reassessed = await json<Fit>(api, "get", fitPath(posting.job_id));
    expect(reassessed).toMatchObject({ current: true, score: { score: 1, assessments: [{ requirement_id: ids[0], kind: "missing" }] } });
    expect(reassessed.score!.assessments).toHaveLength(1);
    expect(oldFit.score!.assessments.map((row) => row.assessment_id)).not.toContain(reassessed.score!.assessments[0]!.assessment_id);
    expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);
    expect(await json(api, "get", "/v1/profile/wording")).toEqual(oldWording);

    // An unavailable provider has unresolved usage authority. Exercise it last
    // and verify the next call is refused by accounting, rather than bypassing
    // that gate to continue the test's positive publication path.
    const acceptedCurrent = await json<NormalizedSnapshot>(api, "get", requirementsPath(posting.job_id));
    const acceptedHistory = await json(api, "get", `${fitPath(posting.job_id)}/history`);
    const acceptedCatalog = await readCatalog(api);
    const unavailable = api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: acceptedCatalog.catalog_revision } });
    const provider = await modelCall(app, "requirements.match_catalog");
    provider.respond({ error: "synthetic_consolidation_unavailable" }, 503);
    const refusedProvider = await unavailable;
    expect(refusedProvider.status(), await refusedProvider.text()).toBe(502);
    expect(await refusedProvider.json()).toMatchObject({ error: { code: "model_provider_failed" } });
    expect(await json(api, "get", requirementsPath(posting.job_id))).toEqual(acceptedCurrent);
    expect(await json(api, "get", `${fitPath(posting.job_id)}/history`)).toEqual(acceptedHistory);
    expect((await json<Fit>(api, "get", fitPath(posting.job_id))).score).toEqual(reassessed.score);
    expect(await json(api, "get", "/v1/profile/wording")).toEqual(oldWording);
    expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);
    const callsBeforeAccountingRefusal = app.external.calls.length;
    const accounting = await api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: acceptedCatalog.catalog_revision } });
    expect(accounting.status(), await accounting.text()).toBe(409);
    expect(await accounting.json()).toMatchObject({ error: { code: "spend_accounting_unresolved" } });
    expect(app.external.calls).toHaveLength(callsBeforeAccountingRefusal);
  });
});
