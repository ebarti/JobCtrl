import type { ScoreProfileFreshness } from "@jobctrl/contracts";
import { getRow, type SqliteDatabase } from "./db.js";
import { readBoundDetermination } from "./semantic-determinations.js";

/** Exact canonical version comparison; GET never calls a provider or writes. */
export function scoreProfileFreshness(
  db: SqliteDatabase, jobId: string, scoreVersion: number | null,
  traceJson: string | null,
): ScoreProfileFreshness {
  const profile = getRow<{ version: number }>(db,
    "SELECT version FROM candidate_profiles WHERE tenant_id = 'local' AND profile_id = 'default'");
  let trace: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(traceJson ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) trace = parsed as Record<string, unknown>;
  } catch { /* Unknown provenance stays unknown. */ }
  const recorded = trace?.profile_snapshot_version ?? trace?.profileSnapshotVersion;
  const scoredProfileVersion = typeof recorded === "number" && Number.isSafeInteger(recorded) && recorded > 0 ? recorded : null;
  const currentProfileVersion = profile && Number.isSafeInteger(profile.version) && profile.version > 0 ? profile.version : null;
  const base = { scoredProfileVersion, currentProfileVersion, review: null };
  if (scoreVersion === null) return { ...base, status: "not_scored" };
  const inputs = trace.profile_inputs;
  if (inputs !== undefined && (!inputs || typeof inputs !== "object" || Array.isArray(inputs)
    || !("profile_id" in inputs) || inputs.profile_id !== "default"
    || !("profile_version" in inputs) || inputs.profile_version !== scoredProfileVersion))
    return { ...base, status: "unknown" };
  if (!scoredProfileVersion || !currentProfileVersion || scoredProfileVersion > currentProfileVersion)
    return { ...base, status: "unknown" };
  if (scoredProfileVersion === currentProfileVersion) return { ...base, status: "current" };
  const envelope = readBoundDetermination(db, "local", "score_profile_review", jobId,
    `${scoreVersion}:default:${currentProfileVersion}`, "score_profile_impact");
  const result = envelope?.result;
  if (!envelope || envelope.lane !== "scoring" || envelope.schema_version !== "1" || envelope.prompt_version !== "score-profile-impact-v1"
    || result?.job_id !== jobId || result.score_version !== scoreVersion || result.profile_id !== "default"
    || result.scored_profile_version !== scoredProfileVersion || result.reviewed_profile_version !== currentProfileVersion
    || result.scoring_determination_id !== trace.determination_id
    || (result.verdict !== "significant" && result.verdict !== "insignificant"))
    return { ...base, status: "profile_updated" };
  return { ...base, status: result.verdict === "insignificant" ? "reviewed_unchanged" : "profile_updated",
    review: { determinationId: envelope.determination_id, verdict: result.verdict,
      rationale: String(result.rationale), provider: envelope.provider, model: envelope.model,
      reasoningEffort: envelope.reasoning_effort ?? null, reviewedAt: envelope.created_at } };
}
