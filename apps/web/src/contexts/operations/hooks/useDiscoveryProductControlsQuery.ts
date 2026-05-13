import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";
import type {
  ManualCaptureListResponse,
  QuarantineListResponse,
  SourceLocatorListResponse,
  SourceRegistryListResponse,
} from "../types.js";

export function useSourceRegistryQuery(): UseQueryResult<SourceRegistryListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: discoveryKeys.sourceRegistry(tenantId),
    queryFn: () => api.discoverySources(),
    staleTime: 0,
  });
}

export function useSourceLocatorCandidatesQuery(): UseQueryResult<SourceLocatorListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: discoveryKeys.sourceLocator(tenantId),
    queryFn: () => api.discoveryLocatorCandidates(),
    staleTime: 0,
  });
}

export function useDiscoveryQuarantineQuery(): UseQueryResult<QuarantineListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: discoveryKeys.quarantine(tenantId),
    queryFn: () => api.discoveryQuarantine(),
    staleTime: 0,
  });
}

export function useManualCaptureQueueQuery(): UseQueryResult<ManualCaptureListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: discoveryKeys.manualCapture(tenantId),
    queryFn: () => api.manualCaptureQueue(),
    staleTime: 0,
  });
}
