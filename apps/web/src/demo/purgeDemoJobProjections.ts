import type { OutcomeAnalyticsSummary } from "@jobctrl/contracts";

import type { DemoWorkspaceSnapshot } from "./workspace/index.js";

type Mutable<TValue> = TValue extends (...args: never[]) => unknown
  ? TValue
  : TValue extends readonly (infer TItem)[]
    ? Mutable<TItem>[]
    : TValue extends object
      ? { -readonly [TKey in keyof TValue]: Mutable<TValue[TKey]> }
      : TValue;

type MutableSnapshot = Mutable<DemoWorkspaceSnapshot>;
type DemoJob =
  MutableSnapshot["state"]["readModel"]["jobs"]["list"]["items"][number];
type AnalyticsFunnel = OutcomeAnalyticsSummary["totals"];
type ConversionCounts = Pick<
  AnalyticsFunnel,
  "applied" | "reply" | "interview" | "offer" | "rejection"
>;

export interface DemoJobPurgeResult {
  /** Stable ownership keys for P3b-generated artifact blobs. */
  readonly removedArtifactIds: readonly string[];
  readonly removedRunIds: readonly string[];
  /**
   * Manifest entries whose ID exactly equals a removed artifact ID or localPath.
   * The current snapshot schema has no broader blob-to-artifact ownership map,
   * so unrelated free-form blobs are deliberately never inferred or deleted.
   */
  readonly blobIdsToDelete: readonly string[];
}

const REPLY_OUTCOMES = new Set([
  "recruiter_reply",
  "interview",
  "assessment",
  "offer",
  "rejection",
]);
const INTERVIEW_OUTCOMES = new Set(["interview", "assessment", "offer"]);
const OFFER_OUTCOMES = new Set(["offer"]);
const REJECTION_OUTCOMES = new Set(["rejection"]);

/**
 * Permanently removes one job from every browser-local structured projection.
 *
 * Call this inside one DemoWorkspaceRepository mutation. The function performs
 * no I/O; blob deletion remains the caller's responsibility through the
 * mutation context so the snapshot and IndexedDB transaction commit together.
 */
