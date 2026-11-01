import { act } from "react";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_TENANT, createJobActiveStateChanged, createJobUpdated } from "@jobctrl/domain-types";
import { useQuery } from "@tanstack/react-query";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { invalidationRouter } from "../../operations/invalidation-router.js";
import { makeJobDetail, makeJobsPage, sampleJob } from "../../../test/fixtures/projections.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useCorrectScoreMutation } from "./useCorrectScoreMutation.js";

describe("useCorrectScoreMutation", () => {
  it("keeps a paginated filtered list relevant when a pending score belongs to an absent job", async () => {
    let resolveFirst!: (value: ReturnType<typeof makeJobDetail>) => void;
    const otherJob = { ...sampleJob, jobKey: "job-2", fitScore: 8 };
    const correctedOther = { ...otherJob, fitScore: 9 };
    const correctScore = vi.fn((jobId: string) => jobId === "job-1"
      ? new Promise<ReturnType<typeof makeJobDetail>>((resolve) => { resolveFirst = resolve; })
      : Promise.resolve(makeJobDetail(correctedOther)));
    const queryClient = createTestQueryClient();
    const key = jobsKeys.list(LOCAL_TENANT, { page: 1, pageSize: 1, minFitScore: 8, sort: "fit_score", dir: "desc" });
    const baseline = { ...makeJobsPage([otherJob]), pagination: { page: 1, pageSize: 1, total: 1, pages: 1 } };
    const canonical = { ...makeJobsPage([correctedOther]), pagination: { page: 1, pageSize: 1, total: 2, pages: 2 } };
    queryClient.setQueryData(key, baseline);
    let reads = 0;
    const { result } = renderHookWithProviders(() => ({
      first: useCorrectScoreMutation(),
      second: useCorrectScoreMutation(),
      query: useQuery<ReturnType<typeof makeJobsPage>>({ queryKey: key, queryFn: async () => {
        reads += 1;
        return canonical;
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { correctScore } }) });
    act(() => result.current.first.mutate({ jobId: "job-1", correctedScore: 9, reason: "synthetic first" }));
    await waitFor(() => expect(correctScore).toHaveBeenCalledTimes(1));
    expect(result.current.query.data?.items.map((job) => job.jobKey)).toEqual(["job-2"]);
    act(() => result.current.second.mutate({ jobId: "job-2", correctedScore: 9, reason: "synthetic second" }));
    await waitFor(() => expect(result.current.second.isSuccess).toBe(true));
    await waitFor(() => expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true));
    expect(reads).toBe(0);
    expect(result.current.first.isPending).toBe(true);
    act(() => resolveFirst(makeJobDetail({ ...sampleJob, fitScore: 9 })));
    await waitFor(() => expect(result.current.first.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.query.data?.pagination.total).toBe(2));
    expect(result.current.query.data?.pagination.pages).toBe(2);
    expect(reads).toBeGreaterThan(0);
  });

  it("posts score correction through the API port", async () => {
    const response = makeJobDetail({ ...sampleJob, fitScore: 9 });
    const correctScore = vi.fn(async () => response);
    const { result } = renderHookWithProviders(() => useCorrectScoreMutation(), {
      ports: buildTestPorts({ api: { correctScore } }),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ jobId: "job-1", correctedScore: 9, reason: "reviewed" }),
      ).resolves.toBe(response);
    });

    expect(correctScore).toHaveBeenCalledWith("job-1", { correctedScore: 9, reason: "reviewed" });
  });

  it("preserves a partial SSE update while undoing a failed score correction", async () => {
    let rejectWrite!: (error: Error) => void;
    const correctScore = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectWrite = reject; }));
    let reads = 0;
    const queryClient = createTestQueryClient();
    const key = jobsKeys.detail(LOCAL_TENANT, "job-1");
    const baseline = makeJobDetail({ ...sampleJob, activeState: "active", fitScore: 8 });
    queryClient.setQueryData(key, baseline);
    const { result } = renderHookWithProviders(() => ({
      correction: useCorrectScoreMutation(),
      query: useQuery<ReturnType<typeof makeJobDetail>>({ queryKey: key, queryFn: async () => { reads += 1; throw new Error("synthetic refetch failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { correctScore } }) });
    act(() => result.current.correction.mutate({ jobId: "job-1", correctedScore: 9, reason: "synthetic" }));
    await waitFor(() => expect(correctScore).toHaveBeenCalledTimes(1));
    expect(result.current.query.data?.job.fitScore).toBe(9);
    act(() => invalidationRouter.handle(createJobActiveStateChanged(LOCAL_TENANT, {
      jobId: "job-1", activeState: "closed", previousState: "active", verificationMethod: "snapshot", verifiedAt: "2026-10-29T00:00:00Z",
    }), queryClient));
    await waitFor(() => expect(result.current.query.data?.job.activeState).toBe("closed"));
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    act(() => rejectWrite(new Error("synthetic correction failure")));
    await waitFor(() => expect(result.current.correction.isError).toBe(true));
    await waitFor(() => expect(result.current.query.isRefetchError).toBe(true));
    const value = queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(key)!;
    expect(value.job.activeState).toBe("closed");
    expect(value.job.fitScore).toBe(8);
    expect(value.job.scoreCorrection).toEqual(baseline.job.scoreCorrection);
  });

  it("keeps a partial list SSE update while a score correction and refetch fail", async () => {
    let rejectWrite!: (error: Error) => void;
    const correctScore = vi.fn(() => new Promise<never>((_resolve, reject) => { rejectWrite = reject; }));
    let reads = 0;
    const queryClient = createTestQueryClient();
    const key = jobsKeys.list(LOCAL_TENANT, { sort: "fit_score" });
    queryClient.setQueryData(key, makeJobsPage([sampleJob]));
    const { result } = renderHookWithProviders(() => ({
      correction: useCorrectScoreMutation(),
      query: useQuery<ReturnType<typeof makeJobsPage>>({ queryKey: key, queryFn: async () => { reads += 1; throw new Error("synthetic refetch failure"); } }),
    }), { queryClient, ports: buildTestPorts({ api: { correctScore } }) });
    act(() => result.current.correction.mutate({ jobId: "job-1", correctedScore: 9, reason: "synthetic" }));
    await waitFor(() => expect(correctScore).toHaveBeenCalledTimes(1));
    act(() => invalidationRouter.handle(createJobUpdated(LOCAL_TENANT, {
      jobId: "job-1", changedFields: { title: "New synthetic title" },
    }), queryClient));
    await waitFor(() => expect(result.current.query.data?.items[0]?.title).toBe("New synthetic title"));
    act(() => rejectWrite(new Error("synthetic correction failure")));
    await waitFor(() => expect(result.current.correction.isError).toBe(true));
    await waitFor(() => expect(reads).toBeGreaterThan(0));
    await waitFor(() => expect(result.current.query.isRefetchError).toBe(true));
    const row = queryClient.getQueryData<ReturnType<typeof makeJobsPage>>(key)!.items[0]!;
    expect(row.title).toBe("New synthetic title");
    expect(row.fitScore).toBe(sampleJob.fitScore);
    expect(row.scoreCorrection).toEqual(sampleJob.scoreCorrection);
  });

  it("keeps a later score correction timestamp when an overlapping correction fails", async () => {
    let serial = 0;
    const clock = vi.spyOn(Date.prototype, "toISOString").mockImplementation(() =>
      `2026-10-01T00:00:${String(serial++).padStart(2, "0")}.000Z`,
    );
    try {
      const reject = new Map<string, (error: Error) => void>();
      const correctScore = vi.fn((jobId: string) => new Promise<never>((_resolve, fail) => { reject.set(jobId, fail); }));
      const { result, queryClient } = renderHookWithProviders(() => ({
        old: useCorrectScoreMutation(), newer: useCorrectScoreMutation(),
      }), { ports: buildTestPorts({ api: { correctScore } }) });
      const key = jobsKeys.lists(LOCAL_TENANT);
      const otherJob = { ...sampleJob, jobKey: "job-2" };
      queryClient.setQueryData(key, makeJobsPage([sampleJob, otherJob]));
      act(() => result.current.old.mutate({ jobId: "job-1", correctedScore: 9, reason: "old" }));
      await waitFor(() => expect(reject.has("job-1")).toBe(true));
      act(() => result.current.newer.mutate({ jobId: "job-2", correctedScore: 10, reason: "new" }));
      await waitFor(() => expect(reject.has("job-2")).toBe(true));
      const before = queryClient.getQueryData<ReturnType<typeof makeJobsPage>>(key)!.items[1]!.scoreCorrection!.correctedAt;
      act(() => reject.get("job-1")!(new Error("old failure")));
      await waitFor(() => expect(result.current.old.isError).toBe(true));
      const after = queryClient.getQueryData<ReturnType<typeof makeJobsPage>>(key)!.items[1]!.scoreCorrection!.correctedAt;
      act(() => reject.get("job-2")!(new Error("new failure")));
      await waitFor(() => expect(result.current.newer.isError).toBe(true));
      expect(after).toBe(before);
    } finally {
      clock.mockRestore();
    }
  });

  it("optimistically patches score detail and rolls back on API failure", async () => {
    const correctScore = vi.fn(async () => {
      throw new Error("network down");
    });
    const { result, queryClient } = renderHookWithProviders(() => useCorrectScoreMutation(), {
      ports: buildTestPorts({ api: { correctScore } }),
    });
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), makeJobDetail(sampleJob));
    queryClient.setQueryData(jobsKeys.lists(LOCAL_TENANT), makeJobsPage([sampleJob]));

    await act(async () => {
      await expect(
        result.current.mutateAsync({ jobId: "job-1", correctedScore: 9, reason: "manual" }),
      ).rejects.toThrow("network down");
    });

    expect(queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(jobsKeys.detail(LOCAL_TENANT, "job-1"))?.job.fitScore).toBe(8);
    expect(correctScore).toHaveBeenCalledWith("job-1", { correctedScore: 9, reason: "manual" });
  });

  it("keeps an unresolved stale marker while a correction is pending and accepted", async () => {
    const staleJob = {
      ...sampleJob,
      scoreStaleness: {
        isStale: true, staleReason: "scoring_policy_changed", currentPolicyVersion: 1,
        targetPolicyVersion: 2, markedAt: "2026-01-01T00:00:00Z", pendingExplicitRescore: true,
      },
    };
    let resolveRequest!: (value: ReturnType<typeof makeJobDetail>) => void;
    const correctScore = vi.fn(() => new Promise<ReturnType<typeof makeJobDetail>>((resolve) => {
      resolveRequest = resolve;
    }));
    const { result, queryClient } = renderHookWithProviders(() => useCorrectScoreMutation(), {
      ports: buildTestPorts({ api: { correctScore } }),
    });
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), makeJobDetail(staleJob));
    queryClient.setQueryData(jobsKeys.lists(LOCAL_TENANT), makeJobsPage([staleJob]));
    let request!: Promise<unknown>;
    await act(async () => {
      request = result.current.mutateAsync({ jobId: "job-1", correctedScore: 9, reason: "manual" });
      await waitFor(() => expect(correctScore).toHaveBeenCalled());
    });
    const detail = queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(jobsKeys.detail(LOCAL_TENANT, "job-1"));
    const page = queryClient.getQueryData<ReturnType<typeof makeJobsPage>>(jobsKeys.lists(LOCAL_TENANT));
    expect(detail?.job.fitScore).toBe(9);
    expect(detail?.job.scoreStaleness).toEqual(staleJob.scoreStaleness);
    expect(page?.items[0]?.scoreStaleness).toEqual(staleJob.scoreStaleness);
    await act(async () => {
      resolveRequest(makeJobDetail({ ...staleJob, fitScore: 9 }));
      await request;
    });
    expect(queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(
      jobsKeys.detail(LOCAL_TENANT, "job-1"),
    )?.job.scoreStaleness).toEqual(staleJob.scoreStaleness);
  });
});
