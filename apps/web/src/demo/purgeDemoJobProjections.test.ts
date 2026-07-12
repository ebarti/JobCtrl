import { describe, expect, it } from "vitest";

import { materializeDemoSeed } from "./clock.js";
import {
  purgeDemoJobProjections,
  recomputeDemoOperationalProjections,
  recomputeDemoOutcomeProjections,
} from "./purgeDemoJobProjections.js";
import { DEMO_SEED } from "./seed.js";
import {
  DEMO_WORKSPACE_SCHEMA_VERSION,
  type DemoWorkspaceSnapshot,
} from "./workspace/index.js";

const JOB = "job-northwind-platform";
const OTHER_JOB = "job-contoso-reliability";
const JOB_URL = "demo-job:northwind-platform";
const NOW = "2026-07-11T12:00:00.000Z";

describe("purgeDemoJobProjections", () => {
  it("removes every structured job projection and recomputes derived counts", () => {
    const snapshot = createSnapshot();
    addUnrelatedContact(snapshot);
    addOutcomeSuggestions(snapshot);
    setBlobIds(snapshot, ["artifact-tailored-resume", "unrelated-blob"]);

    const result = purgeDemoJobProjections(snapshot, JOB);

    expect(result.removedArtifactIds).toEqual([
      "artifact-tailored-resume",
      "artifact-tailored-resume-html",
    ]);
    expect(result.removedRunIds).toEqual(
      expect.arrayContaining([
        "run-materials-progress",
        "run-failed-quality-gate",
        "run-application-rehearsal",
        "run-discovery-cancelled",
        "run-discovery-demo",
      ]),
    );
    expect(result.blobIdsToDelete).toEqual(["artifact-tailored-resume"]);

    const model = snapshot.state.readModel;
    expect(model.jobs.details[JOB]).toBeUndefined();
    expect(model.jobs.list.items.map((job) => job.jobKey)).toEqual([
      OTHER_JOB,
      "job-fabrikam-systems",
    ]);
    expect(model.materials.list.items).toEqual([]);
    expect(model.materials.details).toEqual({});
    expect(model.materials.resumeReviewDrafts[JOB]).toBeUndefined();
    expect(model.materials.resumeReviewFeedback[JOB]).toBeUndefined();
    expect(model.apply.queue.items).toEqual([]);
    expect(model.analytics.jobOutcomes[JOB]).toBeUndefined();
    expect(model.analytics.outcomes.outcomes).toHaveLength(2);
    expect(model.analytics.outcomes.suggestions).toEqual([
      expect.objectContaining({
        suggestionId: "suggestion-unrelated",
        jobKey: OTHER_JOB,
      }),
    ]);
    expect(model.analytics.jobOutcomes[OTHER_JOB]?.suggestions).toEqual(
      model.analytics.outcomes.suggestions,
    );
    expect(model.analytics.summary.totals).toMatchObject({
      n: 2,
      applied: 2,
      reply: 2,
      interview: 1,
      offer: 1,
      rejection: 1,
    });

    expect(model.dashboard.summary.activity).toEqual([]);
    expect(model.dashboard.activity.items).toEqual([]);
    expect(model.dashboard.activityEvents).toEqual({});
    expect(model.dashboard.summary.progress).toEqual([]);
    expect(model.dashboard.summary.applyRuns).toEqual([]);
    expect(model.evidence.entries[0]?.requirementUsages).toEqual([]);
    expect(model.discovery.roleMatchFeedback.suggestions).toEqual([]);

    expect(
      model.contacts.details["contact-demo-hiring-partner"]?.contact.jobId,
    ).toBeNull();
    expect(
      model.contacts.list.items.find(
        (contact) => contact.contactId === "contact-demo-hiring-partner",
      )?.jobId,
    ).toBeNull();
    expect(
      model.contacts.researchTaskDetails["research-demo-hiring-partner"]?.task
        .jobId,
    ).toBeNull();
    expect(model.contacts.researchTasks.items[0]?.jobId).toBeNull();
    expect(model.outreach.thread.thread).toMatchObject({
      threadId: "thread-demo",
      jobId: null,
    });
    expect(model.outreach.dueFollowUps.followUps[0]).toMatchObject({
      threadId: "thread-demo",
      jobId: null,
    });

    expect(
      snapshot.state.routeData.jobs.some((record) => record.id === JOB),
    ).toBe(false);
    expect(collectStructuredJobReferences(model, JOB)).toEqual([]);
    expect(collectStructuredUrlReferences(model, JOB_URL)).toEqual([]);

    expect(model.jobs.list.pagination.total).toBe(model.jobs.list.items.length);
    expect(model.materials.list.pagination.total).toBe(
      model.materials.list.items.length,
    );
    expect(model.runs.list.pagination.total).toBe(model.runs.list.items.length);
    expect(model.dashboard.activity.pagination.total).toBe(
      model.dashboard.activity.items.length,
    );
    expect(model.dashboard.summary.totals.jobs).toBe(
      model.jobs.list.items.length,
    );
    expect(model.dashboard.summary.totals.blocked).toBe(
      model.jobs.list.items.filter((job) => job.currentState === "blocked")
        .length,
    );
    expect(model.dashboard.digest.pendingApprovals.count).toBe(
      model.apply.queue.items.filter((item) => item.review.state === "pending")
        .length,
    );
    expect(model.dashboard.digest.staleScores.count).toBe(
      model.jobs.list.items.filter((job) => job.scoreStaleness.isStale).length,
    );
  });

  it("preserves unrelated jobs, contacts, outcomes, and free-form blobs and is idempotent", () => {
    const snapshot = createSnapshot();
    addUnrelatedContact(snapshot);
    setBlobIds(snapshot, ["artifact-tailored-resume", "unrelated-blob"]);
    const otherDetail = structuredClone(
      snapshot.state.readModel.jobs.details[OTHER_JOB],
    );
    const otherOutcome = structuredClone(
      snapshot.state.readModel.analytics.jobOutcomes[OTHER_JOB],
    );

    purgeDemoJobProjections(snapshot, JOB);
    purgeDemoJobProjections(snapshot, JOB);

    expect(snapshot.state.readModel.jobs.details[OTHER_JOB]).toEqual(
      otherDetail,
    );
    expect(snapshot.state.readModel.analytics.jobOutcomes[OTHER_JOB]).toEqual(
      otherOutcome,
    );
    expect(
      snapshot.state.readModel.contacts.details["contact-unrelated"]?.contact,
    ).toMatchObject({
      contactId: "contact-unrelated",
      jobId: OTHER_JOB,
    });
    expect(snapshot.state.readModel.contacts.list.items).toContainEqual(
      expect.objectContaining({
        contactId: "contact-unrelated",
        jobId: OTHER_JOB,
      }),
    );
    expect(snapshot.blobIds).toEqual([
      "artifact-tailored-resume",
      "unrelated-blob",
    ]);
  });

  it("removes a job-only contact and repairs candidate and outreach references", () => {
    const snapshot = createSnapshot();
    const detail =
      snapshot.state.readModel.contacts.details["contact-demo-hiring-partner"]!;
    const summary = snapshot.state.readModel.contacts.list.items[0]!;
    detail.contact.employer = null;
    summary.employer = null;
    const candidate =
      snapshot.state.readModel.contacts.researchTaskDetails[
        "research-demo-hiring-partner"
      ]!.task.candidates[0]!;
    candidate.status = "confirmed";
    candidate.confirmedContactId = detail.contact.contactId;
    candidate.confirmedAt = NOW;

    purgeDemoJobProjections(snapshot, JOB);

    expect(
      snapshot.state.readModel.contacts.details[detail.contact.contactId],
    ).toBeUndefined();
    expect(snapshot.state.readModel.contacts.list.items).toEqual([]);
    expect(candidate).toMatchObject({
      status: "needs_review",
      confirmedContactId: null,
      confirmedAt: null,
    });
    expect(
      snapshot.state.readModel.contacts.researchTaskDetails[
        "research-demo-hiring-partner"
      ]?.task,
    ).toMatchObject({
      candidateCount: 1,
      needsReviewCount: 1,
      confirmedCount: 0,
    });
    expect(snapshot.state.readModel.outreach.thread.thread).toBeNull();
    expect(snapshot.state.readModel.outreach.dueFollowUps.followUps).toEqual(
      [],
    );
  });
});

