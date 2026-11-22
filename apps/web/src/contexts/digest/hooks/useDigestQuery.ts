import type { DigestAcknowledgeRequest, DigestAcknowledgeResponse } from "@jobctrl/contracts";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { digestKeys } from "../queryKeys.js";
import { digestQuery } from "../readQueries.js";

export function useDigestQuery() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({ ...digestQuery({ tenantId, ports: { http } }), staleTime: 0, refetchOnMount: "always" });
}
export function useAcknowledgeDigestMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DigestAcknowledgeRequest | undefined) => http.json<DigestAcknowledgeResponse>("POST", "/v1/digest/acknowledge", { body: body ?? {} }),
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: digestKeys.all(tenantId) }); },
  });
}
