import { useRef, useState } from "react";

import { useTenantId } from "../providers/TenantProvider.js";
import { usePorts } from "../providers/PortsProvider.js";

export type RetryableActionRetention<T extends { requestId: string }> = Map<string, {
  requestId: string;
  request: T | null;
}>;

/** In-memory only: uncertain retries keep the exact submitted private payload. */
export function useRetryableAction<T extends { requestId: string }>(
  scope: string,
  retention?: RetryableActionRetention<T>,
) {
  const { requestIdentity } = usePorts();
  const tenantId = useTenantId();
  const key = JSON.stringify([tenantId, scope]);
  const [, rerender] = useState(0);
  const local = useRef<RetryableActionRetention<T>>(new Map());
  const states = retention ?? local.current;
  let current = states.get(key);
  if (!current) {
    current = { requestId: requestIdentity.create(), request: null };
    states.set(key, current);
  }
  const selected = current;
  return {
    requestId: selected.requestId,
    pending: selected.request !== null,
    prepare(request: T): T {
      selected.request ??= structuredClone(request);
      rerender((value) => value + 1);
      return selected.request;
    },
    newAction() {
      if (states.get(key) !== selected) return;
      states.set(key, { requestId: requestIdentity.create(), request: null });
      rerender((value) => value + 1);
    },
  };
}
