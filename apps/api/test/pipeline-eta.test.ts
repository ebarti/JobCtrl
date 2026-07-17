import { describe, expect, it } from "vitest";

import {
  PIPELINE_ETA_MAX_SAMPLES,
  PIPELINE_ETA_MINIMUM_SAMPLES,
  estimatePipelineEta,
  nearestRankPercentile,
  roundEtaRangeSeconds,
  type PipelineEtaDurationSample,
  type PipelineEtaEstimatorInput,
  type PipelineEtaStageInput,
} from "../src/pipeline-eta.js";

const AS_OF = "2026-07-14T12:00:00.000Z";

function sample(
  durationMs: number,
  options: Partial<PipelineEtaDurationSample> = {},
): PipelineEtaDurationSample {
  return {
    source: "job_stage_state",
    succeeded: true,
    durationMs,
    completedAt: "2026-07-14T11:59:00.000Z",
    ...options,
  };
}

function stage(
  options: Partial<PipelineEtaStageInput> = {},
): PipelineEtaStageInput {
  return {
    stage: "score",
    remainingCurrentStage: 1,
    primaryEvidence: "job_stage_state",
    samples: Array.from({ length: PIPELINE_ETA_MINIMUM_SAMPLES }, () => sample(600_000)),
    ...options,
  };
}

function input(overrides: Partial<PipelineEtaEstimatorInput> = {}): PipelineEtaEstimatorInput {
  const stages = overrides.stages ?? [stage()];
  return {
    asOf: AS_OF,
    scope: "known",
    membershipOpen: false,
    telemetryFresh: true,
    workerAvailable: true,
    budgetAvailable: true,
    blocked: false,
    dispatchObserved: true,
    runtimeActiveWork: false,
    configuredSlots: 1,
    stages,
    remainingPaths: [{ stageIds: ["score"] }],
    contention: { kind: "bounded", existingBacklog: [], retries: [], queuePresent: false },
    ...overrides,
  };
}

