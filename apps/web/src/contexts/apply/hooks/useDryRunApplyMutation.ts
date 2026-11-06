import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { performApplicationCommand } from "./useApplyReviewMutations.js";
import { applyKeys } from "../queryKeys.js";
import { readApplication } from "../readQueries.js";

export interface DryRunApplyVariables {
  readonly jobId: string;
}
export function useDryRunApplyMutation() {
  const tenant = useTenantId();
  const { http, requestIdentity } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ jobId }: DryRunApplyVariables) => {
      const application = await readApplication(http, jobId);
      if (
        !application.payload ||
        application.stopped ||
        application.approvalBlockReason ===
          "application_request_predates_stop" ||
        application.intent ||
        application.receipt
      )
        throw new Error(
          "Prepare a current application payload before rehearsing it.",
        );
      const result = await performApplicationCommand(http, tenant, jobId, {
        kind: "rehearse",
        payloadId: application.payload.payloadId,
        idempotencyKey: requestIdentity.create(),
      });
      if (!result.run) throw new Error("The rehearsal run receipt is missing.");
      return result.run;
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: applyKeys.all(tenant) });
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
