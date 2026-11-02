import type { ContactDeleteRequest, ContactDeleteResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { createOptimisticMutation, type OptimisticContext } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { reconcileContactListsAfterInitialReads } from "../lib/contact-list-reconciliation.js";
import { publishContactResponse, snapshotContactLists } from "../lib/contact-patches.js";
import { outreachKeys } from "../queryKeys.js";

export interface DeleteContactVariables {
  contactId: string;
  reason?: string;
}

type DeleteContext = OptimisticContext & { readonly listSnapshots: ReturnType<typeof snapshotContactLists> };

export function useDeleteContactMutation(): UseMutationResult<
  ContactDeleteResponse,
  Error,
  DeleteContactVariables
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const listPrefix = outreachKeys.contactLists(tenantId);
  const options = createOptimisticMutation<ContactDeleteResponse, DeleteContactVariables>(queryClient, {
    mutationKey: outreachKeys.contacts(tenantId),
    mutationFn: ({ contactId, reason }) => {
      const body: ContactDeleteRequest = reason ? { reason } : {};
      return api.deleteContact(contactId, body);
    },
    settle: () => [listPrefix, outreachKeys.dueFollowUps(tenantId)],
  });
  return useMutation<ContactDeleteResponse, Error, DeleteContactVariables, DeleteContext>({
    ...options,
    onMutate: async (variables, mutationContext) => {
      const listSnapshots = snapshotContactLists(queryClient, listPrefix, variables.contactId);
      try {
        const context = await options.onMutate!(variables, mutationContext);
        if (!context) throw new Error("Contact deletion could not establish optimistic ownership.");
        return { ...context, listSnapshots };
      } catch (error) {
        for (const snapshot of listSnapshots) snapshot.dispose();
        throw error;
      }
    },
    onSuccess: (response, variables, context) => {
      if (context && response.contactId === variables.contactId) {
        publishContactResponse(queryClient, listPrefix, context.listSnapshots, { kind: "delete", contactId: response.contactId });
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
