import type { APIRequestContext } from "@playwright/test";
import { test, expect, json, modelCall, action, completed, terminal, type ApplicationStack } from "../harness/fixtures.js";
import { baseline, createBaseline, type Profile } from "./core-data.js";
import { catalogMatching, typedExtraction, modelSources } from "./requirements-data.js";
import { qualificationBatchDecision, type QualificationBinding, type QualificationChoice } from "./qualification-data.js";
import { captureReusePosting, type RequirementSnapshot } from "./reuse-data.js";
import { groupedCoverageDecision, impactPartition, refreshPayload, startRefresh, type PendingRefresh, type RefreshOperation } from "./fit-data.js";

type DirectDemand = { requirement_id: string; category: "education" | "language"; revision: number };
type Snapshot = RequirementSnapshot & { education: DirectDemand[]; languages: DirectDemand[]; status: string };
type Evidence = { source_id: string; kind: string; text: string; path?: string[] };
type Assessment = { assessment_id: string; requirement_id: string; category: string; definition: string; kind: string; evidence_route: string | null; wording_support: string; evidence_refs: { source_id: string }[]; provenance: { receipt_id: string }; contribution: { max_points: number; awarded_points: number } };
type Fit = { current: boolean; score: { revision: number; score: number | null; fit_band: string | null; formula_version: string; summary: { assessed_count: number; supported_count: number; qualification_coverage: number | null }; assessments: Assessment[] } | null; coverage: { wording_gaps: unknown[] } };
const assess = { expected_revision: 0, prepare_wording: true, prepare_coverage: true };
const operations = (app: ApplicationStack, since = 0) => app.external.calls.slice(since).filter((call) => call.path === "/model").map((call) => call.body["operation"]);

async function typedJob(api: APIRequestContext, app: ApplicationStack, slug: string) {
  const authored = structuredClone(baseline);
  authored.resume.language_entries = [{ id: "english", language: "English", proficiency: "Professional working proficiency" }];
  // The same language text in Skills and a role is deliberately ineligible as
  // language evidence; only the separately authored Language row has authority.
  authored.resume.skill_categories[0]!.items.push("English");
  authored.resume.experience_entries[0]!.summary = "Operated production services and communicated in English.";
  const { profile } = await createBaseline(api, authored);
  const sources = (await json<{ sources: Evidence[] }>(api, "get", "/v1/profile/sources")).sources;
  const evidence = {
    skill: sources.find((row) => row.path?.[1] === "skill_categories")!,
    experience: sources.find((row) => row.kind === "role")!,
    education: sources.find((row) => row.path?.[1] === "education_entries")!,
    language: sources.find((row) => row.kind === "language")!,
  };
  for (const source of Object.values(evidence)) expect(source).toBeTruthy();
  const texts = [
    "Demonstrate Python programming skill.",
    "Bring professional experience operating production services.",
    "Hold an engineering degree.",
    "Hold an engineering degree or equivalent professional experience.",
    "Use English at professional working proficiency.",
  ];
  const posting = await captureReusePosting(api, slug, texts.join("\n"));
  const extracting = api.post(`/v1/jobs/${posting.job_id}/requirements`, { data: { expected_posting_revision: posting.revision, expected_revision: 0 } });
  const call = await modelCall(app, "requirements.extract");
  call.reply(typedExtraction(call, {
    requirements: [
      { localId: "python", text: texts[0]!, category: "skill", name: "Python programming" },
      { localId: "operations", text: texts[1]!, category: "professional_experience", name: "Production service operations" },
    ],
    education: [
      { text: texts[2]!, qualification: "Engineering degree", subjects: ["Engineering"] },
      { text: texts[3]!, qualification: "Engineering degree", alternative: "Equivalent professional experience" },
    ],
    languages: [{ text: texts[4]!, language: "English", proficiency: "Professional working proficiency" }],
  }));
  const matching = await modelCall(app, "requirements.match_catalog");
  expect((matching.body["context"] as { incoming: unknown[] }).incoming).toHaveLength(2);
  matching.reply(catalogMatching(matching, { python: { verdict: "new" }, operations: { verdict: "new" } }));
  const response = await extracting;
  expect(response.status(), await response.text()).toBe(200);
  const snapshot = await response.json() as Snapshot;
  const choose = (binding: QualificationBinding): QualificationChoice => {
    if (binding.category === "skill") return { evidenceSourceIds: [`evidence:${evidence.skill.source_id}`] };
    if (binding.category === "professional_experience") return { strength: "strong", evidenceSourceIds: [`evidence:${evidence.experience.source_id}`], keywords: ["Synthetic typed operations"] };
    if (binding.category === "language") return { evidenceSourceIds: [`evidence:${evidence.language.source_id}`] };
    return binding.requirement_id === snapshot.education[0]!.requirement_id
      ? { evidenceRoute: "education", evidenceSourceIds: [`evidence:${evidence.education.source_id}`] }
      : { kind: "transferable", evidenceRoute: "equivalent_experience", evidenceSourceIds: [`evidence:${evidence.experience.source_id}`] };
  };
  const assessing = api.post(`/v1/jobs/${posting.job_id}/fit/assess`, { data: assess });
  const batch = await modelCall(app, "fit.qualification-batch");
  const bindings = (batch.body["context"] as { requirements: QualificationBinding[] }).requirements;
  expect(bindings).toHaveLength(5);
  expect(new Set(bindings.map((row) => row.category))).toEqual(new Set(["skill", "professional_experience", "education", "language"]));
  expect(bindings.find((row) => row.category === "language")!.permitted_evidence_ids).toEqual([`evidence:${evidence.language.source_id}`]);
  batch.reply(qualificationBatchDecision(batch, choose));
  const accepted = await assessing;
  expect(accepted.status(), await accepted.text()).toBe(200);
  return { posting, profile, snapshot, evidence, choose, texts, fit: await accepted.json() as Fit };
}

