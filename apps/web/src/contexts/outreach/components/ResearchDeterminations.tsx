import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { outreachKeys } from "../queryKeys.js";
import { DeterminationRecords, recordsMatch, type RecordedDetermination } from "./OutreachDeterminations.js";

export function ResearchDeterminations({ taskId, expectedIds }: { taskId: string; expectedIds: readonly string[] }) {
  const [open, setOpen] = useState(false);
  const tenantId = useTenantId();
  const { http } = usePorts();
  const query = useQuery({
    queryKey: [...outreachKeys.researchTask(tenantId, taskId), "determinations", expectedIds],
    enabled: open,
    queryFn: async () => {
      const response = await http.json<{ ok: true; taskId: string; complete: boolean; authorityVerified: boolean; records: RecordedDetermination[] }>(
        "GET", `/v1/contacts/research/${encodeURIComponent(taskId)}/determinations`,
      );
      if (response.ok !== true || response.taskId !== taskId || typeof response.complete !== "boolean" || typeof response.authorityVerified !== "boolean" ||
          !Array.isArray(response.records) || !recordsMatch(response.records, expectedIds)) {
        throw new Error("The recorded review identities do not match this research task.");
      }
      return response;
    },
  });
  return <details onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Inspect research prompts, model results and sources</summary>
    {query.isFetching ? <p role="status">Loading recorded research.</p> : null}
    {query.error ? <p role="alert">Recorded research could not be loaded: {query.error.message}</p> : null}
    {query.data ? <DeterminationRecords records={query.data.records} complete={query.data.complete} authorityVerified={query.data.authorityVerified} /> : null}
  </details>;
}
