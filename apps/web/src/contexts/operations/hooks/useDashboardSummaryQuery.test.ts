import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useDashboardSummaryQuery } from "./useDashboardSummaryQuery.js";

describe("useDashboardSummaryQuery", () => {
  it("returns mocked dashboard totals + funnel + activity", async () => {
    const { result } = renderHookWithProviders(() => useDashboardSummaryQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.totals.jobs).toBeGreaterThan(0);
    expect(result.current.data?.funnel.length).toBeGreaterThan(0);
    expect(result.current.data?.applyRuns[0]?.runId).toBe("run-1");
  });

  it("propagates 503 errors", async () => {
    server.use(
      http.get("*/v1/dashboard/summary", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useDashboardSummaryQuery());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
