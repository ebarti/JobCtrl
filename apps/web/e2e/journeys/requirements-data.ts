import { createHash } from "node:crypto";
import { expect, type ExternalCall } from "../harness/fixtures.js";

export type ModelSource = { source_id: string; text: string };
export const EXTRACTION_PROMPT_VERSION = "requirements-v2-extract-v8-independent-demands";
export const V6_NORMALIZATION_PROMPT_VERSION = "requirements-capability-demand-partition-v6";
export const NORMALIZATION_PROMPT_VERSION = V6_NORMALIZATION_PROMPT_VERSION + "-background-v1";
export const SOURCE_DICTIONARY_PROMPT_VERSION = "requirements-capability-demand-partition-v8-sources";
export const V9_NORMALIZATION_PROMPT_VERSION = "requirements-capability-demand-partition-v9-tables";
export const V9_BACKGROUND_NORMALIZATION_PROMPT_VERSION = V9_NORMALIZATION_PROMPT_VERSION + "-background-v1";
export const V10_NORMALIZATION_PROMPT_VERSION = "requirements-capability-demand-partition-v10-demand-choices";
export const REFRESH_NORMALIZATION_PROMPT_VERSION = "requirements-capability-demand-partition-v11-cited-occurrences";
const v7CohortPrompt = "requirements-capability-demand-partition-v7-cohort";
export const COHORT_NORMALIZATION_PROMPT_VERSION = v7CohortPrompt + "-background-v1";
export const PARTITION_V5_PROMPT_VERSION = "requirements-capability-demand-partition-v5";
export const PARTITION_V4_PROMPT_VERSION = "requirements-capability-demand-partition-v4";
export const CITATION_SELECTION_PROMPT_VERSION = "requirements-capability-demand-citation-v3";
export const LEGACY_NORMALIZATION_PROMPT_VERSION = "requirements-capability-demand-v2";
export const CITATION_BINDER_VERSION = "requirements-citation-binding-v1";
export const PARTITION_BINDER_VERSION = "requirements-partition-binding-v2";
export const NORMALIZATION_STORAGE_VERSION = "requirements-normalization-binding-v3";
export const modelSources = (call: ExternalCall) =>
  call.body["sources"] as ModelSource[];

export type ReusableDemand = {
  localId: string;
  text: string;
  name?: string;
  definition?: string;
  category?: "skill" | "professional_experience";
  basis?: "explicit" | "inferred" | "explicit_and_inferred";
  rationale?: string | null;
  sourceNote?: string | null;
};
type EducationDemand = {
  text: string;
  qualification: string;
  subjects?: string[];
  alternative?: string | null;
};
type LanguageDemand = { text: string; language: string; proficiency?: string | null };

/** Authored decisions for this live external request. Literal quote binding is
 * shared plumbing; the caller supplies every meaning and language judgment. */
export function typedExtraction(
  call: ExternalCall,
  {
    requirements = [],
    education = [],
    languages = [],
    classification = "english",
    status = "complete",
  }: {
    requirements?: ReusableDemand[];
    education?: EducationDemand[];
    languages?: LanguageDemand[];
    classification?: "english" | "non_english" | "uncertain";
    status?: "complete" | "needs_review" | "unsupported_language";
  },
) {
  const source = modelSources(call)[0]!;
  const quotes: { evidence_id: string; source_id: string; quote: string }[] = [];
  const refs = (quote: string) => {
    let selected = quotes.find((row) => row.quote === quote);
    if (!selected) {
      selected = { evidence_id: `quote-${quotes.length + 1}`, source_id: source.source_id, quote };
      quotes.push(selected);
    }
    return [selected.evidence_id];
  };
  const reusable = requirements.map((row) => ({
    local_id: row.localId,
    category: row.category ?? "professional_experience",
    name: row.name ?? row.text,
    definition: row.definition ?? row.text,
    basis: row.basis ?? "explicit",
    rationale: row.rationale ?? null,
    source_note: row.sourceNote ?? null,
    evidence_refs: refs(row.text),
  }));
  const directEducation = education.map((row) => ({
    qualification: row.qualification,
    subjects: row.subjects ?? [],
    alternative: row.alternative ?? null,
    source_note: null,
    evidence_refs: refs(row.text),
  }));
  const directLanguages = languages.map((row) => ({
    language: row.language,
    proficiency: row.proficiency ?? null,
    source_note: null,
    evidence_refs: refs(row.text),
  }));
  const languageRefs = quotes.length ? [quotes[0]!.evidence_id] : refs(source.text);
  return {
    status,
    language: { classification, reason: "Explicit source-bound language determination for this synthetic posting.", evidence_refs: languageRefs },
    quotes,
    requirements: reusable,
    education: directEducation,
    languages: directLanguages,
    unresolved: [],
  };
}

