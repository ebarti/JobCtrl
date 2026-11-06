import { JobCtrlApiError } from "@jobctrl/api-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { lookupSessionAction, requestWorkspace, useSessionRequestIdentity, type SessionRequestIdentity } from "../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

type PreparationAction = "preparation.run" | "preparation.retry";

/** A single tab may reconcile one unresolved preparation admission at a time. */
export function usePreparationRecovery() {
  const tenantId = useTenantId();
  const { http, requestIdentity } = usePorts();
  const client = useQueryClient();
  const run = useSessionRequestIdentity("preparation", "preparation.run");
  const retry = useSessionRequestIdentity("preparation", "preparation.retry");
  const [message, setMessage] = useState<string | null>(null);
  const [checkingManual, setCheckingManual] = useState(false);
  const record = run.record ?? retry.record;
  const multiple = Boolean(run.record && retry.record);
  const ready = run.ready && retry.ready && !multiple;
  const statusKey = ["tenant", tenantId, "preparation", "request-status", record?.operation ?? "", record?.requestId ?? ""] as const;
  const status = useQuery({
    queryKey: statusKey, enabled: ready && Boolean(record), retry: false,
    queryFn: () => {
      if (!record) throw new Error("No earlier preparation request is recorded.");
      return lookupSessionAction(http, record);
    },
    refetchInterval: (query) => ["pending", "queued", "running"].includes(query.state.data?.status ?? "")
      || (query.state.error instanceof JobCtrlApiError && query.state.error.status === 404) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const notRecorded = status.error instanceof JobCtrlApiError && status.error.status === 404;
  const canRetry = Boolean(record && !status.isFetching && (notRecorded || ["pending", "start_failed"].includes(status.data?.status ?? "")));

  function current(): SessionRequestIdentity | null {
    const a = run.current();
    const b = retry.current();
    if (a && b) throw new Error("Multiple preparation requests need reconciliation before starting more work.");
    return a ?? b;
  }
  function identityFor(action: string) { return action === "preparation.run" ? run : retry; }

  return {
    ready, error: multiple ? new Error("Multiple preparation requests need reconciliation.") : run.error ?? retry.error,
    record, status: status.data, statusError: status.error, checking: status.isFetching || checkingManual, canRetry, message,
    permits(action: PreparationAction) { return ready && (!record || (record.operation === action && canRetry)); },
    async begin(action: PreparationAction, body: object) {
      if (!ready) throw new Error("Session recovery storage is unavailable. Restore it before starting preparation.");
      const fingerprint = await requestIdentity.fingerprint(JSON.stringify({ action, body }));
      const workspace = await requestWorkspace(http);
      const previous = current();
      if (previous && (previous.operation !== action || previous.fingerprint !== fingerprint)) {
        throw new Error("These inputs do not match the earlier preparation request. Check that request before starting different work.");
      }
      if (previous && (previous.workspaceId !== workspace.workspaceId || previous.databaseInstanceId !== workspace.databaseInstanceId)) {
        throw new Error("This request belongs to a different workspace or database. Return there to reconcile it.");
      }
      if (previous) {
        try {
          const observed = await lookupSessionAction(http, previous);
          if (!["pending", "start_failed"].includes(observed.status)) {
            throw new Error(`The previous request is recorded as ${observed.status}. Check it before starting more work.`);
          }
        } catch (error) {
          if (!(error instanceof JobCtrlApiError && error.status === 404)) throw error;
        }
        if (current()?.requestId !== previous.requestId) throw new Error("The previous request changed while its status was checked. Review it again.");
      }
      // Re-read after all asynchronous checks. No await may occur between this
      // cross-action check and saving the identity in tab storage.
      const latest = current();
      if (latest && (!previous || latest.requestId !== previous.requestId)) throw new Error("Another preparation request is awaiting reconciliation.");
      const saved = previous ?? { version: 1 as const, requestId: requestIdentity.create(), operation: action, fingerprint, ...workspace };
      identityFor(action).save(saved);
      setMessage(null);
      return { identity: saved, previous: Boolean(previous) };
    },
    clear(identity: SessionRequestIdentity) { identityFor(identity.operation).clear(identity.requestId); },
    refresh() { void client.invalidateQueries({ queryKey: ["tenant", tenantId, "preparation", "request-status"] }); },
    async check() {
      setCheckingManual(true);
      try {
        const previous = current();
        if (!previous) return;
        const observed = await lookupSessionAction(http, previous);
        if (["queued", "running", "succeeded", "failed", "cancelled"].includes(observed.status)) {
          if (current()?.requestId !== previous.requestId) throw new Error("The earlier request changed while its status was checked.");
          identityFor(previous.operation).clear(previous.requestId);
          setMessage(`Previous request ${observed.runId} is recorded as ${observed.status}. Its admission has been reconciled.`);
        } else {
          setMessage(`Previous request ${observed.runId} is ${observed.status}. Retry only the same command with its saved identity.`);
        }
        void client.invalidateQueries({ queryKey: ["tenant", tenantId, "preparation"] });
      } catch (error) {
        setMessage(error instanceof JobCtrlApiError && error.status === 404
          ? "No admission is recorded at this instant. Retry only the exact previous command with its saved identity."
          : error instanceof Error ? `Request status is unavailable: ${error.message}` : "Request status is unavailable.");
      } finally {
        setCheckingManual(false);
      }
    },
  };
}
