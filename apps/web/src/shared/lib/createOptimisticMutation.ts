import {
  type QueryClient,
  type QueryKey,
  type UseMutationOptions,
} from "@tanstack/react-query";

export interface OptimisticPatchSpec<TVariables> {
  readonly queryKey: QueryKey;
  readonly patch: (previous: unknown, variables: TVariables) => unknown;
  readonly exact?: boolean;
}

export interface OptimisticMutationConfig<TData, TVariables> {
  readonly mutationKey?: QueryKey;
  readonly mutationFn: (variables: TVariables) => Promise<TData>;
  readonly optimisticUpdates?: (variables: TVariables) => readonly OptimisticPatchSpec<TVariables>[];
  readonly settle?: (variables: TVariables, data: TData | undefined) => readonly QueryKey[];
  readonly meta?: Record<string, unknown>;
}

export interface OptimisticContext {
  readonly snapshots: ReadonlyArray<readonly [QueryKey, unknown]>;
}

// Per-call `mutate(payload, { onSuccess, onSettled })` callbacks fire AFTER
// the helper-level lifecycle (onMutate snapshot+patch → mutationFn → helper
// onError rollback → helper onSettled invalidations) per TanStack Query v5
// semantics. Per-call callbacks see the rolled-back / invalidated cache, never
// the optimistic patch.
export function createOptimisticMutation<TData, TVariables>(
  queryClient: QueryClient,
  config: OptimisticMutationConfig<TData, TVariables>,
): UseMutationOptions<TData, Error, TVariables, OptimisticContext> {
  return {
    ...(config.mutationKey ? { mutationKey: config.mutationKey } : {}),
    ...(config.meta ? { meta: config.meta } : {}),
    mutationFn: config.mutationFn,
    onMutate: async (variables) => {
      const patches = config.optimisticUpdates?.(variables) ?? [];
      const snapshots: Array<[QueryKey, unknown]> = [];
      for (const spec of patches) {
        const filters = { queryKey: spec.queryKey, exact: spec.exact ?? true };
        await queryClient.cancelQueries(filters);
        const tuples = queryClient.getQueriesData(filters);
        for (const [key, previous] of tuples) {
          snapshots.push([key, previous]);
        }
        queryClient.setQueriesData(filters, (current: unknown) =>
          spec.patch(current, variables),
        );
      }
      return { snapshots };
    },
    onError: (_error, _variables, context) => {
      if (!context) {
        return;
      }
      for (const [key, previous] of context.snapshots) {
        queryClient.setQueryData(key, previous);
      }
    },
    onSettled: (data, _error, variables) => {
      const keys = config.settle?.(variables, data ?? undefined) ?? [];
      for (const key of keys) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  };
}
