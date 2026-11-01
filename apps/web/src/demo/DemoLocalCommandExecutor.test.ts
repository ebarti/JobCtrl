// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { ProfileSchema, type OutcomeSuggestionDecisionRequest } from "@jobctrl/contracts";
import { createDigestReviewed, LOCAL_TENANT, type DomainEventType } from "@jobctrl/domain-types";

import coachingFixtures from "../../../../packages/domain-types/test/fixtures/required-bullet-suggestions.json" with { type: "json" };
import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import { purgeDemoJobProjections } from "./purgeDemoJobProjections.js";
import {
  DEMO_BROWSER_LOCAL_COMMANDS,
  DEMO_PRODUCTION_NO_EVENT_COMMANDS,
  DemoCommandPersistenceError,
} from "./DemoLocalCommandExecutor.js";
import {
  DemoWorkspaceRepository,
  DemoWorkspaceStorageError,
  DEMO_WORKSPACE_EVENT_LOG_LIMIT,
  InMemoryDemoWorkspaceStore,
  type DemoWorkspaceSnapshot,
  type DemoWorkspaceStore,
  type DemoWorkspaceTransaction,
} from "./workspace/index.js";

const NOW = "2026-07-11T12:00:00.000Z";

function coachingSaveFixture() {
  const fixture = coachingFixtures.find((item) =>
    item.name === "conservative canonical cleanup preserves factual tokens",
  )!;
  const original = ProfileSchema.parse(fixture.profile);
  const accepted = structuredClone(original);
  const replacement = fixture.expected.suggestions[0]!.proposedText!;
  accepted.resume.experience_entries[0]!.bullets[1] = replacement;
  accepted.resume.experience_entries[0]!.achievement_evidence[0]!.source_text = replacement;
  accepted.resume.tailoring_rules.required_bullets_by_experience_id!["exp-1"]![0] = replacement;
  return { fixture, original, accepted };
}

async function harness(store: DemoWorkspaceStore = new InMemoryDemoWorkspaceStore()) {
  let id = 0;
  const repository = new DemoWorkspaceRepository({
    store,
    clock: { now: () => new Date(NOW) },
    createWorkspaceId: () => "workspace-p3a-test",
  });
  await repository.initialize();
  const adapter = new DemoApiClientAdapter(repository, {
    clock: { now: () => new Date(NOW) },
    createId: (prefix) => `demo-${prefix}-${++id}`,
  });
  return { adapter, repository };
}

function requireObservationId(value: string | null): string {
  if (!value) throw new Error("Expected a reviewable deletion observation.");
  return value;
}

type LocalCase = readonly [
  (typeof DEMO_BROWSER_LOCAL_COMMANDS)[number],
  (api: ApiClientPort, repository: DemoWorkspaceRepository) => Promise<unknown>,
];

const JOB = "6e2f4a10-20be-4d5f-98a4-a4bb9a877a35";
const BULK = { jobKeys: [JOB], allMatching: false };

const ACTION_RESPONSE_KEYS = [
  "action", "actionId", "command", "eventCursor", "jobKey", "message", "ok", "runId", "status",
] as const;
const JOB_DETAIL_RESPONSE_KEYS = [
  "applyAudit", "artifacts", "auditHistory", "compensationAudit", "employerAnalysis", "interviewPrep",
  "job", "ok", "repeatApplication", "requirementFitReport", "stages",
] as const;
const EXPECTED_RESPONSE_KEYS = {
  acknowledgeDigest: ["ok", "state"],
  updateDiscoverySettings: ["effectiveSettings", "ok", "settings"],
  upsertDiscoverySource: ["ok", "source"],
  patchDiscoverySourceState: ["ok", "source"],
  updateCompensationSourcePolicy: ["ok", "sources"],
  promoteSourceLocatorCandidate: ["candidateId", "decidedAt", "decision", "ok", "source"],
  rejectSourceLocatorCandidate: ["candidateId", "decidedAt", "decision", "ok", "source"],
  decideDiscoveryQuarantine: ["decision", "jobKey", "ok", "recordedAt"],
  dismissManualCapture: ["dismissedAt", "itemId", "ok", "status"],
  recordDiscoveryFeedback: ["feedbackId", "jobKey", "kind", "ok", "recordedAt", "sourceId"],
  decideRoleMatchFeedbackSuggestion: ["ok", "suggestion"],
  decideApplyReview: ["decision", "ok"],
  createResumeReviewDraft: ["draft", "ok"],
  saveResumeReviewDraftRevision: ["draft", "ok", "revision"],
  seedResumeReviewCommentThreads: ["commentThreads", "draft", "ok", "seededCount", "updatedCount"],
  replyToResumeReviewComment: ["feedbackSignal", "ok", "reply", "thread"],
  saveResumeTemplate: ["ok", "template"],
  setDefaultResumeTemplate: ["defaultTemplate", "ok"],
  setJobResumeTemplate: ["effectiveTemplate", "jobKey", "ok", "overrideTemplate", "templateState"],
  recordManualApplicationOutcome: ["ok", "outcome"],
  decideOutcomeSuggestion: ["disposition", "ok", "outcome", "suggestion"],
  deleteJob: ["count", "jobKeys", "ok"],
  deleteJobs: ["count", "jobKeys", "ok"],
  permanentlyDeleteJob: ["count", "jobKeys", "ok"],
  permanentlyDeleteJobs: ["count", "jobKeys", "ok"],
  restoreJob: ["count", "jobKeys", "ok"],
  restoreJobs: ["count", "jobKeys", "ok"],
  hideJob: ["count", "jobKeys", "ok"],
  hideJobs: ["count", "jobKeys", "ok"],
  unhideJob: ["count", "jobKeys", "ok"],
  unhideJobs: ["count", "jobKeys", "ok"],
  correctScore: JOB_DETAIL_RESPONSE_KEYS,
  resetStaleScoresForRescore: ["alreadyPendingJobKeys", "count", "jobKeys", "nextAction", "ok", "skippedActiveJobKeys"],
  cancelWorkflowRun: ACTION_RESPONSE_KEYS,
  updateProfile: ["ok", "profile", "profileVersion", "style", "templateText"],
  updateSettings: ["effectiveSettings", "ok", "paths", "settings"],
  createContact: ["contact", "ok"],
  updateContact: ["contact", "ok"],
  deleteContact: ["contactId", "deletedAt", "ok"],
  confirmContactCandidate: ["contact", "ok", "task"],
  approveOutreachDraft: ["ok", "thread"],
  rejectOutreachDraft: ["ok", "thread"],
  scheduleOutreachFollowUp: ["ok", "thread"],
  completeOutreachFollowUp: ["ok", "thread"],
  dismissOutreachFollowUp: ["ok", "thread"],
  cancelJobAction: ACTION_RESPONSE_KEYS,
  markSkipped: ACTION_RESPONSE_KEYS,
} as const satisfies Record<(typeof DEMO_BROWSER_LOCAL_COMMANDS)[number], readonly string[]>;

const EXPECTED_EVENT_TYPES = {
  acknowledgeDigest: ["DigestReviewed"],
  updateDiscoverySettings: [],
  upsertDiscoverySource: ["SourceRegistryEntryCreated"],
  patchDiscoverySourceState: ["SourceStateChanged", "SourceRegistryEntryUpdated"],
  updateCompensationSourcePolicy: [],
  promoteSourceLocatorCandidate: ["SourceLocationCandidatePromoted"],
  rejectSourceLocatorCandidate: [],
  decideDiscoveryQuarantine: ["DiscoveryFeedbackRecorded"],
  dismissManualCapture: [],
  recordDiscoveryFeedback: ["DiscoveryFeedbackRecorded"],
  decideRoleMatchFeedbackSuggestion: [],
  decideApplyReview: ["ApplyReviewDecisionRecorded"],
  createResumeReviewDraft: [],
  saveResumeReviewDraftRevision: [],
  seedResumeReviewCommentThreads: [],
  replyToResumeReviewComment: [],
  saveResumeTemplate: ["ResumeTemplateVersionSaved"],
  setDefaultResumeTemplate: ["ResumeTemplateDefaultChanged"],
  setJobResumeTemplate: ["JobResumeTemplateAssigned"],
  recordManualApplicationOutcome: ["ApplicationOutcomeRecorded"],
  decideOutcomeSuggestion: ["OutcomeSuggestionDecided"],
  deleteJob: ["JobDeleted"],
  deleteJobs: ["JobDeleted"],
  permanentlyDeleteJob: [],
  permanentlyDeleteJobs: [],
  restoreJob: ["JobRestored"],
  restoreJobs: ["JobRestored"],
  hideJob: ["JobHidden"],
  hideJobs: ["JobHidden"],
  unhideJob: ["JobUnhidden"],
  unhideJobs: ["JobUnhidden"],
  correctScore: ["ScoreCorrected"],
  resetStaleScoresForRescore: ["ScoreRescoreRequested"],
  cancelWorkflowRun: ["WorkflowCanceled", "StageCanceled"],
  updateProfile: ["ProfileUpdated"],
  updateSettings: [],
  createContact: ["ContactCreated", "ContactAttributeRecorded"],
  updateContact: ["ContactUpdated"],
  deleteContact: ["ContactDeleted"],
  confirmContactCandidate: ["ContactCreated", "ContactAttributeRecorded", "ContactAttributeRecorded", "ContactResearchTaskCompleted"],
  approveOutreachDraft: ["OutreachDraftApproved"],
  rejectOutreachDraft: ["OutreachDraftRejected"],
  scheduleOutreachFollowUp: ["FollowUpScheduled"],
  completeOutreachFollowUp: ["FollowUpCompleted"],
  dismissOutreachFollowUp: ["FollowUpDismissed"],
  cancelJobAction: ["WorkflowCanceled", "StageCanceled"],
  markSkipped: ["StageSkipped"],
} as const satisfies Record<(typeof DEMO_BROWSER_LOCAL_COMMANDS)[number], readonly DomainEventType[]>;

const LOCAL_CASES = [
  ["acknowledgeDigest", (api) => api.acknowledgeDigest({ acknowledgedAt: NOW })],
  ["updateDiscoverySettings", (api) => api.updateDiscoverySettings({ resultsPerSite: 20 })],
  ["upsertDiscoverySource", (api) => api.upsertDiscoverySource({ sourceId: "demo-source:new", kind: "user_mediated_capture", displayName: "Demo source", priority: "standard", state: "experimental" })],
  ["patchDiscoverySourceState", (api) => api.patchDiscoverySourceState("demo-source:northwind", { state: "disabled", reason: "Demo choice" })],
  ["updateCompensationSourcePolicy", (api) => api.updateCompensationSourcePolicy({ sourceId: "levels_fyi", enabled: true, accessMode: "licensed_api", europeCoverageConfirmed: true })],
  ["promoteSourceLocatorCandidate", (api) => api.promoteSourceLocatorCandidate("locator-demo-northwind", { reason: "Demo promotion" })],
  ["rejectSourceLocatorCandidate", (api) => api.rejectSourceLocatorCandidate("locator-demo-northwind", { reason: "Demo rejection" })],
  ["decideDiscoveryQuarantine", (api) => api.decideDiscoveryQuarantine("job-quarantine-demo", { decision: "approve", reason: "Reviewed" })],
  ["dismissManualCapture", (api) => api.dismissManualCapture("capture-demo-browser", { reason: "Dismissed" })],
  ["recordDiscoveryFeedback", (api) => api.recordDiscoveryFeedback({ jobKey: JOB, sourceId: "demo-source:northwind", kind: "saved", note: "Useful" })],
  ["decideRoleMatchFeedbackSuggestion", (api) => api.decideRoleMatchFeedbackSuggestion("role-feedback-demo", { decision: "approve", reason: "Confirmed" })],
  ["decideApplyReview", (api) => api.decideApplyReview(JOB, { decision: "approve_dry_run", decidedBy: "demo-user" })],
  ["createResumeReviewDraft", (api) => api.createResumeReviewDraft(JOB, { generation: 1 })],
  ["saveResumeReviewDraftRevision", (api) => api.saveResumeReviewDraftRevision("draft-tailored-resume", { editedText: "Updated synthetic resume.", editDeltas: [] })],
  ["seedResumeReviewCommentThreads", (api) => api.seedResumeReviewCommentThreads("draft-tailored-resume", { threads: [{ commentBody: "Review this synthetic line." }] })],
  ["replyToResumeReviewComment", (api) => api.replyToResumeReviewComment("comment-tailored-resume-1", { author: "demo-user", decision: "clarified", body: "Clarified with bundled evidence." })],
  ["saveResumeTemplate", async (api, repository) => {
    const theme = repository.snapshotNow().state.readModel.materials.resumeTemplates.templates[0]!.activeVersion.theme;
    return api.saveResumeTemplate({ displayName: "Demo copy", theme, layout: {} });
  }],
  ["setDefaultResumeTemplate", (api) => api.setDefaultResumeTemplate({ templateId: "demo-template" })],
  ["setJobResumeTemplate", (api) => api.setJobResumeTemplate(JOB, { templateId: "demo-template" })],
  ["recordManualApplicationOutcome", (api) => api.recordManualApplicationOutcome(JOB, { requestId: "11720000-0000-4000-8000-000000000001", kind: "interview", occurredAt: NOW, note: "Synthetic outcome", interviewPrepGeneration: 1 })],
  ["decideOutcomeSuggestion", async (api, repository) => {
    await repository.mutate((draft) => {
      const suggestion = {
        suggestionId: "suggestion-demo",
        jobKey: JOB,
        evidenceId: null,
        determination: null, citations: [],
        suggestedKind: "interview",
        confidence: 1,
        rationale: "Synthetic suggestion",
        status: "pending",
        createdAt: NOW,
        decidedAt: null,
        decisionReason: null,
        decidedOutcomeId: null,
      } as const;
      draft.state.readModel.analytics.outcomes.suggestions.push(structuredClone(suggestion));
      draft.state.readModel.analytics.jobOutcomes[JOB]!.suggestions.push(structuredClone(suggestion));
    });
    return api.decideOutcomeSuggestion("suggestion-demo", { decision: "ignore", reason: "Not applicable" });
  }],
  ["deleteJob", (api) => api.deleteJob(JOB, { reason: "Demo delete" })],
  ["deleteJobs", (api) => api.deleteJobs(BULK)],
  ["permanentlyDeleteJob", (api) => api.permanentlyDeleteJob(JOB)],
  ["permanentlyDeleteJobs", (api) => api.permanentlyDeleteJobs(BULK)],
  ["restoreJob", (api) => api.restoreJob(JOB)],
  ["restoreJobs", (api) => api.restoreJobs(BULK)],
  ["hideJob", (api) => api.hideJob(JOB, { reason: "Demo hide" })],
  ["hideJobs", (api) => api.hideJobs(BULK)],
  ["unhideJob", (api) => api.unhideJob(JOB)],
  ["unhideJobs", (api) => api.unhideJobs(BULK)],
  ["correctScore", (api) => api.correctScore(JOB, { correctedScore: 9, reason: "Reviewed synthetic evidence" })],
  ["resetStaleScoresForRescore", (api) => api.resetStaleScoresForRescore({ limit: 1, jobKeys: ["job-fabrikam-systems"] })],
  ["cancelWorkflowRun", (api) => api.cancelWorkflowRun("run-materials-progress")],
  ["updateProfile", (api) => api.updateProfile({ templateText: "Updated bundled template" })],
  ["updateSettings", (api) => api.updateSettings({ dailyBudgetUsd: 12, workerActivitySlots: 8 })],
  ["createContact", (api) => api.createContact({ role: "recruiter", employer: "Demo Workshop", attributes: [{ kind: "name", value: "Synthetic contact" }] })],
  ["updateContact", async (api) => api.updateContact("contact-demo-hiring-partner", { expectedFingerprint: (await api.contact("contact-demo-hiring-partner")).contact.fingerprint, role: "hiring_manager" })],
  ["deleteContact", (api) => api.deleteContact("contact-demo-hiring-partner", { reason: "Demo cleanup" })],
  ["confirmContactCandidate", (api) => api.confirmContactCandidate("research-demo-hiring-partner", "candidate-demo-hiring-partner", { role: "recruiter" })],
  ["approveOutreachDraft", (api) => api.approveOutreachDraft("thread-demo", "outreach-draft-candidate")],
  ["rejectOutreachDraft", (api) => api.rejectOutreachDraft("thread-demo", "outreach-draft-candidate", { reason: "Needs revision" })],
  ["scheduleOutreachFollowUp", (api) => api.scheduleOutreachFollowUp("thread-demo", { dueAt: "2026-07-12T12:00:00.000Z", basis: "manual" })],
  ["completeOutreachFollowUp", (api) => api.completeOutreachFollowUp("thread-demo")],
  ["dismissOutreachFollowUp", (api) => api.dismissOutreachFollowUp("thread-demo")],
  ["cancelJobAction", (api) => api.cancelJobAction(JOB, { runId: "run-materials-progress" })],
  ["markSkipped", (api) => api.markSkipped(JOB, { reason: "Synthetic skip" })],
] as const satisfies readonly LocalCase[];

