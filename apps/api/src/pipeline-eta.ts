/**
 * Pure, explainable ETA estimation for the pipeline operations read model.
 *
 * This module deliberately receives already bounded projection/telemetry facts;
 * it neither opens a database nor reaches Temporal.  Keeping evidence selection
 * here makes the estimator's source and fallback rules testable in isolation.
 */

export const PIPELINE_ETA_ESTIMATOR_VERSION = "pipeline-eta-v1" as const;
export const PIPELINE_ETA_MINIMUM_SAMPLES = 5;
export const PIPELINE_ETA_MAX_SAMPLES = 50;
export const PIPELINE_ETA_SAMPLE_WINDOW_MS = 14 * 24 * 60 * 60 * 1_000;

export type PipelineEtaEvidenceSource =
  | "job_stage_state"
  | "pipeline_step_projection"
  | "operational_attempt_metric";

/** A terminal duration candidate supplied by the operations read model. */
export interface PipelineEtaDurationSample {
  readonly source: PipelineEtaEvidenceSource;
  readonly succeeded: boolean;
  readonly durationMs: number | null;
  readonly completedAt: string;
}

/**
 * A unit of current-cohort service demand.  `primaryEvidence` ensures canonical
 * stage rows and orchestration-step projections stay separate; operational
 * metrics are considered only when the primary source has no usable evidence.
 */
export interface PipelineEtaStageInput {
  readonly stage: string;
  readonly remainingCurrentStage: number;
  readonly primaryEvidence: Exclude<PipelineEtaEvidenceSource, "operational_attempt_metric">;
  readonly samples: readonly PipelineEtaDurationSample[];
}

/** The remaining required stage sequence for one current-cohort job. */
export interface PipelineEtaRemainingPath {
  readonly stageIds: readonly string[];
}

/** Bounded external work that competes for the same shared activity slots. */
export interface PipelineEtaBoundedContention {
  readonly kind: "bounded";
  readonly existingBacklog: readonly PipelineEtaStageDemand[];
  readonly retries: readonly PipelineEtaStageDemand[];
  /** Approximate infrastructure queue work was observed, even if its count is zero. */
  readonly queuePresent: boolean;
}

export interface PipelineEtaStageDemand {
  readonly stage: string;
  readonly count: number;
}

/** A missing, truncated, or unresolved queue-ahead observation cannot be bounded safely. */
export interface PipelineEtaUnboundedContention {
  readonly kind: "unknown" | "truncated" | "unresolved";
}

export type PipelineEtaContention = PipelineEtaBoundedContention | PipelineEtaUnboundedContention;

/** All data needed to estimate one current execution without database access. */
export interface PipelineEtaEstimatorInput {
  readonly asOf: string;
  readonly scope: "known" | "unknown";
  /** True until terminal reconciliation has closed the execution's job membership. */
  readonly membershipOpen: boolean;
  readonly telemetryFresh: boolean;
  readonly workerAvailable: boolean;
  readonly budgetAvailable: boolean;
  readonly blocked: boolean;
  readonly dispatchObserved: boolean;
  /** Fresh runtime proves work exists even when durable projection coverage is incomplete. */
  readonly runtimeActiveWork: boolean;
  readonly configuredSlots: number | null;
  readonly stages: readonly PipelineEtaStageInput[];
  readonly remainingPaths: readonly PipelineEtaRemainingPath[];
  readonly contention: PipelineEtaContention;
}

/** Structural counterpart of the shared `PipelineEta` API union. */
export type PipelineEtaEstimate =
  | {
      readonly status: "available";
      readonly lowSeconds: number;
      readonly highSeconds: number;
      readonly confidence: "low" | "medium" | "high";
      readonly basis: "source_rate" | "stage_throughput" | "cohort_throughput";
      readonly sampleSize: number;
      readonly asOf: string;
      readonly caveat: string | null;
    }
  | {
      readonly status: "calibrating";
      readonly reason: "insufficient_samples" | "membership_open";
      readonly completedSamples: number;
      readonly minimumSamples: number;
      readonly asOf: string;
    }
  | {
      readonly status: "paused";
      readonly reason: "worker_unavailable" | "budget_exceeded" | "blocked" | "no_dispatch";
      readonly asOf: string;
    }
  | {
      readonly status: "stale";
      readonly reason: "telemetry_stale" | "observation_stale" | "unknown_scope";
      readonly asOf: string;
    }
  | {
      readonly status: "unavailable";
      readonly reason: "no_work" | "telemetry_stale" | "unsupported" | "unknown_scope" | "contention_unbounded";
      readonly asOf: string;
    };

