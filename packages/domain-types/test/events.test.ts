import { describe, it, expect } from "vitest";
import { LOCAL_TENANT } from "../src/tenant.js";
import { createDomainEvent } from "../src/events/base.js";
import { DOMAIN_EVENT_TYPES } from "../src/events/index.js";
import {
  createCanonicalJobIdentityResolved,
  createDiscoveryFeedbackRecorded,
  createDiscoveryRunCompleted,
  createDiscoveryRunFailed,
  createDiscoveryRunStarted,
  createDuplicateJobLinked,
  createDuplicateJobLinkRejected,
  createJobDiscovered,
  createJobHidden,
  createJobSourceObserved,
  createJobUnhidden,
  createSourceLocationCandidateDiscovered,
  createSourceLocationCandidatePromoted,
  createSourceRegistryEntryCreated,
  createSourceRegistryEntryUpdated,
  createSourceStateChanged,
  DISCOVERY_FEEDBACK_KINDS,
} from "../src/events/discovery.js";
import {
  createContentDuplicateCandidateDetected,
  createEnrichmentFailed,
  createJobActiveStateChanged,
  createJobEnriched,
  createPostingContentSnapshotCaptured,
  createPostingContentSnapshotFailed,
} from "../src/events/enrichment.js";
import { createJobScored, createScoreRescoreRequested } from "../src/events/scoring.js";
import {
  createResumeApproved,
  createMaterialsExhausted,
  createTailoredArtifactsSuppressed,
  createTailorRetailorRequested,
} from "../src/events/materials.js";
import {
  PREPARATION_WORK_ITEM_KINDS,
  createPreparationWorkItemCompleted,
  createPreparationWorkItemFailed,
  createPreparationWorkItemQueued,
  createPreparationWorkItemStarted,
} from "../src/events/preparation.js";
import {
  createApplicationEmailFeedbackIngested,
  createApplicationOutcomeRecorded,
  createApplicationSubmitted,
  createApplyReviewDecisionRecorded,
  createApplyRunStarted,
  createOutcomeSuggestionDecided,
} from "../src/events/apply.js";
import { createStageStarted, createStageCompleted } from "../src/events/orchestration.js";
import { createProfileUpdated, createProfileImported, createTailoringPolicyUpdated } from "../src/events/profile.js";
import { createCompensationFactsUpdated } from "../src/events/compensation.js";
import { createDigestReviewed } from "../src/events/operations.js";

describe("DomainEvent base", () => {
  it("createDomainEvent sets envelope fields", () => {
    const event = createDomainEvent("TestEvent", LOCAL_TENANT, { foo: "bar" });
    expect(event.eventType).toBe("TestEvent");
    expect(event.tenantId).toBe("local");
    expect(event.occurredAt).toBeTruthy();
    expect(event.payload).toEqual({ foo: "bar" });
  });

  it("createDomainEvent accepts custom occurredAt", () => {
    const ts = "2025-01-01T12:00:00Z";
    const event = createDomainEvent("X", LOCAL_TENANT, {}, ts);
    expect(event.occurredAt).toBe(ts);
  });
});

describe("Operations events", () => {
  it("DigestReviewed carries the explicit acknowledge watermark", () => {
    const event = createDigestReviewed(LOCAL_TENANT, {
      acknowledgedAt: "2026-07-05T10:00:00.000Z",
      reviewedAt: "2026-07-05T10:01:00.000Z",
      previousAcknowledgedAt: "2026-07-04T10:00:00.000Z",
    });
    expect(event.eventType).toBe("DigestReviewed");
    expect(event.tenantId).toBe("local");
    expect(event.payload.acknowledgedAt).toBe("2026-07-05T10:00:00.000Z");
  });
});

