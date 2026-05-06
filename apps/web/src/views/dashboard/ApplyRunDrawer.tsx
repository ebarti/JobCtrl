import type { DashboardSummary } from "@jobhunter/contracts";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";

import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { usePorts } from "../../shared/providers/PortsProvider.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";
import { StatusDot } from "../../shared/ui/status-dot.js";
import { ApplyRunTimeline } from "./ApplyRunTimeline.js";

type ApplyRunSummary = DashboardSummary["applyRuns"][number];

function applyRunDotState(status: string): string {
  if (status === "running") {
    return "running";
  }
  if (status === "failed") {
    return "failed";
  }
  return "succeeded";
}

export interface ApplyRunDrawerProps {
  runId: string;
}

export function ApplyRunDrawer({ runId }: ApplyRunDrawerProps) {
  const ports = usePorts();
  const navigate = useNavigate();
  const close = useCallback(() => {
    void navigate({ to: "/dashboard" });
  }, [navigate]);
  useEscapeKey(true, close);

  const [run, setRun] = useState<ApplyRunSummary | null>(null);
  const [error, setError] = useState("");
  const requestSeq = useRef(0);

  useEffect(() => {
    const requestId = requestSeq.current + 1;
    requestSeq.current = requestId;
    setRun(null);
    setError("");
    ports.api
      .dashboardSummary()
      .then((summary) => {
        if (requestId !== requestSeq.current) {
          return;
        }
        const match = summary.applyRuns.find((entry) => entry.runId === runId) ?? null;
        if (!match) {
          setError("Apply run is no longer in the recent list.");
        }
        setRun(match);
      })
      .catch((requestError: unknown) => {
        if (requestId !== requestSeq.current) {
          return;
        }
        setError(
          requestError instanceof Error ? requestError.message : "Unable to load apply run.",
        );
      });
  }, [ports.api, runId]);

  return (
    <div className="drawer-backdrop">
      <aside className="drawer detail-drawer">
        <button
          aria-label="Close apply run details"
          className="drawer-close"
          type="button"
          onClick={close}
        >
          x
        </button>
        {error && !run ? <Empty title={error} /> : null}
        {!run && !error ? <Empty title="Loading apply run." /> : null}
        {run ? (
          <>
            <div className="drawer-head">
              <StatusDot state={applyRunDotState(run.status)} />
              <span>
                <small>{run.company}</small>
                <h2>{run.title || "Apply run"}</h2>
                <p>
                  {run.status} · {run.dryRun ? "dry-run" : "live run"}
                </p>
              </span>
            </div>
            <Section title="Run details">
              <dl className="detail-list">
                <div>
                  <dt>Run id</dt>
                  <dd className="mono">{run.runId}</dd>
                </div>
                <div>
                  <dt>Job</dt>
                  <dd>{run.title || run.jobKey}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{run.status}</dd>
                </div>
                <div>
                  <dt>Dry-run</dt>
                  <dd>{run.dryRun ? "yes" : "no"}</dd>
                </div>
                <div>
                  <dt>Started</dt>
                  <dd>{formatDateTime(run.startedAt)}</dd>
                </div>
              </dl>
              <button
                className="tab on"
                type="button"
                disabled={!run.jobKey}
                onClick={() =>
                  void navigate({ to: "/jobs/$jobId", params: { jobId: run.jobKey } })
                }
              >
                open related job
              </button>
            </Section>
            <Section title="Timeline">
              <ApplyRunTimeline runId={run.runId} />
            </Section>
          </>
        ) : null}
      </aside>
    </div>
  );
}
