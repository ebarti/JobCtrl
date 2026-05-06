import type { ArtifactSummary, PaginatedResponse } from "@jobhunter/contracts";
import { Outlet, useNavigate, useSearch } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePorts } from "../../shared/providers/PortsProvider.js";
import { CardHeader } from "../../shared/ui/card-header.js";
import { Pager } from "../../shared/ui/pager.js";
import { ArtifactFilterBar } from "./ArtifactFilterBar.js";
import { ArtifactsTable } from "./ArtifactsTable.js";
import { groupArtifacts } from "./selectors/artifactSelectors.js";

export function ArtifactsView() {
  const ports = usePorts();
  const search = useSearch({ from: "/artifacts" });
  const navigate = useNavigate({ from: "/artifacts" });

  const [data, setData] = useState<PaginatedResponse<ArtifactSummary> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [openStatus, setOpenStatus] = useState("");
  const requestSeq = useRef(0);

  const load = useCallback(async () => {
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setLoading(true);
    setError("");
    try {
      const next = await ports.api.artifacts({
        page: search.page,
        pageSize: search.pageSize,
        q: search.q,
        sort: search.sort,
        dir: search.dir,
        status: search.status === "all" ? "" : search.status,
      });
      if (requestId === requestSeq.current) {
        setData(next);
      }
    } catch (requestError) {
      if (requestId === requestSeq.current) {
        setData(null);
        setError(
          requestError instanceof Error ? requestError.message : "Unable to load artifacts.",
        );
      }
    } finally {
      if (requestId === requestSeq.current) {
        setLoading(false);
      }
    }
  }, [
    ports.api,
    search.dir,
    search.page,
    search.pageSize,
    search.q,
    search.sort,
    search.status,
  ]);

  useEffect(() => {
    void load();
  }, [load]);

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
        {error ? <div className="banner inline">{error}</div> : null}
        {openStatus ? <div className="status-line">{openStatus}</div> : null}
        <ArtifactFilterBar search={search} onRefresh={() => void load()} />
        <ArtifactsTable
          groups={groups}
          loading={loading}
          loaded={data !== null}
          onError={setError}
          onStatus={setOpenStatus}
        />
        <Pager pagination={data?.pagination} page={search.page} onPage={setPage} />
      </section>
      <Outlet />
    </>
  );
}