export function purgeDemoJobProjections(
  snapshot: DemoWorkspaceSnapshot,
  jobKey: string,
): DemoJobPurgeResult {
  const draft = snapshot as unknown as MutableSnapshot;
  const model = draft.state.readModel;
  const job =
    model.jobs.details[jobKey]?.job ??
    model.jobs.list.items.find((item) => item.jobKey === jobKey);
  const jobUrl = job?.url ?? null;

  const removedArtifactIds = collectRemovedArtifactIds(draft, jobKey);
  const removedArtifactPaths = collectRemovedArtifactPaths(
    draft,
    removedArtifactIds,
  );
  const removedRunIds = collectRemovedRunIds(draft, jobKey);
  const blobIdsToDelete = draft.blobIds.filter(
    (blobId) =>
      removedArtifactIds.has(blobId) || removedArtifactPaths.has(blobId),
  );

  delete model.jobs.details[jobKey];
  model.jobs.list.items = model.jobs.list.items.filter(
    (item) => item.jobKey !== jobKey,
  );
  syncPagination(model.jobs.list);

  model.materials.list.items = model.materials.list.items.filter(
    (item) => item.jobKey !== jobKey,
  );
  for (const [artifactId, detail] of Object.entries(model.materials.details)) {
    if (
      removedArtifactIds.has(artifactId) ||
      detail.artifact.jobKey === jobKey
    ) {
      delete model.materials.details[artifactId];
    }
  }
  delete model.materials.resumeReviewDrafts[jobKey];
  delete model.materials.resumeReviewFeedback[jobKey];
  syncPagination(model.materials.list);
  const artifactCounts = new Map<string, number>();
  for (const artifact of model.materials.list.items) {
    artifactCounts.set(
      artifact.jobKey,
      (artifactCounts.get(artifact.jobKey) ?? 0) + 1,
    );
  }
  for (const remainingJob of model.jobs.list.items) {
    remainingJob.artifactCount = artifactCounts.get(remainingJob.jobKey) ?? 0;
    const detail = model.jobs.details[remainingJob.jobKey];
    if (detail) {
      detail.job.artifactCount = remainingJob.artifactCount;
      detail.artifacts = detail.artifacts.filter(
        (artifact) =>
          artifact.jobKey === remainingJob.jobKey &&
          !removedArtifactIds.has(artifact.artifactId),
      );
    }
  }

  model.apply.queue.items = model.apply.queue.items.filter(
    (item) => item.jobKey !== jobKey,
  );

  model.runs.list.items = model.runs.list.items.filter(
    (run) => run.jobKey !== jobKey && !removedRunIds.has(run.runId),
  );
  for (const [runId, detail] of Object.entries(model.runs.details)) {
    if (removedRunIds.has(runId) || detail.jobKey === jobKey)
      delete model.runs.details[runId];
  }
  syncPagination(model.runs.list);

  model.analytics.outcomes.outcomes = model.analytics.outcomes.outcomes.filter(
    (outcome) => outcome.jobKey !== jobKey,
  );
  model.analytics.outcomes.suggestions =
    model.analytics.outcomes.suggestions.filter(
      (suggestion) => suggestion.jobKey !== jobKey,
    );
  delete model.analytics.jobOutcomes[jobKey];
  const remainingJobKeys = new Set(
    model.jobs.list.items.map((item) => item.jobKey),
  );
  for (const existingJobKey of Object.keys(model.analytics.jobOutcomes)) {
    if (!remainingJobKeys.has(existingJobKey))
      delete model.analytics.jobOutcomes[existingJobKey];
  }
  for (const remainingJobKey of remainingJobKeys) {
    const perJob = model.analytics.jobOutcomes[remainingJobKey] ?? {
      ok: true,
      jobKey: remainingJobKey,
      outcomes: [],
      suggestions: [],
    };
    perJob.jobKey = remainingJobKey;
    perJob.outcomes = model.analytics.outcomes.outcomes.filter(
      (outcome) => outcome.jobKey === remainingJobKey,
    );
    perJob.suggestions = model.analytics.outcomes.suggestions.filter(
      (suggestion) => suggestion.jobKey === remainingJobKey,
    );
    model.analytics.jobOutcomes[remainingJobKey] = perJob;
  }

  purgeDiscoveryReferences(draft, jobKey, jobUrl);
  purgeEvidenceReferences(draft, jobKey);
  purgeDashboardReferences(draft, jobKey, removedRunIds);
  purgeContactReferences(draft, jobKey);
  purgeRouteReferences(draft, jobKey, jobUrl);
  recomputeDemoOutcomeProjections(snapshot);

  return {
    removedArtifactIds: [...removedArtifactIds],
    removedRunIds: [...removedRunIds],
    blobIdsToDelete,
  };
}

/** Rebuilds dashboard and digest projections after a non-outcome mutation. */
export function recomputeDemoOperationalProjections(
  snapshot: DemoWorkspaceSnapshot,
): void {
  const draft = snapshot as unknown as MutableSnapshot;
  recomputeDashboard(draft);
  recomputeDigest(draft);
}

/** Rebuilds outcome analytics and every dashboard/digest consumer of them. */
export function recomputeDemoOutcomeProjections(
  snapshot: DemoWorkspaceSnapshot,
): void {
  const draft = snapshot as unknown as MutableSnapshot;
  recomputeAnalytics(draft);
  recomputeDashboard(draft);
  recomputeDigest(draft);
}

function collectRemovedArtifactIds(
  draft: MutableSnapshot,
  jobKey: string,
): Set<string> {
  const result = new Set(
    draft.state.readModel.materials.list.items
      .filter((artifact) => artifact.jobKey === jobKey)
      .map((artifact) => artifact.artifactId),
  );
  for (const [artifactId, detail] of Object.entries(
    draft.state.readModel.materials.details,
  )) {
    if (detail.artifact.jobKey === jobKey) result.add(artifactId);
  }
  return result;
}

function collectRemovedArtifactPaths(
  draft: MutableSnapshot,
  artifactIds: ReadonlySet<string>,
): Set<string> {
  const result = new Set<string>();
  for (const artifact of draft.state.readModel.materials.list.items) {
    if (artifactIds.has(artifact.artifactId)) result.add(artifact.localPath);
  }
  for (const [artifactId, detail] of Object.entries(
    draft.state.readModel.materials.details,
  )) {
    if (artifactIds.has(artifactId)) result.add(detail.artifact.localPath);
  }
  return result;
}

