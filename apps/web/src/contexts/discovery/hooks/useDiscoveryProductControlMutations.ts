import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";
import type {
  DiscoveryFeedbackRequest,
  DiscoveryFeedbackResponse,
  ManualCaptureDismissResponse,
  ManualCaptureImportRequest,
  ManualCaptureImportResponse,
  ManualCaptureListResponse,
  ManualCapturePrepareResponse,
  ManualCaptureSupersedeResponse,
  QuarantineDecision,
  QuarantineDecisionResponse,
  RoleMatchFeedbackDecisionRequest,
  RoleMatchFeedbackDecisionResponse,
  SourceLocatorDecisionRequest,
  SourceLocatorDecisionResponse,
  SourceRegistryMutationResponse,
  SourceStatePatch,
  SourceUpsertRequest,
} from "@jobctrl/contracts";

export function useUpsertDiscoverySourceMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: SourceUpsertRequest) => {
      const response = await http.json<SourceRegistryMutationResponse>("POST", "/v1/discovery/sources", { body: { ...body, createOnly: true } });
      const source = response?.source as (SourceRegistryMutationResponse["source"] & { seedUrl?: string }) | undefined;
      if (response?.ok !== true || source?.sourceId !== body.sourceId || source.displayName !== body.displayName
          || source.kind !== body.kind || source.state !== body.state || source.priority !== body.priority
          || (body.seedUrl !== undefined && source.seedUrl !== body.seedUrl)) {
        throw createUnconfirmedWriteError("POST", "/v1/discovery/sources", new Error("The created source was not confirmed."));
      }
      return response;
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
      ]);
    },
  });
}

export function usePatchDiscoverySourceStateMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ sourceId, body }: { sourceId: string; body: SourceStatePatch & { expectedRevision: number } }) => {
      const path = `/v1/discovery/sources/${encodeURIComponent(sourceId)}/state`;
      const response = await http.json<SourceRegistryMutationResponse>("PATCH", path, { body });
      const source = response?.source as (SourceRegistryMutationResponse["source"] & { revision?: number }) | undefined;
      if (response?.ok !== true || source?.sourceId !== sourceId || source.state !== body.state || source.revision !== body.expectedRevision + 1) {
        throw createUnconfirmedWriteError("PATCH", path, new Error("The source state response did not confirm this revision."));
      }
      return response;
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
      ]);
    },
  });
}

export function usePromoteSourceLocatorCandidateMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ candidateId, body }: { candidateId: string; body: SourceLocatorDecisionRequest & { expectedRevision: number } }) => {
      const path = `/v1/discovery/locator-candidates/${encodeURIComponent(candidateId)}/promote`;
      const result = await http.json<SourceLocatorDecisionResponse>("POST", path, { body });
      if (result?.ok !== true || result.candidateId !== candidateId || result.decision !== "promote") throw createUnconfirmedWriteError("POST", path, new Error("The source decision was not confirmed."));
      return result;
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceLocator(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
      ]);
    },
  });
}

export function useRejectSourceLocatorCandidateMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ candidateId, body }: { candidateId: string; body: SourceLocatorDecisionRequest & { expectedRevision: number } }) => {
      const path = `/v1/discovery/locator-candidates/${encodeURIComponent(candidateId)}/reject`;
      const result = await http.json<SourceLocatorDecisionResponse>("POST", path, { body });
      if (result?.ok !== true || result.candidateId !== candidateId || result.decision !== "reject") throw createUnconfirmedWriteError("POST", path, new Error("The source decision was not confirmed."));
      return result;
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceLocator(tenantId) }),
      ]);
    },
  });
}

export function useResetSourceLocatorCandidateMutation() {
  const tenantId = useTenantId(); const { http } = usePorts(); const queryClient = useQueryClient();
  return useMutation({ mutationFn: async ({ candidateId, expectedRevision }: { candidateId: string; expectedRevision: number }) => {
    const path = `/v1/discovery/locator-candidates/${encodeURIComponent(candidateId)}/reset`;
    const result = await http.json<{ ok: true; candidateId: string; decision: "reset" }>("POST", path, { body: { expectedRevision } });
    if (result?.ok !== true || result.candidateId !== candidateId || result.decision !== "reset") throw createUnconfirmedWriteError("POST", path, new Error("The source decision was not confirmed."));
    return result;
  },
    onSettled: () => { void queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceLocator(tenantId) }); } });
}

export function useDiscoveryQuarantineDecisionMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobKey, body }: { jobKey: string; body: QuarantineDecision }) =>
      http.json<QuarantineDecisionResponse>("POST", `/v1/discovery/quarantine/${encodeURIComponent(jobKey)}/decision`, { body }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.quarantine(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.feedback(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceQuality(tenantId) }),
      ]);
    },
  });
}

type CaptureImportOutcome = "confirmed" | "rejected" | "in_progress" | "unknown" | "unsubmitted";
export type CaptureDraftEdits = Partial<{
  captureMode: ManualCaptureImportRequest["captureMode"];
  capturedUrl: string;
  content: string;
  note: string;
  futureManualActionRequired: boolean;
}>;
export type CaptureImportState = {
  status: "editing" | "submitting" | "checking" | "recovering" | "refresh_failed" | "recovery_failed" | "unconfirmed" | "in_progress" | "needs_fence" | "local_copy" | "rejected" | "confirmed";
  outcome: CaptureImportOutcome;
  edits: CaptureDraftEdits;
  submittedDraft: CaptureDraftEdits;
  lifecycleId: string | null;
  attempt: symbol;
};
type CaptureImportStates = ReadonlyMap<string, CaptureImportState>;

function captureImportOutcome(data: unknown, error: unknown): CaptureImportOutcome {
  if (data !== undefined) return "confirmed";
  const response = typeof error === "object" && error !== null && "responseBody" in error ? error.responseBody : null;
  const envelope = response && typeof response === "object" && "error" in response ? response.error : null;
  const details = envelope && typeof envelope === "object" && "details" in envelope ? envelope.details : null;
  const reason = details && typeof details === "object" && "reason" in details ? details.reason : null;
  // This reason is emitted only from a completed, failed workflow result, not
  // from a transport 503 or a failed attempt to wait for the workflow.
  if (typeof error === "object" && error !== null && "status" in error && error.status === 503
      && reason === "manual_capture_provider_failed") return "rejected";
  if (typeof error === "object" && error !== null && "status" in error && error.status === 500
      && reason === "manual_capture_database_failed") return "rejected";
  if (typeof error === "object" && error !== null && "writeOutcomeUnknown" in error
      && error.writeOutcomeUnknown === false && "status" in error
      && (error.status === 400 || error.status === 404 || error.status === 422)) return "rejected";
  if (typeof error === "object" && error !== null && "writeOutcomeUnknown" in error
      && error.writeOutcomeUnknown === false && "status" in error && error.status === 409
      && (reason === "manual_capture_state_changed" || reason === "capture_replay_mismatch")) return "rejected";
  if (typeof error === "object" && error !== null && "writeOutcomeUnknown" in error
      && error.writeOutcomeUnknown === false && "status" in error && error.status === 409
      && reason === "manual_capture_in_progress") return "in_progress";
  return "unknown";
}

