import { useQuery } from "@tanstack/react-query";
import { z } from "zod";

import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

const count = z.number().int().nonnegative();
const seconds = z.number().finite().nonnegative().nullable();
const caveats = z.array(z.string());
const sample = z.object({ runId: z.string(), jobId: z.string().nullable(), startEventId: z.string(),
  endEventId: z.string(), seconds: z.number().finite().positive() });
const stage = z.object({
  stage: z.string(), scope: z.string(), expectedCount: count.nullable(), recordedCount: count,
  statusCounts: z.record(z.string(), count), unrecordedCount: count.nullable(),
  running: z.array(z.object({ jobId: z.string().nullable(), recordedStartAt: z.string().nullable(),
    startEventId: z.string().nullable(), secondsSinceRecordedStart: seconds, unclosedPreviousStart: z.boolean() })),
  duration: z.object({ sampleCount: count, minimumSeconds: seconds, medianSeconds: seconds,
    maximumSeconds: seconds, samples: z.array(sample), caveats }),
});
const cohort = z.object({
  runId: z.string(), recipe: z.string(), status: z.string(), parentRunId: z.string().nullable(),
  scope: z.string(), cohortFrozen: z.boolean(), jobIds: z.array(z.string()),
  jobConcurrency: count.nullable(), createdAt: z.string(), updatedAt: z.string(),
  actionRun: z.object({ runId: z.string(), workflowId: z.string(), status: z.string(),
    updatedAt: z.string(), cancellationRequested: z.boolean() }).nullable(),
  stages: z.array(stage),
  eta: z.object({ available: z.boolean(), lowerSeconds: seconds, upperSeconds: seconds,
    sampleCount: count, basis: z.string(), caveats }),
  caveats,
});
const availableLanes = z.object({ available: z.literal(true), observedAt: z.string(), defaultCapacity: count,
  lanes: z.array(z.object({ lane: z.string(), capacity: count, active: count, unresolved: count,
    availableCapacity: count.nullable() })), monetarySerialization: z.boolean(), budgetBusy: z.boolean(), caveats });
const unavailableLanes = z.object({ available: z.literal(false), errorCode: z.string(), caveats });
const family = z.object({ sourceFamily: z.string(), knownUnitCount: count,
  statusCounts: z.record(z.string(), count), totalCompleteness: z.string() });
const discovery = z.discriminatedUnion("available", [
  z.object({ available: z.literal(true), observedAt: z.string(), caveats,
    runs: z.array(z.object({ runId: z.string(), status: z.string(), knownUnitCount: count,
      completedUnitCount: count, totalCompleteness: z.string(), families: z.array(family) })) }),
  z.object({ available: z.literal(false), errorCode: z.string() }),
]);
const pipelineTelemetrySchema = z.object({
  ok: z.literal(true), observedAt: z.string(),
  cohorts: z.object({ available: z.boolean(), historyLimit: count, historyComplete: z.boolean(),
    displayLimit: count.optional(), displayComplete: z.boolean().optional(),
    selectedRunId: z.string().nullable(), runs: z.array(cohort), caveats }),
  worker: z.object({ available: z.boolean(), observedAt: z.string(), readiness: z.string().nullable(),
    healthy: z.boolean().nullable(), heartbeatAt: z.string().nullable(), heartbeatAgeSeconds: z.number().finite().nullable(),
    configuredActivitySlots: count.nullable(), activeActivitySlots: count.nullable(),
    availableActivitySlots: count.nullable(), caveats }),
  modelLanes: z.discriminatedUnion("available", [availableLanes, unavailableLanes]),
  discovery,
  history: z.object({ available: z.boolean(), since: z.string(), until: z.string(), eventCount: count,
    complete: z.boolean(), caveats }),
  caveats,
});

const telemetryKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "preparation", "telemetry"] as const,
  selected: (tenantId: string, runId: string | undefined) => [...telemetryKeys.all(tenantId), runId ?? ""] as const,
};

export function usePipelineTelemetry(runId?: string) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  return useQuery({
    queryKey: telemetryKeys.selected(tenantId, runId),
    queryFn: async () => {
      const value = await http.json<unknown>("GET", "/v1/telemetry/pipeline", { query: { runId } });
      const parsed = pipelineTelemetrySchema.safeParse(value);
      if (!parsed.success) throw new Error("Pipeline telemetry could not be verified.");
      return parsed.data;
    },
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
    meta: { suppressGlobalErrorToast: true },
  });
}

export const pipelineTelemetryEvents: FeatureEventHandler = {
  eventTypes: ["PreparationUpdated", "ActionQueued", "ActionStarted", "ActionCompleted", "ActionFailed",
    "ActionCancellationRequested", "DiscoveryRunUpdated", "SettingsUpdated"],
  handle(event, client) { void invalidateQueriesWithOptimisticOwnership(client, telemetryKeys.all(event.tenantId)); },
};