function collectRemovedRunIds(
  draft: MutableSnapshot,
  jobKey: string,
): Set<string> {
  const result = new Set(
    draft.state.readModel.runs.list.items
      .filter((run) => run.jobKey === jobKey)
      .map((run) => run.runId),
  );
  for (const [runId, detail] of Object.entries(
    draft.state.readModel.runs.details,
  )) {
    if (detail.jobKey === jobKey) result.add(runId);
  }
  return result;
}

function purgeDiscoveryReferences(
  draft: MutableSnapshot,
  jobKey: string,
  jobUrl: string | null,
): void {
  const discovery = draft.state.readModel.discovery;
  const matchesJobReference = (value: string | null | undefined) =>
    value === jobKey || Boolean(jobUrl && value === jobUrl);

  discovery.quarantine.entries = discovery.quarantine.entries.filter(
    (entry) =>
      entry.jobKey !== jobKey &&
      entry.jobId !== jobKey &&
      !matchesJobReference(entry.postingUrl),
  );
  discovery.locatorCandidates.candidates =
    discovery.locatorCandidates.candidates.filter(
      (candidate) => !matchesJobReference(candidate.candidateUrl),
    );
  discovery.manualCapture.items = discovery.manualCapture.items.filter(
    (item) => !matchesJobReference(item.originatingUrl),
  );
  for (const preview of Object.values(discovery.sourcePreviews)) {
    preview.leads = preview.leads.filter(
      (lead) => !matchesJobReference(lead.candidateUrl),
    );
  }
  discovery.roleMatchFeedback.suggestions =
    discovery.roleMatchFeedback.suggestions.flatMap((suggestion) => {
      suggestion.evidence = suggestion.evidence.filter(
        (evidence) => evidence.jobKey !== jobKey,
      );
      suggestion.sampleCount = suggestion.evidence.length;
      return suggestion.evidence.length > 0 ? [suggestion] : [];
    });
}

function purgeEvidenceReferences(draft: MutableSnapshot, jobKey: string): void {
  const evidence = draft.state.readModel.evidence;
  for (const entry of evidence.entries) {
    entry.resumeUsages = entry.resumeUsages.filter(
      (usage) => usage.jobKey !== jobKey,
    );
    entry.requirementUsages = entry.requirementUsages.filter(
      (usage) => usage.jobKey !== jobKey,
    );
    entry.coverageUsages = entry.coverageUsages.filter(
      (usage) => usage.jobKey !== jobKey,
    );
    for (const gap of entry.gaps)
      gap.jobRefs = gap.jobRefs.filter((usage) => usage.jobKey !== jobKey);
    const latestUsage = [
      ...entry.resumeUsages,
      ...entry.requirementUsages,
      ...entry.coverageUsages,
    ]
      .map((usage) => usage.occurredAt)
      .filter((occurredAt): occurredAt is string => Boolean(occurredAt))
      .sort()
      .at(-1);
    entry.freshness.lastUsedAt = latestUsage ?? null;
  }
  for (const gap of evidence.gaps)
    gap.jobRefs = gap.jobRefs.filter((usage) => usage.jobKey !== jobKey);
}

function purgeDashboardReferences(
  draft: MutableSnapshot,
  jobKey: string,
  removedRunIds: ReadonlySet<string>,
): void {
  const dashboard = draft.state.readModel.dashboard;
  dashboard.summary.activity = dashboard.summary.activity.filter(
    (event) => event.jobKey !== jobKey,
  );
  dashboard.activity.items = dashboard.activity.items.filter(
    (event) => event.jobKey !== jobKey,
  );
  for (const [eventId, response] of Object.entries(dashboard.activityEvents)) {
    if (response.event.jobKey === jobKey)
      delete dashboard.activityEvents[eventId];
  }
  dashboard.summary.work.stuckItems = dashboard.summary.work.stuckItems.filter(
    (item) => item.jobKey !== jobKey,
  );
  dashboard.summary.progress = dashboard.summary.progress.filter(
    (progress) =>
      !removedRunIds.has(progress.runId ?? "") &&
      !removedRunIds.has(progress.workflowId ?? ""),
  );
  dashboard.summary.applyRuns = dashboard.summary.applyRuns.filter(
    (run) => run.jobKey !== jobKey && !removedRunIds.has(run.runId),
  );
  for (const source of dashboard.summary.sourceHealth) {
    if (source.lastRunId && removedRunIds.has(source.lastRunId))
      source.lastRunId = null;
  }
  for (const source of draft.state.readModel.discovery.sources.sources) {
    if (source.lastRunId && removedRunIds.has(source.lastRunId))
      source.lastRunId = null;
  }
  syncPagination(dashboard.activity);
}

