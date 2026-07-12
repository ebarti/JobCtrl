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
  type JobHiddenPayload,
  type JobHidden,
  createJobHidden,
  type JobUnhiddenPayload,
  type JobUnhidden,
  createJobUnhidden,
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
  type EmployerAnalyzedPayload,
  type EmployerAnalyzed,
  createEmployerAnalyzed,
  type BulletProvenanceRecordedPayload,
  type BulletProvenanceRecorded,
  createBulletProvenanceRecorded,
  RETAILOR_REQUEST_KINDS,
  type RetailorRequestKind,
  type TailorRetailorRequestedPayload,
  type TailorRetailorRequested,
  createTailorRetailorRequested,
  type TailoredArtifactsSuppressedPayload,
  type TailoredArtifactsSuppressed,
  createTailoredArtifactsSuppressed,
  type ResumeTemplateVersionSavedPayload,
  type ResumeTemplateVersionSaved,
  createResumeTemplateVersionSaved,
  type ResumeTemplateDefaultChangedPayload,
  type ResumeTemplateDefaultChanged,
  createResumeTemplateDefaultChanged,
  type JobResumeTemplateAssignedPayload,
  type JobResumeTemplateAssigned,
  createJobResumeTemplateAssigned,
  type ResumeTemplateRefreshCompletedPayload,
  type ResumeTemplateRefreshCompleted,
  createResumeTemplateRefreshCompleted,
  type ResumeTemplateRefreshFailedPayload,
  type ResumeTemplateRefreshFailed,
  createResumeTemplateRefreshFailed,
} from "./materials.js";

export {
  type InterviewPrepGeneratedPayload,
  type InterviewPrepGenerated,
  createInterviewPrepGenerated,
  type InterviewPrepFailedPayload,
  type InterviewPrepFailed,
  createInterviewPrepFailed,
} from "./interview.js";

export {
  PREPARATION_WORK_ITEM_KINDS,
  type PreparationWorkItemKind,
  type PreparationWorkItemQueuedPayload,
  type PreparationWorkItemQueued,
  createPreparationWorkItemQueued,
  type PreparationWorkItemStartedPayload,
  type PreparationWorkItemStarted,
  createPreparationWorkItemStarted,
  type PreparationWorkItemCompletedPayload,
  type PreparationWorkItemCompleted,
  createPreparationWorkItemCompleted,
  type PreparationWorkItemFailedPayload,
  type PreparationWorkItemFailed,
  createPreparationWorkItemFailed,
} from "./preparation.js";

export {
  type ApplicationEmailFeedbackIngestedPayload,
  type ApplicationEmailFeedbackIngested,
  createApplicationEmailFeedbackIngested,
  type EmailApplicationCandidateRecordedPayload,
  type EmailApplicationCandidateRecorded,
  createEmailApplicationCandidateRecorded,
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
  type ApplySubmitIntendedPayload,
  type ApplySubmitIntended,
  createApplySubmitIntended,
  type ApplyReviewDecisionValue,
  type ApplyReviewDecisionRecordedPayload,
  type ApplyReviewDecisionRecorded,
  createApplyReviewDecisionRecorded,
  type ApplicationOutcomeKindValue,
  type ApplicationOutcomeSourceValue,
  type ApplicationOutcomeRecordedPayload,
  type ApplicationOutcomeRecorded,
  createApplicationOutcomeRecorded,
  type OutcomeSuggestionDecisionValue,
  type OutcomeSuggestionDecidedPayload,
  type OutcomeSuggestionDecided,
  createOutcomeSuggestionDecided,
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
  type TailoringPolicyUpdatedPayload,
  type TailoringPolicyUpdated,
  createTailoringPolicyUpdated,
} from "./profile.js";

export {
  type CompensationChangedSection,
  type CompensationFactsUpdated,
  type CompensationFactsUpdatedPayload,
  createCompensationFactsUpdated,
} from "./compensation.js";

export {
  type DigestReviewedPayload,
  type DigestReviewed,
  createDigestReviewed,
} from "./operations.js";

export {
  type WorkflowLifecycleStatus,
  type WorkflowStartedPayload,
  type WorkflowStarted,
  createWorkflowStarted,
  type WorkflowCompletedPayload,
  type WorkflowCompleted,
  createWorkflowCompleted,
  type WorkflowFailedPayload,
  type WorkflowFailed,
  createWorkflowFailed,
  type WorkflowCanceledPayload,
  type WorkflowCanceled,
  createWorkflowCanceled,
  type WorkflowTimedOutPayload,
  type WorkflowTimedOut,
  createWorkflowTimedOut,
  type WorkflowTerminatedPayload,
  type WorkflowTerminated,
  createWorkflowTerminated,
} from "./workflow.js";

