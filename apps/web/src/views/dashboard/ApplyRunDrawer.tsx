import { useNavigate } from "@tanstack/react-router";
import { useCallback } from "react";

import { useApplyRunQuery } from "../../contexts/operations/hooks/useApplyRunQuery.js";
import { useEscapeKey } from "../../shared/hooks/useEscapeKey.js";
import { formatDateTime } from "../../shared/lib/formatters.js";
import { DetailDrawerBackdrop } from "../../shared/ui/detail-drawer-backdrop.js";
import { Empty } from "../../shared/ui/empty.js";
import { Section } from "../../shared/ui/section.js";
import { StatusDot } from "../../shared/ui/status-dot.js";
import { ApplyRunTimeline } from "../../contexts/apply/components/ApplyRunTimeline.js";

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
  const navigate = useNavigate();
  const close = useCallback(() => {
    void navigate({ to: "/dashboard" });
  }, [navigate]);
  useEscapeKey(true, close);

  const { data: run, isLoading, error } = useApplyRunQuery(runId);
  const message = error instanceof Error ? error.message : null;
  const notFound = !isLoading && !message && run === null;

  return (
    <DetailDrawerBackdrop onDismiss={close}>
      <div
        className="drawer detail-drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Apply run details"
      >
        <button
          aria-label="Close apply run details"
          className="drawer-close"
          type="button"
          onClick={close}
        >
          x
        </button>
        {message ? <Empty title={message} /> : null}
        {!message && isLoading ? <Empty title="Loading apply run." /> : null}
        {notFound ? <Empty title="Apply run is no longer in the recent list." /> : null}
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
      </div>
    </DetailDrawerBackdrop>
  );
}