describe("derived demo projections", () => {
  it("reconciles cancellation from terminal job, stage, and run state", () => {
    const snapshot = createSnapshot();
    const beforeAnalytics = structuredClone(snapshot.state.readModel.analytics);
    terminalizeJob(snapshot, "canceled");
    terminalizeRun(snapshot, "run-materials-progress", "canceled");

    recomputeDemoOperationalProjections(snapshot);

    const { summary, digest } = snapshot.state.readModel.dashboard;
    expect(summary.work).toMatchObject({ active: 0, stuck: 0 });
    expect(summary.preparation?.workItems).toEqual({
      queued: 0,
      running: 0,
      failed: 0,
    });
    expect(summary.progress).toEqual([]);
    expect(
      summary.funnel.find((stage) => stage.stage === "tailor"),
    ).toMatchObject({
      total: 1,
      running: 0,
      pending: 0,
      blocked: 1,
    });
    expect(digest.pendingApprovals.count).toBe(0);
    expect(digest.staleScores.count).toBe(1);
    expect(snapshot.state.readModel.analytics).toEqual(beforeAnalytics);
  });

  it("reconciles skipped work without representing it as pending", () => {
    const snapshot = createSnapshot();
    terminalizeJob(snapshot, "skipped");
    const queueItem = snapshot.state.readModel.apply.queue.items[0]!;
    queueItem.currentState = "skipped";
    queueItem.review.state = "declined";
    queueItem.review.decision = "decline";

    recomputeDemoOperationalProjections(snapshot);

    const { summary, digest } = snapshot.state.readModel.dashboard;
    expect(summary.work.active).toBe(0);
    expect(summary.preparation?.workItems.running).toBe(0);
    expect(
      summary.funnel.find((stage) => stage.stage === "tailor"),
    ).toMatchObject({
      total: 1,
      running: 0,
      pending: 0,
      blocked: 1,
    });
    expect(digest.pendingApprovals.count).toBe(0);
  });

  it("excludes hidden, deleted, and closed jobs and restores their derived counts", () => {
    const snapshot = createSnapshot();
    const staleJob = snapshot.state.readModel.jobs.list.items.find(
      (job) => job.jobKey === "job-fabrikam-systems",
    )!;
    const staleDetail = snapshot.state.readModel.jobs.details[staleJob.jobKey]!;

    staleJob.hiddenAt = NOW;
    staleDetail.job.hiddenAt = NOW;
    recomputeDemoOutcomeProjections(snapshot);
    expect(snapshot.state.readModel.dashboard.summary.totals.jobs).toBe(2);
    expect(snapshot.state.readModel.dashboard.digest.staleScores.count).toBe(0);
    expect(snapshot.state.readModel.analytics.summary.totals.n).toBe(2);

    staleJob.hiddenAt = null;
    staleDetail.job.hiddenAt = null;
    staleJob.deletedAt = NOW;
    staleDetail.job.deletedAt = NOW;
    recomputeDemoOutcomeProjections(snapshot);
    expect(snapshot.state.readModel.dashboard.summary.totals.jobs).toBe(2);
    expect(snapshot.state.readModel.dashboard.digest.staleScores.count).toBe(0);
    expect(snapshot.state.readModel.analytics.summary.totals.n).toBe(2);

    staleJob.deletedAt = null;
    staleDetail.job.deletedAt = null;
    staleJob.activeState = "closed";
    staleDetail.job.activeState = "closed";
    recomputeDemoOutcomeProjections(snapshot);
    expect(snapshot.state.readModel.dashboard.summary.totals.jobs).toBe(2);
    expect(snapshot.state.readModel.analytics.summary.totals.n).toBe(2);

    staleJob.activeState = "active";
    staleDetail.job.activeState = "active";
    recomputeDemoOutcomeProjections(snapshot);
    expect(snapshot.state.readModel.dashboard.summary.totals.jobs).toBe(3);
    expect(snapshot.state.readModel.dashboard.digest.staleScores.count).toBe(1);
    expect(snapshot.state.readModel.analytics.summary.totals.n).toBe(3);
  });

  it("recomputes settings-dependent digest thresholds and outcome consumers", () => {
    const snapshot = createSnapshot();
    snapshot.state.readModel.settings.settings.minFitScore = 9;

    recomputeDemoOperationalProjections(snapshot);

    expect(snapshot.state.readModel.dashboard.digest.highFitThreshold).toBe(9);
    expect(snapshot.state.readModel.dashboard.digest.newMatches).toEqual({
      count: 3,
      highFitCount: 0,
    });

    recomputeDemoOutcomeProjections(snapshot);

    const analytics = snapshot.state.readModel.analytics.summary;
    expect(analytics.totals).toMatchObject({
      n: 3,
      applied: 3,
      reply: 3,
      interview: 2,
      offer: 1,
      rejection: 1,
    });
    expect(analytics.byTemplate).toEqual([
      expect.objectContaining({ templateId: "demo-template", applied: 3 }),
    ]);
    expect(analytics.byPolicy).toEqual([
      expect.objectContaining({
        tailoringPolicyVersion: 2,
        policyLabel: "Demo policy",
        applied: 3,
      }),
    ]);
    expect(
      snapshot.state.readModel.dashboard.summary.conversion.totals,
    ).toMatchObject({
      applied: 3,
      reply: 3,
      interview: 2,
    });
  });
});

