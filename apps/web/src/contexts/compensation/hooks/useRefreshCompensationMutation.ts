import type { RefreshCompensationRequest } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";

import { invalidateQueriesWithOptimisticOwnership } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { jobsKeys } from "../../jobs/index.js";
import { compensationKeys } from "../queryKeys.js";

export interface RefreshCompensationVariables extends RefreshCompensationRequest {
  readonly jobId: string;
}
export type RefreshAllCompensationVariables = RefreshCompensationRequest;

/** A successful POST is a durable submission receipt, not a completed refresh. */
export function useRefreshCompensationMutation(): UseMutationResult<unknown, Error, RefreshCompensationVariables> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, ...body }) => http.json<unknown>("POST", `/v1/jobs/${encodeURIComponent(jobId)}/actions/refresh-compensation`, { body }),
    onSettled: (_data, _error, { jobId }) => Promise.all([
      invalidateQueriesWithOptimisticOwnership(client, compensationKeys.evidence(tenantId, jobId)),
      invalidateQueriesWithOptimisticOwnership(client, compensationKeys.comparison(tenantId, jobId)),
      invalidateQueriesWithOptimisticOwnership(client, jobsKeys.detail(tenantId, jobId)),
      invalidateQueriesWithOptimisticOwnership(client, jobsKeys.lists(tenantId)),
    ]).then(() => undefined),
  });
}

export function useRefreshAllCompensationMutation(): UseMutationResult<unknown, Error, RefreshAllCompensationVariables> {
  const tenantId = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body) => http.json<unknown>("POST", "/v1/jobs/actions/refresh-compensation", { body }),
    onSettled: () => Promise.all([
      invalidateQueriesWithOptimisticOwnership(client, compensationKeys.all(tenantId)),
      invalidateQueriesWithOptimisticOwnership(client, jobsKeys.all(tenantId)),
    ]).then(() => undefined),
  });
}
