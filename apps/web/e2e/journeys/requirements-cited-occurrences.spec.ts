import { expect, json, modelCall, terminal, test, type ExternalCall } from "../harness/fixtures.js";
import { authoredPartition, requirementsPath, type NormalizedSnapshot } from "./consolidation-data.js";
import { baseline, createBaseline } from "./core-data.js";
import { qualificationBatchDecision, qualificationBindings } from "./qualification-data.js";
import { catalogContext, REFRESH_NORMALIZATION_PROMPT_VERSION, typedExtraction, V10_NORMALIZATION_PROMPT_VERSION } from "./requirements-data.js";
import { captureReusePosting } from "./reuse-data.js";

test.use({ sourceRevision: "29d571dd2556e4add85964ec35a67a3172f5eb90" });

test("a refused dual occurrence assignment stays refused after upgrade and a new source-cited partition supplies both Fit criteria", async ({ api, app }) => {
  await createBaseline(api, structuredClone(baseline));
  const fields = ["Inspect the first stage of a repair.", "Inspect the final stage of a repair.", "Provide accurate estimates to customers."];
  const job = await captureReusePosting(api, "cited-occurrences", fields.join("\n"));
  const path = requirementsPath(job.job_id);
  const start = async (key: string) => {
    const res = await api.post("/v1/actions/requirements.refresh", { headers: { "idempotency-key": key },
      data: { job_id: job.job_id, expected_posting_revision: job.revision, expected_revision: 0 } });
    expect(res.ok(), await res.text()).toBe(true);
    return (await res.json()).runId as string;
  };
  const selection = (call: ExternalCall) => {
    const context = catalogContext(call);
    const rows = ["start", "finish", "estimate"].map(id => context.incoming.find(row => row.local_id === id)!);
    expect(rows.every(Boolean)).toBe(true);
    const groups = [{ groupId: "inspection", memberIds: [rows[0]!.member_id, rows[1]!.member_id], category: "skill" as const,
      name: "Repair inspection", definition: "Inspect the initial and final stages of repairs." },
    { groupId: "estimates", memberIds: [rows[2]!.member_id], category: "skill" as const, name: "Cost estimation", definition: fields[2]! }];
    const raw = authoredPartition(call, groups, groups.map(group => ({ groupId: group.groupId, definition: group.definition, jobIds: [job.job_id] })));
    const occurrence = rows[1]!.occurrence_id;
    const source = context.occurrences.find(row => row.occurrence_id === occurrence)!.source_id;
    const owners = Object.entries(raw.demand_groups).filter(([, demand]) => demand?.citations.some(ref => ref.source_id === source));
    expect(owners).toHaveLength(1);
    const [owner, demand] = owners[0]!;
    const other = Object.entries(raw.demand_groups).find(([key, value]) => value !== null && key !== owner)![0];
    return { raw, occurrence, source, demand: demand!, other };
  };

  const first = await start("v10-contradiction");
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { requirements: ["start", "finish", "estimate"].map((localId, i) =>
    ({ localId, text: fields[i]!, category: "skill" })) }));
  const old = await modelCall(app, "requirements.match_catalog");
  expect(old.body.prompt_version).toBe(V10_NORMALIZATION_PROMPT_VERSION);
  const previous = selection(old);
  previous.raw.occurrence_slots[previous.occurrence] = { kind: "assigned", demand_group_id: previous.other };
  old.reply(previous.raw);
  const refused = await terminal(api, first);
  expect(refused).toMatchObject({ status: "failed", errorCode: "requirements_demand_partition_invalid" });
  expect(await json(api, "get", path)).toBeNull();
  const count = app.external.calls.length;
  await app.upgradeSource();
  expect(await start("v10-contradiction")).toBe(first);
  expect(await terminal(api, first)).toMatchObject({ status: "failed", errorCode: "requirements_demand_partition_invalid" });
  expect(app.external.calls).toHaveLength(count);

  for (const choice of ["extra-assignment", "cross-capability", "supported"] as const) {
    const fresh = await start(choice);
    if (choice === "extra-assignment") {
      const current = await modelCall(app, "requirements.extract");
      expect(current.body.prompt_version).not.toBe(extraction.body.prompt_version);
      current.reply(typedExtraction(current, { requirements: ["start", "finish", "estimate"].map((localId, i) =>
        ({ localId, text: fields[i]!, category: "skill" })) }));
    }
    const call = await modelCall(app, "requirements.match_catalog");
    expect(call.body.prompt_version).toBe(REFRESH_NORMALIZATION_PROMPT_VERSION);
    const { raw, occurrence, source, demand, other } = selection(call);
    expect(raw.occurrence_slots[occurrence]).toEqual({ kind: "cited" });
    if (choice === "extra-assignment") Object.assign(raw.occurrence_slots[occurrence]!, { demand_group_id: other });
    if (choice === "cross-capability") {
      const moved = demand.citations.filter(ref => ref.source_id === source);
      demand.citations = demand.citations.filter(ref => ref.source_id !== source);
      raw.demand_groups[other]!.citations.push(...moved);
    }
    call.reply(raw);
    const outcome = await terminal(api, fresh);
    if (choice === "supported") {
      expect(outcome.status).toBe("succeeded");
    } else {
      expect(outcome).toMatchObject({ status: "failed", errorCode: choice === "extra-assignment" ? "model_schema_violation" : "requirements_demand_partition_invalid" });
      expect(await json(api, "get", path)).toBeNull();
    }
  }
  const saved = await json<NormalizedSnapshot>(api, "get", path);
  expect(saved.requirements).toHaveLength(3);
  expect(new Set(saved.requirements.map(r => r.extraction_determination_id)).size).toBe(1);
  const demands = new Set(saved.requirements.map(r => r.normalized_demand.demand_fingerprint));
  expect(demands.size).toBe(2);
  const pending = api.post(`/v1/jobs/${job.job_id}/fit/assess`, { data: { expected_revision: 0, prepare_wording: false, prepare_coverage: false } });
  const qualification = await modelCall(app, "fit.qualification-batch");
  expect(qualificationBindings(qualification).map(row => row.demand_fingerprint).sort()).toEqual([...demands].sort());
  qualification.reply(qualificationBatchDecision(qualification, () => ({ kind: "missing" })));
  expect((await pending).status()).toBe(200);
  expect(await json(api, "get", `/v1/jobs/${job.job_id}/fit`)).toMatchObject({ current: true, qualifications_current: true, score: { summary: { assessed_count: 2 } } });
  expect(app.external.calls.filter(c => c.body.operation === "requirements.extract")).toHaveLength(2);
});
