import type { ContactMutationResponse, ContactUpdateRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation, type OptimisticContext } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { reconcileContactListsAfterInitialReads } from "../lib/contact-list-reconciliation.js";
import { patchContactDetail, publishContactResponse, snapshotContactLists } from "../lib/contact-patches.js";
import { outreachKeys } from "../queryKeys.js";

export interface UpdateContactVariables {
  contactId: string;
  body: ContactUpdateRequest;
}

type UpdateContext = OptimisticContext & { readonly listSnapshots: ReturnType<typeof snapshotContactLists> };

export function useUpdateContactMutation(): UseMutationResult<
  ContactMutationResponse,
  Error,
  UpdateContactVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const listPrefix = outreachKeys.contactLists(tenantId);
  const options = createOptimisticMutation<ContactMutationResponse, UpdateContactVariables>(queryClient, {
    mutationKey: outreachKeys.contacts(tenantId),
    mutationFn: ({ contactId, body }) => api.updateContact(contactId, body),
    optimisticUpdates: ({ contactId, body }) => [{
      queryKey: outreachKeys.contactDetail(tenantId, contactId),
      patch: (current) => patchContactDetail(current, body),
    }],
    settle: ({ contactId }) => [outreachKeys.contactDetail(tenantId, contactId), listPrefix],
  });
  return useMutation<ContactMutationResponse, Error, UpdateContactVariables, UpdateContext>({
    ...options,
    onMutate: async (variables, mutationContext) => {
      const listSnapshots = snapshotContactLists(queryClient, listPrefix, variables.contactId);
      try {
        const context = await options.onMutate!(variables, mutationContext);
        if (!context) throw new Error("Contact update could not establish optimistic ownership.");
        return { ...context, listSnapshots };
      } catch (error) {
        for (const snapshot of listSnapshots) snapshot.dispose();
        throw error;
      }
    },
    onSuccess: (response, variables, context) => {
      if (context && response.contact.contactId === variables.contactId) {
        publishContactResponse(queryClient, listPrefix, context.listSnapshots, { kind: "update", contact: response.contact });
      }
    },
    onSettled: (...args) => {
      try {
        reconcileContactListsAfterInitialReads(queryClient, listPrefix);
        return options.onSettled?.(...args);
      } finally {
        for (const snapshot of args[3]?.listSnapshots ?? []) snapshot.dispose();
      }
    },
  });
}
