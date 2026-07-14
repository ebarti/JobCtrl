import type { ArtifactSortField } from "@jobctrl/contracts";
import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import type { RowSelectionState, SortingState } from "@tanstack/react-table";
import { useEffect, useMemo, useState } from "react";

import { useArtifactsListQuery } from "../../contexts/operations/hooks/useArtifactsListQuery.js";
import {
  ARTIFACT_SORT_FIELDS_TUPLE,
  type ArtifactsSearch,
} from "../../routes/-artifacts.search.js";
import { PageHead } from "../../shared/ui/page-head.js";
import { ArtifactFilterBar } from "./ArtifactFilterBar.js";
import { ArtifactsTable } from "./ArtifactsTable.js";

const SORTABLE_ARTIFACT_FIELDS: ReadonlySet<ArtifactSortField> = new Set(
  ARTIFACT_SORT_FIELDS_TUPLE,
);

function isArtifactSortField(value: string): value is ArtifactSortField {
  return SORTABLE_ARTIFACT_FIELDS.has(value as ArtifactSortField);
}

function artifactsListInput(search: ArtifactsSearch) {
  return {
    page: search.page,
    pageSize: search.pageSize,
    q: search.q,
    sort: search.sort,
    dir: search.dir,
    status: search.status === "all" ? "" : search.status,
  };
}

export function ArtifactsView() {
  const search = useSearch({ from: "/artifacts" });
  const navigate = useNavigate({ from: "/artifacts" });

  const { data, isFetching, error } = useArtifactsListQuery(artifactsListInput(search));
  const message = error instanceof Error ? error.message : null;

  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  useEffect(() => {
    setRowSelection({});
  }, [search.dir, search.page, search.pageSize, search.q, search.sort, search.status]);

  const setSearch = (next: Partial<ArtifactsSearch>) => {
    void navigate({ search: (prev: ArtifactsSearch) => ({ ...prev, ...next }) });
  };

  const sorting = useMemo<SortingState>(
    () => [{ id: search.sort, desc: search.dir === "desc" }],
    [search.sort, search.dir],
  );

  const handleSortingChange = (next: SortingState) => {
    const head = next[0];
    if (!head || !isArtifactSortField(head.id)) {
      return;
    }
    setSearch({
      sort: head.id,
      dir: head.desc ? "desc" : "asc",
      page: 1,
    });
  };

  return (
    <div className="route-page route-page--artifacts">
      <PageHead
        eyebrow="Library"
        title="Artifacts"
        subtitle={data ? `${data.pagination.total} total` : "loading"}
      />
      <section className="card full data-surface">
        {message ? <div className="banner inline">{message}</div> : null}
        <ArtifactFilterBar search={search} />
        <ArtifactsTable
          data={data ?? null}
          loading={isFetching}
          sorting={sorting}
          onSortingChange={handleSortingChange}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          page={search.page}
          pageSize={search.pageSize}
          onPageChange={(page) => setSearch({ page })}
          onPageSizeChange={(pageSize) => setSearch({ pageSize, page: 1 })}
          onOpenArtifact={(artifactId) =>
            void navigate({ to: "/artifacts/$artifactId", params: { artifactId } })
          }
        />
      </section>
      <Outlet />
    </div>
  );
}
