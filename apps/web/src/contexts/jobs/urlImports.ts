import { JobCtrlApiError } from "@jobctrl/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { cancellationDeliverySchema } from "../../shared/lib/actionStop.js";

import { useRuntimeHealth } from "../runtime/index.js";
import { lookupSessionAction, requestWorkspace, requireRequestWorkspace, useSessionRequestIdentity } from "../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { jobsKeys } from "./client.js";

const operation = "jobs.capture_url";
const statuses = z.enum(["pending", "start_failed", "queued", "running", "waiting_for_capacity", "succeeded", "failed", "cancelled"]);
const listSchema = z.object({ imports: z.array(z.object({
  runId: z.string(), url: z.string(), status: statuses, cancellationRequested: z.boolean(),
  cancellationDelivery: cancellationDeliverySchema, errorCode: z.string().nullable(), jobId: z.string().nullable(),
})) });

export function useUrlImports(enabled: boolean) {
  const tenant = useTenantId();
  const { http, requestIdentity } = usePorts();
  const client = useQueryClient();
  const identity = useSessionRequestIdentity("url-import", operation);
  const health = useRuntimeHealth();
  const databaseId = health.data?.databaseInstanceId;
  const mode = enabled && databaseId && !health.isError && health.data?.features.includes("jobs")
    ? health.data.capabilities?.includes("jobs.url_import_queue") ? "queue" : "action" : null;
  const queryKey = [...jobsKeys.urlImports(tenant), databaseId, mode] as const;
  const list = useQuery({ queryKey, enabled: mode === "queue", queryFn: async () => {
    if (mode !== "queue" || !databaseId) throw new Error("The URL import queue is unavailable in this workspace.");
    const rows = listSchema.parse(await http.json<unknown>("GET", "/v1/jobs/url-imports", { expectedDatabaseInstanceId: databaseId }));
    return { ...rows, databaseId };
  }, refetchInterval: (query) => query.state.data?.imports.some((row) => ["pending", "queued", "running", "waiting_for_capacity"].includes(row.status)) ? 1500 : false,
  meta: { suppressGlobalErrorToast: true } });
  const refresh = () => client.invalidateQueries({ queryKey });
  const start = useMutation({ mutationFn: async (url: string) => {
    const body = { url };
    let previous = identity.current();
    const fingerprint = await requestIdentity.fingerprint(JSON.stringify(body));
    if (previous) {
      await requireRequestWorkspace(http, previous);
      if (previous.fingerprint !== fingerprint) {
        const recorded = await lookupSessionAction(http, previous).catch(() => null);
        if (!recorded || ["pending", "start_failed"].includes(recorded.status))
          throw new Error("Admission for the earlier URL is unconfirmed. Retry that URL first.");
        identity.clear(previous.requestId);
        previous = null;
      }
    }
    const workspace = await requestWorkspace(http);
    if (!mode || workspace.databaseInstanceId !== databaseId) throw new Error("The workspace changed. Refresh Jobs before importing the URL.");
    const saved = previous ?? { ...workspace, version: 1 as const, operation, fingerprint, requestId: requestIdentity.create() };
    identity.save(saved);
    let runId: string;
    try {
      const receipt = z.object({ runId: z.string().min(1), status: z.string() }).parse(await http.json<unknown>("POST", "/v1/actions/jobs.capture_url", {
        body, idempotencyKey: saved.requestId, expectedDatabaseInstanceId: saved.databaseInstanceId,
      }));
      runId = receipt.runId;
    } catch (error) {
      if (!(error instanceof JobCtrlApiError) || error.status >= 500) throw error;
      const busy = z.object({ error: z.object({ code: z.literal("action_scope_busy"), details: z.object({ runId: z.string().min(1) }) }) });
      const matched = busy.safeParse(error.responseBody);
      identity.clear(saved.requestId);
      if (error.status === 409 && matched.success) return { runId: matched.data.error.details.runId, databaseId: saved.databaseInstanceId };
      throw error;
    }
    identity.clear(saved.requestId);
    return { runId, databaseId: saved.databaseInstanceId };
  }, onSettled: refresh });
  const cancel = useMutation({ mutationFn: async (runId: string) => {
    if (!list.data) throw new Error("Refresh the import queue before cancelling.");
    await http.json("POST", `/v1/action-runs/${encodeURIComponent(runId)}/cancel`, {
      body: {}, expectedDatabaseInstanceId: list.data.databaseId,
    });
  }, onSettled: refresh });
  const receipt = mode === "action" && start.data?.databaseId === databaseId ? start.data : null;
  return { list, start, cancel, mode, receipt, ready: identity.ready && Boolean(mode), recoveryError: identity.error ?? health.error };
}