export function useManualCaptureImportMutation(items: ManualCaptureListResponse["items"]) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  const stateKey = discoveryKeys.manualCaptureImports(tenantId);
  const states = useQuery({
    queryKey: stateKey,
    queryFn: (): CaptureImportStates => new Map(),
    initialData: (): CaptureImportStates => new Map(),
    enabled: false,
    staleTime: Infinity,
    gcTime: Infinity,
  }).data;

  useEffect(() => {
    queryClient.setQueryData<CaptureImportStates>(stateKey, (previous) => {
      if (!previous?.size) return previous;
      // An effect from an older render may run after a recovery read has already
      // replaced the queue cache. Compare against the current cache, not that
      // render's stale snapshot, before classifying the draft as a local copy.
      const currentItems = queryClient.getQueryData<ManualCaptureListResponse>(discoveryKeys.manualCapture(tenantId))?.items ?? items;
      const next = new Map(previous);
      for (const [itemId, state] of previous) {
        if (state.status === "local_copy") continue;
        const item = currentItems.find((candidate) => candidate.itemId === itemId);
        if (item && (item.lifecycleId ?? null) !== state.lifecycleId) {
          // The response still owns this snapshot; a new queue lifetime cannot
          // determine whether the earlier request was admitted or completed.
          if (state.status === "submitting" || state.status === "recovering") continue;
          if (state.outcome !== "confirmed") next.set(itemId, { ...state, status: "local_copy", submittedDraft: { ...state.submittedDraft, ...state.edits } });
          else next.delete(itemId);
        } else if (!item && (state.status === "editing" || state.status === "rejected" || state.status === "confirmed")) {
          if (state.outcome !== "confirmed") next.set(itemId, { ...state, status: "local_copy", submittedDraft: { ...state.submittedDraft, ...state.edits } });
          else next.delete(itemId);
        }
      }
      return next.size === previous.size && [...next].every(([id, state]) => previous.get(id) === state) ? previous : next;
    });
  }, [items, queryClient, stateKey, tenantId]);

  const setState = (itemId: string, state: CaptureImportState | null) => {
    queryClient.setQueryData<CaptureImportStates>(stateKey, (previous) => {
      const next = new Map(previous);
      if (state) next.set(itemId, state);
      else next.delete(itemId);
      return next;
    });
  };

  const reconcile = async (itemId: string) => {
    const current = queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId);
    if (!current || current.status === "checking") return;
    setState(itemId, { ...current, status: "checking" });
    const stillChecking = () => {
      const latest = queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId);
      return latest?.attempt === current.attempt && latest.status === "checking";
    };
    try {
      const queueKey = discoveryKeys.manualCapture(tenantId);
      // Do not let a read started before this attempt settle its outcome.
      await queryClient.cancelQueries({ queryKey: queueKey });
      const queue = await queryClient.fetchQuery({
        queryKey: queueKey, queryFn: () => http.json<ManualCaptureListResponse>("GET", "/v1/discovery/manual-capture"), staleTime: 0, retry: false,
      });
      if (!stillChecking()) return;
      const item = queue.items.find((candidate) => candidate.itemId === itemId);
      if (!item || (item.lifecycleId ?? null) !== current.lifecycleId) {
        if (current.outcome !== "confirmed") setState(itemId, { ...current, status: "local_copy" });
        else setState(itemId, null);
      } else if (current.outcome === "unknown") {
        setState(itemId, { ...current, status: "unconfirmed" });
      } else if (current.outcome === "in_progress") {
        setState(itemId, { ...current, status: "in_progress" });
      } else if (current.outcome === "rejected") {
        setState(itemId, { ...current, status: "needs_fence" });
      } else {
        setState(itemId, { ...current, status: current.outcome === "confirmed" ? "confirmed" : "local_copy" });
      }
    } catch {
      if (stillChecking()) {
        setState(itemId, { ...current, status: "refresh_failed" });
      }
    }
  };

  const mutation = useMutation({
    mutationFn: async ({ itemId, body, lifecycleId, submittedDraft }: { itemId: string; body: ManualCaptureImportRequest; edits?: CaptureDraftEdits; submittedDraft: CaptureDraftEdits; lifecycleId: string | null }) => {
      try {
        const prepared = await http.json<ManualCapturePrepareResponse>("POST", `/v1/discovery/manual-capture/${encodeURIComponent(itemId)}/prepare`, { body });
        if (prepared?.ok !== true || prepared.itemId !== itemId || !/^[a-f0-9]{64}$/.test(prepared.lifecycleId)
            || !lifecycleId || prepared.lifecycleId === lifecycleId) throw new Error("invalid capture preparation response");
        const current = queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId);
        if (!current || current.lifecycleId !== lifecycleId || current.status !== "submitting") {
          throw new Error("capture preparation is no longer current");
        }
        const queueKey = discoveryKeys.manualCapture(tenantId);
        const item = queryClient.getQueryData<ManualCaptureListResponse>(queueKey)?.items.find((candidate) => candidate.itemId === itemId);
        if (!item || (item.lifecycleId !== lifecycleId && item.lifecycleId !== prepared.lifecycleId)) {
          throw new Error("capture review changed during preparation");
        }
        setState(itemId, { ...current, lifecycleId: prepared.lifecycleId });
        queryClient.setQueryData<ManualCaptureListResponse>(queueKey, (previous) => previous && ({
          ...previous,
          items: previous.items.map((entry) => {
            if (entry.itemId !== itemId || (entry.lifecycleId !== lifecycleId && entry.lifecycleId !== prepared.lifecycleId)) return entry;
            const context = { ...entry.retryContext };
            delete context.manual_capture_page_decision;
            return { ...entry, lifecycleId: prepared.lifecycleId, retryContext: { ...context,
              manual_capture_import_unresolved: true, manual_capture_draft: {
                capture_mode: submittedDraft.captureMode, captured_url: submittedDraft.capturedUrl,
                content: submittedDraft.content, note: submittedDraft.note,
                future_manual_action_required: submittedDraft.futureManualActionRequired,
              } } };
          }),
        }));
        const result = await http.json<ManualCaptureImportResponse & { lifecycleId?: unknown }>("POST", `/v1/discovery/manual-capture/${encodeURIComponent(itemId)}/import`, { body: { ...body, expectedLifecycleId: prepared.lifecycleId } });
        if (result?.ok !== true || result.itemId !== itemId || result.lifecycleId !== prepared.lifecycleId
            || typeof result.jobKey !== "string" || !result.jobKey) {
          throw new Error("The capture import response did not confirm this request.");
        }
        return result;
      } catch (error) {
        if (["rejected", "in_progress"].includes(captureImportOutcome(undefined, error))) throw error;
        throw new Error("Import outcome is unconfirmed. Check the capture queue before retrying.", { cause: error });
      }
    },
    onMutate: ({ itemId, edits, submittedDraft, lifecycleId }) => {
      const attempt = Symbol();
      setState(itemId, { status: "submitting", outcome: "unknown", edits: edits ?? {}, submittedDraft, lifecycleId, attempt });
      return attempt;
    },
    onSettled: async (data, error, { itemId }, attempt) => {
      const current = queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId);
      if (!current || current.attempt !== attempt) return;
      setState(itemId, { ...current, status: "submitting", outcome: captureImportOutcome(data, error) });
      await Promise.allSettled([
        reconcile(itemId),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.quarantine(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
      ]);
    },
  });
  const updateEdits = (itemId: string, lifecycleId: string | null, changes: CaptureDraftEdits,
    snapshot: CaptureDraftEdits, removeContent = false) => {
    const current = queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId);
    if (!lifecycleId || (current && (current.lifecycleId !== lifecycleId
      || !["editing", "rejected", "confirmed"].includes(current.status)))) return;
    const edits = { ...current?.edits, ...changes };
    if (removeContent) delete edits.content;
    setState(itemId, current ? { ...current, edits, submittedDraft: snapshot } : {
      status: "editing", outcome: "unsubmitted", edits, submittedDraft: snapshot, lifecycleId, attempt: Symbol(),
    });
  };
  const discardLocalCopy = (itemId: string) => {
    if (queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId)?.status === "local_copy") setState(itemId, null);
  };
  const supersede = async (itemId: string, lifecycleId: string | null) => {
    let current = queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId);
    if (!current && lifecycleId) {
      current = { status: "unconfirmed", outcome: "unknown", edits: {}, submittedDraft: {}, lifecycleId, attempt: Symbol() };
    }
    if (!current?.lifecycleId || !["editing", "unconfirmed", "in_progress", "needs_fence", "refresh_failed", "recovery_failed"].includes(current.status)) return;
    setState(itemId, { ...current, status: "recovering" });
    try {
      const result = await http.json<ManualCaptureSupersedeResponse>("POST", `/v1/discovery/manual-capture/${encodeURIComponent(itemId)}/supersede`, { body: { expectedLifecycleId: current.lifecycleId } });
      if (result?.ok !== true || result.itemId !== itemId || !/^[a-f0-9]{64}$/.test(result.lifecycleId)
          || result.lifecycleId === current.lifecycleId) throw new Error("invalid capture recovery response");
      if (queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId)?.attempt !== current.attempt) return;
      // Another attempt may have changed the server draft while this request
      // was blocked. Recover the full submitted snapshot, not just fields the
      // user happened to edit before submitting.
      const rebound = { ...current, edits: { ...current.submittedDraft, ...current.edits },
        lifecycleId: result.lifecycleId, status: "recovering" as const };
      setState(itemId, rebound);
      const queueKey = discoveryKeys.manualCapture(tenantId);
      await queryClient.cancelQueries({ queryKey: queueKey });
      const queue = await queryClient.fetchQuery({ queryKey: queueKey, queryFn: () => http.json<ManualCaptureListResponse>("GET", "/v1/discovery/manual-capture"), staleTime: 0, retry: false });
      if (queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId)?.attempt !== current.attempt) return;
      const item = queue.items.find((candidate) => candidate.itemId === itemId);
      setState(itemId, { ...rebound, status: item?.lifecycleId === result.lifecycleId ? "rejected" : "local_copy" });
    } catch {
      const latest = queryClient.getQueryData<CaptureImportStates>(stateKey)?.get(itemId);
      if (latest?.attempt === current.attempt) setState(itemId, { ...latest, status: "recovery_failed" });
    }
  };
  return { ...mutation, states, updateEdits, discardLocalCopy, supersede: (itemId: string, lifecycleId: string | null) => { void supersede(itemId, lifecycleId); }, retryReconciliation: (itemId: string) => { void reconcile(itemId); } };
}

