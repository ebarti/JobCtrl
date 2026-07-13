import {
  LOCAL_TENANT,
  createContactCreated,
  createContactAttributeRecorded,
  createContactResearchTaskCompleted,
  createApplyReviewDecisionRecorded,
  createApplicationOutcomeRecorded,
  createContactDeleted,
  createContactUpdated,
  createDigestReviewed,
  createDiscoveryFeedbackRecorded,
  createJobDeleted,
  createJobDiscovered,
  createJobHidden,
  createJobRestored,
  createJobUnhidden,
  createJobResumeTemplateAssigned,
  createOutreachDraftApproved,
  createOutreachDraftRejected,
  createOutcomeSuggestionDecided,
  createFollowUpScheduled,
  createFollowUpCompleted,
  createFollowUpDismissed,
  createProfileImported,
  createProfileUpdated,
  createResumeTemplateDefaultChanged,
  createResumeTemplateVersionSaved,
  createScoreCorrected,
  createScoreRescoreRequested,
  createSourceLocationCandidatePromoted,
  createSourceRegistryEntryCreated,
  createSourceRegistryEntryUpdated,
  createSourceStateChanged,
  createStageCanceled,
  createStageSkipped,
  createWorkflowCanceled,
  type ApplicationOutcomeKindValue,
  type ApplyReviewDecisionValue,
  type DomainEventUnion,
  type OutcomeSuggestionDecisionValue,
} from "@jobctrl/domain-types";

import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import type { ApiClientResponse } from "./contracts.js";
import {
  purgeDemoJobProjections,
  recomputeDemoOperationalProjections,
  recomputeDemoOutcomeProjections,
} from "./purgeDemoJobProjections.js";
import {
  DemoWorkspaceRepository,
  isDemoScenarioInvocation,
  type DemoPendingScenario,
  type DemoWorkspaceMutationContext,
  type DemoWorkspaceSnapshot,
} from "./workspace/index.js";

export interface DemoCommandClock {
  now(): Date;
}

export interface DemoLocalCommandExecutorOptions {
  readonly clock?: DemoCommandClock;
  readonly createId?: (prefix: string) => string;
}

const systemClock: DemoCommandClock = { now: () => new Date() };

const BROWSER_LOCAL_COMMANDS = [
  "acknowledgeDigest",
  "updateDiscoverySettings",
  "upsertDiscoverySource",
  "patchDiscoverySourceState",
  "updateCompensationSourcePolicy",
  "promoteSourceLocatorCandidate",
  "rejectSourceLocatorCandidate",
  "decideDiscoveryQuarantine",
  "importManualCapture",
  "dismissManualCapture",
  "recordDiscoveryFeedback",
  "decideRoleMatchFeedbackSuggestion",
  "decideApplyReview",
  "createResumeReviewDraft",
  "saveResumeReviewDraftRevision",
  "seedResumeReviewCommentThreads",
  "replyToResumeReviewComment",
  "saveResumeTemplate",
  "setDefaultResumeTemplate",
  "setJobResumeTemplate",
  "recordManualApplicationOutcome",
  "decideOutcomeSuggestion",
  "deleteJob",
  "deleteJobs",
  "permanentlyDeleteJob",
  "permanentlyDeleteJobs",
  "restoreJob",
  "restoreJobs",
  "hideJob",
  "hideJobs",
  "unhideJob",
  "unhideJobs",
  "correctScore",
  "resetStaleScoresForRescore",
  "cancelWorkflowRun",
  "updateProfile",
  "importResume",
  "updateSettings",
  "createContact",
  "updateContact",
  "deleteContact",
  "confirmContactCandidate",
  "approveOutreachDraft",
  "rejectOutreachDraft",
  "scheduleOutreachFollowUp",
  "completeOutreachFollowUp",
  "dismissOutreachFollowUp",
  "cancelJobAction",
  "markSkipped",
] as const satisfies readonly (keyof ApiClientPort)[];

export type DemoBrowserLocalCommand = (typeof BROWSER_LOCAL_COMMANDS)[number];
export { BROWSER_LOCAL_COMMANDS as DEMO_BROWSER_LOCAL_COMMANDS };

export const DEMO_PRODUCTION_NO_EVENT_COMMANDS = [
  "updateDiscoverySettings",
  "updateCompensationSourcePolicy",
  "rejectSourceLocatorCandidate",
  "dismissManualCapture",
  "decideRoleMatchFeedbackSuggestion",
  "createResumeReviewDraft",
  "saveResumeReviewDraftRevision",
  "seedResumeReviewCommentThreads",
  "replyToResumeReviewComment",
  "updateSettings",
] as const satisfies readonly DemoBrowserLocalCommand[];

export class DemoCommandPersistenceError extends Error {
  readonly code = "demo_command_not_persisted" as const;

  constructor() {
    super("The demo command was rolled back because browser storage could not persist it.");
    this.name = "DemoCommandPersistenceError";
  }
}

export class DemoLocalCommandExecutor {
  private readonly clock: DemoCommandClock;
  private readonly createId: (prefix: string) => string;

  constructor(
    private readonly workspace: DemoWorkspaceRepository,
    options: DemoLocalCommandExecutorOptions = {},
  ) {
    this.clock = options.clock ?? systemClock;
    this.createId = options.createId ?? defaultId;
  }

  async execute<TMethod extends DemoBrowserLocalCommand>(
    method: TMethod,
    args: Parameters<ApiClientPort[TMethod]>,
  ): Promise<ApiClientResponse<TMethod>> {
    const current = await this.workspace.snapshot();
    let response: unknown;
    const now = this.clock.now().toISOString();
    const commit = await this.workspace.mutate(
      (draft, context) => {
        response = this.apply(method, args as unknown[], draft, context, now);
      },
      { expectedResetEpoch: current.resetEpoch },
    );
    if (commit.kind !== "committed") {
      throw new DemoCommandPersistenceError();
    }
    return structuredClone(response) as ApiClientResponse<TMethod>;
  }

