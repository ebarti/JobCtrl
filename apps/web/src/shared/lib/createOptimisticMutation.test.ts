// @vitest-environment node

import { QueryClient, MutationObserver, QueryObserver } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import { applyPartialQueryPatch, createOptimisticMutation, invalidateQueriesWithOptimisticOwnership } from "./createOptimisticMutation.js";

interface Counter {
  readonly count: number;
}

const KEY = ["counter"] as const;

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function runMutation(
  client: QueryClient,
  config: Parameters<typeof createOptimisticMutation<Counter, number>>[1],
  variables: number,
): Promise<{ data?: Counter; error?: Error }> {
  const observer = new MutationObserver(client, createOptimisticMutation(client, config));
  try {
    const data = await observer.mutate(variables);
    return { data };
  } catch (error) {
    return { error: error as Error };
  } finally {
    await flush();
  }
}

describe("createOptimisticMutation", () => {
  it.each(["optimistic", "partial"] as const)("retains a failed read across a %s publication until a read succeeds", async (mode) => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    const read = vi.fn<() => Promise<Counter>>().mockRejectedValueOnce(new Error("Synthetic read failure")).mockResolvedValueOnce({ count: 3 });
    const query = new QueryObserver(client, { queryKey: KEY, queryFn: read });
    const unsubscribe = query.subscribe(() => {});
    await query.refetch();
    expect(query.getCurrentResult().isRefetchError).toBe(true);
    let finish!: (value: Counter) => void;
    if (mode === "optimistic") {
      const mutation = new MutationObserver(client, createOptimisticMutation<Counter, number>(client, {
        mutationFn: () => new Promise((resolve) => { finish = resolve; }),
        optimisticUpdates: () => [{ queryKey: KEY, patch: (current) => ({ count: (current as Counter).count + 1 }) }],
      }));
      const pending = mutation.mutate(0);
      await flush();
      expect(query.getCurrentResult().data?.count).toBe(2);
      expect(query.getCurrentResult().isRefetchError).toBe(true);
      finish({ count: 2 });
      await pending;
    } else {
      const cached = client.getQueryCache().find({ queryKey: KEY, exact: true })!;
      applyPartialQueryPatch(client, cached, (current) => ({ count: (current as Counter).count + 1 }));
    }
    expect(query.getCurrentResult().data?.count).toBe(2);
    expect(query.getCurrentResult().isRefetchError).toBe(true);
    await query.refetch();
    expect(query.getCurrentResult().isRefetchError).toBe(false);
    expect(query.getCurrentResult().data?.count).toBe(3);
    unsubscribe();
  });

  it("retains a failed refresh when a later mutation cancels a read after an accepted partial", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let resolveRetry!: (value: Counter) => void;
    const failure = new Error("Synthetic failed refresh");
    const read = vi.fn<() => Promise<Counter>>()
      .mockRejectedValueOnce(failure)
      .mockImplementationOnce(() => new Promise((resolve) => { resolveRetry = resolve; }))
      .mockResolvedValueOnce({ count: 4 });
    const observer = new QueryObserver(client, { queryKey: KEY, queryFn: read });
    const unsubscribe = observer.subscribe(() => {});
    await observer.refetch();
    expect(observer.getCurrentResult().isRefetchError).toBe(true);
    const retry = observer.refetch();
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    const query = client.getQueryCache().find({ queryKey: KEY, exact: true })!;
    applyPartialQueryPatch(client, query, () => ({ count: 2 }));
    const before = query.state;
    expect(before.status).toBe("error");
    let atPatch: typeof query.state | undefined;
    await new MutationObserver(client, createOptimisticMutation<Counter, number>(client, {
      mutationFn: async () => ({ count: 3 }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: (current) => {
        atPatch = query.state;
        return { count: (current as Counter).count + 1 };
      } }],
    })).mutate(0);
    expect(atPatch).toMatchObject({
      data: before.data,
      dataUpdateCount: before.dataUpdateCount,
      error: failure,
      status: "error",
      errorUpdatedAt: before.errorUpdatedAt,
      errorUpdateCount: before.errorUpdateCount,
      fetchFailureCount: before.fetchFailureCount,
      fetchFailureReason: before.fetchFailureReason,
      isInvalidated: before.isInvalidated,
      fetchStatus: "idle",
    });
    expect(atPatch?.data).toBe(before.data);
    expect(observer.getCurrentResult().data?.count).toBe(3);
    expect(observer.getCurrentResult().isRefetchError).toBe(true);
    resolveRetry({ count: 0 });
    await retry;
    await observer.refetch();
    expect(observer.getCurrentResult().data?.count).toBe(4);
    expect(observer.getCurrentResult().isRefetchError).toBe(false);
    expect(read).toHaveBeenCalledTimes(3);
    unsubscribe();
  });

  it("snapshots, patches, and invalidates on success", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });

    const config = {
      mutationFn: async (delta: number) => ({ count: 99 + delta }),
      optimisticUpdates: (delta: number) => [
        {
          queryKey: KEY,
          patch: (current: unknown) => {
            const value = (current as Counter | undefined) ?? { count: 0 };
            return { count: value.count + delta };
          },
        },
      ],
      settle: () => [KEY],
    };

    const observer = new MutationObserver(client, createOptimisticMutation(client, config));
    const promise = observer.mutate(5);
    await flush();
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(6);
    const data = await promise;
    expect(data.count).toBe(104);
    await flush();
  });

  it("rolls back on error", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 7 });

    const config = {
      mutationFn: async (_delta: number): Promise<Counter> => {
        throw new Error("boom");
      },
      optimisticUpdates: (delta: number) => [
        {
          queryKey: KEY,
          patch: (current: unknown) => {
            const value = (current as Counter | undefined) ?? { count: 0 };
            return { count: value.count + delta };
          },
        },
      ],
    };

    const result = await runMutation(client, config, 4);
    expect(result.error?.message).toBe("boom");
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(7);
  });

  for (const firstFailure of ["older", "newer"] as const) {
    it(`removes overlapping failed patches in ${firstFailure}-first order`, async () => {
      const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
      client.setQueryData<Counter>(KEY, { count: 1 });
      const gates = new Map<number, (error: Error) => void>();
      const options = createOptimisticMutation<Counter, number>(client, {
        mutationFn: (delta) => new Promise((_resolve, reject) => { gates.set(delta, reject); }),
        optimisticUpdates: () => [{
          queryKey: KEY,
          patch: (current, delta) => ({ count: (current as Counter).count + delta }),
        }],
      });
      const older = new MutationObserver(client, options).mutate(1).catch(() => undefined);
      await flush();
      const newer = new MutationObserver(client, options).mutate(10).catch(() => undefined);
      await flush();
      expect(client.getQueryData<Counter>(KEY)?.count).toBe(12);
      const first = firstFailure === "older" ? 1 : 10;
      const second = first === 1 ? 10 : 1;
      gates.get(first)?.(new Error("first failure"));
      await (first === 1 ? older : newer);
      expect(client.getQueryData<Counter>(KEY)?.count).toBe(first === 1 ? 11 : 2);
      gates.get(second)?.(new Error("second failure"));
      await (second === 1 ? older : newer);
      expect(client.getQueryData<Counter>(KEY)?.count).toBe(1);
    });
  }

  it("keeps a later same-value write after the earlier operation fails", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let rejectOlder!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: (value) => value === 1
        ? new Promise((_resolve, reject) => { rejectOlder = reject; })
        : Promise.resolve({ count: 5 }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: () => ({ count: 5 }) }],
    });
    const older = new MutationObserver(client, options).mutate(1).catch(() => undefined);
    await flush();
    await new MutationObserver(client, options).mutate(2);
    rejectOlder(new Error("older failed"));
    await older;
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(5);
  });

  it("refetches unblocked matching queries while a pending query waits for settlement", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    const prefix = ["counters"] as const;
    const blockedKey = [...prefix, "pending"] as const;
    const otherKey = [...prefix, "other"] as const;
    client.setQueryData<Counter>(blockedKey, { count: 1 });
    client.setQueryData<Counter>(otherKey, { count: 2 });
    const blockedRead = vi.fn(async () => ({ count: 5 }));
    const otherRead = vi.fn(async () => ({ count: 3 }));
    const blockedObserver = new QueryObserver(client, { queryKey: blockedKey, queryFn: blockedRead, staleTime: Infinity });
    const otherObserver = new QueryObserver(client, { queryKey: otherKey, queryFn: otherRead, staleTime: Infinity });
    const unsubscribeBlocked = blockedObserver.subscribe(() => {});
    const unsubscribeOther = otherObserver.subscribe(() => {});
    let resolveWrite!: (value: Counter) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((resolve) => { resolveWrite = resolve; }),
      optimisticUpdates: () => [{ queryKey: blockedKey, patch: () => ({ count: 5 }) }],
    });
    const write = new MutationObserver(client, options).mutate(0);
    await flush();
    const invalidation = invalidateQueriesWithOptimisticOwnership(client, prefix);
    let invalidationFinished = false;
    void invalidation.then(() => { invalidationFinished = true; });
    await flush();
    expect(invalidationFinished).toBe(true);
    expect(otherRead).toHaveBeenCalledTimes(1);
    expect(blockedRead).not.toHaveBeenCalled();
    expect(client.getQueryState(blockedKey)?.isInvalidated).toBe(true);
    expect(client.getQueryData(otherKey)).toEqual({ count: 3 });
    const query = client.getQueryCache().find({ queryKey: blockedKey, exact: true })!;
    applyPartialQueryPatch(client, query, (current) => ({ ...(current as object), status: "changed" }));
    expect(client.getQueryState(blockedKey)?.isInvalidated).toBe(true);
    resolveWrite({ count: 5 });
    await write;
    await invalidation;
    expect(blockedRead).toHaveBeenCalledTimes(1);
    expect(client.getQueryData(blockedKey)).toEqual({ count: 5 });
    unsubscribeBlocked();
    unsubscribeOther();
  });

  it("keeps ownership across an unchanged cancellation of an in-flight read", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let rejectOlder!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: (delta) => delta === 1
        ? new Promise((_resolve, reject) => { rejectOlder = reject; })
        : Promise.resolve({ count: 0 }),
      optimisticUpdates: () => [{
        queryKey: KEY,
        patch: (current, delta) => ({ count: (current as Counter).count + delta }),
      }],
    });
    const older = new MutationObserver(client, options).mutate(1).catch(() => undefined);
    await flush();
    const read = client.fetchQuery({ queryKey: KEY, queryFn: () => new Promise<Counter>(() => {}) }).catch(() => undefined);
    await flush();
    await new MutationObserver(client, options).mutate(10);
    await read;
    rejectOlder(new Error("older failed"));
    await older;
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(11);
  });

  it("preserves a partial publication of the same value when the old mutation fails", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: () => ({ count: 5 }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    const query = client.getQueryCache().find({ queryKey: KEY, exact: true })!;
    applyPartialQueryPatch(client, query, (current) =>
      (current as Counter).count === 5 ? current : { count: 5 }, { skipUnchanged: true });
    reject(new Error("old failure"));
    await mutation;
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(5);
  });

  it("keeps a reentrant partial event while rolling back the older mutation", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(KEY, { count: 1, status: "active" });
    let sent = false;
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (!sent && event.type === "updated" && event.action.type === "success") {
        sent = true;
        applyPartialQueryPatch(client, event.query, (current) => ({ ...(current as object), status: "closed" }));
      }
    });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: (current) => ({ ...(current as object), count: 5 }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    reject(new Error("old failure"));
    await mutation;
    unsubscribe();
    expect(client.getQueryData(KEY)).toEqual({ count: 1, status: "closed" });
  });

  it("retains event order when publishing a deferred partial triggers another event", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(KEY, { count: 1, status: "active" });
    let firstBatch = false;
    let thirdSent = false;
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success") return;
      const status = (event.query.state.data as { status: string }).status;
      if (!firstBatch && status === "active") {
        firstBatch = true;
        applyPartialQueryPatch(client, event.query, (current) => ({ ...(current as object), status: "first" }));
        applyPartialQueryPatch(client, event.query, (current) => ({ ...(current as object), status: "second" }));
      } else if (!thirdSent && status === "first") {
        thirdSent = true;
        applyPartialQueryPatch(client, event.query, (current) => ({ ...(current as object), status: "third" }));
      }
    });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: (current) => ({ ...(current as object), count: 5 }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    reject(new Error("old failure"));
    await mutation;
    unsubscribe();
    expect(client.getQueryData(KEY)).toEqual({ count: 1, status: "third" });
  });

  it("does not apply a queued partial event over a reentrant full publication", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(KEY, { count: 1, status: "active" });
    let sent = false;
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (!sent && event.type === "updated" && event.action.type === "success") {
        sent = true;
        applyPartialQueryPatch(client, event.query, (current) => ({ ...(current as object), status: "closed" }));
        client.setQueryData(KEY, { count: 42, status: "canonical" });
      }
    });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: (current) => ({ ...(current as object), count: 5 }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    reject(new Error("old failure"));
    await mutation;
    unsubscribe();
    expect(client.getQueryData(KEY)).toEqual({ count: 42, status: "canonical" });
  });

  it("keeps a full canonical publication after a partial publication and an old failure", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: () => ({ count: 5 }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    const query = client.getQueryCache().find({ queryKey: KEY, exact: true })!;
    applyPartialQueryPatch(client, query, () => ({ count: 7 }));
    client.setQueryData<Counter>(KEY, { count: 42 });
    reject(new Error("old failure"));
    await mutation;
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(42);
  });

  it("invalidates exactly when a partial event cannot be reapplied after rollback", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData(KEY, { row: null });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: () => ({ row: { value: 1 } }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    const query = client.getQueryCache().find({ queryKey: KEY, exact: true })!;
    applyPartialQueryPatch(client, query, (current) => {
      const row = (current as { row: { value: number } | null }).row;
      return row ? { row: { value: 2 } } : undefined;
    });
    const invalidations = vi.spyOn(client, "invalidateQueries");
    reject(new Error("old failure"));
    await mutation;
    expect(client.getQueryData(KEY)).toEqual({ row: null });
    expect(invalidations).toHaveBeenCalledWith({ queryKey: KEY, exact: true });
    expect(client.getQueryState(KEY)?.isInvalidated).toBe(true);
  });

  it("does not undo an independent publication, even if it republishes the same data", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: () => ({ count: 5 }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    client.setQueryData(KEY, (current: Counter | undefined) => current);
    reject(new Error("old failure"));
    await mutation;
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(5);
  });

  it("fences a reentrant canonical publication made by another cache subscriber", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let published = false;
    const unsubscribe = client.getQueryCache().subscribe((event) => {
      if (!published && event.type === "updated" && event.action.type === "success") {
        published = true;
        client.setQueryData<Counter>(KEY, { count: 42 });
      }
    });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: () => ({ count: 5 }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    reject(new Error("old failure"));
    await mutation;
    unsubscribe();
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(42);
  });

  it("does not restore a query removed and recreated while a mutation is pending", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let reject!: (error: Error) => void;
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{ queryKey: KEY, patch: () => ({ count: 5 }) }],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    client.removeQueries({ queryKey: KEY, exact: true });
    client.setQueryData<Counter>(KEY, { count: 42 });
    reject(new Error("old failure"));
    await mutation;
    expect(client.getQueryData<Counter>(KEY)?.count).toBe(42);
  });

  it("rolls back only owned matching queries and invalidates the targeted key", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    const keyA = ["counters", "a"] as const;
    const keyB = ["counters", "b"] as const;
    const unrelated = ["unrelated"] as const;
    client.setQueryData<Counter>(keyA, { count: 1 });
    client.setQueryData<Counter>(keyB, { count: 2 });
    client.setQueryData<Counter>(unrelated, { count: 3 });
    let reject!: (error: Error) => void;
    const invalidate = vi.spyOn(client, "invalidateQueries");
    const options = createOptimisticMutation<Counter, number>(client, {
      mutationFn: () => new Promise((_resolve, fail) => { reject = fail; }),
      optimisticUpdates: () => [{
        queryKey: ["counters"], exact: false,
        patch: (current) => ({ count: (current as Counter).count + 10 }),
      }],
      settle: () => [["counters"]],
    });
    const mutation = new MutationObserver(client, options).mutate(0).catch(() => undefined);
    await flush();
    expect(client.getQueryData<Counter>(keyA)?.count).toBe(11);
    expect(client.getQueryData<Counter>(keyB)?.count).toBe(12);
    client.setQueryData<Counter>(keyA, { count: 42 });
    reject(new Error("old failure"));
    await mutation;
    expect(client.getQueryData<Counter>(keyA)?.count).toBe(42);
    expect(client.getQueryData<Counter>(keyB)?.count).toBe(2);
    expect(client.getQueryData<Counter>(unrelated)?.count).toBe(3);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["counters"] });
  });

  it("skips invalidation when settle is not provided", async () => {
    const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    client.setQueryData<Counter>(KEY, { count: 1 });
    let invalidations = 0;
    const original = client.invalidateQueries.bind(client);
    client.invalidateQueries = ((opts: Parameters<QueryClient["invalidateQueries"]>[0]) => {
      invalidations += 1;
      return original(opts);
    }) as QueryClient["invalidateQueries"];
    const config = { mutationFn: async () => ({ count: 0 }) };
    await runMutation(client, config, 1);
    expect(invalidations).toBe(0);
  });
});
