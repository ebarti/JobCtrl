import type { ProfileUpdateRequest } from "@jobctl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { ProfileConfigResponse } from "../../operations/types.js";
import { patchProfileResponse } from "../lib/profile-patches.js";
import { profileKeys } from "../queryKeys.js";

export function useUpdateProfileMutation(): UseMutationResult<
  ProfileConfigResponse,
  Error,
  ProfileUpdateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ProfileConfigResponse, ProfileUpdateRequest>(queryClient, {
      mutationKey: profileKeys.profile(tenantId),
      mutationFn: (body) => api.updateProfile(body),
      optimisticUpdates: (body) => [
        {
          queryKey: profileKeys.profile(tenantId),
          patch: (current) => patchProfileResponse(current, body),
        },
      ],
      // Profile changes affect downstream scoring (job lists) and dashboard counts.
      settle: () => [
        profileKeys.profile(tenantId),
        jobsKeys.lists(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}