function purgeContactReferences(draft: MutableSnapshot, jobKey: string): void {
  const contacts = draft.state.readModel.contacts;
  const removedContactIds = new Set<string>();

  for (const [contactId, response] of Object.entries(contacts.details)) {
    if (response.contact.jobId !== jobKey) continue;
    if (response.contact.employer) response.contact.jobId = null;
    else {
      removedContactIds.add(contactId);
      delete contacts.details[contactId];
    }
  }
  contacts.list.items = contacts.list.items.flatMap((contact) => {
    if (removedContactIds.has(contact.contactId)) return [];
    if (contact.jobId === jobKey) {
      const detail = contacts.details[contact.contactId]?.contact;
      if (!(detail?.employer ?? contact.employer)) {
        removedContactIds.add(contact.contactId);
        delete contacts.details[contact.contactId];
        return [];
      }
      contact.jobId = null;
      if (detail) detail.jobId = null;
    }
    return [contact];
  });

  const removedTaskIds = new Set<string>();
  for (const [taskId, response] of Object.entries(
    contacts.researchTaskDetails,
  )) {
    if (response.task.jobId !== jobKey) continue;
    if (response.task.employer) response.task.jobId = null;
    else {
      removedTaskIds.add(taskId);
      delete contacts.researchTaskDetails[taskId];
    }
  }
  contacts.researchTasks.items = contacts.researchTasks.items.flatMap(
    (task) => {
      if (removedTaskIds.has(task.taskId)) return [];
      if (task.jobId === jobKey) {
        const detail = contacts.researchTaskDetails[task.taskId]?.task;
        if (!(detail?.employer ?? task.employer)) {
          removedTaskIds.add(task.taskId);
          delete contacts.researchTaskDetails[task.taskId];
          return [];
        }
        task.jobId = null;
        if (detail) detail.jobId = null;
      }
      return [task];
    },
  );

  for (const response of Object.values(contacts.researchTaskDetails)) {
    for (const candidate of response.task.candidates) {
      if (
        !candidate.confirmedContactId ||
        !removedContactIds.has(candidate.confirmedContactId)
      )
        continue;
      candidate.confirmedContactId = null;
      candidate.confirmedAt = null;
      if (candidate.status === "confirmed") candidate.status = "needs_review";
    }
    recomputeResearchTaskCounts(response.task);
    const summary = contacts.researchTasks.items.find(
      (item) => item.taskId === response.task.taskId,
    );
    if (summary) copyResearchTaskCounts(summary, response.task);
  }

  const outreach = draft.state.readModel.outreach;
  if (outreach.thread.thread) {
    if (removedContactIds.has(outreach.thread.thread.contactId))
      outreach.thread.thread = null;
    else if (outreach.thread.thread.jobId === jobKey)
      outreach.thread.thread.jobId = null;
  }
  outreach.dueFollowUps.followUps = outreach.dueFollowUps.followUps.flatMap(
    (followUp) => {
      if (removedContactIds.has(followUp.contactId)) return [];
      if (followUp.jobId === jobKey) followUp.jobId = null;
      return [followUp];
    },
  );
}

function recomputeResearchTaskCounts(
  task: MutableSnapshot["state"]["readModel"]["contacts"]["researchTaskDetails"][string]["task"],
): void {
  task.candidateCount = task.candidates.length;
  task.needsReviewCount = task.candidates.filter(
    (candidate) => candidate.status === "needs_review",
  ).length;
  task.confirmedCount = task.candidates.filter(
    (candidate) => candidate.status === "confirmed",
  ).length;
}

function copyResearchTaskCounts(
  summary: MutableSnapshot["state"]["readModel"]["contacts"]["researchTasks"]["items"][number],
  detail: MutableSnapshot["state"]["readModel"]["contacts"]["researchTaskDetails"][string]["task"],
): void {
  summary.candidateCount = detail.candidateCount;
  summary.needsReviewCount = detail.needsReviewCount;
  summary.confirmedCount = detail.confirmedCount;
}

