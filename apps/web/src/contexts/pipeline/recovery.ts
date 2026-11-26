import { JobCtrlApiError } from "@jobctrl/api-client";
import { useIsMutating, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { lookupSessionAction, requestWorkspace, useSessionRequestIdentity, type SessionRequestIdentity } from "../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";

type PreparationAction = "preparation.run" | "preparation.retry";
export type PreparationRetryRequest = { run_id: string; job_ids?: readonly string[] };

export function preparationRequestInput(action: PreparationAction, body: object) {
  return JSON.stringify({ action, body });
}

const requestSummary = {
  pending: "The previous request is saved. JobCtrl couldn’t confirm it started.",
  start_failed: "The previous request is saved. JobCtrl couldn’t confirm it started.",
  queued: "The previous request is queued.",
  running: "The previous request is running.",
  succeeded: "The previous request completed.",
  failed: "The previous request failed.",
  cancelled: "The previous request was cancelled.",
};

export const preparationAdmissionKey = (tenantId: string) => ["tenant", tenantId, "preparation", "admission"] as const;

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
  const submitting = useIsMutating({ mutationKey: preparationAdmissionKey(tenantId) }) > 0;
  const status = useQuery({
    queryKey: statusKey, enabled: ready && Boolean(record) && !submitting, retry: false,
    queryFn: () => {
      if (!record) throw new Error("No earlier preparation request is recorded.");
      return lookupSessionAction(http, record);
    },
    refetchInterval: (query) => ["pending", "queued", "running"].includes(query.state.data?.status ?? "")
      || (query.state.error instanceof JobCtrlApiError && query.state.error.status === 404) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const notRecorded = status.error instanceof JobCtrlApiError && status.error.status === 404;
  const awaitingStart = ["pending", "start_failed"].includes(status.data?.status ?? "");
  const canRetry = Boolean(record && !submitting && !checkingManual && !status.data?.cancellationRequested
    && (notRecorded || (!status.error && awaitingStart)));
  let summary = "Checking whether the previous request started…";
  if (notRecorded) summary = "JobCtrl has no record of the previous request yet.";
  else if (status.error) summary = "JobCtrl couldn’t check the previous request. Try checking again.";
  else if (status.data) {
    const stopping = status.data.cancellationRequested && (awaitingStart || ["queued", "running"].includes(status.data.status));
    summary = stopping ? "The previous request is stopping." : requestSummary[status.data.status];
  }

  function current(): SessionRequestIdentity | null {
    const a = run.current();
    const b = retry.current();
    if (a && b) throw new Error("Multiple preparation requests need reconciliation before starting more work.");
    return a ?? b;
  }
  function identityFor(action: string) { return action === "preparation.run" ? run : retry; }

  return {
    ready, error: multiple ? new Error("Multiple preparation requests need reconciliation.") : run.error ?? retry.error,
    record, status: status.data, summary, checking: status.isFetching || checkingManual, canRetry, message,
    permits(action: PreparationAction) {
      return ready && (!record || (action === "preparation.run" && record.operation === action && canRetry));
    },
    async begin(action: PreparationAction, body: object) {
      if (!ready) throw new Error("Session recovery storage is unavailable. Restore it before starting preparation.");
      const fingerprint = await requestIdentity.fingerprint(preparationRequestInput(action, body));
      const workspace = await requestWorkspace(http);
      const previous = current();
      if (previous && (previous.operation !== action || previous.fingerprint !== fingerprint)) {
        throw new Error("The previous request used a different selection. Check its status or return to its original selections.");
      }
      if (previous && (previous.workspaceId !== workspace.workspaceId || previous.databaseInstanceId !== workspace.databaseInstanceId)) {
        throw new Error("This request belongs to a different workspace or database. Return there to reconcile it.");
      }
      if (previous) {
        try {
          const observed = await lookupSessionAction(http, previous);
          if (observed.cancellationRequested || !["pending", "start_failed"].includes(observed.status)) {
            throw new Error("The previous request now has a recorded status. Check it before starting more work.");
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
      setMessage(null);
      try {
        const previous = current();
        if (!previous || previous.requestId !== record?.requestId) return;
        const checked = await status.refetch();
        const observed = checked.data;
        if (checked.error || !observed) return;
        if (["queued", "running", "succeeded", "failed", "cancelled"].includes(observed.status)) {
          if (current()?.requestId !== previous.requestId) return;
          identityFor(previous.operation).clear(previous.requestId);
          setMessage(`${requestSummary[observed.status]} See preparation history for details.`);
          void client.invalidateQueries({ queryKey: ["tenant", tenantId, "preparation"] });
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Couldn’t check the previous request.");
      } finally {
        setCheckingManual(false);
      }
    },
  };
}
