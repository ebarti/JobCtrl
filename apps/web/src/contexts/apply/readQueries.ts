import { useQuery } from "@tanstack/react-query";

import type { HttpPort } from "../../shared/ports/HttpPort.js";
import type { HttpLoaderReadContext } from "../../shared/lib/loaderReadContext.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import {
  actionRunSchema,
  applicationQueueSchema,
  applicationResponseSchema,
  repeatApplicationSchema,
  type Application,
} from "./contracts.js";
import { applyKeys } from "./queryKeys.js";

export async function readApplication(
  http: HttpPort,
  jobId: string,
): Promise<Application> {
  const parsed = applicationResponseSchema.safeParse(
    await http.json<unknown>(
      "GET",
      `/v1/jobs/${encodeURIComponent(jobId)}/application`,
    ),
  );
  if (!parsed.success || parsed.data.application.jobId !== jobId)
    throw new Error(
      "The application response is invalid. Retained review evidence remains unchanged.",
    );
  return parsed.data.application;
}

function queueOptions(tenantId: string, http: HttpPort) {
  return {
    queryKey: applyKeys.queue(tenantId),
    queryFn: async () => {
      const parsed = applicationQueueSchema.safeParse(
        await http.json<unknown>("GET", "/v1/apply/review"),
      );
      if (!parsed.success)
        throw new Error("The application review queue is invalid.");
      return parsed.data.items;
    },
  };
}

function applicationOptions(tenantId: string, http: HttpPort, jobId: string) {
  return {
    queryKey: applyKeys.application(tenantId, jobId),
    enabled: Boolean(jobId),
    queryFn: () => readApplication(http, jobId),
    structuralSharing: (previous: unknown, incoming: unknown) => {
      const current = previous as Application | undefined;
      const next = incoming as Application;
      return current && current.version > next.version ? current : next;
    },
    meta: { suppressGlobalErrorToast: true },
  };
}

export function useApplicationQuery(jobId: string) {
  const { http } = usePorts();
  const tenantId = useTenantId();
  return useQuery(applicationOptions(tenantId, http, jobId));
}

export function useApplicationQueueQuery() {
  const { http } = usePorts();
  const tenantId = useTenantId();
  return useQuery({
    ...queueOptions(tenantId, http),
    meta: { suppressGlobalErrorToast: true },
  });
}

export function useRepeatApplicationQuery(jobId: string) {
  const { http } = usePorts();
  const tenantId = useTenantId();
  return useQuery({
    queryKey: applyKeys.repeat(tenantId, jobId),
    queryFn: async () => {
      const parsed = repeatApplicationSchema.safeParse(
        await http.json<unknown>(
          "GET",
          `/v1/jobs/${encodeURIComponent(jobId)}/repeat-application`,
        ),
      );
      if (!parsed.success || parsed.data.jobId !== jobId)
        throw new Error("The repeat-application assessment is invalid.");
      return parsed.data;
    },
    meta: { suppressGlobalErrorToast: true },
  });
}

export function prefetchApplicationQueue(context: HttpLoaderReadContext) {
  return context.queryClient.prefetchQuery(
    queueOptions(context.tenantId, context.ports.http),
  );
}

export function useApplicationActionRun(runId: string | null) {
  const { http } = usePorts();
  const tenantId = useTenantId();
  return useQuery({
    queryKey: applyKeys.action(tenantId, runId ?? ""),
    enabled: Boolean(runId),
    queryFn: () => readApplicationActionRun(http, runId ?? ""),
    refetchInterval: (query) =>
      !query.state.data ||
      ["pending", "queued", "running"].includes(query.state.data.status)
        ? 1500
        : false,
    meta: { suppressGlobalErrorToast: true },
  });
}

async function readApplicationActionRun(http: HttpPort, runId: string) {
  const parsed = actionRunSchema.safeParse(
    await http.json<unknown>(
      "GET",
      `/v1/action-runs/${encodeURIComponent(runId)}`,
    ),
  );
  if (
    !parsed.success ||
    parsed.data.runId !== runId ||
    !parsed.data.action.startsWith("applications.")
  )
    throw new Error("The application action response is invalid.");
  return parsed.data;
}

export function prefetchApplicationRun(
  context: HttpLoaderReadContext,
  jobId: string,
  runId: string,
) {
  return Promise.all([
    context.queryClient.prefetchQuery(
      applicationOptions(context.tenantId, context.ports.http, jobId),
    ),
    context.queryClient.prefetchQuery({
      queryKey: applyKeys.action(context.tenantId, runId),
      queryFn: () => readApplicationActionRun(context.ports.http, runId),
    }),
  ]);
}
