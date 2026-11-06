import type { GenerateInterviewPrepRequest } from "@jobctrl/contracts";
import { useMutation, useQuery, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { create } from "zustand";

import { JobCtrlApiError } from "@jobctrl/api-client";
import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { lookupSessionAction, requestWorkspace, useSessionRequestIdentity } from "../../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { interviewKeys } from "../queryKeys.js";

export interface GenerateInterviewPrepVariables {
  readonly jobId: string;
  readonly body?: GenerateInterviewPrepRequest;
}

const RunSchema = z.object({ runId: z.string().min(1), workflowId: z.string().min(1), status: z.string().min(1) });
type InterviewActionRun = z.infer<typeof RunSchema>;
type PendingRequest = { identity: string; requestId: string; variables: GenerateInterviewPrepVariables; uncertain: boolean };
// The exact inputs remain in memory; session storage holds only their digest.
const usePendingInterviewRequests = create<{
  requests: ReadonlyMap<string, PendingRequest>;
  set: (scope: string, request: PendingRequest | null) => void;
}>((set) => ({ requests: new Map(), set: (scope, request) => set((state) => {
  const requests = new Map(state.requests);
  if (request) requests.set(scope, request); else requests.delete(scope);
  return { requests };
}) }));

export function useGenerateInterviewPrepMutation(jobId: string): UseMutationResult<
  InterviewActionRun,
  Error,
  GenerateInterviewPrepVariables
> & { readonly hasUnconfirmed: boolean; readonly retryUnconfirmed: () => void; readonly recoveryReady: boolean;
  readonly recoveryError: Error | null; readonly hasOriginalInputs: boolean; readonly canResumeWithInputs: boolean; readonly canRetry: boolean;
  readonly observedStatus: string | undefined; readonly checkingStatus: boolean; readonly recoveryMessage: string | null;
  readonly checkPrevious: () => Promise<void> } {
  const tenantId = useTenantId();
  const { http, requestIdentity } = usePorts();
  const queryClient = useQueryClient();
  const identity = useSessionRequestIdentity(jobId, "interviews.generate");
  const scope = JSON.stringify([tenantId, jobId]);
  const pending = usePendingInterviewRequests((state) => state.requests.get(scope));
  const [recoveryMessage, setRecoveryMessage] = useState<string | null>(null);
  const status = useQuery({ queryKey: [...interviewKeys.job(tenantId, jobId), "request-status", identity.record?.requestId ?? ""],
    enabled: Boolean(identity.record), queryFn: async () => {
      if (!identity.record) throw new Error("No earlier preparation request is recorded.");
      return lookupSessionAction(http, identity.record);
    }, retry: false, refetchInterval: (query) => ["pending", "queued", "running"].includes(query.state.data?.status ?? "") || (query.state.error instanceof JobCtrlApiError && query.state.error.status === 404) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true } });
  const notRecorded = status.error instanceof JobCtrlApiError && status.error.status === 404;
  const retryAllowed = Boolean(identity.record && !status.isFetching && (notRecorded || ["pending", "start_failed"].includes(status.data?.status ?? "")));

  const mutation = useMutation<InterviewActionRun, Error, GenerateInterviewPrepVariables>({
    mutationFn: async (variables) => {
      if (variables.jobId !== jobId) throw new Error("Preparation belongs to a different job.");
      if (!identity.ready) throw new Error("Session recovery storage is unavailable. Restore it before submitting.");
      const body = { jobId: variables.jobId, ...variables.body };
      const serialized = JSON.stringify(body);
      const fingerprint = await requestIdentity.fingerprint(serialized);
      const previous = identity.current();
      if (previous && previous.fingerprint !== fingerprint) throw new Error("These inputs do not match the earlier preparation request.");
      const current = usePendingInterviewRequests.getState().requests.get(scope);
      if (current && current.identity !== serialized) {
        throw new Error("The earlier preparation request is unconfirmed. Retry that request before submitting changed inputs.");
      }
      const workspace = await requestWorkspace(http);
      if (previous && (previous.workspaceId !== workspace.workspaceId || previous.databaseInstanceId !== workspace.databaseInstanceId)) throw new Error("This request belongs to a different workspace or database. Return there to reconcile it.");
      const requestId = current?.requestId ?? previous?.requestId ?? requestIdentity.create();
      const request = current ?? { identity: serialized, requestId, variables: structuredClone(variables), uncertain: false };
      identity.save(previous ?? { version: 1, requestId, operation: "interviews.generate", fingerprint, ...workspace });
      usePendingInterviewRequests.getState().set(scope, request);
      try {
        const response = await http.json<unknown>("POST", "/v1/actions/interviews.generate", { body, idempotencyKey: requestId, expectedDatabaseInstanceId: workspace.databaseInstanceId });
        const parsed = RunSchema.safeParse(response);
        if (!parsed.success) throw createUnconfirmedWriteError("POST", "/v1/actions/interviews.generate", parsed.error);
        return parsed.data;
      } catch (error) {
        if (usePendingInterviewRequests.getState().requests.get(scope)?.requestId === requestId) {
          usePendingInterviewRequests.getState().set(scope, { ...request, uncertain: true });
        }
        throw error;
      }
    },
    onSettled: (_data, _error, variables) => {
      void queryClient.invalidateQueries({ queryKey: interviewKeys.job(tenantId, variables.jobId) });
    },
  });
  return { ...mutation, hasUnconfirmed: !identity.ready || Boolean(identity.record), recoveryReady: identity.ready,
    recoveryError: identity.error, hasOriginalInputs: Boolean(pending?.variables), canRetry: retryAllowed, canResumeWithInputs: retryAllowed && !pending?.variables,
    observedStatus: status.data?.status, checkingStatus: status.isFetching, recoveryMessage,
    retryUnconfirmed: () => { if (retryAllowed && pending?.variables && !mutation.isPending) mutation.mutate(pending.variables); },
    checkPrevious: async () => {
      try {
        const checked = await status.refetch();
        if (checked.error) throw checked.error;
        const result = checked.data;
        if (!result) throw new Error("No request status was returned.");
        if (["succeeded", "failed", "cancelled"].includes(result.status)) {
          const record = identity.current();
          if (!record) return;
          identity.clear(record.requestId);
          if (usePendingInterviewRequests.getState().requests.get(scope)?.requestId === record.requestId) usePendingInterviewRequests.getState().set(scope, null);
          setRecoveryMessage(`Previous preparation ${result.status}. Its recorded result has been reconciled.`);
          void queryClient.invalidateQueries({ queryKey: interviewKeys.job(tenantId, jobId) });
        } else setRecoveryMessage(`Previous preparation status: ${result.status}. A new request remains blocked.`);
      } catch (error) {
        setRecoveryMessage(error instanceof JobCtrlApiError && error.status === 404
          ? "No admission is recorded at this instant. The exact request may be retried with the same identity."
          : error instanceof Error ? `Request status is unavailable: ${error.message}` : "Request status is unavailable.");
      }
    } };
}
