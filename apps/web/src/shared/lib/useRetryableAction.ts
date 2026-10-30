import { useRef, useState } from "react";

import { useTenantId } from "../providers/TenantProvider.js";
import { usePorts } from "../providers/PortsProvider.js";

/** In-memory only: uncertain retries keep the exact submitted private payload. */
export function useRetryableAction<T extends { requestId: string }>(scope: string) {
  const { requestIdentity } = usePorts();
  const tenantId = useTenantId();
  scope = `${tenantId}:${scope}`;
  const [, rerender] = useState(0);
  const state = useRef<{ scope: string; requestId: string; request: T | null } | null>(null);
  if (!state.current || state.current.scope !== scope) {
    state.current = { scope, requestId: requestIdentity.create(), request: null };
  }
  const current = state.current;
  return {
    requestId: current.requestId,
    pending: current.request !== null,
    prepare(request: T): T {
      current.request ??= structuredClone(request);
      rerender((value) => value + 1);
      return current.request;
    },
    newAction() {
      if (state.current !== current) return;
      state.current = { scope, requestId: requestIdentity.create(), request: null };
      rerender((value) => value + 1);
    },
  };
}
