import type { DomainEventUnion } from "@jobctrl/domain-types";

import type { DemoWorkspaceSnapshot } from "./contracts.js";

/** Older clients do not maintain these fields. A mismatched checkpoint means
 * an older client or unfamiliar writer committed since the last known state. */
export function hasCurrentLifecycleTracking(snapshot: DemoWorkspaceSnapshot): boolean {
  const revisions = snapshot.jobLifecycleRevisions;
  return revisions !== null && typeof revisions === "object" && !Array.isArray(revisions)
    && snapshot.lifecycleRevisionCheckpoint === snapshot.revision
    && Number.isSafeInteger(snapshot.lifecycleRevisionFloor)
    && (snapshot.lifecycleRevisionFloor ?? -1) >= 0
    && (snapshot.lifecycleRevisionFloor ?? Infinity) <= snapshot.revision
    && Object.values(revisions).every((value) => Number.isSafeInteger(value) && value >= 0);
}

export function captureLifecycleRevisions(snapshot: DemoWorkspaceSnapshot, jobKeys: readonly string[]): Map<string, number> {
  const revisions = hasCurrentLifecycleTracking(snapshot) ? snapshot.jobLifecycleRevisions : undefined;
  return new Map(jobKeys.map((jobKey) => [jobKey, revisions?.[jobKey] ?? 0]));
}

export function changedLifecycleJobs(
  snapshot: DemoWorkspaceSnapshot,
  observedRevision: number,
  observedJobRevisions: ReadonlyMap<string, number>,
  jobKeys: readonly string[],
): string[] | null {
  // A legacy/unfamiliar writer can make every per-job revision untrustworthy.
  if (!hasCurrentLifecycleTracking(snapshot)) return snapshot.revision === observedRevision ? [] : null;
  if (observedRevision < snapshot.lifecycleRevisionFloor!) return null;
  return jobKeys.filter((jobKey) => observedJobRevisions.get(jobKey) !== (snapshot.jobLifecycleRevisions?.[jobKey] ?? 0));
}

/** Advance in the same IndexedDB transaction as the actual mutation. A new
 * tracking floor after legacy writes conservatively rejects older receipts. */
export function advanceLifecycleRevisions(
  current: DemoWorkspaceSnapshot,
  draft: DemoWorkspaceSnapshot,
  events: readonly DomainEventUnion[],
  revision: number,
): Pick<DemoWorkspaceSnapshot, "jobLifecycleRevisions" | "lifecycleRevisionFloor" | "lifecycleRevisionCheckpoint"> {
  const continuous = hasCurrentLifecycleTracking(current);
  const versions: Record<string, number> = continuous ? { ...current.jobLifecycleRevisions } : {};
  const changed = new Set<string>();
  const before = current.state.readModel.jobs.details;
  const after = draft.state.readModel.jobs.details;
  for (const jobKey of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const oldJob = before[jobKey]?.job;
    const newJob = after[jobKey]?.job;
    if (!oldJob || !newJob || oldJob.deletedAt !== newJob.deletedAt || oldJob.hiddenAt !== newJob.hiddenAt) {
      changed.add(jobKey);
    }
  }
  for (const event of events) {
    if (event.eventType === "JobDeleted" || event.eventType === "JobRestored"
      || event.eventType === "JobHidden" || event.eventType === "JobUnhidden") {
      changed.add(event.payload.jobId);
    }
  }
  for (const jobKey of changed) versions[jobKey] = (versions[jobKey] ?? 0) + 1;
  return {
    jobLifecycleRevisions: versions,
    lifecycleRevisionFloor: continuous ? current.lifecycleRevisionFloor! : current.revision,
    lifecycleRevisionCheckpoint: revision,
  };
}
