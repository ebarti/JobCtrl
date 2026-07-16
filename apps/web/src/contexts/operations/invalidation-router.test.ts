import { LOCAL_TENANT, type DomainEventUnion } from "@jobctrl/domain-types";
import { QueryClient, type QueryKey } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { eventByType } from "../../test/fixtures/events.js";
import { activityKeys } from "./activityKeys.js";
import { analyticsKeys } from "./analyticsKeys.js";
import { applyReviewKeys } from "./applyReviewKeys.js";
import { applyRunsKeys } from "./applyRunsKeys.js";
import { artifactsKeys } from "./artifactsKeys.js";
import { dashboardKeys } from "./dashboardKeys.js";
import { digestKeys } from "./digestKeys.js";
import { invalidationRouter } from "./invalidation-router.js";
import { jobsKeys } from "./jobsKeys.js";
import { outcomesKeys } from "./outcomesKeys.js";
import { workflowRunsKeys } from "./workflowRunsKeys.js";
import { discoveryKeys } from "../discovery/queryKeys.js";
import { pipelineKeys } from "../pipeline/queryKeys.js";
import { profileKeys } from "../profile/queryKeys.js";
import { outreachKeys } from "../outreach/queryKeys.js";

type ExpectedKeys = readonly QueryKey[];

const JOB_ID = "job-1";
const RUN_ID = "run-1";
// Matches the workflowId in the Workflow* fixtures (test/fixtures/events.ts).
const WORKFLOW_ID = "run-abc123";
const ARTIFACT_ID = "artifact-1";