type StageEstimate = {
  readonly stage: string;
  readonly sampleSize: number;
  readonly p50Ms: number | null;
  readonly p90Ms: number | null;
};

/**
 * Selects a percentile with the nearest-rank method. Invalid/empty input has no
 * percentile rather than a fabricated zero.
 */
export function nearestRankPercentile(values: readonly number[], percentile: number): number | null {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) return null;
  const sorted = values.filter(isPositiveFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  return sorted[Math.ceil((percentile / 100) * sorted.length) - 1] ?? null;
}

/**
 * Round a non-zero ETA range outward. Below one hour the display unit is one
 * minute; one hour and above it is five minutes. Equal bounds retain one unit
 * of uncertainty rather than becoming a misleading exact estimate.
 */
export function roundEtaRangeSeconds(
  lowSeconds: number,
  highSeconds: number,
): { lowSeconds: number; highSeconds: number } | null {
  if (!Number.isFinite(lowSeconds) || !Number.isFinite(highSeconds) || lowSeconds < 0 || highSeconds < lowSeconds) {
    return null;
  }

  const lowIncrement = etaRoundingIncrement(lowSeconds);
  const highIncrement = etaRoundingIncrement(highSeconds);
  const low = Math.floor(lowSeconds / lowIncrement) * lowIncrement;
  let high = Math.ceil(highSeconds / highIncrement) * highIncrement;

  if (highSeconds > 0 && high <= low) {
    high = low + etaRoundingIncrement(low);
  }

  return { lowSeconds: low, highSeconds: high };
}

/**
 * Computes an honest range or an explicit non-estimate. Gate ordering is
 * intentional: a more fundamental unknown wins over downstream calculations.
 */
