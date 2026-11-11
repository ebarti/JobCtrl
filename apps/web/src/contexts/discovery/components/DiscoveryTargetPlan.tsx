import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { discoveryKeys } from "../queryKeys.js";
import { useDiscoveryActionRecovery } from "../hooks/useDiscoveryActionRecovery.js";
import { useDiscoveryTargetPlanQuery } from "../hooks/useDiscoveryTargetPlanQuery.js";

const RunReceipt = z.object({ runId: z.string().min(1), workflowId: z.string().min(1), status: z.string().min(1) });

export function DiscoveryTargetPlan() {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const recovery = useDiscoveryActionRecovery("discovery.refresh_targets");
  const query = useDiscoveryTargetPlanQuery();
  const refresh = useMutation({ mutationFn: async (profileRevision: number) => {
    const body = { force: true, expectedProfileVersion: profileRevision };
    const { requestId, databaseInstanceId } = await recovery.begin(body, profileRevision);
    const result = RunReceipt.safeParse(await http.json<unknown>("POST", "/v1/actions/discovery.refresh_targets", { body, idempotencyKey: requestId, expectedDatabaseInstanceId: databaseInstanceId }));
    if (!result.success) throw createUnconfirmedWriteError("POST", "/v1/actions/discovery.refresh_targets", result.error);
    return result.data;
  }, onSuccess: (result) => setRunId(result.runId), onSettled: () => { recovery.refresh(); void client.invalidateQueries({ queryKey: discoveryKeys.targetPlan(tenantId) }); } });
  const plan = query.data?.accepted;
  const status = recovery.status?.status;
  return <section className="card full p-4" aria-label="Profile search plan">
    <h2>Profile search plan</h2>
    <p>These queries use the target fields you saved. A query expands search recall; it does not establish job fit.</p>
    {query.error ? <p role="alert">Search plan could not be refreshed. {plan ? "The last loaded plan remains below." : ""}</p> : null}
    {refresh.error ? <p role="alert">Search plan refresh could not be confirmed: {refresh.error.message}.{plan ? " The previous plan remains available." : ""}</p> : null}
    {recovery.record || runId ? <p role="status">Plan refresh: {recovery.statusError ? "status unavailable" : status ?? "checking status"}{recovery.status?.errorCode ? ` (${recovery.status.errorCode})` : ""}</p> : null}
    {!recovery.ready ? <p role="alert">{recovery.error ? "Session recovery storage is unavailable or invalid." : "Checking session recovery storage…"}</p> : recovery.record ? <Button type="button" variant="outline" disabled={recovery.checking} onClick={() => { void recovery.check().then((finished) => { if (finished) setRunId(null); }); }}>Check previous plan refresh</Button> : null}
    {recovery.message ? <p role="status">{recovery.message}</p> : null}
    {status === "failed" || status === "cancelled" ? <p role="alert">Plan refresh did not complete.{plan ? " The previous accepted plan remains available." : ""}</p> : null}
    {plan ? <>
      <p role="status">{query.data?.current ? "Current" : "Profile changed; this saved plan needs refresh"} · Profile revision {plan.profileRevision} · {plan.createdAt}</p>
      <ul>{plan.queries.map((item, index) => <li key={`${item.query}:${index}`}>
        <strong>{item.query}</strong> · tier {item.tier}{item.authority === "literal_authored_target" ? " · your saved target" : " · model-proposed recall"}
        {item.source_scope.length ? ` · sources: ${item.source_scope.join(", ")}` : ""}
        {item.rationale ? <p>{item.rationale}</p> : null}
        {item.citations?.length ? <details><summary>Recorded target sources</summary>{item.citations.map((citation, citationIndex) => <blockquote key={citationIndex}><code>{citation.source_id}</code>: {citation.quote}</blockquote>)}</details> : null}
      </li>)}</ul>
      <p>Locations: {plan.locations.length ? plan.locations.map((item) => `${item.location || "Any location"}${item.remote ? " (remote)" : ""}`).join("; ") : "not specified"}</p>
      {plan.provenance ? <details><summary>Model provenance</summary><p>{plan.provenance.provider} · {plan.provenance.model} · {plan.provenance.lane}</p><p>{plan.provenance.prompt_version} · {plan.provenance.receipt_id}</p><code className="break-all">{plan.provenance.input_fingerprint}</code></details> : <p>Literal saved targets; no model call was required.</p>}
    </> : query.isPending ? <p>Loading saved search plan.</p> : <p>No search plan has been saved yet.</p>}
    <Button type="button" variant="outline" disabled={refresh.isPending || !recovery.ready || (recovery.record ? !recovery.canRetry || !recovery.record.sourceRevision : query.isFetching || Boolean(query.error) || !query.data?.profileRevision)} onClick={() => {
      const revision = recovery.record?.sourceRevision ?? query.data?.profileRevision;
      if (revision) refresh.mutate(revision);
    }}>{refresh.isPending ? "Queueing refresh…" : recovery.record ? "Retry the same refresh request" : "Refresh search plan"}</Button>
  </section>;
}
