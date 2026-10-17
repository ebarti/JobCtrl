import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { buildProviderHarness } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { makeJobsPage, sampleJob } from "../../../test/fixtures/projections.js";
import { jobsKeys } from "../jobsKeys.js";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useJobsListQuery } from "./useJobsListQuery.js";

describe("useJobsListQuery", () => {
  it("keys and invalidates the exact combined page without preceding-page reads", async () => {
    const page = {
      ...makeJobsPage([sampleJob]),
      pagination: { page: 100, pageSize: 50, total: 5001, pages: 101 },
    };
    const jobs = vi.fn().mockResolvedValue(page);
    const harness = buildProviderHarness({
      ports: buildTestPorts({ api: { jobs } }),
    });
    const input = {
      stages: ["discover", "apply"] as const,
      page: 100,
      pageSize: 50,
    };
    const unrelated = ["tenant", LOCAL_TENANT, "unrelated"];
    harness.queryClient.setQueryData(unrelated, "keep");
    const { result } = renderHookWithProviders(
      () => useJobsListQuery(input),
      harness,
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(jobs).toHaveBeenCalledExactlyOnceWith(input);
    expect(
      harness.queryClient.getQueryData(jobsKeys.list(LOCAL_TENANT, input)),
    ).toEqual(page);
    await harness.queryClient.invalidateQueries({
      queryKey: jobsKeys.lists(LOCAL_TENANT),
    });
    expect(jobs).toHaveBeenCalledTimes(2);
    expect(
      jobs.mock.calls.every(
        ([query]) => query.page === 100 && query.pageSize === 50,
      ),
    ).toBe(true);
    expect(harness.queryClient.getQueryState(unrelated)?.isInvalidated).toBe(
      false,
    );
  });
  it("returns the MSW-mocked job list", async () => {
    const { result } = renderHookWithProviders(() => useJobsListQuery({}));
    expect(result.current.isLoading).toBe(true);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items.length).toBeGreaterThan(0);
    expect(result.current.data?.items[0]?.jobKey).toBe("job-1");
  });

  it("surfaces errors when the API responds with 500", async () => {
    server.use(
      http.get(
        "*/v1/jobs",
        () =>
          new HttpResponse(JSON.stringify({ ok: false, error: "boom" }), {
            status: 500,
          }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useJobsListQuery({
        stages: ["discover", "apply"],
        page: 100,
        pageSize: 50,
      }),
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/500/);
  });
});
