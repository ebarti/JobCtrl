import { JobCtrlApiError } from "@jobctrl/api-client";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { z } from "zod";

import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import { lookupSessionAction, requestWorkspace, useSessionRequestIdentity, type SessionRequestIdentity } from "../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { Button } from "../../shared/ui/button.js";

const ACTION = "fit.refresh";
const LIMITS = { max_model_calls: 40, max_requirements: 100, max_wording_proposals: 20, max_duration_seconds: 600 } as const;
const limitsSchema = z.object({ max_model_calls: z.number().int().nonnegative(), max_requirements: z.number().int().nonnegative(),
  max_wording_proposals: z.number().int().nonnegative(), max_duration_seconds: z.number().int().nonnegative() }).passthrough();
const wordingFailureSchema = z.object({ proposal_id: z.string().min(1), achievement_id: z.string().nullable().optional(),
  status: z.string(), failure_code: z.string().nullable(), requirement_ids: z.array(z.string()).optional() }).passthrough();
const operationSchema = z.object({
  operation_id: z.string().min(1), status: z.enum(["running", "completed", "failed", "cancelled", "stale", "limited"]),
  phase: z.enum(["selection", "qualification", "publication", "coverage", "complete"]), job_ids: z.array(z.string()),
  catalog_revision: z.number().int().nonnegative(), requirement_count: z.number().int().nonnegative(),
  selected_requirement_ids: z.array(z.string()).nullable(), limits: limitsSchema,
  counters: z.object({ model_calls: z.number().int().nonnegative(), requirements_assessed: z.number().int().nonnegative(),
    qualifications_reused: z.number().int().nonnegative(), wording_proposals: z.number().int().nonnegative() }).passthrough(),
  failure_code: z.string().nullable(), partial: z.boolean(), hard_monetary_bound: z.boolean(),
  accepted_score_revisions: z.record(z.string(), z.number().int().nonnegative()),
  wording_failures: z.array(wordingFailureSchema),
  created_at: z.string(), deadline_at: z.string(), updated_at: z.string(),
}).passthrough();
const pendingSchema = z.object({
  profile_id: z.string(), readiness: z.literal("ready"), pending: z.boolean(), pending_reasons: z.array(z.string()), stale_job_ids: z.array(z.string()),
  available_job_ids: z.array(z.string()), catalog_revision: z.number().int().nonnegative(),
  requirement_count: z.number().int().nonnegative(), expected_input_fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  pending_wording_failures: z.array(wordingFailureSchema), latest_operation: operationSchema.nullable(),
}).passthrough();
const profileRequiredSchema = z.object({ profile_id: z.string(), readiness: z.literal("profile_required") }).strict();
const receiptSchema = z.object({ runId: z.string().min(1), workflowId: z.string().min(1),
  status: z.enum(["pending", "queued", "running", "succeeded", "failed", "cancelled", "start_failed"]) }).passthrough();
const scopeBusySchema = z.object({ error: z.object({ code: z.literal("action_scope_busy"),
  details: z.object({ runId: z.string().min(1), action: z.literal(ACTION) }).passthrough() }).passthrough() }).passthrough();
const actionRunSchema = z.object({ runId: z.string().min(1), action: z.literal(ACTION), status: z.string(),
  cancellationRequested: z.boolean(), errorCode: z.string().nullable() }).passthrough();
const archivedIdentitySchema = z.object({ version: z.literal(1), requestId: z.string().min(1).max(200), operation: z.literal(ACTION),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), workspaceId: z.string().min(1), databaseInstanceId: z.string().min(1) }).strict();
const busyIdentitySchema = z.object({ runId: z.string().min(1), workspaceId: z.string().min(1), databaseInstanceId: z.string().min(1) }).strict();

type Operation = z.infer<typeof operationSchema>;
type RunWorkspace = { readonly workspaceId: string; readonly databaseInstanceId: string };
type StartKind = "matches" | "wording";
const phaseLabel: Record<Operation["phase"], string> = {
  selection: "Identifying affected requirements", qualification: "Assessing qualifications", publication: "Saving results",
  coverage: "Reviewing wording", complete: "Complete",
};
const terminalAction = (status: string | undefined) => status === "succeeded" || status === "failed" || status === "cancelled";
const activeAction = (status: string | undefined) => status === "pending" || status === "queued" || status === "running" || status === "start_failed";

function operationMessage(operation: Operation): string {
  if (operation.failure_code === "fit_refresh_retry_stale") return "The wording's sources changed. Update affected matches before requesting another wording retry.";
  switch (operation.status) {
    case "running": return "Update in progress.";
    case "completed": return "Update completed.";
    case "failed": return "Update failed. Previously accepted assessments remain available.";
    case "cancelled": return "Update cancelled. Previously accepted assessments remain available.";
    case "stale": return "Saved inputs changed during the update. Earlier accepted assessments remain available; review the pending changes before starting again.";
    case "limited": return "The update reached a limit before all work finished. Review the remaining pending changes.";
  }
}

