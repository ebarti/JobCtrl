import type { ContactListResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export type ContactsListFilters = {
  jobId?: string;
  employer?: string;
};

export function useContactsListQuery(
  filters: ContactsListFilters = {},
): UseQueryResult<ContactListResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: outreachKeys.contactList(tenantId, filters),
    queryFn: () => api.listContacts(filters),
  });
}
