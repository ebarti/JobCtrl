import type { ContactMutationResponse, ContactUpdateRequest } from "@jobhunter/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { patchContactDetail, patchContactSummaryInList } from "../lib/contact-patches.js";
import { outreachKeys } from "../queryKeys.js";

export interface UpdateContactVariables {
  contactId: string;
  body: ContactUpdateRequest;
}

export function useUpdateContactMutation(): UseMutationResult<
  ContactMutationResponse,
  Error,
  UpdateContactVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<ContactMutationResponse, UpdateContactVariables>(queryClient, {
      mutationKey: outreachKeys.contacts(tenantId),
      mutationFn: ({ contactId, body }) => api.updateContact(contactId, body),
      optimisticUpdates: ({ contactId, body }) => [
        {
          queryKey: outreachKeys.contactDetail(tenantId, contactId),
          patch: (current) => patchContactDetail(current, body),
        },
        {
          queryKey: outreachKeys.contactLists(tenantId),
          exact: false,
          patch: (current) => patchContactSummaryInList(current, contactId, body),
        },
      ],
      settle: ({ contactId }) => [
        outreachKeys.contactDetail(tenantId, contactId),
        outreachKeys.contactLists(tenantId),
      ],
    }),
  );
}
