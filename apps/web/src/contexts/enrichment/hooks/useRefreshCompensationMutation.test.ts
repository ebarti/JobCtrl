import type { ActionRunResponse } from "@jobhunter/contracts";
import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { enrichmentKeys } from "../queryKeys.js";
import {
  useRefreshAllCompensationMutation,
  useRefreshCompensationMutation,
} from "./useRefreshCompensationMutation.js";

function actionResponse(action: ActionRunResponse["action"], jobKey: string): ActionRunResponse {
  return {
    ok: true,
    runId: `run-${action}`,
    actionId: `action-${action}`,
    action,
    status: "succeeded",
    jobKey,
    command: { action, jobKey },
  };
}

describe("compensation refresh mutations", () => {
  it("refreshes one job through the API port with source options", async () => {
    const response = actionResponse("refresh_compensation", "job-1");
    const refreshCompensation = vi.fn(async () => response);
    const { result, queryClient } = renderHookWithProviders(() => useRefreshCompensationMutation(), {
      ports: buildTestPorts({ api: { refreshCompensation } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          jobId: "job-1",
          observationsJsonPath: "/tmp/reported-compensation.json",
          includeEuroTopTech: false,
          euroTopTechMaxPages: 3,
        }),
      ).resolves.toBe(response);
    });

    expect(refreshCompensation).toHaveBeenCalledWith("job-1", {
      observationsJsonPath: "/tmp/reported-compensation.json",
      includeEuroTopTech: false,
      euroTopTechMaxPages: 3,
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.detail(LOCAL_TENANT, "job-1") });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.lists(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: enrichmentKeys.all(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dashboardKeys.summary(LOCAL_TENANT) });
    });
  });

  it("refreshes all jobs through the API port and invalidates broad compensation reads", async () => {
    const response = actionResponse("refresh_compensation", "pipeline");
    const refreshAllCompensation = vi.fn(async () => response);
    const { result, queryClient } = renderHookWithProviders(() => useRefreshAllCompensationMutation(), {
      ports: buildTestPorts({ api: { refreshAllCompensation } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(result.current.mutateAsync({ includeEuroTopTech: false })).resolves.toBe(response);
    });

    expect(refreshAllCompensation).toHaveBeenCalledWith({ includeEuroTopTech: false });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.all(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: enrichmentKeys.all(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dashboardKeys.summary(LOCAL_TENANT) });
    });
  });
});
