import type { CareerLearningCommand } from "@jobctrl/contracts";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { create } from "zustand";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { createUnconfirmedWriteError, isUnconfirmedWrite } from "../../../shared/lib/unconfirmed-write.js";
import { getApiCapabilityAvailability } from "../../../shared/lib/apiCapabilityAvailability.js";
import { requestWorkspace, requireRequestWorkspace, useSessionRequestIdentity } from "../../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { LearningResponseSchema, type LearningResponse } from "../contracts.js";
import { careerLearningKeys } from "../queryKeys.js";

type PendingLearning = { requestId: string; identity: string; command: CareerLearningCommand; uncertain: boolean };
const usePendingLearning = create<{
  requests: ReadonlyMap<string, PendingLearning>;
  set: (tenant: string, request: PendingLearning | null) => void;
}>((set) => ({ requests: new Map(), set: (tenant, request) => set((state) => {
  const requests = new Map(state.requests); if (request) requests.set(tenant, request); else requests.delete(tenant); return { requests };
}) }));

function isUnresolved(error: unknown): boolean {
  if (!(error instanceof JobCtrlApiError) || !error.responseBody || typeof error.responseBody !== "object" || !("error" in error.responseBody)) return false;
  const detail = error.responseBody.error;
  return Boolean(detail && typeof detail === "object" && "code" in detail
    && (detail.code === "learning_request_unresolved" || detail.code === "learning_request_in_progress" || detail.code === "idempotency_conflict"));
}

const RequestStatus = z.object({ ok: z.literal(true), state: z.enum(["in_progress", "ready_to_resume", "complete", "failed", "unresolved"]), result: z.unknown().optional(), error: z.object({ message: z.string().optional() }).passthrough().optional(), receiptId: z.string().nullable().optional() }).passthrough();

export function useCareerLearningQuery() {
  const tenant = useTenantId();
  const { http, featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "careerLearning");
  const query = useQuery({ queryKey: careerLearningKeys.all(tenant),
    queryFn: async () => LearningResponseSchema.parse(await http.json<unknown>("GET", "/v1/evidence-map/learning")),
    enabled: availability.available, meta: { suppressGlobalErrorToast: true } });
  return { ...query, availability };
}

