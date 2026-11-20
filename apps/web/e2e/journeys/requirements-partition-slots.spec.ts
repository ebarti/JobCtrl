import { test, expect, json, modelCall } from "../harness/fixtures.js";
import { captureReusePosting } from "./reuse-data.js";
import { authoredPartition, requirementsPath, type NormalizedSnapshot, type ReconciliationReport } from "./consolidation-data.js";
import { catalogContext, NORMALIZATION_STORAGE_VERSION, PARTITION_BINDER_VERSION, normalizationFingerprint, typedExtraction,
  type CapabilityChoice, type legacyCatalogNormalizationV3 } from "./requirements-data.js";

// The same source clauses receive two opposing, explicitly authored identity
// choices in fresh workspaces. No helper decides their semantic relationship.
for (const partition of ["separate", "merged"] as const) {
  test(`required partition slots publish the explicitly authored ${partition} capability partition with every input accounted`, async ({ api, app }) => {
    const clauses = ["Design release recovery.", "Operate release recovery.", "Operate OrionDB."];
    const localIds = ["recovery-design", "recovery-operation", "database-operation"];
    const posting = await captureReusePosting(api, "required-slots", clauses.join("\n"));
    const pending = api.post(requirementsPath(posting.job_id), { data: { expected_posting_revision: posting.revision, expected_revision: 0 } });
    const extraction = await modelCall(app, "requirements.extract");
    extraction.reply(typedExtraction(extraction, { requirements: clauses.map((text, index) => ({ localId: localIds[index]!, text })) }));
    const normalization = await modelCall(app, "requirements.match_catalog");
    const context = catalogContext(normalization);
    expect(context.members.map((row) => row.member_id).sort()).toEqual(localIds.map((id) => "incoming:" + id).sort());
    expect(context.occurrences).toHaveLength(3);
    const separate: CapabilityChoice[] = clauses.map((definition, index) => ({ groupId: localIds[index]!,
      memberIds: ["incoming:" + localIds[index]!], category: "skill", name: definition, definition }));
    const groups: CapabilityChoice[] = partition === "separate" ? separate : [
      { groupId: "release-recovery", memberIds: ["incoming:recovery-design", "incoming:recovery-operation"],
        category: "skill", name: "Release recovery", definition: "Design and operate release recovery." },
      separate[2]!,
    ];
    const raw = authoredPartition(normalization, groups, groups.map((group) => ({ groupId: group.groupId,
      definition: group.definition, jobIds: [posting.job_id] })));
    expect(Object.keys(raw.member_slots).sort()).toEqual(context.members.map((row) => row.member_id).sort());
    expect(Object.keys(raw.occurrence_slots).sort()).toEqual(context.occurrences.map((row) => row.occurrence_id).sort());
    const schema = normalization.body["response_schema"] as { $defs: Record<string, { properties?: Record<string, unknown>; required?: string[]; additionalProperties?: boolean; enum?: string[] }> };
    for (const [name, inventory] of [["MemberSlots", context.members.map((row) => row.member_id)],
      ["OccurrenceSlots", context.occurrences.map((row) => row.occurrence_id)],
      ["CapabilityGroups", context.partition_group_handles.capabilities], ["DemandGroups", context.partition_group_handles.demands]] as const) {
      expect(schema.$defs[name]!.required!.slice().sort()).toEqual(inventory.slice().sort());
      expect(Object.keys(schema.$defs[name]!.properties!).sort()).toEqual(inventory.slice().sort());
      expect(schema.$defs[name]!.additionalProperties).toBe(false);
    }
    expect(schema.$defs["CapabilityGroupId"]!.enum).toEqual(context.partition_group_handles.capabilities);
    expect(schema.$defs["CapabilityGroup"]!.properties!["reuse_requirement_id"]).toMatchObject({ type: "null" });
    expect(schema.$defs["CitedOccurrence"]!.required).toEqual(["kind"]);
    expect(schema.$defs["CitedOccurrence"]!.additionalProperties).toBe(false);
    expect(Object.values(raw.occurrence_slots)).toEqual(context.occurrences.map(() => ({ kind: "cited" })));
    expect(schema.$defs["OfferedSourceId"]!.enum!.slice().sort()).toEqual(Object.keys(context.citation_segments).sort());
    expect(schema.$defs["DemandEvidenceSourceId"]!.enum!.slice().sort()).toEqual([
      context.catalog_inventory_source_id, ...context.occurrences.map((row) => row.source_id),
      ...context.posting_sources.map((row) => row.source_id),
    ].sort());
    expect(schema.$defs).not.toHaveProperty("MemberSameAs");
    expect(schema.$defs).not.toHaveProperty("OccurrenceSameAs");
    expect(Object.keys(raw.capability_groups)).toEqual(context.partition_group_handles.capabilities);
    expect(Object.keys(raw.demand_groups)).toEqual(context.partition_group_handles.demands);
    expect(Object.values(raw.capability_groups).filter((row) => row !== null)).toHaveLength(groups.length);
    expect(Object.values(raw.demand_groups).filter((row) => row !== null)).toHaveLength(groups.length);
    normalization.reply(raw);
    const response = await pending;
    expect(response.status(), await response.text()).toBe(200);
    const accepted = await response.json() as NormalizedSnapshot;
    expect(accepted.requirements).toHaveLength(3);
    expect(new Set(accepted.requirements.map((row) => row.requirement_id)).size).toBe(groups.length);
    expect(accepted.requirements[0]!.requirement_id === accepted.requirements[1]!.requirement_id).toBe(partition === "merged");
    expect(accepted.requirements[2]!.requirement_id).not.toBe(accepted.requirements[0]!.requirement_id);
    const reconciliationId = accepted.requirements[0]!.normalized_demand.provenance.reconciliation_id;
    const audit = await app.requirementsReconciliation(reconciliationId);
    const report = audit.stored_report.report as ReconciliationReport;
    const intermediate = audit.stored_report.intermediate_selection as ReturnType<typeof legacyCatalogNormalizationV3>;
    expect(audit.selection).toEqual(raw);
    expect(audit.authority_receipt.value).toEqual(raw);
    expect(audit.stored_report.storage_version).toBe(NORMALIZATION_STORAGE_VERSION);
    expect(report).toMatchObject({ input_member_count: 3, root_count: groups.length,
      receipt: { accepted_result_fingerprint: normalizationFingerprint(raw) },
      partition_binding: { binder_version: PARTITION_BINDER_VERSION, raw_selection_fingerprint: normalizationFingerprint(raw),
        intermediate_fingerprint: normalizationFingerprint(intermediate) },
      citation_binding: { selection_fingerprint: normalizationFingerprint(intermediate),
        derived_fingerprint: normalizationFingerprint(audit.stored_report.derived_decision) } });
    expect(intermediate).toMatchObject({ status: "complete", catalog_revision: context.catalog_revision, corrections: [], unresolved: [] });
    expect(intermediate.capabilities).toHaveLength(groups.length);
    expect(intermediate.demands).toHaveLength(groups.length);
    expect(Object.keys(report.partition_binding.member_groups).sort()).toEqual(context.members.map((row) => row.member_id).sort());
    expect(Object.keys(report.partition_binding.occurrence_groups).sort()).toEqual(context.occurrences.map((row) => row.occurrence_id).sort());
    expect(new Set(Object.values(report.partition_binding.member_groups)).size).toBe(groups.length);
    for (const group of groups) {
      const projected = intermediate.capabilities.find((row) => row.member_ids.includes(group.memberIds[0]!))!;
      expect(projected.member_ids.slice().sort()).toEqual(group.memberIds.slice().sort());
      expect(projected).toMatchObject({ category: group.category, name: group.name, definition: group.definition });
      expect(report.partition_binding.member_groups[group.memberIds[0]!]).toBe(projected.group_id);
      const demand = intermediate.demands.find((row) => row.group_id === projected.group_id)!;
      expect(demand.definition).toBe(group.definition);
      expect(demand.bindings).toEqual([{ job_id: posting.job_id, occurrence_ids: context.occurrences
        .filter((row) => group.memberIds.includes(row.member_id)).map((row) => row.occurrence_id) }]);
    }
    expect(await json(api, "get", requirementsPath(posting.job_id))).toEqual(accepted);
    expect(await app.requirementsReconciliation(reconciliationId)).toEqual(audit);
    expect(app.external.calls.map((call) => call.body["operation"])).toEqual(["requirements.extract", "requirements.match_catalog"]);
  });
}
