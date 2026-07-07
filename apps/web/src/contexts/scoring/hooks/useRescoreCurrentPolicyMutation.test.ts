import type { ActionRunResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useRescoreCurrentPolicyMutation, useRescoreJobMutation } from "./useRescoreCurrentPolicyMutation.js";

function actionResponse(action: ActionRunResponse["action"], jobKey: string): ActionRunResponse {
  return {
    ok: true,
    runId: `run-${action}`,
    actionId: `action-${action}`,
    action,
    status: "queued",
    jobKey,
    command: { action, jobKey },
  };
}

describe("rescore current-policy mutations", () => {
  it("rescores one job through the API port and invalidates job reads", async () => {
    const response = actionResponse("rescore_job", "job-1");
    const rescoreJob = vi.fn(async () => response);
    const { result, queryClient } = renderHookWithProviders(() => useRescoreJobMutation(), {
      ports: buildTestPorts({ api: { rescoreJob } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(result.current.mutateAsync({ jobId: "job-1" })).resolves.toBe(response);
    });

    expect(rescoreJob).toHaveBeenCalledWith("job-1", { dryRun: false });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.detail(LOCAL_TENANT, "job-1") });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.lists(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dashboardKeys.summary(LOCAL_TENANT) });
    });
  });

  it("rescores current-policy bulk scope through the API port", async () => {
    const response = actionResponse("rescore_jobs_not_on_current_scoring_policy", "pipeline");
    const rescoreJobsNotOnCurrentScoringPolicy = vi.fn(async () => response);
    const { result } = renderHookWithProviders(() => useRescoreCurrentPolicyMutation(), {
      ports: buildTestPorts({ api: { rescoreJobsNotOnCurrentScoringPolicy } }),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ jobKeys: ["job-1", "job-2"], limit: 25 }),
      ).resolves.toBe(response);
    });

    expect(rescoreJobsNotOnCurrentScoringPolicy).toHaveBeenCalledWith({
      jobKeys: ["job-1", "job-2"],
      limit: 25,
      dryRun: false,
    });
  });
});
