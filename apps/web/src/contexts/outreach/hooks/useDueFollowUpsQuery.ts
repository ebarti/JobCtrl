import type { DueFollowUpSummary } from "@jobctl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

/**
 * Read the derived list of outreach follow-ups that are due (or scheduled), a
 * read-model projection recomputed over each thread's schedule and the current
 * clock. These are surfaced-only reminders — JobCtl never sends or acts on
 * them (INV-1). Invalidated by the send-log/follow-up SSE handlers.
 */
export function useDueFollowUpsQuery(): UseQueryResult<DueFollowUpSummary[]> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: outreachKeys.dueFollowUps(tenantId),
    queryFn: async () => (await api.dueOutreachFollowUps()).followUps,
  });
}
