import type { TenantId } from "@jobctrl/domain-types";
import type { DomainEventEnvelope } from "../shared/ports/EventStreamPort.js";

/** Browser-owned committed invalidations, independent of the retired server registry. */
export interface DemoEvent {
  readonly type: string;
  readonly feature: string;
  readonly aggregateId: string | null;
  readonly tenantId: TenantId;
  readonly occurredAt: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

export interface DemoOutcomeSuggestionDecidedPayload extends Readonly<
  Record<string, unknown>
> {
  readonly jobKey: string;
  readonly suggestionId: string;
  readonly evidenceId: string | null;
  readonly decision: "accept" | "correct" | "ignore";
  readonly outcomeId: string | null;
  readonly outcomeKind: string | null;
  readonly notePresent: boolean;
  readonly reasonPresent: boolean;
  readonly decisionRequestVersion?: 1 | 2;
  readonly occurredAtProvided?: boolean;
}

function event<TName extends string>(type: TName, feature: string) {
  return <TPayload extends Readonly<Record<string, unknown>>>(
    tenantId: TenantId,
    payload: TPayload,
  ) => {
    const aggregateId =
      [
        payload.jobId,
        payload.jobKey,
        payload.contactId,
        payload.threadId,
        payload.runId,
        payload.sourceId,
      ].find((value): value is string => typeof value === "string") ?? null;
    return {
      type,
      feature,
      aggregateId,
      tenantId,
      occurredAt: new Date().toISOString(),
      payload,
    };
  };
}

export const createApplicationOutcomeRecorded = event(
  "ApplicationOutcomeRecorded",
  "applications",
);
export const createApplyReviewDecisionRecorded = event(
  "ApplyReviewDecisionRecorded",
  "applications",
);
export const createApplyRunEventRecorded = event(
  "ApplyRunEventRecorded",
  "applications",
);
export const createApplyRunStarted = event("ApplyRunStarted", "applications");
export const createContactAttributeRecorded = event(
  "ContactAttributeRecorded",
  "contacts",
);
export const createContactCreated = event("ContactCreated", "contacts");
export const createContactDeleted = event("ContactDeleted", "contacts");
export const createContactResearchTaskCompleted = event(
  "ContactResearchTaskCompleted",
  "contacts",
);
export const createContactUpdated = event("ContactUpdated", "contacts");
export const createDigestReviewed = event("DigestReviewed", "digest");
export const createDiscoveryFeedbackRecorded = event(
  "DiscoveryFeedbackRecorded",
  "discovery",
);
export const createFollowUpCompleted = event("FollowUpCompleted", "outreach");
export const createFollowUpDismissed = event("FollowUpDismissed", "outreach");
export const createFollowUpScheduled = event("FollowUpScheduled", "outreach");
export const createInterviewQuestionNoteSaved = event(
  "InterviewQuestionNoteSaved",
  "interviews",
);
export const createJobDeleted = event("JobDeleted", "jobs");
export const createJobDiscovered = event("JobDiscovered", "jobs");
export const createJobHidden = event("JobHidden", "jobs");
export const createJobRestored = event("JobRestored", "jobs");
export const createJobResumeTemplateAssigned = event(
  "JobResumeTemplateAssigned",
  "resumes",
);
export const createJobUnhidden = event("JobUnhidden", "jobs");
export const createOutcomeSuggestionDecided = (
  tenantId: TenantId,
  payload: DemoOutcomeSuggestionDecidedPayload,
) => event("OutcomeSuggestionDecided", "applications")(tenantId, payload);
export const createOutreachDraftApproved = event(
  "OutreachDraftApproved",
  "outreach",
);
export const createOutreachDraftRejected = event(
  "OutreachDraftRejected",
  "outreach",
);
export const createProfileImported = event("ProfileImported", "profile");
export const createProfileUpdated = event("ProfileUpdated", "profile");
export const createResumeTemplateDefaultChanged = event(
  "ResumeTemplateDefaultChanged",
  "resumes",
);
export const createResumeTemplateVersionSaved = event(
  "ResumeTemplateVersionSaved",
  "resumes",
);
export const createScoreCorrected = event("ScoreCorrected", "fit");
export const createScoreRescoreRequested = event(
  "ScoreRescoreRequested",
  "fit",
);
export const createSourceLocationCandidatePromoted = event(
  "SourceLocationCandidatePromoted",
  "discovery",
);
export const createSourceRegistryEntryCreated = event(
  "SourceRegistryEntryCreated",
  "discovery",
);
export const createSourceRegistryEntryUpdated = event(
  "SourceRegistryEntryUpdated",
  "discovery",
);
export const createSourceStateChanged = event(
  "SourceStateChanged",
  "discovery",
);
export const createStageCanceled = event("StageCanceled", "operations");
export const createStageCompleted = event("StageCompleted", "operations");
export const createStageSkipped = event("StageSkipped", "operations");
export const createWorkflowCanceled = event("WorkflowCanceled", "operations");

export const DEMO_EVENT_TYPES = [
  "ApplicationOutcomeRecorded",
  "ApplyReviewDecisionRecorded",
  "ApplyRunEventRecorded",
  "ApplyRunStarted",
  "ContactAttributeRecorded",
  "ContactCreated",
  "ContactDeleted",
  "ContactResearchTaskCompleted",
  "ContactUpdated",
  "DigestReviewed",
  "DiscoveryFeedbackRecorded",
  "FollowUpCompleted",
  "FollowUpDismissed",
  "FollowUpScheduled",
  "InterviewQuestionNoteSaved",
  "JobDeleted",
  "JobDiscovered",
  "JobHidden",
  "JobRestored",
  "JobResumeTemplateAssigned",
  "JobUnhidden",
  "OutcomeSuggestionDecided",
  "OutreachDraftApproved",
  "OutreachDraftRejected",
  "ProfileImported",
  "ProfileUpdated",
  "ResumeTemplateDefaultChanged",
  "ResumeTemplateVersionSaved",
  "ScoreCorrected",
  "ScoreRescoreRequested",
  "SourceLocationCandidatePromoted",
  "SourceRegistryEntryCreated",
  "SourceRegistryEntryUpdated",
  "SourceStateChanged",
  "StageCanceled",
  "StageCompleted",
  "StageSkipped",
  "WorkflowCanceled",
] as const;

const publicTypes: Readonly<Record<string, string>> = {
  JobDeleted: "JobUpdated",
  JobRestored: "JobUpdated",
  JobHidden: "JobUpdated",
  JobUnhidden: "JobUpdated",
  JobDiscovered: "JobCaptured",
  ScoreCorrected: "FitCorrected",
  ScoreRescoreRequested: "FitUpdated",
  SourceRegistryEntryCreated: "DiscoverySourceUpdated",
  SourceRegistryEntryUpdated: "DiscoverySourceUpdated",
  SourceStateChanged: "DiscoverySourceUpdated",
  ResumeTemplateDefaultChanged: "ResumeTemplateUpdated",
  ResumeTemplateVersionSaved: "ResumeTemplateUpdated",
  JobResumeTemplateAssigned: "ResumeTemplateUpdated",
  SourceLocationCandidatePromoted: "SourceProposalUpdated",
  DiscoveryFeedbackRecorded: "DiscoveryFeedbackUpdated",
  ContactResearchTaskCompleted: "ContactResearchTaskUpdated",
  WorkflowCanceled: "ActionCancellationRequested",
};
export function demoEventEnvelope(event: DemoEvent): DomainEventEnvelope {
  return {
    eventType: publicTypes[event.type] ?? event.type,
    tenantId: event.tenantId,
    feature: event.feature,
    aggregateId: event.aggregateId,
    occurredAt: event.occurredAt,
    payload: event.payload,
  };
}
