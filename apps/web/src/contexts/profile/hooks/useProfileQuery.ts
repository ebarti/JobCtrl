import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { ProfileConfigResponse } from "@jobctrl/contracts";
import { profileQuery } from "../readQueries.js";
import { readProfile } from "../client.js";

export function useProfileQuery(workspaceIdentity?: string): UseQueryResult<ProfileConfigResponse> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const query = profileQuery({ tenantId, ports: { http } });
  return useQuery({
    ...query, queryKey: workspaceIdentity ? [...query.queryKey, "workspace", workspaceIdentity] : query.queryKey,
    queryFn: () => readProfile(http, workspaceIdentity),
  });
}