export {
  CONTACT_SOURCE_KINDS,
  type ContactSourceKind,
  CONTACT_ROLES,
  type ContactRoleValue,
  OUTREACH_DRAFT_KINDS,
  type OutreachDraftKind,
  type ContactCreatedPayload,
  type ContactCreated,
  createContactCreated,
  type ContactUpdatedPayload,
  type ContactUpdated,
  createContactUpdated,
  type ContactAttributeRecordedPayload,
  type ContactAttributeRecorded,
  createContactAttributeRecorded,
  type ContactDeletedPayload,
  type ContactDeleted,
  createContactDeleted,
  type WarmIntroIdentifiedPayload,
  type WarmIntroIdentified,
  createWarmIntroIdentified,
  type ContactResearchTaskStartedPayload,
  type ContactResearchTaskStarted,
  createContactResearchTaskStarted,
  type ContactCandidateProposedPayload,
  type ContactCandidateProposed,
  createContactCandidateProposed,
  type ContactResearchTaskNeedsReviewPayload,
  type ContactResearchTaskNeedsReview,
  createContactResearchTaskNeedsReview,
  type ContactResearchTaskCompletedPayload,
  type ContactResearchTaskCompleted,
  createContactResearchTaskCompleted,
  type ContactResearchTaskFailedPayload,
  type ContactResearchTaskFailed,
  createContactResearchTaskFailed,
  type OutreachDraftGeneratedPayload,
  type OutreachDraftGenerated,
  createOutreachDraftGenerated,
  type OutreachDraftRevisedPayload,
  type OutreachDraftRevised,
  createOutreachDraftRevised,
  type OutreachDraftApprovedPayload,
  type OutreachDraftApproved,
  createOutreachDraftApproved,
  type OutreachDraftRejectedPayload,
  type OutreachDraftRejected,
  createOutreachDraftRejected,
  type OutreachSendLoggedPayload,
  type OutreachSendLogged,
  createOutreachSendLogged,
  type FollowUpScheduledPayload,
  type FollowUpScheduled,
  createFollowUpScheduled,
  type FollowUpCompletedPayload,
  type FollowUpCompleted,
  createFollowUpCompleted,
  type FollowUpDismissedPayload,
  type FollowUpDismissed,
  createFollowUpDismissed,
} from "./contact.js";