  private apply(
    method: DemoBrowserLocalCommand,
    args: unknown[],
    draft: DemoWorkspaceSnapshot,
    context: DemoWorkspaceMutationContext,
    now: string,
  ): unknown {
    switch (method) {
      case "acknowledgeDigest": {
        const body = record(args[0]);
        const acknowledgedAt = stringValue(body.acknowledgedAt) ?? now;
        const digest = record(draft.state.readModel.dashboard.digest);
        const previous = stringValue(record(digest.state).acknowledgedAt);
        digest.state = { acknowledgedAt };
        context.appendDomainEvent(atTime(createDigestReviewed(LOCAL_TENANT, {
          acknowledgedAt,
          reviewedAt: now,
          previousAcknowledgedAt: previous,
        }), now));
        return { ok: true, state: digest.state };
      }
      case "updateDiscoverySettings": {
        const body = record(args[0]);
        Object.assign(draft.state.readModel.discovery.settings.settings, body);
        for (const [field, value] of Object.entries(body)) {
          const metadata = draft.state.readModel.discovery.settings.effectiveSettings[
            field as keyof typeof draft.state.readModel.discovery.settings.effectiveSettings
          ];
          if (metadata?.editable) Object.assign(metadata, { value, source: "persisted" });
        }
        return draft.state.readModel.discovery.settings;
      }
      case "upsertDiscoverySource": {
        const body = record(args[0]);
        const sources = draft.state.readModel.discovery.sources.sources;
        const sourceId = requiredString(body.sourceId, "sourceId");
        let source = sources.find((candidate) => candidate.sourceId === sourceId);
        const previous = source ? structuredClone(source) : null;
        if (source) {
          source.kind = requiredString(body.kind, "kind") as typeof source.kind;
          source.displayName = requiredString(body.displayName, "displayName");
          source.priority = requiredString(body.priority, "priority") as typeof source.priority;
          source.state = requiredString(body.state, "state") as typeof source.state;
        } else {
          const base = structuredClone(sources[0]!);
          source = Object.assign(base, {
            sourceId,
            kind: requiredString(body.kind, "kind") as typeof base.kind,
            displayName: requiredString(body.displayName, "displayName"),
            owner: "user",
            priority: requiredString(body.priority, "priority") as typeof base.priority,
            state: requiredString(body.state, "state") as typeof base.state,
            policyId: `demo:${sourceId}`,
            recommendedState: body.state === "disabled" ? "disabled" : "experimental",
            lastRunId: null,
            lastRunCompletedAt: null,
            lastErrorClass: null,
            consecutiveFailures: 0,
            observedJobs: 0,
            newJobs: 0,
            duplicateRate: null,
            activeVerificationRate: null,
            fullDescriptionSuccessRate: null,
            applyUrlSuccessRate: null,
            qualityTrend: "unknown",
          });
          sources.push(source);
        }
        context.appendDomainEvent(previous
          ? atTime(createSourceRegistryEntryUpdated(LOCAL_TENANT, {
              sourceId,
              changedFields: changedSourceFields(previous, source, body),
              updatedAt: now,
            }), now)
          : atTime(createSourceRegistryEntryCreated(LOCAL_TENANT, {
              sourceId,
              kind: source.kind,
              policyId: source.policyId,
              state: source.state,
              createdAt: now,
            }), now));
        return { ok: true, source };
      }
      case "patchDiscoverySourceState": {
        const sourceId = requiredString(args[0], "sourceId");
        const source = requireById(
          draft.state.readModel.discovery.sources.sources,
          "sourceId",
          sourceId,
        );
        const body = record(args[1]);
        const fromState = source.state;
        const toState = requiredString(body.state, "state") as typeof source.state;
        source.state = toState;
        context.appendDomainEvent(atTime(createSourceStateChanged(LOCAL_TENANT, {
          sourceId,
          fromState,
          toState,
          reason: stringValue(body.reason) ?? "",
          changedAt: now,
        }), now));
        context.appendDomainEvent(atTime(createSourceRegistryEntryUpdated(LOCAL_TENANT, {
          sourceId,
          changedFields: ["state"],
          updatedAt: now,
        }), now));
        return { ok: true, source };
      }
      case "updateCompensationSourcePolicy": {
        const body = record(args[0]);
        const sourceId = requiredString(body.sourceId, "sourceId");
        const sources = draft.state.readModel.discovery.compensationSources.sources;
        let source = sources.find((candidate) => candidate.sourceId === sourceId);
        if (!source) {
          source = structuredClone(sources[0]!);
          source.sourceId = sourceId;
          source.displayName = sourceId === "levels_fyi" ? "Levels.fyi" : "Glassdoor";
          source.control = {
            kind: "user_preference",
            enabled: false,
            accessMode: null,
            allowedAccessModes: sourceId === "levels_fyi"
              ? ["licensed_api", "licensed_data_feed", "enterprise_mcp"]
              : ["partner_api", "written_permission"],
            europeCoverageRequired: sourceId === "levels_fyi",
            europeCoverageConfirmed: false,
          };
          sources.push(source);
        }
        const control = record(source.control);
        Object.assign(control, body);
        source.control = control as unknown as typeof source.control;
        return draft.state.readModel.discovery.compensationSources;
      }
      case "promoteSourceLocatorCandidate": {
        const candidateId = requiredString(args[0], "candidateId");
        const sourceId = sourceIdForLocatorCandidate(candidateId);
        const existing = draft.state.readModel.discovery.sources.sources.find(
          (source) => source.sourceId === sourceId,
        );
        if (existing) {
          const decision = [...draft.eventLog].reverse().find((entry) =>
            entry.event.eventType === "SourceLocationCandidatePromoted" &&
            entry.event.payload.candidateId === candidateId &&
            entry.event.payload.sourceId === sourceId,
          );
          const decidedAt = decision?.event.eventType === "SourceLocationCandidatePromoted"
            ? decision.event.payload.promotedAt
            : undefined;
          const persistedDecisionAt = decidedAt ??
            draft.state.readModel.discovery.sourcePreviews[sourceId]?.generatedAt;
          if (!persistedDecisionAt) {
            throw new Error(`Demo source promotion ${candidateId} has no persisted decision evidence.`);
          }
          return { ok: true, candidateId, decision: "promote", source: existing, decidedAt: persistedDecisionAt };
        }
        const candidates = draft.state.readModel.discovery.locatorCandidates.candidates;
        const candidate = requireById(candidates, "candidateId", candidateId);
        draft.state.readModel.discovery.locatorCandidates.candidates = candidates.filter(
          (item) => item.candidateId !== candidateId,
        );
        const base = structuredClone(draft.state.readModel.discovery.sources.sources[0]!);
        const source = {
          ...base,
          sourceId,
          kind: candidate.sourceKind,
          displayName: `Promoted ${candidateId.replace(/^locator-demo-/, "")} source`,
          owner: "user" as const,
          priority: "standard" as const,
          state: "active" as const,
          policyId: `demo-policy:${sourceId}`,
          recommendedState: "normal" as const,
          lastRunId: null,
          lastRunCompletedAt: null,
          lastErrorClass: null,
          consecutiveFailures: 0,
          observedJobs: 0,
          newJobs: 0,
          duplicateRate: null,
          activeVerificationRate: null,
          fullDescriptionSuccessRate: null,
          applyUrlSuccessRate: null,
          qualityTrend: "unknown" as const,
        };
        draft.state.readModel.discovery.sources.sources.push(source);
        mutableMap(draft.state.readModel.discovery.sourcePreviews)[sourceId] = {
          ok: true,
          sourceId,
          leads: [{
            candidateUrl: candidate.candidateUrl,
            title: "Bundled promoted opportunity",
            company: "Synthetic promoted workshop",
            location: "Distributed",
            estimatedConfidence: candidate.confidence,
          }],
          generatedAt: now,
        };
        const health = structuredClone(draft.state.readModel.dashboard.summary.sourceHealth[0]!);
        Object.assign(health, {
          sourceId,
          recommendedState: "active",
          runCount: 0,
          failedRunCount: 0,
          consecutiveFailures: 0,
          observedJobs: 0,
          newJobs: 0,
          existingJobs: 0,
          duplicateRate: null,
          activeVerificationRate: null,
          fullDescriptionSuccessRate: null,
          applyUrlSuccessRate: null,
          lastRunId: null,
          updatedAt: now,
        });
        draft.state.readModel.dashboard.summary.sourceHealth.push(health);
        context.appendDomainEvent(atTime(createSourceLocationCandidatePromoted(LOCAL_TENANT, {
          candidateId,
          sourceId,
          promotedAt: now,
        }), now));
        return {
          ok: true,
          candidateId,
          decision: "promote",
          source,
          decidedAt: now,
        };
      }
      case "rejectSourceLocatorCandidate": {
        const candidateId = requiredString(args[0], "candidateId");
        const candidates = draft.state.readModel.discovery.locatorCandidates.candidates;
        requireById(candidates, "candidateId", candidateId);
        draft.state.readModel.discovery.locatorCandidates.candidates = candidates.filter(
          (item) => item.candidateId !== candidateId,
        );
        return { ok: true, candidateId, decision: "reject", source: null, decidedAt: now };
      }
      case "decideDiscoveryQuarantine": {
        const jobKey = requiredString(args[0], "jobKey");
        const decision = requiredString(record(args[1]).decision, "decision");
        const entry = requireById(draft.state.readModel.discovery.quarantine.entries, "jobKey", jobKey);
        draft.state.readModel.discovery.quarantine.entries =
          draft.state.readModel.discovery.quarantine.entries.filter((item) => item.jobKey !== jobKey);
        context.appendDomainEvent(atTime(createDiscoveryFeedbackRecorded(LOCAL_TENANT, {
          feedbackId: this.createId("feedback"),
          jobId: entry.jobId || entry.jobKey,
          sourceId: entry.sourceId,
          kind: decision === "approve" ? "useful" : "irrelevant",
          recordedAt: now,
        }), now));
        return { ok: true, jobKey, decision, recordedAt: now };
      }
      case "importManualCapture": {
        const itemId = requiredString(args[0], "itemId");
        const body = record(args[1]);
        const jobKey = manualCaptureJobKey(itemId);
        const replay = draft.state.readModel.jobs.details[jobKey];
        if (replay) {
          return manualCaptureImportResponse(
            itemId,
            jobKey,
            replay.job.discoveredAt ?? now,
            "https://demo.invalid/source-preview.html",
            body,
          );
        }
        const item = requireById(
          draft.state.readModel.discovery.manualCapture.items,
          "itemId",
          itemId,
        );
        draft.state.readModel.discovery.manualCapture.items =
          draft.state.readModel.discovery.manualCapture.items.filter((candidate) => candidate.itemId !== itemId);
        const baseDetail = structuredClone(draft.state.readModel.jobs.details["job-northwind-platform"]!);
        const importedJob = {
          ...structuredClone(baseDetail.job),
          jobKey,
          url: `demo-job:manual-capture:${itemId}`,
          title: "Bundled manual-capture opportunity",
          company: "Synthetic capture workshop",
          source: "bundled-manual-capture",
          discoverySource: item.sourceId ?? "demo-source:northwind",
          postingSource: "user_mediated_capture",
          postingSourceUrl: "/demo/source-preview.html",
          strategy: "demo_manual_capture",
          location: "Distributed",
          salary: "Not supplied",
          applicationUrl: "/demo/application-preview.html",
          fitScore: null,
          scoreBreakdown: null,
          scoreKeywords: [],
          scoreReasoning: "Not scored yet.",
          scoreVersion: null,
          scoredAt: null,
          scoreCriteria: null,
          scoreTrace: null,
          scoreCorrection: null,
          scoreStaleness: {
            isStale: false,
            staleReason: null,
            currentPolicyVersion: null,
            targetPolicyVersion: null,
            markedAt: null,
            pendingExplicitRescore: false,
          },
          currentStage: "discover" as const,
          currentSubstage: "discover" as const,
          currentState: "succeeded" as const,
          errorCode: null,
          errorMessage: null,
          nextAction: "Review the bundled capture before scoring.",
          artifactCount: 0,
          applyStatus: null,
          appliedAt: null,
          activeState: "active" as const,
          deletedAt: null,
          hiddenAt: null,
          discoveredAt: now,
          descriptionPreview: "Bundled synthetic role imported from the browser-local manual-capture queue.",
        };
        const listJob = structuredClone(importedJob);
        delete (listJob as Partial<typeof importedJob>).descriptionPreview;
        draft.state.readModel.jobs.list.items.push(listJob);
        mutableMap(draft.state.readModel.jobs.details)[jobKey] = {
          ...baseDetail,
          job: importedJob,
          stages: [],
          artifacts: [],
          auditHistory: [{
            id: `audit:${jobKey}:manual-capture`,
            category: "discovery",
            tone: "info",
            title: "Bundled manual capture imported",
            description: "The public demo imported only its bundled synthetic fixture and made no network request.",
            occurredAt: now,
            actor: "demo-user",
            details: [{ label: "Capture", value: itemId }],
          }],
          applyAudit: {
            state: "repair",
            label: "Preparation required",
            summary: "Score and prepare the bundled capture before application review.",
            reviewEvidenceAvailable: false,
            missingPrerequisites: [],
            hardBlockers: [],
            eligibilityConcerns: [],
            sources: [],
          },
          employerAnalysis: null,
          requirementFitReport: null,
          interviewPrep: null,
          compensationAudit: null,
        };
        mutableMap(draft.state.readModel.analytics.jobOutcomes)[jobKey] = {
          ok: true,
          jobKey,
          outcomes: [],
          suggestions: [],
        };
        draft.state.readModel.jobs.list.pagination.total = draft.state.readModel.jobs.list.items.length;
        draft.state.readModel.jobs.list.pagination.pages = Math.max(
          1,
          Math.ceil(draft.state.readModel.jobs.list.pagination.total / draft.state.readModel.jobs.list.pagination.pageSize),
        );
        draft.state.readModel.dashboard.summary.totals.jobs = draft.state.readModel.jobs.list.items.length;
        draft.state.readModel.dashboard.summary.totals.jobsToday += 1;
        draft.state.readModel.dashboard.digest.newMatches.count += 1;
        const discoverFunnel = draft.state.readModel.dashboard.summary.funnel.find((entry) => entry.stage === "discover");
        if (discoverFunnel) {
          discoverFunnel.total += 1;
          discoverFunnel.succeeded += 1;
        }
        const source = draft.state.readModel.discovery.sources.sources.find(
          (candidate) => candidate.sourceId === importedJob.discoverySource,
        );
        if (source) {
          source.observedJobs += 1;
          source.newJobs += 1;
        }
        const health = draft.state.readModel.dashboard.summary.sourceHealth.find(
          (candidate) => candidate.sourceId === importedJob.discoverySource,
        );
        if (health) {
          health.observedJobs += 1;
          health.newJobs += 1;
        }
        context.appendDomainEvent(atTime(createJobDiscovered(LOCAL_TENANT, {
          jobId: jobKey,
          postingUrl: importedJob.postingSourceUrl,
          source: importedJob.discoverySource,
          employer: importedJob.company,
          metadata: { itemId, captureMode: body.captureMode, bundledDemo: true },
          discoveredAt: now,
        }), now));
        return manualCaptureImportResponse(itemId, jobKey, now, item.originatingUrl, body);
      }
      case "dismissManualCapture": {
        const itemId = requiredString(args[0], "itemId");
        draft.state.readModel.discovery.manualCapture.items =
          draft.state.readModel.discovery.manualCapture.items.filter((item) => item.itemId !== itemId);
        return { ok: true, itemId, status: "dismissed", dismissedAt: now };
      }
      case "recordDiscoveryFeedback": {
        const body = record(args[0]);
        const response = {
          ok: true,
          feedbackId: this.createId("feedback"),
          jobKey: requiredString(body.jobKey, "jobKey"),
          sourceId: stringValue(body.sourceId),
          kind: body.kind,
          recordedAt: now,
        };
        context.appendDomainEvent(atTime(createDiscoveryFeedbackRecorded(LOCAL_TENANT, {
          feedbackId: response.feedbackId,
          jobId: response.jobKey,
          sourceId: response.sourceId,
          kind: response.kind as Parameters<typeof createDiscoveryFeedbackRecorded>[1]["kind"],
          recordedAt: now,
        }), now));
        return response;
      }
      case "decideRoleMatchFeedbackSuggestion": {
        const suggestionId = requiredString(args[0], "suggestionId");
        const body = record(args[1]);
        const suggestion = requireById(
          draft.state.readModel.discovery.roleMatchFeedback.suggestions,
          "suggestionId",
          suggestionId,
        );
        suggestion.status = body.decision === "approve" ? "approved" : "declined";
        suggestion.decidedAt = now;
        suggestion.decisionReason = stringValue(body.reason);
        return { ok: true, suggestion };
      }
      case "decideApplyReview": {
        const jobKey = requiredString(args[0], "jobKey");
        const body = record(args[1]);
        const item = requireById(draft.state.readModel.apply.queue.items, "jobKey", jobKey);
        const decision = requiredOneOf(
          body.decision,
          ["approve_submit", "approve_dry_run", "defer", "decline", "reset"] as const,
          "decision",
        ) satisfies ApplyReviewDecisionValue;
        const gate = item.approvalGate;
        if (decision === "approve_submit") {
          if (numberValue(body.materialsGeneration) !== gate.materialsGeneration) {
            throw new TypeError("approval_stale_materials");
          }
          if (numberValue(body.profileVersion) !== gate.profileVersion) {
            throw new TypeError("approval_stale_profile");
          }
          if (stringValue(body.applicationUrl) !== gate.applicationUrl) {
            throw new TypeError("approval_stale_url");
          }
          const partialOverrideRunId = stringValue(body.partialOverrideRunId);
          if (partialOverrideRunId) {
            if (gate.partialDryRunEvidence?.runId !== partialOverrideRunId) {
              throw new TypeError("partial_override_evidence_invalid");
            }
          } else if (!gate.dryRunEvidence || gate.dryRunEvidence.coverage !== "full") {
            throw new TypeError("awaiting_dry_run");
          }
          if (item.emailApplication) {
            if (
              stringValue(body.emailRecipient)?.toLowerCase() !== item.emailApplication.recipient.toLowerCase() ||
              stringValue(body.emailAttachmentArtifactId) !== item.emailApplication.attachmentArtifactId
            ) {
              throw new TypeError("approval_stale_email_candidate");
            }
          }
        }
        item.review.state = decision === "approve_submit"
          ? "approved_submit"
          : decision === "approve_dry_run"
            ? "approved_dry_run"
            : decision === "defer"
              ? "deferred"
              : decision === "reset"
                ? "pending"
                : "declined";
        item.review.decision = decision === "reset" ? null : decision as typeof item.review.decision;
        item.review.decidedAt = decision === "reset" ? null : now;
        item.review.materialsGeneration = gate.materialsGeneration;
        item.review.profileVersion = gate.profileVersion;
        item.review.applicationUrl = gate.applicationUrl;
        item.review.partialOverrideRunId = stringValue(body.partialOverrideRunId);
        item.review.emailRecipient = item.emailApplication?.recipient ?? null;
        item.review.emailAttachmentArtifactId = item.emailApplication?.attachmentArtifactId ?? null;
        gate.reasons = item.review.state === "pending" ? ["awaiting_approval"] : [];
        recomputeDemoOperationalProjections(draft);
        const response = {
          ok: true,
          decision: {
            decisionId: this.createId("apply-review"),
            jobKey,
            decision,
            reason: stringValue(body.reason),
            decidedBy: stringValue(body.decidedBy) ?? "user",
            decidedAt: now,
            materialsGeneration: gate.materialsGeneration,
            profileVersion: gate.profileVersion,
            applicationUrl: gate.applicationUrl,
            partialOverrideRunId: stringValue(body.partialOverrideRunId),
            emailRecipient: item.emailApplication?.recipient ?? null,
            emailAttachmentArtifactId: item.emailApplication?.attachmentArtifactId ?? null,
          },
        };
        context.appendDomainEvent(atTime(createApplyReviewDecisionRecorded(LOCAL_TENANT, {
          jobKey,
          decisionId: response.decision.decisionId,
          decision,
          reasonPresent: response.decision.reason !== null,
          materialsGeneration: response.decision.materialsGeneration,
          profileVersion: response.decision.profileVersion,
          applicationUrl: response.decision.applicationUrl,
          partialOverrideRunId: response.decision.partialOverrideRunId,
          emailRecipient: response.decision.emailRecipient,
          emailAttachmentArtifactId: response.decision.emailAttachmentArtifactId,
        }), now));
        return response;
      }
      case "createResumeReviewDraft": {
        const jobKey = requiredString(args[0], "jobKey");
        const body = record(args[1]);
        const current = requireMapValue(draft.state.readModel.materials.resumeReviewDrafts, jobKey);
        const baseGeneration = numberValue(body.generation) ?? current.draft.baseGeneration;
        const baseResumeTextArtifactId = stringValue(body.resumeTextArtifactId) ?? current.draft.baseResumeTextArtifactId;
        const baseResumePdfArtifactId = stringValue(body.resumePdfArtifactId) ?? current.draft.baseResumePdfArtifactId;
        if (
          current.draft.state === "active" &&
          current.draft.baseGeneration === baseGeneration &&
          current.draft.baseResumeTextArtifactId === baseResumeTextArtifactId &&
          current.draft.baseResumePdfArtifactId === baseResumePdfArtifactId
        ) {
          return current;
        }
        const response = {
          ok: true as const,
          draft: {
            draftId: this.createId("resume-draft"),
            jobKey,
            baseGeneration,
            baseResumeTextArtifactId,
            baseResumePdfArtifactId,
            rendererFormat: stringValue(body.rendererFormat) ?? current.draft.rendererFormat,
            state: "active" as const,
            currentRevisionId: null,
            latestRevisionNumber: 0,
            createdAt: now,
            updatedAt: now,
            latestRevision: null,
            commentThreads: [],
            feedbackSignals: [],
          },
        };
        mutableMap(draft.state.readModel.materials.resumeReviewDrafts)[jobKey] = response;
        return response;
      }
      case "saveResumeReviewDraftRevision": {
        const draftId = requiredString(args[0], "draftId");
        const response = findDraft(draft, draftId);
        const body = record(args[1]);
        const editedText = typeof body.editedText === "string" ? body.editedText : "";
        const revisionId = this.createId("draft-revision");
        const previousText = response.draft.latestRevision?.editedText ?? "";
        const inputs = arrayValue(body.editDeltas);
        const effectiveInputs = inputs.length > 0 || previousText === editedText
          ? inputs
          : [{
              kind: "replace_text",
              section: "document",
              semanticId: null,
              lineAnchor: null,
              beforeText: previousText.slice(0, 6000),
              afterText: editedText.slice(0, 6000),
            }];
        const editDeltas = normalizeResumeEditDeltas(effectiveInputs, revisionId, now, this.createId);
        const revision = {
          revisionId,
          draftId: response.draft.draftId,
          jobKey: response.draft.jobKey,
          revisionNumber: response.draft.latestRevisionNumber + 1,
          editedText,
          plateDocument: body.plateDocument === undefined ? null : structuredClone(body.plateDocument),
          editDeltas,
          createdAt: now,
        };
        response.draft.latestRevision = revision;
        response.draft.latestRevisionNumber = revision.revisionNumber;
        response.draft.currentRevisionId = revision.revisionId;
        response.draft.state = "active";
        response.draft.updatedAt = now;
        for (const delta of editDeltas) {
          const signal = tailoringFeedbackForEditDelta(
            response.draft,
            delta,
            this.createId("resume-feedback"),
            now,
          );
          persistTailoringFeedbackSignal(draft, response.draft, signal);
        }
        markDemoCommentThreadsSuperseded(response.draft, editDeltas, now);
        return { ok: true, draft: response.draft, revision };
      }
      case "seedResumeReviewCommentThreads": {
        const response = findDraft(draft, requiredString(args[0], "draftId"));
        const inputs = arrayValue(record(args[1]).threads);
        let seededCount = 0;
        let updatedCount = 0;
        for (const rawInput of inputs) {
          const input = record(rawInput);
          const commentBody = requiredTrimmedString(input.commentBody, "commentBody").slice(0, 4000);
          const lineAnchor = normalizeResumeLineAnchor(input.lineAnchor);
          const semanticId = trimmedStringValue(input.semanticId) ?? lineAnchor?.semanticId ?? null;
          const sourcePinId = trimmedStringValue(input.sourcePinId);
          const riskLabel = trimmedStringValue(input.riskLabel);
          const baseArtifactId = trimmedStringValue(input.baseArtifactId) ??
            response.draft.baseResumeTextArtifactId ?? response.draft.baseResumePdfArtifactId;
          const threadId = trimmedStringValue(input.threadId) ?? stableDemoId("resume_thread", [
            response.draft.draftId,
            sourcePinId,
            semanticId,
            lineAnchor?.lineNumber ?? null,
            riskLabel,
            commentBody,
          ]);
          const existing = response.draft.commentThreads.find((thread) => thread.threadId === threadId);
          if (existing) {
            Object.assign(existing, {
              baseArtifactId,
              semanticId,
              lineAnchor,
              sourcePinId,
              riskLabel,
              commentBody,
              updatedAt: now,
            });
            updatedCount += 1;
          } else {
            response.draft.commentThreads.push({
              threadId,
              draftId: response.draft.draftId,
              jobKey: response.draft.jobKey,
              baseArtifactId,
              semanticId,
              lineAnchor,
              sourcePinId,
              riskLabel,
              commentBody,
              state: "open",
              anchorResolved: lineAnchor !== null,
              createdAt: now,
              updatedAt: now,
              replies: [],
            });
            seededCount += 1;
          }
        }
        response.draft.updatedAt = now;
        return {
          ok: true,
          draft: response.draft,
          commentThreads: response.draft.commentThreads,
          seededCount,
          updatedCount,
        };
      }
      case "replyToResumeReviewComment": {
        const threadId = requiredString(args[0], "threadId");
        const body = record(args[1]);
        const { draft: owningDraft, thread } = findCommentThreadContext(draft, threadId);
        const decision = requiredOneOf(
          body.decision,
          ["accepted", "rejected", "clarified", "rewrite_requested"] as const,
          "decision",
        );
        const reply = {
          replyId: this.createId("comment-reply"),
          threadId,
          draftRevisionId: stringValue(body.draftRevisionId),
          author: stringValue(body.author) ?? "user",
          decision,
          body: requiredString(body.body, "body"),
          createdAt: now,
        };
        thread.replies.push(reply);
        thread.state = "user_replied";
        thread.updatedAt = now;
        owningDraft.updatedAt = now;
        const feedbackSignal = {
          signalId: this.createId("resume-feedback"),
          jobKey: owningDraft.jobKey,
          draftId: owningDraft.draftId,
          draftRevisionId: reply.draftRevisionId,
          sourceKind: "comment_reply" as const,
          sourceId: reply.replyId,
          kind: feedbackKindForCommentReply(decision),
          status: "candidate" as const,
          summary: reply.body.slice(0, 500),
          section: null,
          semanticId: thread.semanticId,
          createdAt: now,
          reviewedAt: null,
        };
        persistTailoringFeedbackSignal(draft, owningDraft, feedbackSignal);
        return { ok: true, thread, reply, feedbackSignal };
      }
      case "saveResumeTemplate": {
        const body = record(args[0]);
        const templateId = stringValue(body.templateId) ?? this.createId("template");
        const templates = draft.state.readModel.materials.resumeTemplates.templates;
        const existingIndex = templates.findIndex((template) => template.templateId === templateId);
        const previous = existingIndex >= 0 ? templates[existingIndex]! : templates[0]!;
        const previousVersionId = previous.activeVersion.versionId;
        const base = structuredClone(previous);
        const versionId = this.createId("template-version");
        Object.assign(base, {
          templateId,
          displayName: requiredString(body.displayName, "displayName"),
          builtIn: existingIndex >= 0 ? previous.builtIn : false,
          updatedAt: now,
          activeVersion: {
            ...base.activeVersion,
            templateId,
            versionId,
            versionNumber: existingIndex >= 0 ? base.activeVersion.versionNumber + 1 : 1,
            displayName: requiredString(body.displayName, "displayName"),
            theme: body.theme,
            layout: body.layout ?? {},
            contentHash: `demo:${versionId}`,
            createdAt: now,
          },
        });
        if (existingIndex >= 0) {
          templates[existingIndex] = base;
        } else {
          templates.push(base);
        }
        mutableMap(draft.state.readModel.materials.templateDetails)[templateId] = { ok: true, template: base };
        if (
          draft.state.readModel.materials.resumeTemplates.defaultTemplate?.templateId === templateId &&
          draft.state.readModel.materials.resumeTemplates.defaultTemplate.templateVersionId === previousVersionId
        ) {
          const metadata = templateMetadata(base, "profile_default");
          draft.state.readModel.materials.resumeTemplates.defaultTemplate = metadata;
          refreshDefaultTemplateConsumers(draft, metadata);
        }
        context.appendDomainEvent(atTime(createResumeTemplateVersionSaved(LOCAL_TENANT, {
          templateId,
          templateVersionId: base.activeVersion.versionId,
          versionNumber: base.activeVersion.versionNumber,
          displayName: base.displayName,
          savedAt: now,
        }), now));
        return { ok: true, template: base };
      }
      case "setDefaultResumeTemplate": {
        const body = record(args[0]);
        const templateId = requiredString(body.templateId, "templateId");
        const template = requireById(draft.state.readModel.materials.resumeTemplates.templates, "templateId", templateId);
        const requestedVersionId = stringValue(body.versionId);
        if (requestedVersionId && requestedVersionId !== template.activeVersion.versionId) {
          throw new TypeError(`Demo resume template version ${requestedVersionId} was not found.`);
        }
        const metadata = templateMetadata(template, "profile_default");
        draft.state.readModel.materials.resumeTemplates.defaultTemplate = metadata;
        refreshDefaultTemplateConsumers(draft, metadata);
        context.appendDomainEvent(atTime(createResumeTemplateDefaultChanged(LOCAL_TENANT, {
          templateId: metadata.templateId,
          templateVersionId: metadata.templateVersionId,
          changedAt: now,
        }), now));
        return { ok: true, defaultTemplate: metadata };
      }
      case "setJobResumeTemplate": {
        const jobKey = requiredString(args[0], "jobKey");
        const body = record(args[1]);
        const templateId = stringValue(body.templateId);
        const selected = templateId
          ? requireById(draft.state.readModel.materials.resumeTemplates.templates, "templateId", templateId)
          : null;
        const requestedVersionId = stringValue(body.versionId);
        if (selected && requestedVersionId && requestedVersionId !== selected.activeVersion.versionId) {
          throw new TypeError(`Demo resume template version ${requestedVersionId} was not found.`);
        }
        const effective = selected
          ? templateMetadata(selected, "job_override")
          : draft.state.readModel.materials.resumeTemplates.defaultTemplate ??
            draft.state.readModel.materials.resumeTemplates.builtInDefault;
        const templateState = {
          effective,
          snapshot: effective,
          state: "template_current",
          reason: null,
          lastRefreshAttempt: null,
        } as const;
        updateJobCopies(draft, jobKey, (job) => {
          job.resumeTemplate = templateState;
        });
        context.appendDomainEvent(atTime(createJobResumeTemplateAssigned(LOCAL_TENANT, {
          jobId: jobKey,
          templateId: selected?.templateId ?? null,
          templateVersionId: selected?.activeVersion.versionId ?? null,
          assignedAt: now,
        }), now));
        return { ok: true, jobKey, effectiveTemplate: effective, overrideTemplate: selected ? effective : null, templateState };
      }
      case "recordManualApplicationOutcome": {
        const jobKey = requiredString(args[0], "jobKey");
        requireMapValue(draft.state.readModel.jobs.details, jobKey);
        const body = record(args[1]);
        const kind = requiredOneOf(
          body.kind,
          [
            "applied_confirmation", "recruiter_reply", "interview", "assessment", "rejection",
            "offer", "withdrawn", "bounced", "no_response", "unknown",
          ] as const,
          "kind",
        ) satisfies ApplicationOutcomeKindValue;
        const outcome = {
          outcomeId: this.createId("outcome"),
          jobKey,
          kind,
          source: "manual" as const,
          note: stringValue(body.note),
          occurredAt: stringValue(body.occurredAt) ?? now,
          recordedAt: now,
          suggestionId: null,
          evidenceId: null,
          interviewPrepGeneration: numberValue(body.interviewPrepGeneration),
        };
        draft.state.readModel.analytics.outcomes.outcomes.push(outcome as never);
        requireMapValue(draft.state.readModel.analytics.jobOutcomes, jobKey).outcomes.push(outcome as never);
        recomputeDemoOutcomeProjections(draft);
        context.appendDomainEvent(atTime(createApplicationOutcomeRecorded(LOCAL_TENANT, {
          jobKey,
          outcomeId: outcome.outcomeId,
          kind: outcome.kind,
          source: outcome.source,
          occurredAt: outcome.occurredAt,
          suggestionId: null,
          evidenceId: null,
          interviewPrepGeneration: outcome.interviewPrepGeneration,
          notePresent: outcome.note !== null,
        }), now));
        return { ok: true, outcome };
      }
      case "decideOutcomeSuggestion": {
        const suggestionId = requiredString(args[0], "suggestionId");
        const body = record(args[1]);
        const decision: OutcomeSuggestionDecisionValue = requiredOneOf(
          body.decision,
          ["accept", "correct", "ignore"] as const,
          "decision",
        );
        const suggestion = requireById(draft.state.readModel.analytics.outcomes.suggestions, "suggestionId", suggestionId);
        const perJob = requireMapValue(draft.state.readModel.analytics.jobOutcomes, suggestion.jobKey);
        const perJobSuggestion = requireById(perJob.suggestions, "suggestionId", suggestionId);
        if (suggestion.status !== "pending") {
          const replayOutcome = suggestion.decidedOutcomeId
            ? draft.state.readModel.analytics.outcomes.outcomes.find((outcome) => outcome.outcomeId === suggestion.decidedOutcomeId) ?? null
            : null;
          return { ok: true, suggestion, outcome: replayOutcome };
        }
        suggestion.status = decision === "ignore" ? "ignored" : decision === "correct" ? "corrected" : "accepted";
        suggestion.decidedAt = now;
        suggestion.decisionReason = stringValue(body.reason);
        Object.assign(perJobSuggestion, suggestion);
        if (decision === "ignore") {
          recomputeDemoOutcomeProjections(draft);
          context.appendDomainEvent(atTime(createOutcomeSuggestionDecided(LOCAL_TENANT, {
            jobKey: suggestion.jobKey,
            suggestionId,
            evidenceId: suggestion.evidenceId,
            decision: "ignore",
            outcomeId: null,
            outcomeKind: null,
            notePresent: stringValue(body.note) !== null,
            reasonPresent: stringValue(body.reason) !== null,
          }), now));
          return { ok: true, suggestion, outcome: null };
        }
        const outcome = {
          outcomeId: this.createId("outcome"),
          jobKey: suggestion.jobKey,
          kind: decision === "correct"
            ? requiredOneOf(
                body.outcomeKind,
                [
                  "applied_confirmation", "recruiter_reply", "interview", "assessment", "rejection",
                  "offer", "withdrawn", "bounced", "no_response", "unknown",
                ] as const,
                "outcomeKind",
              )
            : suggestion.suggestedKind,
          source: "email_suggestion",
          note: stringValue(body.note),
          occurredAt: stringValue(body.occurredAt) ?? now,
          recordedAt: now,
          suggestionId,
          evidenceId: suggestion.evidenceId,
          interviewPrepGeneration: null,
        } as unknown as typeof draft.state.readModel.analytics.outcomes.outcomes[number];
        suggestion.decidedOutcomeId = outcome.outcomeId;
        Object.assign(perJobSuggestion, suggestion);
        draft.state.readModel.analytics.outcomes.outcomes.push(outcome);
        perJob.outcomes.push(outcome);
        recomputeDemoOutcomeProjections(draft);
        context.appendDomainEvent(atTime(createApplicationOutcomeRecorded(LOCAL_TENANT, {
          jobKey: outcome.jobKey,
          outcomeId: outcome.outcomeId,
          kind: outcome.kind,
          source: outcome.source,
          occurredAt: outcome.occurredAt,
          suggestionId: outcome.suggestionId,
          evidenceId: outcome.evidenceId,
          interviewPrepGeneration: outcome.interviewPrepGeneration,
          notePresent: outcome.note !== null,
        }), now));
        context.appendDomainEvent(atTime(createOutcomeSuggestionDecided(LOCAL_TENANT, {
          jobKey: suggestion.jobKey,
          suggestionId,
          evidenceId: suggestion.evidenceId,
          decision,
          outcomeId: outcome.outcomeId,
          outcomeKind: outcome.kind,
          notePresent: outcome.note !== null,
          reasonPresent: suggestion.decisionReason !== null,
        }), now));
        return { ok: true, suggestion, outcome };
      }
      case "deleteJob":
      case "restoreJob":
      case "hideJob":
      case "unhideJob":
      case "permanentlyDeleteJob": {
        return this.applyJobMutation(
          method,
          [requiredString(args[0], "jobKey")],
          draft,
          context,
          now,
          stringValue(record(args[1]).reason),
        );
      }
      case "deleteJobs":
      case "restoreJobs":
      case "hideJobs":
      case "unhideJobs":
      case "permanentlyDeleteJobs": {
        const body = record(args[0]);
        return this.applyJobMutation(
          method,
          selectJobKeys(draft, body),
          draft,
          context,
          now,
          stringValue(body.reason),
        );
      }
      case "correctScore": {
        const jobKey = requiredString(args[0], "jobKey");
        const body = record(args[1]);
        const detail = requireMapValue(draft.state.readModel.jobs.details, jobKey);
        const originalScore = detail.job.fitScore ?? 0;
        const correctedScore = requiredNumber(body.correctedScore, "correctedScore");
        const currentPolicyVersion = draft.state.readModel.dashboard.summary.preparation?.currentScoringPolicyVersion ?? detail.job.scoreTrace?.scoringPolicyVersion ?? 1;
        const newPolicyVersion = currentPolicyVersion + 1;
        const correction = {
          originalScore,
          correctedScore,
          rationale: requiredString(body.reason, "reason"),
          correctedBy: "demo-user",
          correctedAt: now,
        };
        updateJobCopies(draft, jobKey, (job) => {
          job.fitScore = correctedScore;
          job.scoreVersion = (job.scoreVersion ?? 0) + 1;
          job.scoredAt = now;
          job.scoreCorrection = correction;
          job.scoreCriteria = job.scoreCriteria
            ? { ...job.scoreCriteria, criteriaVersion: `demo-policy-${newPolicyVersion}` }
            : job.scoreCriteria;
          job.scoreTrace = job.scoreTrace
            ? {
                ...job.scoreTrace,
                scoringPolicyId: `demo:scoring-policy-${newPolicyVersion}`,
                scoringPolicyVersion: newPolicyVersion,
                correctionHistory: [...job.scoreTrace.correctionHistory, correction],
              }
            : job.scoreTrace;
          job.scoreStaleness = {
            isStale: false,
            staleReason: null,
            currentPolicyVersion: newPolicyVersion,
            targetPolicyVersion: newPolicyVersion,
            markedAt: null,
            pendingExplicitRescore: false,
          };
        });
        for (const comparable of draft.state.readModel.jobs.list.items) {
          if (comparable.jobKey === jobKey || comparable.scoreVersion === null) continue;
          updateJobCopies(draft, comparable.jobKey, (job) => {
            job.scoreStaleness = {
              isStale: true,
              staleReason: "scoring_policy_changed",
              currentPolicyVersion: job.scoreTrace?.scoringPolicyVersion ?? currentPolicyVersion,
              targetPolicyVersion: newPolicyVersion,
              markedAt: now,
              pendingExplicitRescore: true,
            };
          });
        }
        const corrected = requireMapValue(draft.state.readModel.jobs.details, jobKey).job;
        const queueItem = draft.state.readModel.apply.queue.items.find((item) => item.jobKey === jobKey);
        if (queueItem) {
          Object.assign(queueItem, {
            fitScore: corrected.fitScore,
            scoreBreakdown: corrected.scoreBreakdown,
            scoreKeywords: corrected.scoreKeywords,
            scoreReasoning: corrected.scoreReasoning,
            scoreVersion: corrected.scoreVersion,
            scoredAt: corrected.scoredAt,
            scoreCriteria: corrected.scoreCriteria,
            scoreTrace: corrected.scoreTrace,
          });
        }
        if (draft.state.readModel.dashboard.summary.preparation) {
          draft.state.readModel.dashboard.summary.preparation.currentScoringPolicyVersion = newPolicyVersion;
          draft.state.readModel.dashboard.summary.preparation.outdatedScoreCount =
            draft.state.readModel.jobs.list.items.filter((job) => job.scoreStaleness.isStale).length;
        }
        draft.state.readModel.dashboard.digest.staleScores.count =
          draft.state.readModel.jobs.list.items.filter((job) => job.scoreStaleness.isStale).length;
        recomputeDemoOperationalProjections(draft);
        context.appendDomainEvent(atTime(createScoreCorrected(LOCAL_TENANT, {
          jobId: jobKey,
          originalScore,
          correctedScore,
          reason: requiredString(body.reason, "reason"),
          correctedAt: now,
        }), now));
        return requireMapValue(draft.state.readModel.jobs.details, jobKey);
      }
      case "resetStaleScoresForRescore": {
        const body = record(args[0]);
        const requested = arrayValue(body.jobKeys).map(String);
        const candidates = draft.state.readModel.jobs.list.items.filter((job) =>
          job.scoreStaleness.isStale && (requested.length === 0 || requested.includes(job.jobKey)),
        );
        const limit = numberValue(body.limit) ?? 0;
        const selected = limit > 0 ? candidates.slice(0, limit) : candidates;
        for (const job of selected) {
          const staleness = structuredClone(job.scoreStaleness);
          updateJobCopies(draft, job.jobKey, (candidate) => {
            candidate.currentState = "pending";
            candidate.nextAction = "Run an explicit browser-local rescore rehearsal.";
          });
          context.appendDomainEvent(atTime(createScoreRescoreRequested(LOCAL_TENANT, {
            jobId: job.jobKey,
            staleReason: staleness.staleReason ?? "scoring_policy_changed",
            oldPolicyVersion: staleness.currentPolicyVersion ?? 0,
            newPolicyVersion: staleness.targetPolicyVersion ?? 0,
            nextAction: "jobctrl run score --rescore",
          }), now));
        }
        return {
          ok: true,
          count: selected.length,
          jobKeys: selected.map((job) => job.jobKey),
          nextAction: "jobctrl run score --rescore",
        };
      }
      case "cancelWorkflowRun": {
        const runId = requiredString(args[0], "runId");
        const { detail, changed } = cancelDemoRun(draft, runId, now);
        removePendingScenarios(
          draft,
          (pending) => pending.runId === runId,
        );
        if (!changed) {
          return actionResponse("cancel", detail.jobKey, runId, detail.finishedAt ?? now, { runId }, "canceled");
        }
        context.appendDomainEvent(atTime(createWorkflowCanceled(LOCAL_TENANT, {
          workflowId: detail.workflowId,
          workflowType: detail.workflowType,
          status: "canceled",
          errorCode: "",
          errorMessage: "",
          finishedAt: detail.finishedAt,
          durationMs: detail.durationMs,
          temporalRunId: detail.temporalRunId,
        }), now));
        context.appendDomainEvent(atTime(createStageCanceled(LOCAL_TENANT, {
          jobId: detail.jobKey,
          stage: draft.state.readModel.jobs.details[detail.jobKey]?.job.currentStage ?? "apply",
          canceledAt: now,
          reason: `Workflow ${runId} canceled in the browser-local demo.`,
        }), now));
        recomputeDemoOperationalProjections(draft);
        return actionResponse("cancel", detail.jobKey, runId, now, { runId }, "canceled");
      }
      case "updateProfile": {
        const body = record(args[0]);
        const profile = draft.state.readModel.profile.config;
        if (body.profile !== undefined) profile.profile = structuredClone(body.profile);
        if (body.style !== undefined) profile.style = structuredClone(body.style);
        if (typeof body.templateText === "string") profile.templateText = body.templateText;
        context.appendDomainEvent(atTime(createProfileUpdated(LOCAL_TENANT, {
          changedSections: Object.keys(body),
          updatedAt: now,
        }), now));
        return profile;
      }
      case "importResume": {
        context.appendDomainEvent(atTime(createProfileImported(LOCAL_TENANT, {
          source: "bundled_demo_resume",
          importedSections: ["resume", "style"],
          importedAt: now,
        }), now));
        return {
          ok: true,
          profile: draft.state.readModel.profile.config.profile,
          style: draft.state.readModel.profile.config.style,
          templateText: draft.state.readModel.profile.config.templateText,
          source: { kind: "bundled_demo", filename: stringValue(record(args[0]).filename) ?? "resume.pdf" },
        };
      }
      case "updateSettings": {
        const body = record(args[0]);
        Object.assign(draft.state.readModel.settings.settings, body);
        for (const [field, value] of Object.entries(body)) {
          const metadata = draft.state.readModel.settings.effectiveSettings[
            field as keyof typeof draft.state.readModel.settings.effectiveSettings
          ];
          if (metadata?.editable) {
            Object.assign(metadata, { value, source: "persisted" });
          }
        }
        const dailyBudgetUsd = numberValue(body.dailyBudgetUsd);
        if (dailyBudgetUsd !== null) {
          const spend = draft.state.readModel.dashboard.health.llmSpend;
          spend.dailyBudgetUsd = dailyBudgetUsd;
          spend.remainingUsd = Math.max(0, dailyBudgetUsd - spend.estimatedUsd);
          const digestBudget = draft.state.readModel.dashboard.digest.budget;
          digestBudget.dailyBudgetUsd = dailyBudgetUsd;
          digestBudget.remainingUsd = Math.max(0, dailyBudgetUsd - digestBudget.estimatedUsd);
        }
        recomputeDemoOperationalProjections(draft);
        return draft.state.readModel.settings;
      }
      case "createContact": {
        const body = record(args[0]);
        const contactId = this.createId("contact");
        const attributes = arrayValue(body.attributes).map((rawAttribute, index) => {
          const attribute = record(rawAttribute);
          return {
            attributeId: this.createId(`contact-attribute-${index + 1}`),
            kind: requiredTrimmedString(attribute.kind, `attributes[${index}].kind`),
            value: requiredTrimmedString(attribute.value, `attributes[${index}].value`),
            provenance: {
              sourceKind: "user_entered" as const,
              sourceRef: "user_entered",
              captureMethod: "manual",
              capturedAt: now,
              confidence: 1,
              userConfirmed: true,
            },
          };
        });
        const contact = {
          contactId,
          displayName: attributes.find((attribute) => attribute.kind === "name")?.value ?? "",
          role: body.role ?? "other",
          employer: stringValue(body.employer),
          jobId: stringValue(body.jobId),
          attributes,
          createdAt: now,
          updatedAt: now,
        } as unknown as DemoWorkspaceSnapshot["state"]["readModel"]["contacts"]["details"][string]["contact"];
        mutableMap(draft.state.readModel.contacts.details)[contactId] = { ok: true, contact } as never;
        draft.state.readModel.contacts.list.items.push(contactSummary(contact));
        context.appendDomainEvent(atTime(createContactCreated(LOCAL_TENANT, {
          contactId,
          employer: contact.employer,
          jobId: contact.jobId,
          role: contact.role,
          createdAt: now,
        }), now));
        for (const attribute of attributes) {
          context.appendDomainEvent(atTime(createContactAttributeRecorded(LOCAL_TENANT, {
            contactId,
            attributeId: attribute.attributeId,
            attributeKind: attribute.kind,
            sourceKind: attribute.provenance.sourceKind,
            sourceRef: attribute.provenance.sourceRef,
            captureMethod: attribute.provenance.captureMethod,
            confidence: attribute.provenance.confidence,
            userConfirmed: attribute.provenance.userConfirmed,
            recordedAt: attribute.provenance.capturedAt,
          }), now));
        }
        return { ok: true, contact };
      }
      case "updateContact": {
        const contactId = requiredString(args[0], "contactId");
        const body = record(args[1]);
        const detail = requireMapValue(draft.state.readModel.contacts.details, contactId);
        const contact = detail.contact;
        const employer = Object.hasOwn(body, "employer") ? trimmedStringValue(body.employer) : contact.employer;
        const jobId = Object.hasOwn(body, "jobId") ? trimmedStringValue(body.jobId) : contact.jobId;
        if (!employer && !jobId) {
          throw new TypeError("A contact must link to at least one of employer or jobId.");
        }
        const role = stringValue(body.role) ?? contact.role;
        const changedFields: string[] = [];
        if (role !== contact.role) changedFields.push("role");
        if (employer !== contact.employer) changedFields.push("employer");
        if (jobId !== contact.jobId) changedFields.push("jobId");
        const createdAttributes: typeof contact.attributes = [];
        let attributes = contact.attributes;
        if (Object.hasOwn(body, "attributes")) {
          changedFields.push("attributes");
          const remaining = new Map<string, typeof contact.attributes>();
          for (const attribute of contact.attributes) {
            const key = `${attribute.kind} ${attribute.value}`;
            const bucket = remaining.get(key);
            if (bucket) bucket.push(attribute);
            else remaining.set(key, [attribute]);
          }
          attributes = arrayValue(body.attributes).flatMap((rawAttribute, index) => {
            const input = record(rawAttribute);
            const kind = requiredTrimmedString(input.kind, `attributes[${index}].kind`);
            const value = requiredTrimmedString(input.value, `attributes[${index}].value`);
            const kept = remaining.get(`${kind} ${value}`)?.shift();
            if (kept) return [structuredClone(kept)];
            const attribute = {
              attributeId: this.createId(`contact-attribute-${index + 1}`),
              kind,
              value,
              provenance: {
                sourceKind: "user_entered" as const,
                sourceRef: "user_entered",
                captureMethod: "manual",
                capturedAt: now,
                confidence: 1,
                userConfirmed: true,
              },
            } as typeof contact.attributes[number];
            createdAttributes.push(attribute);
            return [attribute];
          });
        }
        Object.assign(contact, {
          displayName: attributes.find((attribute) => attribute.kind === "name")?.value ?? "",
          role,
          employer,
          jobId,
          attributes,
          updatedAt: now,
        });
        replaceContactSummary(draft, contact);
        context.appendDomainEvent(atTime(createContactUpdated(LOCAL_TENANT, {
          contactId,
          changedFields,
          updatedAt: now,
        }), now));
        for (const attribute of createdAttributes) {
          context.appendDomainEvent(atTime(createContactAttributeRecorded(LOCAL_TENANT, {
            contactId,
            attributeId: attribute.attributeId,
            attributeKind: attribute.kind,
            sourceKind: attribute.provenance.sourceKind,
            sourceRef: attribute.provenance.sourceRef,
            captureMethod: attribute.provenance.captureMethod,
            confidence: attribute.provenance.confidence,
            userConfirmed: attribute.provenance.userConfirmed,
            recordedAt: attribute.provenance.capturedAt,
          }), now));
        }
        return detail;
      }
      case "deleteContact": {
        const contactId = requiredString(args[0], "contactId");
        requireMapValue(draft.state.readModel.contacts.details, contactId);
        delete mutableMap(draft.state.readModel.contacts.details)[contactId];
        draft.state.readModel.contacts.list.items = draft.state.readModel.contacts.list.items.filter((contact) => contact.contactId !== contactId);
        const thread = draft.state.readModel.outreach.thread.thread;
        if (thread?.contactId === contactId) {
          draft.state.readModel.outreach.thread.thread = null;
          draft.state.readModel.outreach.dueFollowUps.followUps = [];
        }
        context.appendDomainEvent(atTime(createContactDeleted(LOCAL_TENANT, { contactId, reason: stringValue(record(args[1]).reason) ?? "demo user deletion", deletedAt: now }), now));
        return { ok: true, contactId, deletedAt: now };
      }
      case "confirmContactCandidate": {
        const taskId = requiredString(args[0], "taskId");
        const candidateId = requiredString(args[1], "candidateId");
        const taskDetail = requireMapValue(draft.state.readModel.contacts.researchTaskDetails, taskId);
        const candidate = requireById(taskDetail.task.candidates, "candidateId", candidateId);
        if (candidate.status !== "needs_review") {
          throw new TypeError(`Demo contact candidate ${candidateId} is not awaiting review.`);
        }
        const contactId = this.createId("contact");
        const attributes = candidate.attributes.map((attribute) => ({
          ...structuredClone(attribute),
          provenance: {
            ...structuredClone(attribute.provenance),
            userConfirmed: true,
          },
        }));
        const displayName = attributes.find((attribute) => attribute.kind === "name")?.value
          ?? attributes.find((attribute) => attribute.kind === "title")?.value
          ?? "Synthetic confirmed contact";
        const contact = {
          contactId,
          displayName,
          role: record(args[2]).role ?? candidate.role,
          employer: taskDetail.task.employer,
          jobId: taskDetail.task.jobId,
          attributes,
          createdAt: now,
          updatedAt: now,
        } as typeof draft.state.readModel.contacts.details[string]["contact"];
        candidate.status = "confirmed";
        candidate.confirmedContactId = contactId;
        candidate.confirmedAt = now;
        taskDetail.task.confirmedCount = taskDetail.task.candidates.filter((item) => item.status === "confirmed").length;
        taskDetail.task.needsReviewCount = taskDetail.task.candidates.filter((item) => item.status === "needs_review").length;
        taskDetail.task.updatedAt = now;
        if (taskDetail.task.needsReviewCount === 0) {
          taskDetail.task.status = "completed";
          taskDetail.task.completedAt = now;
        }
        const summary = requireById(draft.state.readModel.contacts.researchTasks.items, "taskId", taskId);
        Object.assign(summary, {
          status: taskDetail.task.status,
          candidateCount: taskDetail.task.candidateCount,
          confirmedCount: taskDetail.task.confirmedCount,
          needsReviewCount: taskDetail.task.needsReviewCount,
          updatedAt: now,
          completedAt: taskDetail.task.completedAt,
        });
        mutableMap(draft.state.readModel.contacts.details)[contactId] = { ok: true, contact };
        draft.state.readModel.contacts.list.items.push(contactSummary(contact));
        context.appendDomainEvent(atTime(createContactCreated(LOCAL_TENANT, {
          contactId,
          employer: contact.employer,
          jobId: contact.jobId,
          role: contact.role,
          createdAt: now,
        }), now));
        for (const attribute of attributes) {
          context.appendDomainEvent(atTime(createContactAttributeRecorded(LOCAL_TENANT, {
            contactId,
            attributeId: attribute.attributeId,
            attributeKind: attribute.kind,
            sourceKind: attribute.provenance.sourceKind,
            sourceRef: attribute.provenance.sourceRef,
            captureMethod: attribute.provenance.captureMethod,
            confidence: attribute.provenance.confidence,
            userConfirmed: true,
            recordedAt: now,
          }), now));
        }
        if (taskDetail.task.status === "completed") {
          context.appendDomainEvent(atTime(createContactResearchTaskCompleted(LOCAL_TENANT, {
            taskId,
            confirmedCount: taskDetail.task.confirmedCount,
            completedAt: now,
          }), now));
        }
        return { ok: true, contact, task: summary };
      }
      case "approveOutreachDraft":
      case "rejectOutreachDraft": {
        const threadId = requiredString(args[0], "threadId");
        const draftId = requiredString(args[1], "draftId");
        const thread = requireThread(draft, threadId);
        const selected = requireById(thread.drafts, "draftId", draftId);
        const approved = method === "approveOutreachDraft";
        if (selected.status !== "candidate") {
          throw new TypeError(`Demo outreach draft ${draftId} is not awaiting review.`);
        }
        selected.status = approved ? "approved" : "rejected";
        selected.approvedAt = approved ? now : null;
        selected.rejectedAt = approved ? null : now;
        selected.reason = approved ? "" : stringValue(record(args[2]).reason) ?? "Rejected in the browser-local demo.";
        thread.approvedDraftId = approved
          ? draftId
          : thread.approvedDraftId === draftId
            ? thread.drafts.find((item) => item.status === "approved")?.draftId ?? null
            : thread.approvedDraftId;
        thread.hasApprovedDraft = thread.drafts.some((item) => item.status === "approved");
        thread.latestStatus = selected.status;
        thread.updatedAt = now;
        context.appendDomainEvent(approved
          ? atTime(createOutreachDraftApproved(LOCAL_TENANT, {
              threadId,
              draftId,
              generation: selected.generation,
              approvedAt: now,
            }), now)
          : atTime(createOutreachDraftRejected(LOCAL_TENANT, {
              threadId,
              draftId,
              generation: selected.generation,
              reason: selected.reason,
              rejectedAt: now,
            }), now));
        return draft.state.readModel.outreach.thread;
      }
      case "scheduleOutreachFollowUp":
      case "completeOutreachFollowUp":
      case "dismissOutreachFollowUp": {
        const thread = requireThread(draft, requiredString(args[0], "threadId"));
        const body = record(args[1]);
        if (method === "scheduleOutreachFollowUp") {
          thread.followUp = {
            state: "scheduled",
            dueAt: stringValue(body.dueAt) ?? new Date(this.clock.now().getTime() + 86_400_000).toISOString(),
            basis: stringValue(body.basis) ?? "manual",
          };
          context.appendDomainEvent(atTime(createFollowUpScheduled(LOCAL_TENANT, {
            threadId: thread.threadId,
            jobId: thread.jobId,
            dueAt: requiredString(thread.followUp.dueAt, "dueAt"),
            basis: requiredString(thread.followUp.basis, "basis"),
            scheduledAt: now,
          }), now));
        } else {
          if (thread.followUp?.state !== "scheduled") {
            throw new TypeError(`Demo outreach thread ${thread.threadId} has no scheduled follow-up.`);
          }
          thread.followUp = { ...thread.followUp!, state: method === "completeOutreachFollowUp" ? "completed" : "dismissed" };
          context.appendDomainEvent(method === "completeOutreachFollowUp"
            ? atTime(createFollowUpCompleted(LOCAL_TENANT, { threadId: thread.threadId, completedAt: now }), now)
            : atTime(createFollowUpDismissed(LOCAL_TENANT, {
                threadId: thread.threadId,
                reason: "Dismissed in the browser-local demo.",
                dismissedAt: now,
              }), now));
        }
        syncDueFollowUps(draft, thread);
        draft.state.readModel.dashboard.digest.followUpsDue.count =
          draft.state.readModel.outreach.dueFollowUps.followUps.length;
        return draft.state.readModel.outreach.thread;
      }
      case "cancelJobAction":
      case "markSkipped": {
        const jobKey = requiredString(args[0], "jobKey");
        const action = method === "cancelJobAction" ? "cancel" : "mark_skipped";
        const body = record(args[1]);
        const requestedRunId = stringValue(body.runId);
        const pendingActiveRun = [...draft.pendingScenarios]
          .reverse()
          .map((pending) =>
            isDemoScenarioInvocation(pending) &&
            (pending.targetRefs.jobKey === jobKey || pending.targetRefs.jobKeys.includes(jobKey))
              ? draft.state.readModel.runs.details[pending.runId]
              : undefined,
          )
          .find(
            (run) =>
              run?.jobKey === jobKey &&
              (run.status === "starting" || run.status === "in_progress"),
          );
        const activeRun = requestedRunId
          ? requireMapValue(draft.state.readModel.runs.details, requestedRunId)
          : method === "cancelJobAction"
            ? pendingActiveRun ?? Object.values(draft.state.readModel.runs.details).find(
                (run) =>
                  run.jobKey === jobKey &&
                  (run.status === "starting" || run.status === "in_progress"),
              )
            : undefined;
        if (activeRun && activeRun.jobKey !== jobKey) {
          throw new TypeError(`Demo workflow run ${activeRun.runId} does not belong to ${jobKey}.`);
        }
        if (method === "cancelJobAction" && !activeRun) {
          throw new TypeError(`Demo job ${jobKey} has no active workflow run to cancel.`);
        }
        if (method === "cancelJobAction" && activeRun) {
          const canceled = cancelDemoRun(draft, activeRun.runId, now);
          removePendingScenarios(
            draft,
            (pending) => pending.runId === activeRun.runId,
          );
          if (!canceled.changed) {
            return actionResponse("cancel", jobKey, activeRun.runId, activeRun.finishedAt ?? now, {
              runId: activeRun.runId,
              reason: stringValue(body.reason),
            }, "canceled");
          }
          context.appendDomainEvent(atTime(createWorkflowCanceled(LOCAL_TENANT, {
            workflowId: activeRun.workflowId,
            workflowType: activeRun.workflowType,
            status: "canceled",
            errorCode: "",
            errorMessage: "",
            finishedAt: now,
            durationMs: durationBetween(activeRun.startedAt, now),
            temporalRunId: activeRun.temporalRunId,
          }), now));
        }
        updateJobCopies(draft, jobKey, (job) => {
          job.currentState = method === "cancelJobAction" ? "canceled" : "skipped";
          job.nextAction = null;
        });
        const detail = requireMapValue(draft.state.readModel.jobs.details, jobKey);
        const stage = detail.stages.find((candidate) => candidate.stage === detail.job.currentStage) ?? detail.stages[0];
        if (stage) {
          stage.state = method === "cancelJobAction" ? "canceled" : "skipped";
          stage.updatedAt = now;
          stage.finishedAt = now;
          stage.durationMs = durationBetween(stage.startedAt, now);
          stage.retryable = method === "cancelJobAction";
          stage.errorCode = null;
          stage.errorMessage = null;
          stage.nextAction = null;
        }
        const queueItem = draft.state.readModel.apply.queue.items.find((item) => item.jobKey === jobKey);
        if (queueItem) {
          queueItem.currentState = method === "cancelJobAction" ? "canceled" : "skipped";
          if (method === "markSkipped") {
            queueItem.review.state = "declined";
            queueItem.review.decision = "decline";
            queueItem.review.decidedAt = now;
          }
        }
        if (method === "cancelJobAction") {
          context.appendDomainEvent(atTime(createStageCanceled(LOCAL_TENANT, {
            jobId: jobKey,
            stage: detail.job.currentStage,
            canceledAt: now,
            reason: stringValue(body.reason) ?? "Canceled in the browser-local demo.",
          }), now));
        } else {
          context.appendDomainEvent(atTime(createStageSkipped(LOCAL_TENANT, {
            jobId: jobKey,
            stage: detail.job.currentStage,
            reason: stringValue(body.reason) ?? "Skipped in the browser-local demo.",
          }), now));
        }
        recomputeDemoOperationalProjections(draft);
        const runId = activeRun?.runId ?? requestedRunId ?? `job-action:${jobKey}:mark-skipped`;
        return actionResponse(
          action,
          jobKey,
          runId,
          now,
          { ...(requestedRunId ? { runId: requestedRunId } : {}), reason: stringValue(body.reason) },
          method === "cancelJobAction" ? "canceled" : "succeeded",
        );
      }
    }
  }