function purgeRouteReferences(
  draft: MutableSnapshot,
  jobKey: string,
  jobUrl: string | null,
): void {
  for (const route of Object.keys(draft.state.routeData) as Array<
    keyof MutableSnapshot["state"]["routeData"]
  >) {
    draft.state.routeData[route] = draft.state.routeData[route].filter(
      (record) => record.id !== jobKey && record.id !== jobUrl,
    );
  }
}

function recomputeAnalytics(draft: MutableSnapshot): void {
  const model = draft.state.readModel;
  const jobs = activeDemoJobs(draft);
  const outcomesByJob = new Map<
    string,
    typeof model.analytics.outcomes.outcomes
  >();
  for (const outcome of model.analytics.outcomes.outcomes) {
    const values = outcomesByJob.get(outcome.jobKey) ?? [];
    values.push(outcome);
    outcomesByJob.set(outcome.jobKey, values);
  }
  const appliedJobs = jobs.filter(
    (job) =>
      job.applyStatus === "applied" ||
      Boolean(job.appliedAt) ||
      outcomesByJob.has(job.jobKey),
  );
  const minSample = model.analytics.summary.minSample;
  const funnelFor = (selected: readonly DemoJob[]) =>
    buildAnalyticsFunnel(selected, outcomesByJob, minSample);

  const bySource = groupJobs(appliedJobs, (job) => job.source || "unknown");
  const byScoreBand = groupJobs(appliedJobs, (job) => scoreBand(job.fitScore));
  const byFitBand = groupJobs(appliedJobs, (job) =>
    fitBand(job.scoreBreakdown?.fitBand),
  );

  const priorApplyMode =
    model.analytics.summary.byApplyMode[0]?.applyMode ?? "manual_marked";
  const priorTemplate = model.analytics.summary.byTemplate[0] ?? {
    templateId: "unreported",
    templateName: null,
  };
  const priorPolicy = model.analytics.summary.byPolicy[0] ?? {
    tailoringPolicyVersion: null,
    policyLabel: "Unreported",
  };

  model.analytics.summary.totals = funnelFor(appliedJobs);
  model.analytics.summary.bySource = [...bySource].map(
    ([source, selected]) => ({ source, ...funnelFor(selected) }),
  );
  model.analytics.summary.byScoreBand = [...byScoreBand].map(
    ([band, selected]) => ({ scoreBand: band, ...funnelFor(selected) }),
  );
  model.analytics.summary.byFitBand = [...byFitBand].map(
    ([band, selected]) => ({ fitBand: band, ...funnelFor(selected) }),
  );
  model.analytics.summary.byApplyMode =
    appliedJobs.length > 0
      ? [{ applyMode: priorApplyMode, ...funnelFor(appliedJobs) }]
      : [];
  model.analytics.summary.byTemplate =
    appliedJobs.length > 0
      ? [
          {
            templateId: priorTemplate.templateId,
            templateName: priorTemplate.templateName,
            ...funnelFor(appliedJobs),
          },
        ]
      : [];
  model.analytics.summary.byPolicy =
    appliedJobs.length > 0
      ? [
          {
            tailoringPolicyVersion: priorPolicy.tailoringPolicyVersion,
            policyLabel: priorPolicy.policyLabel,
            ...funnelFor(appliedJobs),
          },
        ]
      : [];

  const decided = model.analytics.outcomes.suggestions.filter(
    (suggestion) =>
      suggestion.status === "accepted" ||
      suggestion.status === "corrected" ||
      suggestion.status === "ignored",
  );
  const accepted = decided.filter(
    (suggestion) => suggestion.status === "accepted",
  ).length;
  const corrected = decided.filter(
    (suggestion) => suggestion.status === "corrected",
  ).length;
  const ignored = decided.filter(
    (suggestion) => suggestion.status === "ignored",
  ).length;
  model.analytics.summary.suggestionAccuracy = {
    n: decided.length,
    decided: decided.length,
    accepted,
    corrected,
    ignored,
    acceptanceRate: rate(accepted, decided.length, minSample),
  };

  const responseMinutes = appliedJobs.flatMap((job) => {
    const appliedAt = Date.parse(job.appliedAt ?? "");
    if (!Number.isFinite(appliedAt)) return [];
    const responses = (outcomesByJob.get(job.jobKey) ?? [])
      .filter((outcome) => REPLY_OUTCOMES.has(outcome.kind))
      .map((outcome) => Date.parse(outcome.occurredAt))
      .filter(
        (occurredAt) => Number.isFinite(occurredAt) && occurredAt >= appliedAt,
      )
      .sort((left, right) => left - right);
    return responses[0] === undefined
      ? []
      : [Math.round((responses[0] - appliedAt) / 60_000)];
  });
  model.analytics.summary.timeToResponse = {
    n: responseMinutes.length,
    medianMinutes:
      responseMinutes.length >= minSample ? median(responseMinutes) : null,
  };
}

