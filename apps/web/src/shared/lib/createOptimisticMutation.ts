import {
  type Query,
  type QueryClient,
  type QueryKey,
  type SetDataOptions,
  type UseMutationOptions,
} from "@tanstack/react-query";

export interface OptimisticPatchSpec<TVariables> {
  readonly queryKey: QueryKey;
  readonly patch: (previous: unknown, variables: TVariables, queryKey: QueryKey) => unknown;
  // Return false only when the operation is provably irrelevant to this query.
  readonly isRelevant?: (previous: unknown, variables: TVariables, queryKey: QueryKey) => boolean;
  // Optional caller-owned identity for a partial-publication fence.
  readonly publicationTag?: unknown;
  readonly exact?: boolean;
  // Allow prefix cancellation while keeping the patch itself exact.
  readonly cancelExact?: boolean;
}

export interface OptimisticMutationConfig<TData, TVariables> {
  readonly mutationKey?: QueryKey;
  readonly mutationFn: (variables: TVariables) => Promise<TData>;
  readonly optimisticUpdates?: (variables: TVariables) => readonly OptimisticPatchSpec<TVariables>[];
  readonly settle?: (variables: TVariables, data: TData | undefined) => readonly QueryKey[];
  readonly meta?: Record<string, unknown>;
}

interface PatchEntry {
  readonly operation: symbol;
  readonly context?: OptimisticContext;
  readonly publicationTag?: unknown;
  readonly apply: (current: unknown) => unknown;
  settled: boolean;
  rebaseMiss?: boolean;
}

interface PartialPatchOptions {
  readonly updatedAt?: number;
  readonly skipUnchanged?: boolean;
  readonly publicationTag?: unknown;
}

interface QueryOwnership {
  readonly client: QueryClient;
  readonly query: Query;
  readonly baseline: unknown;
  readonly entries: PatchEntry[];
  readonly deferredPartials: Array<{ updater: (current: unknown) => unknown; options: PartialPatchOptions }>;
  publishing: boolean;
  drainingPartials: boolean;
  unsubscribe: () => void;
  expectedUpdateCount?: number;
  cancellationState?: { readonly data: unknown; readonly updateCount: number };
  deferredInvalidation?: boolean;
}

export interface OptimisticContext {
  readonly operation: symbol;
  readonly ownerships: Set<QueryOwnership>;
  rollbackAttempted: boolean;
}

// Ownership lasts while related mutations are unsettled. A successful refetch, direct
// cache publication, reset, or removal supersedes every older optimistic patch.
const queryOwnership = new WeakMap<Query, QueryOwnership>();

interface TaggedPublication {
  readonly expectedCount: number;
  readonly tag: unknown;
}

const taggedPublications = new WeakMap<Query, TaggedPublication>();
const retainedReadPublications = new WeakMap<Query, { readonly expectedCount: number; readonly data: unknown }>();
const metadataTransitions = new WeakMap<Query, { readonly data: unknown; readonly count: number }>();

function withTaggedPublication<T>(query: Query, tag: unknown, publishData: () => T): T {
  const previous = taggedPublications.get(query);
  const marker = { expectedCount: query.state.dataUpdateCount + 1, tag };
  taggedPublications.set(query, marker);
  try {
    return publishData();
  } finally {
    if (taggedPublications.get(query) === marker) {
      if (previous) taggedPublications.set(query, previous);
      else taggedPublications.delete(query);
    }
  }
}

/** Mark a read result that retained a later publication at cache-commit time. */
export function retainLaterQueryPublication(client: Pick<QueryClient, "getQueryCache">, query: Query, data: unknown): void {
  const before = query.state;
  const marker = { expectedCount: query.state.dataUpdateCount + 1, data };
  retainedReadPublications.set(query, marker);
  queueMicrotask(() => {
    if (retainedReadPublications.get(query) === marker) retainedReadPublications.delete(query);
    // Keeping a later partial is not a successful full read. Do not let the
    // discarded response clear an existing failed-refresh notice.
    retainRefetchError(client, query, before, queryOwnership.get(query));
  });
}

