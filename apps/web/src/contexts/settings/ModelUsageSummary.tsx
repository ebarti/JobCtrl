import { useRuntimeHealth } from "../runtime/index.js";

/** Observed usage is independent of the current admission policy. */
export function ModelUsageSummary() {
  const health = useRuntimeHealth();
  const spend = health.data?.llmSpend;
  return <details className="rounded-md border border-border p-3">
    <summary>Today's model usage</summary>
    {health.isError ? <p>Usage details could not refresh. Try again after the application reconnects.</p>
      : !spend ? <p>Loading usage details…</p>
        : <div className="space-y-2 pt-2 text-sm">
          <p>Dollar total: {spend.costUsd === null ? "Unknown" : `$${spend.costUsd.toFixed(2)}`}.{spend.costUsd === null && spend.knownCostUsd !== undefined ? ` Recorded subtotal: $${spend.knownCostUsd.toFixed(2)}; this is not the complete total.` : ""}</p>
          {(spend.unresolvedCalls ?? 0) > 0 ? <p>{spend.unresolvedCalls} past model {spend.unresolvedCalls === 1 ? "call has" : "calls have"} unknown final usage. The original receipts remain unchanged.</p> : null}
          {(spend.activeCalls ?? 0) > 0 ? <p>{spend.activeCalls} model {spend.activeCalls === 1 ? "call is" : "calls are"} running. Final usage is pending.</p> : null}
          {spend.monetaryAccountingBlocked ? <p>Unknown past cost prevents enforcing the daily dollar limit. New budgeted calls are blocked. Changing a pricing quote does not recover missing past usage.</p> : null}
          {spend.tokenAccountingBlockedLanes?.length ? <p>Unknown past tokens prevent enforcing limits for: {spend.tokenAccountingBlockedLanes.join(", ")}. Other lanes remain available if their policies allow work. <a href="/settings/automation" className="underline">Review lane token limits</a>.</p> : null}
          {spend.accountingBlocked === false && spend.costStatus === "unresolved" ? <p>No enabled accounting limit is blocked by this history. New work can continue under the saved policies.</p> : null}
          {spend.costStatus === "unavailable" ? <p>Some completed calls did not report a monetary amount.</p> : null}
          <p>Usage is recorded for the current UTC day. Unknown usage is never treated as zero. JobCtrl has no automatic reconciliation action for missing final usage.</p>
        </div>}
  </details>;
}
