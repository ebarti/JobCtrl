import type { ExtensionCapabilityTokenResponse } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { profileKeys } from "../queryKeys.js";

export function useRotateExtensionCapabilityTokenMutation(): UseMutationResult<
  ExtensionCapabilityTokenResponse,
  Error,
  void
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: profileKeys.extensionPairing(tenantId),
    mutationFn: () => api.rotateExtensionCapabilityToken(),
    onSuccess: (response) => {
      queryClient.setQueryData(profileKeys.extensionPairing(tenantId), response);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: profileKeys.extensionPairing(tenantId) });
    },
  });
}