const expectedInvalidations: Record<DomainEventUnion["eventType"], ExpectedKeys> = {
  JobDiscovered: [
    jobsKeys.lists(LOCAL_TENANT),
    discoveryKeys.manualCapture(LOCAL_TENANT),
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  JobUpdated: [jobsKeys.lists(LOCAL_TENANT), jobsKeys.detail(LOCAL_TENANT, JOB_ID)],
  JobDeleted: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  JobRestored: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  JobHidden: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  JobUnhidden: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  JobSourceObserved: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
  ],
  DiscoveryRunStarted: [
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  DiscoveryRunCompleted: [
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  DiscoveryRunFailed: [
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  CanonicalJobIdentityResolved: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
  ],
  DuplicateJobLinked: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  DuplicateJobLinkRejected: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  DiscoveryFeedbackRecorded: [
    discoveryKeys.feedback(LOCAL_TENANT),
    discoveryKeys.quarantine(LOCAL_TENANT),
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  SourceLocationCandidateDiscovered: [
    discoveryKeys.sourceLocator(LOCAL_TENANT),
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
  ],
  SourceLocationCandidatePromoted: [
    discoveryKeys.sourceLocator(LOCAL_TENANT),
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  SourceRegistryEntryCreated: [
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
  ],
  SourceRegistryEntryUpdated: [
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
  ],
  SourceStateChanged: [
    discoveryKeys.sourceRegistry(LOCAL_TENANT),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  JobEnriched: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  EnrichmentFailed: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  PostingContentSnapshotCaptured: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
  ],
  PostingContentSnapshotFailed: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
  ],
  JobActiveStateChanged: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  ContentDuplicateCandidateDetected: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.detail(LOCAL_TENANT, "job-2"),
    discoveryKeys.sourceQuality(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  CompensationFactsUpdated: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
  ],
  DigestReviewed: [digestKeys.all(LOCAL_TENANT)],
  JobScored: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  ScoreCorrected: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    applyReviewKeys.queue(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  ScoreRescoreRequested: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  ResumeApproved: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    artifactsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  ResumeFailed: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  CoverLetterGenerated: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    artifactsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  PdfRendered: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    artifactsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  MaterialsExhausted: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  EmployerAnalyzed: [jobsKeys.detail(LOCAL_TENANT, JOB_ID)],
  BulletProvenanceRecorded: [
    artifactsKeys.detail(LOCAL_TENANT, ARTIFACT_ID),
    artifactsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
  ],
  InterviewPrepGenerated: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  InterviewPrepFailed: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  TailoringPolicyUpdated: [
    profileKeys.profile(LOCAL_TENANT),
    jobsKeys.all(LOCAL_TENANT),
    artifactsKeys.all(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  TailorRetailorRequested: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  TailoredArtifactsSuppressed: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    artifactsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  ResumeTemplateVersionSaved: [
    profileKeys.resumeTemplates(LOCAL_TENANT),
    jobsKeys.lists(LOCAL_TENANT),
    artifactsKeys.lists(LOCAL_TENANT),
  ],
  ResumeTemplateDefaultChanged: [
    profileKeys.resumeTemplates(LOCAL_TENANT),
    jobsKeys.lists(LOCAL_TENANT),
    artifactsKeys.lists(LOCAL_TENANT),
    applyReviewKeys.all(LOCAL_TENANT),
  ],
  JobResumeTemplateAssigned: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    artifactsKeys.lists(LOCAL_TENANT),
    applyReviewKeys.all(LOCAL_TENANT),
  ],
  ResumeTemplateRefreshCompleted: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    artifactsKeys.lists(LOCAL_TENANT),
    applyReviewKeys.all(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  ResumeTemplateRefreshFailed: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    applyReviewKeys.all(LOCAL_TENANT),
  ],
  PreparationWorkItemQueued: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  PreparationWorkItemStarted: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  PreparationWorkItemCompleted: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    artifactsKeys.lists(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  PreparationWorkItemFailed: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  PipelineStepQueued: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  PipelineStepStarted: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  PipelineStepCompleted: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  PipelineStepFailed: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  ApplyRunStarted: [
    applyRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.lists(LOCAL_TENANT),
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  ApplyRunEventRecorded: [],
  ApplySubmitIntended: [
    applyRunsKeys.lists(LOCAL_TENANT),
    applyRunsKeys.detail(LOCAL_TENANT, RUN_ID),
    applyReviewKeys.queue(LOCAL_TENANT),
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  ApplicationEmailFeedbackIngested: [
    outcomesKeys.lists(LOCAL_TENANT),
    outcomesKeys.detail(LOCAL_TENANT, JOB_ID),
    applyReviewKeys.queue(LOCAL_TENANT),
    analyticsKeys.all(LOCAL_TENANT),
  ],
  EmailApplicationCandidateRecorded: [applyReviewKeys.queue(LOCAL_TENANT)],
  ApplicationSubmitted: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    applyRunsKeys.lists(LOCAL_TENANT),
    applyRunsKeys.detail(LOCAL_TENANT, RUN_ID),
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, RUN_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    analyticsKeys.all(LOCAL_TENANT),
  ],
  ApplicationFailed: [
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    jobsKeys.lists(LOCAL_TENANT),
    applyRunsKeys.lists(LOCAL_TENANT),
    applyRunsKeys.detail(LOCAL_TENANT, RUN_ID),
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, RUN_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    analyticsKeys.all(LOCAL_TENANT),
  ],
  ApplyReviewDecisionRecorded: [
    applyReviewKeys.queue(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  ApplicationOutcomeRecorded: [
    outcomesKeys.lists(LOCAL_TENANT),
    outcomesKeys.detail(LOCAL_TENANT, JOB_ID),
    analyticsKeys.all(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  OutcomeSuggestionDecided: [
    outcomesKeys.lists(LOCAL_TENANT),
    outcomesKeys.detail(LOCAL_TENANT, JOB_ID),
    analyticsKeys.all(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
  ],
  StageStarted: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  StageCompleted: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  StageFailed: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  StageExhausted: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  StageReset: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  StageBlocked: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  StageSkipped: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    applyReviewKeys.queue(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  StageCanceled: [
    jobsKeys.lists(LOCAL_TENANT),
    jobsKeys.detail(LOCAL_TENANT, JOB_ID),
    applyReviewKeys.queue(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  ProfileUpdated: [profileKeys.profile(LOCAL_TENANT)],
  ProfileImported: [profileKeys.profile(LOCAL_TENANT)],
  WorkflowStarted: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  WorkflowCompleted: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  WorkflowFailed: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  WorkflowCanceled: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    applyReviewKeys.queue(LOCAL_TENANT),
    dashboardKeys.summary(LOCAL_TENANT),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  WorkflowTimedOut: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  WorkflowTerminated: [
    workflowRunsKeys.lists(LOCAL_TENANT),
    workflowRunsKeys.detail(LOCAL_TENANT, WORKFLOW_ID),
    pipelineKeys.operations(LOCAL_TENANT),
  ],
  ContactCreated: [outreachKeys.contactLists(LOCAL_TENANT)],
  ContactUpdated: [
    outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"),
    outreachKeys.contactLists(LOCAL_TENANT),
  ],
  ContactAttributeRecorded: [outreachKeys.contactDetail(LOCAL_TENANT, "contact-1")],
  ContactDeleted: [
    outreachKeys.contactDetail(LOCAL_TENANT, "contact-1"),
    outreachKeys.contactLists(LOCAL_TENANT),
    outreachKeys.threads(LOCAL_TENANT),
    outreachKeys.dueFollowUps(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  WarmIntroIdentified: [outreachKeys.contactDetail(LOCAL_TENANT, "contact-1")],
  ContactResearchTaskStarted: [
    outreachKeys.researchTask(LOCAL_TENANT, "research-1"),
    outreachKeys.researchTaskLists(LOCAL_TENANT),
  ],
  ContactCandidateProposed: [outreachKeys.researchTask(LOCAL_TENANT, "research-1")],
  ContactResearchTaskNeedsReview: [
    outreachKeys.researchTask(LOCAL_TENANT, "research-1"),
    outreachKeys.researchTaskLists(LOCAL_TENANT),
  ],
  ContactResearchTaskCompleted: [
    outreachKeys.researchTask(LOCAL_TENANT, "research-1"),
    outreachKeys.researchTaskLists(LOCAL_TENANT),
    outreachKeys.contactLists(LOCAL_TENANT),
  ],
  ContactResearchTaskFailed: [
    outreachKeys.researchTask(LOCAL_TENANT, "research-2"),
    outreachKeys.researchTaskLists(LOCAL_TENANT),
  ],
  OutreachDraftGenerated: [
    outreachKeys.thread(LOCAL_TENANT, "thread-1"),
    outreachKeys.threads(LOCAL_TENANT),
  ],
  OutreachDraftRevised: [
    outreachKeys.thread(LOCAL_TENANT, "thread-1"),
    outreachKeys.threads(LOCAL_TENANT),
  ],
  OutreachDraftApproved: [
    outreachKeys.thread(LOCAL_TENANT, "thread-1"),
    outreachKeys.threads(LOCAL_TENANT),
  ],
  OutreachDraftRejected: [
    outreachKeys.thread(LOCAL_TENANT, "thread-1"),
    outreachKeys.threads(LOCAL_TENANT),
  ],
  OutreachSendLogged: [
    outreachKeys.thread(LOCAL_TENANT, "thread-1"),
    outreachKeys.dueFollowUps(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  FollowUpScheduled: [
    outreachKeys.thread(LOCAL_TENANT, "thread-1"),
    outreachKeys.dueFollowUps(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  FollowUpCompleted: [
    outreachKeys.thread(LOCAL_TENANT, "thread-1"),
    outreachKeys.dueFollowUps(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
  FollowUpDismissed: [
    outreachKeys.thread(LOCAL_TENANT, "thread-1"),
    outreachKeys.dueFollowUps(LOCAL_TENANT),
    digestKeys.all(LOCAL_TENANT),
  ],
};

describe("invalidationRouter", () => {
  let queryClient: QueryClient;
  let invalidateSpy: ReturnType<typeof vi.spyOn>;
  let setQueryDataSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    queryClient = new QueryClient();
    invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
    setQueryDataSpy = vi.spyOn(queryClient, "setQueryData");
  });

  for (const [eventType, expected] of Object.entries(expectedInvalidations) as [
    DomainEventUnion["eventType"],
    ExpectedKeys,
  ][]) {
    it(`fires the expected invalidation set for ${eventType} (exact match)`, () => {
      const event = eventByType[eventType];
      invalidationRouter.handle(event, queryClient);
      const expectedKeys =
        eventType === "ApplyRunEventRecorded"
          ? expected
          : [...expected, activityKeys.lists(LOCAL_TENANT)];

      const invalidatedKeys = invalidateSpy.mock.calls.map((call: unknown[]) => {
        const args = call[0] as { queryKey?: QueryKey };
        return args.queryKey;
      });

      expect(invalidatedKeys).toHaveLength(expectedKeys.length);
      for (const key of expectedKeys) {
        expect(invalidatedKeys).toContainEqual(key);
      }
      for (const actual of invalidatedKeys) {
        const matched = expectedKeys.some(
          (expectedKey) => JSON.stringify(expectedKey) === JSON.stringify(actual),
        );
        expect(
          matched,
          `${eventType} invalidated unexpected key: ${JSON.stringify(actual)}`,
        ).toBe(true);
      }
    });
  }

  it("appends the apply-run event in place rather than invalidating", () => {
    queryClient.setQueryData(applyRunsKeys.detail(LOCAL_TENANT, RUN_ID), {
      events: [],
    });
    invalidationRouter.handle(eventByType.ApplyRunEventRecorded, queryClient);

    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(setQueryDataSpy).toHaveBeenCalledWith(
      applyRunsKeys.detail(LOCAL_TENANT, RUN_ID),
      expect.any(Function),
    );
    const cached = queryClient.getQueryData(applyRunsKeys.detail(LOCAL_TENANT, RUN_ID)) as {
      events: unknown[];
    };
    expect(cached.events).toHaveLength(1);
  });
});
