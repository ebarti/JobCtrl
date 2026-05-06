/**
 * Domain event barrel — re-exports all bounded-context event types.
 */

export { type DomainEvent, createDomainEvent } from "./base.js";

export {
  type JobDiscoveredPayload,
  type JobDiscovered,
  createJobDiscovered,
  type JobUpdatedPayload,
  type JobUpdated,
  createJobUpdated,
  type JobDeletedPayload,
  type JobDeleted,
  createJobDeleted,
  type JobRestoredPayload,
  type JobRestored,
  createJobRestored,
} from "./discovery.js";

export {
  type JobEnrichedPayload,
  type JobEnriched,
  createJobEnriched,
  type EnrichmentFailedPayload,
  type EnrichmentFailed,
  createEnrichmentFailed,
} from "./enrichment.js";

export {
  type JobScoredPayload,
  type JobScored,
  createJobScored,
  type ScoreCorrectedPayload,
  type ScoreCorrected,
  createScoreCorrected,
} from "./scoring.js";

export {
  type ResumeApprovedPayload,
  type ResumeApproved,
  createResumeApproved,
  type ResumeFailedPayload,
  type ResumeFailed,
  createResumeFailed,
  type CoverLetterGeneratedPayload,
  type CoverLetterGenerated,
  createCoverLetterGenerated,
  type PdfRenderedPayload,
  type PdfRendered,
  createPdfRendered,
  type MaterialsExhaustedPayload,
  type MaterialsExhausted,
  createMaterialsExhausted,
} from "./materials.js";

export {
  type ApplicationSubmittedPayload,
  type ApplicationSubmitted,
  createApplicationSubmitted,
  type ApplicationFailedPayload,
  type ApplicationFailed,
  createApplicationFailed,
  type ApplyRunStartedPayload,
  type ApplyRunStarted,
  createApplyRunStarted,
  type ApplyRunEventRecordedPayload,
  type ApplyRunEventRecorded,
  createApplyRunEventRecorded,
} from "./apply.js";

export {
  type StageStartedPayload,
  type StageStarted,
  createStageStarted,
  type StageCompletedPayload,
  type StageCompleted,
  createStageCompleted,
  type StageFailedPayload,
  type StageFailed,
  createStageFailed,
  type StageExhaustedPayload,
  type StageExhausted,
  createStageExhausted,
  type StageResetPayload,
  type StageReset,
  createStageReset,
  type StageBlockedPayload,
  type StageBlocked,
  createStageBlocked,
  type StageSkippedPayload,
  type StageSkipped,
  createStageSkipped,
  type StageCanceledPayload,
  type StageCanceled,
  createStageCanceled,
} from "./orchestration.js";

export {
  type ProfileUpdatedPayload,
  type ProfileUpdated,
  createProfileUpdated,
  type ProfileImportedPayload,
  type ProfileImported,
  createProfileImported,
} from "./profile.js";

import type {
  JobDeleted,
  JobDiscovered,
  JobRestored,
  JobUpdated,
} from "./discovery.js";
import type { EnrichmentFailed, JobEnriched } from "./enrichment.js";
import type { JobScored, ScoreCorrected } from "./scoring.js";
import type {
  CoverLetterGenerated,
  MaterialsExhausted,
  PdfRendered,
  ResumeApproved,
  ResumeFailed,
} from "./materials.js";
import type {
  ApplicationFailed,
  ApplicationSubmitted,
  ApplyRunEventRecorded,
  ApplyRunStarted,
} from "./apply.js";
import type {
  StageBlocked,
  StageCanceled,
  StageCompleted,
  StageExhausted,
  StageFailed,
  StageReset,
  StageSkipped,
  StageStarted,
} from "./orchestration.js";
import type { ProfileImported, ProfileUpdated } from "./profile.js";

export type DomainEventUnion =
  | JobDiscovered
  | JobUpdated
  | JobDeleted
  | JobRestored
  | JobEnriched
  | EnrichmentFailed
  | JobScored
  | ScoreCorrected
  | ResumeApproved
  | ResumeFailed
  | CoverLetterGenerated
  | PdfRendered
  | MaterialsExhausted
  | ApplyRunStarted
  | ApplyRunEventRecorded
  | ApplicationSubmitted
  | ApplicationFailed
  | StageStarted
  | StageCompleted
  | StageFailed
  | StageExhausted
  | StageReset
  | StageBlocked
  | StageSkipped
  | StageCanceled
  | ProfileUpdated
  | ProfileImported;

export type DomainEventType = DomainEventUnion["eventType"];

export const DOMAIN_EVENT_TYPES = [
  "JobDiscovered",
  "JobUpdated",
  "JobDeleted",
  "JobRestored",
  "JobEnriched",
  "EnrichmentFailed",
  "JobScored",
  "ScoreCorrected",
  "ResumeApproved",
  "ResumeFailed",
  "CoverLetterGenerated",
  "PdfRendered",
  "MaterialsExhausted",
  "ApplyRunStarted",
  "ApplyRunEventRecorded",
  "ApplicationSubmitted",
  "ApplicationFailed",
  "StageStarted",
  "StageCompleted",
  "StageFailed",
  "StageExhausted",
  "StageReset",
  "StageBlocked",
  "StageSkipped",
  "StageCanceled",
  "ProfileUpdated",
  "ProfileImported",
] as const satisfies readonly DomainEventType[];

type EnumeratedDomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

type AssertEnumExhaustive = [DomainEventType] extends [EnumeratedDomainEventType]
  ? [EnumeratedDomainEventType] extends [DomainEventType]
    ? true
    : never
  : never;

const _assertExhaustive: AssertEnumExhaustive = true;
void _assertExhaustive;
