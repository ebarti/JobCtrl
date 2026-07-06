import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { digestKeys } from "../digestKeys.js";
import type { DailyDigest, DigestAcknowledgeRequest, DigestAcknowledgeResponse } from "../types.js";

export function useDigestQuery(): UseQueryResult<DailyDigest> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: digestKeys.summary(tenantId),
    queryFn: () => api.digest(),
    staleTime: 0,
    refetchOnMount: "always",
  });
}

export function useAcknowledgeDigestMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation<DigestAcknowledgeResponse, Error, DigestAcknowledgeRequest | undefined>({
    mutationFn: (body) => api.acknowledgeDigest(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: digestKeys.all(tenantId) });
    },
  });
}
