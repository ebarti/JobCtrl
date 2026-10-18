import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { evidenceMapQuery } from "../readQueries.js";
import type { EvidenceMapEntry, EvidenceMapResponse } from "@jobctrl/contracts";

export function useEvidenceMapQuery(): UseQueryResult<EvidenceMapResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    ...evidenceMapQuery({ tenantId, ports: { api } }),
  });
}

export function useEvidenceMapEntryQuery(
  entryId: string | null,
): UseQueryResult<EvidenceMapEntry | null> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    ...evidenceMapQuery({ tenantId, ports: { api } }),
    select: (response) =>
      entryId
        ? (response.entries.find((entry) => entry.entryId === entryId) ?? null)
        : null,
  });
}
