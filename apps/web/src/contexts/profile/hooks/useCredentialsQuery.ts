import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { CredentialsResponse } from "../../operations/types.js";
import { profileKeys } from "../queryKeys.js";

export function useCredentialsQuery(): UseQueryResult<CredentialsResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: profileKeys.credentials(tenantId),
    queryFn: () => api.credentials(),
  });
}
