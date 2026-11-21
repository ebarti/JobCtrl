import { test, expect, json, modelCall } from "../harness/fixtures.js";
import { captureReusePosting } from "./reuse-data.js";
import { catalogContext, catalogMatching, citationSelections, occurrenceRoots, typedExtraction } from "./requirements-data.js";
import { readCatalog, requirementsPath, type NormalizedSnapshot } from "./consolidation-data.js";

test("demand evidence excludes offered prior definitions while exact reuse and cross-job bindings remain valid", async ({ api, app }) => {
  const definition = "Operate release recovery safely.";
  const first = await captureReusePosting(api, "citation-role-first", definition);
  const firstPending = api.post(requirementsPath(first.job_id), { data: { expected_posting_revision: first.revision, expected_revision: 0 } });
  const extracting = await modelCall(app, "requirements.extract");
  extracting.reply(typedExtraction(extracting, { requirements: [{ localId: "recovery", text: definition }] }));
  const matching = await modelCall(app, "requirements.match_catalog");
  matching.reply(catalogMatching(matching, { recovery: { verdict: "new" } }));
  const acceptedResponse = await firstPending;
  expect(acceptedResponse.status(), await acceptedResponse.text()).toBe(200);
  const firstAccepted = await acceptedResponse.json() as NormalizedSnapshot;
  const requirement = firstAccepted.requirements[0]!;
  const fingerprint = requirement.normalized_demand.demand_fingerprint;
  const catalogBefore = await readCatalog(api);
  const firstAudit = await app.requirementsReconciliation(requirement.normalized_demand.provenance.reconciliation_id);

  const second = await captureReusePosting(api, "citation-role-second", definition + "\nMaintain release readiness.");
  const payload = { expected_posting_revision: second.revision, expected_revision: 0 };
  const callsBefore = app.external.calls.length;
  const refusing = api.post(requirementsPath(second.job_id), { data: payload });
  const secondExtraction = await modelCall(app, "requirements.extract");
  secondExtraction.reply(typedExtraction(secondExtraction, { requirements: [{ localId: "peer", text: definition }] }));
  const invalidCall = await modelCall(app, "requirements.match_catalog");
  const context = catalogContext(invalidCall);
  const prior = context.accepted_demands.find((row) => row.demand_fingerprint === fingerprint)!;
  expect(prior).toBeTruthy();
  const schema = invalidCall.body["response_schema"] as { $defs: Record<string, { enum?: string[]; properties?: Record<string, unknown> }> };
  const eligiblePostings = context.posting_sources.filter((posting) => context.occurrences.some((occurrence) =>
    occurrence.job_id === posting.job_id && occurrence.posting_revision === posting.revision && occurrence.posting_hash === posting.source_hash));
  const allowed = [context.catalog_inventory_source_id, ...context.occurrences.map((row) => row.source_id), ...eligiblePostings.map((row) => row.source_id)];
  expect(schema.$defs["DemandEvidenceSourceId"]!.enum!.slice().sort()).toEqual([...new Set(allowed)].sort());
  expect(schema.$defs["DemandEvidenceSourceId"]!.enum).not.toContain(prior.source_id);
  expect(schema.$defs["OfferedSourceId"]!.enum!.slice().sort()).toEqual(Object.keys(context.citation_segments).sort());
  expect(schema.$defs["OfferedSourceId"]!.enum).toContain(prior.source_id);
  expect(schema.$defs["DemandEvidenceCitation"]!.properties).toMatchObject({ segment_id: { type: "string", minLength: 1, maxLength: 120 } });
  const authored = catalogMatching(invalidCall, { peer: { verdict: "equivalent", requirementId: requirement.requirement_id, demandDefinition: definition } });
  const demand = occurrenceRoots(authored)[0]!.slot;
  expect(demand.kind).toBe("keep");
  // This is an offered, exact prior definition, not an invented source or a
  // mislabeled quote. Its role is reuse context, not original demand evidence.
  demand.citations.push(...citationSelections(invalidCall, [{ sourceId: prior.source_id, valuePath: ["definition"] }]));
  invalidCall.reply(authored);
  const refused = await refusing;
  expect(refused.status(), await refused.text()).toBe(502);
  expect(await refused.json()).toMatchObject({ error: { code: "model_schema_violation" } });
  expect(await json(api, "get", requirementsPath(first.job_id))).toEqual(firstAccepted);
  expect(await json(api, "get", requirementsPath(second.job_id))).toBeNull();
  expect(await readCatalog(api)).toEqual(catalogBefore);
  expect(await app.requirementsReconciliation(requirement.normalized_demand.provenance.reconciliation_id)).toEqual(firstAudit);
  expect(app.external.calls.slice(callsBefore).map((call) => call.body["operation"])).toEqual(["requirements.extract", "requirements.match_catalog"]);

  // An explicit new public operation reuses the accepted extraction. The same
  // authored meaning/reuse reference succeeds with original source evidence.
  const publishing = api.post(requirementsPath(second.job_id), { data: payload });
  const validCall = await modelCall(app, "requirements.match_catalog");
  const valid = catalogMatching(validCall, { peer: { verdict: "equivalent", requirementId: requirement.requirement_id, demandDefinition: definition } });
  expect(occurrenceRoots(valid)[0]!.slot.kind).toBe("keep");
  validCall.reply(valid);
  const published = await publishing;
  expect(published.status(), await published.text()).toBe(200);
  const accepted = await published.json() as NormalizedSnapshot;
  expect(accepted.requirements[0]).toMatchObject({ requirement_id: requirement.requirement_id,
    normalized_demand: { definition, demand_fingerprint: fingerprint } });
  const audit = await app.requirementsReconciliation(accepted.requirements[0]!.normalized_demand.provenance.reconciliation_id);
  const projection = audit.stored_report.intermediate_selection as { demands: { bindings: { job_id: string }[] }[] };
  expect(projection.demands).toHaveLength(1);
  expect(projection.demands[0]!.bindings.map((row) => row.job_id).sort()).toEqual([first.job_id, second.job_id].sort());
  expect(audit.selection).toEqual(valid);
  expect(audit.authority_receipt.value).toEqual(valid);
  expect(app.external.calls.slice(callsBefore).map((call) => call.body["operation"])).toEqual([
    "requirements.extract", "requirements.match_catalog", "requirements.match_catalog",
  ]);
});
