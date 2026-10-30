import type { ActionRunResponse, RetryStageRequest, Stage } from "@jobctrl/contracts";
import {
  useMutation,
  useQueryClient,
  type Query,
  type QueryClient,
  type QueryKey,
  type UseMutationResult,
} from "@tanstack/react-query";

import { useTenantId } from "../../../shared/providers/TenantProvider.js";
import { usePorts } from "../../../shared/providers/PortsProvider.js";
import { useToastStore } from "../../../shared/stores/toasts.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import type { JobId } from "../../operations/types.js";
import { patchRetryStageState } from "../lib/jobDetailPatches.js";
import {
  detailMatchesRetryJob, observeRetryDetailConfirmation, retryStatusScope, type RetryConfirmationInFlight,
} from "../lib/retryStatusConfirmation.js";

export interface RetryStageVariables {
  readonly jobId: JobId;
  /** Identifier used by the mounted Job Detail query, when different from jobId. */
  readonly detailQueryId?: JobId;
  readonly stage: Stage;
  readonly resetAttempts?: boolean;
  readonly runAfter?: boolean;
  readonly dryRun?: boolean;
  readonly refreshApplyUrl?: boolean;
}

interface RetryPatchContext {
  readonly query?: Query;
  readonly revision?: number;
  readonly previous?: unknown;
  uncertaintyToastId?: string;
}

interface PendingRetryRead {
  readonly query: Query;
  noticeId?: string;
  subscribed: boolean;
}

// One pending read may be shared by several retry settlements. Group only the
// same tenant/job/locator and query instance; remove the group when it settles.
const pendingRetryReads = new WeakMap<Promise<unknown>, Map<string, PendingRetryRead>>();

function ownsRetryPatch(queryClient: QueryClient, queryKey: QueryKey, context: RetryPatchContext | undefined): boolean {
  return Boolean(context?.query &&
    queryClient.getQueryCache().find({ queryKey, exact: true }) === context.query &&
    context.query.state.dataUpdateCount === context.revision &&
    context.query.state.fetchStatus === "idle");
}

function invalidateOtherJobDetails(queryClient: QueryClient, tenantId: Parameters<typeof jobsKeys.details>[0],
  mountedKey: QueryKey, jobId: string, stageRetry: boolean): void {
  const candidates = queryClient.getQueryCache().findAll({ queryKey: jobsKeys.details(tenantId) });
  for (const query of candidates) {
    const detailQueryId = query.queryKey[mountedKey.length - 1];
    if (query.queryKey.length !== mountedKey.length ||
        typeof detailQueryId !== "string" || detailQueryId === mountedKey[mountedKey.length - 1]) continue;
    const pending = query.state.fetchStatus === "idle" ? undefined : query.promise;
    const scope = retryStatusScope(tenantId, jobId, detailQueryId);
    let group: PendingRetryRead | undefined;
    if (stageRetry && pending) {
      let groups = pendingRetryReads.get(pending);
      if (!groups) {
        groups = new Map();
        pendingRetryReads.set(pending, groups);
      }
      const existing = groups.get(scope);
      group = existing && existing.query === query ? existing : { query, subscribed: false };
      groups.set(scope, group);
    }
    let noticeId: string | undefined;
    const invalidate = (earlierReadSettled = false) => {
      if (queryClient.getQueryCache().find({ queryKey: query.queryKey, exact: true }) === query &&
          detailMatchesRetryJob(query.state.data, jobId)) {
        const existingId = group?.noticeId ?? noticeId;
        if (stageRetry && (!existingId || !useToastStore.getState().toasts.some((entry) => entry.id === existingId))) {
          const current = query.state.fetchStatus === "idle" ? undefined : query.promise;
          const eligible = earlierReadSettled && current && current !== pending ? { query, promise: current } : undefined;
          let createdId: string | undefined;
          createdId = reportUncertainRetry(queryClient, {}, tenantId, jobId, detailQueryId, eligible, () => {
            if (group && group.noticeId === createdId) delete group.noticeId;
          });
          noticeId = createdId;
          if (group) group.noticeId = createdId;
        }
        void queryClient.invalidateQueries({ queryKey: query.queryKey, exact: true }, { cancelRefetch: false });
      }
    };
    invalidate();
    // A pending first read has no identity yet. Recheck it after completion;
    // a populated read can also clear invalidation and must be marked again.
    // Retries that captured this same promise share one deferred recheck.
    if (pending && !group?.subscribed) {
      if (group) group.subscribed = true;
      const afterPending = () => Promise.resolve().then(() => {
        try {
          invalidate(true);
        } finally {
          const groups = pendingRetryReads.get(pending);
          if (group && groups?.get(scope) === group) {
            groups.delete(scope);
            if (groups.size === 0) pendingRetryReads.delete(pending);
          }
        }
      });
      void pending.then(afterPending, afterPending);
    }
  }
}

