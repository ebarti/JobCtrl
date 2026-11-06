import { useMutation, useQueryClient } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  applicationDraftKey,
  useApplicationDraftStore,
} from "../stores/review-drafts.js";
import {
  performApplicationCommand,
  publishApplication,
} from "./useApplyReviewMutations.js";
import { applyKeys } from "../queryKeys.js";
import { readApplication } from "../readQueries.js";

export interface CancelApplyVariables {
  readonly jobId: string;
  readonly runId?: string;
}
export function useCancelApplyMutation() {
  const tenant = useTenantId();
  const { http, requestIdentity } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: async ({ jobId, runId }: CancelApplyVariables) => {
      const application = await readApplication(http, jobId);
      const knownRun =
        useApplicationDraftStore.getState().activeRuns[
          applicationDraftKey(tenant, jobId)
        ];
      if (runId && runId !== application.runId && runId !== knownRun)
        throw new Error(
          "Reload the application to identify its exact active run before cancelling.",
        );
      const stopped = await performApplicationCommand(http, tenant, jobId, {
        kind: "control",
        body: {
          action: "cancel",
          expectedVersion: application.version,
          idempotencyKey: requestIdentity.create(),
        },
      });
      if (stopped.application)
        publishApplication(client, tenant, stopped.application);
      const target = runId ?? knownRun ?? application.runId;
      if (target)
        await performApplicationCommand(http, tenant, jobId, {
          kind: "cancelRun",
          runId: target,
          idempotencyKey: requestIdentity.create(),
        });
      return stopped;
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: applyKeys.all(tenant) });
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
