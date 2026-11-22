import type { ProfileUpdateRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import type { ProfileConfigResponse } from "@jobctrl/contracts";
import { patchProfileResponse } from "../lib/profile-patches.js";
import { profileKeys } from "../queryKeys.js";
import { updateProfile } from "../client.js";

export function useUpdateProfileMutation(options: { optimistic?: boolean; workspaceIdentity?: string | undefined } = {}): UseMutationResult<
  ProfileConfigResponse,
  Error,
  ProfileUpdateRequest
> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ProfileConfigResponse, ProfileUpdateRequest>(queryClient, {
      mutationKey: profileKeys.profile(tenantId),
      mutationFn: (body) => updateProfile(http, body, options.workspaceIdentity),
      ...(options.optimistic === false ? {} : {
        optimisticUpdates: (body: ProfileUpdateRequest) => [
          {
            queryKey: profileKeys.profile(tenantId),
            patch: (current: unknown) => patchProfileResponse(current, body),
          },
        ],
      }),
      // Jobs/Fit own their cross-feature event invalidation; Profile owns its cache.
      settle: () => [profileKeys.profile(tenantId)],
    }),
  );
}
