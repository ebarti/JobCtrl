/**
 * StageStateMachine — TS port of `workers/automation/src/jobctl/domain/pipeline/state_machine.py`.
 *
 * Pure functions, no I/O, no runtime dependencies. Parity with the Python
 * implementation is enforced by `test/state_machine_parity.test.ts` plus the
 * sibling `tests/test_state_machine_parity.py`, both driven from the shared
 * fixture in `test/fixtures/state_machine_transitions.json`.
 *
 * Mirrors §8.5 — sixteen valid (fromKind, toKind) pairs.
 */

import type {
  Blocked,
  Canceled,
  Exhausted,
  Failed,
  Pending,
  Queued,
  Running,
  Skipped,
  Stale,
  StageState,
  StageStateKind,
  Succeeded,
} from "../pipeline.js";

/* ------------------------------------------------------------------ trigger */

/** Triggers that drive state machine transitions (parity with Python enum). */
export const StageTransitions = [
  "Enqueue",
  "Start",
  "Complete",
  "Fail",
  "Block",
  "Skip",
  "Reset",
  "Cancel",
  "Exhaust",
  "Unblock",
  "MarkStale",
] as const;
export type StageTransition = (typeof StageTransitions)[number];

/* ----------------------------------------------------------------- rejected */

export interface TransitionRejected {
  readonly kind: "TransitionRejected";
  readonly currentState: StageState;
  readonly attemptedTransition: StageTransition;
  readonly reason: string;
}

export type TransitionResult = StageState | TransitionRejected;

export function isRejected(value: TransitionResult): value is TransitionRejected {
  return (value as TransitionRejected).kind === "TransitionRejected";
}

/* --------------------------------------------------------- §8.5 valid pairs */

/** Sixteen valid (fromKind, toKind) transitions from §8.5. */
export const VALID_KIND_TRANSITIONS: ReadonlyArray<readonly [StageStateKind, StageStateKind]> = [
  ["Pending", "Queued"],
  ["Pending", "Running"],
  ["Pending", "Blocked"],
  ["Pending", "Skipped"],
  ["Queued", "Running"],
  ["Queued", "Canceled"],
  ["Running", "Succeeded"],
  ["Running", "Failed"],
  ["Running", "Canceled"],
  ["Failed", "Pending"],
  ["Failed", "Exhausted"],
  ["Blocked", "Pending"],
  ["Exhausted", "Pending"],
  ["Canceled", "Pending"],
  ["Succeeded", "Stale"],
  ["Stale", "Pending"],
] as const;

const VALID_KIND_TRANSITION_SET: ReadonlySet<string> = new Set(
  VALID_KIND_TRANSITIONS.map(([from, to]) => `${from}->${to}`),
);

/** Pure check: does the §8.5 table allow `fromKind → toKind`? */
export function isValidTransition(fromKind: StageStateKind, toKind: StageStateKind): boolean {
  return VALID_KIND_TRANSITION_SET.has(`${fromKind}->${toKind}`);
}

/* ----------------------------------------------------- transition handlers */

/**
 * Optional metadata you can pass through `applyTransition`. Mirrors the
 * **kwargs forwarded to the Python handlers — every field is optional.
 */
export interface TransitionInputs {
  readonly queuedAt?: string;
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly canceledAt?: string;
  readonly attemptCount?: number;
  readonly maxAttempts?: number;
  readonly durationMs?: number;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly retryable?: boolean;
  readonly nextAction?: string;
  readonly reason?: string;
  readonly resetAttempts?: boolean;
  readonly blockedBy?: readonly string[];
}

type Handler = (current: StageState, inputs: TransitionInputs) => StageState;

const HANDLERS = new Map<string, Handler>();

function key(fromKind: StageStateKind, trigger: StageTransition): string {
  return `${fromKind}->${trigger}`;
}

function register(fromKind: StageStateKind, trigger: StageTransition, fn: Handler): void {
  HANDLERS.set(key(fromKind, trigger), fn);
}

// Row 1: Pending -> Queued
register("Pending", "Enqueue", (_current, inputs): Queued => ({
  kind: "Queued",
  queuedAt: inputs.queuedAt ?? "",
}));

// Row 2: Pending -> Running
register("Pending", "Start", (current, inputs): Running => {
  const pending = current as Pending;
  return {
    kind: "Running",
    attemptCount: pending.attemptCount + 1,
    startedAt: inputs.startedAt ?? "",
  };
});

// Row 3: Pending -> Blocked
register("Pending", "Block", (_current, inputs): Blocked => ({
  kind: "Blocked",
  blockedBy: (inputs.blockedBy ?? []) as Blocked["blockedBy"],
  errorCode: inputs.errorCode ?? "BLOCKED_UPSTREAM",
  errorMessage: inputs.errorMessage ?? "",
}));

