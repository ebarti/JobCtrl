import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { prefetchDashboardSummary } from "../readQueries.js";
import { dashboardKeys } from "../dashboardKeys.js";
import { sampleDashboardSummary } from "../../../test/fixtures/projections.js";
import { act } from "react";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useDashboardSummaryQuery } from "./useDashboardSummaryQuery.js";

describe("useDashboardSummaryQuery", () => {
  it("returns mocked dashboard totals + funnel + activity", async () => {
    const { result } = renderHookWithProviders(() =>
      useDashboardSummaryQuery(),
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.totals.jobs).toBeGreaterThan(0);
    expect(result.current.data?.work).toMatchObject({ active: 2, stuck: 1 });
    expect(result.current.data?.funnel.length).toBeGreaterThan(0);
    expect(result.current.data?.applyRuns[0]?.runId).toBe("run-1");
  });

  it("propagates 503 errors", async () => {
    server.use(
      http.get(
        "*/v1/dashboard/summary",
        () => new HttpResponse(JSON.stringify({ ok: false }), { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useDashboardSummaryQuery(),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

it("refreshes loader data on mount, retains it on failure, and retries successfully", async () => {
  const read = vi.fn(async () => sampleDashboardSummary);
  const ports = buildTestPorts({ api: { dashboardSummary: read } });
  const queryClient = createTestQueryClient();
  await prefetchDashboardSummary({
    ports,
    queryClient,
    tenantId: LOCAL_TENANT,
  });
  read.mockRejectedValueOnce(new Error("synthetic mount refresh failed"));
  const { result } = renderHookWithProviders(() => useDashboardSummaryQuery(), {
    ports,
    queryClient,
  });
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.data).toEqual(sampleDashboardSummary);
  expect(queryClient.getQueryData(dashboardKeys.summary(LOCAL_TENANT))).toEqual(
    sampleDashboardSummary,
  );
  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(read).toHaveBeenCalledTimes(3);
});