function createSnapshot(): DemoWorkspaceSnapshot {
  const materialized = materializeDemoSeed(DEMO_SEED, { anchor: NOW });
  return structuredClone({
    schemaVersion: DEMO_WORKSPACE_SCHEMA_VERSION,
    seedVersion: DEMO_SEED.seedVersion,
    workspaceId: "purge-test",
    createdAt: NOW,
    updatedAt: NOW,
    resetCount: 0,
    revision: 0,
    resetEpoch: 0,
    lastEventSequence: 0,
    eventLog: [],
    blobIds: [],
    state: {
      title: materialized.title,
      generatedAt: materialized.generatedAt,
      artifacts: materialized.artifacts,
      readModel: materialized.readModel,
      routeData: materialized.routeData,
      receipts: materialized.receipts,
    },
    pendingScenarios: [],
  }) as DemoWorkspaceSnapshot;
}

function addUnrelatedContact(snapshot: DemoWorkspaceSnapshot): void {
  const contacts = snapshot.state.readModel.contacts;
  const originalSummary = contacts.list.items[0]!;
  const originalDetail = contacts.details[originalSummary.contactId]!;
  contacts.list.items.push({
    ...structuredClone(originalSummary),
    contactId: "contact-unrelated",
    jobId: OTHER_JOB,
  });
  (contacts.details as Record<string, typeof originalDetail>)[
    "contact-unrelated"
  ] = {
    ok: true,
    contact: {
      ...structuredClone(originalDetail.contact),
      contactId: "contact-unrelated",
      jobId: OTHER_JOB,
    },
  };
}

