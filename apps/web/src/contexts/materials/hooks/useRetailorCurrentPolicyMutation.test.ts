import type { ActionRunResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { artifactsKeys } from "../../operations/artifactsKeys.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import {
  useRetailorCurrentPolicyMutation,
  useRetailorJobMutation,
  useTailorJobMutation,
} from "./useRetailorCurrentPolicyMutation.js";

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

describe("re-tailor current-policy mutations", () => {
  it("tailors one job through the API port and invalidates materials reads", async () => {
    const response = actionResponse("tailor_job", "job-1");
    const tailorJob = vi.fn(async () => response);
    const { result, queryClient } = renderHookWithProviders(() => useTailorJobMutation(), {
      ports: buildTestPorts({ api: { tailorJob } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(result.current.mutateAsync({ jobId: "job-1", reason: "manual_tailor" })).resolves.toBe(response);
    });

    expect(tailorJob).toHaveBeenCalledWith("job-1", {
      dryRun: false,
      reason: "manual_tailor",
      tailorModels: [],
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.detail(LOCAL_TENANT, "job-1") });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.lists(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: artifactsKeys.lists(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dashboardKeys.summary(LOCAL_TENANT) });
    });
  });

  it("re-tailors one job through the API port and invalidates materials reads", async () => {
    const response = actionResponse("retailor_job", "job-1");
    const retailorJob = vi.fn(async () => response);
    const { result, queryClient } = renderHookWithProviders(() => useRetailorJobMutation(), {
      ports: buildTestPorts({ api: { retailorJob } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      await expect(result.current.mutateAsync({ jobId: "job-1" })).resolves.toBe(response);
    });

    expect(retailorJob).toHaveBeenCalledWith("job-1", {
      dryRun: false,
      suppressExistingArtifacts: true,
      tailorModels: [],
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.detail(LOCAL_TENANT, "job-1") });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.lists(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: artifactsKeys.lists(LOCAL_TENANT) });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dashboardKeys.summary(LOCAL_TENANT) });
    });
  });

  it("re-tailors current-policy bulk scope through the API port", async () => {
    const response = actionResponse("retailor_current_policy", "pipeline");
    const retailorCurrentPolicy = vi.fn(async () => response);
    const { result } = renderHookWithProviders(() => useRetailorCurrentPolicyMutation(), {
      ports: buildTestPorts({ api: { retailorCurrentPolicy } }),
    });

    await act(async () => {
      await expect(
        result.current.mutateAsync({ jobKeys: ["job-1"], limit: 10 }),
      ).resolves.toBe(response);
    });

    expect(retailorCurrentPolicy).toHaveBeenCalledWith({
      jobKeys: ["job-1"],
      limit: 10,
      dryRun: false,
      suppressExistingArtifacts: true,
      tailorModels: [],
    });
  });
});
