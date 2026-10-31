import { createTenantId, LOCAL_TENANT } from "@jobctrl/domain-types";
import { useQuery } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { useToastStore } from "../../../shared/stores/toasts.js";
import { server } from "../../../test/msw/server.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { retryStatusScope } from "../lib/retryStatusConfirmation.js";
import { useRetryStageMutation } from "./useRetryStageMutation.js";

const initialDetail = {
  ok: true,
  job: { jobKey: "job-1", currentSubstage: "score", currentState: "failed" },
  stages: [{ stage: "score", state: "failed" }, { stage: "tailor", state: "failed" }],
  artifacts: [],
};

describe("useRetryStageMutation", () => {
  afterEach(() => act(() => useToastStore.getState().clear()));

  it("optimistically marks the stage as running, settles on success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1", stage: "tailor", runAfter: true });
      await Promise.resolve();
    });
    const optimistic = queryClient.getQueryData<{
      stages: Array<{ stage: string; state: string }>;
    }>(jobsKeys.detail(LOCAL_TENANT, "job-1"));
    expect(optimistic?.stages.find((s) => s.stage === "tailor")?.state).toBe("running");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("marks a reset-only stage pending instead of running", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1", stage: "tailor" });
      await Promise.resolve();
    });
    const optimistic = queryClient.getQueryData<{
      stages: Array<{ stage: string; state: string }>;
    }>(jobsKeys.detail(LOCAL_TENANT, "job-1"));
    expect(optimistic?.stages.find((s) => s.stage === "tailor")?.state).toBe("pending");
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toMatchObject({
      job: { currentSubstage: "score", currentState: "failed" },
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it.each([false, true])("rolls back the optimistic state on failure with runAfter=%s", async (runAfter) => {
    let releaseResponse!: () => void;
    const responseHeld = new Promise<void>((resolve) => { releaseResponse = resolve; });
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", async () => {
        await responseHeld;
        return new HttpResponse(JSON.stringify({ ok: false }), { status: 500 });
      }),
    );
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    const currentDetail = {
      ...initialDetail,
      job: { ...initialDetail.job, currentSubstage: "tailor" },
    };
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), currentDetail);

    try {
      await act(async () => {
        result.current.mutate({ jobId: "job-1", stage: "tailor", runAfter });
      });
      await waitFor(() => expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toMatchObject({
        job: { currentState: runAfter ? "running" : "pending" },
      }));
      releaseResponse();
      await waitFor(() => expect(result.current.isError).toBe(true));
      expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(currentDetail);
    } finally {
      releaseResponse();
    }
  });

  it("reports an apply URL refresh failure without claiming a stage reset", async () => {
    server.use(http.post("*/v1/jobs/:jobKey/actions/retry-stage", () => HttpResponse.json({
      ok: true, action: "retry_stage", status: "failed", message: "Synthetic refresh failure.",
    })));
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      await result.current.mutateAsync({ jobId: "job-1", stage: "enrich", runAfter: true, refreshApplyUrl: true });
    });
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(initialDetail);
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({
      variant: "error", message: "The refresh could not start. Synthetic refresh failure.",
    })]);
  });

  it("keeps an alternate detail stale after an earlier in-flight read completes", async () => {
    server.use(http.post("*/v1/jobs/:jobKey/actions/retry-stage", () => HttpResponse.json({
      ok: true, action: "retry_stage", status: "reset", stage: { stage: "tailor", state: "pending" },
    })));
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    const mountedKey = jobsKeys.detail(LOCAL_TENANT, "https://example.com/jobs/alias");
    const alternateKey = jobsKeys.detail(LOCAL_TENANT, "job-1");
    queryClient.setQueryData(mountedKey, initialDetail);
    queryClient.setQueryData(alternateKey, initialDetail);
    let releaseRead!: () => void;
    const readHeld = new Promise<void>((resolve) => { releaseRead = resolve; });
    const newer = { ...initialDetail, job: { ...initialDetail.job, currentState: "running" } };
    const read = queryClient.fetchQuery({ queryKey: alternateKey, staleTime: 0, queryFn: async () => {
      await readHeld;
      return newer;
    } });
    try {
      await waitFor(() => expect(queryClient.getQueryState(alternateKey)?.fetchStatus).toBe("fetching"));
      await act(async () => {
        await result.current.mutateAsync({ jobId: "job-1", detailQueryId: "https://example.com/jobs/alias", stage: "tailor" });
      });
      expect(queryClient.getQueryState(alternateKey)?.isInvalidated).toBe(true);
      expect(queryClient.getQueryData(alternateKey)).toBe(initialDetail);
      releaseRead();
      await read;
      await waitFor(() => expect(queryClient.getQueryState(alternateKey)?.isInvalidated).toBe(true));
      expect(queryClient.getQueryData(alternateKey)).toEqual(newer);
    } finally {
      releaseRead();
      await read.catch(() => {});
    }
  });

  it("refetches an active alternate after its earlier in-flight read completes", async () => {
    server.use(http.post("*/v1/jobs/:jobKey/actions/retry-stage", () => HttpResponse.json({
      ok: true, action: "retry_stage", status: "reset", stage: { stage: "tailor", state: "pending" },
    })));
    const queryClient = createTestQueryClient();
    const mountedKey = jobsKeys.detail(LOCAL_TENANT, "https://example.com/jobs/alias");
    const alternateKey = jobsKeys.detail(LOCAL_TENANT, "job-1");
    queryClient.setQueryData(mountedKey, initialDetail);
    queryClient.setQueryData(alternateKey, initialDetail);
    let releaseOldRead!: () => void;
    const oldReadHeld = new Promise<void>((resolve) => { releaseOldRead = resolve; });
    let reads = 0;
    const newer = { ...initialDetail, job: { ...initialDetail.job, currentState: "running" } };
    const observer = renderHookWithProviders(() => useQuery({ queryKey: alternateKey, staleTime: Infinity,
      queryFn: async () => {
        const read = ++reads;
        if (read === 1) await oldReadHeld;
        return read === 1 ? initialDetail : newer;
      } }), { queryClient });
    const { result } = renderHookWithProviders(() => useRetryStageMutation(), { queryClient });
    let firstRead: Promise<void> | undefined;
    try {
      firstRead = queryClient.invalidateQueries({ queryKey: alternateKey, exact: true });
      await waitFor(() => expect(reads).toBe(1));
      await act(async () => {
        await result.current.mutateAsync({ jobId: "job-1", detailQueryId: "https://example.com/jobs/alias", stage: "tailor" });
      });
      expect(queryClient.getQueryData(alternateKey)).toBe(initialDetail);
      releaseOldRead();
      await firstRead;
      await waitFor(() => expect(reads).toBe(2));
      await waitFor(() => expect(queryClient.getQueryData(alternateKey)).toEqual(newer));
    } finally {
      releaseOldRead();
      await firstRead?.catch(() => {});
      observer.unmount();
    }
  });

  it("releases a shared pending-read notice when dismissed and after confirmation", async () => {
    server.use(http.post("*/v1/jobs/:jobKey/actions/retry-stage", () => HttpResponse.json({
      ok: true, action: "retry_stage", status: "reset", stage: { stage: "tailor", state: "pending" },
    })));
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    const mountedId = "https://example.com/jobs/dismissed-notice";
    const alternateId = "job-1";
    const mountedKey = jobsKeys.detail(LOCAL_TENANT, mountedId);
    const alternateKey = jobsKeys.detail(LOCAL_TENANT, alternateId);
    const scope = retryStatusScope(LOCAL_TENANT, "job-1", alternateId);
    const notices = () => useToastStore.getState().toasts.filter((entry) => entry.scope === scope);
    queryClient.setQueryData(mountedKey, initialDetail);
    queryClient.setQueryData(alternateKey, initialDetail);
    let releaseRead!: () => void;
    const held = new Promise<void>((resolve) => { releaseRead = resolve; });
    const read = queryClient.fetchQuery({ queryKey: alternateKey, staleTime: 0, queryFn: async () => {
      await held;
      return initialDetail;
    } });
    try {
      await waitFor(() => expect(queryClient.getQueryState(alternateKey)?.fetchStatus).toBe("fetching"));
      await act(async () => {
        await result.current.mutateAsync({ jobId: "job-1", detailQueryId: mountedId, stage: "tailor" });
        await result.current.mutateAsync({ jobId: "job-1", detailQueryId: mountedId, stage: "tailor" });
      });
      expect(notices()).toHaveLength(1);
      const firstId = notices()[0]!.id;
      act(() => useToastStore.getState().clear());
      await act(async () => {
        await result.current.mutateAsync({ jobId: "job-1", detailQueryId: mountedId, stage: "tailor" });
      });
      expect(notices()).toHaveLength(1);
      expect(notices()[0]!.id).not.toBe(firstId);
      releaseRead();
      await read;
      await waitFor(() => expect(queryClient.getQueryState(alternateKey)?.isInvalidated).toBe(true));
      await queryClient.fetchQuery({ queryKey: alternateKey, staleTime: 0, queryFn: async () => initialDetail });
      expect(notices()).toHaveLength(0);
    } finally {
      releaseRead();
      await read.catch(() => {});
    }
  });

  it("accepts a replacement read started after settlement but before its deferred notice", async () => {
    server.use(http.post("*/v1/jobs/:jobKey/actions/retry-stage", () => HttpResponse.json({
      ok: true, action: "retry_stage", status: "reset", stage: { stage: "tailor", state: "pending" },
    })));
    const queryClient = createTestQueryClient();
    const mountedId = "https://example.com/jobs/reentrant-confirmation";
    const alternateId = "job-1";
    const alternateKey = jobsKeys.detail(LOCAL_TENANT, alternateId);
    const scope = retryStatusScope(LOCAL_TENANT, "job-1", alternateId);
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, mountedId), initialDetail);
    let releaseOldRead!: () => void;
    let releaseLaterRead!: () => void;
    const oldHeld = new Promise<void>((resolve) => { releaseOldRead = resolve; });
    const laterHeld = new Promise<void>((resolve) => { releaseLaterRead = resolve; });
    let reads = 0;
    const observer = renderHookWithProviders(() => useQuery({ queryKey: alternateKey, queryFn: async () => {
      const read = ++reads;
      if (read === 1) await oldHeld;
      else await laterHeld;
      return initialDetail;
    } }), { queryClient });
    const { result } = renderHookWithProviders(() => useRetryStageMutation(), { queryClient });
    let startedReplacement = false;
    const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
      if (event.type !== "updated" || event.action.type !== "success" || event.action.manual || startedReplacement ||
          queryClient.getQueryCache().find({ queryKey: alternateKey, exact: true }) !== event.query) return;
      startedReplacement = true;
      void queryClient.invalidateQueries({ queryKey: alternateKey, exact: true }, { cancelRefetch: false });
    });
    try {
      await waitFor(() => expect(reads).toBe(1));
      await act(async () => {
        await result.current.mutateAsync({ jobId: "job-1", detailQueryId: mountedId, stage: "tailor" });
      });
      expect(queryClient.getQueryData(alternateKey)).toBeUndefined();
      releaseOldRead();
      await waitFor(() => expect(reads).toBe(2));
      await waitFor(() => expect(useToastStore.getState().toasts).toContainEqual(expect.objectContaining({ scope })));
      releaseLaterRead();
      await waitFor(() => expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({ scope })));
    } finally {
      releaseOldRead();
      releaseLaterRead();
      unsubscribe();
      observer.unmount();
    }
  });

  it.each(["different-job", "recreated-query", "other-tenant"] as const)(
    "does not claim an initially empty alternate without matching identity and query ownership (%s)",
    async (scenario) => {
      server.use(http.post("*/v1/jobs/:jobKey/actions/retry-stage", () => HttpResponse.json({
        ok: true, action: "retry_stage", status: "reset", stage: { stage: "tailor", state: "pending" },
      })));
      const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
      const mountedId = "https://example.com/jobs/mounted";
      const alternateId = "https://example.com/jobs/other-locator";
      const tenant = scenario === "other-tenant" ? createTenantId("synthetic-other-tenant") : LOCAL_TENANT;
      const mountedKey = jobsKeys.detail(LOCAL_TENANT, mountedId);
      const alternateKey = jobsKeys.detail(tenant, alternateId);
      queryClient.setQueryData(mountedKey, initialDetail);
      const returned = scenario === "different-job"
        ? { ...initialDetail, job: { ...initialDetail.job, jobKey: "unrelated-job" } }
        : initialDetail;
      let releaseRead!: () => void;
      const held = new Promise<void>((resolve) => { releaseRead = resolve; });
      const read = queryClient.fetchQuery({ queryKey: alternateKey, queryFn: async () => {
        await held;
        return returned;
      } });
      const settledRead = read.catch(() => undefined);
      try {
        await waitFor(() => expect(queryClient.getQueryState(alternateKey)?.fetchStatus).toBe("fetching"));
        expect(queryClient.getQueryData(alternateKey)).toBeUndefined();
        await act(async () => {
          await result.current.mutateAsync({ jobId: "job-1", detailQueryId: mountedId, stage: "tailor" });
        });
        if (scenario === "recreated-query") {
          queryClient.removeQueries({ queryKey: alternateKey, exact: true });
          queryClient.setQueryData(alternateKey, initialDetail);
        }
        await act(async () => {
          releaseRead();
          await settledRead;
          await Promise.resolve();
          await Promise.resolve();
        });
        expect(queryClient.getQueryData(alternateKey)).toEqual(scenario === "recreated-query" ? initialDetail : returned);
        expect(queryClient.getQueryState(alternateKey)?.isInvalidated).toBe(false);
        expect(useToastStore.getState().toasts).not.toContainEqual(expect.objectContaining({
          scope: retryStatusScope(LOCAL_TENANT, "job-1", alternateId),
        }));
      } finally {
        releaseRead();
        await settledRead;
      }
    },
  );
  it("rolls back a stale single-stage retry and exposes the actionable conflict", async () => {
    const message = "A selected job or its retry stage changed or is no longer eligible. Refresh the jobs list and review the selection, then retry.";
    server.use(http.post("*/v1/jobs/:jobKey/actions/retry-stage", () => HttpResponse.json({
      ok: false, error: "retry_selection_changed", message,
    }, { status: 409 })));
    const queryClient = createTestQueryClient();
    const { result, unmount } = renderHookWithProviders(() => useRetryStageMutation(), { queryClient });
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);
    await act(async () => {
      await expect(result.current.mutateAsync({ jobId: "job-1", stage: "tailor", runAfter: true }))
        .rejects.toMatchObject({ status: 409, message, writeOutcomeUnknown: false });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(initialDetail);
    expect(useToastStore.getState().toasts).toEqual([expect.objectContaining({ variant: "error", message })]);
    unmount();
    queryClient.clear();
  });

  it("shows the re-tailor outcome and settles the optimistic stage to pending", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", () => HttpResponse.json({
        ok: true, runId: "reset-1", actionId: "reset-1", action: "retry_stage", jobKey: "job-1",
        command: { action: "retry_stage", jobKey: "job-1" }, status: "reset",
        message: "Approved materials remain available. Use explicit re-tailor to create a replacement.",
        stage: { stage: "tailor", state: "pending" },
      })),
    );
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      await result.current.mutateAsync({ jobId: "job-1", stage: "tailor", runAfter: true });
    });
    expect(queryClient.getQueryData<typeof initialDetail>(jobsKeys.detail(LOCAL_TENANT, "job-1"))?.stages.find((stage) => stage.stage === "tailor")?.state)
      .toBe("pending");
    expect(queryClient.getQueryData<typeof initialDetail>(jobsKeys.detail(LOCAL_TENANT, "job-1"))?.stages.find((stage) => stage.stage === "score")?.state)
      .toBe("failed");
    expect(useToastStore.getState().toasts).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("explicit re-tailor") }),
    ]));
  });
});

it("keeps uncertain Apply visible when reset is refused", async () => {
  server.use(http.post("*/v1/jobs/:jobKey/actions/retry-stage", () =>
    new HttpResponse(JSON.stringify({ ok: false, error: "submission_intent_recorded" }), { status: 400 })));
  const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
  const detail = { ...initialDetail, stages: [{ stage: "apply", state: "needs_verification" }] };
  queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), detail);
  await act(async () => { result.current.mutate({ jobId: "job-1", stage: "apply" }); });
  expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(detail);
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(detail);
});
