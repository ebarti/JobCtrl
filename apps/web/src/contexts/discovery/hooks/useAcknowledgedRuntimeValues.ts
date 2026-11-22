import { hashKey, skipToken, useQuery, useQueryClient, type QueryClient, type QueryKey } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo } from "react";

interface RuntimeBaseline<T> {
  values: T;
}

const readCaptures = new WeakMap<QueryClient, Set<string>>();
const pendingSaves = new WeakMap<QueryClient, Map<string, Promise<void>>>();

function captureSuccessfulReads<TResponse, TValues>(
  queryClient: QueryClient,
  settingsHash: string,
  baselineKey: QueryKey,
  select: (response: TResponse) => TValues,
) {
  const captureKey = JSON.stringify([settingsHash, hashKey(baselineKey)]);
  const captures = readCaptures.get(queryClient) ?? new Set<string>();
  if (captures.has(captureKey)) return;
  captures.add(captureKey);
  readCaptures.set(queryClient, captures);
  queryClient.setQueryDefaults(baselineKey, { enabled: false, staleTime: Infinity, gcTime: Infinity });
  // Keep observing for this QueryClient's lifetime, including while the panel is unmounted.
  queryClient.getQueryCache().subscribe((event) => {
    if (event.type !== "updated" || event.query.queryHash !== settingsHash
      || event.action.type !== "success" || event.action.manual || event.action.data === undefined) return;
    const values = select(event.action.data as TResponse);
    queryClient.setQueryData<RuntimeBaseline<TValues>>(baselineKey, { values });
  });
}

// The settings cache also carries optimistic writes and rollback snapshots.
// Only a successful read or an explicit save acknowledgement is authoritative.
// Runtime writes are serialized per tenant and settings panel, including across remounts.
export function useAcknowledgedRuntimeValues<TResponse, TValues>(
  settingsKey: QueryKey,
  baselineKey: QueryKey,
  initial: TValues,
  select: (response: TResponse) => TValues,
) {
  const queryClient = useQueryClient();
  const settingsHash = hashKey(settingsKey);
  const baselineHash = hashKey(baselineKey);
  const stableBaselineKey = useMemo(() => baselineKey, [baselineHash]);
  const baseline = useQuery<RuntimeBaseline<TValues>>({
    queryKey: stableBaselineKey,
    queryFn: skipToken,
    enabled: false,
    initialData: { values: initial },
    staleTime: Infinity,
    gcTime: Infinity,
  });

  useEffect(() => {
    captureSuccessfulReads(queryClient, settingsHash, stableBaselineKey, select);
  }, [queryClient, select, settingsHash, stableBaselineKey]);

  const acknowledge = useCallback((values: TValues) => {
    queryClient.setQueryData<RuntimeBaseline<TValues>>(stableBaselineKey, { values });
    return values;
  }, [queryClient, stableBaselineKey]);

  const currentValues = useCallback(() =>
    queryClient.getQueryData<RuntimeBaseline<TValues>>(stableBaselineKey)?.values ?? initial,
  [initial, queryClient, stableBaselineKey]);

  const runSave = useCallback(<TResult>(operation: () => Promise<TResult>): Promise<TResult> => {
    const saves = pendingSaves.get(queryClient) ?? new Map<string, Promise<void>>();
    pendingSaves.set(queryClient, saves);
    const previous = saves.get(baselineHash) ?? Promise.resolve();
    const result = previous.then(operation);
    const settled = result.then(() => undefined, () => undefined);
    saves.set(baselineHash, settled);
    void settled.then(() => {
      if (saves.get(baselineHash) === settled) saves.delete(baselineHash);
    });
    return result;
  }, [baselineHash, queryClient]);
  return { values: baseline.data?.values ?? initial, acknowledge, currentValues, runSave };
}
