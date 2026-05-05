/**
 * TS↔Python parity test driven from the shared fixture.
 *
 * The matching Python test lives at
 * `workers/automation/tests/test_state_machine_parity.py`.
 * Both load `fixtures/state_machine_transitions.json` and assert identical
 * outputs for every §8.5 row plus the rejection cases.
 */
import { describe, expect, it } from "vitest";

import type { StageState, StageStateKind } from "../src/pipeline.js";
import {
  applyTransition,
  isRejected,
  isValidTransition,
  StageTransitions,
  VALID_KIND_TRANSITIONS,
  type StageTransition,
  type TransitionInputs,
  type TransitionRejected,
  type TransitionResult,
} from "../src/pipeline/state_machine.js";
import fixtureRaw from "./fixtures/state_machine_transitions.json" with { type: "json" };

interface ValidCase {
  name: string;
  from: StageState;
  trigger: StageTransition;
  inputs?: TransitionInputs;
  expected: Record<string, unknown>;
}

interface RejectionCase {
  name: string;
  from: StageState;
  trigger: StageTransition;
}

interface Fixture {
  validTransitions: ValidCase[];
  rejections: RejectionCase[];
}

const fixture = fixtureRaw as unknown as Fixture;

/**
 * Strip undefined optional fields so JSON-equality with Python output
 * (which omits unset defaults) doesn't fail on `nextAction: undefined`.
 */
function compact<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) out[k] = v;
  }
  return out;
}

describe("§8.5 state machine — TS parity", () => {
  it("VALID_KIND_TRANSITIONS has the expected 16 rows", () => {
    expect(VALID_KIND_TRANSITIONS).toHaveLength(16);
  });

  it("StageTransitions matches the canonical 11 triggers (parity vector)", () => {
    expect(StageTransitions).toHaveLength(11);
  });

  it("fixture covers every row of VALID_KIND_TRANSITIONS exactly once", () => {
    const keysFromFixture = new Set<string>();
    for (const c of fixture.validTransitions) {
      const result = applyTransition(c.from, c.trigger, c.inputs);
      if (!isRejected(result)) {
        keysFromFixture.add(`${c.from.kind}->${result.kind}`);
      }
    }
    const keysFromTable = new Set(
      VALID_KIND_TRANSITIONS.map(([from, to]) => `${from}->${to}`),
    );
    expect(keysFromFixture).toEqual(keysFromTable);
  });

  for (const c of fixture.validTransitions) {
    it(`valid: ${c.name}`, () => {
      const result: TransitionResult = applyTransition(c.from, c.trigger, c.inputs);
      expect(isRejected(result)).toBe(false);
      const successful = result as Exclude<TransitionResult, TransitionRejected>;
      expect(compact(successful as unknown as Record<string, unknown>)).toEqual(compact(c.expected));
    });
  }

  for (const c of fixture.rejections) {
    it(`rejection: ${c.name}`, () => {
      const result = applyTransition(c.from, c.trigger);
      expect(isRejected(result)).toBe(true);
    });
  }

  it("isValidTransition agrees with applyTransition on every fixture row", () => {
    for (const c of fixture.validTransitions) {
      const result = applyTransition(c.from, c.trigger, c.inputs);
      expect(isRejected(result)).toBe(false);
      const toKind = (result as { kind: StageStateKind }).kind;
      expect(isValidTransition(c.from.kind, toKind)).toBe(true);
    }
  });
});