function reportUncertainRetry(queryClient: QueryClient, context: RetryPatchContext,
  tenantId: Parameters<typeof jobsKeys.detail>[0], jobId: string, detailQueryId: string,
  eligibleInFlight?: RetryConfirmationInFlight, onDismiss?: () => void): string {
  if (context.uncertaintyToastId) return context.uncertaintyToastId;
  context.uncertaintyToastId = useToastStore.getState().toast({
    variant: "warning",
    message: "The displayed stage status may be out of date after this retry. Refresh Job Detail to confirm the current state.",
    durationMs: 0,
    scope: retryStatusScope(tenantId, jobId, detailQueryId),
  });
  observeRetryDetailConfirmation(queryClient, jobsKeys.detail(tenantId, detailQueryId), context.uncertaintyToastId,
    jobId, eligibleInFlight, onDismiss);
  return context.uncertaintyToastId;
}

function toRequest(variables: RetryStageVariables): RetryStageRequest {
  return {
    stage: variables.stage,
    resetAttempts: variables.resetAttempts ?? false,
    runAfter: variables.runAfter ?? false,
    dryRun: variables.dryRun ?? false,
    ...(variables.refreshApplyUrl ? { refreshApplyUrl: true } : {}),
  };
}

export function useRetryStageMutation(): UseMutationResult<
  ActionRunResponse,
  Error,
  RetryStageVariables,
  RetryPatchContext
> {
  const tenantId = useTenantId();
  const { api } = usePorts();
  const queryClient = useQueryClient();
  return useMutation<ActionRunResponse, Error, RetryStageVariables, RetryPatchContext>({
    mutationFn: (variables) => api.retryStage(variables.jobId, toRequest(variables)),
    onMutate: async ({ jobId, detailQueryId, stage, runAfter, refreshApplyUrl }) => {
      if (refreshApplyUrl) return {};
      const queryKey = jobsKeys.detail(tenantId, detailQueryId ?? jobId);
      await queryClient.cancelQueries({ queryKey, exact: true });
      const query = queryClient.getQueryCache().find({ queryKey, exact: true });
      if (!query || query.state.data === undefined) return {};
      const previous = query.state.data;
      // The update count increments even if structural sharing retains the
      // same object. Later publications must fence this mutation's response.
      const revision = query.state.dataUpdateCount + 1;
      queryClient.setQueryData(queryKey, (current) =>
        patchRetryStageState(current, stage, runAfter ? "running" : "pending"),
      );
      return { query, revision, previous };
    },
    onError: (_error, { jobId, detailQueryId, refreshApplyUrl }, context) => {
      const queryKey = jobsKeys.detail(tenantId, detailQueryId ?? jobId);
      if (context && ownsRetryPatch(queryClient, queryKey, context)) {
        queryClient.setQueryData(queryKey, context.previous);
      } else if (context && !refreshApplyUrl) {
        reportUncertainRetry(queryClient, context, tenantId, jobId, detailQueryId ?? jobId);
      }
    },
    onSuccess: (data, variables, context) => {
      const acceptedStage = data.stage;
      const dispatchFailed = data.status === "failed" || data.status === "unsupported";
      const resetStage = !variables.refreshApplyUrl && acceptedStage?.stage === variables.stage
        ? acceptedStage
        : undefined;
      const queryKey = jobsKeys.detail(tenantId, variables.detailQueryId ?? variables.jobId);
      const ownsPatch = ownsRetryPatch(queryClient, queryKey, context);
      const resetResult = data.status === "reset" || dispatchFailed;
      if (resetStage && resetResult && ownsPatch) {
        queryClient.setQueryData(queryKey, (current) =>
          patchRetryStageState(current, variables.stage, resetStage.state),
        );
      }
      if (context && !variables.refreshApplyUrl &&
          (!ownsPatch || (resetResult && !resetStage) || (!resetResult && data.status !== "queued"))) {
        reportUncertainRetry(queryClient, context, tenantId, variables.jobId, variables.detailQueryId ?? variables.jobId);
      }
      if (dispatchFailed) {
        const summary = variables.refreshApplyUrl
          ? "The refresh could not start."
          : resetStage?.state === "pending"
            ? "The stage was reset, but the retry could not start."
            : "The retry could not start.";
        const reason = data.message?.trim();
        useToastStore.getState().toast({ variant: "error", message: reason ? `${summary} ${reason}` : summary });
      }
    },
    onSettled: (_data, _error, { jobId, detailQueryId, refreshApplyUrl }, context) => {
      const queryKey = jobsKeys.detail(tenantId, detailQueryId ?? jobId);
      if (context?.uncertaintyToastId) {
        void queryClient.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
      } else {
        void queryClient.invalidateQueries({ queryKey, exact: true });
      }
      invalidateOtherJobDetails(queryClient, tenantId, queryKey, jobId, !refreshApplyUrl);
      for (const queryKey of [jobsKeys.lists(tenantId), dashboardKeys.summary(tenantId)]) {
        void queryClient.invalidateQueries({ queryKey });
      }
    },
  });
}
