import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { makeJobDetail, makeJobsPage, sampleJob } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useResetStaleScoresForRescoreMutation } from "./useResetStaleScoresForRescoreMutation.js";

const staleJob = {
  ...sampleJob,
  jobKey: "job-stale",
  currentStage: "discover" as const,
  currentState: "stale" as const,
  scoreStaleness: {
    isStale: true,
    staleReason: "scoring_policy_changed",
    currentPolicyVersion: 1,
    targetPolicyVersion: 2,
    markedAt: "2026-04-29T10:07:00+00:00",
    pendingExplicitRescore: true,
  },
};

describe("useResetStaleScoresForRescoreMutation", () => {
  it("posts selected stale scores through the API port", async () => {
    const response = {
      ok: true as const,
      count: 1,
      jobKeys: ["job-stale"],
      nextAction: "jobctrl run score --rescore",
    };
    const resetStaleScoresForRescore = vi.fn(async () => response);
    const { result } = renderHookWithProviders(() => useResetStaleScoresForRescoreMutation(), {
      ports: buildTestPorts({ api: { resetStaleScoresForRescore } }),
    });

    await act(async () => {
      await expect(result.current.mutateAsync({ jobKeys: ["job-stale"] })).resolves.toBe(response);
    });

    expect(resetStaleScoresForRescore).toHaveBeenCalledWith({
      jobKeys: ["job-stale"],
      limit: 0,
    });
  });

  it("optimistically clears stale metadata and rolls back on API failure", async () => {
    const resetStaleScoresForRescore = vi.fn(async () => {
      throw new Error("network down");
    });
    const { result, queryClient } = renderHookWithProviders(() => useResetStaleScoresForRescoreMutation(), {
      ports: buildTestPorts({ api: { resetStaleScoresForRescore } }),
    });
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-stale"), makeJobDetail(staleJob));
    queryClient.setQueryData(jobsKeys.lists(LOCAL_TENANT), makeJobsPage([staleJob]));

    await act(async () => {
      await expect(result.current.mutateAsync({ jobKeys: ["job-stale"] })).rejects.toThrow("network down");
    });

    const detail = queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(
      jobsKeys.detail(LOCAL_TENANT, "job-stale"),
    );
    expect(detail?.job.scoreStaleness.isStale).toBe(true);
    expect(detail?.job.currentState).toBe("stale");
  });

  it("optimistically moves stale Discover rows back to pending while preserving the product stage", async () => {
    const response = {
      ok: true as const,
      count: 1,
      jobKeys: ["job-stale"],
      nextAction: "jobctrl run score --rescore",
    };
    const resetStaleScoresForRescore = vi.fn(async () => response);
    const { result, queryClient } = renderHookWithProviders(() => useResetStaleScoresForRescoreMutation(), {
      ports: buildTestPorts({ api: { resetStaleScoresForRescore } }),
    });
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-stale"), makeJobDetail(staleJob));

    await act(async () => {
      await expect(result.current.mutateAsync({ jobKeys: ["job-stale"] })).resolves.toBe(response);
    });

    const detail = queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(
      jobsKeys.detail(LOCAL_TENANT, "job-stale"),
    );
    expect(detail?.job.currentStage).toBe("discover");
    expect(detail?.job.currentState).toBe("pending");
    expect(detail?.job.scoreStaleness.isStale).toBe(false);
  });
});