export function estimatePipelineEta(input: PipelineEtaEstimatorInput): PipelineEtaEstimate {
  const activeStages = input.stages.filter((stage) => normalizedCount(stage.remainingCurrentStage) > 0);

  // Unknown scope and a closed, projection-complete zero remain proof-level
  // answers even when the last telemetry sample is stale. Open membership or
  // fresh runtime activity make a projection zero inconclusive, not no work.
  if (input.scope === "unknown") return unavailable(input.asOf, "unknown_scope");
  if (activeStages.length === 0 && !input.runtimeActiveWork && !input.membershipOpen) {
    return unavailable(input.asOf, "no_work");
  }
  if (!input.telemetryFresh) return stale(input.asOf, "telemetry_stale");

  // A pause is more useful than a numeric range when the current cohort cannot progress.
  if (!input.workerAvailable) return paused(input.asOf, "worker_unavailable");
  if (!input.budgetAvailable) return paused(input.asOf, "budget_exceeded");
  if (input.blocked) return paused(input.asOf, "blocked");
  if (!input.dispatchObserved) return paused(input.asOf, "no_dispatch");

  if (input.contention.kind !== "bounded") return unavailable(input.asOf, "contention_unbounded");

  const stageEstimates = input.stages.map((stage) => estimateStage(stage, input.asOf));
  const estimatesByStage = new Map(stageEstimates.map((estimate) => [estimate.stage, estimate]));
  const paths = normalizedPaths(input.remainingPaths, activeStages);
  const pathStageIds = new Set(paths.flatMap((path) => path.stageIds));
  const relevantStageIds = new Set([...activeStages.map((stage) => stage.stage), ...pathStageIds]);
  const relevantEstimates = [...relevantStageIds].map((stage) => estimatesByStage.get(stage));

  if (relevantEstimates.some((estimate) => estimate === undefined)) {
    return unavailable(input.asOf, "unknown_scope");
  }

  const completeEstimates = relevantEstimates.filter((estimate): estimate is StageEstimate => estimate !== undefined);
  const completedSamples = completeEstimates.length > 0
    ? Math.min(...completeEstimates.map((estimate) => estimate.sampleSize))
    : 0;

  // Membership remains provisional even with sufficient service-time evidence.
  if (input.membershipOpen) {
    return calibrating(input.asOf, "membership_open", completedSamples);
  }

  // Runtime-only work has a known activity classification but no durable
  // quantity or execution scope from which a numeric estimate can be built.
  if (activeStages.length === 0) return unavailable(input.asOf, "unknown_scope");

  if (
    completeEstimates.some(
      (estimate) => estimate.sampleSize < PIPELINE_ETA_MINIMUM_SAMPLES || estimate.p50Ms === null || estimate.p90Ms === null,
    )
  ) {
    return calibrating(input.asOf, "insufficient_samples", completedSamples);
  }

  const configuredSlots = normalizedCount(input.configuredSlots ?? 0);
  if (configuredSlots === 0) return unavailable(input.asOf, "unsupported");

  const externalDemand = boundedExternalDemand(input.contention, estimatesByStage);
  if (externalDemand === null) return unavailable(input.asOf, "contention_unbounded");

  const currentDemand = activeStages.reduce(
    (total, stage) => {
      const estimate = estimatesByStage.get(stage.stage);
      return total + normalizedCount(stage.remainingCurrentStage) * (estimate?.p50Ms ?? 0);
    },
    0,
  );
  const currentDemandP90 = activeStages.reduce(
    (total, stage) => {
      const estimate = estimatesByStage.get(stage.stage);
      return total + normalizedCount(stage.remainingCurrentStage) * (estimate?.p90Ms ?? 0);
    },
    0,
  );
  const longestPathP50 = longestPathDemand(paths, estimatesByStage, "p50Ms");
  const longestPathP90 = longestPathDemand(paths, estimatesByStage, "p90Ms");

  if (longestPathP50 === null || longestPathP90 === null) return unavailable(input.asOf, "unknown_scope");

  const rawLowSeconds = Math.max(currentDemand / configuredSlots, longestPathP50) / 1_000;
  const rawHighSeconds = Math.max(
    (currentDemandP90 + externalDemand) / configuredSlots,
    longestPathP90,
    rawLowSeconds * 1_000,
  ) / 1_000;
  const rounded = roundEtaRangeSeconds(rawLowSeconds, rawHighSeconds);
  if (!rounded || rounded.highSeconds === 0) return unavailable(input.asOf, "unsupported");

  return {
    status: "available",
    ...rounded,
    confidence: confidenceFor(completeEstimates, input.contention),
    basis: "stage_throughput",
    sampleSize: completeEstimates.reduce((total, estimate) => total + estimate.sampleSize, 0),
    asOf: input.asOf,
    caveat: externalContentionCaveat(input.contention),
  };
}

function estimateStage(stage: PipelineEtaStageInput, asOf: string): StageEstimate {
  const samples = selectedSamples(stage, asOf);
  return {
    stage: stage.stage,
    sampleSize: samples.length,
    p50Ms: nearestRankPercentile(samples, 50),
    p90Ms: nearestRankPercentile(samples, 90),
  };
}

function selectedSamples(stage: PipelineEtaStageInput, asOf: string): number[] {
  const cutoff = Date.parse(asOf) - PIPELINE_ETA_SAMPLE_WINDOW_MS;
  const asOfMs = Date.parse(asOf);
  if (!Number.isFinite(cutoff) || !Number.isFinite(asOfMs)) return [];

  const usable = stage.samples.filter((sample) => {
    const completedAt = Date.parse(sample.completedAt);
    return (
      sample.succeeded &&
      isPositiveFinite(sample.durationMs) &&
      Number.isFinite(completedAt) &&
      completedAt >= cutoff &&
      completedAt <= asOfMs
    );
  });
  const primary = newestDurations(usable.filter((sample) => sample.source === stage.primaryEvidence));

  // Metrics remain a true fallback. They never inflate or blend canonical evidence.
  return primary.length > 0
    ? primary
    : newestDurations(usable.filter((sample) => sample.source === "operational_attempt_metric"));
}