describe("DemoLocalCommandExecutor", () => {
  it("retains manual action receipts across demo reopen, conflicts on changed payload, and permits a new identity", async () => {
    const store = new InMemoryDemoWorkspaceStore();
    const first = await harness(store);
    const body = { requestId: "11720000-0000-4000-8000-000000000003", kind: "interview" as const, note: "" };
    const original = await first.adapter.recordManualApplicationOutcome(JOB, body);
    expect(await first.adapter.recordManualApplicationOutcome(JOB, { ...body, note: "  " })).toEqual(original);
    await expect(first.adapter.recordManualApplicationOutcome(JOB, { ...body, note: "A different note" })).rejects.toThrow(/identity conflicts/);
    const next = await first.adapter.recordManualApplicationOutcome(JOB, { ...body, requestId: "11720000-0000-4000-8000-000000000004" });
    expect(next.outcome.outcomeId).not.toBe(original.outcome.outcomeId);
    const reopened = await harness(store);
    expect(await reopened.adapter.recordManualApplicationOutcome(JOB, body)).toEqual(original);
    expect(reopened.repository.snapshotNow().eventLog.filter((entry) => entry.event.eventType === "ApplicationOutcomeRecorded" && entry.event.payload.outcomeId === original.outcome.outcomeId)).toHaveLength(1);
  });


  it("explains unavailable demo rescore consistently across the reset result, job and event", async () => {
    const { adapter, repository } = await harness();
    const jobId = "job-fabrikam-systems";
    const previous = repository.snapshotNow().state.readModel.jobs.details[jobId]!.job;
    expect(DEMO_CAPABILITY_MANIFEST.rescoreJob.class).toBe("unavailable");
    expect(DEMO_CAPABILITY_MANIFEST.rescoreJobsNotOnCurrentScoringPolicy.class).toBe("unavailable");
    await expect(adapter.rescoreJob(jobId, { dryRun: false })).rejects.toMatchObject({
      code: "demo_capability_not_implemented",
    });
    const initialDetail = await adapter.job(jobId);
    expect(initialDetail.job.nextAction).toBe("Rescoring is unavailable in the demo.");
    expect(initialDetail.stages).toContainEqual(expect.objectContaining({
      stage: "score", nextAction: "Rescoring is unavailable in the demo.",
    }));
    const historicalRun = await adapter.workflowRun("run-failed-quality-gate");
    expect(historicalRun.events).toContainEqual(expect.objectContaining({
      eventType: "WorkflowFailed", message: "Rescoring is unavailable in the demo.",
    }));
    const response = await adapter.resetStaleScoresForRescore({
      limit: 1,
      jobKeys: [jobId],
    });
    expect(response).toMatchObject({
      count: 1,
      nextAction: "Rescoring is unavailable in the demo.",
    });
    const snapshot = repository.snapshotNow();
    const detail = snapshot.state.readModel.jobs.details[jobId]!.job;
    expect(detail).toMatchObject({ currentState: "pending", nextAction: response.nextAction });
    expect(detail.scoreStaleness).toEqual(previous.scoreStaleness);
    expect(detail.fitScore).toEqual(previous.fitScore);
    expect(snapshot.state.readModel.jobs.list.items.find((job) => job.jobKey === jobId)).toMatchObject({
      currentState: "pending", nextAction: response.nextAction,
    });
    expect(snapshot.eventLog).toContainEqual(expect.objectContaining({
      event: expect.objectContaining({
        eventType: "ScoreRescoreRequested",
        payload: expect.objectContaining({ nextAction: response.nextAction }),
      }),
    }));
  });

  it("preserves the reviewed profile, Required pin and event history when accepting cleanup cannot persist", async () => {
    const store = new QuotaOnNextTransactionStore();
    const { adapter, repository } = await harness(store);
    const { original, accepted } = coachingSaveFixture();
    const saved = await adapter.updateProfile({
      expectedProfileVersion: 1, profileText: JSON.stringify(original),
    });
    const before = repository.snapshotNow();
    store.failNext = true;
    await expect(adapter.updateProfile({
      expectedProfileVersion: saved.profileVersion!, profileText: JSON.stringify(accepted),
    })).rejects.toBeInstanceOf(DemoCommandPersistenceError);
    expect(repository.snapshotNow()).toEqual(before);
    expect(await store.readSnapshot()).toEqual(before);
    expect(await adapter.profile()).toEqual(saved);
    expect(repository.snapshotNow()).toEqual(before);
    repository.dispose();
  });

  it.each(["accept", "manual"] as const)(
    "fences concurrent acceptance, manual and autosave payloads when %s commits first",
    async (first) => {
      const { adapter, repository } = await harness();
      const { original, accepted } = coachingSaveFixture();
      const saved = await adapter.updateProfile({
        expectedProfileVersion: 1, profileText: JSON.stringify(original),
      });
      const manual = structuredClone(original);
      manual.resume.experience_entries[0]!.bullets[0] = "Manually edited synthetic optional fact.";
      const autosave = structuredClone(manual);
      autosave.resume.experience_entries[0]!.bullets[2] = "Autosaved synthetic optional fact.";
      const ordered = first === "accept" ? [accepted, manual, autosave] : [manual, accepted, autosave];
      const before = repository.snapshotNow();
      const results = await Promise.allSettled(ordered.map((profile) => adapter.updateProfile({
        expectedProfileVersion: saved.profileVersion!, profileText: JSON.stringify(profile),
      })));
      expect(results[0]!.status).toBe("fulfilled");
      for (const result of results.slice(1)) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toMatchObject({ message: expect.stringContaining("stale_profile_version") });
        }
      }
      const current = await adapter.profile();
      expect(current.profile).toEqual(ordered[0]);
      expect(current.profileVersion).toBe(saved.profileVersion! + 1);
      const after = repository.snapshotNow();
      expect(after.revision).toBe(before.revision + 1);
      expect(after.eventLog.slice(before.eventLog.length).map((record) => record.event.eventType))
        .toEqual(["ProfileUpdated"]);
      expect(repository.snapshotNow()).toEqual(after);
      repository.dispose();
    },
  );

  it("has one valid invocation for every P3a browser-local command", async () => {
    expect(LOCAL_CASES.map(([method]) => method).toSorted()).toEqual(
      [...DEMO_BROWSER_LOCAL_COMMANDS].toSorted(),
    );
    expect(DEMO_BROWSER_LOCAL_COMMANDS).toHaveLength(47);
    for (const [method, invoke] of LOCAL_CASES) {
      const { adapter, repository } = await harness();
      const before = repository.snapshotNow();
      const response = await invoke(adapter, repository);
      const after = repository.snapshotNow();
      expect(response, method).toMatchObject({ ok: true });
      expect(Object.keys(response as unknown as Record<string, unknown>).toSorted(), method).toEqual(
        [...EXPECTED_RESPONSE_KEYS[method]].toSorted(),
      );
      expect(after.revision, method).toBe(
        before.revision + (method === "decideOutcomeSuggestion" ? 2 : 1),
      );
    }
  });

  it("maps all 49 commands to exact ordered production events or an explicit revision-only resync", async () => {
    expect(Object.keys(EXPECTED_EVENT_TYPES).toSorted()).toEqual([...DEMO_BROWSER_LOCAL_COMMANDS].toSorted());
    expect(DEMO_PRODUCTION_NO_EVENT_COMMANDS.toSorted()).toEqual(
      Object.entries(EXPECTED_EVENT_TYPES)
        .filter(([method, events]) => events.length === 0 && !method.startsWith("permanentlyDelete"))
        .map(([method]) => method)
        .toSorted(),
    );
    for (const [method, invoke] of LOCAL_CASES) {
      const { adapter, repository } = await harness();
      const before = repository.snapshotNow();
      await invoke(adapter, repository);
      const after = repository.snapshotNow();
      expect(after.revision, method).toBe(
        before.revision + (method === "decideOutcomeSuggestion" ? 2 : 1),
      );
      const eventTypes = after.eventLog.slice(before.eventLog.length).map((entry) => entry.event.eventType);
      expect(eventTypes, method).toEqual(EXPECTED_EVENT_TYPES[method]);
    }
  });

  it("updates list and detail projections atomically and emits typed invalidation events", async () => {
    const { adapter, repository } = await harness();
    await adapter.correctScore(JOB, { correctedScore: 9, reason: "Reviewed" });
    const snapshot = repository.snapshotNow();
    expect(snapshot.state.readModel.jobs.list.items.find((job) => job.jobKey === JOB)?.fitScore).toBe(9);
    expect(snapshot.state.readModel.jobs.details[JOB]?.job.fitScore).toBe(9);
    expect(snapshot.eventLog.at(-1)?.event).toMatchObject({
      eventType: "ScoreCorrected",
      tenantId: "local",
      payload: { jobId: JOB, correctedScore: 9 },
    });
  });

  it("permanently deletes only state-qualified all-matching demo jobs", async () => {
    const { adapter, repository } = await harness();
    const [activeKey, deletedKey, hiddenKey] = repository
      .snapshotNow()
      .state.readModel.jobs.list.items.slice(0, 3)
      .map((job) => job.jobKey);
    expect(activeKey).toBeDefined();
    expect(deletedKey).toBeDefined();
    expect(hiddenKey).toBeDefined();
    await repository.mutate((draft) => {
      const states = [
        [activeKey!, null, null],
        [deletedKey!, "2026-07-09T12:00:00.000Z", null],
        [
          hiddenKey!,
          "2026-07-09T12:00:00.000Z",
          "2026-07-10T12:00:00.000Z",
        ],
      ] as const;
      for (const [jobKey, deletedAt, hiddenAt] of states) {
        const summary = draft.state.readModel.jobs.list.items.find(
          (job) => job.jobKey === jobKey,
        )!;
        const detail = draft.state.readModel.jobs.details[jobKey]!.job;
        summary.deletedAt = deletedAt;
        summary.hiddenAt = hiddenAt;
        detail.deletedAt = deletedAt;
        detail.hiddenAt = hiddenAt;
      }
    });

    const response = await adapter.permanentlyDeleteJobs({
      allMatching: true,
      jobKeys: [],
      filter: {
        q: "",
        deleted: "active",
        jobStates: ["deleted", "hidden"],
        applyStatus: "all",
        source: "",
        company: "",
      },
    });

    expect(response).toMatchObject({
      ok: true,
      count: 2,
      jobKeys: [deletedKey, hiddenKey],
    });
    const snapshot = repository.snapshotNow();
    expect(
      snapshot.state.readModel.jobs.list.items.map((job) => job.jobKey),
    ).toContain(activeKey);
    expect(snapshot.state.readModel.jobs.details[activeKey!]).toBeDefined();
    expect(snapshot.state.readModel.jobs.details[deletedKey!]).toBeUndefined();
    expect(snapshot.state.readModel.jobs.details[hiddenKey!]).toBeUndefined();
  });

  it("refuses the entire reviewed removal when a selected job is restored after preparation", async () => {
    const { adapter, repository } = await harness();
    const [deletedKey, hiddenKey] = repository.snapshotNow().state.readModel.jobs.list.items
      .slice(0, 2).map((job) => job.jobKey);
    await adapter.deleteJob(deletedKey!);
    await adapter.hideJob(hiddenKey!);
    const before = repository.snapshotNow();
    const expected = [deletedKey!, hiddenKey!].map((jobKey) => {
      const job = before.state.readModel.jobs.details[jobKey]!.job;
      return { jobKey, deletedAt: job.deletedAt, hiddenAt: job.hiddenAt };
    });
    const observation = await adapter.reviewableJobs({ deleted: "all" });
    const selection = await adapter.preparePermanentDeleteSelection({
      observationId: requireObservationId(observation.observationId),
      selections: [{ allMatching: false, jobKeys: [deletedKey!, hiddenKey!] }],
      expected,
    });
    expect(repository.snapshotNow().revision).toBe(before.revision);
    await adapter.restoreJob(deletedKey!);
    const afterRestore = repository.snapshotNow();
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false,
      jobKeys: selection.jobKeys,
      selectionId: selection.selectionId,
    })).rejects.toMatchObject({ status: 409, responseBody: {
      error: "permanent_delete_selection_conflict",
      deletedJobKeys: [],
      conflictingJobKeys: [deletedKey],
      unprocessedJobKeys: [hiddenKey],
    } });
    expect(repository.snapshotNow()).toEqual(afterRestore);
    expect(repository.snapshotNow().state.readModel.jobs.details[deletedKey!]).toBeDefined();
    expect(repository.snapshotNow().state.readModel.jobs.details[hiddenKey!]).toBeDefined();
    repository.dispose();
  });

  it("freezes all-matching removed selections and makes a successful receipt single-use", async () => {
    const { adapter, repository } = await harness();
    const [first, second] = repository.snapshotNow().state.readModel.jobs.list.items
      .slice(0, 2).map((job) => job.jobKey);
    await adapter.deleteJob(first!);
    const request = {
      selections: [{ allMatching: true, jobKeys: [], filter: {
        q: "", deleted: "deleted" as const, applyStatus: "all" as const, source: "", company: "",
      } }],
    };
    const observation = await adapter.reviewableJobs({ deleted: "deleted" });
    const stale = await adapter.preparePermanentDeleteSelection({ ...request, observationId: requireObservationId(observation.observationId) });
    expect(stale.jobKeys).toContain(first);
    expect(stale.jobKeys).not.toContain(second);
    await adapter.deleteJob(second!);
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: stale.jobKeys, selectionId: stale.selectionId,
    })).resolves.toMatchObject({ ok: true, count: 1, jobKeys: [first] });
    expect(repository.snapshotNow().state.readModel.jobs.details[second!]).toBeDefined();
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: stale.jobKeys, selectionId: stale.selectionId,
    })).rejects.toMatchObject({ status: 409 });
    const freshObservation = await adapter.reviewableJobs({ deleted: "deleted" });
    const fresh = await adapter.preparePermanentDeleteSelection({ ...request, observationId: requireObservationId(freshObservation.observationId) });
    expect(fresh.jobKeys).toEqual(expect.arrayContaining([second]));
    expect(fresh.jobKeys).not.toContain(first);
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: fresh.jobKeys, selectionId: fresh.selectionId,
    })).resolves.toMatchObject({ ok: true, count: fresh.jobKeys.length });
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: fresh.jobKeys, selectionId: fresh.selectionId,
    })).rejects.toMatchObject({ status: 409 });
    repository.dispose();
  });

  it("rejects stale displayed state before issuing a deletion receipt", async () => {
    const { adapter, repository } = await harness();
    const jobKey = repository.snapshotNow().state.readModel.jobs.list.items[0]!.jobKey;
    await adapter.deleteJob(jobKey);
    const job = repository.snapshotNow().state.readModel.jobs.details[jobKey]!.job;
    const expected = { jobKey, deletedAt: job.deletedAt, hiddenAt: job.hiddenAt };
    const observation = await adapter.reviewableJobs({ deleted: "all" });
    await adapter.restoreJob(jobKey);
    const afterRestore = repository.snapshotNow();
    await expect(adapter.preparePermanentDeleteSelection({
      observationId: requireObservationId(observation.observationId),
      selections: [{ allMatching: false, jobKeys: [jobKey] }],
      expected: [expected],
    })).rejects.toMatchObject({ status: 409 });
    expect(repository.snapshotNow()).toEqual(afterRestore);
    repository.dispose();
  });

  it("reports changed and unprocessed members when a mixed cohort changes before preparation", async () => {
    const { adapter, repository } = await harness();
    const [deletedKey, hiddenKey] = repository.snapshotNow().state.readModel.jobs.list.items
      .slice(0, 2).map((job) => job.jobKey);
    await adapter.deleteJob(deletedKey!);
    await adapter.hideJob(hiddenKey!);
    const observed = await adapter.reviewableJobs({ deleted: "all" });
    const expected = [deletedKey!, hiddenKey!].map((jobKey) => {
      const job = observed.items.find((item) => item.jobKey === jobKey)!;
      return { jobKey, deletedAt: job.deletedAt, hiddenAt: job.hiddenAt };
    });
    await adapter.unhideJob(hiddenKey!);
    const before = repository.snapshotNow();
    await expect(adapter.preparePermanentDeleteSelection({
      observationId: requireObservationId(observed.observationId),
      selections: [{ allMatching: false, jobKeys: [deletedKey!, hiddenKey!] }],
      expected,
    })).rejects.toMatchObject({ status: 409, responseBody: {
      error: "permanent_delete_selection_conflict",
      deletedJobKeys: [],
      conflictingJobKeys: [hiddenKey],
      unprocessedJobKeys: [deletedKey],
    } });
    expect(repository.snapshotNow()).toEqual(before);
    expect(repository.snapshotNow().state.readModel.jobs.details[deletedKey!]).toBeDefined();
    expect(repository.snapshotNow().state.readModel.jobs.details[hiddenKey!]).toBeDefined();
    adapter.dispose(); repository.dispose();
  });

  it("keeps job browsing available when no removed jobs exist or observation capacity is full", async () => {
    const repository = new DemoWorkspaceRepository({
      store: new InMemoryDemoWorkspaceStore(),
      createWorkspaceId: () => "workspace-observation-capacity",
    });
    await repository.initialize();
    let now = Date.parse(NOW);
    const adapter = new DemoApiClientAdapter(repository, {
      clock: { now: () => new Date(now) },
    });
    const active = await adapter.reviewableJobs({ deleted: "active" });
    expect(active.observationId).toBeNull();
    expect(active.items.length).toBeGreaterThan(0);

    const jobKey = active.items[0]!.jobKey;
    await adapter.deleteJob(jobKey);
    for (let index = 0; index < 64; index += 1) {
      expect((await adapter.reviewableJobs({ deleted: "deleted" })).observationId).toBeTruthy();
    }
    const full = await adapter.reviewableJobs({ deleted: "deleted" });
    expect(full.observationId).toBeNull();
    expect(full.items.some((job) => job.jobKey === jobKey)).toBe(true);
    now += 60_000;
    expect((await adapter.reviewableJobs({ deleted: "deleted" })).observationId).toBeTruthy();
    adapter.dispose();
    repository.dispose();
  });

  it("rejects a noncanonical alias in a guarded selection without mutating any job", async () => {
    const { adapter, repository } = await harness();
    const jobKey = repository.snapshotNow().state.readModel.jobs.list.items[0]!.jobKey;
    await adapter.deleteJob(jobKey);
    const observed = await adapter.reviewableJobs({ deleted: "deleted" });
    const job = observed.items.find((item) => item.jobKey === jobKey)!;
    const before = repository.snapshotNow();
    await expect(adapter.preparePermanentDeleteSelection({
      observationId: requireObservationId(observed.observationId),
      selections: [{ allMatching: false, jobKeys: [job.url] }],
      expected: [{ jobKey: job.url, deletedAt: job.deletedAt, hiddenAt: job.hiddenAt }],
    })).rejects.toMatchObject({ status: 409 });
    expect(repository.snapshotNow()).toEqual(before);
    repository.dispose();
  });

  it("rejects restore and re-delete before preparation even when the timestamps collide", async () => {
    const { adapter, repository } = await harness();
    const jobKey = repository.snapshotNow().state.readModel.jobs.list.items[0]!.jobKey;
    await adapter.deleteJob(jobKey);
    const observed = await adapter.reviewableJobs({ deleted: "all" });
    const job = observed.items.find((item) => item.jobKey === jobKey)!;
    const expected = { jobKey, deletedAt: job.deletedAt, hiddenAt: job.hiddenAt };
    await adapter.restoreJob(jobKey);
    await adapter.deleteJob(jobKey); // The test clock deliberately does not advance.
    expect(repository.snapshotNow().state.readModel.jobs.details[jobKey]!.job.deletedAt).toBe(expected.deletedAt);
    const before = repository.snapshotNow();
    await expect(adapter.preparePermanentDeleteSelection({
      observationId: requireObservationId(observed.observationId),
      selections: [{ allMatching: false, jobKeys: [jobKey] }],
      expected: [expected],
    })).rejects.toMatchObject({ status: 409 });
    expect(repository.snapshotNow()).toEqual(before);
    repository.dispose();
  });

  it("preserves a reviewed selection across unrelated lifecycle writes in another tab", async () => {
    const store = new InMemoryDemoWorkspaceStore();
    const { adapter, repository } = await harness(store);
    const otherRepository = new DemoWorkspaceRepository({ store });
    await otherRepository.initialize();
    const otherAdapter = new DemoApiClientAdapter(otherRepository, { clock: { now: () => new Date(NOW) } });
    const [selected, unrelated] = repository.snapshotNow().state.readModel.jobs.list.items
      .slice(0, 2).map((job) => job.jobKey);
    await adapter.deleteJob(selected!);
    const observation = await adapter.reviewableJobs({ deleted: "all" });
    const job = observation.items.find((item) => item.jobKey === selected)!;
    await otherAdapter.hideJob(unrelated!);
    const selection = await adapter.preparePermanentDeleteSelection({
      observationId: requireObservationId(observation.observationId),
      selections: [{ allMatching: false, jobKeys: [selected!] }],
      expected: [{ jobKey: selected!, deletedAt: job.deletedAt, hiddenAt: job.hiddenAt }],
    });
    await otherAdapter.unhideJob(unrelated!);
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: selection.jobKeys, selectionId: selection.selectionId,
    })).resolves.toMatchObject({ ok: true, count: 1, jobKeys: [selected] });
    expect(repository.snapshotNow().state.readModel.jobs.details[unrelated!]).toBeDefined();
    adapter.dispose(); otherAdapter.dispose(); otherRepository.dispose(); repository.dispose();
  });

  it("rejects a legacy writer's same-value ABA even after a newer writer commits", async () => {
    const store = new InMemoryDemoWorkspaceStore();
    const { adapter, repository } = await harness(store);
    const [selected, unrelated] = repository.snapshotNow().state.readModel.jobs.list.items
      .slice(0, 2).map((job) => job.jobKey);
    await adapter.deleteJob(selected!);
    const observation = await adapter.reviewableJobs({ deleted: "all" });
    const job = observation.items.find((item) => item.jobKey === selected)!;
    for (const deletedAt of [null, job.deletedAt]) {
      await store.transact((current, transaction) => {
        const draft = structuredClone(current!);
        draft.state.readModel.jobs.details[selected!]!.job.deletedAt = deletedAt;
        draft.state.readModel.jobs.list.items.find((item) => item.jobKey === selected)!.deletedAt = deletedAt;
        transaction.putSnapshot({ ...draft, revision: draft.revision + 1 });
      });
    }
    await adapter.hideJob(unrelated!); // New writer detects the legacy checkpoint gap.
    await expect(adapter.preparePermanentDeleteSelection({
      observationId: requireObservationId(observation.observationId),
      selections: [{ allMatching: false, jobKeys: [selected!] }],
      expected: [{ jobKey: selected!, deletedAt: job.deletedAt, hiddenAt: job.hiddenAt }],
    })).rejects.toMatchObject({ status: 409 });
    expect((await repository.snapshot()).state.readModel.jobs.details[selected!]).toBeDefined();
    adapter.dispose(); repository.dispose();
  });

  it("consumes changed receipts and rejects expired or disposed selections", async () => {
    const repository = new DemoWorkspaceRepository({
      store: new InMemoryDemoWorkspaceStore(),
      createWorkspaceId: () => "workspace-delete-test",
    });
    await repository.initialize();
    let now = Date.parse(NOW);
    let id = 0;
    const adapter = new DemoApiClientAdapter(repository, {
      clock: { now: () => new Date(now) },
      createId: (prefix) => `${prefix}-${++id}`,
    });
    const [first, second] = repository.snapshotNow().state.readModel.jobs.list.items
      .slice(0, 2).map((job) => job.jobKey);
    await adapter.deleteJob(first!);
    await adapter.deleteJob(second!);
    const current = repository.snapshotNow();
    const expected = [first!, second!].map((jobKey) => {
      const job = current.state.readModel.jobs.details[jobKey]!.job;
      return { jobKey, deletedAt: job.deletedAt, hiddenAt: job.hiddenAt };
    });
    const request = { selections: [{ allMatching: false, jobKeys: [first!, second!] }], expected };
    const observation = await adapter.reviewableJobs({ deleted: "all" });
    const changed = await adapter.preparePermanentDeleteSelection({ ...request, observationId: requireObservationId(observation.observationId) });
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: [first!], selectionId: changed.selectionId,
    })).rejects.toMatchObject({ status: 409 });
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: changed.jobKeys, selectionId: changed.selectionId,
    })).rejects.toMatchObject({ status: 409 });
    const expiryObservation = await adapter.reviewableJobs({ deleted: "all" });
    const expired = await adapter.preparePermanentDeleteSelection({ ...request, observationId: requireObservationId(expiryObservation.observationId) });
    now += 60_000;
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: expired.jobKeys, selectionId: expired.selectionId,
    })).rejects.toMatchObject({ status: 409 });
    const disposalObservation = await adapter.reviewableJobs({ deleted: "all" });
    const disposed = await adapter.preparePermanentDeleteSelection({ ...request, observationId: requireObservationId(disposalObservation.observationId) });
    adapter.dispose();
    await expect(adapter.permanentlyDeleteJobs({
      allMatching: false, jobKeys: disposed.jobKeys, selectionId: disposed.selectionId,
    })).rejects.toMatchObject({ status: 409 });
    expect(repository.snapshotNow().state.readModel.jobs.details[first!]).toBeDefined();
    expect(repository.snapshotNow().state.readModel.jobs.details[second!]).toBeDefined();
    repository.dispose();
  });

  it("uses legacy hidden compatibility for all-matching demo unhide", async () => {
    const { adapter, repository } = await harness();
    const [activeKey, deletedKey, hiddenKey] = repository
      .snapshotNow()
      .state.readModel.jobs.list.items.slice(0, 3)
      .map((job) => job.jobKey);
    await repository.mutate((draft) => {
      const states = [
        [activeKey!, null, null],
        [deletedKey!, "2026-07-09T12:00:00.000Z", null],
        [
          hiddenKey!,
          "2026-07-09T12:00:00.000Z",
          "2026-07-10T12:00:00.000Z",
        ],
      ] as const;
      for (const [jobKey, deletedAt, hiddenAt] of states) {
        const summary = draft.state.readModel.jobs.list.items.find(
          (job) => job.jobKey === jobKey,
        )!;
        const detail = draft.state.readModel.jobs.details[jobKey]!.job;
        summary.deletedAt = deletedAt;
        summary.hiddenAt = hiddenAt;
        detail.deletedAt = deletedAt;
        detail.hiddenAt = hiddenAt;
      }
    });

    const response = await adapter.unhideJobs({
      allMatching: true,
      jobKeys: [],
      filter: {
        q: "",
        deleted: "hidden",
        applyStatus: "all",
        source: "",
        company: "",
      },
    });

    expect(response).toMatchObject({
      ok: true,
      count: 1,
      jobKeys: [hiddenKey],
    });
    const jobs = repository.snapshotNow().state.readModel.jobs.list.items;
    expect(jobs.find((job) => job.jobKey === activeKey)?.hiddenAt).toBeNull();
    expect(jobs.find((job) => job.jobKey === deletedKey)?.deletedAt).not.toBeNull();
    expect(jobs.find((job) => job.jobKey === hiddenKey)).toMatchObject({
      deletedAt: expect.any(String),
      hiddenAt: null,
    });
  });

  it("promotes a locator candidate into one candidate-derived source and replays without duplication", async () => {
    const { adapter, repository } = await harness();
    const first = await adapter.promoteSourceLocatorCandidate("locator-demo-northwind", {
      reason: "Reviewed bundled source",
    });
    const replay = await adapter.promoteSourceLocatorCandidate("locator-demo-northwind", {
      reason: "Replay",
    });
    const snapshot = repository.snapshotNow();
    expect(first).toMatchObject({
      ok: true,
      candidateId: "locator-demo-northwind",
      decision: "promote",
      source: {
        sourceId: "demo-source:locator:locator-demo-northwind",
        state: "active",
        owner: "user",
        lastRunId: null,
        lastRunCompletedAt: null,
      },
    });
    expect(replay.decidedAt).toBe(first.decidedAt);
    expect(replay.source).toEqual(first.source);
    expect(snapshot.state.readModel.discovery.sources.sources.filter(
      (source) => source.sourceId === first.source?.sourceId,
    )).toHaveLength(1);
    expect(snapshot.state.readModel.discovery.sourcePreviews[first.source!.sourceId]).toMatchObject({
      ok: true,
      sourceId: first.source!.sourceId,
    });
    expect(snapshot.eventLog.filter(
      (entry) => entry.event.eventType === "SourceLocationCandidatePromoted",
    )).toHaveLength(1);
    expect(snapshot.state.readModel.dashboard.summary.sourceHealth.find(
      (health) => health.sourceId === first.source?.sourceId,
    )).toMatchObject({ runCount: 0, lastRunId: null });
  });

  it("normalizes resume revisions, stably upserts comment threads, and persists complete feedback signals", async () => {
    const { adapter, repository } = await harness();
    const before = repository.snapshotNow();
    const revision = await adapter.saveResumeReviewDraftRevision("draft-tailored-resume", {
      editedText: "Bundled synthetic tailored resume with 25 improvements.",
      editDeltas: [{
        kind: "replace_text",
        section: " experience ",
        semanticId: " experience-synthetic ",
        lineAnchor: { semanticId: " experience-synthetic ", lineNumber: 4 },
        beforeText: "Coordinated one improvement.",
        afterText: "Coordinated 25 improvements.",
      }],
    });
    expect(revision.revision).toEqual({
      revisionId: "demo-draft-revision-1",
      draftId: "draft-tailored-resume",
      jobKey: JOB,
      revisionNumber: 2,
      editedText: "Bundled synthetic tailored resume with 25 improvements.",
      plateDocument: null,
      editDeltas: [{
        deltaId: "demo-resume-delta-2",
        revisionId: "demo-draft-revision-1",
        kind: "replace_text",
        section: "experience",
        semanticId: "experience-synthetic",
        lineAnchor: { semanticId: "experience-synthetic", lineNumber: 4, pageNumber: null, textHash: null },
        beforeText: "Coordinated one improvement.",
        afterText: "Coordinated 25 improvements.",
        createdAt: NOW,
      }],
      createdAt: NOW,
    });
    expect(revision.draft).toMatchObject({
      state: "active",
      currentRevisionId: revision.revision.revisionId,
      latestRevisionNumber: 2,
      updatedAt: NOW,
      commentThreads: [{ threadId: "comment-tailored-resume-1", state: "resolved" }],
      feedbackSignals: [{
        signalId: "demo-resume-feedback-3",
        jobKey: JOB,
        draftId: "draft-tailored-resume",
        draftRevisionId: revision.revision.revisionId,
        sourceKind: "edit_delta",
        sourceId: revision.revision.editDeltas[0]!.deltaId,
        kind: "factual_correction",
        status: "candidate",
        section: "experience",
        semanticId: "experience-synthetic",
        createdAt: NOW,
        reviewedAt: null,
      }],
    });

    const seedRequest = {
      threads: [{
        semanticId: "summary-synthetic",
        lineAnchor: { semanticId: "summary-synthetic", lineNumber: 2 },
        sourcePinId: "evidence-summary",
        riskLabel: "review",
        commentBody: " Review this summary. ",
      }],
    };
    const seeded = await adapter.seedResumeReviewCommentThreads("draft-tailored-resume", seedRequest);
    const replay = await adapter.seedResumeReviewCommentThreads("draft-tailored-resume", seedRequest);
    expect(seeded).toMatchObject({ ok: true, seededCount: 1, updatedCount: 0 });
    expect(replay).toMatchObject({ ok: true, seededCount: 0, updatedCount: 1 });
    const stableThread = replay.commentThreads.find((thread) => thread.semanticId === "summary-synthetic")!;
    expect(replay.commentThreads.filter((thread) => thread.threadId === stableThread.threadId)).toHaveLength(1);
    expect(stableThread).toMatchObject({
      draftId: "draft-tailored-resume",
      jobKey: JOB,
      commentBody: "Review this summary.",
      state: "open",
      anchorResolved: true,
      createdAt: NOW,
      updatedAt: NOW,
    });

    const reply = await adapter.replyToResumeReviewComment(stableThread.threadId, {
      draftRevisionId: revision.revision.revisionId,
      author: "demo-user",
      decision: "clarified",
      body: "The improvement count comes from bundled evidence.",
    });
    expect(reply).toEqual({
      ok: true,
      thread: { ...stableThread, state: "user_replied", updatedAt: NOW, replies: [reply.reply] },
      reply: {
        replyId: "demo-comment-reply-4",
        threadId: stableThread.threadId,
        draftRevisionId: revision.revision.revisionId,
        author: "demo-user",
        decision: "clarified",
        body: "The improvement count comes from bundled evidence.",
        createdAt: NOW,
      },
      feedbackSignal: {
        signalId: "demo-resume-feedback-5",
        jobKey: JOB,
        draftId: "draft-tailored-resume",
        draftRevisionId: revision.revision.revisionId,
        sourceKind: "comment_reply",
        sourceId: "demo-comment-reply-4",
        kind: "factual_correction",
        status: "candidate",
        summary: "The improvement count comes from bundled evidence.",
        section: null,
        semanticId: "summary-synthetic",
        createdAt: NOW,
        reviewedAt: null,
      },
    });
    const snapshot = repository.snapshotNow();
    expect(snapshot.state.readModel.materials.resumeReviewFeedback[JOB]?.feedbackSignals).toEqual(
      snapshot.state.readModel.materials.resumeReviewDrafts[JOB]?.draft.feedbackSignals,
    );
    expect(snapshot.eventLog).toHaveLength(before.eventLog.length);
    expect(snapshot.revision).toBe(before.revision + 4);
  });

  it("keeps contact edits independent of score reset and outcome retry in a reopened demo", async () => {
    const store = new InMemoryDemoWorkspaceStore();
    const { adapter, repository } = await harness(store);
    const contactId = "contact-demo-hiring-partner";
    const scoreJob = "job-fabrikam-systems";
    await repository.mutate((draft) => {
      const fact = draft.state.readModel.contacts.details[contactId]!.contact.attributes[0]!;
      fact.value = "  Synthetic imported title  ";
      fact.provenance = { ...fact.provenance, sourceKind: "user_imported_list", sourceRef: "synthetic-source" };
    });
    const base = (await adapter.contact(contactId)).contact;
    const scoreBefore = repository.snapshotNow().state.readModel.jobs.details[scoreJob]!.job;
    expect(await adapter.resetStaleScoresForRescore({ jobKeys: [scoreJob], limit: 1 }))
      .toMatchObject({ count: 1, jobKeys: [scoreJob] });
    const afterReset = repository.snapshotNow().state.readModel.jobs.details[scoreJob]!;
    expect(afterReset.job).toMatchObject({ fitScore: scoreBefore.fitScore, scoreVersion: scoreBefore.scoreVersion,
      scoredAt: scoreBefore.scoredAt, scoreCriteria: scoreBefore.scoreCriteria, scoreTrace: scoreBefore.scoreTrace,
      scoreStaleness: scoreBefore.scoreStaleness });
    const outcome = { requestId: "11720000-0000-4000-8000-000000000009", kind: "interview" as const, note: "Synthetic outcome" };
    const accepted = await adapter.recordManualApplicationOutcome(JOB, outcome);
    expect((await adapter.contact(contactId)).contact.fingerprint).toBe(base.fingerprint);
    const imported = base.attributes[0]!;
    const newer = await adapter.updateContact(contactId, { expectedFingerprint: base.fingerprint,
      role: "warm_intro", attributes: [
        ...base.attributes.map(({ attributeId, kind, value }) => ({ attributeId, kind, value })),
        { kind: "note", value: "New synthetic fact" },
      ] });
    const added = newer.contact.attributes.find((fact) => fact.value === "New synthetic fact")!;
    await expect(adapter.updateContact(contactId, { expectedFingerprint: base.fingerprint, employer: "Draft employer" }))
      .rejects.toMatchObject({ status: 409 });
    const latest = (await adapter.contact(contactId)).contact;
    const saved = await adapter.updateContact(contactId, { expectedFingerprint: latest.fingerprint, employer: "Draft employer" });
    expect(saved.contact).toMatchObject({ employer: "Draft employer", role: "warm_intro" });
    expect(saved.contact.attributes.find((fact) => fact.attributeId === imported.attributeId)).toEqual(imported);
    expect(saved.contact.attributes.find((fact) => fact.attributeId === added.attributeId)).toEqual(added);
    expect(repository.snapshotNow().state.readModel.jobs.details[scoreJob]).toEqual(afterReset);
    const reopened = await harness(store);
    expect(await reopened.adapter.recordManualApplicationOutcome(JOB, outcome)).toEqual(accepted);
    expect((await reopened.adapter.contact(contactId)).contact.attributes).toEqual(saved.contact.attributes);
    expect(reopened.repository.snapshotNow().eventLog.filter((entry) => entry.event.eventType === "ApplicationOutcomeRecorded"))
      .toHaveLength(1);
  });

  it("fences canonical demo changes and supports previously saved contacts without edit tokens", async () => {
    const { adapter, repository } = await harness();
    const contactId = "contact-demo-hiring-partner";
    await repository.mutate((draft) => {
      delete (draft.state.readModel.contacts.details[contactId]!.contact as Partial<{ fingerprint: string }>).fingerprint;
    });
    const before = (await adapter.contact(contactId)).contact;
    expect(before.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    await repository.mutate((draft) => {
      draft.state.readModel.contacts.details[contactId]!.contact.attributes[0]!.provenance.sourceRef = "newer-source";
    });
    const accepted = repository.snapshotNow();
    await expect(adapter.updateContact(contactId, { expectedFingerprint: before.fingerprint, role: "referrer" }))
      .rejects.toMatchObject({ status: 409 });
    expect(repository.snapshotNow()).toEqual(accepted);
    const latest = (await adapter.contact(contactId)).contact;
    const next = await adapter.updateContact(contactId, { expectedFingerprint: latest.fingerprint, role: "referrer" });
    expect(next.contact.fingerprint).not.toBe(latest.fingerprint);
    expect((await adapter.contact(contactId)).contact).toEqual(next.contact);
    expect(next.contact.attributes).toEqual(latest.attributes);
  });

  it("updates contact attributes with retain-or-create identity and provenance semantics", async () => {
    const { adapter, repository } = await harness();
    await repository.mutate((draft) => {
      const attribute = draft.state.readModel.contacts.details["contact-demo-hiring-partner"]!.contact.attributes[0]!;
      attribute.provenance = {
        sourceKind: "user_imported_list",
        sourceRef: "bundled-contacts.csv",
        captureMethod: "csv_import",
        capturedAt: "2026-07-10T09:00:00.000Z",
        confidence: 0.8,
        userConfirmed: true,
      };
    });
    const request = {
      expectedFingerprint: (await adapter.contact("contact-demo-hiring-partner")).contact.fingerprint,
      role: "hiring_manager" as const,
      attributes: [
        { kind: "title" as const, value: "Synthetic hiring partner" },
        { kind: "name" as const, value: "Synthetic reviewer" },
      ],
    };
    const first = await adapter.updateContact("contact-demo-hiring-partner", request);
    await expect(adapter.updateContact("contact-demo-hiring-partner", request)).rejects.toMatchObject({ status: 409 });
    const replay = await adapter.updateContact("contact-demo-hiring-partner", { ...request, expectedFingerprint: first.contact.fingerprint });
    expect(first.contact.attributes).toEqual([
      {
        attributeId: "contact-demo-role",
        kind: "title",
        value: "Synthetic hiring partner",
        provenance: {
          sourceKind: "user_imported_list",
          sourceRef: "bundled-contacts.csv",
          captureMethod: "csv_import",
          capturedAt: "2026-07-10T09:00:00.000Z",
          confidence: 0.8,
          userConfirmed: true,
        },
      },
      {
        attributeId: "demo-contact-attribute-2-1",
        kind: "name",
        value: "Synthetic reviewer",
        provenance: {
          sourceKind: "user_entered",
          sourceRef: "user_entered",
          captureMethod: "manual",
          capturedAt: NOW,
          confidence: 1,
          userConfirmed: true,
        },
      },
    ]);
    expect(replay.contact.attributes).toEqual(first.contact.attributes);
    const snapshot = repository.snapshotNow();
    expect(snapshot.state.readModel.contacts.list.items.find(
      (contact) => contact.contactId === first.contact.contactId,
    )).toMatchObject({
      displayName: "Synthetic reviewer",
      role: "hiring_manager",
      attributeCount: 2,
      confirmedCount: 2,
      sourceKinds: ["user_imported_list", "user_entered"],
      allConfirmed: true,
      updatedAt: NOW,
    });
    expect(snapshot.eventLog.map((entry) => entry.event.eventType).slice(-3)).toEqual([
      "ContactUpdated",
      "ContactAttributeRecorded",
      "ContactUpdated",
    ]);
  });

  it("retains the selected duplicate fact and rejects invalid identity claims", async () => {
    const { adapter, repository } = await harness();
    const contactId = "contact-demo-hiring-partner";
    await repository.mutate((draft) => {
      const contact = draft.state.readModel.contacts.details[contactId]!.contact;
      const duplicate = structuredClone(contact.attributes[0]!);
      duplicate.attributeId = "contact-demo-duplicate";
      duplicate.provenance.sourceRef = "synthetic-second-source";
      contact.attributes.push(duplicate);
    });
    const base = (await adapter.contact(contactId)).contact;
    const selected = base.attributes.find((fact) => fact.attributeId === "contact-demo-duplicate")!;
    const saved = await adapter.updateContact(contactId, { expectedFingerprint: base.fingerprint,
      attributes: [{ attributeId: selected.attributeId, kind: "title", value: selected.value }] });
    expect(saved.contact.attributes).toEqual([selected]);
    const normalized = await adapter.updateContact(contactId, { expectedFingerprint: saved.contact.fingerprint,
      attributes: [{ attributeId: selected.attributeId, kind: "title", value: `${selected.value} ` }] });
    expect(normalized.contact.attributes).toEqual([selected]);
    const accepted = repository.snapshotNow();
    for (const attributes of [
      [{ attributeId: selected.attributeId, kind: "title" as const, value: selected.value },
        { attributeId: selected.attributeId, kind: "title" as const, value: selected.value }],
      [{ attributeId: "foreign-fact", kind: "title" as const, value: selected.value }],
    ]) {
      await expect(adapter.updateContact(contactId, { expectedFingerprint: normalized.contact.fingerprint, attributes }))
        .rejects.toMatchObject({ status: 400 });
      expect(repository.snapshotNow()).toEqual(accepted);
    }
  });

  it("retains id-less raw values and distinct sourced identities before normalized matches", async () => {
    const { adapter, repository } = await harness();
    const contactId = "contact-demo-hiring-partner";
    const value = "synthetic@example.test";
    const raw = `  ${value}  `;
    await repository.mutate((draft) => {
      const contact = draft.state.readModel.contacts.details[contactId]!.contact;
      const original = contact.attributes[0]!;
      contact.attributes = ["raw-one", "raw-two", "normalized"].map((attributeId, index) => ({
        ...structuredClone(original), attributeId, kind: "email", value: index < 2 ? raw : value,
        provenance: { ...original.provenance, sourceKind: "user_imported_list", sourceRef: `synthetic-${index}` },
      }));
    });
    const base = (await adapter.contact(contactId)).contact;
    const mixed = await adapter.updateContact(contactId, { expectedFingerprint: base.fingerprint, attributes: [
      { kind: "email", value: raw }, { kind: "email", value: raw },
      { attributeId: "normalized", kind: "email", value },
    ] });
    expect(mixed.contact.attributes).toEqual(base.attributes);
    const idless = await adapter.updateContact(contactId, { expectedFingerprint: mixed.contact.fingerprint,
      attributes: base.attributes.map(({ kind, value: factValue }) => ({ kind, value: factValue })) });
    expect(idless.contact.attributes).toEqual(base.attributes);
  });

  it("retains a long sourced fact and validates new values after trimming", async () => {
    const { adapter, repository } = await harness();
    const contactId = "contact-demo-hiring-partner";
    const long = "L".repeat(2001);
    await repository.mutate((draft) => {
      const fact = draft.state.readModel.contacts.details[contactId]!.contact.attributes[0]!;
      fact.value = long;
      fact.provenance = { ...fact.provenance, sourceKind: "user_imported_list", sourceRef: "synthetic-long-import" };
    });
    const base = (await adapter.contact(contactId)).contact;
    const original = base.attributes[0]!;
    const saved = await adapter.updateContact(contactId, { expectedFingerprint: base.fingerprint, attributes: [
      { attributeId: original.attributeId, kind: original.kind, value: long },
      { kind: "note", value: `${"N".repeat(2000)} ` },
    ] });
    expect(saved.contact.attributes.find((fact) => fact.attributeId === original.attributeId)).toEqual(original);
    expect(saved.contact.attributes.find((fact) => fact.value === "N".repeat(2000))).toBeDefined();
    const idless = await adapter.updateContact(contactId, { expectedFingerprint: saved.contact.fingerprint,
      attributes: saved.contact.attributes.map(({ kind, value }) => ({ kind, value })) });
    expect(idless.contact.attributes).toEqual(saved.contact.attributes);
    const accepted = repository.snapshotNow();
    for (const fact of [
      { attributeId: original.attributeId, kind: original.kind, value: "X".repeat(2001) },
      { kind: "unsupported_new", value: "synthetic" },
      { kind: "note", value: "   " },
    ]) {
      await expect(adapter.updateContact(contactId, { expectedFingerprint: idless.contact.fingerprint, attributes: [fact] }))
        .rejects.toMatchObject({ status: 400 });
      expect(repository.snapshotNow()).toEqual(accepted);
    }
  });

  it("confirms candidate evidence exactly once and completes the owning research task", async () => {
    const { adapter, repository } = await harness();
    const response = await adapter.confirmContactCandidate(
      "research-demo-hiring-partner",
      "candidate-demo-hiring-partner",
      { role: "hiring_manager" },
    );
    const snapshot = repository.snapshotNow();
    expect(response.contact).toMatchObject({
      displayName: "Synthetic research candidate",
      role: "hiring_manager",
      attributes: [
        { attributeId: "candidate-demo-name", provenance: { userConfirmed: true } },
        { attributeId: "candidate-demo-title", provenance: { userConfirmed: true } },
      ],
    });
    expect(response.task).toMatchObject({
      status: "completed",
      candidateCount: 1,
      needsReviewCount: 0,
      confirmedCount: 1,
      completedAt: NOW,
    });
    expect(snapshot.state.readModel.contacts.researchTaskDetails["research-demo-hiring-partner"]?.task).toMatchObject({
      status: "completed",
      candidates: [{ status: "confirmed", confirmedContactId: response.contact.contactId }],
    });
    expect(snapshot.eventLog.map((entry) => entry.event.eventType).slice(-4)).toEqual([
      "ContactCreated",
      "ContactAttributeRecorded",
      "ContactAttributeRecorded",
      "ContactResearchTaskCompleted",
    ]);
    await expect(adapter.confirmContactCandidate(
      "research-demo-hiring-partner",
      "candidate-demo-hiring-partner",
    )).rejects.toThrow("not awaiting review");
    expect(repository.snapshotNow().state.readModel.contacts.list.items.filter(
      (contact) => contact.contactId === response.contact.contactId,
    )).toHaveLength(1);
  });

  it("keeps settings, apply review, and job-template projections consistent", async () => {
    const { adapter, repository } = await harness();
    await expect(adapter.updateSettings({ dailyBudgetUsd: 12, workerActivitySlots: 8 })).resolves.toMatchObject({
      ok: true,
      settings: { dailyBudgetUsd: 12, workerActivitySlots: 8 },
      effectiveSettings: {
        dailyBudgetUsd: { value: 12, source: "persisted" },
      },
    });
    await expect(adapter.decideApplyReview(JOB, { decision: "approve_dry_run", decidedBy: "demo-user" })).resolves.toMatchObject({
      ok: true,
      decision: { jobKey: JOB, decision: "approve_dry_run", decidedAt: NOW },
    });
    const assignment = await adapter.setJobResumeTemplate(JOB, { templateId: "demo-template" });
    const snapshot = repository.snapshotNow();
    expect(snapshot.state.readModel.dashboard.health.llmSpend.dailyBudgetUsd).toBe(12);
    expect(snapshot.state.readModel.dashboard.digest.budget.dailyBudgetUsd).toBe(12);
    expect(snapshot.state.readModel.apply.queue.items.find((item) => item.jobKey === JOB)?.review.state).toBe("approved_dry_run");
    expect(snapshot.state.readModel.dashboard.digest.pendingApprovals.count).toBe(0);
    expect(snapshot.state.readModel.jobs.list.items.find((job) => job.jobKey === JOB)?.resumeTemplate?.effective.templateId).toBe("demo-template");
    expect(snapshot.state.readModel.jobs.details[JOB]?.job.resumeTemplate).toEqual(assignment.templateState);
  });

  it("validates the apply approval snapshot before persisting a review decision", async () => {
    const { adapter, repository } = await harness();
    const before = repository.snapshotNow();
    const queueItem = before.state.readModel.apply.queue.items.find((item) => item.jobKey === JOB)!;
    await expect(adapter.decideApplyReview(JOB, {
      decision: "approve_submit",
      decidedBy: "demo-reviewer",
      materialsGeneration: queueItem.approvalGate.materialsGeneration! + 1,
      profileVersion: queueItem.approvalGate.profileVersion,
      applicationUrl: queueItem.approvalGate.applicationUrl,
    })).rejects.toThrow("approval_stale_materials");
    expect(repository.snapshotNow().revision).toBe(before.revision);

    const response = await adapter.decideApplyReview(JOB, {
      decision: "approve_submit",
      materialsGeneration: queueItem.approvalGate.materialsGeneration,
      profileVersion: queueItem.approvalGate.profileVersion,
      applicationUrl: queueItem.approvalGate.applicationUrl,
      decidedBy: "demo-reviewer",
    });
    const snapshot = repository.snapshotNow();
    expect(response.decision).toMatchObject({
      jobKey: JOB,
      decision: "approve_submit",
      materialsGeneration: 1,
      profileVersion: 1,
      applicationUrl: queueItem.approvalGate.applicationUrl,
      decidedAt: NOW,
    });
    expect(snapshot.state.readModel.apply.queue.items.find((item) => item.jobKey === JOB)?.review).toMatchObject({
      state: "approved_submit",
      decision: "approve_submit",
      decidedAt: NOW,
      materialsGeneration: 1,
      profileVersion: 1,
      applicationUrl: queueItem.approvalGate.applicationUrl,
    });
    expect(snapshot.state.readModel.dashboard.digest.pendingApprovals.count).toBe(0);
    expect(snapshot.eventLog.at(-1)?.event).toMatchObject({
      eventType: "ApplyReviewDecisionRecorded",
      payload: { jobKey: JOB, decision: "approve_submit", materialsGeneration: 1, profileVersion: 1 },
    });
  });

  it("persists response-only audit evidence and links accepted outcome suggestions", async () => {
    const { adapter, repository } = await harness();
    const feedback = await adapter.recordDiscoveryFeedback({ jobKey: JOB, kind: "useful" });
    await repository.mutate((draft) => {
      draft.state.readModel.analytics.outcomes.suggestions.push({
        suggestionId: "suggestion-link",
        jobKey: JOB,
        evidenceId: null,
        determination: null, citations: [],
        suggestedKind: "interview",
        confidence: 0.9,
        rationale: "Synthetic evidence",
        status: "pending",
        createdAt: NOW,
        decidedAt: null,
        decisionReason: null,
        decidedOutcomeId: null,
      });
      draft.state.readModel.analytics.jobOutcomes[JOB]!.suggestions.push(
        structuredClone(draft.state.readModel.analytics.outcomes.suggestions.at(-1)!),
      );
    });
    const decision = await adapter.decideOutcomeSuggestion("suggestion-link", { decision: "accept" });
    const snapshot = repository.snapshotNow();
    expect(snapshot.eventLog.some((entry) =>
      entry.event.eventType === "DiscoveryFeedbackRecorded" &&
      entry.event.payload.feedbackId === feedback.feedbackId,
    )).toBe(true);
    expect(decision.outcome).toMatchObject({ jobKey: JOB, kind: "interview", suggestionId: "suggestion-link" });
    expect(decision.suggestion.decidedOutcomeId).toBe(decision.outcome?.outcomeId);
    expect(snapshot.state.readModel.analytics.jobOutcomes[JOB]?.outcomes).toContainEqual(decision.outcome);
  });

  it("synchronizes manual and suggested outcomes globally and per job without replay duplication", async () => {
    const { adapter, repository } = await harness();
    const manual = await adapter.recordManualApplicationOutcome(JOB, { requestId: "11720000-0000-4000-8000-000000000001",
      kind: "interview",
      occurredAt: NOW,
      note: "Synthetic reply",
      interviewPrepGeneration: 2,
    });
    await repository.mutate((draft) => {
      const suggestion = {
        suggestionId: "suggestion-replay",
        jobKey: JOB,
        evidenceId: "evidence-synthetic-email",
        determination: null, citations: [],
        suggestedKind: "interview",
        confidence: 0.92,
        rationale: "Bundled synthetic evidence",
        status: "pending",
        createdAt: NOW,
        decidedAt: null,
        decisionReason: null,
        decidedOutcomeId: null,
      } as const;
      draft.state.readModel.analytics.outcomes.suggestions.push(structuredClone(suggestion));
      draft.state.readModel.analytics.jobOutcomes[JOB]!.suggestions.push(structuredClone(suggestion));
    });
    const first = await adapter.decideOutcomeSuggestion("suggestion-replay", { decision: "accept", note: "Confirmed" });
    const replay = await adapter.decideOutcomeSuggestion("suggestion-replay", { decision: "accept", note: "Confirmed" });
    await expect(adapter.decideOutcomeSuggestion("suggestion-replay", { decision: "accept", note: "Different" }))
      .rejects.toMatchObject({ status: 409, responseBody: { error: "outcome_suggestion_conflict" } });
    expect(first.disposition).toBe("applied");
    expect(replay.disposition).toBe("replayed");
    const snapshot = repository.snapshotNow();
    expect(replay.outcome).toEqual(first.outcome);
    expect(snapshot.state.readModel.analytics.outcomes.outcomes.filter(
      (outcome) => outcome.outcomeId === first.outcome?.outcomeId,
    )).toHaveLength(1);
    expect(snapshot.state.readModel.analytics.jobOutcomes[JOB]?.outcomes).toContainEqual(manual.outcome);
    expect(snapshot.state.readModel.analytics.jobOutcomes[JOB]?.outcomes).toContainEqual(first.outcome);
    expect(snapshot.state.readModel.analytics.jobOutcomes[JOB]?.suggestions.find(
      (suggestion) => suggestion.suggestionId === "suggestion-replay",
    )).toMatchObject({ status: "accepted", decidedOutcomeId: first.outcome?.outcomeId });
    expect(snapshot.state.readModel.analytics.summary.suggestionAccuracy).toMatchObject({
      n: 1,
      decided: 1,
      accepted: 1,
      corrected: 0,
    });
    expect(snapshot.eventLog.filter((entry) =>
      entry.event.eventType === "ApplicationOutcomeRecorded" &&
      entry.event.payload.outcomeId === first.outcome?.outcomeId,
    )).toHaveLength(1);
    expect(snapshot.eventLog.filter((entry) =>
      entry.event.eventType === "OutcomeSuggestionDecided" &&
      entry.event.payload.suggestionId === "suggestion-replay",
    )).toHaveLength(1);
    await repository.mutate((_draft, context) => {
      for (let index = 0; index < DEMO_WORKSPACE_EVENT_LOG_LIMIT; index += 1) {
        context.appendDomainEvent(createDigestReviewed(LOCAL_TENANT, {
          acknowledgedAt: NOW, reviewedAt: NOW, previousAcknowledgedAt: null,
        }));
      }
    });
    expect(repository.snapshotNow().eventLog.some((entry) => entry.event.eventType === "OutcomeSuggestionDecided" &&
      entry.event.payload.suggestionId === "suggestion-replay")).toBe(false);
    expect((await adapter.decideOutcomeSuggestion("suggestion-replay", { decision: "accept", note: "Confirmed" })).disposition).toBe("replayed");
  });

  it.each([
    "outcome-kind", "outcome-note", "decision-reason", "event-kind", "receipt-fact", "missing-receipt", "reset-pending",
    "null-receipt", "array-receipt", "null-event", "missing-event", "null-fact", "missing-fact",
    "null-suggestion", "missing-suggestion", "missing-outcome", "null-request", "null-container",
  ] as const)(
    "refuses a demo suggestion replay after synthetic %s corruption", async (damage) => {
      const store = new InMemoryDemoWorkspaceStore();
      const { adapter, repository } = await harness(store);
      const suggestionId = `suggestion-integrity-${damage}`;
      const receiptKey = JSON.stringify(["local", JOB, suggestionId]);
      await repository.mutate((draft) => {
        const suggestion = { suggestionId, jobKey: JOB, evidenceId: "synthetic-evidence", determination: null,
          citations: [], suggestedKind: "interview" as const, confidence: 0.9, rationale: "Synthetic",
          status: "pending" as const, createdAt: NOW, decidedAt: null, decisionReason: null, decidedOutcomeId: null };
        draft.state.readModel.analytics.outcomes.suggestions.push(structuredClone(suggestion));
        draft.state.readModel.analytics.jobOutcomes[JOB]!.suggestions.push(structuredClone(suggestion));
      });
      const privateNote = "synthetic private note";
      const privateReason = "synthetic private reason";
      const request: OutcomeSuggestionDecisionRequest = { decision: "correct", outcomeKind: "offer",
        occurredAt: "2026-01-01T12:00:00.000Z", note: privateNote, reason: privateReason };
      await adapter.decideOutcomeSuggestion(suggestionId, request);
      expect((await adapter.decideOutcomeSuggestion(suggestionId, request)).disposition).toBe("replayed");
      const before = repository.snapshotNow();
      const eventText = JSON.stringify(before.eventLog);
      expect(eventText).not.toContain(privateNote);
      expect(eventText).not.toContain(privateReason);
      let retry: OutcomeSuggestionDecisionRequest = request;
      await repository.mutate((draft) => {
        const global = draft.state.readModel.analytics.outcomes;
        const perJob = draft.state.readModel.analytics.jobOutcomes[JOB]!;
        const suggestions = [global.suggestions.find((item) => item.suggestionId === suggestionId)!,
          perJob.suggestions.find((item) => item.suggestionId === suggestionId)!];
        const outcomes = [global.outcomes.find((item) => item.suggestionId === suggestionId)!,
          perJob.outcomes.find((item) => item.suggestionId === suggestionId)!];
        const receipt = draft.state.suggestionDecisionReceipts![receiptKey]!;
        switch (damage) {
          case "outcome-kind":
            outcomes.forEach((outcome) => { outcome.kind = "rejection"; });
            retry = { ...request, outcomeKind: "rejection" };
            break;
          case "outcome-note":
            outcomes.forEach((outcome) => { outcome.note = "altered synthetic note"; });
            retry = { ...request, note: "altered synthetic note" };
            break;
          case "decision-reason":
            suggestions.forEach((item) => { item.decisionReason = "altered synthetic reason"; });
            retry = { ...request, reason: "altered synthetic reason" };
            break;
          case "event-kind": {
            // Event history is append-only through the repository; inject the
            // damage through the independently owned backing store below.
            break;
          }
          case "receipt-fact":
            Object.assign(receipt.fact.suggestion, { decisionReason: "altered receipt" });
            break;
          case "null-receipt":
            Object.assign(draft.state.suggestionDecisionReceipts!, { [receiptKey]: null });
            break;
          case "array-receipt":
            Object.assign(draft.state.suggestionDecisionReceipts!, { [receiptKey]: [] });
            break;
          case "null-event":
            Object.assign(receipt, { event: null });
            break;
          case "missing-event":
            Reflect.deleteProperty(receipt, "event");
            break;
          case "null-fact":
            Object.assign(receipt, { fact: null });
            break;
          case "missing-fact":
            Reflect.deleteProperty(receipt, "fact");
            break;
          case "null-suggestion":
            Object.assign(receipt.fact, { suggestion: null });
            break;
          case "missing-suggestion":
            Reflect.deleteProperty(receipt.fact, "suggestion");
            break;
          case "missing-outcome":
            Reflect.deleteProperty(receipt.fact, "outcome");
            break;
          case "null-request":
            Object.assign(receipt, { request: null });
            break;
          case "null-container":
            Object.assign(draft.state, { suggestionDecisionReceipts: null });
            break;
          case "missing-receipt":
            delete draft.state.suggestionDecisionReceipts![receiptKey];
            break;
          case "reset-pending":
            suggestions.forEach((item) => Object.assign(item, { status: "pending", decidedAt: null, decisionReason: null, decidedOutcomeId: null }));
            break;
        }
      });
      if (damage === "event-kind") {
        await store.transact((current, transaction) => {
          const draft = structuredClone(current!);
          const receipt = draft.state.suggestionDecisionReceipts![receiptKey]!;
          const event = draft.eventLog.find((entry) => entry.sequence === receipt.eventSequence)!;
          Object.assign(event.event.payload, { outcomeKind: "rejection" });
          transaction.putSnapshot({ ...draft, revision: draft.revision + 1 });
        });
        const persisted = (await store.readSnapshot())!;
        const event = persisted.eventLog.find((entry) => entry.sequence === persisted.state.suggestionDecisionReceipts![receiptKey]!.eventSequence)!;
        expect(event.event.payload).toMatchObject({ outcomeKind: "rejection" });
      }
      const corruptedReceipts = structuredClone((await repository.snapshot()).state.suggestionDecisionReceipts);
      await expect(adapter.decideOutcomeSuggestion(suggestionId, retry)).rejects.toMatchObject({
        status: 409, responseBody: { error: "outcome_suggestion_replay_unverifiable" },
      });
      const after = repository.snapshotNow();
      expect(after.state.suggestionDecisionReceipts).toEqual(corruptedReceipts);
      expect(after.state.readModel.analytics.outcomes.outcomes.filter((item) => item.suggestionId === suggestionId)).toHaveLength(1);
      expect(after.eventLog.filter((entry) => entry.event.eventType === "OutcomeSuggestionDecided" && entry.event.payload.suggestionId === suggestionId)).toHaveLength(1);
    },
  );

  it("does not replace a malformed pending receipt even after the bounded event history is absent", async () => {
    const store = new InMemoryDemoWorkspaceStore();
    const { adapter, repository } = await harness(store);
    const suggestionId = "suggestion-corrupt-pending-receipt";
    await repository.mutate((draft) => {
      const suggestion = { suggestionId, jobKey: JOB, evidenceId: "synthetic-evidence", determination: null,
        citations: [], suggestedKind: "interview" as const, confidence: 0.9, rationale: "Synthetic",
        status: "pending" as const, createdAt: NOW, decidedAt: null, decisionReason: null, decidedOutcomeId: null };
      draft.state.readModel.analytics.outcomes.suggestions.push(structuredClone(suggestion));
      draft.state.readModel.analytics.jobOutcomes[JOB]!.suggestions.push(structuredClone(suggestion));
    });
    await adapter.decideOutcomeSuggestion(suggestionId, { decision: "accept" });
    const key = JSON.stringify(["local", JOB, suggestionId]);
    await repository.mutate((draft) => {
      for (const suggestion of [draft.state.readModel.analytics.outcomes.suggestions.find((item) => item.suggestionId === suggestionId)!,
        draft.state.readModel.analytics.jobOutcomes[JOB]!.suggestions.find((item) => item.suggestionId === suggestionId)!]) {
        Object.assign(suggestion, { status: "pending", decidedAt: null, decisionReason: null, decidedOutcomeId: null });
      }
      Object.assign(draft.state.suggestionDecisionReceipts!, { [key]: null });
    });
    await store.transact((current, transaction) => {
      const draft = structuredClone(current!);
      transaction.putSnapshot({ ...draft, eventLog: [], revision: draft.revision + 1 });
    });
    expect((await store.readSnapshot())!.eventLog).toHaveLength(0);
    await repository.snapshot();
    await expect(adapter.decideOutcomeSuggestion(suggestionId, { decision: "ignore" })).rejects.toMatchObject({
      status: 409, responseBody: { error: "outcome_suggestion_replay_unverifiable" },
    });
    const snapshot = repository.snapshotNow();
    expect(snapshot.state.suggestionDecisionReceipts?.[key]).toBeNull();
    expect(snapshot.state.readModel.analytics.outcomes.outcomes.filter((item) => item.suggestionId === suggestionId)).toHaveLength(1);
    expect(snapshot.eventLog).toHaveLength(0);
  });

  it("purges only the selected job's private suggestion receipts", async () => {
    const { adapter, repository } = await harness();
    const suggestionId = "suggestion-purge-receipt";
    await repository.mutate((draft) => {
      const suggestion = { suggestionId, jobKey: JOB, evidenceId: "synthetic-evidence", determination: null,
        citations: [], suggestedKind: "interview" as const, confidence: 0.9, rationale: "Synthetic",
        status: "pending" as const, createdAt: NOW, decidedAt: null, decisionReason: null, decidedOutcomeId: null };
      draft.state.readModel.analytics.outcomes.suggestions.push(structuredClone(suggestion));
      draft.state.readModel.analytics.jobOutcomes[JOB]!.suggestions.push(structuredClone(suggestion));
    });
    await adapter.decideOutcomeSuggestion(suggestionId, { decision: "correct", outcomeKind: "offer", note: "synthetic note" });
    const key = JSON.stringify(["local", JOB, suggestionId]);
    await repository.mutate((draft) => {
      const receipt = draft.state.suggestionDecisionReceipts![key]!;
      draft.state.suggestionDecisionReceipts!["other"] = { ...receipt,
        fact: { ...receipt.fact, suggestion: { ...receipt.fact.suggestion, jobKey: "synthetic-other-job" } } };
      draft.state.suggestionDecisionReceipts!["malformed-target-key"] = structuredClone(receipt);
      Object.assign(receipt, { fact: null });
      Object.assign(draft.state.suggestionDecisionReceipts!, { "malformed-other-key": null });
      purgeDemoJobProjections(draft, JOB);
    });
    const receipts = repository.snapshotNow().state.suggestionDecisionReceipts!;
    expect(receipts[key]).toBeUndefined();
    expect(receipts["other"]).toBeDefined();
    expect(receipts["malformed-target-key"]).toBeUndefined();
    expect(receipts["malformed-other-key"]).toBeNull();
  });

  it("propagates a score correction policy revision and marks comparable scores stale", async () => {
    const { adapter, repository } = await harness();
    const before = repository.snapshotNow();
    const previous = before.state.readModel.jobs.details[JOB]!.job;
    const previousVersion = previous.scoreVersion!;
    await adapter.correctScore(JOB, { correctedScore: 9, reason: "Reviewed synthetic evidence" });
    const snapshot = repository.snapshotNow();
    const corrected = snapshot.state.readModel.jobs.details[JOB]!.job;
    const comparable = snapshot.state.readModel.jobs.list.items.filter(
      (job) => job.jobKey !== JOB && job.scoreVersion !== null && job.scoreCorrection === null,
    );
    expect(corrected).toMatchObject({
      fitScore: 9,
      scoreVersion: previousVersion + 1,
      scoredAt: NOW,
      scoreCorrection: {
        originalScore: previous.fitScore,
        correctedScore: 9,
        rationale: "Reviewed synthetic evidence",
        correctedAt: NOW,
      },
      scoreStaleness: previous.scoreStaleness,
    });
    expect(corrected.scoreTrace).toMatchObject({
      scoringPolicyId: previous.scoreTrace?.scoringPolicyId,
      scoringPolicyVersion: previous.scoreTrace?.scoringPolicyVersion,
    });
    expect(corrected.scoreTrace?.correctionHistory.at(-1)).toMatchObject({ correctedScore: 9, correctedAt: NOW });
    expect(comparable.length).toBeGreaterThan(0);
    for (const job of comparable) {
      expect(job.scoreStaleness).toMatchObject({
        isStale: true,
        staleReason: "scoring_policy_changed",
        targetPolicyVersion: 4,
        markedAt: NOW,
        pendingExplicitRescore: true,
      });
      expect(snapshot.state.readModel.jobs.details[job.jobKey]?.job.scoreStaleness).toEqual(job.scoreStaleness);
    }
    expect(snapshot.state.readModel.apply.queue.items.find((item) => item.jobKey === JOB)).toMatchObject({
      fitScore: 9,
      scoreVersion: previousVersion + 1,
      scoredAt: NOW,
      scoreTrace: { scoringPolicyVersion: previous.scoreTrace?.scoringPolicyVersion },
    });
    expect(snapshot.state.readModel.dashboard.summary.preparation).toMatchObject({
      currentScoringPolicyVersion: 4,
      outdatedScoreCount: comparable.length,
    });
    expect(snapshot.state.readModel.dashboard.digest.staleScores.count).toBe(comparable.length);
  });

  it("keeps existing staleness and score source when correcting an already-stale score", async () => {
    const { adapter, repository } = await harness();
    await adapter.correctScore(JOB, { correctedScore: 9, reason: "Synthetic first correction" });
    const before = repository.snapshotNow();
    const stale = before.state.readModel.jobs.list.items.find((job) =>
      job.jobKey !== JOB && job.scoreVersion !== null && job.scoreStaleness.isStale,
    )!;
    expect(stale).toBeDefined();
    await adapter.correctScore(stale.jobKey, { correctedScore: 8, reason: "Synthetic second correction" });
    const after = repository.snapshotNow();
    const corrected = after.state.readModel.jobs.details[stale.jobKey]!.job;
    expect(corrected.scoreStaleness).toEqual(stale.scoreStaleness);
    expect(corrected.scoreTrace?.scoringPolicyId).toBe(stale.scoreTrace?.scoringPolicyId);
    expect(corrected.scoreTrace?.scoringPolicyVersion).toBe(stale.scoreTrace?.scoringPolicyVersion);
    expect(corrected.scoreCriteria).toEqual(stale.scoreCriteria);
    expect(after.state.readModel.dashboard.digest.staleScores.count).toBe(
      after.state.readModel.jobs.list.items.filter((job) => job.scoreStaleness.isStale).length,
    );
  });

  it("does not reset an active score and reports when to retry", async () => {
    const { adapter, repository } = await harness();
    const jobKey = "job-fabrikam-systems";
    await repository.mutate((draft) => {
      const detail = draft.state.readModel.jobs.details[jobKey]!;
      detail.job.currentState = "running";
      detail.stages.find((stage) => stage.stage === "score")!.state = "running";
      draft.state.readModel.jobs.list.items.find((job) => job.jobKey === jobKey)!.currentState = "running";
    });
    const before = repository.snapshotNow();
    const response = await adapter.resetStaleScoresForRescore({ jobKeys: [jobKey], limit: 0 });
    expect(response).toMatchObject({ count: 0, jobKeys: [], skippedActiveJobKeys: [jobKey] });
    const after = repository.snapshotNow();
    expect(after.state.readModel.jobs.details[jobKey]).toEqual(before.state.readModel.jobs.details[jobKey]);
    expect(after.state.readModel.jobs.details[jobKey]!.job.scoreStaleness.isStale).toBe(true);
  });

  it("keeps hidden and deleted stale jobs out of bounded and explicit resets", async () => {
    const { adapter, repository } = await harness();
    const hidden = JOB;
    const deleted = "job-contoso-reliability";
    const active = "job-fabrikam-systems";
    await repository.mutate((draft) => {
      const template = draft.state.readModel.jobs.details[active]!;
      for (const [jobKey, deletedAt, hiddenAt, scoreState] of [
        [hidden, null, NOW, "running"],
        [deleted, NOW, null, "stale"],
      ] as const) {
        const summary = draft.state.readModel.jobs.list.items.find((job) => job.jobKey === jobKey)!;
        const detail = draft.state.readModel.jobs.details[jobKey]!;
        for (const job of [summary, detail.job]) {
          job.deletedAt = deletedAt;
          job.hiddenAt = hiddenAt;
          job.scoreStaleness = structuredClone(template.job.scoreStaleness);
        }
        const stage = detail.stages.find((item) => item.stage === "score");
        if (stage) stage.state = scoreState;
        else detail.stages.push({ ...structuredClone(template.stages.find((item) => item.stage === "score")!), state: scoreState });
      }
    });
    const before = repository.snapshotNow();
    expect(await adapter.resetStaleScoresForRescore({ jobKeys: [], limit: 1 })).toMatchObject({
      count: 1, jobKeys: [active], skippedActiveJobKeys: [], alreadyPendingJobKeys: [],
    });
    expect(await adapter.resetStaleScoresForRescore({ jobKeys: [hidden, deleted], limit: 1 })).toMatchObject({
      count: 0, jobKeys: [], skippedActiveJobKeys: [], alreadyPendingJobKeys: [],
    });
    const after = repository.snapshotNow();
    expect(after.state.readModel.jobs.details[hidden]).toEqual(before.state.readModel.jobs.details[hidden]);
    expect(after.state.readModel.jobs.details[deleted]).toEqual(before.state.readModel.jobs.details[deleted]);
    expect(after.eventLog.filter((entry) => entry.event.eventType === "ScoreRescoreRequested")).toHaveLength(1);

    await repository.mutate((draft) => {
      for (const [jobKey, property] of [[hidden, "hiddenAt"], [deleted, "deletedAt"]] as const) {
        draft.state.readModel.jobs.list.items.find((job) => job.jobKey === jobKey)![property] = null;
        draft.state.readModel.jobs.details[jobKey]!.job[property] = null;
      }
    });
    expect(await adapter.resetStaleScoresForRescore({ jobKeys: [hidden, deleted], limit: 1 })).toMatchObject({
      count: 1, jobKeys: [deleted], skippedActiveJobKeys: [hidden],
    });
  });

  it.each(["closed", "expired", "removed", "location_incompatible"] as const)(
    "excludes a %s posting from the active stale-score cohort", async (activeState) => {
      const { adapter, repository } = await harness();
      const active = "job-fabrikam-systems";
      await repository.mutate((draft) => {
        const template = draft.state.readModel.jobs.details[active]!;
        const summary = draft.state.readModel.jobs.list.items.find((job) => job.jobKey === JOB)!;
        const detail = draft.state.readModel.jobs.details[JOB]!;
        for (const job of [summary, detail.job]) {
          job.activeState = activeState;
          job.scoreStaleness = structuredClone(template.job.scoreStaleness);
        }
        const stage = detail.stages.find((item) => item.stage === "score");
        if (stage) stage.state = "stale";
        else detail.stages.push({ ...structuredClone(template.stages.find((item) => item.stage === "score")!), state: "stale" });
      });
      const before = repository.snapshotNow().state.readModel.jobs.details[JOB];
      expect(await adapter.resetStaleScoresForRescore({ jobKeys: [], limit: 1 })).toMatchObject({ count: 1, jobKeys: [active] });
      expect(await adapter.resetStaleScoresForRescore({ jobKeys: [JOB], limit: 1 })).toMatchObject({ count: 0, jobKeys: [] });
      expect(repository.snapshotNow().state.readModel.jobs.details[JOB]).toEqual(before);
    },
  );

  it("reports an already pending stale score on a repeated reset", async () => {
    const { adapter, repository } = await harness();
    const jobKey = "job-fabrikam-systems";
    const first = await adapter.resetStaleScoresForRescore({ jobKeys: [jobKey], limit: 1 });
    expect(first).toMatchObject({ count: 1, jobKeys: [jobKey] });
    const afterFirst = repository.snapshotNow();
    expect(afterFirst.state.readModel.jobs.details[jobKey]!.stages.find((stage) => stage.stage === "score")?.state)
      .toBe("pending");
    expect(afterFirst.state.readModel.jobs.details[jobKey]!.job.scoreStaleness.isStale).toBe(true);
    const second = await adapter.resetStaleScoresForRescore({ jobKeys: [jobKey], limit: 1 });
    expect(second).toMatchObject({ count: 0, jobKeys: [], alreadyPendingJobKeys: [jobKey] });
    const afterSecond = repository.snapshotNow();
    expect(afterSecond.state.readModel.jobs.details[jobKey]).toEqual(afterFirst.state.readModel.jobs.details[jobKey]);
    expect(afterSecond.eventLog.filter((entry) => entry.event.eventType === "ScoreRescoreRequested")).toHaveLength(1);
  });

  it("cancels a workflow atomically and replays without duplicate terminal evidence", async () => {
    const { adapter, repository } = await harness();
    const startedAt = repository.snapshotNow().state.readModel.runs.details["run-materials-progress"]!.startedAt!;
    const first = await adapter.cancelWorkflowRun("run-materials-progress");
    const replay = await adapter.cancelWorkflowRun("run-materials-progress");
    const snapshot = repository.snapshotNow();
    const detail = snapshot.state.readModel.runs.details["run-materials-progress"]!;
    expect(replay).toEqual(first);
    expect(detail).toMatchObject({
      status: "canceled",
      result: "canceled_by_user",
      retryable: true,
      finishedAt: NOW,
      durationMs: Date.parse(NOW) - Date.parse(startedAt),
    });
    expect(detail.events.filter((event) => event.eventType === "WorkflowCanceled")).toHaveLength(1);
    expect(snapshot.state.readModel.runs.list.items.find((run) => run.runId === detail.runId)).toMatchObject({
      status: "canceled",
      result: "canceled_by_user",
      finishedAt: NOW,
    });
    expect(snapshot.state.readModel.dashboard.summary.progress.some((progress) => progress.runId === detail.runId)).toBe(false);
    expect(snapshot.state.readModel.jobs.details[JOB]?.job.currentState).toBe("canceled");
    expect(snapshot.state.readModel.dashboard.summary.work).toMatchObject({ active: 0, stuck: 0, stuckItems: [] });
    expect(snapshot.state.readModel.dashboard.summary.preparation?.workItems).toEqual({ queued: 0, running: 0, failed: 1 });
    expect(snapshot.state.readModel.dashboard.summary.funnel.find((stage) => stage.stage === "tailor")).toEqual({
      stage: "tailor", total: 1, succeeded: 0, running: 0, pending: 0, blocked: 1, failed: 0,
    });
    expect(snapshot.state.readModel.apply.queue.items.find((item) => item.jobKey === JOB)?.currentState).toBe("canceled");
    expect(snapshot.state.readModel.dashboard.digest).toMatchObject({
      pendingApprovals: { count: 0 },
      reviewNeededMaterials: { count: 0 },
      staleScores: { count: 1 },
    });
    expect(snapshot.eventLog.filter((entry) =>
      entry.event.eventType === "WorkflowCanceled" && entry.event.payload.workflowId === detail.workflowId,
    )).toHaveLength(1);
    expect(snapshot.eventLog.filter((entry) =>
      entry.event.eventType === "StageCanceled" && entry.event.payload.jobId === JOB,
    )).toHaveLength(1);
  });

  it("requires an owning run for job cancellation and persists skip semantics without a fake run", async () => {
    const { adapter, repository } = await harness();
    await expect(adapter.cancelJobAction("job-fabrikam-systems", {})).rejects.toThrow("no active workflow run");
    const skipped = await adapter.markSkipped(JOB, { reason: "Synthetic operator choice" });
    const snapshot = repository.snapshotNow();
    expect(skipped).toMatchObject({
      ok: true,
      action: "mark_skipped",
      runId: `job-action:${JOB}:mark-skipped`,
      status: "succeeded",
    });
    expect(snapshot.state.readModel.jobs.details[JOB]?.job).toMatchObject({ currentState: "skipped", nextAction: null });
    expect(snapshot.state.readModel.apply.queue.items.find((item) => item.jobKey === JOB)).toMatchObject({
      currentState: "skipped",
      review: { state: "declined", decision: "decline", decidedAt: NOW },
    });
    expect(snapshot.state.readModel.dashboard.digest.pendingApprovals.count).toBe(0);
    expect(snapshot.state.readModel.dashboard.summary.work.active).toBe(0);
    expect(snapshot.state.readModel.dashboard.summary.preparation?.workItems).toEqual({ queued: 0, running: 0, failed: 1 });
    expect(snapshot.state.readModel.dashboard.summary.funnel.find((stage) => stage.stage === "tailor")).toEqual({
      stage: "tailor", total: 1, succeeded: 0, running: 0, pending: 0, blocked: 1, failed: 0,
    });
    expect(snapshot.eventLog.at(-1)?.event).toMatchObject({
      eventType: "StageSkipped",
      payload: { jobId: JOB, reason: "Synthetic operator choice" },
    });
  });

  it("keeps template, visibility, outreach pointer, and due-follow-up projections truthful", async () => {
    const { adapter, repository } = await harness();
    const before = repository.snapshotNow();
    const template = before.state.readModel.materials.resumeTemplates.templates[0]!;
    await adapter.setJobResumeTemplate(JOB, {
      templateId: template.templateId,
      versionId: template.activeVersion.versionId,
    });
    const saved = await adapter.saveResumeTemplate({
      templateId: template.templateId,
      expectedVersionId: template.activeVersion.versionId,
      displayName: "Revised bundled template",
      theme: template.activeVersion.theme,
      layout: template.activeVersion.layout,
    });
    let snapshot = repository.snapshotNow();
    expect(snapshot.state.readModel.materials.resumeTemplates.templates).toHaveLength(1);
    expect(saved.template).toMatchObject({
      templateId: template.templateId,
      builtIn: template.builtIn,
      activeVersion: { versionNumber: template.activeVersion.versionNumber + 1 },
    });
    expect(snapshot.state.readModel.materials.resumeTemplates.defaultTemplate?.templateVersionId).toBe(
      template.activeVersion.versionId,
    );
    expect(snapshot.state.readModel.jobs.details[JOB]?.job.resumeTemplate?.effective).toMatchObject({
      assignmentSource: "job_override",
      templateVersionId: template.activeVersion.versionId,
    });
    expect(snapshot.state.readModel.materials.resumeTemplates.effectiveDefaultVersion.versionId).toBe(
      template.activeVersion.versionId,
    );
    await expect(adapter.setJobResumeTemplate(JOB, {
      templateId: template.templateId,
      versionId: "missing-template-version",
    })).rejects.toThrow("was not found");

    await adapter.hideJob(JOB, { reason: "Synthetic privacy choice" });
    await adapter.unhideJob(JOB);
    await repository.mutate((draft) => {
      const thread = draft.state.readModel.outreach.thread.thread!;
      thread.approvedDraftId = "outreach-draft-candidate";
      thread.hasApprovedDraft = true;
    });
    await adapter.rejectOutreachDraft("thread-demo", "outreach-draft-candidate", { reason: "Needs revision" });
    await adapter.completeOutreachFollowUp("thread-demo");
    snapshot = repository.snapshotNow();
    expect(snapshot.state.readModel.jobs.details[JOB]?.job.hiddenAt).toBeNull();
    expect(snapshot.state.readModel.outreach.thread.thread).toMatchObject({
      approvedDraftId: "outreach-draft-approved",
      hasApprovedDraft: true,
      followUp: { state: "completed" },
    });
    expect(snapshot.state.readModel.outreach.dueFollowUps.followUps).toEqual([]);
    expect(snapshot.state.readModel.dashboard.digest.followUpsDue.count).toBe(0);
    expect(snapshot.eventLog.map((entry) => entry.event.eventType)).toEqual(expect.arrayContaining([
      "JobHidden",
      "JobUnhidden",
      "OutreachDraftRejected",
      "FollowUpCompleted",
    ]));
    expect(snapshot.eventLog.find((entry) => entry.event.eventType === "JobHidden")?.event).toMatchObject({
      payload: { jobId: JOB, reason: "Synthetic privacy choice", hiddenAt: NOW },
    });
  });

  it("refuses a stale demo template update and retains the winning version", async () => {
    const { adapter, repository } = await harness();
    const original = repository.snapshotNow().state.readModel.materials.resumeTemplates.templates[0]!;
    const body = { templateId: original.templateId, expectedVersionId: original.activeVersion.versionId,
      displayName: "Synthetic winning version", theme: original.activeVersion.theme, layout: original.activeVersion.layout };
    const winner = await adapter.saveResumeTemplate(body);
    await expect(adapter.saveResumeTemplate({ ...body, displayName: "Synthetic stale draft" })).rejects.toMatchObject({ status: 409 });
    const current = repository.snapshotNow().state.readModel.materials.resumeTemplates.templates.find((item) => item.templateId === original.templateId);
    expect(current).toMatchObject({ displayName: "Synthetic winning version", activeVersion: { versionId: winner.template.activeVersion.versionId } });
    await expect(adapter.setDefaultResumeTemplate({ templateId: original.templateId, versionId: original.activeVersion.versionId,
      expectedActiveVersionId: original.activeVersion.versionId })).rejects.toMatchObject({ status: 409 });
    const selected = await adapter.setDefaultResumeTemplate({ templateId: original.templateId, versionId: original.activeVersion.versionId,
      expectedActiveVersionId: winner.template.activeVersion.versionId });
    expect(selected.defaultTemplate.templateVersionId).toBe(original.activeVersion.versionId);
  });

  it("rejects invalid template default preconditions and malformed template saves without changing the workspace", async () => {
    const { adapter, repository } = await harness();
    const original = repository.snapshotNow().state.readModel.materials.resumeTemplates.templates[0]!;
    const before = repository.snapshotNow();
    const invalidDefaults = [
      { templateId: original.templateId, expectedActiveVersionId: 42 },
      { templateId: original.templateId, expectedActiveVersionId: null },
      { templateId: original.templateId, expectedActiveVersionId: " " },
      { templateId: original.templateId, expectedActiveVersionID: original.activeVersion.versionId },
    ];
    for (const body of invalidDefaults) {
      await expect(adapter.setDefaultResumeTemplate(body as unknown as Parameters<ApiClientPort["setDefaultResumeTemplate"]>[0])).rejects.toMatchObject({ status: 400 });
    }
    await expect(adapter.setDefaultResumeTemplate({ templateId: "missing-synthetic-template" })).rejects.toMatchObject({ status: 400 });
    await expect(adapter.setDefaultResumeTemplate({ templateId: "missing-synthetic-template", expectedActiveVersionId: "synthetic-version" })).rejects.toMatchObject({ status: 409 });
    await expect(adapter.setDefaultResumeTemplate({ templateId: original.templateId, versionId: "missing-synthetic-version" })).rejects.toMatchObject({ status: 400 });
    const invalidTheme = { displayName: "Synthetic template", theme: { ...original.activeVersion.theme, fontScale: 2 }, layout: {} };
    const invalidThemeError = await adapter.saveResumeTemplate(invalidTheme).then(() => null, (error: unknown) => error);
    expect(invalidThemeError).toMatchObject({ status: 400, message: expect.stringMatching(/^Invalid resume template save request:/) });
    expect(invalidThemeError).toMatchObject({ message: expect.not.stringMatching(/current version/i) });
    await expect(adapter.saveResumeTemplate({ templateId: original.templateId, displayName: "Synthetic template", theme: original.activeVersion.theme, layout: {} }))
      .rejects.toMatchObject({ status: 400, message: expect.stringMatching(/current version/i) });
    const after = repository.snapshotNow();
    expect(after.revision).toBe(before.revision);
    expect(after.eventLog).toEqual(before.eventLog);
    expect(after.state.readModel.materials.resumeTemplates).toEqual(before.state.readModel.materials.resumeTemplates);
  });

  it("cascades permanent job deletion and contact deletion without dangling read models", async () => {
    const { adapter, repository } = await harness();
    const before = repository.snapshotNow();
    await adapter.permanentlyDeleteJob(JOB);
    let snapshot = repository.snapshotNow();
    expect(snapshot.revision).toBe(before.revision + 1);
    expect(snapshot.eventLog).toHaveLength(before.eventLog.length);
    expect(snapshot.state.readModel.jobs.details[JOB]).toBeUndefined();
    expect(snapshot.state.readModel.materials.list.items.some((artifact) => artifact.jobKey === JOB)).toBe(false);
    expect(Object.values(snapshot.state.readModel.runs.details).some((run) => run.jobKey === JOB)).toBe(false);
    expect(snapshot.state.readModel.apply.queue.items.some((item) => item.jobKey === JOB)).toBe(false);
    expect(snapshot.state.readModel.analytics.jobOutcomes[JOB]).toBeUndefined();

    await adapter.deleteContact("contact-demo-hiring-partner", { reason: "Demo cleanup" });
    snapshot = repository.snapshotNow();
    expect(snapshot.state.readModel.contacts.details["contact-demo-hiring-partner"]).toBeUndefined();
    expect(snapshot.state.readModel.outreach.thread.thread).toBeNull();
    expect(snapshot.state.readModel.outreach.dueFollowUps.followUps).toEqual([]);
  });

  it("rejects a quota-failed command and preserves the last durable projection", async () => {
    const store = new QuotaOnNextTransactionStore();
    const { adapter, repository } = await harness(store);
    const before = repository.snapshotNow();
    store.failNext = true;
    await expect(adapter.updateSettings({ dailyBudgetUsd: 99 })).rejects.toBeInstanceOf(
      DemoCommandPersistenceError,
    );
    const after = repository.snapshotNow();
    expect(after.state.readModel.settings.settings.dailyBudgetUsd).toBe(
      before.state.readModel.settings.settings.dailyBudgetUsd,
    );
  });
});

class QuotaOnNextTransactionStore implements DemoWorkspaceStore {
  readonly storageMode = "indexeddb" as const;
  readonly memory = new InMemoryDemoWorkspaceStore();
  failNext = false;

  readSnapshot() { return this.memory.readSnapshot(); }
  readBlob(blobId: string) { return this.memory.readBlob(blobId); }
  readAllBlobs() { return this.memory.readAllBlobs(); }
  transact<TValue>(operation: (
    current: DemoWorkspaceSnapshot | null,
    transaction: DemoWorkspaceTransaction,
  ) => TValue): Promise<TValue> {
    if (this.failNext) {
      this.failNext = false;
      return Promise.reject(new DemoWorkspaceStorageError("quota"));
    }
    return this.memory.transact(operation);
  }
}
