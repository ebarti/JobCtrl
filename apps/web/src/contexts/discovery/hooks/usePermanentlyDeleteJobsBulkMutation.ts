import type { BulkPermanentDeleteRequest, JobMutationResponse, PreparePermanentDeleteSelectionRequest, PreparePermanentDeleteSelectionResponse } from "@jobctrl/contracts";
import { useMutation, useQueryClient, type UseMutationResult } from "@tanstack/react-query";
import { JobCtrlApiError } from "@jobctrl/api-client";
import { z } from "zod";

import { createOptimisticMutation } from "../../../shared/lib/createOptimisticMutation.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { patchListRemove } from "../lib/jobListPatches.js";

const conflictReceiptSchema = z.object({
  error: z.literal("permanent_delete_selection_conflict"),
  deletedJobKeys: z.array(z.string()).length(0),
  conflictingJobKeys: z.array(z.string()),
  unprocessedJobKeys: z.array(z.string()),
});

export function permanentDeleteConflictReceipt(error: unknown) {
  if (!(error instanceof JobCtrlApiError) || error.status !== 409) return null;
  const parsed = conflictReceiptSchema.safeParse(error.responseBody);
  return parsed.success ? parsed.data : null;
}

export function usePermanentlyDeleteJobsBulkMutation(): UseMutationResult<
  JobMutationResponse,
  Error,
  BulkPermanentDeleteRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation(
    createOptimisticMutation<JobMutationResponse, BulkPermanentDeleteRequest>(queryClient, {
      mutationKey: jobsKeys.all(tenantId),
      mutationFn: (body) => api.permanentlyDeleteJobs(body),
      optimisticUpdates: (body) =>
        body.allMatching
          ? []
          : [
              {
                queryKey: jobsKeys.lists(tenantId),
                exact: false,
                patch: (current) => patchListRemove(current, new Set(body.jobKeys)),
              },
            ],
      settle: () => [jobsKeys.lists(tenantId), dashboardKeys.summary(tenantId)],
    }),
  );
}

export function usePreparePermanentDeleteSelectionMutation(): UseMutationResult<
  PreparePermanentDeleteSelectionResponse,
  Error,
  PreparePermanentDeleteSelectionRequest
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body) => api.preparePermanentDeleteSelection(body),
    onError: () => { void queryClient.invalidateQueries({ queryKey: jobsKeys.lists(tenantId) }); },
  });
}
