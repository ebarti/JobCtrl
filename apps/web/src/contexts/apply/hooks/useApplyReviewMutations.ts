import {
  useMutation,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";

import {
  createUnconfirmedWriteError,
  isUnconfirmedWrite,
} from "../../../shared/lib/unconfirmed-write.js";
import type { HttpPort } from "../../../shared/ports/HttpPort.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import {
  actionReceiptSchema,
  actionRunSchema,
  applicationResponseSchema,
  repeatApplicationSchema,
  type ActionReceipt,
  type Application,
  type ApplicationCommand,
  type ReviewApplication,
  type RepeatApplication,
} from "../contracts.js";
import { applyKeys } from "../queryKeys.js";
import {
  applicationDraftKey,
  useApplicationDraftStore,
} from "../stores/review-drafts.js";

export interface ApplicationCommandResult {
  readonly application?: Application;
  readonly run?: ActionReceipt;
  readonly repeat?: RepeatApplication;
}

export async function performApplicationCommand(
  http: HttpPort,
  tenantId: string,
  jobId: string,
  command: ApplicationCommand,
) {
  const key = applicationDraftKey(tenantId, jobId);
  if (
    command.kind === "execute" &&
    useApplicationDraftStore.getState().drafts[key]?.preparationEdited
  ) {
    throw new Error(
      "Prepare the pending application edits or discard them before executing the saved payload.",
    );
  }
  const unresolved = useApplicationDraftStore.getState().uncertain[key];
  if (unresolved && JSON.stringify(unresolved) !== JSON.stringify(command))
    throw new Error(
      "Reconcile the unconfirmed request before making another application change.",
    );
  try {
    const result = await writeApplication(http, jobId, command);
    useApplicationDraftStore.getState().setUncertain(key, undefined);
    if (command.kind === "prepare") {
      const draft = useApplicationDraftStore.getState().drafts[key];
      if (
        draft &&
        draft.mode === command.body.mode &&
        (command.body.mode === "browser" ||
          (draft.recipient === command.body.recipient &&
            draft.subject === command.body.subject &&
            draft.body === command.body.body))
      ) {
        useApplicationDraftStore.getState().edit(key, {
          preparationEdited: false,
          reviewedHash: "",
          rehearsalId: "",
          partialOverrideRunId: "",
        });
      }
    }
    if (result.run)
      useApplicationDraftStore.getState().setActiveRun(key, result.run.runId);
    return result;
  } catch (error) {
    if (isUnconfirmedWrite(error))
      useApplicationDraftStore.getState().setUncertain(key, command);
    else if (unresolved)
      useApplicationDraftStore.getState().setUncertain(key, undefined);
    throw error;
  }
}

export function publishApplication(
  client: QueryClient,
  tenantId: string,
  application: Application,
) {
  client.setQueryData<Application>(
    applyKeys.application(tenantId, application.jobId),
    (current) =>
      current && current.version > application.version ? current : application,
  );
  client.setQueryData<Application[]>(applyKeys.queue(tenantId), (current) =>
    current?.map((item) =>
      item.jobId === application.jobId && item.version <= application.version
        ? application
        : item,
    ),
  );
}

export async function writeApplication(
  http: HttpPort,
  jobId: string,
  command: ApplicationCommand,
): Promise<ApplicationCommandResult> {
  if (command.kind === "repeat_override") {
    const path = `/v1/jobs/${encodeURIComponent(jobId)}/repeat-application/override`;
    const parsed = repeatApplicationSchema.safeParse(
      await http.json<unknown>("POST", path, {
        body: command.body,
        idempotencyKey: command.body.idempotencyKey,
      }),
    );
    if (!parsed.success || parsed.data.jobId !== jobId)
      throw createUnconfirmedWriteError(
        "POST",
        path,
        new Error("The repeat override response is invalid."),
      );
    return { repeat: parsed.data };
  }
  if (
    command.kind === "prepare" ||
    command.kind === "review" ||
    command.kind === "control"
  ) {
    const suffix =
      command.kind === "review"
        ? "apply-review"
        : `application/${command.kind === "prepare" ? "preparation" : "control"}`;
    const path = `/v1/jobs/${encodeURIComponent(jobId)}/${suffix}`;
    const parsed = applicationResponseSchema.safeParse(
      await http.json<unknown>("POST", path, {
        body: command.body,
        idempotencyKey: command.body.idempotencyKey,
      }),
    );
    if (!parsed.success || parsed.data.application.jobId !== jobId)
      throw createUnconfirmedWriteError(
        "POST",
        path,
        new Error("The saved application response is invalid."),
      );
    return { application: parsed.data.application };
  }
  if (command.kind === "cancelRun") {
    const path = `/v1/action-runs/${encodeURIComponent(command.runId)}/cancel`;
    const parsed = actionRunSchema.safeParse(
      await http.json<unknown>("POST", path, {
        body: {},
        idempotencyKey: command.idempotencyKey,
      }),
    );
    if (
      !parsed.success ||
      parsed.data.runId !== command.runId ||
      !parsed.data.action.startsWith("applications.")
    )
      throw createUnconfirmedWriteError(
        "POST",
        path,
        new Error("The cancellation response is invalid."),
      );
    return { run: parsed.data };
  }
  const path = `/v1/actions/applications.${command.kind}`;
  const body =
    command.kind === "execute"
      ? { jobId, payloadId: command.payloadId, approvalId: command.approvalId }
      : command.kind === "repeat_check"
        ? { jobId }
        : { jobId, payloadId: command.payloadId };
  const parsed = actionReceiptSchema.safeParse(
    await http.json<unknown>("POST", path, {
      body,
      idempotencyKey: command.idempotencyKey,
    }),
  );
  if (!parsed.success)
    throw createUnconfirmedWriteError(
      "POST",
      path,
      new Error("The durable action receipt is invalid."),
    );
  return { run: parsed.data };
}

export function useApplicationCommands(jobId: string) {
  const tenant = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  const key = applicationDraftKey(tenant, jobId);
  const uncertain = useApplicationDraftStore((state) => state.uncertain[key]);
  const mutation = useMutation({
    scope: { id: `application:${key}` },
    mutationFn: (command: ApplicationCommand) =>
      performApplicationCommand(http, tenant, jobId, command),
    onSuccess: (result) => {
      useApplicationDraftStore.getState().setUncertain(key, undefined);
      if (result.application)
        publishApplication(client, tenant, result.application);
      if (result.repeat)
        client.setQueryData(applyKeys.repeat(tenant, jobId), result.repeat);
      if (result.run)
        useApplicationDraftStore.getState().setActiveRun(key, result.run.runId);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: applyKeys.all(tenant) });
    },
    meta: { suppressGlobalErrorToast: true },
  });
  return { ...mutation, uncertain };
}

export function useApplyReviewDecisionMutation() {
  const tenant = useTenantId();
  const { http } = usePorts();
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, body }: { jobId: string; body: ReviewApplication }) =>
      performApplicationCommand(http, tenant, jobId, { kind: "review", body }),
    onSuccess: ({ application }) => {
      if (application) publishApplication(client, tenant, application);
    },
    onSettled: () => {
      void client.invalidateQueries({ queryKey: applyKeys.all(tenant) });
    },
    meta: { suppressGlobalErrorToast: true },
  });
}