function isRetainedRead(query: Query, action: { readonly manual?: boolean; readonly data: unknown }): boolean {
  const marker = retainedReadPublications.get(query);
  return !action.manual && marker !== undefined && marker.expectedCount === query.state.dataUpdateCount && action.data === marker.data;
}

export interface OptimisticPublicationSnapshot {
  readonly query: Query;
  readonly isValid: () => boolean;
  readonly dispose: () => void;
}

export function snapshotOptimisticPublication(
  client: QueryClient,
  query: Query,
  independent: (tag: unknown) => boolean,
): OptimisticPublicationSnapshot {
  let valid = true;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.query !== query) return;
    if (event.type === "removed") {
      valid = false;
      unsubscribe();
    } else if (event.type === "updated") {
      if (event.action.type === "success") {
        if (isRetainedRead(query, event.action)) return;
        const marker = taggedPublications.get(query);
        if (!marker || marker.expectedCount !== query.state.dataUpdateCount || !independent(marker.tag)) valid = false;
      } else if (event.action.type === "setState") {
        const marker = metadataTransitions.get(query);
        if (!marker || marker.data !== query.state.data || marker.count !== query.state.dataUpdateCount) valid = false;
      }
    }
  });
  return { query, isValid: () => valid, dispose: unsubscribe };
}

/** Accept only explicitly identified partials, never an intervening full publication. */
export function publicationUnchangedExcept(snapshot: OptimisticPublicationSnapshot): boolean {
  // Fetch/error metadata does not publish data. A response may merge while a
  // read is pending; the read owner fences that earlier read at commit time.
  return snapshot.isValid();
}

function release(ownership: QueryOwnership, reconcile = false): void {
  if (queryOwnership.get(ownership.query) === ownership) {
    queryOwnership.delete(ownership.query);
    for (const entry of ownership.entries) entry.context?.ownerships.delete(ownership);
    ownership.entries.length = 0;
    ownership.deferredPartials.length = 0;
    ownership.unsubscribe();
    const deferred = ownership.deferredInvalidation;
    delete ownership.deferredInvalidation;
    if (deferred && reconcile) void ownership.client.invalidateQueries({ queryKey: ownership.query.queryKey, exact: true });
  }
}

function ownershipFor(client: QueryClient, query: Query): QueryOwnership {
  const existing = queryOwnership.get(query);
  if (existing) return existing;

  const ownership: QueryOwnership = {
    client,
    query,
    baseline: query.state.data,
    entries: [],
    deferredPartials: [],
    publishing: false,
    drainingPartials: false,
    unsubscribe: () => {},
  };
  queryOwnership.set(query, ownership);
  ownership.unsubscribe = client.getQueryCache().subscribe((event) => {
    if (event.query !== query) return;
    if (event.type === "removed") {
      release(ownership);
    } else if (event.type === "updated") {
      if (event.action.type === "success") {
        // An external publication can happen reentrantly in another cache
        // subscriber, so identify our one expected update, not a broad flag.
        if (query.state.dataUpdateCount === ownership.expectedUpdateCount) {
          delete ownership.expectedUpdateCount;
        } else if (isRetainedRead(query, event.action)) {
          // The read started before a newer local publication and was not allowed to replace it.
        } else {
          release(ownership);
        }
      } else if (event.action.type === "setState") {
        const cancelled = ownership.cancellationState;
        if (!cancelled || query.state.data !== cancelled.data ||
            query.state.dataUpdateCount !== cancelled.updateCount) {
          release(ownership);
        }
      }
    }
  });
  return ownership;
}

