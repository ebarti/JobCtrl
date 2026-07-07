import type { ContactCreateRequest, ContactMutationResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { prependContactSummary, provisionalContactSummary } from "../lib/contact-patches.js";
import { outreachKeys } from "../queryKeys.js";

export function useCreateContactMutation(): UseMutationResult<
  ContactMutationResponse,
  Error,
  ContactCreateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ContactMutationResponse, ContactCreateRequest>(queryClient, {
      mutationKey: outreachKeys.contacts(tenantId),
      mutationFn: (body) => api.createContact(body),
      optimisticUpdates: (body) => [
        {
          queryKey: outreachKeys.contactLists(tenantId),
          exact: false,
          patch: (current) => prependContactSummary(current, provisionalContactSummary(body)),
        },
      ],
      settle: () => [outreachKeys.contactLists(tenantId)],
    }),
  );
}
