import type { ProfileImportRequest, ProfileImportResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { profileKeys } from "../queryKeys.js";
import { importResume } from "../client.js";

export function useImportResumeMutation(): UseMutationResult<
  ProfileImportResponse,
  Error,
  ProfileImportRequest
> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ProfileImportResponse, ProfileImportRequest>(queryClient, {
      mutationKey: profileKeys.profile(tenantId),
      mutationFn: (body) => importResume(http, body),
      settle: () => [profileKeys.profile(tenantId)],
    }),
  );
}
