import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import type {
  Application,
  ApplicationCommand,
  ApplicationPayload,
  ReviewApplication,
} from "../contracts.js";
import { applyKeys } from "../queryKeys.js";
import {
  useApplicationActionRun,
  useApplicationQuery,
  useRepeatApplicationQuery,
} from "../readQueries.js";
import {
  applicationDraftKey,
  EMPTY_APPLICATION_DRAFT,
  useApplicationDraftStore,
} from "../stores/review-drafts.js";
import { useApplicationCommands } from "./useApplyReviewMutations.js";

export function payloadApproval(application: Application) {
  const payload = application.payload;
  const approval = application.latestDecision;
  return application.approvalCurrent &&
    application.canExecute &&
    payload &&
    approval?.decision === "approve_submit" &&
    approval.payloadId === payload.payloadId &&
    approval.payloadSha256 === payload.payloadSha256 &&
    !application.stopped &&
    !application.intent &&
    !application.receipt &&
    application.status !== "needs_verification"
    ? approval
    : null;
}
export function matchingRehearsals(
  application: Application,
  payload: ApplicationPayload,
) {
  return application.rehearsals.filter(
    (run) =>
      run.status === "completed" &&
      run.payloadId === payload.payloadId &&
      run.payloadSha256 === payload.payloadSha256,
  );
}

export function useApplyReviewSession(jobId: string) {
  const tenant = useTenantId();
  const { requestIdentity } = usePorts();
  const client = useQueryClient();
  const key = applicationDraftKey(tenant, jobId);
  const query = useApplicationQuery(jobId);
  const repeatQuery = useRepeatApplicationQuery(jobId);
  const draft = useApplicationDraftStore(
    (state) => state.drafts[key] ?? EMPTY_APPLICATION_DRAFT,
  );
  const editDraft = useApplicationDraftStore((state) => state.edit);
  const lastRunId = useApplicationDraftStore((state) => state.activeRuns[key]);
  const mutation = useApplicationCommands(jobId);
  const application = query.data;
  const actionRun = useApplicationActionRun(
    lastRunId ?? application?.runId ?? null,
  );
  useEffect(() => {
    if (
      actionRun.data &&
      ["succeeded", "failed", "cancelled"].includes(actionRun.data.status)
    ) {
      void client.invalidateQueries({
        queryKey: applyKeys.application(tenant, jobId),
      });
      void client.invalidateQueries({ queryKey: applyKeys.queue(tenant) });
    }
  }, [actionRun.data?.status, actionRun.data?.runId, client, tenant, jobId]);
  const payload = application?.payload ?? null;
  const rehearsals =
    application && payload ? matchingRehearsals(application, payload) : [];
  const rehearsal =
    rehearsals.find((run) => run.rehearsalId === draft.rehearsalId) ??
    rehearsals.at(-1) ??
    null;
  const inspectionAllowsApproval =
    payload?.mode !== "browser" ||
    rehearsal?.inspection?.status === "ready" ||
    rehearsal?.inspection?.status === "manual";
  const approval = application ? payloadApproval(application) : null;
  const active = Boolean(
    (lastRunId && actionRun.isPending) ||
    (actionRun.data &&
      ["pending", "queued", "running"].includes(actionRun.data.status)),
  );
  const blocked =
    !application ||
    query.isError ||
    actionRun.isError ||
    mutation.isPending ||
    !!mutation.uncertain ||
    active;
  const externallyBound = Boolean(
    application?.intent ||
    application?.receipt ||
    application?.confirmedApplication ||
    application?.status === "needs_verification",
  );
  const repeatBlocked =
    !repeatQuery.data || repeatQuery.isError || !!repeatQuery.data.blockReason;
  async function command(value: ApplicationCommand) {
    try {
      return await mutation.mutateAsync(value);
    } catch {
      return undefined; /* Keep private edits and authoritative history visible. */
    }
  }
  const edit = (changes: Partial<typeof draft>) => editDraft(key, changes);
  function decide(decision: ReviewApplication["decision"]) {
    if (!application) return;
    void command({
      kind: "review",
      body: {
        expectedVersion: application.version,
        idempotencyKey: requestIdentity.create(),
        decision,
        ...(draft.reason ? { reason: draft.reason } : {}),
        ...((decision === "approve_submit" || decision === "approve_dry_run") &&
        payload
          ? {
              payloadId: payload.payloadId,
              payloadSha256: payload.payloadSha256,
            }
          : {}),
        ...(decision === "approve_submit" && payload && rehearsal
          ? {
              rehearsalId: rehearsal.rehearsalId,
              ...(rehearsal.coverage !== "full"
                ? { partialOverrideRunId: draft.partialOverrideRunId }
                : {}),
            }
          : {}),
      },
    });
  }
  return {
    jobId,
    query,
    repeatQuery,
    repeatBlocked,
    application,
    payload,
    mutation,
    actionRun,
    draft,
    edit,
    rehearsals,
    rehearsal,
    approval,
    blocked,
    externallyBound,
    active,
    approveRehearsalDisabled:
      blocked ||
      externallyBound ||
      !!application?.approvalBlockReason ||
      draft.preparationEdited ||
      !!application?.stopped ||
      !payload ||
      draft.reviewedHash !== payload.payloadSha256,
    approveDisabled:
      blocked ||
      externallyBound ||
      repeatBlocked ||
      !inspectionAllowsApproval ||
      !!application?.approvalBlockReason ||
      draft.preparationEdited ||
      !!application?.stopped ||
      !payload ||
      !rehearsal ||
      draft.reviewedHash !== payload.payloadSha256 ||
      (rehearsal.coverage !== "full" &&
        draft.partialOverrideRunId !== rehearsal.rehearsalId),
    decide,
    command,
    control: (action: "skip" | "cancel" | "reset") => {
      if (application)
        void command({
          kind: "control",
          body: {
            action,
            expectedVersion: application.version,
            idempotencyKey: requestIdentity.create(),
          },
        });
    },
    rehearse: () => {
      if (payload)
        void command({
          kind: "rehearse",
          payloadId: payload.payloadId,
          idempotencyKey: requestIdentity.create(),
        });
    },
    execute: () => {
      if (payload && approval)
        void command({
          kind: "execute",
          payloadId: payload.payloadId,
          approvalId: approval.decisionId,
          idempotencyKey: requestIdentity.create(),
        });
    },
    cancelRun: () => {
      const runId = actionRun.data?.runId;
      if (runId)
        void command({
          kind: "cancelRun",
          runId,
          idempotencyKey: requestIdentity.create(),
        });
    },
  };
}
export type ApplyReviewSession = ReturnType<typeof useApplyReviewSession>;
