import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useJobsListQuery } from "./useJobsListQuery.js";

describe("useJobsListQuery", () => {
  it("returns the MSW-mocked job list", async () => {
    const { result } = renderHookWithProviders(() => useJobsListQuery({}));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items.length).toBeGreaterThan(0);
    expect(result.current.data?.items[0]?.jobKey).toBe("job-1");
  });

  it("surfaces errors when the API responds with 500", async () => {
    server.use(
      http.get("*/v1/jobs", () =>
        new HttpResponse(JSON.stringify({ ok: false, error: "boom" }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useJobsListQuery({}));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/500/);
  });
});
