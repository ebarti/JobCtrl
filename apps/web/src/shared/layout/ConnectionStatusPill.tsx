import { useEffect, useState } from "react";

import { useRuntimeHealth } from "../../contexts/runtime/index.js";
import { useEventStreamStatus } from "../providers/EventStreamProvider.js";
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
  const health = useRuntimeHealth();
  const databaseProblem = databaseStartupProblem(health.error);
  const workspaceChanged = status === "workspace_changed";
  const demo = health.data?.mode === "demo";
  const healthUnavailable = Boolean(health.error);
  const workerUnhealthy = !demo && !healthUnavailable && health.data ? !health.data.worker.healthy : false;
  const lostForLong = useDisconnectedLongerThan(status, CONNECTION_LOST_THRESHOLD_MS);
  const label = databaseProblem
    ? (databaseProblem.kind === "migration_required" ? "Upgrade required" : "Database unavailable")
    : workspaceChanged ? STATUS_LABEL.workspace_changed
      : healthUnavailable ? "Health unavailable"
        : workerUnhealthy ? "Worker unavailable"
          : lostForLong ? "Offline" : demo && status === "open" ? "Demo mode" : STATUS_LABEL[status];
  const spend = healthUnavailable || demo ? undefined : health.data?.llmSpend;
  return <div className="connection-pill-group">
    <span className="connection-pill" data-status={databaseProblem || workspaceChanged || healthUnavailable || workerUnhealthy || lostForLong ? "lost" : status} aria-live="polite" data-typography="status">{label}</span>
    {spend ? <span className="connection-spend" data-status={spend.accountingComplete ? "ok" : "incomplete"} aria-live="polite" data-typography="metadata">
      {spend.accountingComplete ? `LLM $${spend.costUsd.toFixed(2)}${spend.costAuthority === "includes_estimates" ? " (includes estimates)" : ""}` : "LLM spend pending or unresolved"}
    </span> : null}
    {databaseProblem ? <div className="connection-banner" data-state="error" role="alert">{databaseProblem.message}</div>
      : workspaceChanged ? <div className="connection-banner" data-state="error" role="alert">The workspace database changed. Stop JobCtrl, inspect the workspace, restart JobCtrl, and reload this page.</div>
        : healthUnavailable ? <div className="connection-banner" data-state="warning" role="status">Application health is unavailable; retrying.</div>
          : workerUnhealthy ? <div className="connection-banner" data-state="error" role="alert">The automation worker is unavailable. Running work may be delayed until it reconnects.</div>
            : lostForLong ? <div className="connection-banner" data-state="warning" role="status">Connection lost — events paused; data will refresh when reconnected.</div> : null}
  </div>;
}

function useDisconnectedLongerThan(status: EventStreamStatus, thresholdMs: number): boolean {
  const [tripped, setTripped] = useState(false);
  useEffect(() => {
    if (status === "open" || status === "workspace_changed") { setTripped(false); return; }
    setTripped(false);
    const handle = setTimeout(() => setTripped(true), thresholdMs);
    return () => clearTimeout(handle);
  }, [status, thresholdMs]);
  return tripped;
}
