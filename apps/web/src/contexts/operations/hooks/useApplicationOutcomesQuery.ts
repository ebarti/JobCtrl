import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applicationOutcomesQuery } from "../readQueries.js";
import type { ApplicationOutcomeListResponse } from "@jobctrl/contracts";

export function useApplicationOutcomesQuery(): UseQueryResult<ApplicationOutcomeListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    ...applicationOutcomesQuery({ tenantId, ports: { api } }),
  });
}