describe("estimatePipelineEta", () => {
  it("applies gate order before attempting any calculation", () => {
    expect(
      estimatePipelineEta(
        input({
          scope: "unknown",
          stages: [stage({ remainingCurrentStage: 0 })],
          telemetryFresh: false,
          workerAvailable: false,
        }),
      ),
    ).toMatchObject({ status: "unavailable", reason: "unknown_scope" });

    expect(
      estimatePipelineEta(input({ stages: [stage({ remainingCurrentStage: 0 })], telemetryFresh: false })),
    ).toMatchObject({ status: "unavailable", reason: "no_work" });

    expect(
      estimatePipelineEta(input({ telemetryFresh: false, workerAvailable: false })),
    ).toMatchObject({ status: "stale", reason: "telemetry_stale" });

    expect(
      estimatePipelineEta(
        input({
          workerAvailable: false,
          budgetAvailable: false,
          blocked: true,
          dispatchObserved: false,
          contention: { kind: "unresolved" },
        }),
      ),
    ).toMatchObject({ status: "paused", reason: "worker_unavailable" });
  });

  it("keeps the overall ETA calibrating while terminal fanout membership is open", () => {
    expect(estimatePipelineEta(input({ membershipOpen: true }))).toMatchObject({
      status: "calibrating",
      reason: "membership_open",
      completedSamples: PIPELINE_ETA_MINIMUM_SAMPLES,
    });

    expect(estimatePipelineEta(input({ membershipOpen: false }))).toMatchObject({ status: "available" });
  });

  it("does not treat open membership or runtime-only activity as proof of no work", () => {
    expect(
      estimatePipelineEta(input({
        membershipOpen: true,
        stages: [stage({ remainingCurrentStage: 0 })],
        remainingPaths: [],
      })),
    ).toEqual({
      status: "calibrating",
      reason: "membership_open",
      completedSamples: 0,
      minimumSamples: PIPELINE_ETA_MINIMUM_SAMPLES,
      asOf: AS_OF,
    });

    expect(
      estimatePipelineEta(input({
        runtimeActiveWork: true,
        stages: [stage({ remainingCurrentStage: 0 })],
        remainingPaths: [],
      })),
    ).toEqual({ status: "unavailable", reason: "unknown_scope", asOf: AS_OF });
  });

  it("returns no_work instead of a zero-duration range", () => {
    expect(
      estimatePipelineEta(input({ stages: [stage({ remainingCurrentStage: 0 })] })),
    ).toEqual({ status: "unavailable", reason: "no_work", asOf: AS_OF });
  });

  it("returns stale telemetry before evaluating worker or sample state", () => {
    expect(
      estimatePipelineEta(input({ telemetryFresh: false, stages: [stage({ samples: [] })] })),
    ).toEqual({ status: "stale", reason: "telemetry_stale", asOf: AS_OF });
  });

  it.each([
    ["workerAvailable", false, "worker_unavailable"],
    ["budgetAvailable", false, "budget_exceeded"],
    ["blocked", true, "blocked"],
    ["dispatchObserved", false, "no_dispatch"],
  ] as const)("pauses for %s", (key, value, reason) => {
    const overrides = { [key]: value } as Partial<PipelineEtaEstimatorInput>;
    expect(estimatePipelineEta(input(overrides))).toEqual({ status: "paused", reason, asOf: AS_OF });
  });

  it.each(["unknown", "truncated", "unresolved"] as const)(
    "does not invent a range for %s external contention",
    (kind) => {
      expect(estimatePipelineEta(input({ contention: { kind } }))).toEqual({
        status: "unavailable",
        reason: "contention_unbounded",
        asOf: AS_OF,
      });
    },
  );

  it("calibrates on the minimum primary evidence without unioning metric fallback", () => {
    const primary = Array.from({ length: 4 }, () => sample(600_000));
    const metrics = Array.from({ length: 12 }, () =>
      sample(60_000, { source: "operational_attempt_metric" }),
    );
    expect(estimatePipelineEta(input({ stages: [stage({ samples: [...primary, ...metrics] })] }))).toMatchObject({
      status: "calibrating",
      reason: "insufficient_samples",
      completedSamples: 4,
      minimumSamples: 5,
    });
  });

  it("uses operational metrics only when primary stage evidence is absent", () => {
    const metrics = Array.from({ length: PIPELINE_ETA_MINIMUM_SAMPLES }, () =>
      sample(600_000, { source: "operational_attempt_metric" }),
    );
    expect(estimatePipelineEta(input({ stages: [stage({ samples: metrics })] }))).toMatchObject({
      status: "available",
      sampleSize: PIPELINE_ETA_MINIMUM_SAMPLES,
    });
  });

  it.each(["source_family", "preparation_fanout", "pdf_render"])(
    "uses pipeline step projections as primary evidence for %s steps",
    (stepName) => {
      const projections = Array.from({ length: 4 }, () =>
        sample(600_000, { source: "pipeline_step_projection" }),
      );
      const metrics = Array.from({ length: 12 }, () =>
        sample(60_000, { source: "operational_attempt_metric" }),
      );
      expect(
        estimatePipelineEta(
          input({
            stages: [
              stage({
                stage: stepName,
                primaryEvidence: "pipeline_step_projection",
                samples: [...projections, ...metrics],
              }),
            ],
            remainingPaths: [{ stageIds: [stepName] }],
          }),
        ),
      ).toMatchObject({ status: "calibrating", completedSamples: 4 });
    },
  );

  it("uses nearest-rank percentiles and only the newest fifty valid samples in the fourteen-day window", () => {
    expect(nearestRankPercentile([100, 200, 300, 400, 500], 50)).toBe(300);
    expect(nearestRankPercentile([100, 200, 300, 400, 500], 90)).toBe(500);

    const newest = Array.from({ length: PIPELINE_ETA_MAX_SAMPLES }, (_, index) =>
      sample(600_000, {
        completedAt: `2026-07-14T11:${String(index % 60).padStart(2, "0")}:00.000Z`,
      }),
    );
    const olderButInWindow = Array.from({ length: 10 }, () =>
      sample(9_999_000, { completedAt: "2026-07-13T00:00:00.000Z" }),
    );
    const expired = sample(9_999_000, { completedAt: "2026-06-29T11:59:00.000Z" });
    const result = estimatePipelineEta(
      input({ stages: [stage({ samples: [...newest, ...olderButInWindow, expired] })] }),
    );
    expect(result).toMatchObject({
      status: "available",
      sampleSize: PIPELINE_ETA_MAX_SAMPLES,
      lowSeconds: 600,
      highSeconds: 660,
    });
  });

  it("rounds ranges outward and retains one displayed increment for an otherwise exact result", () => {
    expect(roundEtaRangeSeconds(61, 119)).toEqual({ lowSeconds: 60, highSeconds: 120 });
    expect(roundEtaRangeSeconds(60, 60)).toEqual({ lowSeconds: 60, highSeconds: 120 });
    expect(roundEtaRangeSeconds(3_601, 3_601)).toEqual({ lowSeconds: 3_600, highSeconds: 3_900 });
  });

  it("uses the shared-pool lower bound as well as the longest remaining path", () => {
    const result = estimatePipelineEta(
      input({
        configuredSlots: 4,
        stages: [stage({ remainingCurrentStage: 8 })],
      }),
    );
    expect(result).toMatchObject({ status: "available", lowSeconds: 1_200 });
  });

  it("adds bounded existing-backlog and retry demand before applying the pool bound to the high range", () => {
    const result = estimatePipelineEta(
      input({
        configuredSlots: 4,
        stages: [stage({ remainingCurrentStage: 4 })],
        contention: {
          kind: "bounded",
          existingBacklog: [{ stage: "score", count: 1 }],
          retries: [{ stage: "score", count: 2 }],
          queuePresent: false,
        },
      }),
    );
    expect(result).toMatchObject({
      status: "available",
      lowSeconds: 600,
      highSeconds: 1_080,
      caveat: expect.any(String),
    });
  });

  it("sets confidence from per-stage sample support and bounded contention", () => {
    const highSamples = Array.from({ length: 20 }, () => sample(600_000));
    const mediumSamples = Array.from({ length: 10 }, () => sample(600_000));
    const lowSamples = Array.from({ length: 5 }, () => sample(600_000));

    expect(estimatePipelineEta(input({ stages: [stage({ samples: highSamples })] }))).toMatchObject({
      status: "available",
      confidence: "high",
    });
    expect(
      estimatePipelineEta(
        input({
          stages: [stage({ samples: mediumSamples })],
          contention: { kind: "bounded", existingBacklog: [], retries: [], queuePresent: true },
        }),
      ),
    ).toMatchObject({ status: "available", confidence: "medium" });
    expect(estimatePipelineEta(input({ stages: [stage({ samples: lowSamples })] }))).toMatchObject({
      status: "available",
      confidence: "low",
    });
  });
});
