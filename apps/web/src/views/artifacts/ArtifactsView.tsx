import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { useMemo } from "react";

import { useArtifactsListQuery } from "../../contexts/operations/hooks/useArtifactsListQuery.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Pager } from "../../shared/ui/pager.js";
import type { ArtifactsSearch } from "../../routes/-artifacts.search.js";
import { ArtifactFilterBar } from "./ArtifactFilterBar.js";
import { ArtifactsTable } from "./ArtifactsTable.js";
import { groupArtifacts } from "./selectors/artifactSelectors.js";

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

  const setPage = (page: number) => {
    void navigate({ search: (prev) => ({ ...prev, page }) });
  };

  const groups = useMemo(() => groupArtifacts(data?.items ?? []), [data?.items]);

  return (
    <>
      <section className="card full">
        <CardHeader
          title="Artifacts"
          meta={
            data
              ? `${groups.length} jobs · ${data.pagination.total} artifacts`
              : "loading"
          }
        />
        {message ? <div className="banner inline">{message}</div> : null}
        <ArtifactFilterBar search={search} />
        <ArtifactsTable groups={groups} loading={isFetching} loaded={data !== undefined} />
        <Pager pagination={data?.pagination} page={search.page} onPage={setPage} />
      </section>
      <Outlet />
    </>
  );
}
