import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";
import { z } from "zod";

import { canRequestStop, cancellationDeliverySchema } from "../../shared/lib/actionStop.js";
import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { HttpLoaderReadContext, HttpReadContext } from "../../shared/lib/loaderReadContext.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { Button } from "../../shared/ui/button.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.js";
import { useRuntimeHealth } from "../runtime/index.js";

const actionRunSchema = z.object({
  runId: z.string(), action: z.string(), status: z.string(), workflowId: z.string(),
  result: z.unknown(), errorCode: z.string().nullable(),
  createdAt: z.string(), updatedAt: z.string(), cancellationRequested: z.boolean(),
  cancellationDelivery: cancellationDeliverySchema,
});
const runsPageSchema = z.object({ runs: z.array(actionRunSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() });
const summarySchema = z.object({ counts: z.record(z.string(), z.number()), total: z.number(), active: z.number(), pendingCancellation: z.number() });
export type ActionRun = z.infer<typeof actionRunSchema>;
export const actionRunKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "action-runs"] as const,
  pages: (tenantId: string) => [...actionRunKeys.all(tenantId), "pages"] as const,
  summary: (tenantId: string) => [...actionRunKeys.all(tenantId), "summary"] as const,
  detail: (tenantId: string, id: string) => [...actionRunKeys.all(tenantId), "detail", id] as const,
};
function parseRun(value: unknown, runId: string): ActionRun {
  const result = actionRunSchema.safeParse(value);
  if (!result.success || result.data.runId !== runId) throw new Error("The response does not identify the selected run.");
  return result.data;
}
export function actionRunQuery(context: HttpReadContext, runId: string) {
  return { queryKey: actionRunKeys.detail(context.tenantId, runId),
    queryFn: async () => parseRun(await context.ports.http.json<unknown>("GET", `/v1/action-runs/${encodeURIComponent(runId)}`), runId) };
}
export function ensureActionRun(context: HttpLoaderReadContext, runId: string) {
  return context.queryClient.ensureQueryData(actionRunQuery(context, runId));
}
export const actionRunEvents: FeatureEventHandler = {
  eventTypes: ["ActionQueued", "ActionStarted", "ActionFailed", "ActionCompleted", "ActionCancellationRequested", "ActionCancellationAcknowledged"],
  handle(event, invalidate) { invalidate(actionRunKeys.all(event.tenantId)); },
};

export function useActionRunSummary() {
  const tenantId = useTenantId(); const { http } = usePorts();
  return useQuery({ queryKey: actionRunKeys.summary(tenantId), queryFn: async () => {
    const parsed = summarySchema.safeParse(await http.json<unknown>("GET", "/v1/action-runs/summary"));
    if (!parsed.success) throw new Error("The run summary response is invalid."); return parsed.data;
  }, meta: { suppressGlobalErrorToast: true } });
}

export function ActionRunsDashboard() {
  const query = useActionRunSummary();
  return <section className="card operational-panel operational-summary-panel" aria-label="Active work"><h2>Active work</h2>
    {query.isPending ? <p>Loading work status…</p> : null}
    {query.error ? <p role="alert">Work status could not be refreshed: {query.error.message}{query.data ? " Showing the last loaded counts." : ""}</p> : null}
    {query.data ? <p>{query.data.counts.running ?? 0} running · {query.data.counts.queued ?? 0} queued · {query.data.total} recorded · {query.data.pendingCancellation} cancellation requests pending</p> : null}
    <Link to="/runs">View runs</Link>
  </section>;
}

