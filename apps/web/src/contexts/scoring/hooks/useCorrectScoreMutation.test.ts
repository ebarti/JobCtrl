import { act } from "react";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { makeJobDetail, makeJobsPage, sampleJob } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useCorrectScoreMutation } from "./useCorrectScoreMutation.js";

describe("useCorrectScoreMutation", () => {
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