test("typed qualifications share one batch, use permitted Profile sections and refresh only manually selected direct demands", async ({ api, app, page }, testInfo) => {
  const seed = await typedJob(api, app, "typed-sections");
  expect(seed.snapshot).toMatchObject({ contract_version: "requirements-v2", status: "complete", education: [{ category: "education" }, { category: "education" }], languages: [{ category: "language" }] });
  expect(seed.fit.score).toMatchObject({ score: 9, formula_version: "requirement-fit-v3-equal", summary: { assessed_count: 5, supported_count: 5, qualification_coverage: 0.89 } });
  expect(seed.fit.score!.assessments.map((row) => row.contribution.max_points)).toEqual([1, 1, 1, 1, 1]);
  expect(seed.fit.score!.assessments.map((row) => row.wording_support)).toEqual(["section", "section", "section", "section", "section"]);
  expect(seed.fit.coverage.wording_gaps).toEqual([]);
  expect(operations(app)).toEqual(["requirements.extract", "requirements.match_catalog", "fit.qualification-batch"]);
  const callsBeforeName = app.external.calls.length;
  await page.goto(`/jobs/${seed.posting.job_id}?jobTab=fit`);
  const assessments = page.getByRole("list", { name: "Requirement assessments", exact: true });
  await expect(assessments.getByRole("article", { name: "Requirement 3", exact: true })).toContainText("Engineering degree · Subjects: Engineering");
  await expect(assessments.getByRole("article", { name: "Requirement 4", exact: true })).toContainText("Engineering degree · Alternative: Equivalent professional experience");
  await expect(assessments.getByRole("article", { name: "Requirement 5", exact: true })).toContainText("English · Proficiency: Professional working proficiency");
  for (const [index, row] of seed.fit.score!.assessments.entries()) {
    if (row.category === "education" || row.category === "language") {
      await expect(assessments.getByRole("article", { name: `Requirement ${index + 1}`, exact: true })).not.toContainText(row.definition);
    }
  }
  expect((await json<Fit>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(seed.fit.score);
  expect(app.external.calls).toHaveLength(callsBeforeName);
  await testInfo.attach("typed-readable-direct-demands", { contentType: "image/png", body: await page.screenshot({ fullPage: true }) });
  const identityOnly = await json<Profile>(api, "get", "/v1/profile");
  identityOnly.profile.personal.full_name = "Synthetic Updated Display Name";
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: identityOnly.profileVersion, profile: identityOnly.profile });
  expect((await json<Fit>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).current).toBe(true);
  expect(app.external.calls).toHaveLength(callsBeforeName);
  const catalog = await json<{ requirements: { requirement_id: string; category: string }[] }>(api, "get", "/v1/requirements");
  expect(catalog.requirements.map((row) => row.category).sort()).toEqual(["professional_experience", "skill"]);
  for (const row of [...seed.snapshot.education, ...seed.snapshot.languages]) expect(row.requirement_id).toMatch(/^requirements-v2:direct:/);

  // A second occurrence of an equivalent skill changes no arithmetic. Direct
  // demands remain job-local, so only those three items need new qualification.
  const duplicate = await captureReusePosting(api, "typed-duplicate", [...seed.texts, "Demonstrate the same Python programming skill."].join("\n"));
  const extracting = api.post(`/v1/jobs/${duplicate.job_id}/requirements`, { data: { expected_posting_revision: duplicate.revision, expected_revision: 0 } });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, {
    requirements: [
      { localId: "python", text: seed.texts[0]!, category: "skill" },
      { localId: "operations", text: seed.texts[1]!, category: "professional_experience" },
      { localId: "python-again", text: "Demonstrate the same Python programming skill.", category: "skill" },
    ],
    education: [{ text: seed.texts[2]!, qualification: "Engineering degree" }, { text: seed.texts[3]!, qualification: "Engineering degree", alternative: "Equivalent professional experience" }],
    languages: [{ text: seed.texts[4]!, language: "English", proficiency: "Professional working proficiency" }],
  }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, {
    python: { verdict: "equivalent", requirementId: seed.snapshot.requirements[0]!.requirement_id },
    operations: { verdict: "equivalent", requirementId: seed.snapshot.requirements[1]!.requirement_id },
    "python-again": { verdict: "equivalent", requirementId: seed.snapshot.requirements[0]!.requirement_id },
  }));
  const duplicateResponse = await extracting;
  expect(duplicateResponse.status(), await duplicateResponse.text()).toBe(200);
  const duplicateSnapshot = await duplicateResponse.json() as Snapshot;
  const assessing = api.post(`/v1/jobs/${duplicate.job_id}/fit/assess`, { data: assess });
  const directBatch = await modelCall(app, "fit.qualification-batch");
  expect((directBatch.body["context"] as { requirements: QualificationBinding[] }).requirements.map((row) => row.category).sort()).toEqual(["education", "education", "language"]);
  directBatch.reply(qualificationBatchDecision(directBatch, (binding) => binding.category === "language"
    ? { evidenceSourceIds: [`evidence:${seed.evidence.language.source_id}`] }
    : binding.requirement_id === duplicateSnapshot.education[0]!.requirement_id
      ? { evidenceRoute: "education", evidenceSourceIds: [`evidence:${seed.evidence.education.source_id}`] }
      : { kind: "transferable", evidenceRoute: "equivalent_experience", evidenceSourceIds: [`evidence:${seed.evidence.experience.source_id}`] }));
  const duplicateAccepted = await assessing;
  expect(duplicateAccepted.status(), await duplicateAccepted.text()).toBe(200);
  const duplicateFit = await duplicateAccepted.json() as Fit;
  expect(duplicateFit.score).toMatchObject({ score: 9, summary: { assessed_count: 5, qualification_coverage: 0.89 } });
  const beforeSave = app.external.calls.length;
  const profile = await json<Profile>(api, "get", "/v1/profile");
  profile.profile.resume.language_entries[0]!.proficiency = "Elementary proficiency";
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: profile.profile });
  const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
  await json(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`);
  await json(api, "get", "/v1/fit/requirement-library");
  expect(app.external.calls).toHaveLength(beforeSave);
  expect((await json<{ runs: unknown[] }>(api, "get", "/v1/action-runs?action=fit.refresh")).runs).toEqual([]);
  const run = await startRefresh(api, { ...refreshPayload(pending, [seed.posting.job_id], { max_model_calls: 2, max_requirements: 1 }), prepare_wording: true }, "typed-direct-manual");
  const impact = await modelCall(app, "fit.catalog-impact");
  const input = impact.body["context"] as { requirements: { requirement_id: string }[] };
  expect(input.requirements.map((row) => row.requirement_id).sort()).toEqual([...seed.snapshot.requirements, ...seed.snapshot.education, ...seed.snapshot.languages].map((row) => row.requirement_id).sort());
  const languageId = seed.snapshot.languages[0]!.requirement_id;
  impact.reply(impactPartition(impact, Object.fromEntries(input.requirements.map((row) => [row.requirement_id, row.requirement_id === languageId ? "affected" : "unchanged"]))));
  const languageBatch = await modelCall(app, "fit.qualification-batch");
  expect((languageBatch.body["context"] as { requirements: QualificationBinding[] }).requirements.map((row) => row.requirement_id)).toEqual([languageId]);
  languageBatch.reply(qualificationBatchDecision(languageBatch, () => ({ kind: "missing" })));
  await completed(api, run.runId);
  expect(await json<RefreshOperation>(api, "get", `/v1/fit/refresh/operations/${run.runId}`)).toMatchObject({ status: "completed", counters: { model_calls: 2, requirements_assessed: 1 } });
  expect((await json<Fit>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toMatchObject({ score: 7, summary: { assessed_count: 5, qualification_coverage: 0.69 } });
  expect((await json<Fit>(api, "get", `/v1/jobs/${duplicate.job_id}/fit`)).score).toEqual(duplicateFit.score);
  expect(operations(app, beforeSave)).toEqual(["fit.catalog-impact", "fit.qualification-batch"]);
  await page.goto("/requirements");
  await expect(page.getByText("Python programming", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("English", { exact: true })).toHaveCount(0);
  await testInfo.attach("typed-reusable-catalog", { contentType: "image/png", body: await page.screenshot() });
});

test("negative Education judgments retain explicit contrary-evidence routes without inferring a missing route", async ({ api, app }) => {
  const seed = await typedJob(api, app, "typed-education-contrary");
  const original = seed.fit.score;
  const profile = await json<Profile>(api, "get", "/v1/profile");
  profile.profile.resume.education_entries[0]!.degree = "General studies certificate";
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: profile.profile });
  const ids = seed.snapshot.education.map((row) => row.requirement_id);
  const before = app.external.calls.length;
  for (const omitRoute of [true, false]) {
    const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
    const run = await startRefresh(api, { ...refreshPayload(pending, [seed.posting.job_id], { max_model_calls: 2, max_requirements: 2 }),
      prepare_wording: false, prepare_coverage: false }, `typed-education-route-${omitRoute ? "missing" : "explicit"}`);
    const impact = await modelCall(app, "fit.catalog-impact");
    const inputs = impact.body["context"] as { requirements: { requirement_id: string }[] };
    impact.reply(impactPartition(impact, Object.fromEntries(inputs.requirements.map((row) => [row.requirement_id, ids.includes(row.requirement_id) ? "affected" : "unchanged"]))));
    const batch = await modelCall(app, "fit.qualification-batch");
    expect((batch.body["context"] as { requirements: QualificationBinding[] }).requirements.map((row) => row.requirement_id).sort()).toEqual(ids.toSorted());
    batch.reply(qualificationBatchDecision(batch, (binding) => ({
      kind: binding.requirement_id === ids[0] ? "blocked" : "missing",
      evidenceRoute: omitRoute && binding.requirement_id === ids[0] ? null : "education",
      evidenceSourceIds: [`evidence:${seed.evidence.education.source_id}`],
    })));
    if (omitRoute) {
      expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: "fit_evidence_route_invalid" });
      expect((await json<Fit>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(original);
    } else {
      await completed(api, run.runId);
      const accepted = await json<Fit>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`);
      expect(accepted).toMatchObject({ current: true, score: { score: 6,
        summary: { assessed_count: 5, supported_count: 3, qualification_coverage: 0.57 } } });
      expect(accepted.score!.assessments.filter((row) => row.category === "education").map((row) => ({
        kind: row.kind, evidence_route: row.evidence_route, wording_support: row.wording_support,
        evidence_ids: row.evidence_refs.map((ref) => ref.source_id),
      }))).toEqual(["blocked", "missing"].map((kind) => ({ kind, evidence_route: "education", wording_support: "none",
        evidence_ids: [seed.evidence.education.source_id] })));
    }
  }
  expect(operations(app, before)).toEqual(["fit.catalog-impact", "fit.qualification-batch", "fit.catalog-impact", "fit.qualification-batch"]);
});

