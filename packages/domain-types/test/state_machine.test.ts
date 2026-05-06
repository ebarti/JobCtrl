import { describe, expect, it } from "vitest";

import type { Failed, Pending, Running, Stale, Succeeded } from "../src/pipeline.js";
import {
  applyTransition,
  isRejected,
  isValidTransition,
  StageTransitions,
  VALID_KIND_TRANSITIONS,
} from "../src/pipeline/state_machine.js";
import { canTransitionTo, transitionStage } from "../src/pipeline/use_cases.js";

describe("StageStateMachine — §8.5 valid transitions", () => {
  it("exposes exactly 16 valid (from, to) kind pairs", () => {
    expect(VALID_KIND_TRANSITIONS).toHaveLength(16);
  });

  it("exposes the canonical 11 trigger names", () => {
    expect(StageTransitions).toEqual([
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
    ]);
  });

  it("isValidTransition agrees with VALID_KIND_TRANSITIONS", () => {
    for (const [from, to] of VALID_KIND_TRANSITIONS) {
      expect(isValidTransition(from, to)).toBe(true);
    }
  });

  it("isValidTransition rejects unrelated pairs", () => {
    expect(isValidTransition("Pending", "Succeeded")).toBe(false);
    expect(isValidTransition("Skipped", "Pending")).toBe(false);
    expect(isValidTransition("Succeeded", "Pending")).toBe(false);
  });

  it("canTransitionTo mirrors isValidTransition", () => {
    expect(canTransitionTo("Pending", "Running")).toBe(true);
    expect(canTransitionTo("Running", "Stale")).toBe(false);
  });
});

describe("applyTransition", () => {
  it("Pending -> Queued (Enqueue)", () => {
    const pending: Pending = { kind: "Pending", attemptCount: 0, maxAttempts: 5 };
    const result = applyTransition(pending, "Enqueue", { queuedAt: "t" });
    expect(isRejected(result)).toBe(false);
    expect(result).toEqual({ kind: "Queued", queuedAt: "t" });
  });

  it("Pending -> Running increments attemptCount", () => {
    const pending: Pending = { kind: "Pending", attemptCount: 1, maxAttempts: 5 };
    const result = applyTransition(pending, "Start", { startedAt: "t" });
    expect(result).toMatchObject({ kind: "Running", attemptCount: 2, startedAt: "t" });
  });

  it("Failed -> Pending preserves attempts when resetAttempts is false", () => {
    const failed: Failed = {
      kind: "Failed",
      attemptCount: 3,
      maxAttempts: 5,
      errorCode: "X",
      errorMessage: "oops",
      retryable: true,
    };
    const result = applyTransition(failed, "Reset");
    expect(result).toMatchObject({ kind: "Pending", attemptCount: 3, maxAttempts: 5 });
  });

  it("Failed -> Pending zeroes attempts when resetAttempts is true", () => {
    const failed: Failed = {
      kind: "Failed",
      attemptCount: 3,
      maxAttempts: 5,
      errorCode: "X",
      errorMessage: "oops",
      retryable: true,
    };
    const result = applyTransition(failed, "Reset", { resetAttempts: true });
    expect(result).toMatchObject({ kind: "Pending", attemptCount: 0, maxAttempts: 5 });
  });

  it("Running -> Succeeded captures attemptCount from current Running state", () => {
    const running: Running = { kind: "Running", attemptCount: 4, startedAt: "t0" };
    const result = applyTransition(running, "Complete", { finishedAt: "t1", durationMs: 1000 });
    expect(result).toMatchObject({
      kind: "Succeeded",
      attemptCount: 4,
      finishedAt: "t1",
      durationMs: 1000,
    });
  });

  it("Succeeded -> Stale", () => {
    const succeeded: Succeeded = {
      kind: "Succeeded",
      attemptCount: 1,
      finishedAt: "t",
      durationMs: 0,
    };
    const result = applyTransition(succeeded, "MarkStale", { reason: "profile_changed" });
    expect(result).toEqual({ kind: "Stale", reason: "profile_changed" });
  });

  it("Stale -> Pending via Reset", () => {
    const stale: Stale = { kind: "Stale", reason: "x" };
    const result = applyTransition(stale, "Reset", { attemptCount: 0, maxAttempts: 3 });
    expect(result).toMatchObject({ kind: "Pending", attemptCount: 0, maxAttempts: 3 });
  });

  it("returns TransitionRejected for an illegal trigger", () => {
    const succeeded: Succeeded = {
      kind: "Succeeded",
      attemptCount: 1,
      finishedAt: "t",
      durationMs: 0,
    };
    const result = applyTransition(succeeded, "Reset");
    expect(isRejected(result)).toBe(true);
    if (isRejected(result)) {
      expect(result.attemptedTransition).toBe("Reset");
      expect(result.currentState).toBe(succeeded);
      expect(result.reason).toContain("not allowed");
    }
  });
});

describe("transitionStage helper", () => {
  it("returns ok=true with new state on success", () => {
    const out = transitionStage(
      { kind: "Pending", attemptCount: 0, maxAttempts: 3 },
      "Skip",
      { reason: "duplicate" },
    );
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.state).toEqual({ kind: "Skipped", reason: "duplicate" });
    }
  });

  it("returns ok=false with reason on rejection", () => {
    const out = transitionStage(
      { kind: "Skipped", reason: "x" },
      "Reset",
    );
    expect(out.ok).toBe(false);
    if (!out.ok) {
      expect(out.fromKind).toBe("Skipped");
      expect(out.trigger).toBe("Reset");
    }
  });
});
