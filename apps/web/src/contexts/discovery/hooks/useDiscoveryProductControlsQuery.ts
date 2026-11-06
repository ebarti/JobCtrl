import type { ManualCaptureListResponse, QuarantineListResponse, SourceRegistryListResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";
import { DiscoveryPreviewSchema, RoleFeedbackSchema, type DiscoveryPreview, type LocatorList, type RoleFeedback } from "../contracts.js";

export function useSourceRegistryQuery(options: { readonly enabled?: boolean } = {}): UseQueryResult<SourceRegistryListResponse> {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: discoveryKeys.sourceRegistry(tenantId), queryFn: () => http.json<SourceRegistryListResponse>("GET", "/v1/discovery/sources"), enabled: options.enabled ?? true, staleTime: 0 });
}
export function useSourceLocatorCandidatesQuery(): UseQueryResult<LocatorList> {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: discoveryKeys.sourceLocator(tenantId), queryFn: () => http.json<LocatorList>("GET", "/v1/discovery/locator-candidates"), staleTime: 0 });
}
export function useDiscoverySourcePreviewQuery(sourceId: string | null): UseQueryResult<DiscoveryPreview> {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: discoveryKeys.sourcePreview(tenantId, sourceId ?? ""), queryFn: async () => {
    const data = DiscoveryPreviewSchema.parse(await http.json<unknown>("POST", `/v1/discovery/sources/${encodeURIComponent(sourceId ?? "")}/preview`, { body: {} }));
    if (data.sourceId !== sourceId) throw new Error("The source preview does not match the selected source.");
    return data;
  }, enabled: Boolean(sourceId), staleTime: 0 });
}
export function useDiscoveryQuarantineQuery(): UseQueryResult<QuarantineListResponse> {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: discoveryKeys.quarantine(tenantId), queryFn: () => http.json<QuarantineListResponse>("GET", "/v1/discovery/quarantine"), staleTime: 0 });
}
export function useManualCaptureQueueQuery(): UseQueryResult<ManualCaptureListResponse> {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: discoveryKeys.manualCapture(tenantId), queryFn: () => http.json<ManualCaptureListResponse>("GET", "/v1/discovery/manual-capture"), staleTime: 0 });
}
export function useRoleMatchFeedbackQuery(): UseQueryResult<RoleFeedback> {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: discoveryKeys.roleMatchFeedback(tenantId), queryFn: async () => RoleFeedbackSchema.parse(await http.json<unknown>("GET", "/v1/discovery/role-match-feedback")), staleTime: 0 });
}
