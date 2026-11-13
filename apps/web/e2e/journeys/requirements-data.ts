import { expect, type ExternalCall } from "../harness/fixtures.js";

export type ModelSource = { source_id: string; text: string };
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
  incoming: { local_id: string; model_source_id: string }[];
  candidates: { requirement_id: string; revision: number }[];
};

export type CatalogChoice =
  | { verdict: "new" | "uncertain" }
  | { verdict: "equivalent"; requirementId: string }
  | { verdict: "equivalent"; incomingLocalId: string };

/** Explicit choices for the current external request. This helper binds the
 * authored choice to live IDs and verbatim sources; it never compares meaning. */
export function catalogMatching(
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
