import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { z } from "zod";

import { invalidateQueriesWithOptimisticOwnership } from "../../shared/lib/createOptimisticMutation.js";
import type { HttpLoaderReadContext, HttpReadContext } from "../../shared/lib/loaderReadContext.js";
import type { FeatureEventHandler } from "../../shared/ports/FeatureEvents.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { Button } from "../../shared/ui/button.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../shared/ui/select.js";

const eventSchema = z.object({
  eventId: z.string(), type: z.string(), feature: z.string(),
  aggregateId: z.string().nullable(), tenantId: z.string(), occurredAt: z.string(),
  payload: z.record(z.string(), z.unknown()),
  level: z.enum(["debug", "info", "warn", "error"]), stage: z.string().nullable(),
});
const pageSchema = z.object({ events: z.array(eventSchema), nextCursor: z.string().nullable(), hasMore: z.boolean() });
export const activityKeys = {
  all: (tenantId: string) => ["tenant", tenantId, "activity"] as const,
  pages: (tenantId: string) => [...activityKeys.all(tenantId), "pages"] as const,
  recent: (tenantId: string) => [...activityKeys.all(tenantId), "recent"] as const,
  detail: (tenantId: string, id: string) => [...activityKeys.all(tenantId), "detail", id] as const,
};
function parseEvent(value: unknown) {
  const result = eventSchema.safeParse(value);
  if (!result.success) throw new Error("The activity event response is invalid.");
  return result.data;
}
export function activityEventQuery(context: HttpReadContext, eventId: string) {
  return { queryKey: activityKeys.detail(context.tenantId, eventId),
    queryFn: async () => parseEvent(await context.ports.http.json<unknown>("GET", `/v1/activity/${encodeURIComponent(eventId)}`)) };
}
export function ensureActivityEvent(context: HttpLoaderReadContext, eventId: string) {
  return context.queryClient.ensureQueryData(activityEventQuery(context, eventId));
}
export const activityEvents: FeatureEventHandler = {
  eventTypes: ["*"],
  handle(event, client) {
    void invalidateQueriesWithOptimisticOwnership(client, activityKeys.pages(event.tenantId));
    void invalidateQueriesWithOptimisticOwnership(client, activityKeys.recent(event.tenantId));
  },
};

export function RecentActivityPanel() {
  const tenantId = useTenantId(); const { http } = usePorts();
  const query = useQuery({ queryKey: activityKeys.recent(tenantId), queryFn: async () => {
    const result = pageSchema.safeParse(await http.json<unknown>("GET", "/v1/activity", { query: { limit: 5 } }));
    if (!result.success) throw new Error("The activity response is invalid."); return result.data;
  }, meta: { suppressGlobalErrorToast: true } });
  return <section className="card" aria-label="Recent activity"><h2>Recent activity</h2>
    {query.isPending ? <p>Loading activity…</p> : null}
    {query.error ? <p role="alert">Recent activity could not be refreshed: {query.error.message}{query.data ? " Showing the last loaded events." : ""}</p> : null}
    {query.data?.events.length ? <ul>{query.data.events.map((event) => <li key={event.eventId}><Link to="/activity/$eventId" params={{ eventId: event.eventId }}>{event.type}</Link>{` · ${event.occurredAt}`}</li>)}</ul> : query.data ? <p>No activity recorded yet.</p> : null}
    <Link to="/debug">View activity</Link>
  </section>;
}

export interface ActivityFilters {
  readonly q: string; readonly level: string; readonly stage: string; readonly eventType: string;
  readonly feature: string; readonly aggregateId: string; readonly since: string; readonly until: string;
}

