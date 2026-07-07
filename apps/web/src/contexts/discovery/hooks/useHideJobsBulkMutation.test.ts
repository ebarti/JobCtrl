import { LOCAL_TENANT } from "@jobctl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { jobsKeys } from "../../operations/jobsKeys.js";
import { useHideJobsBulkMutation } from "./useHideJobsBulkMutation.js";

const initialList = {
  ok: true,
  items: [
    { jobKey: "job-1", title: "A", company: "X" },
    { jobKey: "job-2", title: "B", company: "Y" },
  ],
  pagination: { page: 1, pageSize: 50, total: 2, pages: 1 },
  sort: { field: "discovered_at", dir: "desc" },
  filter: {},
};

describe("useHideJobsBulkMutation", () => {
  it("removes hidden jobs from the cached list optimistically", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useHideJobsBulkMutation());
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), initialList);

    await act(async () => {
      result.current.mutate({ jobKeys: ["job-2"], allMatching: false });
      await Promise.resolve();
    });

    const optimistic = queryClient.getQueryData<{ items: Array<{ jobKey: string }> }>(
      jobsKeys.list(LOCAL_TENANT, {}),
    );
    expect(optimistic?.items.map((item) => item.jobKey)).toEqual(["job-1"]);
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic patch when bulk-hide fails", async () => {
    server.use(
      http.post("*/v1/jobs/bulk-hide", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useHideJobsBulkMutation());
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), initialList);

    await act(async () => {
      result.current.mutate({ jobKeys: ["job-1"], allMatching: false });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.list(LOCAL_TENANT, {}))).toEqual(initialList);
  });
});
