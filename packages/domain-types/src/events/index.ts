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
  type SourceLocationCandidateDiscoveredPayload,
  type SourceLocationCandidateDiscovered,
  createSourceLocationCandidateDiscovered,
  type SourceLocationCandidatePromotedPayload,
  type SourceLocationCandidatePromoted,
  createSourceLocationCandidatePromoted,
  type SourceRegistryEntryCreatedPayload,
  type SourceRegistryEntryCreated,
  createSourceRegistryEntryCreated,
  type SourceRegistryEntryUpdatedPayload,
  type SourceRegistryEntryUpdated,
  createSourceRegistryEntryUpdated,
  type SourceStateChangedPayload,
  type SourceStateChanged,
  createSourceStateChanged,
  type JobSourceObservedPayload,
  type JobSourceObserved,
  createJobSourceObserved,
  type DiscoveryRunStartedPayload,
  type DiscoveryRunStarted,
  createDiscoveryRunStarted,
  type DiscoveryRunCounts,
  type DiscoveryRunCompletedPayload,
  type DiscoveryRunCompleted,
  createDiscoveryRunCompleted,
  type DiscoveryRunFailedPayload,
  type DiscoveryRunFailed,
  createDiscoveryRunFailed,
  type CanonicalJobIdentityResolvedPayload,
  type CanonicalJobIdentityResolved,
  createCanonicalJobIdentityResolved,
  type DuplicateJobLinkedPayload,
  type DuplicateJobLinked,
  createDuplicateJobLinked,
  type DuplicateJobLinkRejectedPayload,
  type DuplicateJobLinkRejected,
  createDuplicateJobLinkRejected,
  type DiscoveryFeedbackKind,
  DISCOVERY_FEEDBACK_KINDS,
  type DiscoveryFeedbackRecordedPayload,
  type DiscoveryFeedbackRecorded,
  createDiscoveryFeedbackRecorded,
} from "./discovery.js";

export {
  type ActiveStateValue,
  type ContentDuplicateCandidateDetected,
  type ContentDuplicateCandidateDetectedPayload,
  createContentDuplicateCandidateDetected,
  type DuplicateEvidenceKindValue,
  type DuplicateEvidenceOnWire,
  type EnrichmentFailed,
  type EnrichmentFailedPayload,
  createEnrichmentFailed,
  type JobActiveStateChanged,
  type JobActiveStateChangedPayload,
  createJobActiveStateChanged,
  type JobEnriched,
  type JobEnrichedPayload,
  createJobEnriched,
  type PostingContentSnapshotCaptured,
  type PostingContentSnapshotCapturedPayload,
  createPostingContentSnapshotCaptured,
  type PostingContentSnapshotFailed,
  type PostingContentSnapshotFailedPayload,
  createPostingContentSnapshotFailed,
} from "./enrichment.js";

export {
  type JobScoredPayload,
  type JobScored,
  createJobScored,
  type ScoreCorrectedPayload,
  type ScoreCorrected,
  createScoreCorrected,
  type ScoreRescoreRequestedPayload,
  type ScoreRescoreRequested,
  createScoreRescoreRequested,
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
  JobSourceObserved,
  DiscoveryRunStarted,
  DiscoveryRunCompleted,
  DiscoveryRunFailed,
  JobRestored,
  JobUpdated,
  CanonicalJobIdentityResolved,
  DuplicateJobLinked,
  DuplicateJobLinkRejected,
  DiscoveryFeedbackRecorded,
  SourceLocationCandidateDiscovered,
  SourceLocationCandidatePromoted,
  SourceRegistryEntryCreated,
  SourceRegistryEntryUpdated,
  SourceStateChanged,
} from "./discovery.js";
import type {
  ContentDuplicateCandidateDetected,
  EnrichmentFailed,
  JobActiveStateChanged,
  JobEnriched,
  PostingContentSnapshotCaptured,
  PostingContentSnapshotFailed,
} from "./enrichment.js";
import type { JobScored, ScoreCorrected, ScoreRescoreRequested } from "./scoring.js";
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
  | JobSourceObserved
  | DiscoveryRunStarted
  | DiscoveryRunCompleted
  | DiscoveryRunFailed
  | CanonicalJobIdentityResolved
  | DuplicateJobLinked
  | DuplicateJobLinkRejected
  | DiscoveryFeedbackRecorded
  | SourceLocationCandidateDiscovered
  | SourceLocationCandidatePromoted
  | SourceRegistryEntryCreated
  | SourceRegistryEntryUpdated
  | SourceStateChanged
  | JobEnriched
  | EnrichmentFailed
  | PostingContentSnapshotCaptured
  | PostingContentSnapshotFailed
  | JobActiveStateChanged
  | ContentDuplicateCandidateDetected
  | JobScored
  | ScoreCorrected
  | ScoreRescoreRequested
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
  "JobSourceObserved",
  "DiscoveryRunStarted",
  "DiscoveryRunCompleted",
  "DiscoveryRunFailed",
  "CanonicalJobIdentityResolved",
  "DuplicateJobLinked",
  "DuplicateJobLinkRejected",
  "DiscoveryFeedbackRecorded",
  "SourceLocationCandidateDiscovered",
  "SourceLocationCandidatePromoted",
  "SourceRegistryEntryCreated",
  "SourceRegistryEntryUpdated",
  "SourceStateChanged",
  "JobEnriched",
  "EnrichmentFailed",
  "PostingContentSnapshotCaptured",
  "PostingContentSnapshotFailed",
  "JobActiveStateChanged",
  "ContentDuplicateCandidateDetected",
  "JobScored",
  "ScoreCorrected",
  "ScoreRescoreRequested",
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