// Row 4: Pending -> Skipped
register("Pending", "Skip", (_current, inputs): Skipped => ({
  kind: "Skipped",
  reason: inputs.reason ?? "",
}));

// Row 5: Queued -> Running
register("Queued", "Start", (_current, inputs): Running => ({
  kind: "Running",
  attemptCount: inputs.attemptCount ?? 1,
  startedAt: inputs.startedAt ?? "",
}));

// Row 6: Queued -> Canceled
register("Queued", "Cancel", (_current, inputs): Canceled => ({
  kind: "Canceled",
  canceledAt: inputs.canceledAt ?? "",
  reason: inputs.reason,
}));

// Row 7: Running -> Succeeded
register("Running", "Complete", (current, inputs): Succeeded => {
  const running = current as Running;
  return {
    kind: "Succeeded",
    attemptCount: running.attemptCount,
    finishedAt: inputs.finishedAt ?? "",
    durationMs: inputs.durationMs ?? 0,
  };
});

// Row 8: Running -> Failed
register("Running", "Fail", (current, inputs): Failed => {
  const running = current as Running;
  return {
    kind: "Failed",
    attemptCount: running.attemptCount,
    maxAttempts: inputs.maxAttempts ?? 0,
    errorCode: inputs.errorCode ?? "",
    errorMessage: inputs.errorMessage ?? "",
    retryable: inputs.retryable ?? true,
    nextAction: inputs.nextAction,
  };
});

// Row 9: Running -> Canceled
register("Running", "Cancel", (_current, inputs): Canceled => ({
  kind: "Canceled",
  canceledAt: inputs.canceledAt ?? "",
  reason: inputs.reason,
}));

// Row 10: Failed -> Pending
register("Failed", "Reset", (current, inputs): Pending => {
  const failed = current as Failed;
  const reset = inputs.resetAttempts ?? false;
  return {
    kind: "Pending",
    attemptCount: reset ? 0 : failed.attemptCount,
    maxAttempts: failed.maxAttempts,
    nextAction: inputs.nextAction,
  };
});

// Row 11: Failed -> Exhausted
register("Failed", "Exhaust", (current, inputs): Exhausted => {
  const failed = current as Failed;
  return {
    kind: "Exhausted",
    attemptCount: failed.attemptCount,
    maxAttempts: failed.maxAttempts,
    errorCode: inputs.errorCode ?? failed.errorCode,
    errorMessage: inputs.errorMessage ?? failed.errorMessage,
    nextAction: inputs.nextAction,
  };
});

// Row 12: Blocked -> Pending
register("Blocked", "Unblock", (_current, inputs): Pending => ({
  kind: "Pending",
  attemptCount: inputs.attemptCount ?? 0,
  maxAttempts: inputs.maxAttempts ?? 0,
  nextAction: inputs.nextAction,
}));

// Row 13: Exhausted -> Pending
register("Exhausted", "Reset", (current, inputs): Pending => {
  const exhausted = current as Exhausted;
  return {
    kind: "Pending",
    attemptCount: 0,
    maxAttempts: exhausted.maxAttempts,
    nextAction: inputs.nextAction,
  };
});

// Row 14: Canceled -> Pending
register("Canceled", "Reset", (_current, inputs): Pending => ({
  kind: "Pending",
  attemptCount: inputs.attemptCount ?? 0,
  maxAttempts: inputs.maxAttempts ?? 0,
  nextAction: inputs.nextAction,
}));

// Row 15: Succeeded -> Stale
register("Succeeded", "MarkStale", (_current, inputs): Stale => ({
  kind: "Stale",
  reason: inputs.reason ?? "",
}));

// Row 16: Stale -> Pending
register("Stale", "Reset", (_current, inputs): Pending => ({
  kind: "Pending",
  attemptCount: inputs.attemptCount ?? 0,
  maxAttempts: inputs.maxAttempts ?? 0,
  nextAction: inputs.nextAction,
}));

/* -------------------------------------------------------- applyTransition */

/**
 * Apply a state transition. Pure function — no side effects.
 *
 * Returns the new `StageState` on success or `TransitionRejected` when the
 * trigger is not allowed from `current.kind` per the §8.5 table.
 */
export function applyTransition(
  current: StageState,
  trigger: StageTransition,
  inputs: TransitionInputs = {},
): TransitionResult {
  const handler = HANDLERS.get(key(current.kind, trigger));
  if (!handler) {
    return {
      kind: "TransitionRejected",
      currentState: current,
      attemptedTransition: trigger,
      reason: `Transition ${trigger} is not allowed from ${current.kind}`,
    };
  }
  return handler(current, inputs);
}
