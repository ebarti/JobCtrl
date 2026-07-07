import type { BulkRunPendingPreparationResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { applyRunsKeys } from "../../operations/applyRunsKeys.js";
import { dashboardKeys } from "../../operations/dashboardKeys.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { workflowRunsKeys } from "../../operations/workflowRunsKeys.js";
import { useRunPendingPreparationMutation } from "./useRunPendingPreparationMutation.js";

describe("useRunPendingPreparationMutation", () => {
  it("runs pending preparation through the API port and invalidates operational reads", async () => {
    const runPendingPreparation = vi.fn(async (): Promise<BulkRunPendingPreparationResponse> => ({
      ok: true,
      count: 2,
      jobKeys: ["job-1", "job-2"],
      stageCounts: { score: 2 },
      status: "queued",
      actions: [],
    }));
    const { result, queryClient } = renderHookWithProviders(() => useRunPendingPreparationMutation(), {
      ports: buildTestPorts({ api: { runPendingPreparation } }),
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    await act(async () => {
      result.current.mutate({
        allMatching: true,
        filter: {
          q: "",
          state: "pending",
          deleted: "active",
          applyStatus: "all",
          source: "",
          company: "",
        },
        jobKeys: [],
        workers: 14,
        minScore: 7,
        validationMode: "normal",
        dryRun: false,
        llmModel: "gemini:gemini-3.5-flash",
      });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(runPendingPreparation).toHaveBeenCalledWith({
      allMatching: true,
      filter: {
        q: "",
        state: "pending",
        deleted: "active",
        applyStatus: "all",
        source: "",
        company: "",
      },
      jobKeys: [],
      workers: 14,
      minScore: 7,
      validationMode: "normal",
      dryRun: false,
      llmModel: "gemini:gemini-3.5-flash",
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.lists(LOCAL_TENANT) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: jobsKeys.details(LOCAL_TENANT) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: dashboardKeys.summary(LOCAL_TENANT) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: workflowRunsKeys.lists(LOCAL_TENANT) });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: applyRunsKeys.lists(LOCAL_TENANT) });
  });
});
