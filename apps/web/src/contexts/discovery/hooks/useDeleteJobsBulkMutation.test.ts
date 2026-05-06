import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useDeleteJobsBulkMutation } from "./useDeleteJobsBulkMutation.js";

describe("useDeleteJobsBulkMutation", () => {
  it("optimistically removes selected jobs from the cached list", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useDeleteJobsBulkMutation());
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), {
      ok: true,
      items: [
        { jobKey: "job-1", title: "A", company: "X" },
        { jobKey: "job-2", title: "B", company: "Y" },
        { jobKey: "job-3", title: "C", company: "Z" },
      ],
      pagination: { page: 1, pageSize: 50, total: 3, pages: 1 },
      sort: { field: "discovered_at", dir: "desc" },
      filter: {},
    });

    await act(async () => {
      result.current.mutate({ jobKeys: ["job-1", "job-3"], allMatching: false });
      await Promise.resolve();
    });
    const optimistic = queryClient.getQueryData<{ items: Array<{ jobKey: string }> }>(
      jobsKeys.list(LOCAL_TENANT, {}),
    );
    expect(optimistic?.items.map((item) => item.jobKey)).toEqual(["job-2"]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("skips optimistic removal in allMatching mode", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useDeleteJobsBulkMutation());
    const initial = {
      ok: true,
      items: [
        { jobKey: "job-1", title: "A", company: "X" },
        { jobKey: "job-2", title: "B", company: "Y" },
      ],
      pagination: { page: 1, pageSize: 50, total: 2, pages: 1 },
      sort: { field: "discovered_at", dir: "desc" },
      filter: {},
    };
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), initial);

    await act(async () => {
      result.current.mutate({ jobKeys: [], allMatching: true });
      await Promise.resolve();
    });
    const cache = queryClient.getQueryData(jobsKeys.list(LOCAL_TENANT, {}));
    expect(cache).toEqual(initial);
  });

  it("rolls back the optimistic patch when the bulk request fails", async () => {
    server.use(
      http.post("*/v1/jobs/bulk-delete", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useDeleteJobsBulkMutation());
    const initial = {
      ok: true,
      items: [
        { jobKey: "job-1", title: "A", company: "X" },
        { jobKey: "job-2", title: "B", company: "Y" },
      ],
      pagination: { page: 1, pageSize: 50, total: 2, pages: 1 },
      sort: { field: "discovered_at", dir: "desc" },
      filter: {},
    };
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), initial);

    await act(async () => {
      result.current.mutate({ jobKeys: ["job-1"], allMatching: false });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.list(LOCAL_TENANT, {}))).toEqual(initial);
  });
});
