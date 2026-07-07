import {
  ACTIVITY_SORT_FIELDS,
  type ActivitySortField,
} from "@jobctrl/contracts";
import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import type { SortingState } from "@tanstack/react-table";
import { useMemo } from "react";

import { useActivityListQuery } from "../../contexts/operations/hooks/useActivityListQuery.js";
import type { ActivityListInput } from "../../contexts/operations/types.js";
import type { DebugSearch } from "../../routes/-debug.search.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { DebugActivityTable } from "./DebugActivityTable.js";
import { DebugFilterBar } from "./DebugFilterBar.js";

function activityInput(search: DebugSearch): ActivityListInput {
  return {
    page: search.page,
    pageSize: search.pageSize,
    sort: search.sort,
    dir: search.dir,
    q: search.q,
    level: search.level,
    stage: search.stage,
    eventType: search.eventType,
  };
}

const SORTABLE_ACTIVITY_FIELDS: ReadonlySet<ActivitySortField> = new Set(
  ACTIVITY_SORT_FIELDS,
);

function isActivitySortField(value: string): value is ActivitySortField {
  return SORTABLE_ACTIVITY_FIELDS.has(value as ActivitySortField);
}

export function DebugView() {
  const search = useSearch({ from: "/debug" });
  const navigate = useNavigate({ from: "/debug" });
  const { data, isFetching, error } = useActivityListQuery(activityInput(search));
  const message = error instanceof Error ? error.message : null;

  const setSearch = (next: Partial<DebugSearch>) => {
    void navigate({ search: (prev: DebugSearch) => ({ ...prev, ...next }) });
  };
  const sorting = useMemo<SortingState>(
    () => [{ id: search.sort, desc: search.dir === "desc" }],
    [search.dir, search.sort],
  );
  const handleSortingChange = (next: SortingState) => {
    const head = next[0];
    if (!head || !isActivitySortField(head.id)) {
      return;
    }
    setSearch({
      sort: head.id,
      dir: head.desc ? "desc" : "asc",
      page: 1,
    });
  };
  const openActivity = (eventId: string) => {
    void navigate({ to: "/activity/$eventId", params: { eventId } });
  };

  return (
    <>
      <section className="card full">
        <CardHeader
          title="Debug"
          meta={data ? `${data.pagination.total} activity events` : "loading"}
        />
        {message ? <div className="banner inline">{message}</div> : null}
        <DebugFilterBar search={search} onChange={setSearch} />
        <DebugActivityTable
          data={data ?? null}
          loading={isFetching}
          sorting={sorting}
          onSortingChange={handleSortingChange}
          page={search.page}
          pageSize={search.pageSize}
          onPageChange={(page) => setSearch({ page })}
          onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
          onOpenActivity={openActivity}
        />
      </section>
      <Outlet />
    </>
  );
}
