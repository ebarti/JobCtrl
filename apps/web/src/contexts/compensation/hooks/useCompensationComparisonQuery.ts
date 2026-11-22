import type { MarketCompensationEstimateResponse, PostedCompensationFactResponse } from "@jobctrl/contracts";
import { useQuery } from "@tanstack/react-query";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { compensationKeys } from "../queryKeys.js";
import { marketEvidenceRead, postedEvidenceRead } from "../responseSchemas.js";

/** Read-only comparison; recorded terms and compensation retain separate authority. */
export function useCompensationComparisonQuery(jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: compensationKeys.comparison(tenantId, jobId),
    queryFn: async () => {
      const path = `/v1/jobs/${encodeURIComponent(jobId)}/compensation`;
      const [posted, market] = await Promise.all([
        http.json<unknown>("GET", `${path}/posted`),
        http.json<unknown>("GET", `${path}/market`),
      ]);
      if (!postedEvidenceRead.safeParse(posted).success || !marketEvidenceRead.safeParse(market).success ||
          !belongsToJob(posted, jobId, "fact") || !belongsToJob(market, jobId, "estimate")) {
        throw new Error("Compensation evidence could not be verified for this job.");
      }
      return { posted: posted as PostedCompensationFactResponse & { sourceCurrent?: boolean; sourceRevision?: number | null },
        market: market as MarketCompensationEstimateResponse & { sourceCurrent?: boolean; sourceRevision?: number | null; evidenceFresh?: boolean; evidenceFreshUntil?: string | null } };
    },
  });
}

function belongsToJob(value: unknown, jobId: string, record: "fact" | "estimate"): boolean {
  if (!value || typeof value !== "object") return false;
  const outer = value as Record<string, unknown>;
  const inner = outer[record];
  const identity = inner && typeof inner === "object" ? (inner as Record<string, unknown>).jobKey : outer.jobKey;
  return identity === jobId;
}
