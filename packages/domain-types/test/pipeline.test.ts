import { describe, it, expect } from "vitest";
import {
  STAGES,
  STAGE_STATE_KINDS,
  serializeStage,
  deserializeStage,
  serializeStageState,
  deserializeStageStateKind,
  type Stage,
  type StageState,
  type Pending,
  type Queued,
  type Running,
  type Succeeded,
  type Failed,
  type Blocked,
  type Skipped,
  type Exhausted,
  type Stale,
  type Canceled,
} from "../src/pipeline.js";

describe("Stage", () => {
  it("has exactly 6 pipeline stages", () => {
    expect(STAGES).toHaveLength(6);
  });

  it("contains all canonical stages in order", () => {
    expect(STAGES).toEqual([
      "Discover",
      "Enrich",
      "Score",
      "Tailor",
      "Cover",
      "Apply",
    ]);
  });

  it("serializeStage maps PascalCase to lowercase", () => {
    expect(serializeStage("Discover")).toBe("discover");
    expect(serializeStage("Apply")).toBe("apply");
  });

  it("deserializeStage maps lowercase to PascalCase", () => {
    expect(deserializeStage("discover")).toBe("Discover");
    expect(deserializeStage("apply")).toBe("Apply");
  });

  it("serializeStage round-trips through deserializeStage", () => {
    for (const stage of STAGES) {
      expect(deserializeStage(serializeStage(stage))).toBe(stage);
    }
  });

  it("deserializeStage throws on invalid input", () => {
    expect(() => deserializeStage("invalid")).toThrow(
      'Invalid serialized stage: "invalid"',
    );
  });
});

describe("StageState", () => {
  it("has exactly 10 state kinds", () => {
    expect(STAGE_STATE_KINDS).toHaveLength(10);
  });

  it("contains all canonical state kinds", () => {
    expect(STAGE_STATE_KINDS).toEqual([
      "Pending",
      "Queued",
      "Running",
      "Succeeded",
      "Failed",
      "Blocked",
      "Skipped",
      "Exhausted",
      "Stale",
      "Canceled",
    ]);
  });

  it("each variant can be constructed with required fields", () => {
    const pending: Pending = {
      kind: "Pending",
      attemptCount: 0,
      maxAttempts: 3,
    };
    const queued: Queued = { kind: "Queued", queuedAt: "2025-01-01T00:00:00Z" };
    const running: Running = {
      kind: "Running",
      attemptCount: 1,
      startedAt: "2025-01-01T00:00:00Z",
    };
    const succeeded: Succeeded = {
      kind: "Succeeded",
      attemptCount: 1,
      finishedAt: "2025-01-01T00:00:00Z",
      durationMs: 1000,
    };
    const failed: Failed = {
      kind: "Failed",
      attemptCount: 1,
      maxAttempts: 3,
      errorCode: "ERR",
      errorMessage: "boom",
      retryable: true,
    };
    const blocked: Blocked = {
      kind: "Blocked",
      blockedBy: ["Discover"],
      errorCode: "UPSTREAM",
      errorMessage: "upstream not done",
    };
    const skipped: Skipped = {
      kind: "Skipped",
      reason: "below threshold",
    };
    const exhausted: Exhausted = {
      kind: "Exhausted",
      attemptCount: 3,
      maxAttempts: 3,
      errorCode: "MAX",
      errorMessage: "max attempts",
    };
    const stale: Stale = { kind: "Stale", reason: "upstream re-ran" };
    const canceled: Canceled = {
      kind: "Canceled",
      canceledAt: "2025-01-01T00:00:00Z",
    };

    // All should be assignable to StageState
    const states: StageState[] = [
      pending,
      queued,
      running,
      succeeded,
      failed,
      blocked,
      skipped,
      exhausted,
      stale,
      canceled,
    ];
    expect(states).toHaveLength(10);
  });

  it("serializeStageState lowercases the kind", () => {
    const state: StageState = { kind: "Pending", attemptCount: 0, maxAttempts: 3 };
    expect(serializeStageState(state)).toBe("pending");
  });

  it("deserializeStageStateKind maps lowercase to PascalCase", () => {
    expect(deserializeStageStateKind("pending")).toBe("Pending");
    expect(deserializeStageStateKind("canceled")).toBe("Canceled");
    expect(deserializeStageStateKind("exhausted")).toBe("Exhausted");
  });

  it("deserializeStageStateKind throws on invalid input", () => {
    expect(() => deserializeStageStateKind("nope")).toThrow(
      'Invalid serialized stage state: "nope"',
    );
  });
});