export function citeSources(call: ExternalCall, sourceIds: string[]) {
  return sourceIds.map((sourceId) => {
    const source = modelSources(call).find((row) => row.source_id === sourceId);
    expect(
      source,
      `The actual model request contains source ${sourceId}`,
    ).toBeTruthy();
    return { source_id: sourceId, quote: source!.text.slice(0, 160) };
  });
}

type CitationSegment = (string | number)[] | {
  source_format?: "json_string" | "serialized"; value_path: (string | number)[];
  start: number; end: number; preview?: string };
export type CatalogContext = {
  partition_group_handles: { capabilities: string[]; demands: string[] };
  catalog_revision: number;
  catalog_inventory_source_id: string;
  posting?: { model_source_id: string };
  posting_content?: { source_id: string };
  incoming: { local_id: string; model_source_id: string; occurrence_id: string; job_id: string; member_id: string }[];
  candidates: { requirement_id: string; revision: number }[];
  members: { member_id: string; source_id: string; requirement_id: string | null; revision: number | null }[];
  occurrences: { job_id: string; occurrence_id: string; member_id: string; source_id: string; posting_revision: number; posting_hash: string;
    requirement_id: string; requirement_revision: number; source_kind: "proposed" | "accepted_snapshot";
    snapshot_revision: number | null; base_snapshot_revision: number; prior_demand_source_id?: string | null; correction_determination_id: string | null;
    previous_occurrence_id: string | null; resolution_determination_ids: string[] }[];
  accepted_demands: { definition?: string; group_member_ids: string[]; source_id: string; demand_fingerprint: string; normalization_version: string }[];
  accepted_occurrence_counts: Record<string, number>;
  posting_sources: { job_id: string; revision: number; source_hash: string; source_id: string }[];
  citation_segments: Record<string, Record<string, CitationSegment | string>>;
  cohort_texts?: Record<string, string>;
  cohort_segment_paths?: Record<string, CitationSegment>;
  expanded_context_fingerprint?: string;
  citation_catalog_fingerprint: string;
  citation_source_fingerprints: Record<string, string>;
  citation_source_context_fingerprint: string;
  source_snapshot_heads: { job_id: string; revision: number; posting_revision: number; posting_hash: string;
    contract_version?: string; snapshot_fingerprint?: string }[];
};

export type CitationSelection = { source_id: string; segment_id: string };
type CitationReference = { sourceId: string; valuePath?: (string | number)[] };

const citationCatalogs = new WeakMap<ExternalCall, {
  segments: Record<string, Record<string, CitationSegment>>;
  sourceIds: ReadonlySet<string>;
}>();

function offeredCitations(call: ExternalCall) {
  const cached = citationCatalogs.get(call);
  if (cached) return cached;
  const context = catalogContext(call);
  const segments = Object.fromEntries(Object.entries(context.citation_segments).map(([sourceId, catalog]) => [sourceId,
    Object.fromEntries(Object.entries(catalog).map(([segmentId, descriptor]) => {
      if (typeof descriptor !== "string") return [segmentId, descriptor];
      const expanded = context.cohort_segment_paths?.[descriptor];
      expect(expanded, `The supplied segment handle ${descriptor} has an exact descriptor`).toBeTruthy();
      return [segmentId, expanded!];
    }))]));
  expect(context.citation_catalog_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(normalizationFingerprint(segments)).toBe(context.citation_catalog_fingerprint);
  if (context.cohort_texts) {
    const expanded = { ...context, citation_segments: segments };
    delete expanded.cohort_texts;
    delete expanded.cohort_segment_paths;
    delete expanded.expanded_context_fingerprint;
    expect(normalizationFingerprint(expanded)).toBe(context.expanded_context_fingerprint);
  }
  const catalog = { segments, sourceIds: new Set(modelSources(call).map(source => source.source_id)) };
  citationCatalogs.set(call, catalog);
  return catalog;
}

/** Select only owner-supplied references at explicitly authored DTO paths.
 * The helper neither invents quote text/ranges nor searches prose for meaning. */
export function citationSelections(call: ExternalCall, references: CitationReference[]): CitationSelection[] {
  const { segments, sourceIds } = offeredCitations(call);
  return references.map(({ sourceId, valuePath }) => {
    const offered = Object.entries(segments[sourceId] ?? {}).filter(([, segment]) =>
      valuePath === undefined || JSON.stringify(Array.isArray(segment) ? segment : segment.value_path) === JSON.stringify(valuePath));
    expect(offered, "Select one explicitly provided source field reference").toHaveLength(1);
    expect(sourceIds.has(sourceId)).toBe(true);
    return { source_id: sourceId, segment_id: offered[0]![0] };
  });
}

const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalValue(item)])) : value;
export const normalizationFingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");

