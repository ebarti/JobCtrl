import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { SaveOfferTerms, RecordOfferDecision } from "@jobctrl/contracts";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outcomesKeys } from "../../operations/outcomesKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import type { JobId } from "../../operations/types.js";

export function useOfferMutations(jobId: JobId) {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const client = useQueryClient();
  const settled = () => {
    void client.invalidateQueries({
      queryKey: outcomesKeys.detail(tenantId, jobId),
    });
    void client.invalidateQueries({ queryKey: outcomesKeys.lists(tenantId) });
    void client.invalidateQueries({
      queryKey: jobsKeys.detail(tenantId, jobId),
    });
    void client.invalidateQueries({
      queryKey: dashboardKeys.summary(tenantId),
    });
    // A corrected source may make previously reviewed offer messages stale.
    void client.invalidateQueries({
      queryKey: ["tenant", tenantId, "outreach"],
    });
  };
  return {
    terms: useMutation({
      mutationFn: (body: SaveOfferTerms) => api.saveOfferTerms(jobId, body),
      onSettled: settled,
    }),
    decision: useMutation({
      mutationFn: (body: RecordOfferDecision) =>
        api.recordOfferDecision(jobId, body),
      onSettled: settled,
    }),
  };
}
