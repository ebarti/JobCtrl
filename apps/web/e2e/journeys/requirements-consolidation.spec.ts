import type { Page, TestInfo } from "@playwright/test";
import { test, expect, json, modelCall, action, completed, terminal, type ExternalCall } from "../harness/fixtures.js";
import { createBaseline, acceptBaseline, getResume } from "./core-data.js";
import { catalogMatching, catalogOccurrenceEvidence, citationSelections, CITATION_BINDER_VERSION, memberRoots, occurrenceRoots,
  PARTITION_BINDER_VERSION, NORMALIZATION_STORAGE_VERSION, modelSources, normalizationFingerprint, NORMALIZATION_PROMPT_VERSION,
  typedExtraction, type CatalogContext } from "./requirements-data.js";
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
  const beforeBrowsing = app.external.calls.length;
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/requirements?requirement=${encodeURIComponent(canonicalId)}`);
  const capabilityRow = page.getByRole("table", { name: "Saved requirements", exact: true }).locator("tbody tr[data-row-id]");
  await expect(capabilityRow).toHaveCount(1);
  await expect(capabilityRow.getByRole("cell", { name: /^Not assessed/ })).toBeVisible();
  await expect(capabilityRow.getByText("2 job-specific demands", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Linked achievements 0", exact: true })).toBeVisible();
  await captureDetailTop(page, testInfo, "requirements-unassessed-multiple-demands-1440");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByText("Profile match: Not assessed", { exact: true })).toBeVisible();
  await captureDetailTop(page, testInfo, "requirements-unassessed-multiple-demands-390");
  await page.setViewportSize({ width: 1440, height: 1000 });
  expect(app.external.calls).toHaveLength(beforeBrowsing);

  const assessing = api.post(`${fitPath(first.job_id)}/assess`, { data: assessBody });
  const qualification = await modelCall(app, "fit.qualification-batch");
  expect((qualification.body["context"] as { requirements: unknown[] }).requirements).toHaveLength(1);
  qualification.reply(qualificationBatchDecision(qualification, () => ({ achievementIds: [achievement.achievement_id], evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] })));
  expect((await assessing).status()).toBe(200);
  const firstFit = await json<Fit>(api, "get", fitPath(first.job_id));
  expect(firstFit).toMatchObject({ current: true, score: { score: 10, summary: { assessed_count: 1 }, assessments: [{ demand_fingerprint: sharedFingerprint }] } });
  expect(firstFit.score!.assessments).toHaveLength(1);
  expect(firstFit.score!.assessments[0]!.contribution.max_points).toBe(1);
  const beforePartialRead = app.external.calls.length;
  await page.reload();
  await expect(capabilityRow.getByRole("cell", { name: /^Partially assessed/ })).toBeVisible();
  expect(app.external.calls).toHaveLength(beforePartialRead);
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
  await expect(page.getByRole("cell", { name: /^Varies by job/ })).toBeVisible();
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
      { localId: "improve", text: "Improve engineering processes through outcome measures.", name: "Engineering process improvement", definition: "Improve engineering processes through outcome measures.", category: "skill" as const },
      { localId: "assess", text: "Assess engineering workflows to improve delivery.", name: "Engineering workflow assessment", definition: "Assess engineering workflows to improve delivery.", category: "skill" as const },
      { localId: "temporal", text: "Orchestrate production workflows using Temporal.", name: "Temporal workflow orchestration", definition: "Orchestrate workflows using Temporal.", category: "professional_experience" as const },
    ];
    const saved: { posting: Awaited<ReturnType<typeof captureReusePosting>>;
      snapshot: Awaited<ReturnType<typeof acceptLegacyRequirements>>; id: string }[] = [];
    for (const row of authored) {
      const posting = await captureReusePosting(api, `legacy-${row.localId}`, row.text);
      const snapshot = await acceptLegacyRequirements(api, app, posting, [row], { [row.localId]: { verdict: "new" } });
      saved.push({ posting, snapshot, id: snapshot.requirements[0]!.requirement_id });
    }
    const originalTechnology = await json<Record<string, unknown>>(api, "get", `/v1/requirements/${saved[2]!.id}?revision=1`);
    expect(originalTechnology["category"]).toBe("professional_experience");
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
      { groupId: "temporal", memberIds: [saved[2]!.id], category: "skill", name: authored[2]!.name,
        definition: authored[2]!.definition },
    ], [
      { groupId: "process", definition: processDefinition, jobIds: [saved[0]!.posting.job_id, saved[1]!.posting.job_id] },
      { groupId: "temporal", definition: authored[2]!.definition, jobIds: [saved[2]!.posting.job_id] },
    ]));
    const runs = await json<{ runs: { runId: string }[] }>(api, "get", "/v1/action-runs?action=requirements.consolidate");
    expect(runs.runs).toHaveLength(1);
    const completedRun = await completed(api, runs.runs[0]!.runId);
    const report = completedRun["result"] as ReconciliationReport;
    expect(report).toMatchObject({ input_member_count: 3, root_count: 2, receipt: { prompt_version: NORMALIZATION_PROMPT_VERSION, lane: "requirements" } });
    const root = [saved[0]!.id, saved[1]!.id].sort()[0]!;
    const alias = [saved[0]!.id, saved[1]!.id].find((id) => id !== root)!;
    expect(report.mapping).toMatchObject({ [saved[0]!.id]: root, [saved[1]!.id]: root, [saved[2]!.id]: saved[2]!.id });
    const catalog = await readCatalog(api);
    expect(catalog).toMatchObject({ total: 2, normalization: { ready: true, normalization_version: NORMALIZATION_VERSION } });
    expect(catalog.aliases[alias]).toBe(root);
    expect(catalog.requirements.map((row) => row.requirement_id).sort()).toEqual([root, saved[2]!.id].sort());
    expect(catalog.requirements.find((row) => row.requirement_id === saved[2]!.id)).toMatchObject({
      category: "skill", revision: 2, name: authored[2]!.name, definition: authored[2]!.definition,
    });
    const composed = await json<{ requirements: { requirement_id: string; category: string; revision: number }[] }>(api, "get", "/v1/fit/requirement-library");
    expect(composed.requirements.find((row) => row.requirement_id === saved[2]!.id)).toMatchObject({ category: "skill", revision: 2 });
    const historicalTechnology = await json<Record<string, unknown>>(api, "get", `/v1/requirements/${saved[2]!.id}?revision=1`);
    for (const key of ["requirement_id", "revision", "contract_version", "category", "name", "definition", "provenance", "created_at"])
      expect(historicalTechnology[key]).toEqual(originalTechnology[key]);
    const technology = await json<NormalizedSnapshot>(api, "get", requirementsPath(saved[2]!.posting.job_id));
    expect(technology.requirements[0]).toMatchObject({ requirement_id: saved[2]!.id, requirement_revision: 2,
      category: "professional_experience", canonical: { category: "skill" }, definition: authored[2]!.definition,
      job_id: saved[2]!.posting.job_id, posting_revision: saved[2]!.posting.revision,
      source_id: saved[2]!.posting.source_id, source_revision: saved[2]!.posting.source_revision,
      source_hash: saved[2]!.posting.source_hash,
      previous_occurrence_id: saved[2]!.snapshot.requirements[0]!.occurrence_id,
      normalized_demand: { definition: authored[2]!.definition, normalization_version: NORMALIZATION_VERSION } });
    expect(technology.requirements[0]!.spans).toEqual(saved[2]!.snapshot.requirements[0]!.spans);
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

  test("a historical correction witness publishes complete source-bound capabilities without losing current independent demands", async ({ api, app }) => {
    const notesDefinition = "Prepare release notes.";
    const accessDefinition = "Operate access controls.";
    const compositeDefinition = "Prepare release notes and operate access controls.";
    const notesJob = await captureReusePosting(api, "historical-witness-notes", notesDefinition);
    const obsolete = await acceptLegacyRequirements(api, app, notesJob, [{ localId: "obsolete", text: notesDefinition,
      category: "skill", name: "Release notes and access operation", definition: compositeDefinition }], { obsolete: { verdict: "new" } });
    const obsoleteId = obsolete.requirements[0]!.requirement_id;
    // The real predecessor refresh supersedes its unsupported composite head.
    // Its original record remains retained; only the corrected source meaning
    // owns the current accepted occurrence for this Job.
    const notes = await acceptLegacyRequirements(api, app, notesJob, [{ localId: "notes", text: notesDefinition,
      category: "skill", name: "Release note preparation", definition: notesDefinition }], { notes: { verdict: "new" } },
    { expectedRevision: obsolete.revision, force: true });
    const notesId = notes.requirements[0]!.requirement_id;
    expect(notesId).not.toBe(obsoleteId);
    const accessJob = await captureReusePosting(api, "historical-witness-access", accessDefinition);
    const access = await acceptLegacyRequirements(api, app, accessJob, [{ localId: "access", text: accessDefinition,
      category: "skill", name: "Access control operation", definition: accessDefinition }], { access: { verdict: "new" } });
    const accessId = access.requirements[0]!.requirement_id;
    const oldMeaning = await json<Record<string, unknown>>(api, "get", `/v1/requirements/${obsoleteId}?revision=1`);
    const witnessResponse = (request: ExternalCall) => {
      const input = request.body["context"] as CatalogContext;
      const result = authoredPartition(request, [
        { ...retainedCapability(request, notesId, "notes"), memberIds: [obsoleteId, notesId] },
        retainedCapability(request, accessId, "access"),
      ], [{ groupId: "notes", definition: notesDefinition, jobIds: [notesJob.job_id] },
        { groupId: "access", definition: accessDefinition, jobIds: [accessJob.job_id] }]);
      const primaryCitations = [obsoleteId, accessId].map((id) => {
        const member = input.members.find((row) => row.member_id === id)!;
        return { sourceId: member.source_id, valuePath: ["canonical", "spans", 0, "quote"] };
      });
      result.corrections = [{ member_id: obsoleteId, unsupported_claim: "operate access controls",
        represented_by_member_id: accessId, reason: "The historical source establishes release note preparation only; access operation is independently preserved from its own current source.",
        citations: citationSelections(request, [{ sourceId: input.catalog_inventory_source_id }, ...primaryCitations]) }];
      return result;
    };
    const callsBeforeUpgrade = app.external.calls.length;
    await app.upgradeSource();
    expect(app.external.calls).toHaveLength(callsBeforeUpgrade);
    const catalog = await readCatalog(api);
    const payload = { expected_catalog_revision: catalog.catalog_revision, operation_id: "synthetic-historical-correction-witness" };
    const invalidPublishing = api.post("/v1/requirements/consolidate", { data: { ...payload, operation_id: "synthetic-uncorrected-historical-witness" } });
    const call = await modelCall(app, "requirements.match_catalog");
    const context = call.body["context"] as CatalogContext;
    expect(context.incoming).toEqual([]);
    expect(context.members.map((row) => row.member_id).sort()).toEqual([obsoleteId, notesId, accessId].sort());
    expect(context.accepted_occurrence_counts).toMatchObject({ [obsoleteId]: 0, [notesId]: 1, [accessId]: 1 });
    expect(context.occurrences.map((row) => row.occurrence_id).sort()).toEqual([
      notes.requirements[0]!.occurrence_id, access.requirements[0]!.occurrence_id,
    ].sort());
    const uncorrected = witnessResponse(call);
    const retainedGroup = memberRoots(uncorrected).find((group) => group.memberId === obsoleteId)!.slot;
    Object.assign(retainedGroup, { category: "skill", name: "Release notes and access operation", definition: compositeDefinition,
      reuse_requirement_id: obsoleteId });
    call.reply(uncorrected);
    const invalid = await invalidPublishing;
    expect(invalid.status(), await invalid.text()).toBe(422);
    expect(await invalid.json()).toMatchObject({ error: { code: "requirements_correction_witness_invalid" } });
    expect((await readCatalog(api)).catalog_revision).toBe(catalog.catalog_revision);
    for (const [posting, original] of [[notesJob, notes], [accessJob, access]] as const) {
      const current = await json<RequirementSnapshot>(api, "get", requirementsPath(posting.job_id));
      expect(current.requirements).toEqual(original.requirements);
      expect(current.revision).toBe(original.revision);
    }
    const publishing = api.post("/v1/requirements/consolidate", { data: payload });
    const positive = await modelCall(app, "requirements.match_catalog");
    const decision = witnessResponse(positive);
    positive.reply(decision);
    const response = await publishing;
    expect(response.status(), await response.text()).toBe(200);
    const report = await response.json() as ReconciliationReport;
    const notesRoot = [obsoleteId, notesId].sort()[0]!;
    const notesGroup = report.partition_binding.member_groups[obsoleteId]!;
    const accessGroup = report.partition_binding.member_groups[accessId]!;
    const witness = decision.corrections[0]!;
    expect(report).toMatchObject({ input_member_count: 3, root_count: 2, corrections: [{ member_id: witness.member_id,
      retained_group_id: notesGroup, represented_by_group_id: accessGroup, unsupported_claim: witness.unsupported_claim, reason: witness.reason }],
      mapping: { [obsoleteId]: notesRoot, [notesId]: notesRoot, [accessId]: accessId } });
    const positiveContext = positive.body["context"] as CatalogContext;
    expect(report.corrections[0]!.citations).toEqual([
      { source_id: positiveContext.catalog_inventory_source_id, quote: `"catalog_revision":${positiveContext.catalog_revision}` },
      { source_id: positiveContext.members.find((row) => row.member_id === obsoleteId)!.source_id, quote: notesDefinition },
      { source_id: positiveContext.members.find((row) => row.member_id === accessId)!.source_id, quote: accessDefinition },
    ]);
    const root = await json<{ provenance: { normalization: { corrections: unknown[]; receipt: { receipt_id: string };
      reconciliation_id: string; citation_binding: { selection_fingerprint: string; derived_fingerprint: string; source_context_fingerprint: string } } } }>(api, "get", `/v1/requirements/${notesRoot}`);
    expect(root.provenance.normalization).toMatchObject({ corrections: report.corrections,
      receipt: { receipt_id: report.receipt.receipt_id }, reconciliation_id: report.reconciliation_id,
      citation_binding: { selection_fingerprint: report.citation_binding.selection_fingerprint,
        derived_fingerprint: report.citation_binding.derived_fingerprint,
        source_context_fingerprint: report.citation_binding.source_context_fingerprint } });
    const retainedOriginal = await json<Record<string, unknown>>(api, "get", `/v1/requirements/${obsoleteId}?revision=1`);
    for (const key of ["requirement_id", "revision", "contract_version", "category", "name", "definition", "provenance", "created_at"])
      expect(retainedOriginal[key]).toEqual(oldMeaning[key]);
    const historical = await json<{ rows: { occurrence_id: string; definition: string; accepted: boolean }[] }>(api, "get", `/v1/requirements/${obsoleteId}/history?kind=occurrences`);
    expect(historical.rows).toEqual(expect.arrayContaining([expect.objectContaining({ occurrence_id: obsolete.requirements[0]!.occurrence_id,
      definition: compositeDefinition, accepted: false })]));
    for (const [posting, original, requirementId, definition] of [
      [notesJob, notes, notesRoot, notesDefinition], [accessJob, access, accessId, accessDefinition],
    ] as const) {
      const current = await json<NormalizedSnapshot>(api, "get", requirementsPath(posting.job_id));
      expect(current.requirements).toHaveLength(1);
      expect(current.requirements[0]).toMatchObject({ requirement_id: requirementId, definition,
        job_id: posting.job_id, posting_revision: posting.revision, source_id: posting.source_id,
        source_revision: posting.source_revision, source_hash: posting.source_hash,
        previous_occurrence_id: original.requirements[0]!.occurrence_id,
        normalized_demand: { definition, normalization_version: NORMALIZATION_VERSION } });
      expect(current.requirements[0]!.spans).toEqual(original.requirements[0]!.spans);
    }
    const currentCatalog = await readCatalog(api);
    expect(currentCatalog).toMatchObject({ total: 2, normalization: { ready: true } });
    const callsBeforeReplay = app.external.calls.length;
    expect(await json(api, "post", "/v1/requirements/consolidate", payload)).toEqual({ ...report, reused_action: true });
    expect(app.external.calls).toHaveLength(callsBeforeReplay);
    expect(app.external.calls.slice(callsBeforeUpgrade).map((row) => row.body["operation"])).toEqual(["requirements.match_catalog", "requirements.match_catalog"]);
  });

  test("redirects never inherit legacy approved coverage or scores and refused partitions preserve accepted snapshots and PDF bytes", async ({ api, app, page }, testInfo) => {
    const { profile, library } = await createBaseline(api);
    const clauses = ["Improve engineering processes through \"delivery\\review\"\nand assess delivery outcomes.", "Assess engineering process outcomes."];
    const core = "Improve engineering processes.";
    const completeDemand = "Improve engineering processes through \"delivery\\review\" and assess delivery outcomes.";
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
    // This achievement has no assessment or coverage relationship. A removed
    // manual link must stay in history without entering the displayed count.
    const removedAchievement = library.roles[0]!.achievements[1]!;
    const removedAssociation = await json<{ association_id: string; revision: number }>(api, "post", "/v1/fit/associations", {
      ...oldAssociationRequest, association_id: "consolidation-removed-only-link",
      achievement_id: removedAchievement.achievement_id, achievement_source_refs: removedAchievement.source_refs,
    });
    await json(api, "post", `/v1/fit/associations/${removedAssociation.association_id}/state`, {
      profile_id: "default", expected_revision: removedAssociation.revision, state: "removed",
    });
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
    const multilineSource = (request: ExternalCall) => {
      const input = request.body["context"] as CatalogContext;
      const reference = input.occurrences.find((row) => row.occurrence_id === accepted.requirements[0]!.occurrence_id)!;
      expect(reference).toBeTruthy();
      const source = catalogOccurrenceEvidence(request, reference.occurrence_id);
      const container = modelSources(request).find((row) => row.source_id === reference.source_id)!;
      expect(source.original.spans[0]!.quote).toBe(clauses[0]);
      // The literal newline, quotes and backslash belong to one decoded value;
      // their JSON transport escaping is not the original source quotation.
      expect(container.text).not.toContain(clauses[0]);
      const selection = citationSelections(request, [{ sourceId: reference.source_id, valuePath: ["original", "spans", 0, "quote"] }])[0]!;
      return { sourceId: reference.source_id, original: source.original, selection };
    };
    const faults = ["omitted member", "foreign member", "omitted occurrence", "foreign occurrence", "member alias", "occurrence alias", "group alias", "missing capability definition", "missing demand definition", "unused capability definition", "unused demand definition",
      "wrong capability assignment", "foreign capability handle", "foreign demand handle", "schema", "uncertain", "uncertain occurrence", "blank normalized definition", "active correction",
      "foreign occurrence segment", "wrong-source occurrence segment", "legacy quote field", "stale catalogue"] as const;
    for (const fault of faults) {
      const attempt = api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: catalogBefore.catalog_revision } });
      const call = await modelCall(app, "requirements.match_catalog");
      const valid = catalogMatching(call, {});
      const invalid = structuredClone(valid);
      const members = Object.keys(invalid.member_slots);
      const occurrences = Object.keys(invalid.occurrence_slots);
      if (fault === "omitted member") delete invalid.member_slots[members[0]!];
      if (fault === "foreign member") invalid.member_slots["foreign:unrecorded-member"] = invalid.member_slots[members[0]!]!;
      if (fault === "omitted occurrence") delete invalid.occurrence_slots[occurrences[0]!];
      if (fault === "foreign occurrence") invalid.occurrence_slots["foreign:unrecorded-occurrence"] = invalid.occurrence_slots[occurrences[0]!]!;
      if (fault === "member alias") Object.assign(invalid.member_slots, {
        [members[0]!]: { kind: "same_as", member_id: members[1]! }, [members[1]!]: { kind: "same_as", member_id: members[0]! } });
      if (fault === "occurrence alias") Object.assign(invalid.occurrence_slots, {
        [occurrences[0]!]: { kind: "same_as", occurrence_id: occurrences[1]! }, [occurrences[1]!]: { kind: "same_as", occurrence_id: occurrences[0]! } });
      const capabilities = Object.keys(invalid.capability_groups), demands = Object.keys(invalid.demand_groups);
      if (fault === "group alias") Object.assign(invalid.capability_groups, { [capabilities[0]!]: { kind: "same_as", capability_group_id: capabilities[1]! } });
      if (fault === "missing capability definition") invalid.capability_groups[capabilities[0]!] = null;
      if (fault === "missing demand definition") invalid.demand_groups[demands[0]!] = null;
      if (fault === "unused capability definition") invalid.member_slots[members[0]!] = { kind: "assigned", capability_group_id: capabilities[1]! };
      if (fault === "unused demand definition") invalid.occurrence_slots[occurrences[0]!] = { kind: "assigned", demand_group_id: demands[1]! };
      if (fault === "wrong capability assignment") {
        invalid.occurrence_slots[occurrences[0]!] = { kind: "assigned", demand_group_id: demands[1]! };
        invalid.demand_groups[demands[0]!] = null;
      }
      if (fault === "foreign capability handle") invalid.member_slots[members[0]!] = { kind: "assigned", capability_group_id: "capability:foreign" };
      if (fault === "foreign demand handle") invalid.occurrence_slots[occurrences[0]!] = { kind: "assigned", demand_group_id: "demand:foreign" };
      if (fault === "foreign occurrence segment" || fault === "wrong-source occurrence segment") {
        const source = multilineSource(call);
        const citation = occurrenceRoots(invalid).flatMap(({ slot }) => slot.citations).find((row) => row.source_id === source.sourceId)!;
        expect(citation).toBeTruthy();
        if (fault === "foreign occurrence segment") citation.segment_id = "unowned:occurrence-segment";
        else {
          const other = (call.body["context"] as CatalogContext).occurrences.find((row) => row.occurrence_id !== accepted.requirements[0]!.occurrence_id)!;
          citation.segment_id = citationSelections(call, [{ sourceId: other.source_id, valuePath: ["original", "spans", 0, "quote"] }])[0]!.segment_id;
        }
      }
      if (fault === "stale catalogue") invalid.catalog_revision -= 1;
      if (fault === "blank normalized definition") memberRoots(invalid)[0]!.slot.definition = " \n\t ";
      if (fault === "active correction") {
        const context = call.body["context"] as CatalogContext;
        const retained = memberRoots(invalid)[0]!;
        const represented = memberRoots(invalid)[1]!;
        const primaryCitations = [retained.memberId, represented.memberId].map((id) => {
          const member = context.members.find((row) => row.member_id === id)!;
          return { sourceId: member.source_id, valuePath: ["canonical", "spans", 0, "quote"] };
        });
        invalid.corrections = [{ member_id: retained.memberId,
          unsupported_claim: core, represented_by_member_id: represented.memberId,
          reason: "Explicit invalid witness: a current accepted occurrence cannot be rewritten through a historical-only correction.",
          citations: citationSelections(call, [{ sourceId: context.catalog_inventory_source_id }, ...primaryCitations]) }];
      }
      if (fault === "uncertain") {
        invalid.status = "needs_review";
        invalid.member_slots[members[0]!] = { kind: "unresolved", reason: "The supplied sources do not establish a complete normalized partition.", citations: memberRoots(valid)[0]!.slot.citations };
        const input = call.body["context"] as CatalogContext;
        for (const occurrence of input.occurrences.filter((row) => row.member_id === members[0]!))
          invalid.occurrence_slots[occurrence.occurrence_id] = { kind: "unresolved", reason: "This unresolved capability leaves its job demand unresolved.",
            citations: citationSelections(call, [{ sourceId: input.catalog_inventory_source_id },
              { sourceId: occurrence.source_id, valuePath: ["original", "spans", 0, "quote"] }]) };
      }
      if (fault === "uncertain occurrence") {
        invalid.status = "needs_review";
        invalid.occurrence_slots[occurrences[0]!] = { kind: "unresolved", reason: "The supplied sources leave this job demand unresolved.", citations: occurrenceRoots(valid)[0]!.slot.citations };
      }
      if (fault === "schema") call.reply({ ...invalid, invented_authority: true });
      else if (fault === "legacy quote field") {
        const source = multilineSource(call);
        call.reply({ ...invalid, demand_groups: Object.fromEntries(Object.entries(invalid.demand_groups).map(([id, slot]) => [id,
          slot !== null ? { ...slot, citations: slot.citations.map((ref) => ref.source_id === source.sourceId
            ? { ...ref, quote: source.original.name + "\n" + source.original.definition } : ref) } : slot,
        ])) });
      }
      else call.reply(invalid);
      const response = await attempt;
      const schemaFault = ["omitted member", "foreign member", "omitted occurrence", "foreign occurrence", "foreign capability handle", "foreign demand handle", "member alias", "occurrence alias", "group alias", "schema", "legacy quote field"].some((value) => value === fault);
      expect(response.status(), `${fault}: ${await response.text()}`).toBe(schemaFault ? 502 : fault === "stale catalogue" ? 409 : 422);
      expect(await response.json()).toMatchObject({ error: { code: {
        "omitted member": "model_schema_violation", "foreign member": "model_schema_violation",
        "omitted occurrence": "model_schema_violation", "foreign occurrence": "model_schema_violation",
        "foreign capability handle": "model_schema_violation", "foreign demand handle": "model_schema_violation",
        "member alias": "model_schema_violation", "occurrence alias": "model_schema_violation", "group alias": "model_schema_violation",
        "missing capability definition": "requirements_partition_reference_invalid", "missing demand definition": "requirements_partition_reference_invalid",
        "unused capability definition": "requirements_partition_reference_invalid", "unused demand definition": "requirements_partition_reference_invalid",
        "wrong capability assignment": "requirements_demand_partition_invalid",
        schema: "model_schema_violation", uncertain: "requirements_consolidation_uncertain", "uncertain occurrence": "requirements_consolidation_uncertain",
        "blank normalized definition": "blank_requirement_field", "active correction": "requirements_correction_witness_invalid",
        "foreign occurrence segment": "foreign_citation_segment_id", "wrong-source occurrence segment": "foreign_source_id",
        "legacy quote field": "model_schema_violation", "stale catalogue": "stale_catalog_revision",
      }[fault] } });
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
    const normalized = authoredPartition(merging, [{ ...root, memberIds: ids }], [{ groupId: "process", definition: completeDemand, jobIds: [posting.job_id] }]);
    const source = multilineSource(merging);
    expect(occurrenceRoots(normalized)[0]!.slot.citations).toEqual(expect.arrayContaining([source.selection]));
    merging.reply(normalized);
    const published = await success;
    expect(published.status(), await published.text()).toBe(200);
    const report = await published.json() as ReconciliationReport;
    expect(report.roots).toHaveLength(1);
    const input = merging.body["context"] as CatalogContext;
    const projectedGroup = report.partition_binding.member_groups[ids[0]!]!;
    expect(projectedGroup.length).toBeLessThanOrEqual(120);
    expect(new Set(Object.values(report.partition_binding.member_groups))).toEqual(new Set([projectedGroup]));
    const inventoryCitation = { source_id: input.catalog_inventory_source_id, quote: `"catalog_revision":${input.catalog_revision}` };
    const { kind: _memberKind, ...capability } = memberRoots(normalized)[0]!.slot;
    const { kind: _occurrenceKind, ...demand } = occurrenceRoots(normalized)[0]!.slot;
    const expectedIntermediate = { status: "complete", catalog_revision: input.catalog_revision,
      capabilities: [{ group_id: projectedGroup, member_ids: ids, ...capability }],
      demands: [{ group_id: projectedGroup, ...demand, bindings: [{ job_id: posting.job_id,
        occurrence_ids: input.occurrences.map((row) => row.occurrence_id) }] }], corrections: [], unresolved: [] };
    const expectedDerived = { ...expectedIntermediate,
      capabilities: [{ ...expectedIntermediate.capabilities[0]!, citations: [inventoryCitation, ...ids.map((id) => ({
        source_id: input.members.find((member) => member.member_id === id)!.source_id, quote: core,
      }))] }],
      demands: [{ ...expectedIntermediate.demands[0]!, citations: [inventoryCitation,
        ...expectedIntermediate.demands[0]!.bindings.flatMap((binding) => binding.occurrence_ids.map((id) => ({
          source_id: input.occurrences.find((occurrence) => occurrence.occurrence_id === id)!.source_id,
          quote: accepted.requirements.find((occurrence) => occurrence.occurrence_id === id)!.spans[0]!.quote,
        }))),
      ] }],
    };
    expect(report.receipt).toMatchObject({ prompt_version: NORMALIZATION_PROMPT_VERSION,
      accepted_result_fingerprint: normalizationFingerprint(normalized) });
    expect(report.partition_binding).toMatchObject({ binder_version: PARTITION_BINDER_VERSION,
      raw_selection_fingerprint: normalizationFingerprint(normalized), intermediate_fingerprint: normalizationFingerprint(expectedIntermediate),
      member_groups: Object.fromEntries(ids.map((id) => [id, projectedGroup])),
      occurrence_groups: Object.fromEntries(input.occurrences.map((row) => [row.occurrence_id, occurrenceRoots(normalized)[0]!.groupId])) });
    const sourceDocuments = Object.fromEntries(modelSources(merging).map((item) => [item.source_id, item.text]));
    expect(report.citation_binding).toMatchObject({ binder_version: CITATION_BINDER_VERSION,
      selection_fingerprint: normalizationFingerprint(expectedIntermediate), derived_fingerprint: normalizationFingerprint(expectedDerived),
      segment_catalog_fingerprint: input.citation_catalog_fingerprint,
      source_fingerprint: normalizationFingerprint(sourceDocuments), source_context_fingerprint: input.citation_source_context_fingerprint,
      source_fingerprints: input.citation_source_fingerprints, segment_catalog: input.citation_segments,
    });
    expect(report.citation_binding.selection_fingerprint).not.toBe(report.citation_binding.derived_fingerprint);
    expect(normalizationFingerprint(report.citation_binding.source_context)).toBe(input.citation_source_context_fingerprint);
    expect(report.citation_binding.source_context.snapshot_heads).toEqual(input.source_snapshot_heads);
    for (const original of accepted.requirements) {
      const recorded = report.citation_binding.source_context.occurrences.find((item) => item.occurrence_id === original.occurrence_id)!;
      expect(recorded).toMatchObject({ requirement_id: original.requirement_id, requirement_revision: original.requirement_revision,
        job_id: posting.job_id, posting_revision: posting.revision, posting_hash: posting.source_hash,
        source_kind: "accepted_snapshot", snapshot_revision: accepted.revision, base_snapshot_revision: accepted.revision,
        source_identity: { source_id: original.source_id, source_revision: original.source_revision, source_hash: original.source_hash,
          evidence_refs: original.evidence_refs, extraction_determination_id: original.extraction_determination_id } });
      expect(report.citation_binding.source_fingerprints[recorded.source_id]).toBe(normalizationFingerprint(sourceDocuments[recorded.source_id]));
    }
    expect(report.citation_binding.source_context.posting_sources).toEqual(expect.arrayContaining([expect.objectContaining({
      job_id: posting.job_id, revision: posting.revision, source_hash: posting.source_hash,
      posting_source_id: posting.source_id, source_revision: posting.source_revision,
    })]));
    const audit = await app.requirementsReconciliation(report.reconciliation_id);
    expect(audit).toMatchObject({ operation_id: report.reconciliation_id, input_fingerprint: report.input_fingerprint });
    expect(audit.selection).toEqual(normalized);
    expect(audit.authority_receipt).toMatchObject({ receipt_id: report.receipt.receipt_id, value: normalized });
    expect(audit.stored_report).toMatchObject({ storage_version: NORMALIZATION_STORAGE_VERSION, report,
      intermediate_selection: expectedIntermediate, derived_decision: expectedDerived,
      partition_binding: report.partition_binding, citation_binding: report.citation_binding });
    // The survivor's name/definition/revision stay exact. Its older positive
    // outcomes and approved wording still cannot acquire the new demand pins.
    expect(report.roots[0]).toMatchObject({ requirement_id: ids[0], revision: 1, definition: core });
    const currentRequirements = await json<NormalizedSnapshot>(api, "get", requirementsPath(posting.job_id));
    expect(currentRequirements.requirements).toHaveLength(2);
    expect(currentRequirements.requirements[0]!.spans).toEqual(accepted.requirements[0]!.spans);
    for (const occurrence of currentRequirements.requirements) {
      expect(occurrence.normalized_demand.definition).toBe(completeDemand);
      expect(occurrence.normalized_demand.provenance.reconciliation_id).toBe(report.reconciliation_id);
      expect(occurrence.normalized_demand.provenance.citation_binding).toMatchObject({
        selection_fingerprint: report.citation_binding.selection_fingerprint,
        derived_fingerprint: report.citation_binding.derived_fingerprint,
        source_context_fingerprint: report.citation_binding.source_context_fingerprint,
      });
      expect(occurrence.normalized_demand.provenance.citations).toEqual(expect.arrayContaining([
        { source_id: source.sourceId, quote: clauses[0] },
      ]));
    }
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
    const removedHistory = await json<{ rows: { state: string; achievement_id: string; current: boolean }[] }>(api, "get", `/v1/fit/associations/${removedAssociation.association_id}/history`);
    expect(removedHistory.rows[0]).toMatchObject({ state: "removed", achievement_id: removedAchievement.achievement_id, current: false });
    expect(app.external.calls).toHaveLength(callsBeforeAliasWrites);
    expect(await json(api, "get", "/v1/profile/wording")).toEqual(oldWording);
    expect(await json(api, "get", `${fitPath(posting.job_id)}/history`)).toEqual(oldHistory);
    expect((await getResume(api, resume.resume_id)).accepted_revision_id).toBe(resume.accepted_revision_id);
    expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);

    await page.goto(`/requirements?requirement=${encodeURIComponent(ids[0]!)}`);
    const detail = page.getByRole("region", { name: "Requirement details", exact: true });
    await expect(detail.getByRole("heading", { name: "Linked achievements 1", exact: true })).toBeVisible();
    await expect(detail.getByText("Profile match: Needs update", { exact: true })).toBeVisible();
    const earlierCard = detail.locator(`.requirement-achievement[data-achievement-id='${achievement.achievement_id}']`);
    await expect(detail.locator(".requirement-achievement")).toHaveCount(1);
    await expect(earlierCard.locator(".requirement-achievement__fact")).toHaveText(library.variants.find((variant) => variant.variant_id === achievement.baseline_variant_id)!.text);
    await expect(earlierCard.getByText("Earlier relationship · needs review", { exact: true })).toBeVisible();
    await expect(detail.locator(`.requirement-achievement[data-achievement-id='${removedAchievement.achievement_id}']`)).toHaveCount(0);
    await expect(detail.getByRole("button", { name: "Use as current wording", exact: true })).toHaveCount(0);
    await expect(earlierCard.getByText("No current wording has been selected for this requirement.", { exact: true })).toBeVisible();
    await page.getByRole("combobox", { name: "Filter a column", exact: true }).selectOption("support");
    const matchFilter = page.getByRole("dialog", { name: "Profile match filter", exact: true });
    await matchFilter.getByRole("checkbox", { name: "Needs update", exact: true }).check();
    await page.keyboard.press("Escape");
    await page.reload();
    const retainedRow = page.getByRole("table", { name: "Saved requirements", exact: true }).locator("tbody tr[data-row-id]");
    await expect(retainedRow).toHaveCount(1);
    await expect(retainedRow.getByText("1 earlier · needs review", { exact: true })).toBeVisible();
    await expect(earlierCard.getByText("Earlier relationship · needs review", { exact: true })).toBeVisible();
    await detail.getByRole("button", { name: "← Back to requirements", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(retainedRow.getByText("1 earlier · needs review", { exact: true })).toBeVisible();
    await testInfo.attach("requirements-retained-links-table-1280", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
    await page.setViewportSize({ width: 390, height: 844 });
    const mobileRequirements = page.getByRole("list", { name: "Saved requirements", exact: true });
    await expect(mobileRequirements.getByText("1 earlier · needs review", { exact: true })).toBeVisible();
    await testInfo.attach("requirements-retained-links-list-390", { contentType: "image/png", body: await page.screenshot({ animations: "disabled" }) });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await retainedRow.click();
    await expect(earlierCard.getByText("Earlier relationship · needs review", { exact: true })).toBeVisible();
    await earlierCard.locator("summary").filter({ hasText: /^Recorded achievement identity$/ }).click();
    await expect(earlierCard.getByText(achievement.achievement_id, { exact: true })).toBeVisible();
    await earlierCard.locator("summary").filter({ hasText: /^Earlier relationship sources$/ }).click();
    await expect(earlierCard.getByRole("heading", { name: `Recorded requirement: ${aliasId}`, exact: true })).toBeVisible();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
      await earlierCard.scrollIntoViewIfNeeded();
      expect(await earlierCard.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await testInfo.attach(`requirements-earlier-achievement-${width}`, { contentType: "image/png", body: await earlierCard.screenshot() });
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
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
    await earlierSummary.locator("..").getByRole("heading", { name: `Recorded requirement: ${earlierRecords[0]!.requirement_id}`, exact: true }).scrollIntoViewIfNeeded();
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
