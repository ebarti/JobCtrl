import { create } from "zustand";
import { z } from "zod";

import type { SessionPort } from "../../shared/ports/SessionPort.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../shared/providers/TenantProvider.js";
import { PYTHON_JOBS_SORT_FIELDS } from "../../shared/stores/saved-table-views.js";
import type { JobGridQuery, JobGridTextFilter } from "./composedList.js";

type ScrollPosition = { listTop: number; tableLeft: number };
type Navigation = { session: SessionPort; tenant: string; query: JobGridQuery; scroll: ScrollPosition };
export const useJobGridNavigationStore = create<{
  current: Navigation | null;
  remember: (session: SessionPort, tenant: string, query: JobGridQuery) => void;
  scroll: (session: SessionPort, tenant: string, position: Partial<ScrollPosition>) => void;
  clear: (session: SessionPort, tenant: string) => void;
}>((set) => ({
  current: null,
  remember: (session, tenant, query) => set((state) => {
    const sameScope = state.current?.session === session && state.current.tenant === tenant;
    if (sameScope && JSON.stringify(state.current?.query) === JSON.stringify(query)) return state;
    return { current: { session, tenant, query, scroll: sameScope ? state.current!.scroll : { listTop: 0, tableLeft: 0 } } };
  }),
  scroll: (session, tenant, position) => set((state) => state.current?.session === session && state.current.tenant === tenant
    ? { current: { ...state.current, scroll: { ...state.current.scroll, ...position } } } : state),
  clear: (session, tenant) => set((state) => state.current?.session === session && state.current.tenant === tenant ? { current: null } : state),
}));

const defaultQuery: JobGridQuery = { q: "", job_state: "active", sort: "discovered_at", direction: "desc", offset: 0, limit: 50 };
const sortSchema = z.enum(PYTHON_JOBS_SORT_FIELDS);

/** Navigation memory is scoped to this app session and tenant; it contains no posting or profile content. */
export function useJobsReturnSearch() {
  const { session } = usePorts();
  const tenant = useTenantId();
  const query = useJobGridNavigationStore((state) => state.current?.session === session && state.current.tenant === tenant ? state.current.query : defaultQuery);
  const columnFilters: Record<string, JobGridTextFilter> = {};
  for (const [id, value] of Object.entries(query.column_filters ?? {})) if (value) columnFilters[id] = value;
  return { ...query, offset: query.offset > 0 && !query.query_revision ? 0 : query.offset,
    sort: sortSchema.catch("discovered_at").parse(query.sort), column_filters: columnFilters,
    grid: "v1" as const, stage: "all" as const, state: "all" as const, applyStatus: "all" as const,
    deleted: "active" as const, dir: "desc" as const, page: 1, pageSize: query.limit };
}
