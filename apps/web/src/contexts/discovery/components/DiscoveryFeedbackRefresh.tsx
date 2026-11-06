import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { createUnconfirmedWriteError } from "../../../shared/lib/unconfirmed-write.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { Button } from "../../../shared/ui/button.js";
import { discoveryKeys } from "../queryKeys.js";
import { useDiscoveryActionRecovery } from "../hooks/useDiscoveryActionRecovery.js";

const Receipt = z.object({ runId: z.string().min(1), workflowId: z.string().min(1), status: z.string().min(1) });

export function DiscoveryFeedbackRefresh() {
  const tenantId = useTenantId(); const { http } = usePorts(); const client = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const recovery = useDiscoveryActionRecovery("discovery.refresh_feedback");
  const refresh = useMutation({ mutationFn: async () => {
    const { requestId, databaseInstanceId } = await recovery.begin({});
    const parsed = Receipt.safeParse(await http.json<unknown>("POST", "/v1/actions/discovery.refresh_feedback", { body: {}, idempotencyKey: requestId, expectedDatabaseInstanceId: databaseInstanceId }));
    if (!parsed.success) throw createUnconfirmedWriteError("POST", "/v1/actions/discovery.refresh_feedback", parsed.error);
    return parsed.data;
  }, onSuccess: (receipt) => setRunId(receipt.runId), onSettled: () => { recovery.refresh(); void client.invalidateQueries({ queryKey: discoveryKeys.roleMatchFeedback(tenantId) }); } });
  const value = recovery.status?.status;
  return <div>
    <p>Refresh proposals from saved feedback. Each proposal stays under review until you decide.</p>
    <Button type="button" variant="outline" disabled={refresh.isPending || !recovery.ready || Boolean(recovery.record && !recovery.canRetry)} onClick={() => refresh.mutate()}>{refresh.isPending ? "Queueing refresh…" : recovery.record ? "Retry the same refresh request" : "Refresh feedback proposals"}</Button>
    {!recovery.ready ? <p role="alert">{recovery.error ? "Session recovery storage is unavailable or invalid." : "Checking session recovery storage…"}</p> : recovery.record ? <Button type="button" variant="outline" disabled={recovery.checking} onClick={() => { void recovery.check().then((finished) => { if (finished) setRunId(null); }); }}>Check previous feedback refresh</Button> : null}
    {recovery.message ? <p role="status">{recovery.message}</p> : null}
    {refresh.error ? <p role="alert">Refresh could not be confirmed: {refresh.error.message}. Saved proposals remain available.</p> : null}
    {recovery.record || runId ? <p role="status">Refresh: {recovery.statusError ? "status unavailable" : value ?? "checking status"}{recovery.status?.errorCode ? ` (${recovery.status.errorCode})` : ""}</p> : null}
  </div>;
}
