import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applyReviewKeys } from "../applyReviewKeys.js";
import type { ApplyReviewQueueResponse } from "../types.js";

export function useApplyReviewQueueQuery(): UseQueryResult<ApplyReviewQueueResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: applyReviewKeys.queue(tenantId),
    queryFn: () => api.applyReviewQueue(),
  });
}
