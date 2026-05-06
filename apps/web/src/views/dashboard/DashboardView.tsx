import type { DashboardSummary } from "@jobhunter/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Empty } from "../../shared/ui/empty.js";
import { ActivityFeed } from "./ActivityFeed.js";
import { ApplyRunsCard } from "./ApplyRunsCard.js";
import { Funnel } from "./Funnel.js";
import { KpiGrid, KpiSkeleton } from "./KpiGrid.js";

type LoadState = "idle" | "loading" | "ready" | "error";

export function DashboardView() {
  const ports = usePorts();
  const [status, setStatus] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const requestSeq = useRef(0);

  const refresh = useCallback(async () => {
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setStatus("loading");
    setError("");
    try {
      await ports.api.health();
      const next = await ports.api.dashboardSummary();
      if (requestId !== requestSeq.current) {
        return;
      }
      setSummary(next);
      setStatus("ready");
    } catch (requestError) {
      if (requestId !== requestSeq.current) {
        return;
      }
      setStatus("error");
      setError(
        requestError instanceof Error
          ? requestError.message
          : "Unable to reach JobHunter API.",
      );
    }
  }, [ports.api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <>
      {summary ? <KpiGrid summary={summary} /> : <KpiSkeleton />}
      {error ? <div className="banner">{error}</div> : null}
      {summary ? (
        <div className="dashboard-grid">
          <Funnel summary={summary} />
          <ApplyRunsCard summary={summary} />
          <ActivityFeed summary={summary} />
        </div>
      ) : (
        <Empty title={status === "loading" ? "Loading dashboard." : "No dashboard data."} />
      )}
    </>
  );
}
