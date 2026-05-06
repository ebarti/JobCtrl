import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { SettingsResponse } from "../../operations/types.js";
import { profileKeys } from "../queryKeys.js";

export function useSettingsQuery(): UseQueryResult<SettingsResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: profileKeys.settings(tenantId),
    queryFn: () => api.settings(),
  });
}
