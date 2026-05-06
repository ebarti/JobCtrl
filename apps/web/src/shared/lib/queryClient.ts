import { MutationCache, QueryCache, QueryClient } from "@tanstack/react-query";

import { useToastStore } from "../stores/toasts.js";

export interface QueryMeta {
  readonly suppressGlobalErrorToast?: boolean;
}

declare module "@tanstack/react-query" {
  interface Register {
    queryMeta: QueryMeta;
    mutationMeta: QueryMeta;
  }
}

function toastError(error: unknown, meta: QueryMeta | undefined): void {
  if (meta?.suppressGlobalErrorToast) {
    return;
  }
  const message = error instanceof Error ? error.message : "Unexpected error.";
  useToastStore.getState().toast({ variant: "error", message });
}

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnWindowFocus: true,
        refetchOnReconnect: true,
        retry: 1,
      },
      mutations: {
        retry: false,
      },
    },
    queryCache: new QueryCache({
      onError: (error, query) => toastError(error, query.meta),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => toastError(error, mutation.meta),
    }),
  });
}
