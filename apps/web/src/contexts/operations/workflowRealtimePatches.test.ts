import {
  LOCAL_TENANT,
  createWorkflowCanceled,
  createWorkflowCompleted,
  createWorkflowFailed,
  createWorkflowStarted,
  type TenantId,
} from "@jobctrl/domain-types";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  makeWorkflowRunDetail,
  makeWorkflowRunsPage,
  sampleDashboardSummary,
  sampleWorkflowRun,
} from "../../test/fixtures/projections.js";
import { dashboardKeys } from "./dashboardKeys.js";
import { invalidationRouter } from "./invalidation-router.js";
import {
  patchWorkflowRunDetail,
} from "./realtimePatches.js";
import { workflowRunsKeys } from "./workflowRunsKeys.js";

const NOW = "2026-08-01T15:00:00Z";
const OTHER_TENANT = "other" as TenantId;

describe("workflow realtime cache patches", () => {
  it("terminalizes an open run detail and appends one inspectable timeline event", () => {
    const current = makeWorkflowRunDetail({
      workflowId: "run-1",
      runId: "run-1",
      status: "in_progress",
      finishedAt: null,
      durationMs: null,
      errorCode: "old_error",
      errorMessage: "old message",
      retryable: true,
      events: [],
    });
    const event = createWorkflowCompleted(LOCAL_TENANT, {
      workflowId: "run-1",
      workflowType: "JobPipelineWorkflow",
      status: "succeeded",
      finishedAt: NOW,
      durationMs: 42_000,
      temporalRunId: "temporal-run-1",
    });

    const wireEvent = {
      eventType: event.eventType,
      tenantId: event.tenantId,
      payload: event.payload,
    } as typeof event;
    const patched = patchWorkflowRunDetail(current, wireEvent) as typeof current;
    expect(patched).toMatchObject({
      status: "succeeded",
      finishedAt: NOW,
      durationMs: 42_000,
      errorCode: null,
      errorMessage: null,
      retryable: false,
    });
    expect(patched.events).toEqual([
      {
        eventType: "WorkflowCompleted",
        occurredAt: NOW,
        status: "succeeded",
        message: null,
      },
    ]);
    const replayed = patchWorkflowRunDetail(patched, wireEvent) as typeof patched;
    expect(replayed.events).toHaveLength(1);
  });

  it("keeps the first terminal result when a later terminal event races it", () => {
    const current = makeWorkflowRunDetail({
      status: "succeeded",
      finishedAt: NOW,
      durationMs: 10_000,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      events: [],
    });
    const lateFailure = createWorkflowFailed(LOCAL_TENANT, {
      workflowId: current.workflowId,
      workflowType: current.workflowType,
      status: "failed",
      errorCode: "late_failure",
      errorMessage: "late failure must not replace success",
      retryable: true,
      finishedAt: "2026-08-01T15:01:00Z",
      durationMs: 11_000,
      temporalRunId: current.temporalRunId,
    });

    const patched = patchWorkflowRunDetail(current, lateFailure) as typeof current;
    expect(patched).toMatchObject({
      status: "succeeded",
      finishedAt: NOW,
      durationMs: 10_000,
      errorCode: null,
      errorMessage: null,
      retryable: false,
    });
    expect(patched.events.at(-1)?.eventType).toBe("WorkflowFailed");
  });

  it("does not patch state for a missing or superseded Temporal execution id", () => {
    const current = makeWorkflowRunDetail({
      status: "in_progress",
      temporalRunId: "temporal-current",
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      events: [],
    });
    const missingIdentity = createWorkflowFailed(LOCAL_TENANT, {
      workflowId: current.workflowId,
      workflowType: current.workflowType,
      status: "failed",
      errorCode: "missing_identity",
      errorMessage: "identity unavailable",
      retryable: true,
      finishedAt: NOW,
      durationMs: 5_000,
      temporalRunId: null,
    });
    const superseded = createWorkflowFailed(LOCAL_TENANT, {
      ...missingIdentity.payload,
      errorCode: "late_old_run",
      temporalRunId: "temporal-old",
    });

    const afterMissing = patchWorkflowRunDetail(current, missingIdentity) as typeof current;
    const afterSuperseded = patchWorkflowRunDetail(current, superseded) as typeof current;
    const unidentifiedCurrent = patchWorkflowRunDetail(
      { ...current, temporalRunId: null },
      superseded,
    ) as typeof current;
    for (const patched of [afterMissing, afterSuperseded, unidentifiedCurrent]) {
      expect(patched).toMatchObject({
        status: "in_progress",
        finishedAt: null,
        durationMs: null,
        errorCode: null,
        errorMessage: null,
        retryable: false,
      });
      expect(patched.events).toHaveLength(1);
    }
    expect(afterMissing.temporalRunId).toBe("temporal-current");
    expect(afterSuperseded.temporalRunId).toBe("temporal-current");
    expect(unidentifiedCurrent.temporalRunId).toBeNull();
  });

  it("reopens recovered workflow state without retaining terminal failure fields", () => {
    const current = makeWorkflowRunDetail({
      status: "terminated",
      errorCode: "reconciled_not_found",
      errorMessage: "history temporarily unavailable",
      retryable: false,
    });
    const event = createWorkflowStarted(LOCAL_TENANT, {
      workflowId: current.workflowId,
      workflowType: current.workflowType,
      status: "in_progress",
      inputSummary: { stages: ["discover", "score"] },
      startedAt: NOW,
      temporalRunId: "temporal-recovered",
      recoveredFromMissingHistory: true,
    });

    const patched = patchWorkflowRunDetail(current, event) as typeof current;
    expect(patched).toMatchObject({
      status: "in_progress",
      inputSummary: { stages: ["discover", "score"] },
      startedAt: NOW,
      finishedAt: null,
      durationMs: null,
      errorCode: null,
      errorMessage: null,
      retryable: false,
      temporalRunId: "temporal-recovered",
    });
  });

  it("patches exact tenant details while preserving filtered run-list context", () => {
    const queryClient = new QueryClient();
    const workflowId = sampleWorkflowRun.workflowId;
    const listKey = workflowRunsKeys.list(LOCAL_TENANT, {
      page: 3,
      status: "in_progress",
      sort: "started_at",
      dir: "desc",
    });
    const listBefore = makeWorkflowRunsPage([sampleWorkflowRun]);
    const detailBefore = makeWorkflowRunDetail({
      workflowId,
      runId: workflowId,
      workflowType: sampleWorkflowRun.workflowType,
      status: "in_progress",
      errorCode: null,
      errorMessage: null,
      retryable: false,
      temporalRunId: "temporal-apply-run-1",
      finishedAt: null,
      durationMs: null,
      events: [],
    });
    const dashboardBefore = {
      ...sampleDashboardSummary,
      applyRuns: sampleDashboardSummary.applyRuns.map((run, index) =>
        index === 0 ? { ...run, runId: workflowId, status: "in_progress" } : run,
      ),
    };
    queryClient.setQueryData(listKey, listBefore);
    queryClient.setQueryData(
      workflowRunsKeys.detail(LOCAL_TENANT, workflowId),
      detailBefore,
    );
    queryClient.setQueryData(
      workflowRunsKeys.detail(OTHER_TENANT, workflowId),
      detailBefore,
    );
    queryClient.setQueryData(dashboardKeys.summary(LOCAL_TENANT), dashboardBefore);

    const event = createWorkflowCanceled(LOCAL_TENANT, {
      workflowId,
      workflowType: "ApplyWorkflow",
      status: "canceled",
      errorCode: "",
      errorMessage: "",
      finishedAt: NOW,
      durationMs: 7_000,
      temporalRunId: "temporal-apply-run-1",
    });
    invalidationRouter.handle(event, queryClient);

    expect(queryClient.getQueryData(listKey)).toBe(listBefore);
    expect(queryClient.getQueryState(listKey)?.isInvalidated).toBe(true);
    expect(
      queryClient.getQueryData<ReturnType<typeof makeWorkflowRunDetail>>(
        workflowRunsKeys.detail(LOCAL_TENANT, workflowId),
      )?.status,
    ).toBe("canceled");
    expect(
      queryClient.getQueryData<ReturnType<typeof makeWorkflowRunDetail>>(
        workflowRunsKeys.detail(OTHER_TENANT, workflowId),
      )?.status,
    ).toBe("in_progress");
    expect(queryClient.getQueryData(dashboardKeys.summary(LOCAL_TENANT))).toBe(
      dashboardBefore,
    );
    expect(
      queryClient.getQueryState(dashboardKeys.summary(LOCAL_TENANT))?.isInvalidated,
    ).toBe(true);
  });
});
