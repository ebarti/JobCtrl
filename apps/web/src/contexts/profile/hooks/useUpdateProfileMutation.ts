import type { ProfileUpdateRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { patchProfileResponse } from "../lib/profile-patches.js";
import { isJsonRecord } from "../lib/json-record.js";
import { profileKeys } from "../queryKeys.js";
import { updateProfile, type ProfileSnapshot } from "../client.js";

type ProfileUpdateVariables = ProfileUpdateRequest & { expectedDatabaseInstanceId?: string };

export function useUpdateProfileMutation(options: { optimistic?: boolean; workspaceIdentity?: string | undefined } = {}): UseMutationResult<
  ProfileSnapshot,
  Error,
  ProfileUpdateVariables
> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ProfileSnapshot, ProfileUpdateVariables>(queryClient, {
      mutationKey: profileKeys.profile(tenantId),
      mutationFn: ({ expectedDatabaseInstanceId, ...body }) => updateProfile(
        http, body, expectedDatabaseInstanceId ?? options.workspaceIdentity,
      ),
      ...(options.optimistic === false ? {} : {
        optimisticUpdates: (body: ProfileUpdateVariables) => [
          {
            queryKey: profileKeys.profile(tenantId),
            isRelevant: (current: unknown) => {
              const source = body.expectedDatabaseInstanceId ?? options.workspaceIdentity;
              return source === undefined || (isJsonRecord(current) && current["databaseInstanceId"] === source);
            },
            patch: (current: unknown) => patchProfileResponse(current, body),
          },
        ],
      }),
      // Jobs/Fit own their cross-feature event invalidation; Profile owns its cache.
      settle: () => [profileKeys.profile(tenantId)],
    }),
  );
}