test("typed qualification refuses cross-section evidence and unoffered education alternatives without replacing accepted scores", async ({ api, app }) => {
  const seed = await typedJob(api, app, "typed-source-fences");
  const profile = await json<Profile>(api, "get", "/v1/profile");
  profile.profile.resume.experience_entries[0]!.summary = "Operated production services with a reviewed recovery process.";
  profile.profile.resume.skill_categories[0]!.items.push("Source auditing");
  profile.profile.resume.education_entries[0]!.institution = "Synthetic Updated University";
  profile.profile.resume.language_entries[0]!.proficiency = "Full professional proficiency";
  await json(api, "patch", "/v1/profile", { expectedProfileVersion: profile.profileVersion, profile: profile.profile });
  const failures = [
    { category: "skill", evidence: seed.evidence.language, route: null },
    { category: "professional_experience", evidence: seed.evidence.education, route: null },
    { category: "language", evidence: seed.evidence.skill, route: null },
    { category: "education", evidence: seed.evidence.experience, route: "equivalent_experience" as const },
  ];
  for (const failure of failures) {
    const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
    const run = await startRefresh(api, { ...refreshPayload(pending, [seed.posting.job_id]), prepare_wording: false }, `typed-source-fence-${failure.category}`);
    const impact = await modelCall(app, "fit.catalog-impact");
    const impactInputs = impact.body["context"] as { requirements: { requirement_id: string }[] };
    impact.reply(impactPartition(impact, Object.fromEntries(impactInputs.requirements.map((row) => [row.requirement_id, "affected" as const]))));
    const call = await modelCall(app, "fit.qualification-batch");
    expect(modelSources(call).some((row) => row.source_id === `evidence:${failure.evidence.source_id}`)).toBe(true);
    call.reply(qualificationBatchDecision(call, (binding) => binding.category === failure.category && (binding.category !== "education" || binding.requirement_id === seed.snapshot.education[0]!.requirement_id)
      ? { evidenceSourceIds: [`evidence:${failure.evidence.source_id}`], evidenceRoute: failure.route, wordingSupport: "section" }
      : seed.choose(binding)));
    expect(await terminal(api, run.runId)).toMatchObject({ status: "failed", errorCode: failure.category === "education" ? "fit_evidence_route_invalid" : "fit_evidence_category_invalid" });
    expect((await json<Fit>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).score).toEqual(seed.fit.score);
  }
});

