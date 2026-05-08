import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useWorkflowRunsListQuery } from "./useWorkflowRunsListQuery.js";

describe("useWorkflowRunsListQuery", () => {
  it("returns the MSW-mocked workflow-runs list", async () => {
    const { result } = renderHookWithProviders(() => useWorkflowRunsListQuery());
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items.length).toBeGreaterThan(0);
    expect(result.current.data?.items[0]?.workflowId).toBe("apply-run-1");
    // The deep-link uses `workflowId`; the read-model preserves the
    // distinction between `runId` and `workflowId` so future non-apply
    // workflows that key timeline events on a different id keep working.
    expect(result.current.data?.items[0]?.runId).toBe("apply-run-1");
  });

  it("surfaces errors when the API responds with 500", async () => {
    server.use(
      http.get("*/v1/workflow-runs", () =>
        new HttpResponse(JSON.stringify({ ok: false, error: "boom" }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useWorkflowRunsListQuery());
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/500/);
  });
});
