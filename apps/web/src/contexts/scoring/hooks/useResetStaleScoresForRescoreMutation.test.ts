import { act } from "react";
import { waitFor } from "@testing-library/react";
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
      nextAction: "jobctrl score --rescore",
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

  it("keeps the accepted score and stage unchanged while a reset is pending or fails", async () => {
    let rejectRequest!: (error: Error) => void;
    const resetStaleScoresForRescore = vi.fn(() => new Promise<never>((_resolve, reject) => {
      rejectRequest = reject;
    }));
    const { result, queryClient } = renderHookWithProviders(() => useResetStaleScoresForRescoreMutation(), {
      ports: buildTestPorts({ api: { resetStaleScoresForRescore } }),
    });
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-stale"), makeJobDetail(staleJob));
    queryClient.setQueryData(jobsKeys.lists(LOCAL_TENANT), makeJobsPage([staleJob]));

    let request!: Promise<unknown>;
    await act(async () => {
      request = result.current.mutateAsync({ jobKeys: ["job-stale"] });
      await waitFor(() => expect(resetStaleScoresForRescore).toHaveBeenCalled());
    });

    const pendingDetail = queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(
      jobsKeys.detail(LOCAL_TENANT, "job-stale"),
    );
    expect(pendingDetail?.job.currentState).toBe("stale");
    expect(pendingDetail?.job.scoreStaleness).toEqual(staleJob.scoreStaleness);
    await act(async () => {
      rejectRequest(new Error("network down"));
      await expect(request).rejects.toThrow("network down");
    });

    const detail = queryClient.getQueryData<ReturnType<typeof makeJobDetail>>(
      jobsKeys.detail(LOCAL_TENANT, "job-stale"),
    );
    expect(detail?.job.scoreStaleness.isStale).toBe(true);
    expect(detail?.job.currentState).toBe("stale");
  });

  it("does not guess a stage change before the server returns its selected cohort", async () => {
    const response = {
      ok: true as const,
      count: 1,
      jobKeys: ["job-stale"],
      nextAction: "jobctrl score --rescore",
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
    expect(detail?.job.currentState).toBe("stale");
    expect(detail?.job.scoreStaleness).toEqual(staleJob.scoreStaleness);
  });
});