// A local publication or cancellation is not a successful read. Preserve an
// earlier failed-refresh status while this transition still owns the data.
function retainRefetchError(
  client: Pick<QueryClient, "getQueryCache">,
  query: Query,
  before: Query["state"],
  ownership: QueryOwnership | undefined,
  expectedUpdateCount = before.dataUpdateCount + 1,
): void {
  if (before.status !== "error" || before.data === undefined ||
      client.getQueryCache().get(query.queryHash) !== query || queryOwnership.get(query) !== ownership ||
      query.state.dataUpdateCount !== expectedUpdateCount || query.state.status !== "success") return;
  const previousCancellation = ownership?.cancellationState;
  if (ownership) ownership.cancellationState = { data: query.state.data, updateCount: query.state.dataUpdateCount };
  const previousTransition = metadataTransitions.get(query);
  const transition = { data: query.state.data, count: query.state.dataUpdateCount };
  metadataTransitions.set(query, transition);
  try {
    query.setState({
      status: "error",
      error: before.error,
      errorUpdatedAt: before.errorUpdatedAt,
      errorUpdateCount: before.errorUpdateCount,
      fetchFailureCount: before.fetchFailureCount,
      fetchFailureReason: before.fetchFailureReason,
      isInvalidated: before.isInvalidated,
    });
  } finally {
    if (metadataTransitions.get(query) === transition) {
      if (previousTransition) metadataTransitions.set(query, previousTransition);
      else metadataTransitions.delete(query);
    }
    if (ownership) {
      if (previousCancellation) ownership.cancellationState = previousCancellation;
      else delete ownership.cancellationState;
    }
  }
}

function publish(ownership: QueryOwnership, data: unknown, options?: SetDataOptions, publicationTag?: unknown): void {
  if (queryOwnership.get(ownership.query) !== ownership) return;
  const before = ownership.query.state;
  ownership.expectedUpdateCount = ownership.query.state.dataUpdateCount + 1;
  ownership.publishing = true;
  try {
    const updater = () => data;
    withTaggedPublication(ownership.query, publicationTag, () => {
      if (options) ownership.client.setQueryData(ownership.query.queryKey, updater, options);
      else ownership.client.setQueryData(ownership.query.queryKey, updater);
    });
    retainRefetchError(ownership.client, ownership.query, before, ownership);
  } finally {
    ownership.publishing = false;
    delete ownership.expectedUpdateCount;
    if (!ownership.drainingPartials) {
      ownership.drainingPartials = true;
      try {
        let rebaseMiss = false;
        while (queryOwnership.get(ownership.query) === ownership && ownership.deferredPartials.length) {
          const partial = ownership.deferredPartials.shift()!;
          const next = applyPartialQueryPatch(ownership.client, ownership.query, partial.updater, partial.options);
          rebaseMiss ||= next === undefined;
        }
        if (rebaseMiss) {
          void invalidateQueriesWithOptimisticOwnership(ownership.client, ownership.query.queryKey, true);
        }
      } finally {
        ownership.drainingPartials = false;
      }
    }
    // A manual patch clears Query's invalidated flag. Retain the deferred
    // read's stale state until ownership settles or a full publication wins.
    if (ownership.deferredInvalidation && queryOwnership.get(ownership.query) === ownership && !ownership.query.state.isInvalidated) {
      void ownership.client.invalidateQueries({ queryKey: ownership.query.queryKey, exact: true, refetchType: "none" });
    }
  }
}

// Callers know when a publication updates only part of a query. Keep that pure
// patch in order with pending mutations so rollback removes only the failed
// operation, including when a later partial write used the same value.
export function applyPartialQueryPatch(
  client: QueryClient,
  query: Query,
  updater: (current: unknown) => unknown,
  options: PartialPatchOptions = {},
): unknown {
  const ownership = queryOwnership.get(query);
  // Cache subscribers can synchronously dispatch an event during our own
  // publication. Queue it until the outer write finishes so its notification
  // cannot be mistaken for an unrelated full publication.
  const current = ownership?.publishing
    ? ownership.deferredPartials.reduce((data, partial) => {
      const updated = partial.updater(data);
      return updated === undefined ? data : updated;
    }, query.state.data)
    : query.state.data;
  const next = updater(current);
  if (next === undefined) return undefined;
  if (ownership?.publishing) {
    ownership.deferredPartials.push({ updater, options });
    return next;
  }
  if (ownership) {
    const entry: PatchEntry = {
      operation: Symbol("partial publication"),
      publicationTag: options.publicationTag,
      settled: true,
      apply: (previous) => {
        const rebased = updater(previous);
        entry.rebaseMiss = rebased === undefined;
        return rebased === undefined ? previous : rebased;
      },
    };
    ownership.entries.push(entry);
  }
  if (next !== current || !options.skipUnchanged) {
    const dataOptions = options.updatedAt === undefined ? undefined : { updatedAt: options.updatedAt };
    if (ownership) publish(ownership, next, dataOptions, options.publicationTag);
    else {
      const before = query.state;
      withTaggedPublication(query, options.publicationTag, () => {
        if (dataOptions) client.setQueryData(query.queryKey, () => next, dataOptions);
        else client.setQueryData(query.queryKey, () => next);
      });
      retainRefetchError(client, query, before, undefined);
    }
  }
  return next;
}

