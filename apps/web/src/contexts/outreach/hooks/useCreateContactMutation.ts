import type { ContactCreateRequest, ContactListResponse, ContactMutationResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { applyPartialQueryPatch, createOptimisticMutation, type OptimisticContext } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { reconcileContactListsAfterInitialReads } from "../lib/contact-list-reconciliation.js";
import { contactListMayInclude, matchesContactList, prependContactSummary, provisionalContactSummary, reconcileCreatedContact } from "../lib/contact-patches.js";
import { outreachKeys } from "../queryKeys.js";

export function useCreateContactMutation(): UseMutationResult<
  ContactMutationResponse,
  Error,
  ContactCreateRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  const listPrefix = outreachKeys.contactLists(tenantId);
  const options = createOptimisticMutation<ContactMutationResponse, ContactCreateRequest>(queryClient, {
    mutationKey: outreachKeys.contacts(tenantId),
    mutationFn: (body) => api.createContact(body),
    settle: () => [listPrefix],
  });
  type CreateContext = OptimisticContext & { readonly provisionalId: string };
  return useMutation<ContactMutationResponse, Error, ContactCreateRequest, CreateContext>({
    ...options,
    onMutate: async (body, mutationContext) => {
      const summary = provisionalContactSummary(body);
      const scoped = createOptimisticMutation<ContactMutationResponse, ContactCreateRequest>(queryClient, {
        mutationFn: (variables) => api.createContact(variables),
        optimisticUpdates: () => [{
          queryKey: outreachKeys.contactLists(tenantId),
          exact: false,
          publicationTag: { kind: "contact-create", provisionalId: summary.contactId },
          // There is no provisional list patch before the first accepted read.
          // Keep that GET and its joined loaders; settlement reconciles it once.
          isRelevant: (current, _variables, queryKey) => current !== undefined && contactListMayInclude(queryKey, listPrefix.length, summary),
          patch: (current, _variables, queryKey) => matchesContactList(queryKey, listPrefix.length, summary)
            ? prependContactSummary(current, summary) : current,
        }],
      });
      const context = await scoped.onMutate!(body, mutationContext);
      if (!context) throw new Error("Contact creation could not establish optimistic ownership.");
      return { ...context, provisionalId: summary.contactId };
    },
    onSuccess: (response, _body, context) => {
      if (!context) return;
      for (const query of queryClient.getQueryCache().findAll({ queryKey: listPrefix })) {
        const current = query.state.data as ContactListResponse | undefined;
        if (!Array.isArray(current?.items) || !current.items.some((item) => item.contactId === context.provisionalId)) continue;
        const included = matchesContactList(query.queryKey, listPrefix.length, response.contact);
        applyPartialQueryPatch(queryClient, query, (current) =>
          reconcileCreatedContact(current, context.provisionalId, response.contact, included),
        { publicationTag: { kind: "contact", contactId: response.contact.contactId } });
      }
    },
    onSettled: (...args) => {
      reconcileContactListsAfterInitialReads(queryClient, listPrefix);
      return options.onSettled?.(...args);
    },
  });
}
