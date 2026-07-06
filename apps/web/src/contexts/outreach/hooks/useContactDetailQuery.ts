import type { ContactDetailResponse } from "@jobhunter/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export function useContactDetailQuery(
  contactId: string,
): UseQueryResult<ContactDetailResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: outreachKeys.contactDetail(tenantId, contactId),
    queryFn: () => api.contact(contactId),
    enabled: Boolean(contactId),
  });
}