function activeDemoJobs(draft: MutableSnapshot): DemoJob[] {
  return draft.state.readModel.jobs.list.items.filter(
    (job) =>
      !job.deletedAt &&
      !job.hiddenAt &&
      job.activeState !== "closed" &&
      job.activeState !== "expired" &&
      job.activeState !== "removed" &&
      job.activeState !== "location_incompatible",
  );
}

function buildAnalyticsFunnel(
  jobs: readonly DemoJob[],
  outcomesByJob: ReadonlyMap<string, readonly { kind: string }[]>,
  minSample: number,
): AnalyticsFunnel {
  const counts: ConversionCounts = {
    applied: jobs.length,
    reply: 0,
    interview: 0,
    offer: 0,
    rejection: 0,
  };
  for (const job of jobs) {
    const kinds = new Set(
      (outcomesByJob.get(job.jobKey) ?? []).map((outcome) => outcome.kind),
    );
    if (hasAny(kinds, REPLY_OUTCOMES)) counts.reply += 1;
    if (hasAny(kinds, INTERVIEW_OUTCOMES)) counts.interview += 1;
    if (hasAny(kinds, OFFER_OUTCOMES)) counts.offer += 1;
    if (hasAny(kinds, REJECTION_OUTCOMES)) counts.rejection += 1;
  }
  return {
    n: counts.applied,
    ...counts,
    replyRate: rate(counts.reply, counts.applied, minSample),
    interviewRate: rate(counts.interview, counts.applied, minSample),
    offerRate: rate(counts.offer, counts.applied, minSample),
    rejectionRate: rate(counts.rejection, counts.applied, minSample),
  };
}

function groupJobs<TKey>(
  jobs: readonly DemoJob[],
  keyFor: (job: DemoJob) => TKey,
): Map<TKey, DemoJob[]> {
  const groups = new Map<TKey, DemoJob[]>();
  for (const job of jobs) {
    const key = keyFor(job);
    const group = groups.get(key) ?? [];
    group.push(job);
    groups.set(key, group);
  }
  return groups;
}

function scoreBand(
  score: number | null,
): OutcomeAnalyticsSummary["byScoreBand"][number]["scoreBand"] {
  if (score === null) return "unscored";
  if (score >= 9) return "perfect";
  if (score >= 7) return "strong";
  if (score >= 5) return "moderate";
  if (score >= 3) return "weak";
  return "poor";
}

function fitBand(
  value: string | undefined,
): OutcomeAnalyticsSummary["byFitBand"][number]["fitBand"] {
  return value === "excellent" ||
    value === "strong" ||
    value === "plausible" ||
    value === "stretch" ||
    value === "poor"
    ? value
    : "unreported";
}

function hasAny(
  values: ReadonlySet<string>,
  targets: ReadonlySet<string>,
): boolean {
  for (const value of values) if (targets.has(value)) return true;
  return false;
}

