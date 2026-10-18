import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import type { SettingsResponse } from "@jobctrl/contracts";
import { settingsQuery } from "../readQueries.js";

export function useSettingsQuery(): UseQueryResult<SettingsResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    ...settingsQuery({ tenantId, ports: { api } }),
  });
}
