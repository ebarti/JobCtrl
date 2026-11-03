import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { discoveryKeys } from "../queryKeys.js";
import type {
  DiscoveryFeedbackRequest,
  ManualCaptureImportRequest,
  ManualCaptureListResponse,
  QuarantineDecision,
  RoleMatchFeedbackDecisionRequest,
  SourceLocatorDecisionRequest,
  SourceStatePatch,
  SourceUpsertRequest,
} from "@jobctrl/contracts";

export function useUpsertDiscoverySourceMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: SourceUpsertRequest) => api.upsertDiscoverySource(body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function usePatchDiscoverySourceStateMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sourceId, body }: { sourceId: string; body: SourceStatePatch }) =>
      api.patchDiscoverySourceState(sourceId, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function usePromoteSourceLocatorCandidateMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ candidateId, body = {} }: { candidateId: string; body?: SourceLocatorDecisionRequest }) =>
      api.promoteSourceLocatorCandidate(candidateId, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceLocator(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useRejectSourceLocatorCandidateMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ candidateId, body = {} }: { candidateId: string; body?: SourceLocatorDecisionRequest }) =>
      api.rejectSourceLocatorCandidate(candidateId, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceLocator(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useDiscoveryQuarantineDecisionMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobKey, body }: { jobKey: string; body: QuarantineDecision }) =>
      api.decideDiscoveryQuarantine(jobKey, body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.quarantine(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.feedback(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceQuality(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
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
  // This reason is emitted only from a completed, failed workflow result, not
  // from a transport 503 or a failed attempt to wait for the workflow.
  if (typeof error === "object" && error !== null && "status" in error && error.status === 503
      && "responseBody" in error && typeof error.responseBody === "object" && error.responseBody !== null
      && "reason" in error.responseBody && error.responseBody.reason === "manual_capture_provider_failed") return "rejected";
  if (typeof error === "object" && error !== null && "status" in error && error.status === 500
      && "responseBody" in error && typeof error.responseBody === "object" && error.responseBody !== null
      && "reason" in error.responseBody && error.responseBody.reason === "manual_capture_database_failed") return "rejected";
  if (typeof error === "object" && error !== null && "writeOutcomeUnknown" in error
      && error.writeOutcomeUnknown === false && "status" in error
      && (error.status === 400 || error.status === 404 || error.status === 422)) return "rejected";
  if (typeof error === "object" && error !== null && "writeOutcomeUnknown" in error
      && error.writeOutcomeUnknown === false && "status" in error && error.status === 409
      && "responseBody" in error && typeof error.responseBody === "object" && error.responseBody !== null
      && "reason" in error.responseBody
      && (error.responseBody.reason === "manual_capture_state_changed"
        || error.responseBody.reason === "capture_replay_mismatch")) return "rejected";
  if (typeof error === "object" && error !== null && "writeOutcomeUnknown" in error
      && error.writeOutcomeUnknown === false && "status" in error && error.status === 409
      && "responseBody" in error && typeof error.responseBody === "object" && error.responseBody !== null
      && "reason" in error.responseBody && error.responseBody.reason === "manual_capture_in_progress") return "in_progress";
  return "unknown";
}

export function useManualCaptureImportMutation(items: ManualCaptureListResponse["items"]) {
  const tenantId = useTenantId();
  const { api } = usePorts();
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
        queryKey: queueKey, queryFn: () => api.manualCaptureQueue(), staleTime: 0, retry: false,
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
        const prepared = await api.prepareManualCapture(itemId, body);
        if (prepared.itemId !== itemId || !/^[a-f0-9]{64}$/.test(prepared.lifecycleId)
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
        return await api.importManualCapture(itemId, { ...body, expectedLifecycleId: prepared.lifecycleId });
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
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
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
      const result = await api.supersedeManualCapture(itemId, current.lifecycleId);
      if (result.itemId !== itemId || !/^[a-f0-9]{64}$/.test(result.lifecycleId)
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
      const queue = await queryClient.fetchQuery({ queryKey: queueKey, queryFn: () => api.manualCaptureQueue(), staleTime: 0, retry: false });
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
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ itemId, lifecycleId }: { itemId: string; lifecycleId: string | null }) => api.dismissManualCapture(itemId,
      lifecycleId ? { expectedLifecycleId: lifecycleId } : {}),
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
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: DiscoveryFeedbackRequest) => api.recordDiscoveryFeedback(body),
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: discoveryKeys.feedback(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceRegistry(tenantId) }),
        queryClient.invalidateQueries({ queryKey: discoveryKeys.sourceQuality(tenantId) }),
        queryClient.invalidateQueries({ queryKey: dashboardKeys.summary(tenantId) }),
      ]);
    },
  });
}

export function useRoleMatchFeedbackDecisionMutation() {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      suggestionId,
      body,
    }: {
      suggestionId: string;
      body: RoleMatchFeedbackDecisionRequest;
    }) => api.decideRoleMatchFeedbackSuggestion(suggestionId, body),
    onSettled: async () => {
      await queryClient.invalidateQueries({
        queryKey: discoveryKeys.roleMatchFeedback(tenantId),
      });
    },
  });
}
