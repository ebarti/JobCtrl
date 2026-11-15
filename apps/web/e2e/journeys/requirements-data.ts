import { createHash } from "node:crypto";
import { expect, type ExternalCall } from "../harness/fixtures.js";

export type ModelSource = { source_id: string; text: string };
export const NORMALIZATION_PROMPT_VERSION = "requirements-capability-demand-citation-v3";
export const LEGACY_NORMALIZATION_PROMPT_VERSION = "requirements-capability-demand-v2";
export const CITATION_BINDER_VERSION = "requirements-citation-binding-v1";
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

export type CatalogContext = {
  catalog_revision: number;
  catalog_inventory_source_id: string;
  posting?: { model_source_id: string };
  posting_content?: { source_id: string };
  incoming: { local_id: string; model_source_id: string; occurrence_id: string; job_id: string; member_id: string }[];
  candidates: { requirement_id: string; revision: number }[];
  members: { member_id: string; source_id: string; requirement_id: string | null; revision: number | null }[];
  occurrences: { job_id: string; occurrence_id: string; member_id: string; source_id: string; posting_revision: number; posting_hash: string;
    requirement_id: string; requirement_revision: number; source_kind: "proposed" | "accepted_snapshot";
    snapshot_revision: number | null; base_snapshot_revision: number; correction_determination_id: string | null;
    previous_occurrence_id: string | null; resolution_determination_ids: string[] }[];
  accepted_demands: { group_member_ids: string[]; source_id: string; demand_fingerprint: string; normalization_version: string }[];
  accepted_occurrence_counts: Record<string, number>;
  posting_sources: { job_id: string; revision: number; source_hash: string; source_id: string }[];
  citation_segments: Record<string, Record<string, (string | number)[] | {
    source_format?: "json_string" | "serialized"; value_path: (string | number)[];
    start: number; end: number; preview?: string }>>;
  citation_catalog_fingerprint: string;
  citation_source_fingerprints: Record<string, string>;
  citation_source_context_fingerprint: string;
  source_snapshot_heads: { job_id: string; revision: number; posting_revision: number; posting_hash: string;
    contract_version?: string; snapshot_fingerprint?: string }[];
};

export type CitationSelection = { source_id: string; segment_id: string };
type CitationReference = { sourceId: string; valuePath?: (string | number)[] };

/** Select only owner-supplied references at explicitly authored DTO paths.
 * The helper neither invents quote text/ranges nor searches prose for meaning. */
export function citationSelections(call: ExternalCall, references: CitationReference[]): CitationSelection[] {
  const context = call.body["context"] as CatalogContext;
  expect(context.citation_catalog_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(normalizationFingerprint(context.citation_segments)).toBe(context.citation_catalog_fingerprint);
  return references.map(({ sourceId, valuePath }) => {
    const offered = Object.entries(context.citation_segments[sourceId] ?? {}).filter(([, segment]) =>
      valuePath === undefined || JSON.stringify(Array.isArray(segment) ? segment : segment.value_path) === JSON.stringify(valuePath));
    expect(offered, "Select one explicitly provided source field reference").toHaveLength(1);
    expect(modelSources(call).some((source) => source.source_id === sourceId)).toBe(true);
    return { source_id: sourceId, segment_id: offered[0]![0] };
  });
}

const canonicalValue = (value: unknown): unknown => Array.isArray(value) ? value.map(canonicalValue)
  : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => [key, canonicalValue(item)])) : value;
export const normalizationFingerprint = (value: unknown) => createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex");

type CatalogMeaning = { category: "skill" | "professional_experience"; name: string; definition: string };
type OccurrenceEvidence = Omit<CatalogContext["occurrences"][number],
  "correction_determination_id" | "previous_occurrence_id" | "resolution_determination_ids"> & {
  original: CatalogMeaning & { spans: { quote: string }[] };
  canonical: CatalogMeaning;
  normalized_demand: { normalization_version: string; demand_fingerprint: string } | null;
};

/** The current wire carries structural references. Meanings are read from the
 * referenced live source DTOs, never reconstructed from names or identifiers. */
function catalogSource<T>(call: ExternalCall, sourceId: string): T {
  const source = modelSources(call).find((row) => row.source_id === sourceId);
  expect(source, `The actual request owns source ${sourceId}`).toBeTruthy();
  return JSON.parse(source!.text) as T;
}

export function catalogMemberMeaning(call: ExternalCall, memberId: string): CatalogMeaning {
  const member = (call.body["context"] as CatalogContext).members.find((row) => row.member_id === memberId);
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
  const occurrence = (call.body["context"] as CatalogContext).occurrences.find((row) => row.occurrence_id === occurrenceId);
  expect(occurrence).toBeTruthy();
  const source = catalogSource<OccurrenceEvidence>(call, occurrence!.source_id);
  // These lineage fields belong to context and its persisted source_context;
  // the source document carries the remaining shared identity/evidence pins.
  const { correction_determination_id, previous_occurrence_id, resolution_determination_ids, ...sourcePins } = occurrence!;
  expect(source).toMatchObject(sourcePins);
  return source;
}

function catalogAcceptedDemand(call: ExternalCall, fingerprint: string) {
  const demand = (call.body["context"] as CatalogContext).accepted_demands.find((row) => row.demand_fingerprint === fingerprint);
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
export type CorrectionWitness = NormalizationCorrection<CitationSelection>;
export type BoundCorrectionWitness = NormalizationCorrection<ReturnType<typeof citeSources>[number]>;

/** Authors supply the complete semantic partition. This binds only live IDs,
 * exhaustive inventory accounting and verbatim citations, never meaning. */
export function catalogNormalization(call: ExternalCall, capabilities: CapabilityChoice[], demands: DemandChoice[]) {
  expect(call.body["operation"]).toBe("requirements.match_catalog");
  expect(call.body["prompt_version"]).toBe(NORMALIZATION_PROMPT_VERSION);
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
  const context = call.body["context"] as CatalogContext;
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
  const context = call.body["context"] as CatalogContext;
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
  const result = catalogNormalization(call, groups, demands);
  const uncertain = context.incoming.filter((row) => choices[row.local_id]!.verdict === "uncertain");
  if (uncertain.length) {
    result.status = "needs_review";
    result.unresolved = uncertain.map((row) => ({ member_ids: [row.member_id], reason: "Explicit uncertain source-bound choice; preserve accepted state.", citations: citationSelections(call, [
      { sourceId: row.model_source_id, valuePath: ["definition"] }, { sourceId: context.catalog_inventory_source_id },
    ]) }));
  }
  return result;
}

/** Explicit choices for the current external request. This helper binds the
 * predecessor's authored choice to live IDs. Never use for the current stage. */
export function legacyCatalogMatching(
  call: ExternalCall,
  choices: Record<string, CatalogChoice>,
) {
  const context = call.body["context"] as CatalogContext;
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
