import { useQuery, type UseQueryResult } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { applyReviewKeys } from "../applyReviewKeys.js";
import type { ResumeReviewDraftResponse } from "../types.js";

export function useResumeReviewDraftQuery(
  jobId: string,
  enabled = true,
): UseQueryResult<ResumeReviewDraftResponse> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  return useQuery({
    queryKey: applyReviewKeys.draft(tenantId, jobId),
    queryFn: () => api.resumeReviewDraft(jobId),
    enabled,
    retry: false,
  });
}
