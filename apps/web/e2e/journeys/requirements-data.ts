import { expect, type ExternalCall } from "../harness/fixtures.js";

export type ModelSource = { source_id: string; text: string };
export const modelSources = (call: ExternalCall) =>
  call.body["sources"] as ModelSource[];

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
