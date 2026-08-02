import { describe, expect, it, vi } from "vitest";
import type { DomainEventType } from "@jobctrl/domain-types";

import type { ApiClientPort } from "../shared/ports/ApiClientPort.js";
import { DEMO_CAPABILITY_MANIFEST } from "./capabilities.js";
import { DemoApiClientAdapter } from "./DemoApiClientAdapter.js";
import {
  DEMO_BROWSER_LOCAL_COMMANDS,
  DEMO_PRODUCTION_NO_EVENT_COMMANDS,
  DemoCommandPersistenceError,
} from "./DemoLocalCommandExecutor.js";
import {
  DemoWorkspaceRepository,
  DemoWorkspaceStorageError,
  InMemoryDemoWorkspaceStore,
  type DemoWorkspaceSnapshot,
  type DemoWorkspaceStore,
  type DemoWorkspaceTransaction,
} from "./workspace/index.js";

const NOW = "2026-07-11T12:00:00.000Z";

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
  importManualCapture: ["importedAt", "itemId", "jobKey", "ok", "provenance"],
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
  decideOutcomeSuggestion: ["ok", "outcome", "suggestion"],
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
  resetStaleScoresForRescore: ["count", "jobKeys", "nextAction", "ok"],
  cancelWorkflowRun: ACTION_RESPONSE_KEYS,
  updateProfile: ["ok", "profile", "style", "templateText"],
  importResume: ["ok", "profile", "source", "style", "templateText"],
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
  importManualCapture: ["JobDiscovered"],
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
  importResume: ["ProfileImported"],
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
  ["importManualCapture", (api) => api.importManualCapture("capture-demo-browser", { captureMode: "current_page", capturedUrl: "https://example.invalid/demo", futureManualActionRequired: false })],
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
  ["recordManualApplicationOutcome", (api) => api.recordManualApplicationOutcome(JOB, { kind: "interview", occurredAt: NOW, note: "Synthetic outcome", interviewPrepGeneration: 1 })],
  ["decideOutcomeSuggestion", async (api, repository) => {
    await repository.mutate((draft) => {
      const suggestion = {
        suggestionId: "suggestion-demo",
        jobKey: JOB,
        evidenceId: null,
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
  ["importResume", (api) => api.importResume({ filename: "demo.pdf", pdfBase64: "ZGVtbw==", importProfile: true, importStyle: true })],
  ["updateSettings", (api) => api.updateSettings({ dailyBudgetUsd: 12, workerActivitySlots: 8 })],
  ["createContact", (api) => api.createContact({ role: "recruiter", employer: "Demo Workshop", attributes: [{ kind: "name", value: "Synthetic contact" }] })],
  ["updateContact", (api) => api.updateContact("contact-demo-hiring-partner", { role: "hiring_manager" })],
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
  it("keeps the 133-member capability manifest exhaustive with exact class counts", () => {
    const counts = Object.values(DEMO_CAPABILITY_MANIFEST).reduce<Record<string, number>>(
      (result, capability) => {
        result[capability.class] = (result[capability.class] ?? 0) + 1;
        return result;
      },
      {},
    );
    expect(Object.keys(DEMO_CAPABILITY_MANIFEST)).toHaveLength(133);
    expect(counts).toEqual({
      browser_local: 92,
      simulated_async: 4,
      rehearsed_external: 4,
      unavailable: 33,
    });
  });

  it("has one valid invocation for every P3a browser-local command", async () => {
    expect(LOCAL_CASES.map(([method]) => method).toSorted()).toEqual(
      [...DEMO_BROWSER_LOCAL_COMMANDS].toSorted(),
    );
    expect(DEMO_BROWSER_LOCAL_COMMANDS).toHaveLength(49);
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
      role: "hiring_manager" as const,
      attributes: [
        { kind: "title" as const, value: "Synthetic hiring partner" },
        { kind: "name" as const, value: "Synthetic reviewer" },
      ],
    };
    const first = await adapter.updateContact("contact-demo-hiring-partner", request);
    const replay = await adapter.updateContact("contact-demo-hiring-partner", request);
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

  it("imports the bundled manual capture into one coherent job and replays without fetching or duplicating", async () => {
    const { adapter, repository } = await harness();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const before = repository.snapshotNow();
      const request = {
        captureMode: "current_page" as const,
        capturedUrl: "https://demo.invalid/source-preview.html",
        futureManualActionRequired: false,
      };
      const first = await adapter.importManualCapture("capture-demo-browser", request);
      const replay = await adapter.importManualCapture("capture-demo-browser", request);
      const snapshot = repository.snapshotNow();
      expect(first).toMatchObject({
        ok: true,
        itemId: "capture-demo-browser",
        jobKey: "job-manual-capture:capture-demo-browser",
        provenance: {
          sourceKind: "user_mediated_capture",
          originatingUrl: "https://demo.invalid/source-preview.html",
        },
      });
      expect(replay).toEqual(first);
      expect(snapshot.state.readModel.jobs.list.items.filter((job) => job.jobKey === first.jobKey)).toHaveLength(1);
      expect(snapshot.state.readModel.jobs.details[first.jobKey!]).toMatchObject({
        ok: true,
        job: {
          jobKey: first.jobKey,
          source: "bundled-manual-capture",
          descriptionPreview: expect.stringContaining("browser-local"),
        },
      });
      expect(snapshot.state.readModel.analytics.jobOutcomes[first.jobKey!]).toEqual({
        ok: true,
        jobKey: first.jobKey,
        outcomes: [],
        suggestions: [],
      });
      expect(snapshot.state.readModel.dashboard.summary.totals.jobs).toBe(before.state.readModel.dashboard.summary.totals.jobs + 1);
      expect(snapshot.state.readModel.dashboard.digest.newMatches.count).toBe(before.state.readModel.dashboard.digest.newMatches.count + 1);
      expect(snapshot.eventLog.filter((entry) => entry.event.eventType === "JobDiscovered")).toHaveLength(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
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
    const manual = await adapter.recordManualApplicationOutcome(JOB, {
      kind: "recruiter_reply",
      occurredAt: NOW,
      note: "Synthetic reply",
      interviewPrepGeneration: 2,
    });
    await repository.mutate((draft) => {
      const suggestion = {
        suggestionId: "suggestion-replay",
        jobKey: JOB,
        evidenceId: "evidence-synthetic-email",
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
    const replay = await adapter.decideOutcomeSuggestion("suggestion-replay", { decision: "accept", note: "Replay" });
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
      (job) => job.jobKey !== JOB && job.scoreVersion !== null,
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
      scoreStaleness: {
        isStale: false,
        currentPolicyVersion: 4,
        targetPolicyVersion: 4,
        pendingExplicitRescore: false,
      },
    });
    expect(corrected.scoreTrace).toMatchObject({
      scoringPolicyId: "demo:scoring-policy-4",
      scoringPolicyVersion: 4,
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
      scoreTrace: { scoringPolicyVersion: 4 },
    });
    expect(snapshot.state.readModel.dashboard.summary.preparation).toMatchObject({
      currentScoringPolicyVersion: 4,
      outdatedScoreCount: comparable.length,
    });
    expect(snapshot.state.readModel.dashboard.digest.staleScores.count).toBe(comparable.length);
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

  it("cancels the newest pending job action without orphaning it behind a seeded active run", async () => {
    const { adapter, repository } = await harness();
    const queued = await adapter.rescoreJob(JOB, {});

    expect(repository.snapshotNow().state.readModel.runs.details["run-materials-progress"]?.status)
      .toBe("in_progress");
    expect(repository.snapshotNow().pendingScenarios).toContainEqual(
      expect.objectContaining({ runId: queued.runId, targetRefs: expect.objectContaining({ jobKey: JOB }) }),
    );

    const canceled = await adapter.cancelJobAction(JOB, {});
    adapter.dispose();
    const snapshot = repository.snapshotNow();

    expect(canceled).toMatchObject({ runId: queued.runId, status: "canceled" });
    expect(snapshot.state.readModel.runs.details[queued.runId]?.status).toBe("canceled");
    expect(snapshot.state.readModel.runs.details["run-materials-progress"]?.status).toBe("in_progress");
    expect(snapshot.pendingScenarios).not.toContainEqual(
      expect.objectContaining({ runId: queued.runId }),
    );
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