function addOutcomeSuggestions(snapshot: DemoWorkspaceSnapshot): void {
  const analytics = snapshot.state.readModel.analytics;
  type Suggestion = (typeof analytics.outcomes.suggestions)[number];
  const base = {
    evidenceId: null,
    suggestedKind: "interview",
    confidence: 0.8,
    rationale: "Structured purge fixture",
    status: "pending",
    createdAt: NOW,
    decidedAt: null,
    decisionReason: null,
    decidedOutcomeId: null,
  } satisfies Omit<Suggestion, "suggestionId" | "jobKey">;
  const deletedSuggestion: Suggestion = {
    ...base,
    suggestionId: "suggestion-deleted",
    jobKey: JOB,
  };
  const unrelatedSuggestion: Suggestion = {
    ...base,
    suggestionId: "suggestion-unrelated",
    jobKey: OTHER_JOB,
  };
  analytics.outcomes.suggestions.push(deletedSuggestion, unrelatedSuggestion);
  analytics.jobOutcomes[JOB]!.suggestions.push(deletedSuggestion);
  analytics.jobOutcomes[OTHER_JOB]!.suggestions.push(unrelatedSuggestion);
}

function terminalizeJob(
  snapshot: DemoWorkspaceSnapshot,
  state: "canceled" | "skipped",
): void {
  const summary = snapshot.state.readModel.jobs.list.items.find(
    (job) => job.jobKey === JOB,
  )!;
  const detail = snapshot.state.readModel.jobs.details[JOB]!;
  summary.currentState = state;
  detail.job.currentState = state;
  detail.stages[0]!.state = state;
}

function terminalizeRun(
  snapshot: DemoWorkspaceSnapshot,
  runId: string,
  status: "canceled",
): void {
  const summary = snapshot.state.readModel.runs.list.items.find(
    (run) => run.runId === runId,
  )!;
  const detail = snapshot.state.readModel.runs.details[runId]!;
  Object.assign(summary as unknown as Record<string, unknown>, { status });
  Object.assign(detail as unknown as Record<string, unknown>, { status });
}

function setBlobIds(snapshot: DemoWorkspaceSnapshot, blobIds: string[]): void {
  (snapshot as unknown as { blobIds: string[] }).blobIds = blobIds;
}

function collectStructuredJobReferences(
  value: unknown,
  jobKey: string,
): string[] {
  const references: string[] = [];
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate)) {
      const nestedPath = path ? `${path}.${key}` : key;
      if (
        (key === "jobKey" || key === "jobId" || key === "jobUrl") &&
        nested === jobKey
      ) {
        references.push(nestedPath);
      }
      if (key === jobKey) references.push(`${nestedPath} (record key)`);
      visit(nested, nestedPath);
    }
  };
  visit(value, "readModel");
  return references;
}

function collectStructuredUrlReferences(
  value: unknown,
  jobUrl: string,
): string[] {
  const referenceFields = new Set([
    "url",
    "jobUrl",
    "postingUrl",
    "candidateUrl",
    "originatingUrl",
  ]);
  const references: string[] = [];
  const visit = (candidate: unknown, path: string): void => {
    if (Array.isArray(candidate)) {
      candidate.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (!candidate || typeof candidate !== "object") return;
    for (const [key, nested] of Object.entries(candidate)) {
      const nestedPath = path ? `${path}.${key}` : key;
      if (referenceFields.has(key) && nested === jobUrl)
        references.push(nestedPath);
      visit(nested, nestedPath);
    }
  };
  visit(value, "readModel");
  return references;
}