type CatalogTables = { row_fields: string[][]; strings: string[]; segment_layouts: number[][]; segment_paths: CitationSegment[];
  expanded_context_fingerprint: string };
const tableRequests = new WeakMap<ExternalCall, { context: CatalogContext; sources: Map<string, unknown> }>();

/** Decode only the live wire's explicit row/column and source/segment joins. */
function tableRequest(call: ExternalCall) {
  const prior = tableRequests.get(call);
  if (prior) return prior;
  const { catalog_tables: tables, citation_segments: offers, ...header } = call.body["context"] as
    Record<string, unknown> & { catalog_tables: CatalogTables; citation_segments: Record<string, [number, string]> };
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      const first = value[0];
      if (typeof first === "string" && /^~r\d+$/.test(first)) {
        const fields = tables.row_fields[Number(first.slice(2))]!;
        if (value.length !== fields.length + 1) throw new Error("Incomplete catalog row");
        return Object.fromEntries(fields.map((name, i) => [name, decode(value[i + 1])]));
      }
      return value.map(decode);
    }
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, field]) => [key, decode(field)]));
    }
    if (typeof value === "string" && value.startsWith("~~")) return value.slice(1);
    if (typeof value === "string" && /^~\d+$/.test(value)) return tables.strings[Number(value.slice(1))];
    return value;
  };
  const sources = new Map(modelSources(call).map(row => [row.source_id, decode(JSON.parse(row.text))]));
  const context = Object.fromEntries(Object.entries(header).map(([key, value]) =>
    [key, value !== null && typeof value === "object" ? decode(value) : value])) as CatalogContext;
  context.citation_segments = Object.fromEntries(Object.entries(offers).map(([source, [layout, identifiers]]) => {
    const paths = tables.segment_layouts[layout]!;
    const ids = identifiers.split(" ");
    if (ids.length !== paths.length) throw new Error("Incomplete citation layout");
    return [source, Object.fromEntries(ids.map((id, i) => [id, tables.segment_paths[paths[i]!]!]))];
  }));
  context.citation_source_fingerprints = Object.fromEntries([...sources].map(([key, value]) =>
    [key, normalizationFingerprint(JSON.stringify(canonicalValue(value)))]));
  expect(normalizationFingerprint(context)).toBe(tables.expanded_context_fingerprint);
  expect(normalizationFingerprint(context.citation_segments)).toBe(context.citation_catalog_fingerprint);
  const result = { context, sources };
  tableRequests.set(call, result);
  return result;
}

export function catalogContext(call: ExternalCall): CatalogContext {
  return [V9_NORMALIZATION_PROMPT_VERSION, V9_BACKGROUND_NORMALIZATION_PROMPT_VERSION, V10_NORMALIZATION_PROMPT_VERSION, REFRESH_NORMALIZATION_PROMPT_VERSION].includes(String(call.body["prompt_version"]))
    ? tableRequest(call).context : call.body["context"] as CatalogContext;
}

type CatalogMeaning = { category: "skill" | "professional_experience"; name: string; definition: string };
type OccurrenceEvidence = Omit<CatalogContext["occurrences"][number],
  "correction_determination_id" | "previous_occurrence_id" | "resolution_determination_ids"> & {
  original: CatalogMeaning & { spans: { quote: string }[] };
  canonical: CatalogMeaning;
  normalized_demand: { normalization_version: string; demand_fingerprint: string } | null;
};

/** The current wire carries structural references. Meanings are read from the
 * referenced live source DTOs, never reconstructed from names or identifiers. */
export function catalogSource<T>(call: ExternalCall, sourceId: string): T {
  if ([V9_NORMALIZATION_PROMPT_VERSION, V9_BACKGROUND_NORMALIZATION_PROMPT_VERSION, V10_NORMALIZATION_PROMPT_VERSION, REFRESH_NORMALIZATION_PROMPT_VERSION].includes(String(call.body["prompt_version"]))) {
    const { sources } = tableRequest(call);
    expect(sources.has(sourceId)).toBe(true);
    return sources.get(sourceId) as T;
  }
  const source = modelSources(call).find((row) => row.source_id === sourceId);
  expect(source, `The actual request owns source ${sourceId}`).toBeTruthy();
  const context = catalogContext(call);
  const expand = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(expand);
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      if (Object.keys(record).length === 1 && typeof record["$text"] === "string") {
        const text = context.cohort_texts?.[record["$text"]];
        expect(typeof text, "A cohort text reference must resolve in the actual request").toBe("string");
        return text;
      }
      return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, expand(entry)]));
    }
    return value;
  };
  const value = expand(JSON.parse(source!.text));
  if (context.cohort_texts) {
    const expandedText = JSON.stringify(canonicalValue(value));
    expect(normalizationFingerprint(expandedText)).toBe(context.citation_source_fingerprints[sourceId]);
  }
  return value as T;
}

