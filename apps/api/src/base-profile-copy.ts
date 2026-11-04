import type { ArtifactSummary } from "@jobctrl/contracts";

/** Read only this artifact's persisted origin; never infer it from settings. */
export function baseProfileCopyOrigin(
  value: string | null,
): Exclude<ArtifactSummary["resumePreparation"], undefined> {
  let metadata: unknown;
  try {
    metadata = value ? JSON.parse(value) : null;
  } catch {
    return null;
  }
  if (!metadata || typeof metadata !== "object") return null;
  const record = metadata as Record<string, unknown>;
  if (record.preparation_mode !== "baseline_copy") return null;
  const origin = record.base_profile_copy;
  if (!origin || typeof origin !== "object") return null;
  const source = origin as Record<string, unknown>;
  if (
    typeof source.profile_id !== "string" ||
    !source.profile_id ||
    typeof source.profile_version !== "number" ||
    !Number.isSafeInteger(source.profile_version) ||
    source.profile_version < 1 ||
    typeof source.modified !== "boolean" ||
    !Array.isArray(source.source_ids) ||
    !source.source_ids.every((id) => typeof id === "string")
  )
    return null;
  return {
    mode: "baseline_copy",
    profileId: source.profile_id,
    profileVersion: source.profile_version,
    modified: source.modified,
    sourceIds: source.source_ids,
  };
}
