import { QueryClient, MutationObserver } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import { createOptimisticMutation } from "./createOptimisticMutation.js";

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