export function catalogMemberMeaning(call: ExternalCall, memberId: string): CatalogMeaning {
  const member = catalogContext(call).members.find((row) => row.member_id === memberId);
  expect(member).toBeTruthy();
  let meaning: CatalogMeaning;
  if (member!.requirement_id === null) {
    meaning = catalogSource<CatalogMeaning>(call, member!.source_id);
  } else {
    const source = catalogSource<{ canonical: CatalogMeaning & { requirement_id: string; revision: number } }>(call, member!.source_id);
    expect(source.canonical).toMatchObject({ requirement_id: member!.requirement_id, revision: member!.revision });
    meaning = source.canonical;
  }
  expect(["skill", "professional_experience"]).toContain(meaning.category);
  expect(typeof meaning.name).toBe("string");
  expect(typeof meaning.definition).toBe("string");
  return meaning;
}

export function catalogOccurrenceEvidence(call: ExternalCall, occurrenceId: string): OccurrenceEvidence {
  const occurrence = catalogContext(call).occurrences.find((row) => row.occurrence_id === occurrenceId);
  expect(occurrence).toBeTruthy();
  const source = catalogSource<OccurrenceEvidence>(call, occurrence!.source_id);
  // These lineage fields belong to context and its persisted source_context;
  // the source document carries the remaining shared identity/evidence pins.
  const { correction_determination_id, previous_occurrence_id, resolution_determination_ids, prior_demand_source_id, ...sourcePins } = occurrence!;
  if ([V10_NORMALIZATION_PROMPT_VERSION, REFRESH_NORMALIZATION_PROMPT_VERSION].includes(String(call.body["prompt_version"]))) {
    const prior = catalogContext(call).accepted_demands.find(row => row.demand_fingerprint === source.normalized_demand?.demand_fingerprint);
    expect(prior_demand_source_id).toBe(prior?.source_id ?? null);
  }
  expect(source).toMatchObject(sourcePins);
  return source;
}

function catalogAcceptedDemand(call: ExternalCall, fingerprint: string) {
  const demand = catalogContext(call).accepted_demands.find((row) => row.demand_fingerprint === fingerprint);
  expect(demand).toBeTruthy();
  const source = catalogSource<{ definition: string; demand_fingerprint: string; normalization_version: string }>(call, demand!.source_id);
  expect(source).toMatchObject({ demand_fingerprint: fingerprint, normalization_version: demand!.normalization_version });
  expect(typeof source.definition).toBe("string");
  return source;
}

export type CatalogChoice = (
  | { verdict: "new" | "uncertain" }
  | { verdict: "equivalent"; requirementId: string }
  | { verdict: "equivalent"; incomingLocalId: string }
) & { demandDefinition?: string };

export type CapabilityChoice = {
  groupId: string; memberIds: string[]; category: "skill" | "professional_experience";
  name: string; definition: string; reuseRequirementId?: string | null;
};
export type DemandChoice = {
  groupId: string; definition: string; reuseDemandFingerprint?: string | null;
  bindings: { jobId: string; occurrenceIds: string[] }[];
};
type NormalizationCorrection<Citation> = { member_id: string; retained_group_id: string; unsupported_claim: string;
  represented_by_group_id: string; reason: string; citations: Citation[] };
export type CorrectionWitness = { member_id: string; represented_by_member_id: string; unsupported_claim: string;
  reason: string; citations: CitationSelection[] };
export type BoundCorrectionWitness = NormalizationCorrection<ReturnType<typeof citeSources>[number]>;
export type MemberRootSlot = { kind: "group"; category: "skill" | "professional_experience"; name: string;
  definition: string; reuse_requirement_id: string | null; reason: string; citations: CitationSelection[] };
export type OccurrenceRootSlot = { kind: "group"; definition: string; reuse_demand_fingerprint: string | null; citations: CitationSelection[] };
export type DemandChoiceSlot = (
  | { kind: "keep"; citations: CitationSelection[] }
  | { kind: "select"; prior_demand_source_id: string; citations: CitationSelection[] }
  | { kind: "author"; definition: string; citations: CitationSelection[] }
) & { reuse_demand_fingerprint?: never };
type UnresolvedSlot = { kind: "unresolved"; reason: string; citations: CitationSelection[] };
export type MemberSlot = { kind: "assigned"; capability_group_id: string } | UnresolvedSlot;
export type OccurrenceSlot = { kind: "assigned"; demand_group_id: string } | { kind: "cited" } | UnresolvedSlot;
export type CatalogSlots = { status: "complete" | "needs_review"; catalog_revision: number;
  member_slots: Record<string, MemberSlot>; occurrence_slots: Record<string, OccurrenceSlot>;
  capability_groups: Record<string, MemberRootSlot | null>; demand_groups: Record<string, OccurrenceRootSlot | DemandChoiceSlot | null>;
  corrections: CorrectionWitness[] };
