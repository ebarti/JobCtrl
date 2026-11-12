import { useQuery } from "@tanstack/react-query";
import { ModelReceiptSchema } from "@jobctrl/contracts";
import { z } from "zod";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";

const querySchema = z.object({ query: z.string(), tier: z.number(), source_scope: z.array(z.string()),
  authority: z.string().optional(), rationale: z.string().optional(),
  citations: z.array(z.object({ source_id: z.string(), quote: z.string() }).passthrough()).optional() }).passthrough();
const targetPlanSchema = z.object({ ok: z.literal(true), current: z.boolean(), accepted: z.object({
  planId: z.string(), profileRevision: z.number(), profileFingerprint: z.string(), queries: z.array(querySchema),
  locations: z.array(z.object({ location: z.string(), remote: z.boolean() }).passthrough()),
  provenance: ModelReceiptSchema.nullable(), createdAt: z.string(),
}).passthrough().nullable(), targets: z.record(z.string(), z.unknown()), profileRevision: z.number().int().positive().optional() }).passthrough();

/** A local saved-plan read. It never refreshes a plan or contacts a provider. */
export function useDiscoveryTargetPlanQuery() {
  const tenant = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: discoveryKeys.targetPlan(tenant),
    queryFn: async () => targetPlanSchema.parse(await http.json<unknown>("GET", "/v1/discovery/target-search")) });
}
