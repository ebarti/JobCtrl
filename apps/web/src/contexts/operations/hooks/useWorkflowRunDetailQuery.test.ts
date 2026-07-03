import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useWorkflowRunDetailQuery } from "./useWorkflowRunDetailQuery.js";

describe("useWorkflowRunDetailQuery", () => {
  it("returns the MSW-mocked workflow-run detail", async () => {
    const { result } = renderHookWithProviders(() =>
      useWorkflowRunDetailQuery("run-pipeline-1"),
    );
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.workflowId).toBe("run-pipeline-1");
    expect(result.current.data?.workflowType).toBe("JobPipelineWorkflow");
    expect(result.current.data?.events.length).toBeGreaterThan(0);
  });

  it("surfaces errors when the API responds with 404", async () => {
    server.use(
      http.get(
        "*/v1/workflow-runs/:runId",
        () => new HttpResponse(JSON.stringify({ ok: false, error: "workflow_run_not_found" }), { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useWorkflowRunDetailQuery("missing"),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/404/);
  });
});
