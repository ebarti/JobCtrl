import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
    expect(result.current.data?.byApplyMode[0]?.applyMode).toBe("automated_live");
  });

  it("propagates analytics endpoint errors", async () => {
    server.use(
      http.get("*/v1/analytics/outcomes", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useOutcomeAnalyticsQuery());

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
