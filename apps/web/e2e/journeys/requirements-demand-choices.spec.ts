import { expect, json, modelCall, terminal, test } from "../harness/fixtures.js";
import { baseline, createBaseline } from "./core-data.js";
import { authoredPartition, requirementsPath, retainedCapability, type NormalizedSnapshot } from "./consolidation-data.js";
import { qualificationBatchDecision, qualificationBindings } from "./qualification-data.js";
import { catalogContext, catalogMatching, normalizationFingerprint, REFRESH_NORMALIZATION_PROMPT_VERSION,
  typedExtraction, type CatalogChoice, type OccurrenceRootSlot, type ReusableDemand } from "./requirements-data.js";
import { captureReusePosting } from "./reuse-data.js";

test("table comparisons bind each retained demand once and refuse foreign or ambiguous selections before publishing and assessing Fit", async ({ api, app }, info) => {
  await createBaseline(api, structuredClone(baseline));
  const repair = "Overhaul the pump assemblies.";
  const otherWording = "Perform overhauls on the pump assemblies.";
  const training = "Previous experience instructing apprentices.";
  const records = "Document the completed pump overhauls.";
  const skill = (localId: string, text: string): ReusableDemand => ({ localId, text, category: "skill" });
  const publish = async (slug: string, rows: ReusableDemand[], choices: Record<string, CatalogChoice>) => {
    const posting = await captureReusePosting(api, slug, rows.map(row => row.text).join("\n"));
    const request = api.post(requirementsPath(posting.job_id), { data: { expected_posting_revision: posting.revision, expected_revision: 0 } });
    const extraction = await modelCall(app, "requirements.extract");
    extraction.reply(typedExtraction(extraction, { requirements: rows }));
    const matching = await modelCall(app, "requirements.match_catalog");
    matching.reply(catalogMatching(matching, choices));
    const result = await request;
    expect(result.status(), await result.text()).toBe(200);
    return { id: posting.job_id, snapshot: await result.json() as NormalizedSnapshot };
  };
  const first = await publish("demand-choice-first", [skill("repair", repair), { localId: "trainer", text: training, category: "professional_experience" }],
    { repair: { verdict: "new" }, trainer: { verdict: "new" } });
  const firstRepair = first.snapshot.requirements.find(row => row.local_id === "repair")!;
  const trainer = first.snapshot.requirements.find(row => row.local_id === "trainer")!;
  const second = await publish("demand-choice-second", [skill("overhaul", otherWording)],
    { overhaul: { verdict: "equivalent", requirementId: firstRepair.requirement_id, demandDefinition: otherWording } });
  expect(second.snapshot.requirements[0]!.normalized_demand.demand_fingerprint).not.toBe(firstRepair.normalized_demand.demand_fingerprint);
  const third = await captureReusePosting(api, "demand-choice-third", `${repair}\n${records}`);
  const target = requirementsPath(third.job_id), data = { expected_posting_revision: third.revision, expected_revision: 0 };
  const failures = {
    ambiguous: "requirements_demand_reuse_invalid", absent: "requirements_demand_reuse_invalid", differentGroup: "requirements_demand_reuse_invalid",
    changedCategory: "requirements_demand_reuse_invalid", foreign: "model_schema_violation", bothDefinitionAndReference: "model_schema_violation",
    missingEvidence: "missing_source_citation", foreignOccurrence: "requirements_demand_source_invalid",
  } as const;
  for (const choice of [...Object.keys(failures) as (keyof typeof failures)[], "valid"] as const) {
    const pending = api.post(target, { data });
    if (choice === "ambiguous") {
      const extracting = await modelCall(app, "requirements.extract");
      extracting.reply(typedExtraction(extracting, { requirements: [skill("repair", repair), skill("record", records)] }));
    }
    const matching = await modelCall(app, "requirements.match_catalog");
    expect(matching.body.prompt_version).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
    const context = catalogContext(matching);
    const proposed = (id: string) => context.incoming.find(row => row.local_id === id)!;
    const shared = retainedCapability(matching, firstRepair.requirement_id, "shared");
    shared.memberIds.push(proposed("repair").member_id);
    const response = authoredPartition(matching, [shared, retainedCapability(matching, trainer.requirement_id, "trainer"),
      { groupId: "new", memberIds: [proposed("record").member_id], category: "skill", name: records, definition: records }], [
      { groupId: "shared", jobIds: [first.id, second.id, third.job_id], definition: repair, reuseDemandFingerprint: firstRepair.normalized_demand.demand_fingerprint },
      { groupId: "trainer", jobIds: [first.id], definition: training, reuseDemandFingerprint: trainer.normalized_demand.demand_fingerprint },
      { groupId: "new", jobIds: [third.job_id], definition: records },
    ]);
    const slots = response.demand_groups;
    const source = context.accepted_demands.find(row => row.demand_fingerprint === firstRepair.normalized_demand.demand_fingerprint)!;
    const other = context.accepted_demands.find(row => row.demand_fingerprint === trainer.normalized_demand.demand_fingerprint)!;
    expect(source).toMatchObject({ definition: repair, group_member_ids: [firstRepair.requirement_id] });
    const group = (kind: string) => Object.entries(slots).find(([, slot]) => slot?.kind === kind)![0];
    const selected = group("select"), authored = group("author");
    expect(slots[selected]).toMatchObject({ kind: "select", prior_demand_source_id: source.source_id });
    expect(slots[group("keep")]).not.toHaveProperty("definition");
    expect(slots[authored]).toMatchObject({ kind: "author", definition: records });
    expect(JSON.stringify(response)).not.toContain(firstRepair.normalized_demand.demand_fingerprint);
    const citations = slots[selected]!.citations;
    if (choice === "ambiguous") slots[selected] = { kind: "keep", citations };
    if (choice === "absent") slots[authored] = { kind: "keep", citations: slots[authored]!.citations };
    if (choice === "differentGroup" || choice === "foreign") slots[selected] = { kind: "select", citations,
      prior_demand_source_id: choice === "differentGroup" ? other.source_id : context.catalog_inventory_source_id };
    if (choice === "changedCategory") {
      const assignment = response.member_slots[firstRepair.requirement_id]!;
      if (assignment.kind !== "assigned") throw new Error("The controlled repair capability must be assigned");
      const capability = response.capability_groups[assignment.capability_group_id]!;
      capability.category = "professional_experience"; capability.reuse_requirement_id = null;
    }
    if (choice === "foreignOccurrence") citations.push(slots[group("keep")]!.citations.find(row => row.source_id !== context.catalog_inventory_source_id)!);
    if (choice === "missingEvidence") slots[selected]!.citations = citations.filter(row => row.source_id === context.catalog_inventory_source_id);
    if (choice === "bothDefinitionAndReference") Object.assign(slots[selected]!, { definition: repair });
    matching.reply(response);
    const result = await pending;
    if (choice !== "valid") {
      expect(await result.json()).toMatchObject({ error: { code: failures[choice] } });
      expect(await json(api, "get", target)).toBeNull();
      expect(await json(api, "get", requirementsPath(second.id))).toEqual(second.snapshot);
      continue;
    }
    expect(result.status(), await result.text()).toBe(200);
    const saved = await result.json() as NormalizedSnapshot;
    const reused = saved.requirements.find(row => row.local_id === "repair")!;
    expect(reused.normalized_demand).toMatchObject({ definition: repair, demand_fingerprint: firstRepair.normalized_demand.demand_fingerprint });
    const unchanged = await json<NormalizedSnapshot>(api, "get", requirementsPath(first.id));
    expect(unchanged).toEqual(first.snapshot);
    const updated = await json<NormalizedSnapshot>(api, "get", requirementsPath(second.id));
    expect(updated.requirements[0]).toMatchObject({ previous_occurrence_id: second.snapshot.requirements[0]!.occurrence_id,
      extraction_determination_id: second.snapshot.requirements[0]!.extraction_determination_id,
      normalized_demand: { definition: repair, demand_fingerprint: firstRepair.normalized_demand.demand_fingerprint } });
    const audit = await app.requirementsReconciliation(reused.normalized_demand.provenance.reconciliation_id);
    expect(audit.selection).toEqual(response);
    expect(audit.authority_receipt.value).toEqual(response);
    const intermediate = audit.stored_report.intermediate_selection as { demands: (Omit<OccurrenceRootSlot, "kind"> & {
      bindings: { occurrence_ids: string[] }[] })[] };
    const expanded = structuredClone(response);
    for (const row of context.occurrences) {
      expect(response.occurrence_slots[row.occurrence_id]).toEqual({ kind: "cited" });
      const owners = Object.entries(response.demand_groups).filter(([, group]) => group?.citations.some(ref => ref.source_id === row.source_id));
      expect(owners).toHaveLength(1);
      expanded.occurrence_slots[row.occurrence_id] = { kind: "assigned", demand_group_id: owners[0]![0] };
    }
    for (const demand of intermediate.demands) {
      const assignment = expanded.occurrence_slots[demand.bindings[0]!.occurrence_ids[0]!]!;
      if (assignment.kind !== "assigned") throw new Error("The published demand must have a recorded occurrence assignment");
      expanded.demand_groups[assignment.demand_group_id] = { kind: "group", definition: demand.definition,
        reuse_demand_fingerprint: demand.reuse_demand_fingerprint, citations: demand.citations };
    }
    expect(audit.stored_report.partition_binding).toMatchObject({ raw_selection_fingerprint: normalizationFingerprint(response),
      expanded_group_selection_fingerprint: normalizationFingerprint(expanded), intermediate_fingerprint: normalizationFingerprint(intermediate) });
    await info.attach("demand-selection-bytes", { contentType: "application/json", body: JSON.stringify({
      request: Buffer.byteLength(JSON.stringify(matching.body)), selected: Buffer.byteLength(JSON.stringify(response)),
      equivalentFullSlots: Buffer.byteLength(JSON.stringify(expanded)),
    }) });
    const assessing = api.post(`/v1/jobs/${third.job_id}/fit/assess`, { data: { expected_revision: 0, prepare_coverage: false, prepare_wording: false } });
    const qualification = await modelCall(app, "fit.qualification-batch");
    expect(qualificationBindings(qualification).map(row => row.demand_fingerprint).sort()).toEqual(saved.requirements.map(row => row.normalized_demand.demand_fingerprint).sort());
    qualification.reply(qualificationBatchDecision(qualification, () => ({ kind: "missing" })));
    const assessed = await assessing;
    expect(assessed.status(), await assessed.text()).toBe(200);
    expect(await json(api, "get", `/v1/jobs/${third.job_id}/fit`)).toMatchObject({ current: true, qualifications_current: true,
      score: { summary: { assessed_count: 2 }, assessments: [{ contribution: { max_points: 1 } }, { contribution: { max_points: 1 } }] } });
  }
});


test("an interrupted demand-choice comparison keeps its original run and never dispatches a replacement decision", async ({ api, app }) => {
  const description = "Inspect the completed work before a workshop reopens.";
  const job = await captureReusePosting(api, "interrupted-demand-choice", description);
  const data = { job_id: job.job_id, expected_posting_revision: job.revision, expected_revision: 0 };
  const start = () => api.post("/v1/actions/requirements.refresh", { headers: { "idempotency-key": "interrupted-demand-choice" }, data });
  const started = await start();
  expect(started.ok(), await started.text()).toBe(true);
  const { runId } = await started.json();
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { requirements: [{ localId: "inspection", category: "skill", text: description }] }));
  const held = await modelCall(app, "requirements.match_catalog");
  expect(held.body.prompt_version).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
  const count = app.external.calls.length;
  await app.restartWorker();
  expect(await terminal(api, runId)).toMatchObject({ status: "failed", errorCode: "requirements_consolidation_call_unsettled" });
  const replay = await start();
  expect(await replay.json()).toMatchObject({ runId, status: "failed" });
  expect(app.external.calls).toHaveLength(count);
  expect(await json(api, "get", requirementsPath(job.job_id))).toBeNull();
});
