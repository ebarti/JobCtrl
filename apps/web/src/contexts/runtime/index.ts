import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

const healthSchema = z.object({
  ok: z.literal(true),
  application: z.literal("jobctrl-python"),
  mode: z.enum(["local", "demo"]).optional(),
  databaseInstanceId: z.string().min(1).optional(),
  schemaVersion: z.number(),
  runtimeIdentity: z.object({ workspace: z.string(), build: z.string() }).passthrough().optional(),
  features: z.array(z.string()),
  capabilities: z.array(z.string()).optional(),
  storage: z.object({ engine: z.literal("postgresql"), status: z.literal("ready") }).optional(),
  dbos: z.object({ engine: z.literal("dbos"), available: z.boolean(), systemSchema: z.string().min(1) }).optional(),
  worker: z.object({ status: z.enum(["healthy", "unavailable"]), healthy: z.boolean(), message: z.string().optional() }).passthrough(),
  llmSpend: z.object({
    costUsd: z.number().nullable(),
    accountingComplete: z.boolean(),
    costAuthority: z.enum(["reported", "includes_estimates", "incomplete"]),
    accountingBlocked: z.boolean().optional(),
    monetaryAccountingBlocked: z.boolean().optional(),
    tokenAccountingBlockedLanes: z.array(z.string()).optional(),
    activeCalls: z.number().int().nonnegative().optional(),
    dailyActiveCalls: z.number().int().nonnegative().optional(),
    unresolvedCalls: z.number().int().nonnegative().optional(),
    costStatus: z.enum(["complete", "unavailable", "pending", "unresolved"]).optional(),
    tokenStatus: z.enum(["complete", "unavailable", "pending", "unresolved"]).optional(),
    knownCostUsd: z.number().nonnegative().optional(),
    unlimited: z.boolean().optional(),
  }).passthrough(),
}).passthrough();

export function useRuntimeHealth() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: ["tenant", tenantId, "runtime", "health"] as const,
    queryFn: async () => {
      const result = healthSchema.safeParse(await http.json<unknown>("GET", "/v1/health"));
      if (!result.success) throw new Error("The application health response is invalid.");
      return result.data;
    },
    refetchInterval: 30_000,
    staleTime: 10_000,
    retry: 1,
    meta: { suppressGlobalErrorToast: true },
  });
}

/** Unknown composition is not evidence that an optional feature is mounted. */
export function useMountedFeatures(): ReadonlySet<string> {
  return new Set(useRuntimeHealth().data?.features ?? []);
}
