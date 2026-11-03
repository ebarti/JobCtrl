import type { ProfileUpdateRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { ProfileConfigResponse } from "@jobctrl/contracts";
import { patchProfileResponse } from "../lib/profile-patches.js";
import { profileKeys } from "../queryKeys.js";

export function useUpdateProfileMutation(options: { optimistic?: boolean } = {}): UseMutationResult<
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
      ...(options.optimistic === false ? {} : {
        optimisticUpdates: (body: ProfileUpdateRequest) => [
          {
            queryKey: profileKeys.profile(tenantId),
            patch: (current: unknown) => patchProfileResponse(current, body),
          },
        ],
      }),
      // Profile changes affect downstream scoring (job lists) and dashboard counts.
      settle: () => [
        profileKeys.profile(tenantId),
        jobsKeys.lists(tenantId),
        jobsKeys.details(tenantId),
        dashboardKeys.summary(tenantId),
      ],
    }),
  );
}