test("an English posting changing to non-English preserves its accepted score as history and refuses fresh qualification", async ({ api, app }) => {
  const seed = await typedJob(api, app, "typed-language-transition");
  expect(await json(api, "get", "/v1/scoring/keywords")).toMatchObject({ keywords: [{ display_keyword: "Synthetic typed operations", job_count: 1 }] });
  const revised = await json<{ revision: number }>(api, "patch", `/v1/jobs/${seed.posting.job_id}`, { expectedRevision: seed.posting.revision, description: "La empresa busca una persona con experiencia para operar sus servicios." });
  const refreshing = api.post(`/v1/jobs/${seed.posting.job_id}/requirements`, { data: { expected_posting_revision: revised.revision, expected_revision: seed.snapshot.revision } });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { classification: "non_english", status: "unsupported_language" }));
  const response = await refreshing;
  expect(response.status(), await response.text()).toBe(200);
  expect(await response.json()).toMatchObject({ status: "unsupported_language", requirements: [], education: [], languages: [] });
  const beforeRefusal = app.external.calls.length;
  expect(await json(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).toMatchObject({ current: false, stale_reasons: ["unsupported_posting_language"], score: seed.fit.score });
  const refused = await api.post(`/v1/jobs/${seed.posting.job_id}/fit/assess`, { data: { ...assess, expected_revision: seed.fit.score!.revision } });
  expect(refused.status(), await refused.text()).toBe(409);
  expect(await refused.json()).toMatchObject({ error: { code: "unsupported_posting_language" } });
  const sorted = await json<{ rows: { job: { job_id: string }; scalars: { fit_score: number | null } }[] }>(api, "get", "/v1/jobs/query?sort=fit_score&direction=desc");
  expect(sorted.rows.find((row) => row.job.job_id === seed.posting.job_id)!.scalars.fit_score).toBeNull();
  expect(await json(api, "get", "/v1/jobs/query?minFitScore=1")).toMatchObject({ total: 0, rows: [] });
  expect(await json(api, "get", "/v1/scoring/keywords")).toEqual({ keywords: [] });
  expect(app.external.calls).toHaveLength(beforeRefusal);
});