export function useManualCaptureDismissMutation(onDismissed?: (itemId: string) => void) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ itemId, lifecycleId }: { itemId: string; lifecycleId: string | null }) => {
      const result = await http.json<ManualCaptureDismissResponse>("POST", `/v1/discovery/manual-capture/${encodeURIComponent(itemId)}/dismiss`, { body: lifecycleId ? { expectedLifecycleId: lifecycleId } : {} });
      if (result?.ok !== true || result.itemId !== itemId || result.status !== "dismissed") {
        throw new Error("Dismissal could not be confirmed. Refresh the capture queue before retrying.");
      }
      return result;
    },
    onSuccess: async (_result, { itemId, lifecycleId }) => {
      const queueKey = discoveryKeys.manualCapture(tenantId);
      // An earlier queue read must not restore an item after its confirmed dismissal.
      await queryClient.cancelQueries({ queryKey: queueKey });
      queryClient.setQueryData<CaptureImportStates>(discoveryKeys.manualCaptureImports(tenantId), (previous) => {
        if (previous?.get(itemId)?.lifecycleId !== lifecycleId) return previous;
        const next = new Map(previous);
        next.delete(itemId);
        return next;
      });
      queryClient.setQueryData<ManualCaptureListResponse>(queueKey, (previous) => previous && ({
        ...previous,
        items: previous.items.filter((item) => item.itemId !== itemId || (item.lifecycleId ?? null) !== lifecycleId),
      }));
      onDismissed?.(itemId);
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: discoveryKeys.manualCapture(tenantId) });
    },
  });
}

export function useDiscoveryFeedbackMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DiscoveryFeedbackRequest) => http.json<DiscoveryFeedbackResponse>("POST", "/v1/discovery/feedback", { body }),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.feedback(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceQuality(tenantId) }),
      ]);
    },
  });
}

export function useRoleMatchFeedbackDecisionMutation() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      suggestionId,
      body,
    }: {
      suggestionId: string;
      body: RoleMatchFeedbackDecisionRequest;
    }) => {
      const path = `/v1/discovery/role-match-feedback/${encodeURIComponent(suggestionId)}/decision`;
      return http.json<RoleMatchFeedbackDecisionResponse>("POST", path, { body }).then((response) => {
        const expected = body.decision === "approve" ? "approved" : "declined";
        if (response?.ok !== true || response.suggestion?.suggestionId !== suggestionId || response.suggestion.status !== expected) {
          throw createUnconfirmedWriteError("POST", path, new Error("The proposal decision was not confirmed."));
        }
        return response;
      });
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: discoveryKeys.roleMatchFeedback(tenantId),
      });
    },
  });
}
