import type { OutreachThreadResponse } from "@jobhunter/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export interface UseOutreachThreadQueryInput {
  contactId: string;
  jobId?: string;
}

/**
 * Read the outreach thread for a contact (optionally scoped to a job). `thread`
 * is null until the first draft is generated. Keyed by `threadForContact` so the
 * SSE invalidation router — which invalidates the parent `threads` scope on every
 * draft event — refreshes this drawer read after a generate/revise/approve/reject.
 */
export function useOutreachThreadQuery({
  contactId,
  jobId,
}: UseOutreachThreadQueryInput): UseQueryResult<OutreachThreadResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: outreachKeys.threadForContact(tenantId, contactId, jobId ?? null),
    queryFn: () => api.outreachThread(contactId, jobId ? { jobId } : {}),
    enabled: Boolean(contactId),
  });
}