export function useCareerLearningMutation() {
  const tenant = useTenantId();
  const { http, requestIdentity } = usePorts();
  const client = useQueryClient();
  const key = careerLearningKeys.all(tenant);
  const identity = useSessionRequestIdentity("learning", "learning.execute");
  const pending = usePendingLearning((state) => state.requests.get(tenant));
  const [requestStatus, setRequestStatus] = useState<string | null>(null);
  const status = useQuery({
    queryKey: [...key, "request-status", identity.record?.requestId ?? ""],
    enabled: Boolean(identity.record),
    queryFn: async () => {
      const record = identity.record;
      if (!record) throw new Error("No earlier learning request is recorded.");
      await requireRequestWorkspace(http, record);
      return RequestStatus.parse(await http.json<unknown>("GET", "/v1/evidence-map/learning/request-status", { idempotencyKey: record.requestId, expectedDatabaseInstanceId: record.databaseInstanceId }));
    },
    retry: false,
    refetchInterval: (query) => query.state.data?.state === "in_progress" || (query.state.error instanceof JobCtrlApiError && query.state.error.status === 404) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const mutation = useMutation(createOptimisticMutation<LearningResponse, CareerLearningCommand>(client, {
    mutationFn: async (body) => {
      setRequestStatus(null);
      if (!identity.ready) throw new Error("Session recovery storage is unavailable. Restore it before submitting.");
      const serialized = JSON.stringify(body);
      const fingerprint = await requestIdentity.fingerprint(serialized);
      const previous = identity.current();
      if (previous && (previous.fingerprint !== fingerprint || previous.requestKind !== body.action)) {
        throw new Error("These inputs do not match the earlier learning request. Review its status and re-enter the same inputs.");
      }
      const current = usePendingLearning.getState().requests.get(tenant);
      if (current && current.identity !== serialized) throw new Error("The earlier learning change is unconfirmed. Retry that request first.");
      const workspace = await requestWorkspace(http);
      if (previous && (previous.workspaceId !== workspace.workspaceId || previous.databaseInstanceId !== workspace.databaseInstanceId)) {
        throw new Error("This request belongs to a different workspace or database. Return there to reconcile it.");
      }
      const request = current ?? { requestId: previous?.requestId ?? requestIdentity.create(), identity: serialized, command: structuredClone(body), uncertain: false };
      identity.save(previous ?? { version: 1, requestId: request.requestId, operation: "learning.execute", fingerprint, ...workspace,
        requestKind: body.action, ...(body.action === "compare" && body.expectedSnapshotFingerprint ? { sourceFingerprint: body.expectedSnapshotFingerprint } : {}) });
      usePendingLearning.getState().set(tenant, request);
      try {
        const response = await http.json<unknown>("POST", "/v1/evidence-map/learning", { body, idempotencyKey: request.requestId, expectedDatabaseInstanceId: workspace.databaseInstanceId });
        const parsed = LearningResponseSchema.safeParse(response);
        if (!parsed.success) throw createUnconfirmedWriteError("POST", "/v1/evidence-map/learning", parsed.error);
        try { identity.clear(request.requestId); } catch (error) { throw createUnconfirmedWriteError("POST", "/v1/evidence-map/learning", error); }
        if (usePendingLearning.getState().requests.get(tenant)?.requestId === request.requestId) usePendingLearning.getState().set(tenant, null);
        return parsed.data;
      } catch (error) {
        if (usePendingLearning.getState().requests.get(tenant)?.requestId === request.requestId) {
          if (previous || isUnconfirmedWrite(error) || isUnresolved(error)) usePendingLearning.getState().set(tenant, { ...request, uncertain: true });
          else {
            try { identity.clear(request.requestId); usePendingLearning.getState().set(tenant, null); }
            catch { usePendingLearning.getState().set(tenant, { ...request, uncertain: true }); }
          }
        }
        throw error;
      }
    },
    optimisticUpdates: (command) => command.action !== "update" ? [] : [{
      queryKey: key,
      patch: (current) => {
        const response = current as LearningResponse | undefined;
        if (!response) return current;
        return { ...response, milestones: response.milestones.map((milestone) =>
          milestone.milestoneId === command.milestoneId
            ? { ...milestone, status: command.status, completionEvidence: command.completionEvidence }
            : milestone) };
      },
    }],
    settle: () => [key],
    meta: { suppressGlobalErrorToast: true },
  }));
  const notRecorded = status.error instanceof JobCtrlApiError && status.error.status === 404;
  const canResumeWithInputs = Boolean(identity.record && !pending?.command && (status.data?.state === "ready_to_resume" || notRecorded));
  return { ...mutation, hasUnconfirmed: !identity.ready || Boolean(identity.record), recoveryReady: identity.ready,
    recoveryError: identity.error, pendingKind: identity.record?.requestKind, sourceFingerprint: identity.record?.sourceFingerprint,
    canResumeWithInputs, hasOriginalInputs: Boolean(pending?.command), requestStatus, observedStatus: status.data?.state,
    statusError: status.error, checkingStatus: status.isFetching,
    retryUnconfirmed: async () => {
      if (pending?.uncertain && !mutation.isPending) return mutation.mutateAsync(pending.command);
      return undefined;
    },
    checkUnconfirmed: async () => {
      try {
        const record = identity.current();
        if (!record) return undefined;
        const checked = await status.refetch();
        if (checked.error) throw checked.error;
        const response = checked.data;
        if (!response) throw new Error("No request status was returned.");
        if (response.state === "failed") {
          identity.clear(record.requestId);
          if (usePendingLearning.getState().requests.get(tenant)?.requestId === record.requestId) usePendingLearning.getState().set(tenant, null);
          setRequestStatus(`The earlier request failed${response.error?.message ? `: ${response.error.message}` : "."} You may start a new request.`);
          mutation.reset();
          void client.invalidateQueries({ queryKey: key });
        } else if (response.state === "complete") {
          const result = LearningResponseSchema.parse(response.result);
          identity.clear(record.requestId);
          if (usePendingLearning.getState().requests.get(tenant)?.requestId === record.requestId) usePendingLearning.getState().set(tenant, null);
          client.setQueryData(key, result);
          mutation.reset();
          setRequestStatus("The saved result of the earlier request was recovered.");
          return result;
        } else if (response.state === "unresolved") {
          setRequestStatus(`The earlier model attempt remains unconfirmed${response.receiptId ? ` (receipt ${response.receiptId})` : ""}. No new request has been started.`);
        } else if (response.state === "in_progress") {
          setRequestStatus("The earlier request is still running.");
        } else setRequestStatus("The earlier request is ready to resume with the same identity and exact inputs.");
      } catch (error) {
        setRequestStatus(error instanceof JobCtrlApiError && error.status === 404
          ? "No request was recorded at this instant. Re-enter the exact inputs to retry with the same identity."
          : error instanceof Error ? `Request status is unavailable: ${error.message}` : "Request status is unavailable.");
      }
      return undefined;
    },
  };
}
