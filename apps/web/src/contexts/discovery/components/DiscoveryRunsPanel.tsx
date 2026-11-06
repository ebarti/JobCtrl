import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { useState } from "react";
import { z } from "zod";
import { create } from "zustand";

import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { requireRequestWorkspace } from "../../../shared/lib/useSessionRequestIdentity.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { Field, FieldLabel } from "../../../shared/ui/field.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { discoveryKeys } from "../queryKeys.js";
import { useDiscoveryActionRecovery } from "../hooks/useDiscoveryActionRecovery.js";

const StartReceipt = z.object({ runId: z.string().min(1), workflowId: z.string().min(1), status: z.string().min(1) });
const RunList = z.object({ ok: z.literal(true), runs: z.array(z.object({
  runId: z.string(), status: z.string(), newJobs: z.number(), observedJobs: z.number(),
  failureCode: z.string().nullable(), createdAt: z.string(), updatedAt: z.string(),
}).passthrough()) }).passthrough();
const ActionRun = z.object({ runId: z.string(), status: z.string(), errorCode: z.string().nullable().optional() }).passthrough();
type SearchPayload = { queries?: string[]; locations?: { location: string; remote: boolean }[] };
type PendingSearch = { payload: string; body: SearchPayload; requestId: string; uncertain: boolean };
// Search text remains in memory; session storage retains only its fingerprint.
const usePendingDiscovery = create<{
  requests: ReadonlyMap<string, PendingSearch>;
  set: (tenant: string, request: PendingSearch | null) => void;
}>((set) => ({ requests: new Map(), set: (tenant, request) => set((state) => {
  const requests = new Map(state.requests);
  if (request) requests.set(tenant, request); else requests.delete(tenant);
  return { requests };
}) }));