describe("Discovery events", () => {
  it("JobDiscovered carries tenantId and all payload fields", () => {
    const event = createJobDiscovered(LOCAL_TENANT, {
      jobId: "j1",
      postingUrl: "https://example.com/job",
      source: "linkedin",
      employer: "Acme",
      metadata: { title: "Engineer" },
      discoveredAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("JobDiscovered");
    expect(event.tenantId).toBe("local");
    expect(event.payload.jobId).toBe("j1");
    expect(event.payload.source).toBe("linkedin");
  });

  it("JobHidden and JobUnhidden preserve distinct lifecycle facts", () => {
    const hidden = createJobHidden(LOCAL_TENANT, {
      jobId: "j1",
      reason: "not-a-fit",
      hiddenAt: "2026-07-11T10:00:00Z",
    });
    const unhidden = createJobUnhidden(LOCAL_TENANT, {
      jobId: "j1",
      unhiddenAt: "2026-07-11T11:00:00Z",
    });
    expect(hidden).toMatchObject({
      eventType: "JobHidden",
      payload: { jobId: "j1", reason: "not-a-fit" },
    });
    expect(unhidden).toMatchObject({
      eventType: "JobUnhidden",
      payload: { jobId: "j1" },
    });
  });

  it("SourceLocationCandidateDiscovered carries locator fields", () => {
    const event = createSourceLocationCandidateDiscovered(LOCAL_TENANT, {
      candidateId: "candidate-1",
      candidateUrl: "https://example.com/careers",
      sourceKind: "employer_careers_page",
      confidence: 0.82,
      evidenceRef: "evidence:candidate-1",
      discoveredAt: "2026-05-12T00:00:00Z",
    });
    expect(event.eventType).toBe("SourceLocationCandidateDiscovered");
    expect(event.payload.sourceKind).toBe("employer_careers_page");
  });

  it("SourceRegistryEntryCreated carries source state", () => {
    const event = createSourceRegistryEntryCreated(LOCAL_TENANT, {
      sourceId: "smart_extract:remoteok",
      kind: "smart_extract",
      policyId: "smart_extract_experimental",
      state: "experimental",
      createdAt: "2026-05-12T00:00:00Z",
    });
    expect(event.eventType).toBe("SourceRegistryEntryCreated");
    expect(event.payload.state).toBe("experimental");
  });

  it("JobSourceObserved carries observation attribution", () => {
    const event = createJobSourceObserved(LOCAL_TENANT, {
      jobId: "j1",
      sourceObservationId: "observation-1",
      sourceId: "greenhouse:acme",
      sourceNativeId: "123456",
      observedUrl: "https://boards.greenhouse.io/acme/jobs/123456",
      runId: "run-1",
      observedAt: "2026-05-12T00:00:00Z",
    });
    expect(event.eventType).toBe("JobSourceObserved");
    expect(event.payload.sourceObservationId).toBe("observation-1");
    expect(event.payload.runId).toBe("run-1");
  });

  it("DiscoveryRun events carry scheduler telemetry", () => {
    const started = createDiscoveryRunStarted(LOCAL_TENANT, {
      runId: "run-1",
      sourceIds: ["greenhouse:acme"],
      profileSnapshotId: "profile:1",
      startedAt: "2026-05-13T00:00:00Z",
    });
    const completed = createDiscoveryRunCompleted(LOCAL_TENANT, {
      runId: "run-1",
      counts: {
        total: 3,
        newJobs: 2,
        existingJobs: 1,
        observedJobs: 3,
        duplicateJobs: 0,
        rejectedDuplicates: 0,
      },
      errorClasses: [],
      completedAt: "2026-05-13T00:01:00Z",
    });
    const failed = createDiscoveryRunFailed(LOCAL_TENANT, {
      runId: "run-2",
      sourceId: "greenhouse:acme",
      errorClass: "TimeoutError",
      retryable: true,
      failedAt: "2026-05-13T00:02:00Z",
    });
    expect(started.eventType).toBe("DiscoveryRunStarted");
    expect(completed.payload.counts.newJobs).toBe(2);
    expect(failed.payload.errorClass).toBe("TimeoutError");
  });

  it("CanonicalJobIdentityResolved carries ATS identity fields", () => {
    const event = createCanonicalJobIdentityResolved(LOCAL_TENANT, {
      jobId: "j1",
      canonicalUrl: "https://boards.greenhouse.io/acme/jobs/123456",
      atsKind: "greenhouse",
      sourceNativeId: "123456",
      confidence: 0.98,
    });
    expect(event.eventType).toBe("CanonicalJobIdentityResolved");
    expect(event.payload.atsKind).toBe("greenhouse");
    expect(event.payload.confidence).toBe(0.98);
  });

  it("DuplicateJobLinked carries the survivor and superseded ids", () => {
    const event = createDuplicateJobLinked(LOCAL_TENANT, {
      duplicateLinkId: "duplicate-link-1",
      survivingJobId: "j1",
      supersededJobOrObservationId: "observation-2",
      reason: "ats_identity_match",
      confidence: 0.96,
    });
    expect(event.eventType).toBe("DuplicateJobLinked");
    expect(event.payload.survivingJobId).toBe("j1");
    expect(event.payload.supersededJobOrObservationId).toBe("observation-2");
  });

  it("DuplicateJobLinkRejected attributes the rejected link to the surviving owner", () => {
    const event = createDuplicateJobLinkRejected(LOCAL_TENANT, {
      duplicateLinkId: "duplicate-link-rejected-1",
      jobId: "owner-1",
      candidateJobId: "candidate-1",
      reason: "low_confidence",
      rejectedAt: "2026-05-12T00:00:00Z",
    });
    expect(event.eventType).toBe("DuplicateJobLinkRejected");
    expect(event.payload.jobId).toBe("owner-1");
    expect(event.payload.candidateJobId).toBe("candidate-1");
  });

  it("DiscoveryFeedbackRecorded carries the feedback kind without raw text", () => {
    const event = createDiscoveryFeedbackRecorded(LOCAL_TENANT, {
      feedbackId: "feedback-1",
      jobId: "j1",
      sourceId: "greenhouse:acme",
      kind: "saved",
      recordedAt: "2026-05-13T12:00:00Z",
    });
    expect(event.eventType).toBe("DiscoveryFeedbackRecorded");
    expect(event.payload.kind).toBe("saved");
    expect(event.payload.sourceId).toBe("greenhouse:acme");
    expect(DISCOVERY_FEEDBACK_KINDS).toContain(event.payload.kind);
  });
});

describe("Enrichment events", () => {
  it("JobEnriched has required fields", () => {
    const event = createJobEnriched(LOCAL_TENANT, {
      jobId: "j1",
      fullDescription: "Full desc",
      applicationUrl: "https://apply.example.com",
      extractionTier: "json_ld",
      enrichedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("JobEnriched");
    expect(event.tenantId).toBe("local");
    expect(event.payload.extractionTier).toBe("json_ld");
  });

  it("PostingContentSnapshotCaptured carries snapshot provenance", () => {
    const event = createPostingContentSnapshotCaptured(LOCAL_TENANT, {
      jobId: "j1",
      snapshotVersion: 1,
      snapshotRef: "j1:1",
      sourceId: "greenhouse:acme",
      extractionTier: "json_ld",
      capturedAt: "2026-05-13T00:00:00Z",
    });
    expect(event.eventType).toBe("PostingContentSnapshotCaptured");
    expect(event.payload.snapshotRef).toBe("j1:1");
    expect(event.payload.sourceId).toBe("greenhouse:acme");
  });

  it("PostingContentSnapshotFailed carries retry classification", () => {
    const event = createPostingContentSnapshotFailed(LOCAL_TENANT, {
      jobId: "j1",
      sourceId: "greenhouse:acme",
      errorClass: "FETCH_ERROR",
      retryable: true,
      failedAt: "2026-05-13T00:00:00Z",
    });
    expect(event.eventType).toBe("PostingContentSnapshotFailed");
    expect(event.payload.errorClass).toBe("FETCH_ERROR");
    expect(event.payload.retryable).toBe(true);
  });

  it("JobActiveStateChanged carries active-state transition details", () => {
    const event = createJobActiveStateChanged(LOCAL_TENANT, {
      jobId: "j1",
      activeState: "closed",
      previousState: "active",
      verificationMethod: "closed_marker",
      verifiedAt: "2026-05-13T00:00:00Z",
    });
    expect(event.eventType).toBe("JobActiveStateChanged");
    expect(event.payload.activeState).toBe("closed");
    expect(event.payload.verificationMethod).toBe("closed_marker");
  });

  it("ContentDuplicateCandidateDetected carries duplicate evidence", () => {
    const event = createContentDuplicateCandidateDetected(LOCAL_TENANT, {
      jobId: "j1",
      candidateJobId: "j2",
      evidence: [
        {
          kind: "description_hash_match",
          matchedValue: "hash-1",
          confidence: 1,
        },
      ],
      confidence: 1,
      detectedAt: "2026-05-13T00:00:00Z",
    });
    expect(event.eventType).toBe("ContentDuplicateCandidateDetected");
    expect(event.payload.candidateJobId).toBe("j2");
    expect(event.payload.evidence[0]?.kind).toBe("description_hash_match");
  });
});

describe("Scoring events", () => {
  it("JobScored has required fields", () => {
    const event = createJobScored(LOCAL_TENANT, {
      jobId: "j1",
      fitScore: 8,
      breakdown: { technicalFit: 9 },
      keywords: ["python", "react"],
      version: 1,
      scoredAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("JobScored");
    expect(event.tenantId).toBe("local");
    expect(event.payload.fitScore).toBe(8);
    expect(event.payload.keywords).toEqual(["python", "react"]);
  });

  it("ScoreRescoreRequested carries policy version metadata", () => {
    const event = createScoreRescoreRequested(LOCAL_TENANT, {
      jobId: "j1",
      staleReason: "scoring_policy_changed",
      oldPolicyVersion: 1,
      newPolicyVersion: 2,
      nextAction: "jobctrl run score --rescore",
    });
    expect(event.eventType).toBe("ScoreRescoreRequested");
    expect(event.payload.oldPolicyVersion).toBe(1);
    expect(event.payload.newPolicyVersion).toBe(2);
  });
});

describe("Materials events", () => {
  it("ResumeApproved has required fields", () => {
    const event = createResumeApproved(LOCAL_TENANT, {
      jobId: "j1",
      artifactId: "a1",
      generation: 1,
      approvedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("ResumeApproved");
    expect(event.tenantId).toBe("local");
  });

  it("MaterialsExhausted has required fields", () => {
    const event = createMaterialsExhausted(LOCAL_TENANT, {
      jobId: "j1",
      stage: "tailor",
      attemptCount: 3,
      maxAttempts: 3,
    });
    expect(event.eventType).toBe("MaterialsExhausted");
    expect(event.payload.attemptCount).toBe(3);
  });

  it("TailorRetailorRequested carries stale policy details", () => {
    const event = createTailorRetailorRequested(LOCAL_TENANT, {
      requestId: "retailor-1",
      jobId: "j1",
      requestKind: "policy_update",
      currentPolicyVersion: 4,
      latestArtifactPolicyVersion: 3,
      reason: "tailoring_policy_changed",
      requestedAt: "2026-05-26T10:00:00Z",
      sourceEventId: "event-1",
    });
    expect(event.eventType).toBe("TailorRetailorRequested");
    expect(event.payload.jobId).toBe("j1");
    expect(event.payload.currentPolicyVersion).toBe(4);
  });

  it("TailoredArtifactsSuppressed carries artifact ids but no local paths", () => {
    const event = createTailoredArtifactsSuppressed(LOCAL_TENANT, {
      jobId: "j1",
      artifactIds: ["artifact-1"],
      suppressionReason: "tailoring_policy_changed",
      suppressedAt: "2026-05-26T10:01:00Z",
      currentTailoringPolicyVersion: 4,
    });
    expect(event.eventType).toBe("TailoredArtifactsSuppressed");
    expect(event.payload.artifactIds).toEqual(["artifact-1"]);
    expect(event.payload.currentTailoringPolicyVersion).toBe(4);
  });
});

describe("Preparation events", () => {
  it("exposes the durable preparation command vocabulary", () => {
    expect(PREPARATION_WORK_ITEM_KINDS).toEqual([
      "score_job",
      "tailor_resume",
      "suppress_tailored_artifacts",
    ]);
  });

  it("PreparationWorkItemQueued carries queue metadata", () => {
    const event = createPreparationWorkItemQueued(LOCAL_TENANT, {
      workItemId: "prep-1",
      jobId: "j1",
      kind: "score_job",
      reason: "new_job_discovered",
      targetVersion: 2,
      sourceEventId: "job-enriched-1",
      queuedAt: "2026-05-26T10:00:00Z",
    });
    expect(event.eventType).toBe("PreparationWorkItemQueued");
    expect(event.payload.kind).toBe("score_job");
    expect(event.payload.targetVersion).toBe(2);
    expect(event.payload.sourceEventId).toBe("job-enriched-1");
  });

  it("PreparationWorkItemStarted carries worker identity", () => {
    const event = createPreparationWorkItemStarted(LOCAL_TENANT, {
      workItemId: "prep-1",
      jobId: "j1",
      kind: "tailor_resume",
      workerId: "worker-1",
      startedAt: "2026-05-26T10:01:00Z",
    });
    expect(event.eventType).toBe("PreparationWorkItemStarted");
    expect(event.payload.workerId).toBe("worker-1");
  });

  it("PreparationWorkItemCompleted carries duration", () => {
    const event = createPreparationWorkItemCompleted(LOCAL_TENANT, {
      workItemId: "prep-1",
      jobId: "j1",
      kind: "suppress_tailored_artifacts",
      completedAt: "2026-05-26T10:02:00Z",
      durationMs: 1200,
    });
    expect(event.eventType).toBe("PreparationWorkItemCompleted");
    expect(event.payload.durationMs).toBe(1200);
  });

  it("PreparationWorkItemFailed carries retry classification", () => {
    const event = createPreparationWorkItemFailed(LOCAL_TENANT, {
      workItemId: "prep-1",
      jobId: "j1",
      kind: "tailor_resume",
      errorCode: "POLICY_VERSION_MISSING",
      retryable: false,
      failedAt: "2026-05-26T10:03:00Z",
    });
    expect(event.eventType).toBe("PreparationWorkItemFailed");
    expect(event.payload.retryable).toBe(false);
    expect(event.payload.errorCode).toBe("POLICY_VERSION_MISSING");
  });
});

describe("Apply events", () => {
  it("ApplicationSubmitted has required fields", () => {
    const event = createApplicationSubmitted(LOCAL_TENANT, {
      jobId: "j1",
      runId: "r1",
      appliedAt: "2025-01-01T00:00:00Z",
      verificationConfidence: 0.95,
    });
    expect(event.eventType).toBe("ApplicationSubmitted");
    expect(event.tenantId).toBe("local");
    expect(event.payload.verificationConfidence).toBe(0.95);
  });

  it("ApplyRunStarted has required fields", () => {
    const event = createApplyRunStarted(LOCAL_TENANT, {
      jobId: "j1",
      runId: "r1",
      workerId: "w1",
      model: "haiku",
      dryRun: false,
      startedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("ApplyRunStarted");
    expect(event.payload.dryRun).toBe(false);
  });

  it("creates production-shaped apply review and outcome audit events", () => {
    const decision = createApplyReviewDecisionRecorded(LOCAL_TENANT, {
      jobKey: "j1",
      decisionId: "decision-1",
      decision: "approve_dry_run",
      reasonPresent: true,
      materialsGeneration: 2,
      profileVersion: 3,
      applicationUrl: "https://example.com/apply",
      partialOverrideRunId: null,
      emailRecipient: null,
      emailAttachmentArtifactId: null,
    });
    const outcome = createApplicationOutcomeRecorded(LOCAL_TENANT, {
      jobKey: "j1",
      outcomeId: "outcome-1",
      kind: "interview",
      source: "manual",
      occurredAt: "2026-07-11T10:00:00Z",
      suggestionId: null,
      evidenceId: null,
      interviewPrepGeneration: 1,
      notePresent: true,
    });
    const suggestion = createOutcomeSuggestionDecided(LOCAL_TENANT, {
      jobKey: "j1",
      suggestionId: "suggestion-1",
      evidenceId: "evidence-1",
      decision: "accept",
      outcomeId: "outcome-1",
      outcomeKind: "interview",
      notePresent: false,
      reasonPresent: true,
    });
    expect(decision.eventType).toBe("ApplyReviewDecisionRecorded");
    expect(outcome.payload).toMatchObject({ kind: "interview", source: "manual" });
    expect(suggestion.payload).toMatchObject({ decision: "accept", outcomeId: "outcome-1" });
  });
});

describe("Orchestration events", () => {
  it("StageStarted has required fields", () => {
    const event = createStageStarted(LOCAL_TENANT, {
      jobId: "j1",
      stage: "enrich",
      attemptNumber: 1,
      startedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("StageStarted");
    expect(event.tenantId).toBe("local");
    expect(event.payload.stage).toBe("enrich");
  });

  it("StageCompleted has required fields", () => {
    const event = createStageCompleted(LOCAL_TENANT, {
      jobId: "j1",
      stage: "score",
      finishedAt: "2025-01-01T00:00:00Z",
      durationMs: 5000,
    });
    expect(event.eventType).toBe("StageCompleted");
    expect(event.payload.durationMs).toBe(5000);
  });
});

describe("Profile events", () => {
  it("ProfileUpdated has required fields", () => {
    const event = createProfileUpdated(LOCAL_TENANT, {
      changedSections: ["experience", "skills"],
      updatedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("ProfileUpdated");
    expect(event.tenantId).toBe("local");
    expect(event.payload.changedSections).toEqual(["experience", "skills"]);
  });

  it("ProfileImported has required fields", () => {
    const event = createProfileImported(LOCAL_TENANT, {
      source: "resume.pdf",
      importedSections: ["experience", "education"],
      importedAt: "2025-01-01T00:00:00Z",
    });
    expect(event.eventType).toBe("ProfileImported");
    expect(event.payload.source).toBe("resume.pdf");
  });

  it("TailoringPolicyUpdated carries policy version metadata without content", () => {
    const event = createTailoringPolicyUpdated(LOCAL_TENANT, {
      policyId: "tailoring:default",
      policyVersion: 4,
      previousPolicyVersion: 3,
      policyFingerprint: "tailoring-policy:4",
      changedFields: ["writing_style", "tailoring_policy"],
      updatedAt: "2026-05-26T10:00:00Z",
    });
    expect(event.eventType).toBe("TailoringPolicyUpdated");
    expect(event.payload.policyId).toBe("tailoring:default");
    expect(event.payload.changedFields).toEqual(["writing_style", "tailoring_policy"]);
  });
});

describe("Compensation events", () => {
  it("CompensationFactsUpdated carries safe state markers only", () => {
    const event = createCompensationFactsUpdated(LOCAL_TENANT, {
      jobId: "j1",
      changedSections: ["posted", "market"],
      postedRecordStatus: "recorded",
      postedParseState: "parsed_range",
      marketRecordStatus: "recorded",
      marketEstimateState: "estimated_range",
      updatedAt: "2026-06-19T10:00:00Z",
    });
    expect(event.eventType).toBe("CompensationFactsUpdated");
    expect(event.payload.changedSections).toEqual(["posted", "market"]);
    expect(JSON.stringify(event.payload)).not.toContain("salaryExpectation");
    expect(JSON.stringify(event.payload)).not.toContain("sourceText");
  });
});

describe("All events carry tenantId", () => {
  const factories = [
    () =>
      createJobDiscovered(LOCAL_TENANT, {
        jobId: "j1",
        postingUrl: "u",
        source: "s",
        employer: "e",
        metadata: {},
        discoveredAt: "t",
      }),
    () =>
      createSourceRegistryEntryCreated(LOCAL_TENANT, {
        sourceId: "source-1",
        kind: "smart_extract",
        policyId: "smart_extract_experimental",
        state: "experimental",
        createdAt: "t",
      }),
    () =>
      createJobSourceObserved(LOCAL_TENANT, {
        jobId: "j1",
        sourceObservationId: "observation-1",
        sourceId: "greenhouse:acme",
        sourceNativeId: "123456",
        observedUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        runId: "run-1",
        observedAt: "t",
      }),
    () =>
      createDiscoveryRunStarted(LOCAL_TENANT, {
        runId: "run-1",
        sourceIds: ["greenhouse:acme"],
        profileSnapshotId: null,
        startedAt: "t",
      }),
    () =>
      createDiscoveryRunCompleted(LOCAL_TENANT, {
        runId: "run-1",
        counts: {
          total: 1,
          newJobs: 1,
          existingJobs: 0,
          observedJobs: 1,
          duplicateJobs: 0,
          rejectedDuplicates: 0,
        },
        errorClasses: [],
        completedAt: "t",
      }),
    () =>
      createDiscoveryRunFailed(LOCAL_TENANT, {
        runId: "run-2",
        sourceId: "greenhouse:acme",
        errorClass: "TimeoutError",
        retryable: true,
        failedAt: "t",
      }),
    () =>
      createJobEnriched(LOCAL_TENANT, {
        jobId: "j1",
        fullDescription: "d",
        applicationUrl: "u",
        extractionTier: "t",
        enrichedAt: "t",
      }),
    () =>
      createPostingContentSnapshotCaptured(LOCAL_TENANT, {
        jobId: "j1",
        snapshotVersion: 1,
        snapshotRef: "j1:1",
        sourceId: "greenhouse:acme",
        extractionTier: "json_ld",
        capturedAt: "t",
      }),
    () =>
      createJobActiveStateChanged(LOCAL_TENANT, {
        jobId: "j1",
        activeState: "active",
        previousState: "unknown",
        verificationMethod: "json_ld_valid_through",
        verifiedAt: "t",
      }),
    () =>
      createCompensationFactsUpdated(LOCAL_TENANT, {
        jobId: "j1",
        changedSections: ["posted"],
        postedRecordStatus: "recorded",
        postedParseState: "parsed_range",
        marketRecordStatus: null,
        marketEstimateState: null,
        updatedAt: "t",
      }),
    () =>
      createJobScored(LOCAL_TENANT, {
        jobId: "j1",
        fitScore: 5,
        breakdown: {},
        keywords: [],
        version: 1,
        scoredAt: "t",
      }),
    () =>
      createResumeApproved(LOCAL_TENANT, {
        jobId: "j1",
        artifactId: "a1",
        generation: 1,
        approvedAt: "t",
      }),
    () =>
      createTailoringPolicyUpdated(LOCAL_TENANT, {
        policyId: "tailoring:default",
        policyVersion: 1,
        previousPolicyVersion: null,
        policyFingerprint: "tailoring-policy:1",
        changedFields: ["tailoring_policy"],
        updatedAt: "t",
      }),
    () =>
      createPreparationWorkItemQueued(LOCAL_TENANT, {
        workItemId: "prep-1",
        jobId: "j1",
        kind: "score_job",
        reason: "new_job_discovered",
        targetVersion: 1,
        sourceEventId: "job-enriched-1",
        queuedAt: "t",
      }),
    () =>
      createApplicationEmailFeedbackIngested(LOCAL_TENANT, {
        jobKey: "j1",
        evidenceId: "e1",
        suggestionId: "s1",
        provider: "gmail",
        suggestedKind: "interview",
        classificationConfidence: 0.9,
        linkConfidence: 0.8,
        linkSignals: ["recipient"],
      }),
    () =>
      createApplicationSubmitted(LOCAL_TENANT, {
        jobId: "j1",
        runId: "r1",
        appliedAt: "t",
        verificationConfidence: 0.9,
      }),
    () =>
      createStageStarted(LOCAL_TENANT, {
        jobId: "j1",
        stage: "enrich",
        attemptNumber: 1,
        startedAt: "t",
      }),
    () =>
      createProfileUpdated(LOCAL_TENANT, {
        changedSections: [],
        updatedAt: "t",
      }),
  ];

  for (const factory of factories) {
    const event = factory();
    it(`${event.eventType} has tenantId`, () => {
      expect(event.tenantId).toBe("local");
    });
  }
});

describe("DOMAIN_EVENT_TYPES enumeration", () => {
  it("lists every variant of DomainEventUnion exactly once", () => {
    expect(new Set(DOMAIN_EVENT_TYPES).size).toBe(DOMAIN_EVENT_TYPES.length);
  });

  it("matches the names emitted by every event creator factory", () => {
    const fromFactories = new Set([
      createJobDiscovered(LOCAL_TENANT, {
        jobId: "j",
        postingUrl: "u",
        source: "s",
        employer: "e",
        metadata: {},
        discoveredAt: "t",
      }).eventType,
      createJobHidden(LOCAL_TENANT, {
        jobId: "j",
        reason: "user-requested",
        hiddenAt: "t",
      }).eventType,
      createJobUnhidden(LOCAL_TENANT, {
        jobId: "j",
        unhiddenAt: "t",
      }).eventType,
      createSourceLocationCandidateDiscovered(LOCAL_TENANT, {
        candidateId: "candidate-1",
        candidateUrl: "https://example.com/careers",
        sourceKind: "employer_careers_page",
        confidence: 0.8,
        evidenceRef: "evidence:candidate-1",
        discoveredAt: "t",
      }).eventType,
      createSourceLocationCandidatePromoted(LOCAL_TENANT, {
        candidateId: "candidate-1",
        sourceId: "source-1",
        promotedAt: "t",
      }).eventType,
      createSourceRegistryEntryCreated(LOCAL_TENANT, {
        sourceId: "source-1",
        kind: "smart_extract",
        policyId: "smart_extract_experimental",
        state: "experimental",
        createdAt: "t",
      }).eventType,
      createSourceRegistryEntryUpdated(LOCAL_TENANT, {
        sourceId: "source-1",
        changedFields: ["state"],
        updatedAt: "t",
      }).eventType,
      createSourceStateChanged(LOCAL_TENANT, {
        sourceId: "source-1",
        fromState: "experimental",
        toState: "active",
        reason: "validated",
        changedAt: "t",
      }).eventType,
      createJobSourceObserved(LOCAL_TENANT, {
        jobId: "j",
        sourceObservationId: "observation-1",
        sourceId: "greenhouse:acme",
        sourceNativeId: "123456",
        observedUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        runId: "run-1",
        observedAt: "t",
      }).eventType,
      createDiscoveryRunStarted(LOCAL_TENANT, {
        runId: "run-1",
        sourceIds: ["greenhouse:acme"],
        profileSnapshotId: "profile:1",
        startedAt: "t",
      }).eventType,
      createDiscoveryRunCompleted(LOCAL_TENANT, {
        runId: "run-1",
        counts: {
          total: 1,
          newJobs: 1,
          existingJobs: 0,
          observedJobs: 1,
          duplicateJobs: 0,
          rejectedDuplicates: 0,
        },
        errorClasses: [],
        completedAt: "t",
      }).eventType,
      createDiscoveryRunFailed(LOCAL_TENANT, {
        runId: "run-2",
        sourceId: "greenhouse:acme",
        errorClass: "TimeoutError",
        retryable: true,
        failedAt: "t",
      }).eventType,
      createCanonicalJobIdentityResolved(LOCAL_TENANT, {
        jobId: "j",
        canonicalUrl: "https://boards.greenhouse.io/acme/jobs/123456",
        atsKind: "greenhouse",
        sourceNativeId: "123456",
        confidence: 0.98,
      }).eventType,
      createDuplicateJobLinked(LOCAL_TENANT, {
        duplicateLinkId: "duplicate-link-1",
        survivingJobId: "j",
        supersededJobOrObservationId: "observation-2",
        reason: "ats_identity_match",
        confidence: 0.96,
      }).eventType,
      createDuplicateJobLinkRejected(LOCAL_TENANT, {
        duplicateLinkId: "duplicate-link-rejected-1",
        jobId: "j",
        candidateJobId: "j2",
        reason: "low_confidence",
        rejectedAt: "t",
      }).eventType,
      createDiscoveryFeedbackRecorded(LOCAL_TENANT, {
        feedbackId: "feedback-1",
        jobId: "j",
        sourceId: "greenhouse:acme",
        kind: "saved",
        recordedAt: "t",
      }).eventType,
      createJobEnriched(LOCAL_TENANT, {
        jobId: "j",
        fullDescription: "d",
        applicationUrl: "u",
        extractionTier: "t",
        enrichedAt: "t",
      }).eventType,
      createEnrichmentFailed(LOCAL_TENANT, {
        jobId: "j",
        error: "timeout",
        attemptNumber: 1,
      }).eventType,
      createPostingContentSnapshotCaptured(LOCAL_TENANT, {
        jobId: "j",
        snapshotVersion: 1,
        snapshotRef: "j:1",
        sourceId: "greenhouse:acme",
        extractionTier: "json_ld",
        capturedAt: "t",
      }).eventType,
      createPostingContentSnapshotFailed(LOCAL_TENANT, {
        jobId: "j",
        sourceId: "greenhouse:acme",
        errorClass: "FETCH_ERROR",
        retryable: true,
        failedAt: "t",
      }).eventType,
      createJobActiveStateChanged(LOCAL_TENANT, {
        jobId: "j",
        activeState: "active",
        previousState: "unknown",
        verificationMethod: "json_ld_valid_through",
        verifiedAt: "t",
      }).eventType,
      createContentDuplicateCandidateDetected(LOCAL_TENANT, {
        jobId: "j",
        candidateJobId: "j2",
        evidence: [
          {
            kind: "description_hash_match",
            matchedValue: "hash",
            confidence: 1,
          },
        ],
        confidence: 1,
        detectedAt: "t",
      }).eventType,
      createJobScored(LOCAL_TENANT, {
        jobId: "j",
        fitScore: 1,
        breakdown: {},
        keywords: [],
        version: 1,
        scoredAt: "t",
      }).eventType,
      createScoreRescoreRequested(LOCAL_TENANT, {
        jobId: "j",
        staleReason: "scoring_policy_changed",
        oldPolicyVersion: 1,
        newPolicyVersion: 2,
        nextAction: "run_score",
      }).eventType,
      createResumeApproved(LOCAL_TENANT, {
        jobId: "j",
        artifactId: "a",
        generation: 1,
        approvedAt: "t",
      }).eventType,
      createMaterialsExhausted(LOCAL_TENANT, {
        jobId: "j",
        stage: "tailor",
        attemptCount: 1,
        maxAttempts: 1,
      }).eventType,
      createTailoringPolicyUpdated(LOCAL_TENANT, {
        policyId: "tailoring:default",
        policyVersion: 2,
        previousPolicyVersion: 1,
        policyFingerprint: "tailoring-policy:2",
        changedFields: ["tailoring_policy"],
        updatedAt: "t",
      }).eventType,
      createTailorRetailorRequested(LOCAL_TENANT, {
        requestId: "retailor-1",
        jobId: "j",
        requestKind: "policy_update",
        currentPolicyVersion: 2,
        latestArtifactPolicyVersion: 1,
        reason: "tailoring_policy_changed",
        requestedAt: "t",
      }).eventType,
      createTailoredArtifactsSuppressed(LOCAL_TENANT, {
        jobId: "j",
        artifactIds: ["a"],
        suppressionReason: "tailoring_policy_changed",
        suppressedAt: "t",
        currentTailoringPolicyVersion: 2,
      }).eventType,
      createPreparationWorkItemQueued(LOCAL_TENANT, {
        workItemId: "prep-1",
        jobId: "j",
        kind: "score_job",
        reason: "new_job_discovered",
        targetVersion: 2,
        sourceEventId: "job-enriched-1",
        queuedAt: "t",
      }).eventType,
      createPreparationWorkItemStarted(LOCAL_TENANT, {
        workItemId: "prep-1",
        jobId: "j",
        kind: "score_job",
        workerId: "w",
        startedAt: "t",
      }).eventType,
      createPreparationWorkItemCompleted(LOCAL_TENANT, {
        workItemId: "prep-1",
        jobId: "j",
        kind: "tailor_resume",
        completedAt: "t",
        durationMs: 1,
      }).eventType,
      createPreparationWorkItemFailed(LOCAL_TENANT, {
        workItemId: "prep-1",
        jobId: "j",
        kind: "suppress_tailored_artifacts",
        errorCode: "FAILED",
        retryable: true,
        failedAt: "t",
      }).eventType,
      createApplicationSubmitted(LOCAL_TENANT, {
        jobId: "j",
        runId: "r",
        appliedAt: "t",
        verificationConfidence: 0.5,
      }).eventType,
      createApplyReviewDecisionRecorded(LOCAL_TENANT, {
        jobKey: "j",
        decisionId: "decision-1",
        decision: "approve_dry_run",
        reasonPresent: false,
        materialsGeneration: 1,
        profileVersion: 1,
        applicationUrl: "u",
        partialOverrideRunId: null,
        emailRecipient: null,
        emailAttachmentArtifactId: null,
      }).eventType,
      createApplicationOutcomeRecorded(LOCAL_TENANT, {
        jobKey: "j",
        outcomeId: "outcome-1",
        kind: "interview",
        source: "manual",
        occurredAt: "t",
        suggestionId: null,
        evidenceId: null,
        interviewPrepGeneration: 1,
        notePresent: false,
      }).eventType,
      createOutcomeSuggestionDecided(LOCAL_TENANT, {
        jobKey: "j",
        suggestionId: "suggestion-1",
        evidenceId: null,
        decision: "ignore",
        outcomeId: null,
        outcomeKind: null,
        notePresent: false,
        reasonPresent: false,
      }).eventType,
      createApplicationEmailFeedbackIngested(LOCAL_TENANT, {
        jobKey: "j",
        evidenceId: "e",
        suggestionId: "s",
        provider: "gmail",
        suggestedKind: "interview",
        classificationConfidence: 0.9,
        linkConfidence: 0.8,
        linkSignals: ["recipient"],
      }).eventType,
      createApplyRunStarted(LOCAL_TENANT, {
        jobId: "j",
        runId: "r",
        workerId: "w",
        model: "m",
        dryRun: false,
        startedAt: "t",
      }).eventType,
      createStageStarted(LOCAL_TENANT, {
        jobId: "j",
        stage: "enrich",
        attemptNumber: 1,
        startedAt: "t",
      }).eventType,
      createStageCompleted(LOCAL_TENANT, {
        jobId: "j",
        stage: "enrich",
        finishedAt: "t",
        durationMs: 1,
      }).eventType,
      createProfileUpdated(LOCAL_TENANT, {
        changedSections: [],
        updatedAt: "t",
      }).eventType,
      createProfileImported(LOCAL_TENANT, {
        source: "x",
        importedSections: [],
        importedAt: "t",
      }).eventType,
      createCompensationFactsUpdated(LOCAL_TENANT, {
        jobId: "j",
        changedSections: ["market"],
        postedRecordStatus: null,
        postedParseState: null,
        marketRecordStatus: "recorded",
        marketEstimateState: "insufficient_evidence",
        updatedAt: "t",
      }).eventType,
    ]);
    for (const eventType of fromFactories) {
      expect(DOMAIN_EVENT_TYPES).toContain(eventType);
    }
  });
});
