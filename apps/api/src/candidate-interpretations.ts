import { readBoundDetermination } from "./semantic-determinations.js";
import type { SqliteDatabase } from "./db.js";
import {
  TargetRoleSuggestionResultSchema,
  type TargetRoleSuggestionResult,
} from "@jobctrl/contracts";

/** Proposals are projections of the version-bound candidate determination. */
export function readTargetRoleProposal(
  db: SqliteDatabase,
  profileVersion: number,
  maximum: number,
): TargetRoleSuggestionResult | null {
  const envelope = readBoundDetermination(
    db,
    "local",
    "profile",
    "default",
    String(profileVersion),
    "candidate_interpretation",
  );
  if (!envelope) return null;
  const confirmation = readCandidateInterpretationStatus(db, profileVersion);
  if (
    confirmation.determination?.determination_id !== envelope.determination_id
  )
    return null;
  const result = envelope.result as {
    target_roles: Array<{
      title: string;
      classification: string;
      track: string;
      seniority: string;
      citations: Array<{
        source_id: string;
        quote: string;
        exact_values: string[];
      }>;
      rationale: string;
    }>;
    target_preferences: Array<{
      location: string;
      work_model: string;
      citations: Array<{
        source_id: string;
        quote: string;
        exact_values: string[];
      }>;
      rationale: string;
    }>;
  };
  return TargetRoleSuggestionResultSchema.parse({
    profileVersion,
    determinationId: envelope.determination_id,
    status: confirmation.status,
    strategy: "model",
    warnings: [],
    suggestions: result.target_roles
      .slice(0, maximum)
      .map((item) => ({
        ...item,
        evidenceIds: [...new Set(item.citations.map((cite) => cite.source_id))],
      })),
    preferenceSuggestions: result.target_preferences
      .slice(0, maximum)
      .map((item) => ({
        location: item.location,
        workModel: item.work_model,
        evidenceIds: [...new Set(item.citations.map((cite) => cite.source_id))],
        citations: item.citations,
        rationale: item.rationale,
      })),
  });
}

/** Read the current version's receipt and its explicit confirmation state. */
export function readCandidateInterpretationStatus(
  db: SqliteDatabase,
  profileVersion: number,
) {
  try {
    const determination = readBoundDetermination(
      db,
      "local",
      "profile",
      "default",
      String(profileVersion),
      "candidate_interpretation",
    );
    if (determination) {
      const row = db
        .prepare(
          "SELECT status FROM candidate_interpretation_suggestions WHERE tenant_id='local' AND profile_id='default' AND profile_version=? AND determination_id=?",
        )
        .get(profileVersion, determination.determination_id) as
        | { status: "pending_confirmation" | "confirmed" }
        | undefined;
      if (!row)
        return {
          status: "unavailable" as const,
          failureCode: "candidate_confirmation_binding_invalid",
          determination: null,
        };
      return { status: row.status, failureCode: null, determination };
    }
    const failure = db
      .prepare(
        "SELECT failure_code FROM semantic_stage_states WHERE tenant_id='local' AND entity_id=? AND kind='candidate_interpretation_request' AND state='blocked' ORDER BY updated_at DESC LIMIT 1",
      )
      .get(`default:${profileVersion}`) as { failure_code: string } | undefined;
    return {
      status: failure ? ("unavailable" as const) : ("missing" as const),
      failureCode: failure?.failure_code ?? null,
      determination: null,
    };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("determination_"))
      return {
        status: "unavailable" as const,
        failureCode: error.message,
        determination: null,
      };
    throw error;
  }
}