/** Fit owns this read and action; hosts compose it without importing Profile internals. */
export function AffectedMatchesPanel(props: { readonly jobIds?: readonly string[] } = {}) {
  const { featureFlags } = usePorts();
  const availability = getApiCapabilityAvailability(featureFlags, "updateAffectedMatches");
  if (availability.isDemo && !availability.available) return <section className="card grid gap-1 p-4" aria-label="Affected matches">
    <h2>Affected matches</h2>
    <p>Updating matches is unavailable in the demo. {availability.reason}</p>
    <div><Button type="button" disabled>Update affected matches</Button></div>
  </section>;
  return <AvailableAffectedMatchesPanel {...props} />;
}

function AvailableAffectedMatchesPanel({ jobIds }: { readonly jobIds?: readonly string[] }) {
  const tenantId = useTenantId();
  const { http, featureFlags, requestIdentity, sessionStorage } = usePorts();
  const client = useQueryClient();
  const identity = useSessionRequestIdentity("affected-matches", ACTION);
  const availability = getApiCapabilityAvailability(featureFlags, "updateAffectedMatches");
  const [message, setMessage] = useState<string | null>(null);
  const [fallbackBusy, setFallbackBusy] = useState<z.infer<typeof busyIdentitySchema> | null>(null);
  const [wordingSelection, setWordingSelection] = useState<{ inventory: string; ids: ReadonlySet<string> } | null>(null);
  const startGuard = useRef(false);
  const archiveStorageKey = JSON.stringify([tenantId, ACTION, "earlier-requests"]);
  const archiveQueryKey = ["tenant", tenantId, "fit", "refresh", "earlier-requests"] as const;
  const archive = useQuery({ queryKey: archiveQueryKey, staleTime: Infinity, retry: false,
    queryFn: (): SessionRequestIdentity[] => {
      const raw = sessionStorage.get(archiveStorageKey);
      if (raw === null) return [];
      try { return z.array(archivedIdentitySchema).parse(JSON.parse(raw)); }
      catch { throw new Error("Earlier update identities could not be read. Restore session storage before starting work."); }
    }, meta: { suppressGlobalErrorToast: true },
  });
  const busyStorageKey = JSON.stringify([tenantId, ACTION, "scope-conflict"]);
  const busyQueryKey = ["tenant", tenantId, "fit", "refresh", "scope-conflict"] as const;
  const busyIdentity = useQuery({ queryKey: busyQueryKey, staleTime: Infinity, retry: false,
    queryFn: () => {
      const raw = sessionStorage.get(busyStorageKey);
      if (raw === null) return null;
      try { return busyIdentitySchema.parse(JSON.parse(raw)); }
      catch { throw new Error("The other update's recovery identity could not be read. Restore session storage before starting work."); }
    }, meta: { suppressGlobalErrorToast: true },
  });
  const busy = fallbackBusy ?? busyIdentity.data;
  const earlierStatuses = useQuery({ queryKey: ["tenant", tenantId, "fit", "refresh", "earlier-status", archive.data ?? []],
    enabled: Boolean(archive.data?.length), retry: false,
    queryFn: async () => Promise.all((archive.data ?? []).map(async (record) => {
      try { return { record, status: await lookupSessionAction(http, record), error: null }; }
      catch (error) { return { record, status: null, error }; }
    })),
    refetchInterval: (query) => query.state.data?.some((item) => !terminalAction(item.status?.status)) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const pending = useQuery({
    queryKey: ["tenant", tenantId, "fit", "refresh", "pending"],
    queryFn: async () => {
      const workspace = await requestWorkspace(http);
      const parsed = z.union([pendingSchema, profileRequiredSchema]).safeParse(await http.json<unknown>("GET", "/v1/fit/refresh/pending", {
        query: { profile_id: "default" }, expectedDatabaseInstanceId: workspace.databaseInstanceId,
      }));
      if (!parsed.success) throw new Error("Pending match changes could not be read safely.");
      return { ...parsed.data, workspace };
    },
    refetchInterval: (query) => query.state.data?.readiness === "ready" && query.state.data.latest_operation?.status === "running" ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const requestStatus = useQuery({
    queryKey: ["tenant", tenantId, "fit", "refresh", "request", identity.record?.requestId ?? ""],
    enabled: identity.ready && Boolean(identity.record), retry: false,
    queryFn: () => {
      if (!identity.record) throw new Error("No earlier update request is recorded.");
      return lookupSessionAction(http, identity.record);
    },
    refetchInterval: (query) => activeAction(query.state.data?.status)
      || (query.state.error instanceof JobCtrlApiError && query.state.error.status === 404) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const pendingReady = pending.data?.readiness === "ready" ? pending.data : undefined;
  const operationId = identity.record ? requestStatus.data?.runId : pendingReady?.latest_operation?.operation_id;
  const operationWorkspace = identity.record ?? pending.data?.workspace;
  const visibleRunId = pendingReady?.latest_operation?.operation_id;
  const visibleRun = useQuery({ queryKey: ["tenant", tenantId, "fit", "refresh", "visible-run", visibleRunId ?? "", pending.data?.workspace.databaseInstanceId ?? ""],
    enabled: Boolean(visibleRunId && pending.data?.workspace), retry: false,
    queryFn: async () => {
      if (!visibleRunId || !pending.data?.workspace) throw new Error("No update is recorded.");
      const parsed = actionRunSchema.safeParse(await http.json<unknown>("GET", `/v1/action-runs/${encodeURIComponent(visibleRunId)}`, {
        expectedDatabaseInstanceId: pending.data.workspace.databaseInstanceId,
      }));
      if (!parsed.success) throw new Error("The update status could not be read safely.");
      return parsed.data;
    }, refetchInterval: (query) => activeAction(query.state.data?.status) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const busyRun = useQuery({ queryKey: ["tenant", tenantId, "fit", "refresh", "scope-run", busy?.runId ?? "", busy?.databaseInstanceId ?? ""], enabled: Boolean(busy), retry: false,
    queryFn: async () => {
      if (!busy) throw new Error("No conflicting update was recorded.");
      const parsed = actionRunSchema.safeParse(await http.json<unknown>("GET", `/v1/action-runs/${encodeURIComponent(busy.runId)}`, {
        expectedDatabaseInstanceId: busy.databaseInstanceId,
      }));
      if (!parsed.success) throw new Error("The other update status could not be read safely.");
      return parsed.data;
    }, refetchInterval: (query) => activeAction(query.state.data?.status) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const operationQuery = useQuery({
    queryKey: ["tenant", tenantId, "fit", "refresh", "operation", operationId ?? "", operationWorkspace?.databaseInstanceId ?? ""], enabled: Boolean(operationId && operationWorkspace), retry: false,
    queryFn: async () => {
      if (!operationId || !operationWorkspace) throw new Error("No update is recorded.");
      try {
        const value = await http.json<unknown>("GET", `/v1/fit/refresh/operations/${encodeURIComponent(operationId)}`, {
          query: { allow_pending: true }, expectedDatabaseInstanceId: operationWorkspace.databaseInstanceId,
        });
        if (value === null) return null;
        const parsed = operationSchema.safeParse(value);
        if (!parsed.success) throw new Error("The recorded update could not be read safely.");
        return parsed.data;
      } catch (error) {
        if (error instanceof JobCtrlApiError && error.status === 404) return null;
        throw error;
      }
    },
    refetchInterval: (query) => query.state.data?.status === "running" || (query.state.data === null && activeAction(requestStatus.data?.status)) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const availableIds = pendingReady?.available_job_ids ?? [];
  const selectedIds = [...new Set(jobIds ?? (availableIds.length <= 100 ? availableIds : []))].filter((id) => availableIds.includes(id)).sort();
  const selectionRequired = !jobIds && availableIds.length > 100;
  const selectionInvalid = selectionRequired || Boolean(jobIds && (selectedIds.length === 0 || selectedIds.length > 100));
  const latest = pendingReady?.latest_operation;
  const notRecorded = requestStatus.error instanceof JobCtrlApiError && requestStatus.error.status === 404;
  const operation = operationQuery.data ?? (!identity.record || notRecorded ? latest : null);
  const publishedScores = operation ? Object.keys(operation.accepted_score_revisions).length : 0;
  const wordingFailures = pendingReady?.pending_wording_failures ?? [];
  const retryRows = wordingFailures.filter((item) => item.status === "failed" || item.status === "uncertain");
  const owners = retryRows.map((item) => item.achievement_id);
  const needsWordingChoice = retryRows.length > 1 && (owners.some((id) => !id) || new Set(owners).size !== owners.length);
  const wordingInventory = JSON.stringify(retryRows.map((item) => [item.proposal_id, item.achievement_id, item.status]).sort());
  const retryIds = retryRows.filter((item) => !needsWordingChoice || (wordingSelection !== null && wordingSelection.inventory === wordingInventory && wordingSelection.ids.has(item.proposal_id)))
    .map((item) => item.proposal_id).sort();
  const recoveryRetryIds = retryIds;
  const makeBody = (kind: StartKind, ids: readonly string[]) => ({ profile_id: "default", job_ids: kind === "wording" ? [] : selectedIds,
    prepare_wording: true, limits: LIMITS, expected_input_fingerprint: pendingReady!.expected_input_fingerprint,
    retry_wording_proposal_ids: kind === "wording" ? [...ids] : [] });
  const fingerprintQuery = useQuery({
    queryKey: ["tenant", tenantId, "fit", "refresh", "current-fingerprint", selectedIds, recoveryRetryIds, pendingReady?.expected_input_fingerprint ?? ""],
    enabled: Boolean(identity.record && pendingReady), retry: false,
    queryFn: async () => ({
      matches: await requestIdentity.fingerprint(JSON.stringify({ action: ACTION, body: makeBody("matches", []) })),
      wording: recoveryRetryIds.length ? await requestIdentity.fingerprint(JSON.stringify({ action: ACTION, body: makeBody("wording", recoveryRetryIds) })) : null,
    }),
    meta: { suppressGlobalErrorToast: true },
  });
  const otherActive = latest?.status === "running" && latest.operation_id !== requestStatus.data?.runId;
  const exactKind: StartKind | null = !identity.record ? null : fingerprintQuery.data?.matches === identity.record.fingerprint
    ? "matches" : fingerprintQuery.data?.wording === identity.record.fingerprint ? "wording" : null;
  const exactInputs = exactKind !== null;
  const mayRetry = Boolean(identity.record && exactInputs && !requestStatus.isFetching && (notRecorded || ["pending", "start_failed"].includes(requestStatus.data?.status ?? "")));

  const start = useMutation({
    mutationFn: async ({ kind, proposalIds }: { kind: StartKind; proposalIds: readonly string[] }) => {
      if (!identity.ready || !archive.isSuccess || !busyIdentity.isSuccess || !pendingReady || pending.isError) throw new Error("Refresh the saved match state and recovery storage before starting an update.");
      if (kind === "matches" && selectionInvalid) throw new Error("Select between 1 and 100 scored jobs.");
      if (kind === "wording" && (!proposalIds.length || proposalIds.length > 100
          || proposalIds.some((id) => !recoveryRetryIds.includes(id)))) throw new Error("Review the failed wording before retrying.");
      const body = makeBody(kind, proposalIds);
      const fingerprint = await requestIdentity.fingerprint(JSON.stringify({ action: ACTION, body }));
      const workspace = await requestWorkspace(http);
      if (pendingReady.workspace.workspaceId !== workspace.workspaceId || pendingReady.workspace.databaseInstanceId !== workspace.databaseInstanceId) {
        throw new Error("The saved match state belongs to a different workspace or database. Refresh it before starting an update.");
      }
      const previous = identity.current();
      if (previous && (previous.fingerprint !== fingerprint || previous.workspaceId !== workspace.workspaceId
          || previous.databaseInstanceId !== workspace.databaseInstanceId)) {
        throw new Error("The saved inputs or workspace differ from the earlier unconfirmed request. Check that request before starting different work.");
      }
      if (previous) {
        try {
          const observed = await lookupSessionAction(http, previous);
          if (!["pending", "start_failed"].includes(observed.status)) throw new Error(`The previous update is ${observed.status}. Review it before starting another.`);
        } catch (error) {
          if (!(error instanceof JobCtrlApiError && error.status === 404)) throw error;
        }
      }
      const latestIdentity = identity.current();
      if (latestIdentity && (!previous || latestIdentity.requestId !== previous.requestId)) throw new Error("Another update request needs review.");
      const saved = previous ?? { version: 1 as const, requestId: requestIdentity.create(), operation: ACTION, fingerprint, ...workspace };
      identity.save(saved);
      const path = `/v1/actions/${ACTION}`;
      try {
        const parsed = receiptSchema.safeParse(await http.json<unknown>("POST", path, {
          body, idempotencyKey: saved.requestId, expectedDatabaseInstanceId: saved.databaseInstanceId,
        }));
        if (!parsed.success) throw createUnconfirmedWriteError("POST", path, parsed.error);
        return parsed.data;
      } catch (error) {
        const errorBody = error instanceof JobCtrlApiError ? error.responseBody : null;
        const scopeBusy = scopeBusySchema.safeParse(errorBody);
        if (scopeBusy.success) {
          const conflict = { runId: scopeBusy.data.error.details.runId, workspaceId: saved.workspaceId, databaseInstanceId: saved.databaseInstanceId };
          setFallbackBusy(conflict);
          try { sessionStorage.set(busyStorageKey, JSON.stringify(conflict)); client.setQueryData(busyQueryKey, conflict); setFallbackBusy(null); }
          catch { setMessage("The other update could not be retained for recovery. View or cancel it before leaving this page."); }
        }
        const errorCode = errorBody && typeof errorBody === "object" && "error" in errorBody
          && errorBody.error && typeof errorBody.error === "object" && "code" in errorBody.error ? errorBody.error.code : null;
        const rejected = error instanceof JobCtrlApiError && ((error.status >= 400 && error.status < 500
          && ![408, 409, 429].includes(error.status)) || errorCode === "worker_unavailable" || errorCode === "workspace_changed");
        if (!previous && rejected) {
          try { identity.clear(saved.requestId); } catch { /* Keep an uncertain identity for reconciliation. */ }
        }
        throw error;
      }
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: ["tenant", tenantId, "fit", "refresh"] }); },
  });
  const cancel = useMutation({
    mutationFn: async ({ runId, origin }: { runId: string; origin: RunWorkspace }) => {
      const workspace = await requestWorkspace(http);
      if (origin.workspaceId !== workspace.workspaceId || origin.databaseInstanceId !== workspace.databaseInstanceId) {
        throw new Error("This update belongs to a different workspace or database.");
      }
      return http.json<unknown>("POST", `/v1/action-runs/${encodeURIComponent(runId)}/cancel`, { body: {}, expectedDatabaseInstanceId: origin.databaseInstanceId });
    },
    onSettled: () => { void client.invalidateQueries({ queryKey: ["tenant", tenantId, "fit", "refresh"] }); },
  });
  const startUpdate = async (kind: StartKind = "matches", proposalIds: readonly string[] = []) => {
    if (startGuard.current) return;
    startGuard.current = true;
    setMessage(null);
    try { await start.mutateAsync({ kind, proposalIds }); } catch { /* The status and recovery controls retain the attempt. */ }
    finally { startGuard.current = false; }
  };
  const startCurrentAfterUnconfirmed = async (kind: StartKind, proposalIds: readonly string[] = []) => {
    if (startGuard.current || !identity.record || !notRecorded || exactInputs || !archive.isSuccess) return;
    startGuard.current = true;
    setMessage(null);
    try {
      const previous = identity.current();
      if (!previous) throw new Error("The earlier request changed. Check its status again.");
      try {
        await lookupSessionAction(http, previous);
        throw new Error("The earlier request is now recorded. Check its status before starting another update.");
      } catch (error) {
        if (!(error instanceof JobCtrlApiError && error.status === 404)) throw error;
      }
      if (identity.current()?.requestId !== previous.requestId) throw new Error("The earlier request changed. Check its status again.");
      const raw = sessionStorage.get(archiveStorageKey);
      const currentArchive = raw === null ? [] : z.array(archivedIdentitySchema).parse(JSON.parse(raw));
      const nextArchive = currentArchive.some((record) => record.requestId === previous.requestId) ? currentArchive : [...currentArchive, previous];
      sessionStorage.set(archiveStorageKey, JSON.stringify(nextArchive));
      client.setQueryData(archiveQueryKey, nextArchive);
      identity.clear(previous.requestId);
      await start.mutateAsync({ kind, proposalIds });
      setMessage(`${kind === "wording" ? "Requested a wording retry" : "Requested an update"} for the current saved changes. The earlier request is retained below for status checks.`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The current update could not be started.");
    } finally { startGuard.current = false; }
  };
  const status = requestStatus.data?.status;
  const scopeBlocked = Boolean(busy && (!busyRun.data || activeAction(busyRun.data.status)));
  const canStart = availability.available && identity.ready && archive.isSuccess && busyIdentity.isSuccess && Boolean(pendingReady) && !pending.isPending && !pending.isError && !start.isPending && !scopeBlocked
    && !otherActive && (!identity.record || mayRetry) && (exactKind === "wording" || !selectionInvalid);
  const canRetryWording = availability.available && identity.ready && archive.isSuccess && busyIdentity.isSuccess && Boolean(pendingReady) && !pending.isPending
    && !pending.isError && !start.isPending && !scopeBlocked && !otherActive && !identity.record && operation?.status !== "running"
    && retryIds.length > 0 && retryIds.length <= 100;
  const cancellableRun = identity.record && activeAction(status) && !requestStatus.data?.cancellationRequested
    ? requestStatus.data?.runId ? { runId: requestStatus.data.runId, origin: identity.record } : undefined
    : !identity.record && activeAction(visibleRun.data?.status) && !visibleRun.data?.cancellationRequested && visibleRun.data && pending.data?.workspace
      ? { runId: visibleRun.data.runId, origin: pending.data.workspace } : undefined;

  return <section className="card grid gap-1 p-4" aria-label="Affected matches">
    <h2>Affected matches</h2>
    {pending.data?.readiness === "profile_required" ? <p>Save a Profile before updating matches. <Link className="underline" to="/profile">Open Profile</Link></p>
      : <p>Uses your last saved Profile. An update may use your model and prepare wording proposals for review.</p>}
    <details><summary>Work limits</summary><p>Each update can reserve up to 40 model call attempts over 10 minutes, with at most 100 affected requirements, 100 scored jobs and 20 wording proposals. Attempts are counted before provider and budget checks. This request does not impose a hard monetary cap. Saving or opening this page does not start work. Approved wording and accepted artifacts remain available.</p></details>
    {pending.isPending ? <p>Checking saved match state…</p> : null}
    {pending.error ? <p role="alert">Match state could not be refreshed: {pending.error.message}{pending.data ? " The last loaded state remains below." : ""} <Button type="button" variant="outline" onClick={() => void pending.refetch()}>Check match state</Button></p> : null}
    {pendingReady ? <p role="status">{pendingReady.pending
      ? `${pendingReady.pending_reasons.some((reason) => ["saved_job_inputs_changed", "catalog_qualification_pending", "saved_catalog_or_wording_changed"].includes(reason)) ? "Saved changes may affect matches." : "Some match work remains unfinished."} ${pendingReady.stale_job_ids.length} scored ${pendingReady.stale_job_ids.length === 1 ? "job is" : "jobs are"} marked out of date.`
      : "No pending changes are recorded."} {!jobIds && !selectionRequired
        ? selectedIds.length ? `Includes ${selectedIds.length} available scored ${selectedIds.length === 1 ? "job" : "jobs"}.` : "This update checks the catalog without updating job scores."
        : `${availableIds.length} scored jobs are available.`}</p> : null}
    {pendingReady?.stale_job_ids.some((id) => !availableIds.includes(id)) ? <p>Some out-of-date jobs are unavailable for this update. Check their saved posting and requirements.</p> : null}
    {selectionRequired ? <p>More than 100 scored jobs are available. <Link to="/jobs">Select up to 100 jobs in Jobs</Link> to update their matches.</p> : null}
    {jobIds && pendingReady ? <p>{selectedIds.length} selected {selectedIds.length === 1 ? "job has" : "jobs have"} a recorded score and will be included.{jobIds.length > selectedIds.length ? ` ${jobIds.length - selectedIds.length} selected ${jobIds.length - selectedIds.length === 1 ? "job is" : "jobs are"} unavailable for this update.` : ""}{selectedIds.length > 100 ? " Select at most 100 scored jobs." : ""}</p> : null}
    {!identity.ready ? <p role="alert">{identity.error ? "Update recovery storage is unavailable or invalid. Restore it before starting work." : "Checking update recovery storage…"}</p> : null}
    {archive.error ? <p role="alert">{archive.error.message}</p> : null}
    {busyIdentity.error ? <p role="alert">{busyIdentity.error.message}</p> : null}
    {identity.record && !terminalAction(status) && (!activeAction(status) || status === "start_failed" || requestStatus.error) ? <div role="status"><p>{status ? `Previous update request: ${status.replaceAll("_", " ")}.` : notRecorded
      ? "No admission is recorded at this instant. Only the exact earlier request may be retried."
      : "Checking the previous update request before starting different work."}</p>
      <Button type="button" variant="outline" disabled={requestStatus.isFetching} onClick={() => void requestStatus.refetch()}>Check previous update</Button>
      {notRecorded && !exactInputs && fingerprintQuery.data ? <><p>The earlier request may still arrive. The saved inputs now differ, so it cannot be retried with its original key. A new request uses a new key; the earlier identity is retained for status checks.</p>
        <Button type="button" variant="outline" disabled={!availability.available || !pendingReady || pending.isError || start.isPending || !archive.isSuccess || !busyIdentity.isSuccess || otherActive || scopeBlocked || selectionInvalid} onClick={() => void startCurrentAfterUnconfirmed("matches")}>Start a refresh for current saved changes</Button></> : null}
      {requestStatus.error && !notRecorded ? <p role="alert">The previous request could not be checked: {requestStatus.error.message}</p> : null}
    </div> : null}
    {archive.data?.length ? <div><p>Earlier unconfirmed updates are retained for status checks. An absent admission does not establish that a request cannot still arrive.</p>
      {earlierStatuses.data?.map(({ record, status: prior, error }) => <div key={record.requestId} role="status">
        <p>{prior ? `Earlier update: ${prior.status.replaceAll("_", " ")}${prior.cancellationRequested ? " · cancellation requested" : ""}.`
          : error instanceof JobCtrlApiError && error.status === 404 ? "An earlier request has not been found yet." : "An earlier request's status is unavailable."}</p>
        {prior ? <Link to="/runs/$runId" params={{ runId: prior.runId }}>View run details</Link> : null}
        {prior && activeAction(prior.status) && !prior.cancellationRequested ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate({ runId: prior.runId, origin: record })}>Request cancellation of earlier update</Button> : null}
        {prior && terminalAction(prior.status) ? <Button type="button" variant="outline" onClick={() => {
          const next = (archive.data ?? []).filter((item) => item.requestId !== record.requestId);
          sessionStorage.set(archiveStorageKey, JSON.stringify(next)); client.setQueryData(archiveQueryKey, next);
        }}>Dismiss earlier update</Button> : null}
      </div>)}
      <Button type="button" variant="outline" disabled={earlierStatuses.isFetching} onClick={() => void earlierStatuses.refetch()}>Check earlier updates</Button>
    </div> : null}
    {busy ? <div role="status"><p>{busyRun.data ? `Another update is ${busyRun.data.status.replaceAll("_", " ")}${busyRun.data.cancellationRequested ? " · cancellation requested" : ""}. This request was not admitted while that work held the scope.` : "Checking the other update that holds this scope…"}</p>
      {busyRun.data ? <Link to="/runs/$runId" params={{ runId: busyRun.data.runId }}>View other update</Link> : null}
      {busyRun.error ? <p role="alert">The other update could not be checked: {busyRun.error.message}</p> : null}
      <Button type="button" variant="outline" disabled={busyRun.isFetching} onClick={() => void busyRun.refetch()}>Check other update</Button>
      {busyRun.data && activeAction(busyRun.data.status) && !busyRun.data.cancellationRequested ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate({ runId: busyRun.data.runId, origin: busy })}>Request cancellation of other update</Button> : null}
      {busyRun.data && terminalAction(busyRun.data.status) ? <Button type="button" variant="outline" onClick={() => {
        try {
          const raw = sessionStorage.get(busyStorageKey);
          const current = raw === null ? null : busyIdentitySchema.parse(JSON.parse(raw));
          if (current && current.runId !== busy.runId) throw new Error("A newer update needs review.");
          sessionStorage.remove(busyStorageKey); client.setQueryData(busyQueryKey, null); setFallbackBusy(null); void pending.refetch();
        } catch (error) { setMessage(error instanceof Error ? error.message : "The other update could not be dismissed."); }
      }}>Dismiss other update</Button> : null}
    </div> : null}
    {otherActive && identity.record && !busy && visibleRun.data && pending.data?.workspace ? <div role="status"><p>Another update is {visibleRun.data.status.replaceAll("_", " ")}{visibleRun.data.cancellationRequested ? " · cancellation requested" : ""}.</p>
      <Link to="/runs/$runId" params={{ runId: visibleRun.data.runId }}>View other update</Link>
      {activeAction(visibleRun.data.status) && !visibleRun.data.cancellationRequested ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate({ runId: visibleRun.data.runId, origin: pending.data!.workspace })}>Request cancellation of other update</Button> : null}
    </div> : null}
    {operation ? <div role="status">{identity.record && notRecorded ? <p>Most recent recorded update:</p> : null}<p>{operationMessage(operation)}</p>
      {operation.partial ? <p>Partial result: the qualification stage finished{publishedScores ? ` and ${publishedScores} ${publishedScores === 1 ? "job score was" : "job scores were"} saved` : ""}, but the remaining work stopped. Review the pending changes before updating again.</p> : null}
      {operation.status === "running" ? <p>{phaseLabel[operation.phase]}.</p> : null}
      <p>{operation.counters.requirements_assessed} {operation.counters.requirements_assessed === 1 ? "requirement" : "requirements"} assessed · {operation.counters.qualifications_reused} {operation.counters.qualifications_reused === 1 ? "assessment" : "assessments"} reused · {operation.counters.wording_proposals} wording {operation.counters.wording_proposals === 1 ? "proposal" : "proposals"}.</p>
      <details><summary>Run details</summary><p>{phaseLabel[operation.phase]}{operation.selected_requirement_ids === null ? "" : ` · ${operation.selected_requirement_ids.length} affected ${operation.selected_requirement_ids.length === 1 ? "requirement" : "requirements"} selected`} · {operation.job_ids.length} {operation.job_ids.length === 1 ? "job" : "jobs"} · {operation.counters.model_calls} model call {operation.counters.model_calls === 1 ? "attempt" : "attempts"}.</p>
        <Link to="/runs/$runId" params={{ runId: operation.operation_id }}>View full run</Link></details>
      {operation.failure_code ? <details><summary>Failure details</summary><p>Recorded reason: {operation.failure_code}</p></details> : null}
      {operation.wording_failures.length ? <details><summary>Recorded wording outcomes</summary><ul>{operation.wording_failures.map((item) => <li key={item.proposal_id}>Proposal {item.proposal_id}: {item.status.replaceAll("_", " ")}{item.failure_code ? ` (${item.failure_code})` : ""}</li>)}</ul></details> : null}
    </div> : operationId && !operationQuery.error && activeAction(status) ? <p role="status">The update is queued or starting; detailed progress has not been recorded yet.</p>
      : operationId && !operationQuery.error && status === "failed" ? <div role="alert"><p>{requestStatus.data?.errorCode === "fit_refresh_stale" ? "Saved inputs changed before the update started." : requestStatus.data?.errorCode === "fit_refresh_retry_stale" ? "The wording's sources changed. Update affected matches before requesting another wording retry." : "The update failed before detailed progress was recorded."} Check the saved match state before starting again. Accepted work remains available.</p>
        {requestStatus.data?.errorCode ? <details><summary>Failure details</summary><p>Recorded reason: {requestStatus.data.errorCode}</p></details> : null}</div>
      : operationId && !operationQuery.error && status === "cancelled" ? <p role="status">The update was cancelled before detailed progress was recorded. Accepted work remains available.</p> : null}
    {wordingFailures.length ? <div><p>{retryRows.length} wording {retryRows.length === 1 ? "proposal can" : "proposals can"} be retried.{wordingFailures.length > retryRows.length ? " Other proposals remain unresolved and cannot be retried yet." : ""}</p>
      <details><summary>Wording needing attention</summary><ul>{wordingFailures.map((item) => <li key={item.proposal_id}>Proposal {item.proposal_id}: {item.status.replaceAll("_", " ")}{item.failure_code ? ` (${item.failure_code})` : ""}</li>)}</ul></details>
      {needsWordingChoice ? <fieldset><legend>Choose one proposal per achievement</legend>{retryRows.map((item) => {
        const checked = retryIds.includes(item.proposal_id);
        const owner = item.achievement_id ?? "unknown";
        const ownerSelected = retryRows.some((other) => retryIds.includes(other.proposal_id) && (other.achievement_id ?? "unknown") === owner);
        return <label key={item.proposal_id} className="block"><input type="checkbox" checked={checked} disabled={!checked && ownerSelected} onChange={(event) => {
          const selected = event.currentTarget.checked;
          setWordingSelection((previous) => {
            const ids = new Set(previous?.inventory === wordingInventory ? previous.ids : []);
            if (selected) ids.add(item.proposal_id); else ids.delete(item.proposal_id);
            return { inventory: wordingInventory, ids };
          });
        }} /> {item.status.replaceAll("_", " ")} · achievement {owner} · proposal {item.proposal_id}</label>;
      })}</fieldset> : null}
      {identity.record && terminalAction(status) && retryRows.length ? <p>Dismiss the completed update before retrying.</p> : null}
      {retryRows.length ? <Button type="button" variant="outline" disabled={!canRetryWording} onClick={() => void startUpdate("wording", retryIds)}>Retry failed wording</Button> : null}
      {identity.record && notRecorded && !exactInputs && fingerprintQuery.data && retryIds.length ? <Button type="button" variant="outline" disabled={!availability.available || !pendingReady || pending.isError || start.isPending || !archive.isSuccess || !busyIdentity.isSuccess || otherActive || scopeBlocked || retryIds.length > 100} onClick={() => void startCurrentAfterUnconfirmed("wording", retryIds)}>Retry failed wording for current saved changes</Button> : null}
    </div> : null}
    {operationQuery.error ? <p role="alert">Update progress could not be refreshed: {operationQuery.error.message}{operation ? " The last recorded state remains above." : ""} <Button type="button" variant="outline" onClick={() => void operationQuery.refetch()}>Check update progress</Button></p> : null}
    {requestStatus.data?.cancellationRequested || visibleRun.data?.cancellationRequested ? <p role="status">Cancellation requested; waiting for the recorded outcome.</p> : null}
    {visibleRun.error ? <p role="alert">Update status could not be refreshed: {visibleRun.error.message}</p> : null}
    <div className="flex flex-wrap gap-2">
      {identity.record && terminalAction(status) ? <Button type="button" variant="outline" disabled={!operationQuery.isSuccess || operationQuery.isFetching} onClick={() => {
        const current = identity.current();
        if (current && terminalAction(status)) { identity.clear(current.requestId); setMessage("Previous update reviewed. The recorded result remains available below."); void pending.refetch(); }
      }}>Dismiss completed update</Button> : <Button type="button" disabled={!canStart} onClick={() => void startUpdate(exactKind ?? "matches", exactKind === "wording" ? recoveryRetryIds : [])}>{start.isPending ? "Starting update…" : identity.record && mayRetry ? "Retry previous update" : "Update affected matches"}</Button>}
      {cancellableRun ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(cancellableRun)}>Request cancellation</Button> : null}
    </div>
    {!availability.available ? <p>{availability.reason}</p> : null}
    {otherActive ? <p role="status">Another update is already in progress. Wait for its recorded outcome.</p> : null}
    {start.error ? <p role="alert">{start.error.message} Check the previous request before trying different inputs.</p> : null}
    {cancel.error ? <p role="alert">{cancel.error.message} Check the update status before retrying cancellation.</p> : null}
    {message ? <p role="status">{message}</p> : null}
  </section>;
}
