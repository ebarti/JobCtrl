import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { evidenceMapKeys } from "../evidenceMapKeys.js";
import type { EvidenceMapEntry, EvidenceMapResponse } from "../types.js";

export function useEvidenceMapQuery(): UseQueryResult<EvidenceMapResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: evidenceMapKeys.list(tenantId),
    queryFn: () => api.evidenceMap(),
  });
}

export function useEvidenceMapEntryQuery(
  entryId: string | null,
): UseQueryResult<EvidenceMapEntry | null> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: evidenceMapKeys.list(tenantId),
    queryFn: () => api.evidenceMap(),
    select: (response) =>
      entryId ? response.entries.find((entry) => entry.entryId === entryId) ?? null : null,
  });
}
