import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { artifactsKeys } from "../artifactsKeys.js";
import type { ArtifactsListInput, ArtifactSummary, PaginatedResponse } from "../types.js";

export function useArtifactsListQuery(
  input: ArtifactsListInput,
): UseQueryResult<PaginatedResponse<ArtifactSummary>> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: artifactsKeys.list(tenantId, input),
    queryFn: () => api.artifacts(input),
    staleTime: 60_000,
  });
}
