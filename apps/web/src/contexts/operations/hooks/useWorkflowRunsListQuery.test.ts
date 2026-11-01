import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { prefetchWorkflowRunsList } from "../readQueries.js";
import { workflowRunsKeys } from "../workflowRunsKeys.js";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useWorkflowRunsListQuery } from "./useWorkflowRunsListQuery.js";

describe("useWorkflowRunsListQuery", () => {
  it("reuses the loader cache, retains accepted data on failure and recovers", async () => {
    const ports = buildTestPorts();
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: Infinity },
    });
    const read = vi.spyOn(ports.api, "workflowRuns");
    await prefetchWorkflowRunsList(
      { ports, queryClient, tenantId: LOCAL_TENANT },
      { status: "failed", page: 2 },
    );
    const key = workflowRunsKeys.list(LOCAL_TENANT, {
      status: "failed",
      page: 2,
    });
    const accepted = queryClient.getQueryData(key);
    expect(accepted).toBeDefined();
    const { result } = renderHookWithProviders(
      () => useWorkflowRunsListQuery({ status: "failed", page: 2 }),
      {
        ports,
        queryClient,
      },
    );
    expect(result.current.data).toEqual(accepted);
    // Observe status before settlement so Query's tracked-property subscription
    // delivers a failed refresh even when accepted data is unchanged.
    expect(result.current.isError).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(new Error("synthetic refresh failure"));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toEqual(accepted);
    expect(queryClient.getQueryData(key)).toEqual(accepted);
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("returns the MSW-mocked workflow-runs list", async () => {
    const { result } = renderHookWithProviders(() =>
      useWorkflowRunsListQuery(),
    );
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
      http.get(
        "*/v1/workflow-runs",
        () =>
          new HttpResponse(JSON.stringify({ ok: false, error: "boom" }), {
            status: 500,
          }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useWorkflowRunsListQuery(),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/500/);
  });
});
