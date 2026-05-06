import type { CredentialKey } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import type { CredentialsResponse } from "../../operations/types.js";
import { patchCredentialConfigured } from "../lib/profile-patches.js";
import { profileKeys } from "../queryKeys.js";

export function useDeleteCredentialMutation(): UseMutationResult<
  CredentialsResponse,
  Error,
  CredentialKey
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<CredentialsResponse, CredentialKey>(queryClient, {
      mutationKey: profileKeys.credentials(tenantId),
      mutationFn: (key) => api.deleteCredential(key),
      optimisticUpdates: (key) => [
        {
          queryKey: profileKeys.credentials(tenantId),
          patch: (current) => patchCredentialConfigured(current, key, false),
        },
      ],
      settle: () => [profileKeys.credentials(tenantId)],
    }),
  );
}
