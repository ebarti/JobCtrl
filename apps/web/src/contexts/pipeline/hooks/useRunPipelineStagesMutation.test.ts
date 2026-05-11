import type { PipelineStageRunResponse } from "@jobhunter/contracts";
import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { workflowRunsKeys } from "../../operations/workflowRunsKeys.js";
import { applyRunsKeys } from "../../operations/applyRunsKeys.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useRunPipelineStagesMutation } from "./useRunPipelineStagesMutation.js";

describe("useRunPipelineStagesMutation", () => {
  it("runs selected pipeline stages through the API port and invalidates operational reads", async () => {
    const runPipelineStages = vi.fn(async (): Promise<PipelineStageRunResponse> => ({
      ok: true as const,
      action: "run_stage" as const,
      status: "queued",
      jobKey: "pipeline",
      count: 2,
      command: {
        stages: ["score", "apply"],
        limit: 12,
        workers: 3,
        minScore: 8,
        validationMode: "strict" as const,
        dryRun: true,
        rescore: true,
        retailor: false,
        headless: true,
        model: "sonnet",
        continuous: true,
      },
      actions: [],
    }));
    const { result, queryClient } = renderHookWithProviders(() => useRunPipelineStagesMutation(), {
      ports: buildTestPorts({ api: { runPipelineStages } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.mutate({
        stages: ["score", "apply"],
        limit: 12,
        workers: 3,
        minScore: 8,
        validationMode: "strict",
        dryRun: true,
        rescore: true,
        retailor: false,
        model: "sonnet",
        headless: true,
        continuous: true,
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(runPipelineStages).toHaveBeenCalledWith({
      stages: ["score", "apply"],
      limit: 12,
      workers: 3,
      minScore: 8,
      validationMode: "strict",
      dryRun: true,
      rescore: true,
      retailor: false,
      model: "sonnet",
      headless: true,
      continuous: true,
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.lists(LOCAL_TENANT) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dashboardKeys.summary(LOCAL_TENANT) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workflowRunsKeys.lists(LOCAL_TENANT) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: applyRunsKeys.lists(LOCAL_TENANT) });
  });
});
