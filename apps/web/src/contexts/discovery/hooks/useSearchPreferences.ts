import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";

export function useSearchPreferences(version: number | undefined) {
  const { api } = usePorts();
  const tenantId = useTenantId();
  const client = useQueryClient();
  const key = discoveryKeys.preferences(tenantId, version);
  const query = useQuery({
    queryKey: key,
    enabled: version !== undefined,
    queryFn: () =>
      api.searchPreferences({
        operation: "read",
        expectedProfileVersion: version!,
      }),
  });
  const mutation = useMutation({
    mutationKey: key,
    mutationFn: (operation: "prepare" | "confirm") =>
      api.searchPreferences({
        operation,
        expectedProfileVersion: version!,
        ...(operation === "confirm"
          ? { determinationId: query.data!.determination!.determination_id }
          : {}),
      }),
    onSuccess: (data) => client.setQueryData(key, data),
  });
  return { query, mutation };
}
