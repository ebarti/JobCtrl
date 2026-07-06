/**
 * Operations / Read-Side projection types — TypeScript mirror.
 *
 * See docs/architecture/domain-model/ §4.8 / §6.6 and the Python source of truth at
 * ``workers/automation/src/jobhunter/domain/operations/projections.py``.
 *
 * Pure data shapes — no I/O.
 */
import type { TenantId } from "../tenant.js";
import type { InterviewPrep } from "../interview/index.js";
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
  readonly applyMode: string | null;
  readonly resumeTemplateId: string | null;
  readonly resumeTemplateName: string | null;
  readonly tailoringPolicyVersion: number | null;
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
  readonly interviewPrep: InterviewPrep | null;
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
  readonly layoutBoxesJson: string | null;
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

/**
 * Read-side row for one contact (Contact & Outreach, ninth context).
 *
 * Derived data carrying NO attribute values (names, emails, notes live only in
 * `contact_attributes.value_json` on the canonical write side). It carries
 * identifiers, the link, the role, counts, the distinct source-kind set, and
 * per-attribute provenance metadata (INV-2). The read model joins this with
 * canonical attribute values at read time.
 */
export interface ContactProvenanceEntry {
  readonly attributeId: string;
  readonly attributeKind: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly captureMethod: string;
  readonly confidence: number;
  readonly userConfirmed: boolean;
  readonly recordedAt: string;
}

export interface ContactProjection {
  readonly tenantId: TenantId;
  readonly contactId: string;
  readonly employer: string | null;
  readonly jobId: string | null;
  readonly role: string;
  readonly attributeCount: number;
  readonly confirmedCount: number;
  readonly sourceKinds: readonly string[];
  readonly provenance: readonly ContactProvenanceEntry[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly lastUpdatedAt: string | null;
}

/**
 * Read-side row for one supervised research task (Contact & Outreach, ninth
 * context). Carries NO candidate attribute values (names, emails live only in
 * `contact_candidates.attributes_json` on the canonical write side): the task
 * lifecycle, counts, the source-attempt outcomes (provenance of the search),
 * and per-candidate provenance metadata (INV-2). The read model joins canonical
 * candidate values at read time.
 */
export interface ContactResearchSourceAttemptEntry {
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly outcome: string;
  readonly attemptedAt: string;
  readonly detail: string;
}

export interface ContactResearchCandidateEntry {
  readonly candidateId: string;
  readonly role: string;
  readonly sourceKind: string;
  readonly sourceRef: string;
  readonly captureMethod: string;
  readonly confidence: number;
  readonly status: string;
  readonly proposedAt: string;
  readonly confirmedContactId: string | null;
  readonly confirmedAt: string | null;
  readonly attributeKinds: readonly string[];
}

export interface ContactResearchTaskProjection {
  readonly tenantId: TenantId;
  readonly taskId: string;
  readonly employer: string | null;
  readonly jobId: string | null;
  readonly status: string;
  readonly candidateCount: number;
  readonly needsReviewCount: number;
  readonly confirmedCount: number;
  readonly sourceAttempts: readonly ContactResearchSourceAttemptEntry[];
  readonly candidates: readonly ContactResearchCandidateEntry[];
  readonly startedAt: string | null;
  readonly updatedAt: string | null;
  readonly needsReviewAt: string | null;
  readonly completedAt: string | null;
  readonly failedAt: string | null;
  readonly errorClass: string | null;
  readonly lastUpdatedAt: string | null;
}

/**
 * Read-side row for one outreach thread (Contact & Outreach, ninth context).
 *
 * Carries the thread lifecycle SUMMARY plus per-draft METADATA — never the draft
 * body, gate internals, or claim provenance (those live only in canonical
 * `outreach_drafts` and are joined at DETAIL read time, exactly like research
 * candidates). `latestStatus` is the highest-generation draft's status;
 * `gatePassed` on each entry is the persisted gate outcome (INV-5) surfaced for
 * the review UI.
 */
export interface OutreachDraftMetadataEntry {
  readonly draftId: string;
  readonly generation: number;
  readonly kind: string;
  readonly status: string;
  readonly gatePassed: boolean;
  readonly createdAt: string | null;
  readonly approvedAt: string | null;
  readonly rejectedAt: string | null;
}

export interface OutreachThreadProjection {
  readonly tenantId: TenantId;
  readonly threadId: string;
  readonly contactId: string;
  readonly jobId: string | null;
  readonly draftCount: number;
  readonly latestGeneration: number;
  readonly hasApprovedDraft: boolean;
  readonly approvedDraftId: string | null;
  readonly latestStatus: string | null;
  readonly drafts: readonly OutreachDraftMetadataEntry[];
  readonly createdAt: string | null;
  readonly updatedAt: string | null;
  readonly lastUpdatedAt: string | null;
}

export const PROJECTION_TABLES = [
  "job_list_projections",
  "dashboard_projections",
  "job_detail_projections",
  "artifact_list_projections",
  "evidence_usage_projections",
  "apply_run_projections",
  "contact_projections",
  "contact_research_task_projections",
  "outreach_thread_projections",
] as const;
export type ProjectionTable = (typeof PROJECTION_TABLES)[number];

/** Watermark name shared between TS and Python projection refreshers. */
export const PROJECTION_WATERMARK_NAME = "operations_projections";