export const memberRoots = (value: CatalogSlots) => Object.entries(value.capability_groups).flatMap(([groupId, slot]) =>
  slot === null ? [] : [{ groupId, memberId: Object.entries(value.member_slots).find(([, assignment]) =>
    assignment.kind === "assigned" && assignment.capability_group_id === groupId)![0], slot }]);
export const occurrenceRoots = (value: CatalogSlots) => Object.entries(value.demand_groups).flatMap(([groupId, slot]) =>
  slot === null ? [] : [{ groupId, slot }]);

/** Authors supply the complete semantic partition. Only live IDs, supplied
 * independent handles and verbatim citation selections are joined here. */
export function catalogNormalization(call: ExternalCall, capabilities: CapabilityChoice[], demands: DemandChoice[]): CatalogSlots {
  const prompt = call.body["prompt_version"];
  if (typeof prompt !== "string" || ![V6_NORMALIZATION_PROMPT_VERSION, NORMALIZATION_PROMPT_VERSION,
    V9_NORMALIZATION_PROMPT_VERSION, V9_BACKGROUND_NORMALIZATION_PROMPT_VERSION, V10_NORMALIZATION_PROMPT_VERSION, REFRESH_NORMALIZATION_PROMPT_VERSION, SOURCE_DICTIONARY_PROMPT_VERSION,
    v7CohortPrompt, COHORT_NORMALIZATION_PROMPT_VERSION].includes(prompt)) throw new Error("Unexpected catalog partition version");
  return normalizationSlots(call, capabilities, demands, prompt);
}

/** Exact v5 transport while an actual pinned predecessor is running. */
export function legacyCatalogNormalizationV5(call: ExternalCall, capabilities: CapabilityChoice[], demands: DemandChoice[]): CatalogSlots {
  return normalizationSlots(call, capabilities, demands, PARTITION_V5_PROMPT_VERSION);
}

function normalizationSlots(call: ExternalCall, capabilities: CapabilityChoice[], demands: DemandChoice[], prompt: string): CatalogSlots {
  expect(call.body["operation"]).toBe("requirements.match_catalog");
  expect(call.body["prompt_version"]).toBe(prompt);
  const context = catalogContext(call);
  const handles = context.partition_group_handles;
  expect(handles.capabilities).toHaveLength(context.members.length);
  expect(handles.demands).toHaveLength(context.occurrences.length);
  const authored = normalizationResponse(call, capabilities, demands, (references) => citationSelections(call, references));
  const member_slots: CatalogSlots["member_slots"] = {};
  const capability_groups: CatalogSlots["capability_groups"] = Object.fromEntries(handles.capabilities.map((id) => [id, null]));
  authored.capabilities.forEach((group, index) => {
    const groupId = handles.capabilities[index]!;
    capability_groups[groupId] = { kind: "group", category: group.category, name: group.name, definition: group.definition,
      reuse_requirement_id: group.reuse_requirement_id, reason: group.reason, citations: group.citations };
    for (const memberId of group.member_ids) member_slots[memberId] = { kind: "assigned", capability_group_id: groupId };
  });
  const occurrence_slots: CatalogSlots["occurrence_slots"] = {};
  const demand_groups: CatalogSlots["demand_groups"] = Object.fromEntries(handles.demands.map((id) => [id, null]));
  authored.demands.forEach((demand, index) => {
    const groupId = handles.demands[index]!;
    if (![V10_NORMALIZATION_PROMPT_VERSION, REFRESH_NORMALIZATION_PROMPT_VERSION].includes(prompt)) {
      demand_groups[groupId] = { kind: "group", definition: demand.definition,
        reuse_demand_fingerprint: demand.reuse_demand_fingerprint, citations: demand.citations };
    } else if (demand.reuse_demand_fingerprint === null) {
      demand_groups[groupId] = { kind: "author", definition: demand.definition, citations: demand.citations };
    } else {
      const previous = context.accepted_demands.find(row => row.demand_fingerprint === demand.reuse_demand_fingerprint)!;
      expect(previous.definition).toBe(demand.definition);
      const occurrences = new Set(demand.bindings.flatMap(binding => binding.occurrence_ids));
      const prior = new Set(context.occurrences.filter(row => occurrences.has(row.occurrence_id) && row.prior_demand_source_id)
        .map(row => row.prior_demand_source_id));
      demand_groups[groupId] = prior.size === 1 && prior.has(previous.source_id)
        ? { kind: "keep", citations: demand.citations }
        : { kind: "select", prior_demand_source_id: previous.source_id, citations: demand.citations };
    }
    for (const occurrenceId of demand.bindings.flatMap((binding) => binding.occurrence_ids))
      occurrence_slots[occurrenceId] = prompt === REFRESH_NORMALIZATION_PROMPT_VERSION ? { kind: "cited" } : { kind: "assigned", demand_group_id: groupId };
  });
  return { status: "complete", catalog_revision: authored.catalog_revision, member_slots, occurrence_slots,
    capability_groups, demand_groups, corrections: [] };
}

