import type { ProviderModelCatalogResponse, SettingsResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { settingsKeys } from "../settingsKeys.js";

export function useSettingsPolicyQuery(): UseQueryResult<SettingsResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({ queryKey: settingsKeys.settings(tenantId), queryFn: () => api.settings() });
}

export function useProviderModelCatalogQuery(): UseQueryResult<ProviderModelCatalogResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({ queryKey: settingsKeys.providerModels(tenantId), queryFn: () => api.providerModels() });
}
