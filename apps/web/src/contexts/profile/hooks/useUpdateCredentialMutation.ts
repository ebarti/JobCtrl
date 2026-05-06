import type { CredentialUpdateRequest } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import type { CredentialsResponse } from "../../operations/types.js";
import { patchCredentialConfigured } from "../lib/profile-patches.js";
import { profileKeys } from "../queryKeys.js";

export function useUpdateCredentialMutation(): UseMutationResult<
  CredentialsResponse,
  Error,
  CredentialUpdateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<CredentialsResponse, CredentialUpdateRequest>(queryClient, {
      mutationKey: profileKeys.credentials(tenantId),
      mutationFn: (body) => api.updateCredential(body),
      optimisticUpdates: (body) => [
        {
          queryKey: profileKeys.credentials(tenantId),
          patch: (current) => patchCredentialConfigured(current, body.key, true),
        },
      ],
      settle: () => [profileKeys.credentials(tenantId)],
    }),
  );
}
