import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { makeJobDetail, sampleInterviewPrep } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useGenerateInterviewPrepMutation } from "./useGenerateInterviewPrepMutation.js";

describe("useGenerateInterviewPrepMutation", () => {
  it("dispatches explicit prep generation and keeps the accepted prep cached until refresh", async () => {
    const generateInterviewPrep = vi.fn(async () => ({
      ok: true as const,
      runId: "run-prep",
      actionId: "act-prep",
      action: "generate_interview_prep" as const,
      status: "queued",
      jobKey: "job-1",
      command: { action: "generate_interview_prep" as const, jobKey: "job-1" },
    }));
    const { result, queryClient } = renderHookWithProviders(
      () => useGenerateInterviewPrepMutation(),
      { ports: buildTestPorts({ api: { generateInterviewPrep } }) },
    );
    const detail = makeJobDetail(undefined, { interviewPrep: sampleInterviewPrep });
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), detail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
      await Promise.resolve();
    });

    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(detail);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(generateInterviewPrep).toHaveBeenCalledWith("job-1");
  });
});