  private applyJobMutation(
    method: "deleteJob" | "deleteJobs" | "hideJob" | "hideJobs" | "permanentlyDeleteJob" | "permanentlyDeleteJobs" | "restoreJob" | "restoreJobs" | "unhideJob" | "unhideJobs",
    jobKeys: string[],
    draft: DemoWorkspaceSnapshot,
    context: DemoWorkspaceMutationContext,
    now: string,
    reason: string | null,
  ): unknown {
    const permanent = method.startsWith("permanently");
    const hide = method.startsWith("hide");
    const restore = method.startsWith("restore");
    const unhide = method.startsWith("unhide");
    for (const jobKey of jobKeys) {
      requireMapValue(draft.state.readModel.jobs.details, jobKey);
      if (permanent) {
        const purged = purgeDemoJobProjections(draft, jobKey);
        for (const blobId of purged.blobIdsToDelete) context.deleteBlob(blobId);
      } else {
        updateJobCopies(draft, jobKey, (job) => {
          if (restore) {
            job.deletedAt = null;
          } else if (unhide) {
            job.hiddenAt = null;
          } else if (hide) {
            job.hiddenAt = now;
          } else {
            job.deletedAt = now;
          }
        });
      }
      if (permanent) {
        // Production purges have no ordinary lifecycle event. The workspace
        // revision backstop performs the required broad cache resync.
      } else if (restore) {
        context.appendDomainEvent(atTime(createJobRestored(LOCAL_TENANT, { jobId: jobKey, restoredAt: now }), now));
      } else if (hide) {
        context.appendDomainEvent(atTime(createJobHidden(LOCAL_TENANT, {
          jobId: jobKey,
          reason: reason ?? "",
          hiddenAt: now,
        }), now));
      } else if (unhide) {
        context.appendDomainEvent(atTime(createJobUnhidden(LOCAL_TENANT, { jobId: jobKey, unhiddenAt: now }), now));
      } else {
        context.appendDomainEvent(atTime(createJobDeleted(LOCAL_TENANT, {
          jobId: jobKey,
          reason: reason ?? (permanent ? "permanent demo deletion" : "deleted in demo"),
          deletedAt: now,
        }), now));
      }
    }
    if (!permanent) recomputeDemoOutcomeProjections(draft);
    return { ok: true, count: jobKeys.length, jobKeys };
  }
}

