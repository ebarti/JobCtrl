/**
 * Pipeline stage and stage-state domain types.
 *
 * PascalCase variants are the domain representation used in-memory.
 * Lowercase strings are the serialized form written to the database,
 * emitted in event payloads, and exposed through API DTOs.
 *
 * @see docs/architecture/domain-model/tactical.md §4.7 (Pipeline Orchestration), §8.5 (State Machine), §11 (Glossary)
 */

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

/** The six pipeline stages in canonical order (domain PascalCase). */
export const STAGES = [
  "Discover",
  "Enrich",
  "Score",
  "Tailor",
  "Cover",
  "Apply",
] as const;

/** Domain-layer stage type (PascalCase). */
export type Stage = (typeof STAGES)[number];

/** Serialized stage string (lowercase) for persistence / transport. */
export type SerializedStage =
  | "discover"
  | "enrich"
  | "score"
  | "tailor"
  | "cover"
  | "apply";

const STAGE_TO_SERIALIZED: Record<Stage, SerializedStage> = {
  Discover: "discover",
  Enrich: "enrich",
  Score: "score",
  Tailor: "tailor",
  Cover: "cover",
  Apply: "apply",
};

const SERIALIZED_TO_STAGE: Record<SerializedStage, Stage> = {
  discover: "Discover",
  enrich: "Enrich",
  score: "Score",
  tailor: "Tailor",
  cover: "Cover",
  apply: "Apply",
};

/** Convert a domain Stage to its lowercase serialized form. */
export function serializeStage(stage: Stage): SerializedStage {
  return STAGE_TO_SERIALIZED[stage];
}

/** Convert a lowercase serialized string back to a domain Stage. Throws on invalid input. */
export function deserializeStage(value: string): Stage {
  const stage = SERIALIZED_TO_STAGE[value as SerializedStage];
  if (stage === undefined) {
    throw new Error(`Invalid serialized stage: "${value}"`);
  }
  return stage;
}

// ---------------------------------------------------------------------------
// StageState — discriminated union
// ---------------------------------------------------------------------------

/** All stage-state variant names (domain PascalCase). */
export const STAGE_STATE_KINDS = [
  "Pending",
  "Queued",
  "Running",
  "Succeeded",
  "Failed",
  "Blocked",
  "Skipped",
  "Exhausted",
  "NeedsVerification",
  "Stale",
  "Canceled",
] as const;

export type StageStateKind = (typeof STAGE_STATE_KINDS)[number];

/** Serialized stage-state string (lowercase). */
export type SerializedStageState =
  | "pending"
  | "queued"
  | "running"
  | "succeeded"
  | "failed"
  | "blocked"
  | "skipped"
  | "exhausted"
  | "needs_verification"
  | "stale"
  | "canceled";

export interface Pending {
  readonly kind: "Pending";
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAction?: string | undefined;
}

export interface Queued {
  readonly kind: "Queued";
  readonly queuedAt: string;
}

export interface Running {
  readonly kind: "Running";
  readonly attemptCount: number;
  readonly startedAt: string;
}

export interface Succeeded {
  readonly kind: "Succeeded";
  readonly attemptCount: number;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface Failed {
  readonly kind: "Failed";
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly retryable: boolean;
  readonly nextAction?: string | undefined;
}

export interface Blocked {
  readonly kind: "Blocked";
  readonly blockedBy: readonly Stage[];
  readonly errorCode: string;
  readonly errorMessage: string;
}

export interface Skipped {
  readonly kind: "Skipped";
  readonly reason: string;
}

export interface Exhausted {
  readonly kind: "Exhausted";
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly nextAction?: string | undefined;
}

export interface NeedsVerification {
  readonly kind: "NeedsVerification";
  readonly reason: string;
  readonly nextAction?: string | undefined;
}

export interface Stale {
  readonly kind: "Stale";
  readonly reason: string;
}

export interface Canceled {
  readonly kind: "Canceled";
  readonly canceledAt: string;
  readonly reason?: string | undefined;
}

/** Discriminated union of all stage-state variants. */
export type StageState =
  | Pending
  | Queued
  | Running
  | Succeeded
  | Failed
  | Blocked
  | Skipped
  | Exhausted
  | NeedsVerification
  | Stale
  | Canceled;

/** Convert a domain StageState kind to its lowercase serialized form. */
export function serializeStageState(state: StageState): SerializedStageState {
  if (state.kind === "NeedsVerification") {
    return "needs_verification";
  }
  return state.kind.toLowerCase() as SerializedStageState;
}

/** Convert a lowercase string to a StageState kind. Throws on invalid input. */
export function deserializeStageStateKind(value: string): StageStateKind {
  const lower = value.toLowerCase();
  if (lower === "needs_verification") {
    return "NeedsVerification";
  }
  const found = STAGE_STATE_KINDS.find((k) => k.toLowerCase() === lower);
  if (found === undefined) {
    throw new Error(`Invalid serialized stage state: "${value}"`);
  }
  return found;
}
