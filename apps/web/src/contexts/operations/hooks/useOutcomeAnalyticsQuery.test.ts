import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { prefetchOutcomeAnalytics } from "../readQueries.js";
import { analyticsKeys } from "../analyticsKeys.js";
import { act } from "react";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../test/msw/server.js";
import { sampleOutcomeAnalyticsSummary } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useOutcomeAnalyticsQuery } from "./useOutcomeAnalyticsQuery.js";

describe("useOutcomeAnalyticsQuery", () => {
  it("returns mocked outcome analytics", async () => {
    const { result } = renderHookWithProviders(() =>
      useOutcomeAnalyticsQuery({ dimension: "fit_band" }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.minSample).toBe(5);
    expect(result.current.data?.byFitBand[0]?.fitBand).toBe("excellent");
    expect(result.current.data?.byApplyMode[0]?.applyMode).toBe(
      "automated_live",
    );
  });

  it("propagates analytics endpoint errors", async () => {
    server.use(
      http.get(
        "*/v1/analytics/outcomes",
        () => new HttpResponse(JSON.stringify({ ok: false }), { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useOutcomeAnalyticsQuery(),
    );

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

it("refreshes loader data on mount, retains it on failure, and retries successfully", async () => {
  const read = vi.fn(async () => sampleOutcomeAnalyticsSummary);
  const ports = buildTestPorts({ api: { outcomeAnalytics: read } });
  const queryClient = createTestQueryClient();
  await prefetchOutcomeAnalytics(
    { ports, queryClient, tenantId: LOCAL_TENANT },
    { dimension: "fit_band" },
  );
  read.mockRejectedValueOnce(new Error("synthetic mount refresh failed"));
  const { result } = renderHookWithProviders(
    () => useOutcomeAnalyticsQuery({ dimension: "fit_band" }),
    { ports, queryClient },
  );
  await waitFor(() => expect(result.current.isError).toBe(true));
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.current.data).toEqual(sampleOutcomeAnalyticsSummary);
  expect(
    queryClient.getQueryData(
      analyticsKeys.outcomes(LOCAL_TENANT, { dimension: "fit_band" }),
    ),
  ).toEqual(sampleOutcomeAnalyticsSummary);
  await act(async () => {
    await result.current.refetch();
  });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(read).toHaveBeenCalledTimes(3);
});
