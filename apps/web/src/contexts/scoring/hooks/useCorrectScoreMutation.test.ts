import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { LOCAL_TENANT } from "@jobctl/domain-types";
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
});
