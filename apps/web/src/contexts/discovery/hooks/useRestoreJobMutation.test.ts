import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useRestoreJobMutation } from "./useRestoreJobMutation.js";

const initialList = {
  ok: true,
  items: [{ jobKey: "job-3", title: "C", company: "Z" }],
  pagination: { page: 1, pageSize: 50, total: 1, pages: 1 },
  sort: { field: "discovered_at", dir: "desc" },
  filter: {},
};

describe("useRestoreJobMutation", () => {
  it("removes the restored job from the active list optimistically", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRestoreJobMutation());
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), initialList);

    await act(async () => {
      result.current.mutate({ jobId: "job-3" });
      await Promise.resolve();
    });
    const optimistic = queryClient.getQueryData<{ items: Array<{ jobKey: string }> }>(
      jobsKeys.list(LOCAL_TENANT, {}),
    );
    expect(optimistic?.items).toEqual([]);

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.jobKeys).toEqual(["job-3"]);
  });

  it("rolls back the optimistic removal when the restore POST fails", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/restore", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useRestoreJobMutation());
    queryClient.setQueryData(jobsKeys.list(LOCAL_TENANT, {}), initialList);

    await act(async () => {
      result.current.mutate({ jobId: "job-3" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.list(LOCAL_TENANT, {}))).toEqual(initialList);
  });
});
