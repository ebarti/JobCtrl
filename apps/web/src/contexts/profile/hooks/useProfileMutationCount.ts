import { useMutationState } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { profileKeys } from "../queryKeys.js";

export function useProfileMutationCount(): number {
  const tenantId = useTenantId();
  const submittedAt = useMutationState({
    filters: {
      mutationKey: profileKeys.profile(tenantId),
      status: "success",
    },
    select: (mutation) => mutation.state.submittedAt,
  });
  return submittedAt.length;
}
