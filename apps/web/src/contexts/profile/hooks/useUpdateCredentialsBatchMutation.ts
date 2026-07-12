import type {
  CredentialBatchUpdateRequest,
  CredentialsResponse,
} from "@jobctrl/contracts";
import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { profileKeys } from "../queryKeys.js";

export function useUpdateCredentialsBatchMutation(): UseMutationResult<
  CredentialsResponse,
  Error,
  CredentialBatchUpdateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...profileKeys.credentials(tenantId), "batch"],
    mutationFn: (body) => api.updateCredentialsBatch(body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: profileKeys.credentials(tenantId) }),
        queryClient.invalidateQueries({ queryKey: profileKeys.providerStatus(tenantId) }),
      ]);
    },
  });
}
