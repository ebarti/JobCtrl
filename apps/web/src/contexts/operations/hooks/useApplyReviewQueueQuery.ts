import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applyReviewQueueQuery } from "../readQueries.js";
import type { ApplyReviewQueueResponse } from "@jobctrl/contracts";

export function useApplyReviewQueueQuery(): UseQueryResult<ApplyReviewQueueResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    ...applyReviewQueueQuery({ tenantId, ports: { api } }),
  });
}