/** Exact graph wire, used only while the pinned v4 predecessor is running. */
export function legacyCatalogNormalizationV4(call: ExternalCall, capabilities: CapabilityChoice[], demands: DemandChoice[]) {
  expect(call.body["operation"]).toBe("requirements.match_catalog");
  expect(call.body["prompt_version"]).toBe(PARTITION_V4_PROMPT_VERSION);
  const authored = normalizationResponse(call, capabilities, demands, (references) => citationSelections(call, references));
  const member_slots: Record<string, { kind: "root" } & Omit<MemberRootSlot, "kind"> | { kind: "same_as"; member_id: string }> = {};
  for (const group of authored.capabilities) {
    const representative = group.member_ids[0]!;
    expect(representative).toBeTruthy();
    for (const memberId of group.member_ids) member_slots[memberId] = memberId === representative
      ? { kind: "root", category: group.category, name: group.name, definition: group.definition,
        reuse_requirement_id: group.reuse_requirement_id, reason: group.reason, citations: group.citations }
      : { kind: "same_as", member_id: representative };
  }
  const occurrence_slots: Record<string, { kind: "root" } & Omit<OccurrenceRootSlot, "kind"> | { kind: "same_as"; occurrence_id: string }> = {};
  for (const demand of authored.demands) {
    const occurrences = demand.bindings.flatMap((binding) => binding.occurrence_ids);
    const representative = occurrences[0]!;
    expect(representative).toBeTruthy();
    for (const occurrenceId of occurrences) occurrence_slots[occurrenceId] = occurrenceId === representative
      ? { kind: "root", definition: demand.definition, reuse_demand_fingerprint: demand.reuse_demand_fingerprint, citations: demand.citations }
      : { kind: "same_as", occurrence_id: representative };
  }
  return { status: "complete", catalog_revision: authored.catalog_revision, member_slots, occurrence_slots, corrections: [] };
}

/** Explicit v3 transport used only before an actual pinned source upgrade. */
export function legacyCatalogNormalizationV3(call: ExternalCall, capabilities: CapabilityChoice[], demands: DemandChoice[]) {
  expect(call.body["operation"]).toBe("requirements.match_catalog");
  expect(call.body["prompt_version"]).toBe(CITATION_SELECTION_PROMPT_VERSION);
  return normalizationResponse(call, capabilities, demands, (references) => citationSelections(call, references));
}

/** Exact predecessor contract, used only before an actual source upgrade. */
export function legacyCatalogNormalizationV2(call: ExternalCall, capabilities: CapabilityChoice[], demands: DemandChoice[]) {
  expect(call.body["operation"]).toBe("requirements.match_catalog");
  expect(call.body["prompt_version"]).toBe(LEGACY_NORMALIZATION_PROMPT_VERSION);
  return normalizationResponse(call, capabilities, demands, (references) => citeSources(call, references.map((row) => row.sourceId)));
}

function normalizationResponse<Citation>(call: ExternalCall, capabilities: CapabilityChoice[], demands: DemandChoice[],
  citations: (references: CitationReference[]) => Citation[]) {
  const context = catalogContext(call);
  const members = capabilities.flatMap((group) => group.memberIds);
  expect(members.length).toBe(new Set(members).size);
  expect([...members].sort()).toEqual(context.members.map((row) => row.member_id).sort());
  const occurrences = demands.flatMap((demand) => demand.bindings.flatMap((binding) => binding.occurrenceIds));
  expect(occurrences.length).toBe(new Set(occurrences).size);
  expect([...occurrences].sort()).toEqual(context.occurrences.map((row) => row.occurrence_id).sort());
  return {
    status: "complete",
    catalog_revision: context.catalog_revision,
    capabilities: capabilities.map((group) => ({
      group_id: group.groupId, member_ids: group.memberIds, category: group.category,
      name: group.name, definition: group.definition, reuse_requirement_id: group.reuseRequirementId ?? null,
      reason: "Explicit capability identity choice for this synthetic journey.",
      citations: citations([{ sourceId: context.catalog_inventory_source_id }, ...group.memberIds.map((id) => {
        const member = context.members.find((row) => row.member_id === id);
        expect(member, "Every authored member belongs to the complete live catalog input").toBeTruthy();
        return { sourceId: member!.source_id, valuePath: member!.requirement_id === null ? ["definition"] : ["canonical", "definition"] };
      })]),
    })),
    demands: demands.map((demand) => ({
      group_id: demand.groupId, definition: demand.definition, reuse_demand_fingerprint: demand.reuseDemandFingerprint ?? null,
      bindings: demand.bindings.map((binding) => ({ job_id: binding.jobId, occurrence_ids: binding.occurrenceIds })),
      citations: citations([{ sourceId: context.catalog_inventory_source_id }, ...demand.bindings.flatMap((binding) => binding.occurrenceIds.map((id) => {
        const occurrence = context.occurrences.find((row) => row.occurrence_id === id);
        expect(occurrence?.job_id).toBe(binding.jobId);
        return { sourceId: occurrence!.source_id, valuePath: ["original", "spans", 0, "quote"] };
      }))]),
    })),
    corrections: [] as NormalizationCorrection<Citation>[],
    unresolved: [] as { member_ids: string[]; reason: string; citations: Citation[] }[],
  };
}

