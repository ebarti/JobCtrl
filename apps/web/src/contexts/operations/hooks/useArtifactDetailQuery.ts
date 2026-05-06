import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { artifactsKeys } from "../artifactsKeys.js";
import type { ArtifactDetail } from "../types.js";

export function useArtifactDetailQuery(artifactId: string): UseQueryResult<ArtifactDetail> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: artifactsKeys.detail(tenantId, artifactId),
    queryFn: () => api.artifact(artifactId),
  });
}