function releaseIfSettled(ownership: QueryOwnership): void {
  if (ownership.entries.every((entry) => entry.settled)) release(ownership, true);
}

// A cancelled read can restore its saved query state. Preserve pending patch
// ownership only when that restoration leaves the publication unchanged.
async function cancelQueriesWithOptimisticOwnership(
  client: QueryClient,
  filters: { readonly queryKey: QueryKey; readonly exact?: boolean; readonly predicate?: (query: Query) => boolean },
): Promise<void> {
  const queries = client.getQueryCache().findAll(filters);
  const cancelling = queries
    .map((query) => queryOwnership.get(query))
    .filter((ownership): ownership is QueryOwnership => ownership !== undefined);
  for (const ownership of cancelling) {
    ownership.cancellationState = {
      data: ownership.query.state.data,
      updateCount: ownership.query.state.dataUpdateCount,
    };
  }
  try {
    // Query cancels synchronously restore their saved state. Only a restore
    // that keeps the same data/count is metadata, rather than a new owner.
    const transitions = queries.map((query) => ({
      query,
      state: query.state,
      previous: metadataTransitions.get(query),
      marker: { data: query.state.data, count: query.state.dataUpdateCount },
    }));
    for (const { query, marker } of transitions) metadataTransitions.set(query, marker);
    let cancellation: Promise<void>;
    try {
      cancellation = client.cancelQueries(filters);
      for (const { query, state } of transitions) {
        if (query.state.data === state.data && query.state.dataUpdateCount === state.dataUpdateCount) {
          // A manual write saved a success state before its error metadata was
          // restored. Cancelling that read must not revive the saved success.
          retainRefetchError(client, query, state, queryOwnership.get(query), state.dataUpdateCount);
        }
      }
    } finally {
      for (const { query, marker, previous } of transitions) {
        if (metadataTransitions.get(query) !== marker) continue;
        if (previous) metadataTransitions.set(query, previous);
        else metadataTransitions.delete(query);
      }
    }
    await cancellation;
  } finally {
    for (const ownership of cancelling) delete ownership.cancellationState;
  }
}

// A settlement read cannot distinguish an uncommitted pending patch from one
// already included by the server. Mark affected queries stale, but wait until
// their pending operations settle before refetching them. Other queries refetch
// immediately, and an independent canonical publication still takes ownership.
export function invalidateQueriesWithOptimisticOwnership(
  client: QueryClient,
  queryKey: QueryKey,
  exact = false,
): Promise<void> {
  const filters = exact ? { queryKey, exact: true } : { queryKey };
  const deferredQueries = new Set<Query>();
  for (const query of client.getQueryCache().findAll(filters)) {
    const ownership = queryOwnership.get(query);
    if (!ownership || ownership.entries.every((entry) => entry.settled)) continue;
    deferredQueries.add(query);
    ownership.deferredInvalidation = true;
  }
  if (!deferredQueries.size) return client.invalidateQueries(filters);
  const marked = client.invalidateQueries({ ...filters, refetchType: "none" });
  const unblocked = client.refetchQueries({ ...filters, type: "active", predicate: (query) => !deferredQueries.has(query) });
  return Promise.all([marked, unblocked]).then(() => undefined);
}

