import { JobCtrlApiError } from "@jobctrl/api-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";
import { create } from "zustand";

import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { requestWorkspace } from "../../../shared/lib/useSessionRequestIdentity.js";
import type { HttpPort, SessionPort } from "../../../shared/ports/index.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { discoveryKeys } from "../queryKeys.js";
import { useDiscoveryActionRecovery } from "./useDiscoveryActionRecovery.js";

const ACTIVE = ["pending", "start_failed", "queued", "running"] as const;
const TERMINAL = ["succeeded", "failed", "cancelled"] as const;
const SearchActionSchema = z.object({
  runId: z.string().min(1), action: z.literal("discovery.search"),
  status: z.enum([...ACTIVE, ...TERMINAL]), cancellationRequested: z.boolean(),
  errorCode: z.string().nullable().optional(), result: z.unknown().optional(),
  createdAt: z.string().optional(), updatedAt: z.string().optional(),
}).passthrough();
const ActionPageSchema = z.object({ runs: z.array(SearchActionSchema) });
const StartReceiptSchema = z.object({ runId: z.string().min(1), workflowId: z.string().min(1), status: z.enum([...ACTIVE, ...TERMINAL]) });
const SourceFailureSchema = z.object({ boards: z.array(z.string()).optional(), sourceId: z.string().optional(), sourceFamily: z.string().optional(), unitId: z.string().optional(), code: z.string(), message: z.string().optional() });
const RunListSchema = z.object({ ok: z.literal(true), runs: z.array(z.object({
  runId: z.string().min(1), status: z.string(), newJobs: z.number().int().nonnegative(),
  failures: z.array(SourceFailureSchema).optional(), observedJobs: z.number().int().nonnegative(), failureCode: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
}).passthrough()) });
const ResultSchema = z.object({ failures: z.array(SourceFailureSchema).optional(), status: z.string().optional(), acquisitionStatus: z.string().optional(),
  preparationAvailable: z.boolean().optional(), preparation: z.object({ status: z.string(), assessedJobs: z.number().int().nonnegative(), failedJobs: z.number().int().nonnegative(),
    failures: z.array(z.object({ jobId: z.string(), stage: z.string(), code: z.string().nullable() })) }).optional(),
  newJobs: z.number().int().nonnegative().optional(), observedJobs: z.number().int().nonnegative().optional() }).passthrough();
const ScopeBusySchema = z.object({ error: z.object({ code: z.literal("action_scope_busy") }) });
export type DiscoverySearchPayload = { queries?: string[]; locations?: { location: string; remote: boolean }[]; expectedProfileVersion?: number };
type SearchAction = z.infer<typeof SearchActionSchema>;
type Workspace = Awaited<ReturnType<typeof requestWorkspace>>;
type SearchActions = { workspace: Workspace; active: SearchAction[]; latest: SearchAction | null };
type PendingSearch = Workspace & { payload: string; body: DiscoverySearchPayload; requestId: string; uncertain: boolean; receipt?: z.infer<typeof StartReceiptSchema> };
type Memory = { busy: boolean; pending?: PendingSearch };

// Request bodies remain in this browser session's memory. Storage contains only
// opaque recovery identity, fingerprint, workspace and source revision.
const useSearchMemory = create<{ sessions: ReadonlyMap<SessionPort, ReadonlyMap<string, Memory>> }>(() => ({ sessions: new Map() }));
function memoryFor(session: SessionPort, tenant: string) { return useSearchMemory.getState().sessions.get(session)?.get(tenant); }
function updateMemory(session: SessionPort, tenant: string, update: (previous: Memory) => Memory) {
  useSearchMemory.setState((state) => {
    const sessions = new Map(state.sessions); const tenants = new Map(sessions.get(session));
    tenants.set(tenant, update(tenants.get(tenant) ?? { busy: false })); sessions.set(session, tenants);
    return { sessions };
  });
}
function active(status: string) { return (ACTIVE as readonly string[]).includes(status); }
function terminal(status: string) { return (TERMINAL as readonly string[]).includes(status); }
function sameWorkspace(left: Workspace, right: Workspace) { return left.workspaceId === right.workspaceId && left.databaseInstanceId === right.databaseInstanceId; }