function newestDurations(samples: readonly PipelineEtaDurationSample[]): number[] {
  return [...samples]
    .sort((left, right) => Date.parse(right.completedAt) - Date.parse(left.completedAt))
    .slice(0, PIPELINE_ETA_MAX_SAMPLES)
    .map((sample) => sample.durationMs)
    .filter((durationMs): durationMs is number => isPositiveFinite(durationMs));
}

function normalizedPaths(
  paths: readonly PipelineEtaRemainingPath[],
  activeStages: readonly PipelineEtaStageInput[],
): readonly PipelineEtaRemainingPath[] {
  const validPaths = paths.filter((path) => path.stageIds.length > 0);
  return validPaths.length > 0 ? validPaths : activeStages.map((stage) => ({ stageIds: [stage.stage] }));
}

function boundedExternalDemand(
  contention: PipelineEtaBoundedContention,
  estimatesByStage: ReadonlyMap<string, StageEstimate>,
): number | null {
  let demand = 0;
  for (const work of [...contention.existingBacklog, ...contention.retries]) {
    const count = normalizedCount(work.count);
    if (count === 0) continue;
    const stage = estimatesByStage.get(work.stage);
    if (!stage || stage.p90Ms === null) return null;
    demand += count * stage.p90Ms;
  }
  return demand;
}

function longestPathDemand(
  paths: readonly PipelineEtaRemainingPath[],
  estimatesByStage: ReadonlyMap<string, StageEstimate>,
  percentile: "p50Ms" | "p90Ms",
): number | null {
  let longest = 0;
  for (const path of paths) {
    let demand = 0;
    for (const stageId of path.stageIds) {
      const stage = estimatesByStage.get(stageId);
      const duration = stage?.[percentile];
      if (duration === null || duration === undefined) return null;
      demand += duration;
    }
    longest = Math.max(longest, demand);
  }
  return longest;
}

function confidenceFor(
  estimates: readonly StageEstimate[],
  contention: PipelineEtaBoundedContention,
): "low" | "medium" | "high" {
  const minimumStageSamples = Math.min(...estimates.map((estimate) => estimate.sampleSize));
  const hasExternalContention =
    contention.queuePresent ||
    contention.existingBacklog.some((work) => normalizedCount(work.count) > 0) ||
    contention.retries.some((work) => normalizedCount(work.count) > 0);

  if (minimumStageSamples >= 20 && !hasExternalContention) return "high";
  if (minimumStageSamples >= 10) return "medium";
  return "low";
}

function externalContentionCaveat(contention: PipelineEtaBoundedContention): string | null {
  return contention.queuePresent ||
    contention.existingBacklog.some((work) => normalizedCount(work.count) > 0) ||
    contention.retries.some((work) => normalizedCount(work.count) > 0)
    ? "Includes bounded external backlog, retry, or queue contention."
    : null;
}

function etaRoundingIncrement(seconds: number): number {
  return seconds >= 60 * 60 ? 5 * 60 : 60;
}

function normalizedCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function isPositiveFinite(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function unavailable(
  asOf: string,
  reason: Extract<PipelineEtaEstimate, { status: "unavailable" }> ["reason"],
): Extract<PipelineEtaEstimate, { status: "unavailable" }> {
  return { status: "unavailable", reason, asOf };
}

function stale(
  asOf: string,
  reason: Extract<PipelineEtaEstimate, { status: "stale" }> ["reason"],
): Extract<PipelineEtaEstimate, { status: "stale" }> {
  return { status: "stale", reason, asOf };
}

function paused(
  asOf: string,
  reason: Extract<PipelineEtaEstimate, { status: "paused" }> ["reason"],
): Extract<PipelineEtaEstimate, { status: "paused" }> {
  return { status: "paused", reason, asOf };
}

function calibrating(
  asOf: string,
  reason: Extract<PipelineEtaEstimate, { status: "calibrating" }> ["reason"],
  completedSamples: number,
): Extract<PipelineEtaEstimate, { status: "calibrating" }> {
  return {
    status: "calibrating",
    reason,
    completedSamples: Math.max(0, completedSamples),
    minimumSamples: PIPELINE_ETA_MINIMUM_SAMPLES,
    asOf,
  };
}
