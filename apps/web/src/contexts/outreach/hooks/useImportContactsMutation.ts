import type { ContactImportRequest, ContactImportResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export function useImportContactsMutation(): UseMutationResult<
  ContactImportResponse,
  Error,
  ContactImportRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  // Plain mutation, not createOptimisticMutation: a bulk CSV import has no
  // meaningful client-side patch (imported count and contact ids are derived
  // server-side), so it only invalidates the contact lists once settled.
  return useMutation({
    mutationKey: outreachKeys.contacts(tenantId),
    mutationFn: (body: ContactImportRequest) => api.importContacts(body),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: outreachKeys.contactLists(tenantId) });
    },
  });
}
