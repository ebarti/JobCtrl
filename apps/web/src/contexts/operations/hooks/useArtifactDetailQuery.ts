import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { artifactsKeys } from "../artifactsKeys.js";
import type { ArtifactDetail } from "../types.js";

export interface UseArtifactDetailQueryOptions {
  readonly enabled?: boolean;
}

export function useArtifactDetailQuery(
  artifactId: string | null | undefined,
  options: UseArtifactDetailQueryOptions = {},
): UseQueryResult<ArtifactDetail> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const enabled = Boolean(artifactId) && (options.enabled ?? true);
  return useQuery({
    queryKey: artifactsKeys.detail(tenantId, artifactId ?? "__missing_artifact_id__"),
    queryFn: () => api.artifact(artifactId ?? ""),
    enabled,
  });
}
