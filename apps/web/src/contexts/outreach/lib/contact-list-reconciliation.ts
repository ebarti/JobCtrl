import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";

import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";

interface PendingInitialRead {
  readonly promise: Promise<unknown>;
  dispose: () => void;
}

// One follow-up per query/promise, regardless of how many writes settle while
// its first read is still pending. Query eviction removes the subscription.
const pendingInitialReads = new WeakMap<Query, PendingInitialRead>();

export function reconcileContactListsAfterInitialReads(client: QueryClient, prefix: QueryKey): void {
  const cache = client.getQueryCache();
  for (const query of cache.findAll({ queryKey: prefix })) {
    const read = query.promise;
    if (query.state.data !== undefined || query.state.fetchStatus === "idle" || !read) continue;
    if (pendingInitialReads.get(query)?.promise === read) continue;
    pendingInitialReads.get(query)?.dispose();
    const originalCount = query.state.dataUpdateCount;
    const pending: PendingInitialRead = { promise: read, dispose: () => {} };
    let newerPublication = false;
    const unsubscribe = cache.subscribe((event) => {
      if (event.query !== query) return;
      if (event.type === "removed" || (event.type === "updated" &&
          (event.action.type === "setState" || event.action.type === "fetch"))) {
        pending.dispose();
      } else if (event.type === "updated" && event.action.type === "success" && event.action.manual) {
        newerPublication = true;
      }
    });
    pending.dispose = () => {
      unsubscribe();
      if (pendingInitialReads.get(query) === pending) pendingInitialReads.delete(query);
    };
    pendingInitialReads.set(query, pending);
    const afterRead = () => {
      if (pendingInitialReads.get(query) !== pending) return;
      pending.dispose();
      // A replaced/reset query, a later read, or a further publication takes
      // authority. Otherwise reconcile once, without blocking the mutation.
      if (newerPublication || cache.get(query.queryHash) !== query || (query.promise !== undefined && query.promise !== read) ||
          query.state.fetchStatus !== "idle" || query.state.dataUpdateCount > originalCount + 1) return;
      void invalidateQueriesWithOptimisticOwnership(client, query.queryKey, true);
    };
    void read.then(afterRead, afterRead);
  }
}
