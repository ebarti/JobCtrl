import { focusManager, type Query, type QueryClient, type QueryKey } from "@tanstack/react-query";

import { invalidateQueriesWithOptimisticOwnership } from "./createOptimisticMutation.js";

// A long-running search can commit hundreds of events per second. Keep the UI
// moving during a continuous burst as well as after its last event.
const REFRESH_INTERVAL_MS = 250;

export function createEventQueryInvalidation(client: QueryClient) {
  const cache = client.getQueryCache();
  const dirty = new Set<Query>();
  const waitingForRead = new Set<Query>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;

  function enqueue(query: Query) {
    if (closed || waitingForRead.has(query)) return;
    dirty.add(query);
    if (focusManager.isFocused()) timer ??= setTimeout(flush, REFRESH_INTERVAL_MS);
  }

  function flush() {
    clearTimeout(timer);
    timer = undefined;
    if (!focusManager.isFocused()) return;
    for (const query of Array.from(dirty)) {
      dirty.delete(query);
      if (cache.get(query.queryHash) !== query) continue;
      const read = query.state.fetchStatus !== "idle" && query.promise;
      if (read) {
        // Its response may predate this event. Never cancel a useful read,
        // and issue only one trailing refresh even if more events arrive.
        waitingForRead.add(query);
        const afterRead = () => {
          waitingForRead.delete(query);
          if (cache.get(query.queryHash) === query) enqueue(query);
        };
        void read.then(afterRead, afterRead);
      } else {
        void invalidateQueriesWithOptimisticOwnership(client, query.queryKey, true);
      }
    }
  }

  // Hidden pages keep receiving events and collecting dirty queries. Resume
  // immediately on visibility, while sharing the same in-flight fence.
  const offFocus = focusManager.subscribe((focused) => { if (focused && dirty.size) flush(); });
  return {
    invalidate(key: QueryKey) {
      for (const query of cache.findAll({ queryKey: key })) {
        query.invalidate();
        enqueue(query);
      }
    },
    close() {
      closed = true;
      clearTimeout(timer);
      offFocus();
      dirty.clear();
      waitingForRead.clear();
    },
  };
}