test("Fit correction forms preserve explicit support routes across missing, section and achievement transitions", async ({ api, app, page }, testInfo) => {
  const seed = await typedJob(api, app, "typed-correction-routes");
  const library = await json<{ roles: { achievements: { achievement_id: string; baseline_variant_id: string; source_refs: { source_id: string }[] }[] }[] }>(api, "get", "/v1/profile/wording");
  const achievement = library.roles[0]!.achievements[0]!;
  const achievementSource = (await json<{ sources: Evidence[] }>(api, "get", "/v1/profile/sources")).sources.find((row) => row.source_id === achievement.source_refs[0]!.source_id)!;
  const requirementId = seed.snapshot.requirements[0]!.requirement_id;
  const before = app.external.calls.length;
  async function openCorrection() {
    await page.goto(`/jobs/${seed.posting.job_id}`);
    const item = page.getByRole("article", { name: "Requirement 1", exact: true });
    await item.locator("summary").filter({ hasText: /^Evidence and assessment details$/ }).click();
    await item.locator("summary").filter({ hasText: /^Correct this requirement assessment$/ }).click();
    return item.locator(".fit-correction form");
  }
  async function saveCorrection(form: Awaited<ReturnType<typeof openCorrection>>, key: string, support: "none" | "section" | "achievement") {
    const saved = page.waitForResponse((response) => new URL(response.url()).pathname === `/v1/fit/requirements/${encodeURIComponent(requirementId)}/correct` && response.request().method() === "POST");
    await form.getByRole("button", { name: "Save requirement correction", exact: true }).click();
    const response = await saved;
    expect(response.status(), await response.text()).toBe(200);
    const body = response.request().postDataJSON();
    expect(body).toMatchObject({ wording_support: support, evidence_route: null, eligibility: "unknown", blocker_category: null, warning_category: null, achievement_ids: support === "achievement" ? [achievement.achievement_id] : [] });
    if (support === "achievement") expect(body.evidence_refs).toContainEqual(expect.objectContaining({ source_id: achievementSource.source_id, quote: achievementSource.text.slice(0, 160) }));
    else expect(body.evidence_refs).toContainEqual(expect.objectContaining({ source_id: seed.evidence.skill.source_id }));
    const pending = await json<PendingRefresh>(api, "get", "/v1/fit/refresh/pending");
    const run = await startRefresh(api, { ...refreshPayload(pending, [seed.posting.job_id], { max_model_calls: 1, max_requirements: 0 }), prepare_wording: false }, key);
    if (support === "achievement") {
      const coverage = await modelCall(app, "fit.wording-coverage-grouped");
      coverage.reply(groupedCoverageDecision(coverage, { evidenceSourceId: `evidence:${achievementSource.source_id}`, status: "covered", action: "reuse_approved", reusableVariantId: achievement.baseline_variant_id }));
    }
    await completed(api, run.runId);
    expect((await json<Fit>(api, "get", `/v1/jobs/${seed.posting.job_id}/fit`)).current).toBe(true);
  }
  let form = await openCorrection();
  await form.getByRole("combobox", { name: "Qualification", exact: true }).selectOption("missing");
  await form.getByRole("textbox", { name: "Reason", exact: true }).fill("The saved source does not establish this skill; this is an explicit user correction.");
  await saveCorrection(form, "typed-correction-missing", "none");
  form = await openCorrection();
  await form.getByRole("combobox", { name: "Qualification", exact: true }).selectOption("matched");
  await form.getByRole("textbox", { name: "Reason", exact: true }).fill("The exact retained structured Skills source establishes this skill; this is an explicit user correction.");
  const postsBeforeValidation = app.external.calls.length;
  await form.getByRole("button", { name: "Save requirement correction", exact: true }).click();
  await expect(form.locator("..").getByRole("alert")).toContainText("Choose whether the factual support comes from a Profile section or an achievement.");
  expect(app.external.calls).toHaveLength(postsBeforeValidation);
  await form.getByRole("combobox", { name: /^Factual support route/ }).selectOption("section");
  await saveCorrection(form, "typed-correction-section", "section");
  form = await openCorrection();
  await form.getByRole("combobox", { name: /^Factual support route/ }).selectOption("achievement");
  const source = form.locator("details").filter({ hasText: achievementSource.source_id }).first();
  await source.locator("summary").click();
  await source.getByRole("textbox", { name: "Quote from this source", exact: true }).fill(achievementSource.text.slice(0, 160));
  await form.getByRole("group", { name: "Supported achievements", exact: true }).getByRole("checkbox").first().check();
  await form.getByRole("textbox", { name: "Reason", exact: true }).fill("The cited authored achievement establishes this skill and selects its exact saved wording support.");
  await saveCorrection(form, "typed-correction-achievement", "achievement");
  expect(operations(app, before)).toEqual(["fit.wording-coverage-grouped"]);
  await testInfo.attach("typed-correction-routes", { contentType: "image/png", body: await page.screenshot() });
});

