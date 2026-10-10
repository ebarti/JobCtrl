import { z } from "zod";
import contracts from "./semantic-result-schemas.json" with { type: "json" };

// Generated from the owning Python models. Readers validate recorded decisions
// with these schemas; they never reinterpret source text.
const validators = new Map(
  Object.entries(contracts).map(([kind, contract]) => [
    kind,
    {
      schemaVersion: contract.schemaVersion,
      promptVersion: contract.promptVersion,
      schema: z.fromJSONSchema(
        contract.schema as Parameters<typeof z.fromJSONSchema>[0],
      ),
    },
  ]),
);

export function isCurrentDeterminationVersion(envelope: {
  kind: string;
  schema_version: string;
  prompt_version: string;
}): boolean {
  const contract = validators.get(envelope.kind);
  return Boolean(
    contract &&
    contract.schemaVersion === envelope.schema_version &&
    contract.promptVersion === envelope.prompt_version,
  );
}

export function validDeterminationResult(envelope: {
  kind: string;
  schema_version: string;
  prompt_version: string;
  result: unknown;
}): boolean {
  if (!isCurrentDeterminationVersion(envelope)) return false;
  const contract = validators.get(envelope.kind)!;
  const parsed = contract.schema.safeParse(envelope.result);
  if (!parsed.success) return false;
  if (envelope.kind === "page_interpretation") {
    const page = parsed.data as {
      access_state: { value: string };
      availability: { value: string };
    };
    if (
      ["login_required", "challenge"].includes(page.access_state.value) &&
      page.availability.value !== "unknown"
    )
      return false;
  }
  return true;
}