function defaultId(prefix: string): string {
  const suffix = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2);
  return `demo-${prefix}-${suffix}`;
}

function sourceIdForLocatorCandidate(candidateId: string): string {
  return `demo-source:locator:${candidateId}`;
}

function changedSourceFields(
  previous: DemoWorkspaceSnapshot["state"]["readModel"]["discovery"]["sources"]["sources"][number],
  next: DemoWorkspaceSnapshot["state"]["readModel"]["discovery"]["sources"]["sources"][number],
  input: Record<string, unknown>,
): string[] {
  const changed: string[] = [];
  if (previous.kind !== next.kind) changed.push("kind");
  if (previous.displayName !== next.displayName) changed.push("displayName");
  if (previous.priority !== next.priority) changed.push("priority");
  if (previous.state !== next.state) changed.push("state");
  if (Object.hasOwn(input, "seedUrl")) changed.push("seedUrl");
  return changed.length > 0 ? changed : ["updatedAt"];
}

function manualCaptureJobKey(itemId: string): string {
  return `job-manual-capture:${itemId}`;
}

function manualCaptureImportResponse(
  itemId: string,
  jobKey: string,
  importedAt: string,
  originatingUrl: string,
  body: Record<string, unknown>,
) {
  return {
    ok: true,
    itemId,
    jobKey,
    importedAt,
    provenance: {
      sourceKind: "user_mediated_capture" as const,
      originatingUrl,
      captureMode: body.captureMode,
      futureManualActionRequired: body.futureManualActionRequired === true,
    },
  };
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function trimmedStringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function requiredString(value: unknown, label: string): string {
  const result = stringValue(value);
  if (result === null) throw new TypeError(`Demo command requires ${label}.`);
  return result;
}

function requiredTrimmedString(value: unknown, label: string): string {
  const result = trimmedStringValue(value);
  if (result === null) throw new TypeError(`Demo command requires ${label}.`);
  return result;
}

function stableDemoId(prefix: string, parts: readonly unknown[]): string {
  const input = JSON.stringify(parts);
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}_${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function requiredNumber(value: unknown, label: string): number {
  const result = numberValue(value);
  if (result === null) throw new TypeError(`Demo command requires ${label}.`);
  return result;
}

function requiredOneOf<const TValues extends readonly string[]>(
  value: unknown,
  values: TValues,
  label: string,
): TValues[number] {
  const result = requiredString(value, label);
  if (!values.includes(result)) {
    throw new TypeError(`Demo command requires a valid ${label}.`);
  }
  return result as TValues[number];
}

function requireById<TValue extends object>(values: TValue[], key: keyof TValue, id: string): TValue {
  const value = values.find((candidate) => candidate[key] === id);
  if (!value) throw new Error(`Demo resource ${id} was not found.`);
  return value;
}

function requireMapValue<TValue>(values: Record<string, TValue>, id: string): TValue {
  const value = values[id];
  if (value === undefined) throw new Error(`Demo resource ${id} was not found.`);
  return value;
}

function mutableMap<TValue>(values: Readonly<Record<string, TValue>>): Record<string, TValue> {
  return values as Record<string, TValue>;
}

function atTime<TEvent extends DomainEventUnion>(event: TEvent, occurredAt: string): TEvent {
  return { ...event, occurredAt };
}

function selectJobKeys(draft: DemoWorkspaceSnapshot, body: Record<string, unknown>): string[] {
  const explicit = arrayValue(body.jobKeys).map(String);
  return body.allMatching === true
    ? draft.state.readModel.jobs.list.items.map((job) => job.jobKey)
    : explicit;
}

function updateJobCopies(
  draft: DemoWorkspaceSnapshot,
  jobKey: string,
  update: (job: DemoWorkspaceSnapshot["state"]["readModel"]["jobs"]["list"]["items"][number]) => void,
): void {
  const summary = draft.state.readModel.jobs.list.items.find((job) => job.jobKey === jobKey);
  const detail = requireMapValue(draft.state.readModel.jobs.details, jobKey);
  if (summary) update(summary);
  update(detail.job);
}

function findDraft(draft: DemoWorkspaceSnapshot, draftId: string) {
  const response = Object.values(draft.state.readModel.materials.resumeReviewDrafts)
    .find((candidate) => candidate.draft.draftId === draftId);
  if (!response) throw new Error(`Demo resume draft ${draftId} was not found.`);
  return response;
}

type DemoResumeDraft = DemoWorkspaceSnapshot["state"]["readModel"]["materials"]["resumeReviewDrafts"][string]["draft"];
type DemoResumeEditDelta = NonNullable<DemoResumeDraft["latestRevision"]>["editDeltas"][number];
type DemoTailoringFeedbackSignal = DemoResumeDraft["feedbackSignals"][number];

function findCommentThreadContext(draft: DemoWorkspaceSnapshot, threadId: string) {
  for (const response of Object.values(draft.state.readModel.materials.resumeReviewDrafts)) {
    const thread = response.draft.commentThreads.find((candidate) => candidate.threadId === threadId);
    if (thread) return { draft: response.draft, thread };
  }
  throw new Error(`Demo comment thread ${threadId} was not found.`);
}

function normalizeResumeEditDeltas(
  inputs: unknown[],
  revisionId: string,
  createdAt: string,
  createId: (prefix: string) => string,
): DemoResumeEditDelta[] {
  return inputs.flatMap((rawInput) => {
    const input = record(rawInput);
    const beforeText = typeof input.beforeText === "string" ? input.beforeText : "";
    const afterText = typeof input.afterText === "string" ? input.afterText : "";
    if (beforeText === afterText) return [];
    return [{
      deltaId: trimmedStringValue(input.deltaId) ?? createId("resume-delta"),
      revisionId,
      kind: requiredOneOf(
        input.kind ?? "replace_text",
        ["replace_text", "insert_text", "delete_text", "structure_change"] as const,
        "edit delta kind",
      ),
      section: trimmedStringValue(input.section),
      semanticId: trimmedStringValue(input.semanticId),
      lineAnchor: normalizeResumeLineAnchor(input.lineAnchor),
      beforeText,
      afterText,
      createdAt,
    }];
  });
}

function normalizeResumeLineAnchor(value: unknown): DemoResumeEditDelta["lineAnchor"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  return {
    semanticId: trimmedStringValue(input.semanticId),
    lineNumber: numberValue(input.lineNumber),
    pageNumber: numberValue(input.pageNumber),
    textHash: trimmedStringValue(input.textHash),
  };
}

function tailoringFeedbackForEditDelta(
  draft: DemoResumeDraft,
  delta: DemoResumeEditDelta,
  signalId: string,
  createdAt: string,
): DemoTailoringFeedbackSignal {
  const changedNumbers = JSON.stringify(delta.beforeText.match(/\d+(?:[.,]\d+)?%?/g) ?? []) !==
    JSON.stringify(delta.afterText.match(/\d+(?:[.,]\d+)?%?/g) ?? []);
  const kind = delta.kind === "structure_change" || !delta.beforeText || !delta.afterText
    ? "style_preference"
    : changedNumbers
      ? "factual_correction"
      : /unsupported|incorrect|fabricated|source|provenance/i.test(`${delta.beforeText}\n${delta.afterText}`)
        ? "claim_policy_correction"
        : "style_preference";
  return {
    signalId,
    jobKey: draft.jobKey,
    draftId: draft.draftId,
    draftRevisionId: delta.revisionId,
    sourceKind: "edit_delta",
    sourceId: delta.deltaId,
    kind,
    status: "candidate",
    summary: `${delta.section ?? "resume"} edit: ${delta.beforeText || "[empty]"} -> ${delta.afterText || "[empty]"}`.slice(0, 500),
    section: delta.section,
    semanticId: delta.semanticId,
    createdAt,
    reviewedAt: null,
  };
}

function persistTailoringFeedbackSignal(
  snapshot: DemoWorkspaceSnapshot,
  draft: DemoResumeDraft,
  signal: DemoTailoringFeedbackSignal,
): void {
  draft.feedbackSignals.push(structuredClone(signal));
  const response = requireMapValue(snapshot.state.readModel.materials.resumeReviewFeedback, draft.jobKey);
  response.feedbackSignals.push(structuredClone(signal));
}

function feedbackKindForCommentReply(
  decision: "accepted" | "rejected" | "clarified" | "rewrite_requested",
): DemoTailoringFeedbackSignal["kind"] {
  if (decision === "accepted") return "claim_policy_correction";
  if (decision === "rejected") return "provenance_dispute";
  if (decision === "clarified") return "factual_correction";
  return "style_preference";
}

function markDemoCommentThreadsSuperseded(
  draft: DemoResumeDraft,
  deltas: readonly DemoResumeEditDelta[],
  updatedAt: string,
): void {
  for (const thread of draft.commentThreads) {
    if (!["open", "user_replied", "residual_after_acceptance"].includes(thread.state)) continue;
    const matched = deltas.find((delta) =>
      Boolean(thread.semanticId && delta.semanticId && thread.semanticId === delta.semanticId) ||
      Boolean(thread.lineAnchor?.semanticId && delta.lineAnchor?.semanticId &&
        thread.lineAnchor.semanticId === delta.lineAnchor.semanticId) ||
      Boolean(thread.lineAnchor?.lineNumber && delta.lineAnchor?.lineNumber &&
        thread.lineAnchor.lineNumber === delta.lineAnchor.lineNumber),
    );
    if (!matched) continue;
    thread.state = "superseded_by_edit";
    thread.anchorResolved = Boolean(matched.afterText.trim());
    thread.updatedAt = updatedAt;
  }
}

function actionResponse(
  action: "cancel" | "mark_skipped",
  jobKey: string,
  runId: string,
  now: string,
  extra: Record<string, unknown>,
  status = "succeeded",
) {
  return {
    ok: true,
    runId,
    actionId: `demo-action-${runId}`,
    action,
    status,
    jobKey,
    command: { action, jobKey, ...extra },
    eventCursor: null,
    message: `Browser-local demo action completed at ${now}.`,
  };
}

function durationBetween(startedAt: string | null, finishedAt: string): number | null {
  if (!startedAt) return null;
  const duration = Date.parse(finishedAt) - Date.parse(startedAt);
  return Number.isFinite(duration) ? Math.max(0, duration) : null;
}

function cancelDemoRun(draft: DemoWorkspaceSnapshot, runId: string, now: string) {
  const detail = requireMapValue(draft.state.readModel.runs.details, runId);
  if (detail.status !== "starting" && detail.status !== "in_progress") {
    if (detail.status === "canceled") return { detail, changed: false } as const;
    throw new TypeError(`Demo workflow run ${runId} is already terminal.`);
  }
  const mutableDetail = detail as unknown as {
    status: "canceled";
    result: string | null;
    errorCode: string | null;
    errorMessage: string | null;
    retryable: boolean;
    finishedAt: string | null;
    durationMs: number | null;
    events: Array<{ eventType: string; occurredAt: string | null; status: string | null; message: string | null }>;
  };
  mutableDetail.status = "canceled";
  mutableDetail.result = "canceled_by_user";
  mutableDetail.errorCode = null;
  mutableDetail.errorMessage = null;
  mutableDetail.retryable = true;
  mutableDetail.finishedAt = now;
  mutableDetail.durationMs = durationBetween(detail.startedAt, now);
  mutableDetail.events.push({
    eventType: "WorkflowCanceled",
    occurredAt: now,
    status: "canceled",
    message: "Canceled in the browser-local demo.",
  });
  const summary = draft.state.readModel.runs.list.items.find((run) => run.runId === runId);
  if (summary) {
    Object.assign(summary as unknown as Record<string, unknown>, {
      status: "canceled",
      result: "canceled_by_user",
      finishedAt: now,
      durationMs: mutableDetail.durationMs,
    });
  }
  draft.state.readModel.dashboard.summary.progress =
    draft.state.readModel.dashboard.summary.progress.filter((progress) => progress.runId !== runId);
  const applyRun = draft.state.readModel.dashboard.summary.applyRuns.find((run) => run.runId === runId);
  if (applyRun) {
    applyRun.status = "canceled";
    applyRun.events.push({ at: now, type: "canceled", level: "warning", message: "Canceled in the browser-local demo." });
  }
  const queueItem = draft.state.readModel.apply.queue.items.find((item) => item.jobKey === detail.jobKey);
  if (queueItem) queueItem.currentState = "canceled";
  if (queueItem?.latestApplyRun?.runId === runId) {
    queueItem.latestApplyRun.status = "canceled";
    queueItem.latestApplyRun.result = "canceled_by_user";
    queueItem.latestApplyRun.finishedAt = now;
  }
  updateJobCopies(draft, detail.jobKey, (job) => {
    job.currentState = "canceled";
    job.nextAction = null;
  });
  const jobDetail = draft.state.readModel.jobs.details[detail.jobKey];
  const stage = jobDetail?.stages.find((candidate) => candidate.stage === jobDetail.job.currentStage) ?? jobDetail?.stages[0];
  if (stage) {
    stage.state = "canceled";
    stage.updatedAt = now;
    stage.finishedAt = now;
    stage.durationMs = durationBetween(stage.startedAt, now);
    stage.retryable = true;
    stage.errorCode = null;
    stage.errorMessage = null;
    stage.nextAction = null;
  }
  return { detail, changed: true } as const;
}

function removePendingScenarios(
  draft: DemoWorkspaceSnapshot,
  predicate: (pending: Extract<DemoPendingScenario, { invocationVersion: 1 }>) => boolean,
): void {
  (draft as unknown as { pendingScenarios: DemoPendingScenario[] }).pendingScenarios =
    draft.pendingScenarios.filter(
      (pending) => !isDemoScenarioInvocation(pending) || !predicate(pending),
    );
}

function contactSummary(
  contact: DemoWorkspaceSnapshot["state"]["readModel"]["contacts"]["details"][string]["contact"],
) {
  const sourceKinds = [...new Set(contact.attributes.map((attribute) => attribute.provenance.sourceKind))];
  const confirmedCount = contact.attributes.filter((attribute) => attribute.provenance.userConfirmed).length;
  return {
    contactId: contact.contactId,
    displayName: contact.displayName,
    role: contact.role,
    employer: contact.employer,
    jobId: contact.jobId,
    attributeCount: contact.attributes.length,
    confirmedCount,
    sourceKinds,
    allConfirmed: contact.attributes.length > 0 && confirmedCount === contact.attributes.length,
    createdAt: contact.createdAt,
    updatedAt: contact.updatedAt,
  } as DemoWorkspaceSnapshot["state"]["readModel"]["contacts"]["list"]["items"][number];
}

function templateMetadata(
  template: DemoWorkspaceSnapshot["state"]["readModel"]["materials"]["resumeTemplates"]["templates"][number],
  assignmentSource: "profile_default" | "job_override",
) {
  return {
    templateId: template.templateId,
    templateVersionId: template.activeVersion.versionId,
    templateVersionNumber: template.activeVersion.versionNumber,
    templateName: template.displayName,
    templateHash: template.activeVersion.contentHash,
    assignmentSource,
  } as const;
}

function refreshDefaultTemplateConsumers(
  draft: DemoWorkspaceSnapshot,
  metadata: ReturnType<typeof templateMetadata>,
): void {
  type ResumeTemplateState = NonNullable<
    DemoWorkspaceSnapshot["state"]["readModel"]["jobs"]["list"]["items"][number]["resumeTemplate"]
  >;
  const refresh = (current: ResumeTemplateState | null | undefined): ResumeTemplateState => {
    if (current?.effective.assignmentSource === "job_override") return current;
    return {
      effective: structuredClone(metadata),
      snapshot: structuredClone(metadata),
      state: "template_current" as const,
      reason: null,
      lastRefreshAttempt: null,
    };
  };
  for (const job of draft.state.readModel.jobs.list.items) {
    const next = refresh(job.resumeTemplate);
    job.resumeTemplate = next;
    const detail = draft.state.readModel.jobs.details[job.jobKey];
    if (detail) detail.job.resumeTemplate = structuredClone(next);
  }
  for (const artifact of draft.state.readModel.materials.list.items) {
    const next = refresh(artifact.resumeTemplate);
    artifact.resumeTemplate = next;
    const detail = draft.state.readModel.materials.details[artifact.artifactId];
    if (detail) detail.artifact.resumeTemplate = structuredClone(next);
  }
}

function replaceContactSummary(
  draft: DemoWorkspaceSnapshot,
  contact: DemoWorkspaceSnapshot["state"]["readModel"]["contacts"]["details"][string]["contact"],
): void {
  const index = draft.state.readModel.contacts.list.items.findIndex((item) => item.contactId === contact.contactId);
  if (index >= 0) draft.state.readModel.contacts.list.items[index] = contactSummary(contact);
}

function requireThread(draft: DemoWorkspaceSnapshot, threadId: string) {
  const thread = draft.state.readModel.outreach.thread.thread;
  if (!thread || thread.threadId !== threadId) throw new Error(`Demo outreach thread ${threadId} was not found.`);
  return thread;
}

function syncDueFollowUps(
  draft: DemoWorkspaceSnapshot,
  thread: NonNullable<DemoWorkspaceSnapshot["state"]["readModel"]["outreach"]["thread"]["thread"]>,
): void {
  const followUp = thread.followUp;
  draft.state.readModel.outreach.dueFollowUps.followUps = followUp?.state === "scheduled"
    ? [{
        threadId: thread.threadId,
        contactId: thread.contactId,
        jobId: thread.jobId,
        dueAt: followUp.dueAt,
        basis: followUp.basis,
        state: followUp.state,
        isDue: false,
      }]
    : [];
}