function recomputeDashboard(draft: MutableSnapshot): void {
  const model = draft.state.readModel;
  const summary = model.dashboard.summary;
  const jobs = activeDemoJobs(draft);
  const activeJobKeys = new Set(jobs.map((job) => job.jobKey));
  const actionableJobKeys = new Set(
    jobs
      .filter(
        (job) =>
          job.currentState !== "canceled" && job.currentState !== "skipped",
      )
      .map((job) => job.jobKey),
  );
  const generatedDay = summary.generatedAt.slice(0, 10);
  const outcomeJobKeys = new Set(
    model.analytics.outcomes.outcomes.map((outcome) => outcome.jobKey),
  );
  const applyQueueByJob = new Map(
    model.apply.queue.items.map((item) => [item.jobKey, item]),
  );

  summary.totals.jobs = jobs.length;
  summary.totals.jobsToday = jobs.filter((job) =>
    job.discoveredAt?.startsWith(generatedDay),
  ).length;
  summary.totals.failures = jobs.filter(
    (job) => job.currentState === "failed",
  ).length;
  summary.totals.blocked = jobs.filter(
    (job) => job.currentState === "blocked",
  ).length;
  summary.totals.ready = jobs.filter((job) => {
    const queueItem = applyQueueByJob.get(job.jobKey);
    return (
      job.currentStage === "apply" &&
      job.currentState === "pending" &&
      queueItem?.materials.hasResume === true
    );
  }).length;
  summary.totals.applied = jobs.filter(
    (job) =>
      job.applyStatus === "applied" ||
      Boolean(job.appliedAt) ||
      outcomeJobKeys.has(job.jobKey),
  ).length;
  summary.totals.appliedToday = jobs.filter((job) =>
    job.appliedAt?.startsWith(generatedDay),
  ).length;
  summary.applyRuns = summary.applyRuns.filter((run) =>
    activeJobKeys.has(run.jobKey),
  );
  summary.totals.dryRuns = summary.applyRuns.filter((run) => run.dryRun).length;

  const runDetails = model.runs.details;
  summary.progress = summary.progress.filter((progress) => {
    const runId = progress.runId ?? progress.workflowId;
    if (!runId) return true;
    const run = runDetails[runId];
    if (!run) return true;
    return (
      activeJobKeys.has(run.jobKey) &&
      actionableJobKeys.has(run.jobKey) &&
      (run.status === "in_progress" || run.status === "starting")
    );
  });

  summary.work.stuckItems = summary.work.stuckItems.filter((item) => {
    const job = jobs.find((candidate) => candidate.jobKey === item.jobKey);
    return job?.currentState === "running";
  });
  const stuckJobKeys = new Set(
    summary.work.stuckItems.map((item) => item.jobKey),
  );
  summary.work.active = jobs.filter(
    (job) =>
      (job.currentState === "queued" || job.currentState === "running") &&
      !stuckJobKeys.has(job.jobKey),
  ).length;
  summary.work.stuck = summary.work.stuckItems.length;
  if (summary.preparation) {
    summary.preparation.outdatedScoreCount = jobs.filter(
      (job) => job.scoreStaleness.isStale,
    ).length;
    summary.preparation.outdatedTailoredArtifactCount = jobs.filter(
      (job) => job.resumeTemplate?.state === "template_stale",
    ).length;
    const preparationRuns = model.runs.list.items.filter(
      (run) =>
        activeJobKeys.has(run.jobKey) && actionableJobKeys.has(run.jobKey),
    );
    summary.preparation.workItems = {
      queued: preparationRuns.filter((run) => run.status === "starting").length,
      running: preparationRuns.filter((run) => run.status === "in_progress")
        .length,
      failed: preparationRuns.filter((run) => run.status === "failed").length,
    };
  }

  summary.funnel = summary.funnel.map((stage) => {
    const stageStates = jobs.flatMap(
      (job) =>
        model.jobs.details[job.jobKey]?.stages.filter(
          (candidate) => candidate.stage === stage.stage,
        ) ?? [],
    );
    // Skipped/canceled work has no representable funnel bucket. Excluding it
    // is truthful; treating either terminal state as pending would resurrect
    // work after the user explicitly ended it.
    const represented = stageStates.filter(
      (candidate) =>
        candidate.state !== "skipped" && candidate.state !== "canceled",
    );
    return {
      ...stage,
      total: represented.length,
      succeeded: represented.filter(
        (candidate) => candidate.state === "succeeded",
      ).length,
      running: represented.filter(
        (candidate) =>
          candidate.state === "running" || candidate.state === "queued",
      ).length,
      pending: represented.filter(
        (candidate) =>
          candidate.state === "pending" ||
          candidate.state === "needs_verification" ||
          candidate.state === "stale",
      ).length,
      blocked: represented.filter((candidate) => candidate.state === "blocked")
        .length,
      failed: represented.filter(
        (candidate) =>
          candidate.state === "failed" || candidate.state === "exhausted",
      ).length,
    };
  });

  const analytics = model.analytics.summary;
  summary.conversion = {
    totals: dashboardFunnel(analytics.totals),
    bySource: analytics.bySource.map(({ source, ...funnel }) => ({
      source,
      ...dashboardFunnel(funnel),
    })),
    byBand: analytics.byScoreBand.map(({ scoreBand, ...funnel }) => ({
      band: scoreBand,
      ...dashboardFunnel(funnel),
    })),
  };
}