export function DiscoveryRunsPanel() {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const recovery = useDiscoveryActionRecovery("discovery.search");
  const pending = usePendingDiscovery((state) => state.requests.get(tenantId));
  const unconfirmed = pending?.uncertain ? pending.body : null;
  const runs = useQuery({ queryKey: discoveryKeys.runs(tenantId),
    queryFn: async () => RunList.parse(await http.json<unknown>("GET", "/v1/discovery/runs")) });
  const start = useMutation({
    mutationFn: async (body: SearchPayload) => {
      const payload = JSON.stringify(body);
      const current = usePendingDiscovery.getState().requests.get(tenantId);
      if (current && current.payload !== payload) throw new Error("An earlier search request is unconfirmed. Retry that request first.");
      const { requestId: key, databaseInstanceId } = await recovery.begin(body);
      const request = current ?? { payload, body: structuredClone(body), requestId: key, uncertain: false };
      usePendingDiscovery.getState().set(tenantId, request);
      try {
        const response = await http.json<unknown>("POST", "/v1/actions/discovery.search", { body, idempotencyKey: key, expectedDatabaseInstanceId: databaseInstanceId });
        const parsed = StartReceipt.safeParse(response);
        if (!parsed.success) throw createUnconfirmedWriteError("POST", "/v1/actions/discovery.search", parsed.error);
        return parsed.data;
      } catch (error) {
        if (usePendingDiscovery.getState().requests.get(tenantId)?.requestId === key) {
          usePendingDiscovery.getState().set(tenantId, { ...request, uncertain: true });
        }
        throw error;
      }
    },
    onSuccess: (result) => setRunId(result.runId),
    onSettled: () => { recovery.refresh(); void client.invalidateQueries({ queryKey: discoveryKeys.runs(tenantId) }); },
  });
  const cancel = useMutation({
    mutationFn: async (id: string) => {
      if (recovery.record && recovery.status?.runId === id) await requireRequestWorkspace(http, recovery.record);
      const result = ActionRun.extend({ cancellationRequested: z.boolean() }).parse(await http.json<unknown>("POST", `/v1/action-runs/${encodeURIComponent(id)}/cancel`, { body: {},
        ...(recovery.record && recovery.status?.runId === id ? { expectedDatabaseInstanceId: recovery.record.databaseInstanceId } : {}) }));
      if (result.runId !== id || !result.cancellationRequested) throw new Error("The stop request could not be confirmed.");
      return result;
    },
    onSettled: () => { recovery.refresh(); void client.invalidateQueries({ queryKey: discoveryKeys.runs(tenantId) }); },
  });
  const lines = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean);
  const runInputSchema = z.object({ queries: z.string().max(10000), locations: z.string().max(10000), remoteOnly: z.boolean() });
  const form = useForm({
    defaultValues: { queries: pending?.body.queries?.join("\n") ?? "", locations: pending?.body.locations?.map((item) => item.location).filter(Boolean).join("\n") ?? "", remoteOnly: pending?.body.locations?.some((item) => item.remote) ?? false },
    validators: { onSubmit: ({ value }) => runInputSchema.safeParse(value).success ? undefined : "Search inputs are too long." },
    onSubmit: ({ value }) => {
      const parsed = runInputSchema.safeParse(value);
      if (!parsed.success || !recovery.ready || (recovery.record && !recovery.canRetry)) return;
      const queryLines = lines(parsed.data.queries); const locationLines = lines(parsed.data.locations);
      start.mutate(unconfirmed ?? { ...(queryLines.length ? { queries: queryLines } : {}),
        ...(locationLines.length || parsed.data.remoteOnly ? { locations: (locationLines.length ? locationLines : [""]).map((location) => ({ location, remote: parsed.data.remoteOnly })) } : {}) });
    },
  });
  const activeStatus = recovery.status?.status;
  const activeRunId = recovery.status?.runId ?? runId;
  return <section className="card full p-4" aria-label="Discovery runs">
    <h2>Discovery runs</h2>
    <p>Run a search using your saved targets. Optional lines below apply only to this run; they do not replace saved targets.</p>
    <form onSubmit={(event) => { event.preventDefault(); void form.handleSubmit(); }}>
      <form.Field name="queries">{(field) => <Field><FieldLabel htmlFor="discovery-run-queries">Search queries, one per line (optional)</FieldLabel><Textarea id="discovery-run-queries" rows={3} value={field.state.value} disabled={Boolean(unconfirmed)} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></Field>}</form.Field>
      <form.Field name="locations">{(field) => <Field><FieldLabel htmlFor="discovery-run-locations">Locations, one per line (optional)</FieldLabel><Textarea id="discovery-run-locations" rows={2} value={field.state.value} disabled={Boolean(unconfirmed)} onBlur={field.handleBlur} onChange={(event) => field.handleChange(event.target.value)} /></Field>}</form.Field>
      <form.Field name="remoteOnly">{(field) => <label><input type="checkbox" checked={field.state.value} disabled={Boolean(unconfirmed)} onChange={(event) => field.handleChange(event.target.checked)} /> Remote only for this run</label>}</form.Field>
      <form.Subscribe selector={(state) => state.errors}>{(errors) => errors.length ? <p role="alert">{errors.join(" ")}</p> : null}</form.Subscribe>
      <Button type="submit" disabled={start.isPending || !recovery.ready || Boolean(recovery.record && !recovery.canRetry)}>{start.isPending ? "Queueing search…" : recovery.record ? "Retry the same request" : "Run discovery"}</Button>
    </form>
    {!recovery.ready ? <p role="alert">{recovery.error ? "Session recovery storage is unavailable or invalid. Restore it before starting a search." : "Checking session recovery storage…"}</p> : recovery.record ? <div role="alert"><p>A previous search remains under review. Check its status before starting another.{!pending?.body ? " Its inputs were not stored; re-enter the exact inputs if retry is available." : ""}</p><Button type="button" variant="outline" disabled={recovery.checking} onClick={() => { void recovery.check().then((finished) => { if (finished) { usePendingDiscovery.getState().set(tenantId, null); setRunId(null); } }); }}>Check previous search</Button></div> : null}
    {recovery.message ? <p role="status">{recovery.message}</p> : null}
    {start.error ? <p role="alert">Search could not be confirmed: {start.error.message}. Retry the same inputs to check the same request.</p> : null}
    {activeRunId ? <p role="status">Run {activeRunId}: {recovery.statusError ? "status unavailable" : activeStatus ?? "checking status"}{recovery.status?.errorCode ? ` (${recovery.status.errorCode})` : ""}</p> : null}
    {activeRunId && activeStatus && ["pending", "queued", "running"].includes(activeStatus) ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(activeRunId)}>Request stop</Button> : null}
    {recovery.status?.cancellationRequested === true ? <p role="status">Stop requested; the run remains active until it settles.</p> : null}
    {recovery.record && recovery.statusError ? <p role="alert">Run status is unavailable. Check the previous request before starting again.</p> : null}
    {runs.error ? <p role="alert">Discovery run history could not be refreshed.</p> : null}
    <ul>{runs.data?.runs.map((run) => <li key={run.runId}>
      {run.status} · {run.newJobs} new, {run.observedJobs} observed · {run.createdAt}
      {run.failureCode ? ` · ${run.failureCode}` : ""}
      {run.status === "running" ? <Button type="button" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate(run.runId)}>Stop discovery</Button> : null}
    </li>)}</ul>
    {cancel.error ? <p role="alert">Could not confirm stop: {cancel.error.message}. Check run status before retrying.</p> : null}
  </section>;
}
