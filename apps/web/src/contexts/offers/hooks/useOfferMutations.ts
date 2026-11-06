import { useMutation, useQueryClient } from "@tanstack/react-query";
import { OfferReadResponseSchema, type SaveOfferTerms, type RecordOfferDecision } from "@jobctrl/contracts";
import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { jobsKeys } from "../../jobs/index.js";
import { offerKeys } from "../queryKeys.js";

export function useOfferMutations(jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  const path = `/v1/jobs/${encodeURIComponent(jobId)}/offer`;
  const save = async (action: "terms" | "decisions", body: SaveOfferTerms | RecordOfferDecision) => {
    const response = OfferReadResponseSchema.safeParse(await http.json<unknown>("POST", `${path}/${action}`, { body }));
    if (!response.success || response.data.jobId !== jobId) {
      throw new Error("The offer was submitted but its response could not be confirmed. Reload the latest record before retrying.");
    }
    return response.data;
  };
  const settled = () => Promise.all([
    invalidateQueriesWithOptimisticOwnership(client, offerKeys.detail(tenantId, jobId)),
    invalidateQueriesWithOptimisticOwnership(client, jobsKeys.detail(tenantId, jobId)),
    // Corrected source terms can stale reviewed offer messages.
    invalidateQueriesWithOptimisticOwnership(client, ["tenant", tenantId, "outreach"]),
  ]).then(() => undefined);
  return {
    terms: useMutation({ mutationFn: (body: SaveOfferTerms) => save("terms", body), onSettled: settled }),
    decision: useMutation({ mutationFn: (body: RecordOfferDecision) => save("decisions", body), onSettled: settled }),
  };
}