/** The caller authors incoming relations; this convenience response explicitly
 * retains each existing identity and recorded demand. Existing-existing merges
 * use catalogNormalization with an authored group partition instead. Incoming
 * demands use their authored extraction definition unless the caller supplies
 * an explicit normalized/combined demandDefinition. No source text is matched. */
export function catalogMatching(call: ExternalCall, choices: Record<string, CatalogChoice>) {
  return matchingSlots(call, choices, catalogNormalization);
}

export function legacyCatalogMatchingV5(call: ExternalCall, choices: Record<string, CatalogChoice>) {
  return matchingSlots(call, choices, legacyCatalogNormalizationV5);
}

function matchingSlots(call: ExternalCall, choices: Record<string, CatalogChoice>, normalize: typeof catalogNormalization) {
  const context = catalogContext(call);
  expect(Object.keys(choices).sort()).toEqual(context.incoming.map((row) => row.local_id).sort());
  const groups: CapabilityChoice[] = context.candidates.map((candidate, index) => {
    const member = context.members.find((row) => row.member_id === candidate.requirement_id)!;
    expect(member).toBeTruthy();
    const meaning = catalogMemberMeaning(call, member.member_id);
    return { groupId: `retained-${index}`, memberIds: [member.member_id], category: meaning.category,
      name: meaning.name, definition: meaning.definition, reuseRequirementId: candidate.requirement_id };
  });
  const incomingGroups = new Map<string, CapabilityChoice>();
  const resolving = new Set<string>();
  const groupFor = (localId: string): CapabilityChoice => {
    const cached = incomingGroups.get(localId);
    if (cached) return cached;
    expect(resolving.has(localId), "Authored incoming references are acyclic").toBe(false);
    resolving.add(localId);
    const choice = choices[localId]!;
    const incoming = context.incoming.find((row) => row.local_id === localId);
    expect(choice).toBeTruthy(); expect(incoming).toBeTruthy();
    let group: CapabilityChoice;
    if ("requirementId" in choice) {
      group = groups.find((row) => row.memberIds.includes(choice.requirementId))!;
      expect(group, "The authored equivalent ID belongs to the complete live catalog").toBeTruthy();
    } else if ("incomingLocalId" in choice) {
      group = groupFor(choice.incomingLocalId);
    } else {
      const member = context.members.find((row) => row.member_id === incoming!.member_id)!;
      expect(member).toBeTruthy();
      const meaning = catalogMemberMeaning(call, member.member_id);
      group = { groupId: `incoming-${localId}`, memberIds: [], category: meaning.category, name: meaning.name, definition: meaning.definition };
      groups.push(group);
    }
    group.memberIds.push(incoming!.member_id);
    incomingGroups.set(localId, group); resolving.delete(localId);
    return group;
  };
  for (const incoming of context.incoming) groupFor(incoming.local_id);
  const jobGroups = new Map<string, { group: CapabilityChoice; occurrences: CatalogContext["occurrences"] }>();
  for (const occurrence of context.occurrences) {
    const group = groups.find((row) => row.memberIds.includes(occurrence.member_id))!;
    expect(group).toBeTruthy();
    const key = JSON.stringify([occurrence.job_id, group.groupId]);
    const existing = jobGroups.get(key) ?? { group, occurrences: [] };
    existing.occurrences.push(occurrence); jobGroups.set(key, existing);
  }
  const demands: DemandChoice[] = [];
  for (const { group, occurrences } of jobGroups.values()) {
    const evidence = occurrences.map((row) => catalogOccurrenceEvidence(call, row.occurrence_id));
    const incoming = context.incoming.filter((row) => occurrences.some((occurrence) => occurrence.occurrence_id === row.occurrence_id));
    const authored = incoming.map((row) => choices[row.local_id]!.demandDefinition).filter((value): value is string => value !== undefined);
    let definition: string;
    let reuseDemandFingerprint: string | null = null;
    if (authored.length) {
      expect(new Set(authored).size, "One authored combined demand per Job/capability").toBe(1);
      definition = authored[0]!;
    } else if (!incoming.length && evidence.every((row) => row.normalized_demand)) {
      expect(new Set(evidence.map((row) => row.normalized_demand!.demand_fingerprint)).size).toBe(1);
      reuseDemandFingerprint = evidence[0]!.normalized_demand!.demand_fingerprint;
      definition = catalogAcceptedDemand(call, reuseDemandFingerprint).definition;
    } else {
      // Exact equality is only a structural guard against dropping different
      // authored clauses. It never decides whether different demands mean the
      // same thing; those require an explicit demandDefinition above.
      const definitions = incoming.length ? incoming.map((row) => catalogMemberMeaning(call, row.member_id).definition)
        : evidence.map((row) => row.original.definition);
      expect(new Set(definitions).size, "Author an explicit combined demandDefinition for differing source demands").toBe(1);
      definition = definitions[0]!;
    }
    // These are already-authored normalized definitions, not source prose
    // comparisons: serialize identical signatures into one response entry.
    let demand = demands.find((row) => row.groupId === group.groupId && row.definition === definition);
    if (!demand) { demand = { groupId: group.groupId, definition, reuseDemandFingerprint, bindings: [] }; demands.push(demand); }
    else if (reuseDemandFingerprint) demand.reuseDemandFingerprint = reuseDemandFingerprint;
    demand.bindings.push({ jobId: occurrences[0]!.job_id, occurrenceIds: occurrences.map((row) => row.occurrence_id) });
  }
  const result = normalize(call, groups, demands);
  const uncertain = context.incoming.filter((row) => choices[row.local_id]!.verdict === "uncertain");
  if (uncertain.length) {
    result.status = "needs_review";
    for (const row of uncertain) {
      result.member_slots[row.member_id] = { kind: "unresolved",
        reason: "Explicit uncertain source-bound choice; preserve accepted state.", citations: citationSelections(call, [
          { sourceId: row.model_source_id, valuePath: ["definition"] }, { sourceId: context.catalog_inventory_source_id },
        ]) };
      for (const occurrence of context.occurrences.filter((item) => item.member_id === row.member_id))
        result.occurrence_slots[occurrence.occurrence_id] = { kind: "unresolved",
          reason: "The explicitly unresolved capability leaves this source demand unresolved.", citations: citationSelections(call, [
            { sourceId: occurrence.source_id, valuePath: ["original", "spans", 0, "quote"] }, { sourceId: context.catalog_inventory_source_id },
          ]) };
    }
  }
  return result;
}

