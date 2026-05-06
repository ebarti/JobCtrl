import type { ProfileImportRequest, ProfileImportResponse } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { profileKeys } from "../queryKeys.js";

export function useImportResumeMutation(): UseMutationResult<
  ProfileImportResponse,
  Error,
  ProfileImportRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ProfileImportResponse, ProfileImportRequest>(queryClient, {
      mutationKey: profileKeys.profile(tenantId),
      mutationFn: (body) => api.importResume(body),
      settle: () => [profileKeys.profile(tenantId)],
    }),
  );
}
