import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { payloadApproval } from "./useApplyReviewSession.js";
import { performApplicationCommand } from "./useApplyReviewMutations.js";
import { applyKeys } from "../queryKeys.js";
import { readApplication } from "../readQueries.js";

export interface ApplyJobVariables {
  readonly jobId: string;
  readonly body?: unknown;
}
export function useApplyJobMutation() {
  const tenant = useTenantId();
  const { http, requestIdentity } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ jobId }: ApplyJobVariables) => {
      const application = await readApplication(http, jobId);
      const approval = payloadApproval(application);
      if (!application.payload || !approval)
        throw new Error(
          "Review and approve the exact application payload before executing it.",
        );
      const result = await performApplicationCommand(http, tenant, jobId, {
        kind: "execute",
        payloadId: application.payload.payloadId,
        approvalId: approval.decisionId,
        idempotencyKey: requestIdentity.create(),
      });
      if (!result.run)
        throw new Error("The application run receipt is missing.");
      return result.run;
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: applyKeys.all(tenant) });
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
