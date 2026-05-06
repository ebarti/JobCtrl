/**
 * Pure helpers used by the TS write-model when applying simple state
 * transitions. Builds on `state_machine.ts` to keep ports on the API side
 * thin: the API only needs to map "command + current DB row" → "next state".
 *
 * No I/O, no DB. Pair with the parity test for behavioral equivalence with
 * the Python side.
 */

import type { StageState, StageStateKind } from "../pipeline.js";

import {
  applyTransition,
  isRejected,
  isValidTransition,
  type StageTransition,
  type TransitionInputs,
  type TransitionResult,
} from "./state_machine.js";

/** Outcome of `transitionStage`. */
export type StageTransitionOutcome =
  | { ok: true; readonly state: StageState }
  | {
      ok: false;
      readonly reason: string;
      readonly fromKind: StageStateKind;
      readonly trigger: StageTransition;
    };

/**
 * Run the state machine and unwrap into a discriminated result that's
 * easier to consume from a write-model. Errors from the machine become
 * `ok: false` rather than rejected variants.
 */
export function transitionStage(
  current: StageState,
  trigger: StageTransition,
  inputs: TransitionInputs = {},
): StageTransitionOutcome {
  const result: TransitionResult = applyTransition(current, trigger, inputs);
  if (isRejected(result)) {
    return {
      ok: false,
      reason: result.reason,
      fromKind: result.currentState.kind,
      trigger,
    };
  }
  return { ok: true, state: result };
}

/**
 * Check whether moving from `fromKind` straight to `toKind` is allowed
 * (without specifying the trigger). The TS write-model uses this as the
 * gate before writing `job_stage_states`, mirroring `_validate_stage_transition`
 * in `state.py`.
 */
export function canTransitionTo(fromKind: StageStateKind, toKind: StageStateKind): boolean {
  return isValidTransition(fromKind, toKind);
}
