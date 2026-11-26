import { JobCtrlApiError } from "@jobctrl/api-client";
import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { z } from "zod";

import { canRequestStop, cancellationDeliverySchema } from "../../shared/lib/actionStop.js";
import { getApiCapabilityAvailability } from "../../shared/lib/apiCapabilityAvailability.js";
import { createUnconfirmedWriteError } from "../../shared/lib/unconfirmed-write.js";
import { lookupSessionAction, requestWorkspace, requireRequestWorkspace, useSessionRequestIdentity } from "../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { Button } from "../../shared/ui/button.js";
import { requirementLibraryKeys, type RequirementNormalization } from "./library.js";

const ACTION = "requirements.consolidate";
const active = (status: string | undefined) => status === "pending" || status === "queued" || status === "running" || status === "start_failed";
const terminal = (status: string | undefined) => status === "succeeded" || status === "failed" || status === "cancelled";
const receiptSchema = z.object({ runId: z.string().min(1), workflowId: z.string().min(1), status: z.string().min(1) });
const runSchema = z.object({ runId: z.string().min(1), action: z.literal(ACTION), status: z.string().min(1),
  cancellationRequested: z.boolean(), cancellationDelivery: cancellationDeliverySchema, errorCode: z.string().nullable() }).passthrough();
const busySchema = z.object({ runId: z.string().min(1), workspaceId: z.string().min(1), databaseInstanceId: z.string().min(1) }).strict();
const scopeBusySchema = z.object({ error: z.object({ code: z.literal("action_scope_busy"),
  details: z.object({ runId: z.string().min(1), action: z.literal(ACTION) }).passthrough() }).passthrough() }).passthrough();
const changedCatalogSchema = z.object({ error: z.object({
  code: z.literal("requirements_consolidation_catalog_changed"),
  details: z.object({ currentCatalogRevision: z.number().int().nonnegative() }),
}) });
const requestInput = (revision: number) => ({ expected_catalog_revision: revision });
const requestFingerprint = (revision: number) => JSON.stringify({ action: ACTION, body: requestInput(revision) });
type RunWorkspace = z.infer<typeof busySchema>;