export function ActivityPage({ filters, onFilterChange }: { readonly filters: ActivityFilters; readonly onFilterChange: (filters: ActivityFilters) => void }) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const [draft, setDraft] = useState(filters);
  useEffect(() => { setDraft(filters); }, [filters.q, filters.level, filters.stage, filters.eventType,
    filters.feature, filters.aggregateId, filters.since, filters.until]);
  const query = useInfiniteQuery({
    queryKey: [...activityKeys.pages(tenantId), filters] as const, initialPageParam: null as string | null,
    queryFn: async ({ pageParam }) => {
      const result = pageSchema.safeParse(await http.json<unknown>("GET", "/v1/activity", { query: {
        before: pageParam, limit: 50, q: filters.q, level: filters.level, stage: filters.stage,
        type: filters.eventType, feature: filters.feature, aggregateId: filters.aggregateId,
        since: filters.since, until: filters.until,
      } }));
      if (!result.success) throw new Error("The activity response is invalid.");
      return result.data;
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    meta: { suppressGlobalErrorToast: true },
  });
  const events = query.data?.pages.flatMap((page) => page.events) ?? [];
  return <div>
    <PageHead eyebrow="Activity" title="Activity" subtitle="Committed changes in this workspace." />
    <details><summary>Filter activity{Object.values(filters).some(Boolean) ? " (active)" : ""}</summary>
      <form onSubmit={(event) => { event.preventDefault(); onFilterChange(draft); }}>
        <label>Search events or record IDs<input value={draft.q} onChange={(event) => setDraft({ ...draft, q: event.target.value })} /></label>
        <label htmlFor="activity-level">Level</label><Select value={draft.level} onValueChange={(value) => { if (value !== null) setDraft({ ...draft, level: value }); }}><SelectTrigger id="activity-level"><SelectValue>{({ "": "All levels", debug: "Debug", info: "Info", warn: "Warning", error: "Error" } as Record<string, string>)[draft.level] ?? draft.level}</SelectValue></SelectTrigger><SelectContent><SelectItem value="">All levels</SelectItem><SelectItem value="debug">Debug</SelectItem><SelectItem value="info">Info</SelectItem><SelectItem value="warn">Warning</SelectItem><SelectItem value="error">Error</SelectItem></SelectContent></Select>
        <label>Stage<input value={draft.stage} onChange={(event) => setDraft({ ...draft, stage: event.target.value })} /></label>
        <label>Event type<input value={draft.eventType} onChange={(event) => setDraft({ ...draft, eventType: event.target.value })} /></label>
        <label>Feature<input value={draft.feature} onChange={(event) => setDraft({ ...draft, feature: event.target.value })} /></label>
        <label>Record ID<input value={draft.aggregateId} onChange={(event) => setDraft({ ...draft, aggregateId: event.target.value })} /></label>
        <label>Since (ISO timestamp with timezone)<input value={draft.since} onChange={(event) => setDraft({ ...draft, since: event.target.value })} /></label>
        <label>Until (ISO timestamp with timezone)<input value={draft.until} onChange={(event) => setDraft({ ...draft, until: event.target.value })} /></label>
        <Button type="submit">Apply filters</Button>
        <Button type="button" variant="outline" onClick={() => {
          const empty = { q: "", level: "", stage: "", eventType: "", feature: "", aggregateId: "", since: "", until: "" };
          setDraft(empty); onFilterChange(empty);
        }}>Clear filters</Button>
      </form>
    </details>
    {query.error ? <p role="alert">Activity could not be refreshed: {query.error.message}{query.data ? " Previously loaded events remain visible." : ""}</p> : null}
    {query.isPending ? <p>Loading activity…</p> : null}
    {query.data && events.length === 0 ? <p>No activity recorded yet.</p> : null}
    {events.length ? <ul>{events.map((event) => <li key={event.eventId}>
      <Link to="/activity/$eventId" params={{ eventId: event.eventId }}>{event.type}</Link>
      {` · ${event.feature} · ${event.level}${event.stage ? ` · ${event.stage}` : ""} · ${event.occurredAt}`}
    </li>)}</ul> : null}
    {query.hasNextPage ? <Button type="button" variant="outline" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>{query.isFetchingNextPage ? "Loading…" : "Load older activity"}</Button> : null}
  </div>;
}

export function ActivityEventPage({ eventId }: { readonly eventId: string }) {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const query = useQuery({ ...activityEventQuery({ tenantId, ports: { http } }, eventId), meta: { suppressGlobalErrorToast: true } });
  return <div>
    <PageHead eyebrow="Activity" title="Activity detail" />
    <Link to="/debug" search={{ page: 1, pageSize: 50, sort: "occurred_at", dir: "desc", q: "", level: "", stage: "", eventType: "", feature: "", aggregateId: "", since: "", until: "" }}>Back to activity</Link>
    {query.isPending ? <p>Loading event…</p> : null}
    {query.error ? <p role="alert">{query.error.message}</p> : null}
    {query.data ? <section className="card"><h2>{query.data.type}</h2><p>{query.data.feature} · {query.data.level}{query.data.stage ? ` · ${query.data.stage}` : ""} · {query.data.occurredAt}</p><p>Event {query.data.eventId}{query.data.aggregateId ? ` · Record ${query.data.aggregateId}` : ""}</p><details><summary>Event details</summary><pre>{JSON.stringify(query.data.payload, null, 2)}</pre></details></section> : null}
  </div>;
}