function rollback(context: OptimisticContext): void {
  context.rollbackAttempted = true;
  for (const ownership of context.ownerships) {
    if (queryOwnership.get(ownership.query) !== ownership) continue;
    const removed = ownership.entries.filter((entry) => entry.operation === context.operation);
    const retained = ownership.entries.filter((entry) => entry.operation !== context.operation);
    ownership.entries.splice(0, ownership.entries.length, ...retained);
    context.ownerships.delete(ownership);
    // Reapply later pure patches over the original baseline. This removes the
    // failed operation while preserving independent or same-field later edits.
    const data = retained.reduce((current, entry) => entry.apply(current), ownership.baseline);
    publish(ownership, data, undefined, removed.length === 1 ? removed[0]?.publicationTag : undefined);
    releaseIfSettled(ownership);
    // Invalidate after publishing: setQueryData clears the invalidated flag.
    // A partial event that no longer applies needs exact reconciliation.
    if (retained.some((entry) => entry.rebaseMiss)) {
      void invalidateQueriesWithOptimisticOwnership(ownership.client, ownership.query.queryKey, true);
    }
  }
}

// Per-call `mutate(payload, { onSuccess, onSettled })` callbacks fire AFTER
// the helper-level lifecycle (onMutate patch → mutationFn → helper onError
// rollback → helper onSettled invalidations) per TanStack Query v5 semantics.
export function createOptimisticMutation<TData, TVariables>(
  queryClient: QueryClient,
  config: OptimisticMutationConfig<TData, TVariables>,
): UseMutationOptions<TData, Error, TVariables, OptimisticContext> {
  return {
    ...(config.mutationKey ? { mutationKey: config.mutationKey } : {}),
    ...(config.meta ? { meta: config.meta } : {}),
    mutationFn: config.mutationFn,
    onMutate: async (variables) => {
      const context: OptimisticContext = {
        operation: Symbol("optimistic mutation"),
        ownerships: new Set(),
        rollbackAttempted: false,
      };
      try {
        for (const spec of config.optimisticUpdates?.(variables) ?? []) {
          const filters = { queryKey: spec.queryKey, exact: spec.exact ?? true };
          const cancelFilters = {
            queryKey: spec.queryKey,
            exact: spec.cancelExact ?? spec.exact ?? true,
            ...(spec.isRelevant ? { predicate: (query: Query) => spec.isRelevant!(query.state.data, variables, query.queryKey) } : {}),
          };
          await cancelQueriesWithOptimisticOwnership(queryClient, cancelFilters);
          for (const query of queryClient.getQueryCache().findAll(filters)) {
            if (spec.isRelevant && !spec.isRelevant(query.state.data, variables, query.queryKey)) continue;
            const entry: PatchEntry = {
              operation: context.operation,
              context,
              publicationTag: spec.publicationTag,
              apply: (current) => spec.patch(current, variables, query.queryKey),
              settled: false,
            };
            const patched = entry.apply(query.state.data);
            const ownership = ownershipFor(queryClient, query);
            ownership.entries.push(entry);
            context.ownerships.add(ownership);
            publish(ownership, patched, undefined, spec.publicationTag);
          }
        }
        return context;
      } catch (error) {
        rollback(context);
        throw error;
      }
    },
    onError: (_error, _variables, context) => {
      if (context) rollback(context);
    },
    onSettled: (data, error, variables, context) => {
      if (context) {
        for (const ownership of context.ownerships) {
          if (queryOwnership.get(ownership.query) !== ownership) continue;
          if (error && !context.rollbackAttempted) {
            // A caller-specific onError deliberately declined helper rollback.
            // Drop the ledger rather than revive its stale snapshot later.
            release(ownership);
            continue;
          }
          for (const entry of ownership.entries) {
            if (entry.operation === context.operation) entry.settled = true;
          }
          releaseIfSettled(ownership);
        }
      }
      const keys = config.settle?.(variables, data ?? undefined) ?? [];
      for (const key of keys) {
        void invalidateQueriesWithOptimisticOwnership(queryClient, key);
      }
    },
  };
}