import type {
  JobDeleted,
  JobDiscovered,
  JobSourceObserved,
  DiscoveryRunStarted,
  DiscoveryRunCompleted,
  DiscoveryRunFailed,
  JobHidden,
  JobRestored,
  JobUnhidden,
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
  BulletProvenanceRecorded,
  CoverLetterGenerated,
  EmployerAnalyzed,
  MaterialsExhausted,
  PdfRendered,
  ResumeApproved,
  ResumeFailed,
  ResumeTemplateDefaultChanged,
  ResumeTemplateRefreshCompleted,
  ResumeTemplateRefreshFailed,
  ResumeTemplateVersionSaved,
  TailoredArtifactsSuppressed,
  TailorRetailorRequested,
  JobResumeTemplateAssigned,
} from "./materials.js";
import type { InterviewPrepFailed, InterviewPrepGenerated } from "./interview.js";
import type {
  PreparationWorkItemCompleted,
  PreparationWorkItemFailed,
  PreparationWorkItemQueued,
  PreparationWorkItemStarted,
} from "./preparation.js";
import type {
  ApplicationEmailFeedbackIngested,
  ApplicationFailed,
  ApplicationSubmitted,
  EmailApplicationCandidateRecorded,
  ApplyRunEventRecorded,
  ApplyRunStarted,
  ApplySubmitIntended,
  ApplyReviewDecisionRecorded,
  ApplicationOutcomeRecorded,
  OutcomeSuggestionDecided,
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
import type { ProfileImported, ProfileUpdated, TailoringPolicyUpdated } from "./profile.js";
import type { CompensationFactsUpdated } from "./compensation.js";
import type { DigestReviewed } from "./operations.js";
import type {
  WorkflowStarted,
  WorkflowCompleted,
  WorkflowFailed,
  WorkflowCanceled,
  WorkflowTimedOut,
  WorkflowTerminated,
} from "./workflow.js";
import type {
  ContactCreated,
  ContactUpdated,
  ContactAttributeRecorded,
  ContactDeleted,
  WarmIntroIdentified,
  ContactResearchTaskStarted,
  ContactCandidateProposed,
  ContactResearchTaskNeedsReview,
  ContactResearchTaskCompleted,
  ContactResearchTaskFailed,
  OutreachDraftGenerated,
  OutreachDraftRevised,
  OutreachDraftApproved,
  OutreachDraftRejected,
  OutreachSendLogged,
  FollowUpScheduled,
  FollowUpCompleted,
  FollowUpDismissed,
} from "./contact.js";

export type DomainEventUnion =
  | JobDiscovered
  | JobUpdated
  | JobDeleted
  | JobRestored
  | JobHidden
  | JobUnhidden
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
  | EmployerAnalyzed
  | BulletProvenanceRecorded
  | InterviewPrepGenerated
  | InterviewPrepFailed
  | TailorRetailorRequested
  | TailoredArtifactsSuppressed
  | ResumeTemplateVersionSaved
  | ResumeTemplateDefaultChanged
  | JobResumeTemplateAssigned
  | ResumeTemplateRefreshCompleted
  | ResumeTemplateRefreshFailed
  | PreparationWorkItemQueued
  | PreparationWorkItemStarted
  | PreparationWorkItemCompleted
  | PreparationWorkItemFailed
  | ApplyRunStarted
  | ApplySubmitIntended
  | ApplyRunEventRecorded
  | EmailApplicationCandidateRecorded
  | ApplicationEmailFeedbackIngested
  | ApplicationSubmitted
  | ApplicationFailed
  | ApplyReviewDecisionRecorded
  | ApplicationOutcomeRecorded
  | OutcomeSuggestionDecided
  | StageStarted
  | StageCompleted
  | StageFailed
  | StageExhausted
  | StageReset
  | StageBlocked
  | StageSkipped
  | StageCanceled
  | ProfileUpdated
  | ProfileImported
  | TailoringPolicyUpdated
  | CompensationFactsUpdated
  | DigestReviewed
  | WorkflowStarted
  | WorkflowCompleted
  | WorkflowFailed
  | WorkflowCanceled
  | WorkflowTimedOut
  | WorkflowTerminated
  | ContactCreated
  | ContactUpdated
  | ContactAttributeRecorded
  | ContactDeleted
  | WarmIntroIdentified
  | ContactResearchTaskStarted
  | ContactCandidateProposed
  | ContactResearchTaskNeedsReview
  | ContactResearchTaskCompleted
  | ContactResearchTaskFailed
  | OutreachDraftGenerated
  | OutreachDraftRevised
  | OutreachDraftApproved
  | OutreachDraftRejected
  | OutreachSendLogged
  | FollowUpScheduled
  | FollowUpCompleted
  | FollowUpDismissed;

export type DomainEventType = DomainEventUnion["eventType"];

export const DOMAIN_EVENT_TYPES = [
  "JobDiscovered",
  "JobUpdated",
  "JobDeleted",
  "JobRestored",
  "JobHidden",
  "JobUnhidden",
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
  "EmployerAnalyzed",
  "BulletProvenanceRecorded",
  "InterviewPrepGenerated",
  "InterviewPrepFailed",
  "TailorRetailorRequested",
  "TailoredArtifactsSuppressed",
  "ResumeTemplateVersionSaved",
  "ResumeTemplateDefaultChanged",
  "JobResumeTemplateAssigned",
  "ResumeTemplateRefreshCompleted",
  "ResumeTemplateRefreshFailed",
  "PreparationWorkItemQueued",
  "PreparationWorkItemStarted",
  "PreparationWorkItemCompleted",
  "PreparationWorkItemFailed",
  "ApplyRunStarted",
  "ApplySubmitIntended",
  "ApplyRunEventRecorded",
  "EmailApplicationCandidateRecorded",
  "ApplicationEmailFeedbackIngested",
  "ApplicationSubmitted",
  "ApplicationFailed",
  "ApplyReviewDecisionRecorded",
  "ApplicationOutcomeRecorded",
  "OutcomeSuggestionDecided",
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
  "TailoringPolicyUpdated",
  "CompensationFactsUpdated",
  "DigestReviewed",
  "WorkflowStarted",
  "WorkflowCompleted",
  "WorkflowFailed",
  "WorkflowCanceled",
  "WorkflowTimedOut",
  "WorkflowTerminated",
  "ContactCreated",
  "ContactUpdated",
  "ContactAttributeRecorded",
  "ContactDeleted",
  "WarmIntroIdentified",
  "ContactResearchTaskStarted",
  "ContactCandidateProposed",
  "ContactResearchTaskNeedsReview",
  "ContactResearchTaskCompleted",
  "ContactResearchTaskFailed",
  "OutreachDraftGenerated",
  "OutreachDraftRevised",
  "OutreachDraftApproved",
  "OutreachDraftRejected",
  "OutreachSendLogged",
  "FollowUpScheduled",
  "FollowUpCompleted",
  "FollowUpDismissed",
] as const satisfies readonly DomainEventType[];

type EnumeratedDomainEventType = (typeof DOMAIN_EVENT_TYPES)[number];

type AssertEnumExhaustive = [DomainEventType] extends [EnumeratedDomainEventType]
  ? [EnumeratedDomainEventType] extends [DomainEventType]
    ? true
    : never
  : never;

const _assertExhaustive: AssertEnumExhaustive = true;
void _assertExhaustive;
