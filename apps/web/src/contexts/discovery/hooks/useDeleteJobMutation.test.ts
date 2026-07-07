import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useDeleteJobMutation } from "./useDeleteJobMutation.js";

describe("useDeleteJobMutation", () => {
  it("optimistically removes the job from a cached list, then settles via invalidation", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useDeleteJobMutation());
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), {
      ok: true,
      items: [
        { jobKey: "job-1", title: "A", company: "X" },
        { jobKey: "job-2", title: "B", company: "Y" },
      ],
      pagination: { page: 1, pageSize: 50, total: 2, pages: 1 },
      sort: { field: "discovered_at", dir: "desc" },
      filter: {},
    });

    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
      await Promise.resolve();
    });
    const optimistic = queryClient.getQueryData<{ items: Array<{ jobKey: string }> }>(
      jobsKeys.list(LOCAL_TENANT, {}),
    );
    expect(optimistic?.items.map((item) => item.jobKey)).toEqual(["job-2"]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.count).toBe(1);
  });

  it("rolls back the optimistic patch when the request fails", async () => {
    server.use(
      http.delete("*/v1/jobs/:jobKey", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useDeleteJobMutation());
    const original = {
      ok: true,
      items: [{ jobKey: "job-1", title: "A", company: "X" }],
      pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
      sort: { field: "discovered_at", dir: "desc" },
      filter: {},
    };
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), original);

    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(jobsKeys.list(LOCAL_TENANT, {}));
    expect(restored).toEqual(original);
  });
});
