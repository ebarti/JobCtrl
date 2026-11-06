import { useQuery } from "@tanstack/react-query";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import type { CompensationEvidenceResponse } from "../contracts.js";
import { compensationKeys } from "../queryKeys.js";
import { compensationEvidenceEnvelope } from "../responseSchemas.js";

export function useCompensationEvidenceQuery(jobId: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: compensationKeys.evidence(tenantId, jobId),
    queryFn: async () => {
      const value = await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/compensation`);
      const parsed = compensationEvidenceEnvelope.safeParse(value);
      if (!parsed.success || !belongsToJob(parsed.data.audit, jobId)) {
        throw new Error("Compensation evidence could not be verified.");
      }
      return value as CompensationEvidenceResponse;
    },
    meta: { suppressGlobalErrorToast: true },
  });
}

function belongsToJob(audit: unknown, jobId: string): boolean {
  if (audit === null) return true;
  if (!audit || typeof audit !== "object") return false;
  const value = audit as Record<string, unknown>;
  return [value.posted, value.market].every((entry) => {
    if (!entry || typeof entry !== "object") return false;
    const row = entry as Record<string, unknown>;
    const nested = row.recordStatus === "recorded" ? (row.fact ?? row.estimate) : row;
    return Boolean(nested && typeof nested === "object" && (nested as Record<string, unknown>).jobId === jobId);
  });
}
