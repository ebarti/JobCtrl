import type { CodexVerifyResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { profileKeys } from "../queryKeys.js";

export function useVerifyCodexProviderMutation(): UseMutationResult<
  CodexVerifyResponse,
  Error,
  void
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationKey: [...profileKeys.providerStatus(tenantId), "verify", "codex"],
    mutationFn: () => api.verifyCodexProvider(),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: profileKeys.providerStatus(tenantId) }),
  });
}
