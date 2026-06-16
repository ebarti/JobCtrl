/**
 * Operations / Read-Side projection types — TypeScript mirror.
 *
 * See ddd-target.md §4.8 / §6.6 and the Python source of truth at
 * ``workers/automation/src/jobhunter/domain/operations/projections.py``.
 *
 * Pure data shapes — no I/O.
 */
import type { TenantId } from "../tenant.js";
import type { RequirementFitReport, ScoreBreakdown } from "../scoring/index.js";

export interface StageProjection {
  readonly stage: string;
  readonly state: string;
  readonly attemptCount: number;
  readonly maxAttempts: number | null;
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryable: boolean;
  readonly blockedBy: readonly string[];
  readonly nextAction: string | null;
}

export interface JobListProjection {
  readonly tenantId: TenantId;
  readonly jobId: string;
  readonly title: string;
  readonly employer: string;
  readonly source: string;
  readonly strategy: string;
  readonly location: string;
  readonly salary: string;
  readonly applicationUrl: string | null;
  readonly discoveredAt: string | null;
  readonly description: string;
  readonly fullDescription: string;
  readonly fitScore: number | null;
  readonly scoreBreakdown: ScoreBreakdown | null;
  readonly scoreKeywords: readonly string[];
  readonly scoreReasoning: string;
  readonly scoreVersion: number | null;
  readonly scoredAt: string | null;
  readonly currentStage: string;
  readonly currentState: string;
  readonly currentErrorCode: string | null;
  readonly currentErrorMessage: string | null;
  readonly currentNextAction: string | null;
  readonly hasResume: boolean;
  readonly hasCoverLetter: boolean;
  readonly hasPdf: boolean;
  readonly applyStatus: string | null;
  readonly appliedAt: string | null;
  readonly artifactCount: number;
  readonly deletedAt: string | null;
  readonly lastUpdatedAt: string | null;
}

export interface DashboardFunnelStage {
  readonly stage: string;
  readonly total: number;
  readonly succeeded: number;
  readonly running: number;
  readonly pending: number;
  readonly blocked: number;
  readonly failed: number;
}

export interface DashboardProjection {
  readonly tenantId: TenantId;
  readonly totalJobs: number;
  readonly failures: number;
  readonly blocked: number;
  readonly ready: number;
  readonly applied: number;
  readonly dryRuns: number;
  readonly funnel: readonly DashboardFunnelStage[];
  readonly bySource: readonly (readonly [string, number])[];
  readonly scoreDistribution: readonly (readonly [number, number])[];
  readonly generatedAt: string;
}

export interface JobDetailProjection {
  readonly tenantId: TenantId;
  readonly jobId: string;
  readonly descriptionPreview: string;
  readonly scoreBreakdown: ScoreBreakdown | null;
  readonly scoreKeywords: readonly string[];
  readonly scoreReasoning: string;
  readonly scoreVersion: number | null;
  readonly scoredAt: string | null;
  readonly stages: readonly StageProjection[];
  readonly requirementFitReport: RequirementFitReport | null;
  readonly lastUpdatedAt: string | null;
}

export interface ArtifactListProjection {
  readonly artifactId: string;
  readonly tenantId: TenantId;
  readonly jobId: string;
  readonly jobTitle: string;
  readonly jobEmployer: string;
  readonly artifactType: string;
  readonly status: string;
  readonly localPath: string;
  readonly sizeBytes: number | null;
  readonly createdAt: string | null;
  readonly generation: number | null;
  readonly metadataJson: string | null;
}

export interface ApplyRunProjection {
  readonly runId: string;
  readonly tenantId: TenantId;
  readonly jobId: string;
  readonly jobTitle: string;
  readonly jobEmployer: string;
  readonly status: string;
  readonly result: string | null;
  readonly dryRun: boolean;
  readonly workerId: number | null;
  readonly model: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly events: readonly Record<string, unknown>[];
}

export const PROJECTION_TABLES = [
  "job_list_projections",
  "dashboard_projections",
  "job_detail_projections",
  "artifact_list_projections",
  "apply_run_projections",
] as const;
export type ProjectionTable = (typeof PROJECTION_TABLES)[number];

/** Watermark name shared between TS and Python projection refreshers. */
export const PROJECTION_WATERMARK_NAME = "operations_projections";
