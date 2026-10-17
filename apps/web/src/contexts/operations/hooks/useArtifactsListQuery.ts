import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { artifactsKeys } from "../artifactsKeys.js";
import type { ArtifactsListInput } from "../types.js";
import type { ArtifactSummary, PaginatedResponse } from "@jobctrl/contracts";

export interface UseArtifactsListQueryOptions {
  readonly enabled?: boolean;
}

export function useArtifactsListQuery(
  input: ArtifactsListInput,
  options: UseArtifactsListQueryOptions = {},
): UseQueryResult<PaginatedResponse<ArtifactSummary>> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: artifactsKeys.list(tenantId, input),
    queryFn: () => api.artifacts(input),
    enabled: options.enabled ?? true,
    staleTime: 60_000,
  });
}