async function readSearchActions(http: HttpPort): Promise<SearchActions> {
  const workspace = await requestWorkspace(http);
  // Discovery's acquired-run list starts after planning. Inspect every active
  // action state, independently of the bounded terminal history page.
  const pages = await Promise.all([undefined, ...ACTIVE].map(async (status) => ActionPageSchema.parse(await http.json<unknown>("GET", "/v1/action-runs", {
    query: { action: "discovery.search", status, limit: 1 }, expectedDatabaseInstanceId: workspace.databaseInstanceId,
  }))));
  const activeRuns = pages.slice(1).flatMap((page) => page.runs);
  activeRuns.sort((left, right) => (right.createdAt ?? "").localeCompare(left.createdAt ?? ""));
  return { workspace, active: activeRuns, latest: pages[0]?.runs[0] ?? null };
}

export function useDiscoverySearchController({ disabledReason, profileVersion, workspaceIdentity, savedPreferences = false }: {
  readonly disabledReason?: string | undefined;
  readonly profileVersion?: number | null | undefined;
  readonly workspaceIdentity?: string | undefined;
  readonly savedPreferences?: boolean;
} = {}) {
  const tenant = useTenantId(); const { http, session } = usePorts(); const client = useQueryClient();
  const memory = useSearchMemory((state) => state.sessions.get(session)?.get(tenant));
  const recovery = useDiscoveryActionRecovery("discovery.search", { paused: Boolean(memory?.busy) });
  const recoveryRef = useRef(recovery); recoveryRef.current = recovery;
  const pending = memory?.pending?.requestId === recovery.record?.requestId ? memory?.pending : undefined;
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [startMessage, setStartMessage] = useState<string | null>(null);
  const attemptRequest = useRef<string | null>(null);
  const confirmedRequest = useRef<string | null>(null);
  const actions = useQuery({ queryKey: discoveryKeys.searchActions(tenant), queryFn: () => readSearchActions(http), retry: false,
    refetchInterval: 3000, meta: { suppressGlobalErrorToast: true } });
  const runs = useQuery({ queryKey: discoveryKeys.runs(tenant), enabled: Boolean(actions.data), retry: false,
    queryFn: async () => {
      const workspace = await requestWorkspace(http);
      return { ...RunListSchema.parse(await http.json<unknown>("GET", "/v1/discovery/runs", { expectedDatabaseInstanceId: workspace.databaseInstanceId })), workspace };
    }, refetchInterval: actions.data?.active.length || recovery.record ? 3000 : false,
    meta: { suppressGlobalErrorToast: true } });
  const recordMatchesWorkspace = Boolean(recovery.record && actions.data && sameWorkspace(recovery.record, actions.data.workspace));
  const localStatus = recordMatchesWorkspace && !recovery.statusError ? SearchActionSchema.safeParse(recovery.status) : null;
  const ownAction = localStatus?.success ? localStatus.data : null;
  const receiptAction: SearchAction | null = pending?.receipt && actions.data && sameWorkspace(pending, actions.data.workspace)
    ? { ...pending.receipt, action: "discovery.search" as const, cancellationRequested: false } : null;
  const selected = actions.data?.active[0] ?? (recovery.record ? ownAction ?? receiptAction : actions.data?.latest) ?? null;
  const detail = useQuery({ queryKey: discoveryKeys.searchAction(tenant, actions.data?.workspace.databaseInstanceId ?? "", selected?.runId ?? ""),
    enabled: Boolean(selected && actions.data), retry: false,
    queryFn: async () => {
      if (!selected || !actions.data) throw new Error("No search is selected.");
      const result = SearchActionSchema.parse(await http.json<unknown>("GET", `/v1/action-runs/${encodeURIComponent(selected.runId)}`, { expectedDatabaseInstanceId: actions.data.workspace.databaseInstanceId }));
      if (result.runId !== selected.runId) throw new Error("The search response returned a different run.");
      return result;
    }, refetchInterval: (query) => !query.state.data || active(query.state.data.status) || Boolean(query.state.error) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true } });
  const action = detail.data?.runId === selected?.runId ? detail.data : selected;
  const result = ResultSchema.safeParse(action?.result);
  const recorded = runs.data && actions.data && sameWorkspace(runs.data.workspace, actions.data.workspace) ? runs.data.runs.find((run) => run.runId === action?.runId) : undefined;
  const terminalOutcome = result.success && ["completed", "partial"].includes(result.data.status ?? "") ? result.data.status
    : recorded && ["completed", "partial"].includes(recorded.status) ? recorded.status : null;
  const outcomeUnavailable = action?.status === "succeeded" && !terminalOutcome;

  if (ownAction && recovery.record) confirmedRequest.current = recovery.record.requestId;

  useEffect(() => {
    if (!recovery.record || recovery.statusError || !recovery.status || !terminal(recovery.status.status)) return;
    const requestId = recovery.record.requestId;
    void recoveryRef.current.reconcileTerminal().then((resolved) => {
      if (!resolved) return;
      updateMemory(session, tenant, (previous) => previous.pending?.requestId === requestId ? { busy: previous.busy } : previous);
      setReconcileError(null);
      void client.invalidateQueries({ queryKey: discoveryKeys.searchActions(tenant) });
      void client.invalidateQueries({ queryKey: discoveryKeys.runs(tenant) });
    }).catch((error: unknown) => setReconcileError(error instanceof Error ? error.message : "The earlier search could not be reconciled."));
  }, [client, recovery.record?.requestId, recovery.status?.runId, recovery.status?.status, recovery.statusError, session, tenant]);

  const start = useMutation({ mutationKey: [...discoveryKeys.searchActions(tenant), "start"],
    mutationFn: async (body: DiscoverySearchPayload) => {
      if (memoryFor(session, tenant)?.busy) throw new Error("A search request is already being sent.");
      updateMemory(session, tenant, (previous) => ({ ...previous, busy: true }));
      setStartMessage(null);
      attemptRequest.current = null;
      try {
        const fresh = await client.fetchQuery({ queryKey: discoveryKeys.searchActions(tenant), queryFn: () => readSearchActions(http), staleTime: 0 });
        const earlier = recoveryRef.current;
        const expectedDatabase = earlier.record?.databaseInstanceId ?? workspaceIdentity;
        if (savedPreferences && (!expectedDatabase || fresh.workspace.databaseInstanceId !== expectedDatabase)) {
          throw new Error("The saved search criteria belong to a different workspace. Reload and review them before starting.");
        }
        const earlierRun = earlier.status?.runId;
        if (fresh.active.some((run) => run.runId !== earlierRun || !["pending", "start_failed"].includes(run.status))) {
          throw new Error("A search is already active. Follow its progress before starting another.");
        }
        const payload = JSON.stringify(body);
        const previous = memoryFor(session, tenant)?.pending;
        if (previous && earlier.record?.requestId === previous.requestId && previous.payload !== payload) throw new Error("Retry the exact earlier search inputs first.");
        const identity = await earlier.begin(body, body.expectedProfileVersion, expectedDatabase);
        attemptRequest.current = identity.requestId;
        const request: PendingSearch = { ...identity, payload, body: structuredClone(body), uncertain: false };
        updateMemory(session, tenant, (current) => ({ ...current, pending: request }));
        try {
          const response = await http.json<unknown>("POST", "/v1/actions/discovery.search", { body, idempotencyKey: identity.requestId, expectedDatabaseInstanceId: identity.databaseInstanceId });
          const parsed = StartReceiptSchema.safeParse(response);
          if (!parsed.success) throw createUnconfirmedWriteError("POST", "/v1/actions/discovery.search", parsed.error);
          updateMemory(session, tenant, (current) => current.pending?.requestId === identity.requestId ? { ...current, pending: { ...request, receipt: parsed.data } } : current);
          return parsed.data;
        } catch (error) {
          if (error instanceof JobCtrlApiError && error.status === 409 && ScopeBusySchema.safeParse(error.responseBody).success) {
            // An exact refusal settles this first attempt only. A retry may
            // still have an older delivery-uncertain attempt in transit.
            if (!identity.reused && await recoveryRef.current.releaseUnadmitted(identity.requestId)) {
              updateMemory(session, tenant, (current) => current.pending?.requestId === identity.requestId ? { busy: current.busy } : current);
            } else if (identity.reused) {
              updateMemory(session, tenant, (current) => current.pending?.requestId === identity.requestId ? { ...current, pending: { ...request, uncertain: true } } : current);
            }
            setStartMessage("Another search is already active. Its progress is shown here.");
            await client.fetchQuery({ queryKey: discoveryKeys.searchActions(tenant), queryFn: () => readSearchActions(http), staleTime: 0 });
            return null;
          }
          updateMemory(session, tenant, (current) => current.pending?.requestId === identity.requestId ? { ...current, pending: { ...request, uncertain: true } } : current);
          throw error;
        }
      } finally { updateMemory(session, tenant, (current) => ({ ...current, busy: false })); }
    },
    onSettled: () => { recoveryRef.current.refresh(); void client.invalidateQueries({ queryKey: discoveryKeys.searchActions(tenant) }); void client.invalidateQueries({ queryKey: discoveryKeys.runs(tenant) }); },
  });
  const stop = useMutation({ mutationFn: async (runId: string) => {
    if (!actions.data) throw new Error("Search workspace identity is unavailable.");
    const current = await requestWorkspace(http);
    if (!sameWorkspace(current, actions.data.workspace)) throw new Error("The search belongs to a different workspace. Return there before requesting a stop.");
    const result = SearchActionSchema.parse(await http.json<unknown>("POST", `/v1/action-runs/${encodeURIComponent(runId)}/cancel`, { body: {}, expectedDatabaseInstanceId: current.databaseInstanceId }));
    if (result.runId !== runId || !result.cancellationRequested) throw new Error("The stop request could not be confirmed.");
    client.setQueryData(discoveryKeys.searchAction(tenant, current.databaseInstanceId, runId), result);
    return result;
  }, onSettled: () => { recoveryRef.current.refresh(); void client.invalidateQueries({ queryKey: discoveryKeys.searchActions(tenant) }); void client.invalidateQueries({ queryKey: discoveryKeys.runs(tenant) }); } });

  const otherActive = actions.data?.active.some((run) => run.runId !== ownAction?.runId || !["pending", "start_failed"].includes(run.status)) ?? false;
  const needsPreviousInputs = Boolean(recovery.record && !pending && !recovery.record.sourceRevision);
  let blockedReason: string | undefined;
  if (!recovery.ready) blockedReason = recovery.error ? "Session recovery storage is unavailable. Restore it before searching." : "Checking session recovery storage…";
  else if (memory?.busy) blockedReason = "Queueing your search…";
  else if (actions.isPending) blockedReason = "Checking current searches…";
  else if (actions.error) blockedReason = "Current search status is unavailable. Check it before starting another search.";
  else if (detail.error) blockedReason = "The recorded search status is unavailable. Check it before starting another search.";
  else if (outcomeUnavailable) blockedReason = "The workflow finished, but its source outcome is unavailable. Check search status before starting another search.";
  else if (recovery.record && recovery.statusError && !recovery.canRetry) blockedReason = "The earlier search request could not be checked. Reconcile it before starting another search.";
  else if (reconcileError) blockedReason = reconcileError;
  else if (recovery.record && !recovery.canRetry) blockedReason = "An earlier search is still active or awaiting an exact status check.";
  else if (otherActive) blockedReason = "A search is already active. Follow its progress before starting another.";
  else if (savedPreferences && needsPreviousInputs) blockedReason = "In Search preferences, open Search plans, schedules and source behavior → One-off search with temporary criteria. Re-enter the earlier inputs there to retry the same request.";
  else if (!recovery.record && disabledReason) blockedReason = disabledReason;
  else if (!recovery.record && savedPreferences && !profileVersion) blockedReason = "Save your Search preferences before starting a search.";
  else if (!recovery.record && savedPreferences && !workspaceIdentity) blockedReason = "Checking the saved search workspace…";

  const resultCounts = result.success && result.data.newJobs !== undefined && result.data.observedJobs !== undefined ? { newJobs: result.data.newJobs, observedJobs: result.data.observedJobs } : null;
  const counts = action && terminal(action.status) && resultCounts ? resultCounts : recorded ? { newJobs: recorded.newJobs, observedJobs: recorded.observedJobs } : resultCounts;
  const statusUnavailable = Boolean(actions.error || detail.error || outcomeUnavailable || (recovery.record && recovery.statusError && !recovery.canRetry) || reconcileError);
  const status = memory?.busy ? "queueing" : statusUnavailable ? "status-unavailable" : action
    ? action.cancellationRequested && active(action.status) ? "cancel-requested" : action.status === "succeeded" ? terminalOutcome === "partial" ? "partial" : "completed" : action.status
    : recovery.record ? recovery.canRetry ? "unconfirmed" : "checking" : actions.isPending ? "checking" : "idle";

  return {
    workspace: actions.data?.workspace,
    assessmentAvailable: result.success ? result.data.preparationAvailable : undefined,
    assessment: result.success ? result.data.preparation : undefined,
    acquisitionStatus: result.success ? result.data.acquisitionStatus : undefined,
    action, counts, status, sourceFailures: result.success ? result.data.failures ?? recorded?.failures ?? [] : recorded?.failures ?? [], statusUnavailable, countsStale: Boolean(runs.error || statusUnavailable),
    blockedReason, canStart: !blockedReason && !start.isPending, isPending: Boolean(memory?.busy || start.isPending),
    pendingBody: pending?.body, uncertain: Boolean(pending?.uncertain && !ownAction), recovery,
    hasUnconfirmedRequest: Boolean(recovery.record && !ownAction && (pending?.uncertain || recovery.statusError)),
    startError: attemptRequest.current && attemptRequest.current === confirmedRequest.current ? null : start.error,
    startMessage, stopError: stop.error, isStopping: stop.isPending,
    canStop: Boolean(action && active(action.status) && !action.cancellationRequested && !statusUnavailable),
    history: runs.data?.runs ?? [], historyLoading: runs.isPending, historyError: runs.error,
    launch(overrides: Pick<DiscoverySearchPayload, "queries" | "locations"> = {}) {
      if (blockedReason || start.isPending) return;
      const previous = recovery.record;
      const revision = previous?.sourceRevision ?? profileVersion;
      const body = pending?.body ?? {
        ...((savedPreferences || previous?.sourceRevision) ? { queries: [], locations: [], ...(revision ? { expectedProfileVersion: revision } : {}) } : {}),
        ...overrides,
      };
      start.mutate(body);
    },
    requestStop(runId = action?.runId) { if (runId && !stop.isPending) stop.mutate(runId); },
    async checkPrevious() {
      const requestId = recovery.record?.requestId;
      if (await recovery.check()) updateMemory(session, tenant, (previous) => previous.pending?.requestId === requestId ? { busy: previous.busy } : previous);
      void actions.refetch(); void runs.refetch();
    },
    refresh() { void actions.refetch(); if (selected) void detail.refetch(); void runs.refetch(); recovery.refresh(); setReconcileError(null); },
  };
}

export type DiscoverySearchController = ReturnType<typeof useDiscoverySearchController>;
