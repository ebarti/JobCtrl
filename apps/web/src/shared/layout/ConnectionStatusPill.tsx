import { useEffect, useState } from "react";

import { useRuntimeHealth } from "../../contexts/runtime/index.js";
import { useEventStreamStatus } from "../providers/EventStreamProvider.js";
import { databaseStartupProblem } from "../lib/databaseStartupProblem.js";
import { modelActivityBeforeToday } from "../lib/model-activity.js";
import { Button } from "../ui/button.js";
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
  const dbosUnavailable = !demo && !healthUnavailable && health.data?.dbos?.available === false;
  const workerUnhealthy = !demo && !healthUnavailable && health.data ? !health.data.worker.healthy : false;
  const lostForLong = useDisconnectedLongerThan(status, CONNECTION_LOST_THRESHOLD_MS);
  const label = databaseProblem
    ? (databaseProblem.kind === "migration_required" ? "Upgrade required" : "Database unavailable")
    : workspaceChanged ? STATUS_LABEL.workspace_changed
      : healthUnavailable ? "Health unavailable"
        : dbosUnavailable ? "Workflow service unavailable"
          : workerUnhealthy ? "Worker unavailable"
            : lostForLong ? "Offline" : demo && status === "open" ? "Demo mode" : STATUS_LABEL[status];
  const spend = healthUnavailable || demo ? undefined : health.data?.llmSpend;
  const costStatus = spend?.costStatus ?? (spend?.accountingComplete ? "complete" : "unresolved");
  const accountingBlocked = spend?.accountingBlocked ?? (costStatus === "unresolved" || (costStatus === "unavailable" && !spend?.unlimited));
  const active = (spend?.activeCalls ?? 0) > 0 || costStatus === "pending";
  const spendDetails = [modelActivityBeforeToday(spend), costStatus === "unresolved" ? "Some past model usage is unknown. Inspect usage details in Settings → Budgets." : null].filter(Boolean).join(" ");
  const spendLabel = !spend ? null
    : active ? `LLM running${spend.unlimited ? " · No daily limit" : ""}`
      : accountingBlocked ? spend.monetaryAccountingBlocked === false ? "Token limit needs usage tracking" : "Daily limit needs cost tracking"
        : spend.unlimited ? "LLM · No daily limit"
          : costStatus === "unavailable" || spend.costUsd === null ? "LLM cost unavailable"
            : `LLM $${spend.costUsd.toFixed(2)}${spend.costAuthority === "includes_estimates" ? " (includes estimates)" : ""}`;
  return <div className="connection-pill-group">
    <span className="connection-pill" data-status={databaseProblem || workspaceChanged || healthUnavailable || dbosUnavailable || workerUnhealthy || lostForLong ? "lost" : status} aria-live="polite" data-typography="status">{label}</span>
    {health.data?.runtimeIdentity ? <span className="connection-workspace" data-typography="metadata" title={health.data.runtimeIdentity.workspace}>Workspace {health.data.runtimeIdentity.workspace.split("/").filter(Boolean).at(-1)}</span> : null}
    {spend ? <span className="connection-spend" title={spendDetails || undefined} data-status={active ? "pending" : accountingBlocked ? "incomplete" : "ok"} aria-live="polite" data-typography="metadata">
      {spendLabel}
    </span> : null}
    {databaseProblem ? <div className="connection-banner" data-state="error" role="alert">{databaseProblem.message}</div>
      : workspaceChanged ? <div className="connection-banner" data-state="error" role="alert">The workspace database changed. Stop JobCtrl, inspect the workspace, restart JobCtrl, and reload this page.</div>
        : healthUnavailable ? <div className="connection-banner" data-state="warning" role="status">Application health is unavailable; retrying.</div>
          : dbosUnavailable || workerUnhealthy ? <div className="connection-banner" data-state="error" role="alert">
            {dbosUnavailable ? "DBOS cannot accept durable work. Check JobCtrl status and try again." : (health.data?.worker.message ?? "Start the automation worker, then retry.")}{" "}
            <Button type="button" variant="outline" size="sm" disabled={health.isFetching} onClick={() => void health.refetch()}>Check again</Button>
          </div>
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
