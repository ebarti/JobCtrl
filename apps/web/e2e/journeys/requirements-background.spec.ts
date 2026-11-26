import { completed, expect, json, modelCall, terminal, test } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { type NormalizedSnapshot } from "./consolidation-data.js";
import { qualificationBatchDecision } from "./qualification-data.js";
import { catalogContext, catalogMatching, modelSources, REFRESH_NORMALIZATION_PROMPT_VERSION,
  typedExtraction, type ReusableDemand } from "./requirements-data.js";
import { captureReusePosting } from "./reuse-data.js";

test("an explicit new comparison can retain alternative prior backgrounds as one demand after an uncertain result", async ({ api, app }) => {
  test.setTimeout(120_000);
  const authored = structuredClone(baseline);
  authored.resume.experience_entries[0]!.bullets[0] = "Managed collection records for a museum.";
  const { library } = await createBaseline(api, authored);
  const rows: ReusableDemand[] = [
    { localId: "prior", category: "professional_experience", text: "Prior work in either museum collections or railway operations qualifies.",
      name: "Prior work in museum collections or railway operations", definition: "Previously worked in either museum collections or railway operations." },
    { localId: "practice", category: "skill", text: "Design control panels with a layout editor, for example Aster or Brio.",
      name: "Control panel design", definition: "Design control panels using a layout editor.", sourceNote: "Aster and Brio are examples." },
  ];
  const posting = await captureReusePosting(api, "background-choice", rows.map(row => row.text).join("\n"));
  const path = `/v1/jobs/${posting.job_id}/requirements`;
  const data = { job_id: posting.job_id, expected_posting_revision: posting.revision, expected_revision: 0 };
  const start = async (key: string) => {
    const response = await api.post("/v1/actions/requirements.refresh", { data, headers: { "idempotency-key": key } });
    expect(response.ok(), await response.text()).toBe(true);
    return (await response.json()).runId as string;
  };
  const original = await start("original-background");
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { requirements: rows }));
  const previous = await modelCall(app, "requirements.match_catalog");
  expect(previous.body["prompt_version"]).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  previous.reply(catalogMatching(previous, { prior: { verdict: "uncertain" }, practice: { verdict: "new" } }));
  expect(await terminal(api, original)).toMatchObject({ status: "failed", errorCode: "requirements_consolidation_uncertain" });
  expect(await json(api, "get", path)).toBeNull();

  expect(await start("original-background")).toBe(original);
  expect(await terminal(api, original)).toMatchObject({ status: "failed", errorCode: "requirements_consolidation_uncertain" });
  expect(app.external.calls.filter(call => call.path === "/model")).toHaveLength(2);
  const fresh = await start("new-background");
  const comparison = await modelCall(app, "requirements.match_catalog");
  expect(comparison.body["prompt_version"]).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  expect(comparison.body["instructions"]).toContain("SOURCE-ESTABLISHED ALTERNATIVES IN PRIOR BACKGROUND");
  const context = catalogContext(comparison);
  expect(context.members).toHaveLength(2);
  expect(context.occurrences).toHaveLength(2);
  comparison.reply(catalogMatching(comparison, { prior: { verdict: "new" }, practice: { verdict: "new" } }));
  await completed(api, fresh);
  const accepted = await json<NormalizedSnapshot>(api, "get", path);
  expect(accepted.requirements).toHaveLength(2);
  const background = accepted.requirements.find(row => row.canonical.category === "professional_experience")!;
  const skill = accepted.requirements.find(row => row.canonical.category === "skill")!;
  for (const [item, originalRow] of [[background, rows[0]!], [skill, rows[1]!]] as const) {
    expect(item.definition).toBe(originalRow.definition);
    expect(item.normalized_demand.definition).toBe(originalRow.definition);
    expect(item.spans).toEqual(expect.arrayContaining([expect.objectContaining({ quote: originalRow.text })]));
    expect(item.provenance.resolution).toEqual([expect.objectContaining({ prompt_version: REFRESH_NORMALIZATION_PROMPT_VERSION })]);
  }
  const assessing = api.post(`/v1/jobs/${posting.job_id}/fit/assess`, { data: { expected_revision: 0, prepare_wording: false, prepare_coverage: false } });
  const qualification = await modelCall(app, "fit.qualification-batch");
  const achievement = library.roles[0]!.achievements[0]!;
  qualification.reply(qualificationBatchDecision(qualification, binding => {
    if (binding.requirement_id === skill.requirement_id) return { kind: "missing" };
    expect(binding).toMatchObject({ requirement_id: background.requirement_id, demand_fingerprint: background.normalized_demand.demand_fingerprint });
    expect(modelSources(qualification).find(source => source.source_id === binding.source_id)!.text).toContain(background.normalized_demand.definition);
    return { kind: "matched", strength: "direct", achievementIds: [achievement.achievement_id],
      evidenceSourceIds: [`evidence:${achievement.source_refs[0]!.source_id}`] };
  }));
  const assessed = await assessing;
  expect(assessed.status(), await assessed.text()).toBe(200);
  const fit = await json<{ score: { assessments: { requirement_id: string; contribution: { max_points: number } }[] } }>(
    api, "get", `/v1/jobs/${posting.job_id}/fit`);
  expect(fit.score.assessments.map(item => item.requirement_id).sort()).toEqual([background.requirement_id, skill.requirement_id].sort());
  expect(fit.score.assessments.find(item => item.requirement_id === background.requirement_id)?.contribution.max_points).toBe(1);

  const unclear = "The posting lists a rotation, with prior participation or training after hire to be clarified.";
  const additional = await captureReusePosting(api, "unclear-background", unclear);
  const refusal = api.post(`/v1/jobs/${additional.job_id}/requirements`, {
    data: { expected_posting_revision: additional.revision, expected_revision: 0 } });
  const unclearExtraction = await modelCall(app, "requirements.extract");
  unclearExtraction.reply(typedExtraction(unclearExtraction, { requirements: [{ localId: "rotation", text: unclear,
    category: "professional_experience", name: "Rotation background", definition: "Previously participated in a rotation." }] }));
  const unresolved = await modelCall(app, "requirements.match_catalog");
  expect(unresolved.body["prompt_version"]).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  unresolved.reply(catalogMatching(unresolved, { rotation: { verdict: "uncertain" } }));
  expect((await refusal).status()).toBe(422);
  expect(await json(api, "get", path)).toEqual(accepted);
  expect(await json(api, "get", `/v1/jobs/${additional.job_id}/requirements`)).toBeNull();
  expect(app.external.calls.filter(call => call.path === "/model").map(call => call.body["operation"])).toEqual([
    "requirements.extract", "requirements.match_catalog", "requirements.match_catalog", "fit.qualification-batch",
    "requirements.extract", "requirements.match_catalog",
  ]);
});
