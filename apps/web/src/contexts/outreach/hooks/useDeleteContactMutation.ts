import type { ContactDeleteRequest, ContactDeleteResponse } from "@jobctl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { removeContactFromList } from "../lib/contact-patches.js";
import { outreachKeys } from "../queryKeys.js";

export interface DeleteContactVariables {
  contactId: string;
  reason?: string;
}

export function useDeleteContactMutation(): UseMutationResult<
  ContactDeleteResponse,
  Error,
  DeleteContactVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ContactDeleteResponse, DeleteContactVariables>(queryClient, {
      mutationKey: outreachKeys.contacts(tenantId),
      mutationFn: ({ contactId, reason }) => {
        const body: ContactDeleteRequest = reason ? { reason } : {};
        return api.deleteContact(contactId, body);
      },
      optimisticUpdates: ({ contactId }) => [
        {
          queryKey: outreachKeys.contactLists(tenantId),
          exact: false,
          patch: (current) => removeContactFromList(current, contactId),
        },
      ],
      settle: () => [outreachKeys.contactLists(tenantId), outreachKeys.dueFollowUps(tenantId)],
    }),
  );
}
