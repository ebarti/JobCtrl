import { JobCtrlApiError } from "@jobctrl/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { lookupSessionAction, requestWorkspace, requireRequestWorkspace, useSessionRequestIdentity } from "../../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";

/** Recovery metadata and exact-key status for Discovery's durable actions. */
export function useDiscoveryActionRecovery(operation: "discovery.search" | "discovery.refresh_targets" | "discovery.refresh_feedback", { paused = false }: { readonly paused?: boolean } = {}) {
  const tenant = useTenantId();
  const { http, requestIdentity } = usePorts();
  const client = useQueryClient();
  const identity = useSessionRequestIdentity("discovery", operation);
  const [message, setMessage] = useState<string | null>(null);
  const statusKey = ["tenant", tenant, "discovery", "request-status", operation, identity.record?.requestId ?? ""] as const;
  const status = useQuery({ queryKey: statusKey, enabled: Boolean(identity.record) && !paused,
    queryFn: () => {
      if (!identity.record) throw new Error("No earlier Discovery request is recorded.");
      return lookupSessionAction(http, identity.record);
    }, retry: false, refetchInterval: (query) => !paused && (["pending", "queued", "running"].includes(query.state.data?.status ?? "") || (query.state.error instanceof JobCtrlApiError && query.state.error.status === 404)) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true } });
  const notRecorded = status.error instanceof JobCtrlApiError && status.error.status === 404;
  const canRetry = Boolean(identity.record && !status.isFetching && (notRecorded || ["pending", "start_failed"].includes(status.data?.status ?? "")));
  return {
    ready: identity.ready, error: identity.error, record: identity.record, status: status.data, statusError: status.error,
    checking: paused || status.isFetching, canRetry, message,
    async begin(body: object, sourceRevision?: number, expectedDatabaseInstanceId?: string) {
      if (!identity.ready) throw new Error("Session recovery storage is unavailable. Restore it before submitting.");
      const previous = identity.current();
      const fingerprint = await requestIdentity.fingerprint(JSON.stringify(body));
      if (previous && previous.fingerprint !== fingerprint) throw new Error("These inputs do not match the earlier Discovery request.");
      const workspace = await requestWorkspace(http);
      if (expectedDatabaseInstanceId && workspace.databaseInstanceId !== expectedDatabaseInstanceId) {
        throw new Error("The saved search criteria belong to a different workspace. Reload and review them before starting.");
      }
      if (previous && (previous.workspaceId !== workspace.workspaceId || previous.databaseInstanceId !== workspace.databaseInstanceId)) {
        throw new Error("This request belongs to a different workspace or database. Return there to reconcile it.");
      }
      const requestId = previous?.requestId ?? requestIdentity.create();
      const saved = previous ?? { version: 1 as const, requestId, operation, fingerprint, ...workspace,
        ...(sourceRevision !== undefined ? { sourceRevision } : {}) };
      identity.save(saved);
      setMessage(null);
      return { ...saved, reused: Boolean(previous) };
    },
    refresh() { void client.invalidateQueries({ queryKey: ["tenant", tenant, "discovery", "request-status", operation] }); },
    async releaseUnadmitted(requestId: string) {
      const record = identity.current();
      if (!record || record.requestId !== requestId) return false;
      await requireRequestWorkspace(http, record);
      if (identity.current()?.requestId !== requestId) return false;
      identity.clear(requestId);
      return true;
    },
    async reconcileTerminal() {
      // Only an exact-key status read may release its request. Recheck the
      // current database before clearing, including after a workspace switch.
      const record = identity.current();
      if (!record || record.requestId !== identity.record?.requestId || status.error
          || !status.data || !["succeeded", "failed", "cancelled"].includes(status.data.status)) return false;
      await requireRequestWorkspace(http, record);
      if (identity.current()?.requestId !== record.requestId) return false;
      identity.clear(record.requestId);
      return true;
    },
    async check() {
      try {
        const original = identity.current();
        if (!original || original.requestId !== identity.record?.requestId) throw new Error("The earlier request changed. Check the current request before continuing.");
        const checked = await status.refetch();
        if (checked.error) throw checked.error;
        const result = checked.data;
        if (!result) throw new Error("No request status was returned.");
        if (["succeeded", "failed", "cancelled"].includes(result.status)) {
          await requireRequestWorkspace(http, original);
          if (identity.current()?.requestId !== original.requestId) return false;
          identity.clear(original.requestId);
          setMessage(`Previous request ${result.status}. Its recorded result has been reconciled.`);
          return true;
        }
        setMessage(`Previous request status: ${result.status}. A new request remains blocked.`);
      } catch (error) {
        setMessage(error instanceof JobCtrlApiError && error.status === 404
          ? "No admission is recorded at this instant. The exact request may be retried with the same identity."
          : error instanceof Error ? `Request status is unavailable: ${error.message}` : "Request status is unavailable.");
      }
      return false;
    },
  };
}
