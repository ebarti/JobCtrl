import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useCancelWorkflowRunMutation } from "./useCancelWorkflowRunMutation.js";

describe("useCancelWorkflowRunMutation", () => {
  it("calls the workflow-run cancel endpoint with the run id", async () => {
    const cancelWorkflowRun = vi.fn(async (runId: string) => ({
      ok: true as const,
      runId,
      actionId: runId,
      action: "cancel" as const,
      status: "cancel_requested",
      jobKey: "pipeline",
      command: { action: "cancel" as const, jobKey: "pipeline", runId },
    }));
    const { result } = renderHookWithProviders(() => useCancelWorkflowRunMutation(), {
      ports: buildTestPorts({ api: { cancelWorkflowRun } }),
    });

    await act(async () => {
      result.current.mutate({ runId: "workflow-run-1" });
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(cancelWorkflowRun).toHaveBeenCalledWith("workflow-run-1");
  });
});