/** Explicit durable action; reading this panel never starts consolidation. */
export function RequirementConsolidationPanel({ normalization, catalogUnavailable, onSettled }: {
  normalization?: RequirementNormalization | undefined;
  catalogUnavailable: boolean;
  onSettled: () => void;
}) {
  const tenantId = useTenantId();
  const { http, requestIdentity, sessionStorage, featureFlags } = usePorts();
  const client = useQueryClient();
  const availability = getApiCapabilityAvailability(featureFlags, "requirementsConsolidate");
  const identity = useSessionRequestIdentity("catalog", ACTION);
  const earlier = useSessionRequestIdentity("earlier-catalog", ACTION);
  const [message, setMessage] = useState<string | null>(null);
  const [fallbackBusy, setFallbackBusy] = useState<RunWorkspace | null>(null);
  const startGuard = useRef(false);
  const handledTerminal = useRef<string | null>(null);
  const busyStorageKey = JSON.stringify([tenantId, ACTION, "scope-conflict"]);
  const busyKey = ["tenant", tenantId, "requirements", "consolidation", "scope-conflict"] as const;
  const busyIdentity = useQuery({ queryKey: busyKey, staleTime: Infinity, retry: false, queryFn: () => {
    const raw = sessionStorage.get(busyStorageKey);
    if (raw === null) return null;
    try { return busySchema.parse(JSON.parse(raw)); }
    catch { throw new Error("Another consolidation's saved identity could not be read."); }
  }, meta: { suppressGlobalErrorToast: true } });
  const busy = fallbackBusy ?? busyIdentity.data ?? null;
  const statusKey = ["tenant", tenantId, "requirements", "consolidation", "request", identity.record?.requestId ?? ""] as const;
  const status = useQuery({ queryKey: statusKey, enabled: Boolean(identity.record), retry: false,
    queryFn: () => {
      if (!identity.record) throw new Error("No earlier consolidation request is recorded.");
      return lookupSessionAction(http, identity.record);
    },
    refetchInterval: (query) => active(query.state.data?.status)
      || query.state.error instanceof JobCtrlApiError && query.state.error.status === 404 ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const earlierStatus = useQuery({
    queryKey: ["tenant", tenantId, "requirements", "consolidation", "earlier-request", earlier.record?.requestId ?? ""],
    enabled: Boolean(earlier.record), retry: false,
    queryFn: () => {
      if (!earlier.record) throw new Error("No earlier consolidation request is retained.");
      return lookupSessionAction(http, earlier.record);
    },
    refetchInterval: (query) => active(query.state.data?.status) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const otherRun = useQuery({ queryKey: [...busyKey, busy?.runId ?? "", busy?.databaseInstanceId ?? ""],
    enabled: Boolean(busy), retry: false, queryFn: async () => {
      if (!busy) throw new Error("No other consolidation is recorded.");
      const workspace = await requestWorkspace(http);
      if (workspace.workspaceId !== busy.workspaceId || workspace.databaseInstanceId !== busy.databaseInstanceId) {
        throw new Error("The other consolidation belongs to a different workspace or database.");
      }
      const parsed = runSchema.safeParse(await http.json<unknown>("GET", `/v1/action-runs/${encodeURIComponent(busy.runId)}`, {
        expectedDatabaseInstanceId: busy.databaseInstanceId,
      }));
      if (!parsed.success) throw new Error("The other consolidation status could not be verified.");
      return parsed.data;
    }, refetchInterval: (query) => active(query.state.data?.status) ? 3000 : false,
    meta: { suppressGlobalErrorToast: true },
  });
  const retryRevision = identity.record?.sourceRevision ?? normalization?.catalog_revision;
  const fingerprint = useQuery({
    queryKey: ["tenant", tenantId, "requirements", "consolidation", "fingerprint", retryRevision],
    enabled: Boolean(identity.record && retryRevision !== undefined), retry: false,
    queryFn: () => requestIdentity.fingerprint(requestFingerprint(retryRevision!)),
    meta: { suppressGlobalErrorToast: true },
  });
  const notRecorded = status.error instanceof JobCtrlApiError && status.error.status === 404;
  const exactInputs = Boolean(identity.record && fingerprint.data === identity.record.fingerprint);
  const canRetry = Boolean(identity.record && exactInputs && !status.isFetching && !status.data?.cancellationRequested
    && (notRecorded || ["pending", "start_failed"].includes(status.data?.status ?? "")));

  const refresh = () => {
    void client.invalidateQueries({ queryKey: requirementLibraryKeys.all(tenantId) });
    onSettled();
  };
  useEffect(() => {
    if (!identity.record || !terminal(status.data?.status)) return;
    const key = `${identity.record.requestId}:${status.data?.status}`;
    if (handledTerminal.current === key) return;
    handledTerminal.current = key;
    refresh();
  }, [identity.record?.requestId, status.data?.status]);

  const start = useMutation({ mutationFn: async () => {
    if (!normalization || catalogUnavailable || !identity.ready || !busyIdentity.isSuccess || busy) {
      throw new Error("Refresh the catalog and recovery status before starting consolidation.");
    }
    const previous = identity.current();
    const revision = previous?.sourceRevision ?? normalization.catalog_revision;
    const body = requestInput(revision);
    const fingerprint = await requestIdentity.fingerprint(requestFingerprint(revision));
    const workspace = await requestWorkspace(http);
    if (previous && (previous.fingerprint !== fingerprint || previous.workspaceId !== workspace.workspaceId
        || previous.databaseInstanceId !== workspace.databaseInstanceId)) {
      throw new Error("The catalog or workspace differs from the earlier unconfirmed request. Check it before starting different work.");
    }
    if (previous) {
      try {
        const observed = await lookupSessionAction(http, previous);
        if (!["pending", "start_failed"].includes(observed.status)) throw new Error(`The earlier consolidation is ${observed.status}. Review it before starting another.`);
      } catch (error) {
        if (!(error instanceof JobCtrlApiError && error.status === 404)) throw error;
      }
    }
    if (identity.current()?.requestId !== previous?.requestId) throw new Error("Another consolidation request needs review.");
    const saved = {
      ...(previous ?? { version: 1 as const, requestId: requestIdentity.create(), operation: ACTION, fingerprint, ...workspace }),
      sourceRevision: revision,
    };
    identity.save(saved);
    const path = `/v1/actions/${ACTION}`;
    try {
      const parsed = receiptSchema.safeParse(await http.json<unknown>("POST", path, {
        body, idempotencyKey: saved.requestId, expectedDatabaseInstanceId: saved.databaseInstanceId,
      }));
      if (!parsed.success) throw createUnconfirmedWriteError("POST", path, parsed.error);
      return parsed.data;
    } catch (error) {
      const response = error instanceof JobCtrlApiError ? error.responseBody : null;
      const conflict = scopeBusySchema.safeParse(response);
      if (conflict.success) {
        const other = { runId: conflict.data.error.details.runId, workspaceId: saved.workspaceId, databaseInstanceId: saved.databaseInstanceId };
        setFallbackBusy(other);
        try { sessionStorage.set(busyStorageKey, JSON.stringify(other)); client.setQueryData(busyKey, other); setFallbackBusy(null); }
        catch { setMessage("The other consolidation's identity could not be retained. Check it before leaving this page."); }
      }
      const changed = changedCatalogSchema.safeParse(error instanceof JobCtrlApiError && error.status === 409 ? response : null);
      if (changed.success && changed.data.error.details.currentCatalogRevision > revision) {
        // The stale revision was refused in the admission transaction. This
        // exact key cannot be admitted later against a newer revision.
        identity.clear(saved.requestId);
        setMessage("The skills catalog changed before the request started. The saved catalog is still available.");
        refresh();
        return null;
      }
      const code = response && typeof response === "object" && "error" in response
        && response.error && typeof response.error === "object" && "code" in response.error ? response.error.code : null;
      const refused = error instanceof JobCtrlApiError && ((error.status >= 400 && error.status < 500
        && ![408, 409, 429].includes(error.status)) || code === "worker_unavailable" || code === "workspace_changed" || conflict.success || changed.success);
      if (!previous && refused) {
        try { identity.clear(saved.requestId); } catch { /* Retain the identity if it cannot be reconciled safely. */ }
      }
      throw error;
    }
  }, onSettled: () => { void client.invalidateQueries({ queryKey: ["tenant", tenantId, "requirements", "consolidation"] }); } });

  const cancel = useMutation({ mutationFn: async ({ runId, workspaceId, databaseInstanceId }: RunWorkspace) => {
    const workspace = await requestWorkspace(http);
    if (workspace.workspaceId !== workspaceId || workspace.databaseInstanceId !== databaseInstanceId) throw new Error("This consolidation belongs to a different workspace or database.");
    const path = `/v1/action-runs/${encodeURIComponent(runId)}/cancel`;
    const parsed = runSchema.safeParse(await http.json<unknown>("POST", path, { body: {}, expectedDatabaseInstanceId: databaseInstanceId }));
    if (!parsed.success) throw createUnconfirmedWriteError("POST", path, parsed.error);
    return parsed.data;
  }, onSettled: () => { void client.invalidateQueries({ queryKey: ["tenant", tenantId, "requirements", "consolidation"] }); } });

  const reconcile = async (archived = false) => {
    const selected = archived ? earlier : identity;
    try {
      const original = selected.current();
      if (!original || original.requestId !== selected.record?.requestId) throw new Error("The earlier request changed. Check its status again.");
      const checked = await (archived ? earlierStatus : status).refetch();
      if (checked.error) throw checked.error;
      if (!terminal(checked.data?.status)) throw new Error("The earlier consolidation has not finished.");
      await requireRequestWorkspace(http, original);
      if (selected.current()?.requestId !== original.requestId) throw new Error("A newer request needs review.");
      selected.clear(original.requestId);
      setMessage(`Previous consolidation ${checked.data!.status}. Its recorded result has been checked.`);
      refresh();
    } catch (error) {
      setMessage(error instanceof JobCtrlApiError && error.status === 404
        ? "No admission is recorded at this instant. Only the exact earlier request may be retried."
        : error instanceof Error ? error.message : "The previous consolidation could not be checked.");
    }
  };
  const dismissOther = async () => {
    try {
      if (!busy || !terminal(otherRun.data?.status)) throw new Error("The other consolidation has not finished.");
      const workspace = await requestWorkspace(http);
      if (workspace.workspaceId !== busy.workspaceId || workspace.databaseInstanceId !== busy.databaseInstanceId) throw new Error("Return to the other consolidation's workspace first.");
      sessionStorage.remove(busyStorageKey); client.setQueryData(busyKey, null); setFallbackBusy(null); refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The other consolidation could not be reconciled."); }
  };

  const incompatibleEarlierRequest = Boolean(identity.record && identity.record.sourceRevision === undefined &&
    notRecorded && !exactInputs && fingerprint.isSuccess);
  const useCurrentCatalog = async () => {
    if (startGuard.current || !normalization || !incompatibleEarlierRequest) return;
    startGuard.current = true;
    setMessage(null);
    try {
      const previous = identity.current();
      if (!previous || previous.sourceRevision !== undefined || previous.requestId !== identity.record?.requestId) {
        throw new Error("The earlier request changed. Check its status again.");
      }
      try {
        await lookupSessionAction(http, previous);
        throw new Error("The earlier request now has a recorded run. Check it before starting different work.");
      } catch (error) {
        if (!(error instanceof JobCtrlApiError && error.status === 404)) throw error;
      }
      earlier.save(previous);
      identity.clear(previous.requestId);
      if (!normalization.ready) await start.mutateAsync();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The current catalog could not be used.");
    } finally {
      startGuard.current = false;
    }
  };

  if (!normalization && !identity.record && !earlier.record && !busy) return null;
  if (normalization?.ready && !identity.record && !earlier.record && !busy && !message) return null;
  const run = status.data;
  const refused = start.error instanceof JobCtrlApiError && start.error.status >= 400 && start.error.status < 500
    && ![408, 429].includes(start.error.status);
  const canSubmit = availability.available && identity.ready && busyIdentity.isSuccess && !busy && !catalogUnavailable
    && Boolean(normalization) && !start.isPending;
  const canStart = canSubmit && (identity.record ? canRetry : normalization?.ready === false);
  const canUseCurrent = (normalization?.ready && !catalogUnavailable || canSubmit) && !status.isFetching && earlier.ready &&
    (!earlier.record || earlier.record.requestId === identity.record?.requestId);
  const currentRun = run && identity.record ? { runId: run.runId, workspaceId: identity.record.workspaceId, databaseInstanceId: identity.record.databaseInstanceId } : null;
  const earlierRun = earlierStatus.data && earlier.record ? { runId: earlierStatus.data.runId, workspaceId: earlier.record.workspaceId, databaseInstanceId: earlier.record.databaseInstanceId } : null;
  const earlierNotRecorded = earlierStatus.error instanceof JobCtrlApiError && earlierStatus.error.status === 404;
  return <section className="requirement-consolidation" aria-label="Skill consolidation">
    <div><h2>Consolidate skills</h2>
      <p>Review the complete saved skills catalog, including retained sources, before using its normalized meanings. This may use your configured model. Opening the library does not start work.</p>
      <p>Existing accepted records remain available if consolidation cannot finish.</p></div>
    {!identity.ready ? <p role="alert">{identity.error ? "Consolidation recovery storage is unavailable or invalid." : "Checking consolidation recovery storage…"}</p> : null}
    {busyIdentity.error ? <p role="alert">{busyIdentity.error.message}</p> : null}
    {start.error ? <p role="alert">{refused ? "Consolidation was refused" : "Consolidation could not be confirmed"}: {start.error.message} The previously accepted catalog remains available.</p> : null}
    {identity.record ? <div role="status"><p>{run ? `Consolidation: ${run.status.replaceAll("_", " ")}${run.cancellationRequested ? " · cancellation requested" : ""}${run.errorCode ? ` · ${run.errorCode.replaceAll("_", " ")}` : ""}.`
      : notRecorded ? "No run has been recorded for this request yet."
      : "Checking the earlier consolidation request…"}</p>
      {run ? <Link to="/runs/$runId" params={{ runId: run.runId }}>View run details</Link> : null}
      {status.error && !notRecorded ? <p role="alert">The earlier request status is unavailable: {status.error.message}</p> : null}
      {currentRun && active(run?.status) && canRequestStop(run) ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(currentRun)}>{run?.cancellationDelivery === "pending" ? "Retry stop" : "Request cancellation"}</Button> : null}
      {terminal(run?.status) ? <Button type="button" variant="outline" disabled={status.isFetching} onClick={() => void reconcile()}>Acknowledge result</Button>
        : <Button type="button" variant="outline" disabled={status.isFetching} onClick={() => void status.refetch()}>Check previous request</Button>}
      {incompatibleEarlierRequest ? <>
        <p>The saved catalog changed. The earlier request can still be checked by its saved key.</p>
        <Button type="button" variant="outline" disabled={!canUseCurrent} onClick={() => void useCurrentCatalog()}>{normalization?.ready ? "Use current catalog" : "Consolidate current catalog"}</Button>
      </> : null}
    </div> : null}
    {earlier.record ? <div role="status">
      <p>{earlierStatus.data ? `Earlier consolidation: ${earlierStatus.data.status.replaceAll("_", " ")}.`
        : earlierNotRecorded ? "No run has been recorded for the earlier request yet." : "Checking the earlier consolidation."}</p>
      {earlierRun ? <Link to="/runs/$runId" params={{ runId: earlierRun.runId }}>View earlier run</Link> : null}
      {earlierStatus.error && !earlierNotRecorded ? <p role="alert">{earlierStatus.error.message}</p> : null}
      {earlierRun && active(earlierStatus.data?.status) && canRequestStop(earlierStatus.data) ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(earlierRun)}>{earlierStatus.data?.cancellationDelivery === "pending" ? "Retry stop" : "Request cancellation of earlier run"}</Button> : null}
      {terminal(earlierStatus.data?.status) ? <Button type="button" variant="outline" disabled={earlierStatus.isFetching} onClick={() => void reconcile(true)}>Acknowledge earlier result</Button>
        : <Button type="button" variant="outline" disabled={earlierStatus.isFetching} onClick={() => void earlierStatus.refetch()}>Check earlier request</Button>}
    </div> : null}
    {busy ? <div role="status"><p>{otherRun.data ? `Another consolidation: ${otherRun.data.status.replaceAll("_", " ")}${otherRun.data.cancellationRequested ? " · cancellation requested" : ""}.` : "Checking another consolidation…"}</p>
      {otherRun.error ? <p role="alert">{otherRun.error.message}</p> : null}
      {otherRun.data ? <Link to="/runs/$runId" params={{ runId: otherRun.data.runId }}>View other run</Link> : null}
      {otherRun.data && active(otherRun.data.status) && canRequestStop(otherRun.data) ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(busy)}>{otherRun.data.cancellationDelivery === "pending" ? "Retry stop for other consolidation" : "Request cancellation of other consolidation"}</Button> : null}
      {terminal(otherRun.data?.status) ? <Button type="button" variant="outline" onClick={() => void dismissOther()}>Acknowledge other result</Button> : <Button type="button" variant="outline" disabled={otherRun.isFetching} onClick={() => void otherRun.refetch()}>Check other consolidation</Button>}
    </div> : null}
    {cancel.error ? <p role="alert">Cancellation could not be confirmed: {cancel.error.message} Check the run before retrying.</p> : null}
    {message ? <p role="status">{message}</p> : null}
    {normalization && !normalization.ready || identity.record && canRetry ? <div><Button type="button" disabled={!canStart} onClick={() => {
      if (startGuard.current) return;
      startGuard.current = true; setMessage(null);
      void start.mutateAsync().catch(() => undefined).finally(() => { startGuard.current = false; });
    }}>{start.isPending ? "Requesting consolidation…" : identity.record ? "Retry the same consolidation" : "Consolidate skills"}</Button></div> : null}
    {!availability.available ? <p>{availability.reason}</p> : null}
  </section>;
}