for (const classification of ["non_english", "english"] as const) {
  test(`preparation terminally skips ${classification === "english" ? "an English posting with no demands and records no score" : "a non-English posting without translating or scoring"}`, async ({ api, app }) => {
    await createBaseline(api);
    const posting = await captureReusePosting(api, `typed-empty-${classification}`, classification === "english" ? "This is a synthetic company introduction." : "Esta empresa presenta su equipo y busca una persona para el puesto.");
    const run = await action(api, "preparation.run", { recipe: "prepare", scope: "selected", job_ids: [posting.job_id], limit: 1, resume_mode: "tailored" });
    const extraction = await modelCall(app, "requirements.extract");
    extraction.reply(typedExtraction(extraction, { classification, status: classification === "english" ? "complete" : "unsupported_language" }));
    await completed(api, run.runId);
    const result = await json<{ status: string; steps: { stage: string; status: string; result: Record<string, unknown> | null }[] }>(api, "get", `/v1/preparation/runs/${run.runId}`);
    expect(result.status).toBe("succeeded");
    expect(result.steps.find((row) => row.stage === "compose")).toMatchObject({ status: "skipped", result: { skip: classification === "english" ? "no_extractable_requirements" : "unsupported_posting_language" } });
    const fit = await json<Fit>(api, "get", `/v1/jobs/${posting.job_id}/fit`);
    if (classification === "english") expect(fit.score).toMatchObject({ score: null, fit_band: null, summary: { assessed_count: 0, qualification_coverage: null } });
    else expect(fit.score).toBeNull();
    expect((await json<{ resumes: unknown[] }>(api, "get", `/v1/resumes?jobId=${posting.job_id}`)).resumes).toEqual([]);
    expect(operations(app)).toEqual(["requirements.extract"]);
  });
}
