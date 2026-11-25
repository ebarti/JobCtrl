import { test, expect, json, modelCall, completed } from "../harness/fixtures.js";
import { acceptBaseline, createBaseline } from "./core-data.js";
import { captureReusePosting } from "./reuse-data.js";
import { catalogMatching, citationSelections, CITATION_BINDER_VERSION, memberRoots, PARTITION_BINDER_VERSION,
  NORMALIZATION_STORAGE_VERSION, modelSources, normalizationFingerprint, NORMALIZATION_PROMPT_VERSION,
  typedExtraction, type CatalogContext } from "./requirements-data.js";
import { acceptedPdf, authoredPartition, NORMALIZATION_VERSION, readCatalog, requirementsPath,
  type NormalizedSnapshot, type ReconciliationReport } from "./consolidation-data.js";

test("consolidation keeps original receipts across worker restart and binds new citations to retained alias sources", async ({ api, app }) => {
  const { profile } = await createBaseline(api);
  const clauses = ["Implement durable workflow recovery.", "Maintain durable workflow recovery.", "Assess durable workflow recovery."];
  const localIds = ["implementation", "maintenance", "assessment"];
  const combined = "Implement, maintain and assess durable workflow recovery.";
  const posting = await captureReusePosting(api, "retained-citation-sources", clauses.join("\n"));
  const extracting = api.post(requirementsPath(posting.job_id), { data: { expected_posting_revision: posting.revision, expected_revision: 0 } });
  const extraction = await modelCall(app, "requirements.extract");
  extraction.reply(typedExtraction(extraction, { requirements: clauses.map((text, index) => ({ localId: localIds[index]!, text, category: "skill" })) }));
  const initial = await modelCall(app, "requirements.match_catalog");
  initial.reply(authoredPartition(initial, clauses.map((text, index) => ({ groupId: localIds[index]!,
    memberIds: ["incoming:" + localIds[index]!], category: "skill", name: text, definition: text })),
  clauses.map((definition, index) => ({ groupId: localIds[index]!, definition, jobIds: [posting.job_id] }))));
  const initialResponse = await extracting;
  expect(initialResponse.status(), await initialResponse.text()).toBe(200);
  const split = await initialResponse.json() as NormalizedSnapshot;
  const oldIds = split.requirements.map((row) => row.requirement_id).sort();
  const oldPayload = { expected_catalog_revision: (await readCatalog(api)).catalog_revision };
  const key = "first-cited-consolidation";
  const admitted = await api.post("/v1/actions/requirements.consolidate", { headers: { "idempotency-key": key }, data: oldPayload });
  expect(admitted.status(), await admitted.text()).toBe(202);
  const run = await admitted.json() as { runId: string };
  const oldCall = await modelCall(app, "requirements.match_catalog");
  const oldSelection = authoredPartition(oldCall, [{ groupId: "recovery", memberIds: oldIds, category: "skill",
    name: "Workflow recovery", definition: combined }], [{ groupId: "recovery", definition: combined, jobIds: [posting.job_id] }]);
  oldCall.reply(oldSelection);
  const oldAction = await completed(api, run.runId);
  expect(oldAction["result"]).toMatchObject({ normalization_version: NORMALIZATION_VERSION,
    receipt: { prompt_version: NORMALIZATION_PROMPT_VERSION, accepted_result_fingerprint: normalizationFingerprint(oldSelection) } });
  const oldAudit = await app.requirementsReconciliation(run.runId);
  expect(oldAudit.selection).toEqual(oldSelection);
  expect(oldAudit.authority_receipt.value).toEqual(oldSelection);
  const oldCatalog = await readCatalog(api);
  const rootId = oldIds[0]!;
  const family = oldIds.filter((id) => id !== rootId).map((requirement_id) => ({ requirement_id, revision: 1 }));
  expect(oldCatalog.requirements).toMatchObject([{ requirement_id: rootId, revision: 2, definition: combined }]);
  expect(Object.keys(oldCatalog.aliases).sort()).toEqual(family.map((row) => row.requirement_id));
  const oldHistory = await json(api, "get", `/v1/requirements/${rootId}/history?kind=revisions&limit=20&offset=0`);
  const oldSnapshot = await json<NormalizedSnapshot>(api, "get", requirementsPath(posting.job_id));
  const resume = await acceptBaseline(api, posting.job_id, profile.profileVersion);
  const pdf = await acceptedPdf(api, resume.resume_id);
  const beforeRestart = app.external.calls.length;
  const replacement = await app.restartWorker();
  expect(replacement.current).not.toBe(replacement.previous);
  expect(app.external.calls).toHaveLength(beforeRestart);
  expect(await json(api, "get", "/v1/action-runs/" + run.runId)).toEqual(oldAction);
  expect(await app.requirementsReconciliation(run.runId)).toEqual(oldAudit);
  expect(await json(api, "get", `/v1/requirements/${rootId}/history?kind=revisions&limit=20&offset=0`)).toEqual(oldHistory);
  expect(await json(api, "get", requirementsPath(posting.job_id))).toEqual(oldSnapshot);
  const retained = await readCatalog(api);
  expect(retained.requirements).toEqual(oldCatalog.requirements);
  expect(retained.aliases).toEqual(oldCatalog.aliases);
  expect(retained.catalog_revision).toBe(oldCatalog.catalog_revision);
  const replay = await api.post("/v1/actions/requirements.consolidate", { headers: { "idempotency-key": key }, data: oldPayload });
  expect(replay.ok(), await replay.text()).toBe(true);
  expect(await replay.json()).toMatchObject({ runId: run.runId, status: "succeeded" });
  expect(app.external.calls).toHaveLength(beforeRestart);
  expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);

  const publishing = api.post("/v1/requirements/consolidate", { data: { expected_catalog_revision: retained.catalog_revision } });
  const current = await modelCall(app, "requirements.match_catalog");
  const input = current.body["context"] as CatalogContext;
  expect(current.body["prompt_version"]).toBe(NORMALIZATION_PROMPT_VERSION);
  const selection = catalogMatching(current, {});
  const member = input.members.find((row) => row.member_id === rootId)!;
  const familyRef = citationSelections(current, [{ sourceId: member.source_id, valuePath: ["retained_members", 0, "definition"] }])[0]!;
  memberRoots(selection)[0]!.slot.citations.push(familyRef);
  current.reply(selection);
  const published = await publishing;
  expect(published.status(), await published.text()).toBe(200);
  const report = await published.json() as ReconciliationReport;
  expect(report).toMatchObject({ normalization_version: NORMALIZATION_VERSION,
    receipt: { prompt_version: NORMALIZATION_PROMPT_VERSION, accepted_result_fingerprint: normalizationFingerprint(selection) },
    partition_binding: { binder_version: PARTITION_BINDER_VERSION, raw_selection_fingerprint: normalizationFingerprint(selection) },
    citation_binding: { binder_version: CITATION_BINDER_VERSION, selection_fingerprint: report.partition_binding.intermediate_fingerprint } });
  const recordedMember = report.citation_binding.source_context.members.find((row) => row.member_id === rootId)!;
  expect(recordedMember).toMatchObject({ source_id: familyRef.source_id, requirement_id: rootId, revision: 2, retained_members: family });
  expect(report.citation_binding.segment_catalog[familyRef.source_id]![familyRef.segment_id]).toEqual(["retained_members", 0, "definition"]);
  const source = modelSources(current).find((row) => row.source_id === member.source_id)!;
  expect(report.citation_binding.source_fingerprints[member.source_id]).toBe(normalizationFingerprint(source.text));
  const sourceDocument = JSON.parse(source.text) as { retained_members: { requirement_id: string; revision: number }[] };
  expect(recordedMember.retained_members).toEqual(sourceDocument.retained_members.map(({ requirement_id, revision }) => ({ requirement_id, revision })));
  const expectedFamilyQuote = split.requirements.find((row) => row.requirement_id === family[0]!.requirement_id)!.definition;
  const audit = await app.requirementsReconciliation(report.reconciliation_id);
  expect(audit.selection).toEqual(selection);
  expect(audit.authority_receipt.value).toEqual(selection);
  expect(audit.stored_report).toMatchObject({ storage_version: NORMALIZATION_STORAGE_VERSION, report,
    derived_decision: { capabilities: [{ citations: expect.arrayContaining([{ source_id: familyRef.source_id, quote: expectedFamilyQuote }]) }] },
    citation_binding: report.citation_binding });
  expect(normalizationFingerprint(audit.stored_report.intermediate_selection)).toBe(report.partition_binding.intermediate_fingerprint);
  expect(normalizationFingerprint(audit.stored_report.derived_decision)).toBe(report.citation_binding.derived_fingerprint);
  expect(await app.requirementsReconciliation(run.runId)).toEqual(oldAudit);
  expect(await acceptedPdf(api, resume.resume_id)).toEqual(pdf);
  expect(app.external.calls.slice(beforeRestart).map((call) => call.body["operation"])).toEqual(["requirements.match_catalog"]);
});