function dashboardFunnel(funnel: AnalyticsFunnel) {
  return {
    applied: funnel.applied,
    reply: funnel.reply,
    interview: funnel.interview,
    offer: funnel.offer,
    rejection: funnel.rejection,
    replyRate: funnel.replyRate,
    interviewRate: funnel.interviewRate,
    offerRate: funnel.offerRate,
    rejectionRate: funnel.rejectionRate,
    costPerInterview: null,
  };
}

function recomputeDigest(draft: MutableSnapshot): void {
  const model = draft.state.readModel;
  const digest = model.dashboard.digest;
  const activeJobs = activeDemoJobs(draft);
  const activeJobsByKey = new Map(activeJobs.map((job) => [job.jobKey, job]));
  digest.highFitThreshold = model.settings.settings.minFitScore;
  const since = digest.since
    ? Date.parse(digest.since)
    : Number.NEGATIVE_INFINITY;
  const newMatches = activeJobs.filter((job) => {
    const discoveredAt = Date.parse(job.discoveredAt ?? "");
    const scoredAt = Date.parse(job.scoredAt ?? "");
    return discoveredAt >= since || scoredAt >= since;
  });
  digest.newMatches = {
    count: newMatches.length,
    highFitCount: newMatches.filter(
      (job) => (job.fitScore ?? -1) >= digest.highFitThreshold,
    ).length,
  };
  digest.blockedSources = {
    count: model.dashboard.summary.sourceHealth.filter(
      (source) =>
        source.recommendedState === "quarantined" ||
        source.recommendedState === "disabled" ||
        source.consecutiveFailures >= 3,
    ).length,
    sources: model.dashboard.summary.sourceHealth
      .filter(
        (source) =>
          source.recommendedState === "quarantined" ||
          source.recommendedState === "disabled" ||
          source.consecutiveFailures >= 3,
      )
      .map((source) => ({
        sourceId: source.sourceId,
        recommendedState: source.recommendedState,
        consecutiveFailures: source.consecutiveFailures,
      })),
  };
  digest.reviewNeededMaterials.count = model.apply.queue.items.filter(
    (item) => {
      const job = activeJobsByKey.get(item.jobKey);
      return (
        Boolean(job) &&
        job?.currentState !== "canceled" &&
        job?.currentState !== "skipped" &&
        (item.materials.hasResume ||
          item.materials.hasCoverLetter ||
          item.materials.hasPdf) &&
        !item.materials.ready
      );
    },
  ).length;
  digest.staleScores.count = activeJobs.filter(
    (job) => job.scoreStaleness.isStale,
  ).length;
  digest.pendingApprovals.count = model.apply.queue.items.filter((item) => {
    const job = activeJobsByKey.get(item.jobKey);
    return (
      Boolean(job) &&
      job?.currentState !== "canceled" &&
      job?.currentState !== "skipped" &&
      item.currentState === "pending" &&
      item.review.state === "pending"
    );
  }).length;
  digest.followUpsDue.count = model.outreach.dueFollowUps.followUps.filter(
    (followUp) =>
      followUp.state === "scheduled" &&
      (followUp.jobId === null || activeJobsByKey.has(followUp.jobId)),
  ).length;
}

function syncPagination(value: {
  items: readonly unknown[];
  pagination: { page: number; pageSize: number; total: number; pages: number };
}): void {
  value.pagination.total = value.items.length;
  value.pagination.pages =
    value.items.length === 0
      ? 0
      : Math.ceil(value.items.length / value.pagination.pageSize);
  value.pagination.page =
    value.pagination.pages === 0
      ? 1
      : Math.min(value.pagination.page, value.pagination.pages);
}

function rate(
  numerator: number,
  denominator: number,
  minSample: number,
): number | null {
  if (denominator < minSample || denominator === 0) return null;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
