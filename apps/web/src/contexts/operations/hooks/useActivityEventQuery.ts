import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { activityKeys } from "../activityKeys.js";
import type { ActivityEventSummary } from "../types.js";

export type ActivityEvent = ActivityEventSummary;

function isNotFoundError(error: unknown): boolean {
  return typeof error === "object" && error !== null && "status" in error && error.status === 404;
}

export function useActivityEventQuery(eventId: string): UseQueryResult<ActivityEvent | null> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery<ActivityEvent | null>({
    queryKey: activityKeys.detail(tenantId, eventId),
    queryFn: async () => {
      try {
        const response = await api.activityEvent(eventId);
        return response.event;
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    },
  });
}
