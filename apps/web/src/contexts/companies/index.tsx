import { AcceptedCompanyBriefingSchema, CompanyBriefingAttemptSchema, CompanyBriefingConfigSchema } from "@jobctrl/contracts";
import type { TenantId } from "@jobctrl/domain-types";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { CompanyBriefingPanel } from "./components/CompanyBriefingPanel.js";

export const companyKeys = {
  all: (tenantId: TenantId) => ["tenant", tenantId, "companies"] as const,
  briefing: (tenantId: TenantId, jobId: string) => [...companyKeys.all(tenantId), "briefing", jobId] as const,
};
const CompanyBriefingViewSchema = z.object({
  company: CompanyBriefingConfigSchema.nullable(), accepted: AcceptedCompanyBriefingSchema.nullable(),
  lastAttempt: CompanyBriefingAttemptSchema.nullable(), staleReasons: z.array(z.string()),
  status: z.enum(["current", "stale", "missing", "needs_review", "unavailable"]),
}).strict().nullable();

export function CompanyBriefingForJob({ jobId }: { readonly jobId: string }) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const briefing = useQuery({
    queryKey: companyKeys.briefing(tenantId, jobId),
    queryFn: async () => CompanyBriefingViewSchema.parse(await http.json<unknown>("GET", `/v1/jobs/${encodeURIComponent(jobId)}/company-briefing`)),
    enabled: Boolean(jobId),
  });
  return <>
    {briefing.error ? <p role="alert">Company briefing could not be refreshed. {briefing.data ? "The last loaded briefing remains below." : "Retry loading it."}</p> : null}
    <CompanyBriefingPanel briefing={briefing.data} />
  </>;
}

export const companyEvents: FeatureEventHandler = {
  eventTypes: ["CompanyBriefingUpdated"],
  handle(event, queryClient) {
    const payload = event.payload;
    const jobId = payload && typeof payload === "object" && "jobId" in payload && typeof payload.jobId === "string" ? payload.jobId : null;
    void invalidateQueriesWithOptimisticOwnership(queryClient, jobId ? companyKeys.briefing(event.tenantId, jobId) : companyKeys.all(event.tenantId));
  },
};
