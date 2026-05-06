import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { ProfileConfigResponse } from "../../operations/types.js";
import { profileKeys } from "../queryKeys.js";

export function useProfileQuery(): UseQueryResult<ProfileConfigResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: profileKeys.profile(tenantId),
    queryFn: () => api.profile(),
  });
}
