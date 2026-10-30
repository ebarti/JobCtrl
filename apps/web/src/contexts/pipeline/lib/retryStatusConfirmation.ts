import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import { useToastStore } from "../../../shared/stores/toasts.js";

export function retryStatusScope(tenantId: string, jobId: string, detailQueryId: string = jobId): string {
  return `retry-stage:${JSON.stringify([tenantId, jobId, detailQueryId])}`;
}

export function detailMatchesRetryJob(value: unknown, jobId: string): boolean {
  if (typeof value !== "object" || value === null || !("job" in value)) return false;
  const job = value.job;
  return typeof job === "object" && job !== null && "jobKey" in job && job.jobKey === jobId;
}

export interface RetryConfirmationInFlight {
  readonly query: Query;
  readonly promise: Promise<unknown>;
}

export function observeRetryDetailConfirmation(queryClient: QueryClient, queryKey: QueryKey, noticeId: string,
  jobId: string, eligibleInFlight?: RetryConfirmationInFlight, onDismiss?: () => void): void {
  const cache = queryClient.getQueryCache();
  // Observe the query, not a particular view: another subscriber can perform
  // the confirming read. A fetch already underway when the notice was created
  // is deliberately absent from this set.
  const startedAfterNotice = new WeakSet<Query>();
  // A deferred notice can inherit a read proven to have replaced the earlier
  // promise captured at settlement, even when that read started before the
  // notice could be created.
  if (eligibleInFlight && cache.find({ queryKey, exact: true }) === eligibleInFlight.query &&
      eligibleInFlight.query.state.fetchStatus !== "idle" && eligibleInFlight.query.promise === eligibleInFlight.promise) {
    startedAfterNotice.add(eligibleInFlight.query);
  }
  const unsubscribeQuery = cache.subscribe((event) => {
    if (event.type !== "updated" || cache.find({ queryKey, exact: true }) !== event.query) return;
    if (event.action.type === "fetch") startedAfterNotice.add(event.query);
    if (event.action.type === "success" && !event.action.manual && startedAfterNotice.has(event.query) &&
        detailMatchesRetryJob(event.query.state.data, jobId)) {
      useToastStore.getState().dismiss(noticeId);
    }
  });
  const unsubscribeToast = useToastStore.subscribe((state) => {
    if (state.toasts.some((entry) => entry.id === noticeId)) return;
    // Keep listening across navigation, but only for the notice's lifetime.
    unsubscribeQuery();
    unsubscribeToast();
    onDismiss?.();
  });
}

export async function confirmRetryDetail(queryClient: QueryClient, queryKey: QueryKey, noticeId: string,
  jobId: string, signal: AbortSignal): Promise<void> {
  const isCurrent = () => !signal.aborted && useToastStore.getState().toasts.some((entry) => entry.id === noticeId);
  // A read already in flight may have started before the reset committed.
  // Let it settle before starting a distinct confirmation read.
  while (isCurrent()) {
    const query = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (!query || !query.isActive()) return;
    if (query.state.fetchStatus !== "idle") {
      const pending = query.promise;
      if (!pending) return;
      await new Promise<void>((resolve) => {
        const finish = () => {
          signal.removeEventListener("abort", finish);
          resolve();
        };
        signal.addEventListener("abort", finish, { once: true });
        void pending.then(finish, finish);
      });
      continue;
    }
    if (!isCurrent()) return;
    const revision = query.state.dataUpdateCount;
    try {
      await queryClient.invalidateQueries({ queryKey, exact: true }, { throwOnError: true });
    } catch {
      return;
    }
    if (isCurrent() && queryClient.getQueryCache().find({ queryKey, exact: true }) === query &&
        query.state.status === "success" && query.state.dataUpdateCount > revision &&
        detailMatchesRetryJob(query.state.data, jobId)) {
      useToastStore.getState().dismiss(noticeId);
    }
    return;
  }
}