/** Explicit choices for the current external request. This helper binds the
 * predecessor's authored choice to live IDs. Never use for the current stage. */
export function legacyCatalogMatching(
  call: ExternalCall,
  choices: Record<string, CatalogChoice>,
) {
  const context = catalogContext(call);
  expect(Object.keys(choices).sort()).toEqual(
    context.incoming.map((row) => row.local_id).sort(),
  );
  return {
    status: "complete",
    catalog_revision: context.catalog_revision,
    decisions: context.incoming.map((incoming) => {
      const choice = choices[incoming.local_id]!;
      const sourceIds = [
        context.posting_content?.source_id ?? context.posting!.model_source_id,
        incoming.model_source_id,
        context.catalog_inventory_source_id,
      ];
      let requirementId: string | null = null;
      let requirementRevision: number | null = null;
      let equivalentLocalId: string | null = null;
      if ("requirementId" in choice) {
        const candidate = context.candidates.find(
          (row) => row.requirement_id === choice.requirementId,
        );
        expect(
          candidate,
          "The chosen canonical ID belongs to the complete live catalog",
        ).toBeTruthy();
        requirementId = candidate!.requirement_id;
        requirementRevision = candidate!.revision;
        sourceIds.push(`requirement:${requirementId}:${requirementRevision}`);
      } else if ("incomingLocalId" in choice) {
        const representative = context.incoming.find(
          (row) => row.local_id === choice.incomingLocalId,
        );
        expect(representative).toBeTruthy();
        equivalentLocalId = choice.incomingLocalId;
        sourceIds.push(representative!.model_source_id);
      }
      return {
        local_id: incoming.local_id,
        verdict: choice.verdict,
        requirement_id: requirementId,
        requirement_revision: requirementRevision,
        equivalent_local_id: equivalentLocalId,
        reason:
          "Explicit source-bound catalog choice for this synthetic journey.",
        citations: citeSources(call, sourceIds),
      };
    }),
  };
}