export type ActionRunStatusFilter = "all" | "pending" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "start_failed";
export interface ActionRunFilters {
  readonly status: ActionRunStatusFilter; readonly action: string; readonly since: string; readonly until: string;
}
export function ActionRunsPage({ filters, onFilterChange }: { readonly filters: ActionRunFilters; readonly onFilterChange: (filters: ActionRunFilters) => void }) {
  const tenantId = useTenantId(); const { http } = usePorts();
  const [draft, setDraft] = useState(filters);
  useEffect(() => { setDraft(filters); }, [filters.status, filters.action, filters.since, filters.until]);
  const query = useInfiniteQuery({ queryKey: [...actionRunKeys.pages(tenantId), filters], initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const parsed = runsPageSchema.safeParse(await http.json<unknown>("GET", "/v1/action-runs", { query: {
        before: pageParam, limit: 50, status: filters.status === "all" ? "" : filters.status,
        action: filters.action, since: filters.since, until: filters.until,
      } }));
      if (!parsed.success) throw new Error("The action run list response is invalid."); return parsed.data;
    }, getNextPageParam: (last) => last.nextCursor ?? undefined, meta: { suppressGlobalErrorToast: true },
  });
  const runs = query.data?.pages.flatMap((page) => page.runs) ?? [];
  return <div className="operational-workspace action-runs-workspace">
    <PageHead eyebrow="Activity" title="Runs" subtitle="Durable work and its recorded outcome." />
    <details className="card operational-filters"><summary>Filter runs{filters.status !== "all" || filters.action || filters.since || filters.until ? " (active)" : ""}</summary>
      <form className="operational-filter-form" onSubmit={(event) => { event.preventDefault(); onFilterChange(draft); }}>
        <div className="operational-field"><label htmlFor="run-status">Status</label><Select value={draft.status} onValueChange={(value) => { if (value) setDraft({ ...draft, status: value as ActionRunStatusFilter }); }}>
          <SelectTrigger id="run-status"><SelectValue>{({ all: "All statuses", pending: "Pending", queued: "Queued", running: "Running", succeeded: "Succeeded", failed: "Failed", cancelled: "Cancelled", start_failed: "Start failed" } as const)[draft.status]}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">All statuses</SelectItem><SelectItem value="pending">Pending</SelectItem><SelectItem value="queued">Queued</SelectItem><SelectItem value="running">Running</SelectItem><SelectItem value="succeeded">Succeeded</SelectItem><SelectItem value="failed">Failed</SelectItem><SelectItem value="cancelled">Cancelled</SelectItem><SelectItem value="start_failed">Start failed</SelectItem></SelectContent>
        </Select></div>
        <label>Action name<input value={draft.action} onChange={(event) => setDraft({ ...draft, action: event.target.value })} /></label>
        <label>Since (ISO timestamp with timezone)<input value={draft.since} onChange={(event) => setDraft({ ...draft, since: event.target.value })} /></label>
        <label>Until (ISO timestamp with timezone)<input value={draft.until} onChange={(event) => setDraft({ ...draft, until: event.target.value })} /></label>
        <div className="operational-filter-actions"><Button type="submit">Apply filters</Button>
        <Button type="button" variant="outline" onClick={() => { const empty: ActionRunFilters = { status: "all", action: "", since: "", until: "" }; setDraft(empty); onFilterChange(empty); }}>Clear filters</Button></div>
      </form>
    </details>
    {query.error ? <p role="alert">Runs could not be refreshed: {query.error.message}{query.data ? " Previously loaded runs remain visible." : ""}</p> : null}
    {query.isPending ? <p>Loading runs…</p> : null}
    {query.data && !runs.length ? <p>No runs recorded yet.</p> : null}
    {runs.length ? <ul className="card operational-record-list">{runs.map((run) => <li key={run.runId}><Link to="/runs/$runId" params={{ runId: run.runId }}>{run.action}</Link><span>{run.status} · {run.createdAt}</span></li>)}</ul> : null}
    {query.hasNextPage ? <Button type="button" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load older runs"}</Button> : null}
  </div>;
}

export function ActionRunDetail({ runId, renderFeatureDetail }: { readonly runId: string; readonly renderFeatureDetail?: (run: ActionRun) => ReactNode }) {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  const health = useRuntimeHealth();
  const query = useQuery({ ...actionRunQuery({ tenantId, ports: { http } }, runId), meta: { suppressGlobalErrorToast: true } });
  const cancel = useMutation({ mutationFn: async ({ selectedRunId, databaseInstanceId }: { selectedRunId: string; databaseInstanceId: string | undefined }) =>
    parseRun(await http.json<unknown>("POST", `/v1/action-runs/${encodeURIComponent(selectedRunId)}/cancel`,
      { body: {}, ...(databaseInstanceId ? { expectedDatabaseInstanceId: databaseInstanceId } : {}) }), selectedRunId),
    onSettled: () => invalidateQueriesWithOptimisticOwnership(client, actionRunKeys.all(tenantId)) });
  const run = query.data;
  const active = run && ["pending", "start_failed", "queued", "running"].includes(run.status);
  const canCancel = active && canRequestStop(run);
  const featureDetail = run ? renderFeatureDetail?.(run) : null;
  return <div className="operational-workspace action-run-detail-workspace">
    <PageHead eyebrow="Activity" title="Run detail" />
    <Link to="/runs">Back to runs</Link>
    {query.isPending ? <p>Loading run…</p> : null}
    {query.error ? <p role="alert">Run status could not be refreshed: {query.error.message}{run ? " The last loaded status remains below." : ""}</p> : null}
    {run ? <section className="card operational-panel"><h2>{run.action}</h2><p role="status">Status: {run.status === "cancelled" ? "Cancelled" : run.status.replaceAll("_", " ")}</p>
      {active && run.cancellationRequested ? <div role="status"><p>Stop requested</p>
        <p>{run.cancellationDelivery === "pending" ? "The workflow service has not confirmed receipt. Retry stop when it is available." : "Waiting for this run to settle."}</p>
      </div> : null}
      <dl className="operational-metadata"><div><dt>Run</dt><dd>{run.runId}</dd></div><div><dt>Workflow</dt><dd>{run.workflowId}</dd></div><div><dt>Created</dt><dd>{run.createdAt}</dd></div><div><dt>Updated</dt><dd>{run.updatedAt}</dd></div>{run.errorCode ? <div><dt>Error code</dt><dd>{run.errorCode}</dd></div> : null}</dl>
      {canCancel ? <div className="operational-actions">
      <Button type="button" variant="outline" disabled={cancel.isPending || query.isError}
        onClick={() => cancel.mutate({ selectedRunId: run.runId, databaseInstanceId: health.data?.databaseInstanceId })}>
        {run.cancellationDelivery === "pending" ? "Retry stop" : "Request stop"}
      </Button>
      </div> : null}
      {cancel.error ? <p role="alert">{cancel.error.message} Check the current run state before retrying.</p> : null}
      {run.result !== null && run.result !== undefined ? <details><summary>Recorded result</summary><pre>{JSON.stringify(run.result, null, 2)}</pre></details> : null}
      {featureDetail ? <div className="operational-feature-detail">{featureDetail}</div> : null}
    </section> : null}
  </div>;
}
