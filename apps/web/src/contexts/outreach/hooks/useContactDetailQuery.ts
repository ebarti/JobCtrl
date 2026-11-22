import type { ContactDetailResponse } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";

export function useContactDetailQuery(
  contactId: string,
): UseQueryResult<ContactDetailResponse> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: outreachKeys.contactDetail(tenantId, contactId),
    queryFn: () => http.json<ContactDetailResponse>("GET", `/v1/contacts/${encodeURIComponent(contactId)}`),
    enabled: Boolean(contactId),
  });
}
