import { useEffect, useState } from "react";

import { useHealthQuery } from "../../contexts/operations/hooks/useHealthQuery.js";
import { useEventStreamStatus } from "../../contexts/operations/providers/EventStreamProvider.js";
import { databaseStartupProblem } from "../lib/databaseStartupProblem.js";
import type { EventStreamStatus } from "../ports/EventStreamPort.js";

const STATUS_LABEL: Record<EventStreamStatus, string> = {
  connecting: "Connecting",
  open: "Live",
  closed: "Reconnecting",
  workspace_changed: "Workspace changed",
};

const CONNECTION_LOST_THRESHOLD_MS = 30_000;

export function ConnectionStatusPill() {
  const status = useEventStreamStatus();
  const health = useHealthQuery();
  const databaseProblem = databaseStartupProblem(health.error);
  const workerStatus = health.data?.worker.status ?? "healthy";
  const workerUnhealthy = workerStatus !== "healthy";
  const workspaceChanged = status === "workspace_changed";
  const lostForLong = useDisconnectedLongerThan(status, CONNECTION_LOST_THRESHOLD_MS);
  const label = databaseProblem
    ? (databaseProblem.kind === "migration_required" ? "Upgrade required" : "Database unavailable")
    : workspaceChanged
      ? STATUS_LABEL.workspace_changed
      : workerUnhealthy
        ? "Worker unavailable"
        : lostForLong
          ? "Offline"
          : STATUS_LABEL[status];
  const spend = databaseProblem ? undefined : health.data?.llmSpend;
  return (
    <div className="connection-pill-group">
      <span
        className="connection-pill"
        data-status={databaseProblem || workspaceChanged || workerUnhealthy || lostForLong ? "lost" : status}
        aria-live="polite"
        data-typography="status"
      >
        {label}
      </span>
      {spend ? (
        <span
          className="connection-spend"
          data-status={spend.status}
          aria-live="polite"
          data-typography="metadata"
        >
          {spend.status === "incomplete" || spend.estimatedUsd === null
            ? "LLM spend pending or unresolved"
            : formatSpendLine(spend.estimatedUsd, spend.dailyBudgetUsd, spend.unlimited)}
        </span>
      ) : null}
      {databaseProblem ? (
        <div
          className="connection-banner"
          data-state="error"
          data-typography="body"
          role="alert"
          aria-live="assertive"
        >
          {databaseProblem.message}{" "}
          <a href="https://jobctrl.dev/user/getting-started#update-roll-back-or-remove-jobctrl" target="_blank" rel="noreferrer">
            Update guidance
          </a>
        </div>
      ) : workspaceChanged ? (
        <div
          className="connection-banner"
          data-state="error"
          data-typography="body"
          role="alert"
          aria-live="assertive"
        >
          The workspace database changed. Stop JobCtrl, inspect the workspace, restart JobCtrl, and reload this page.
        </div>
      ) : workerUnhealthy ? (
        <div
          className="connection-banner"
          data-state="error"
          data-typography="body"
          role="alert"
          aria-live="assertive"
        >
          {health.data?.worker.message ?? "JobCtrl automation worker health is unavailable."}
        </div>
      ) : lostForLong ? (
        <div
          className="connection-banner"
          data-state="warning"
          data-typography="body"
          role="status"
          aria-live="polite"
        >
          Connection lost — events paused; data will refresh when reconnected.
        </div>
      ) : null}
    </div>
  );
}

function formatSpendLine(estimatedUsd: number, dailyBudgetUsd: number, unlimited: boolean): string {
  const budget = unlimited ? "unlimited" : `$${dailyBudgetUsd.toFixed(2)}`;
  return `LLM $${estimatedUsd.toFixed(2)} / ${budget}`;
}

function useDisconnectedLongerThan(status: EventStreamStatus, thresholdMs: number): boolean {
  const [tripped, setTripped] = useState(false);
  useEffect(() => {
    if (status === "open" || status === "workspace_changed") {
      setTripped(false);
      return;
    }
    setTripped(false);
    const handle = setTimeout(() => {
      setTripped(true);
    }, thresholdMs);
    return () => {
      clearTimeout(handle);
    };
  }, [status, thresholdMs]);
  return tripped;
}
