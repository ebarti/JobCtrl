import type { PipelineOperationsSnapshot } from "@jobctrl/contracts";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { pipelineKeys } from "../../pipeline/queryKeys.js";

const ACTIVE_POLL_INTERVAL_MS = 15_000;
const IDLE_POLL_INTERVAL_MS = 60_000;
const PIPELINE_OPERATIONS_STALE_TIME_MS = 10_000;

function isActiveExecution(snapshot: PipelineOperationsSnapshot | undefined): boolean {
  const phase = snapshot?.execution?.phase;
  return phase === "discovering" || phase === "draining";
}

export function usePipelineOperationsQuery(): UseQueryResult<PipelineOperationsSnapshot> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: pipelineKeys.operations(tenantId),
    queryFn: () => api.pipelineOperations(),
    staleTime: PIPELINE_OPERATIONS_STALE_TIME_MS,
    refetchInterval: (query) =>
      isActiveExecution(query.state.data) ? ACTIVE_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS,
    refetchIntervalInBackground: false,
  });
}
