import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useMarkAppliedMutation } from "./useMarkAppliedMutation.js";

const initialDetail = {
  ok: true,
  job: { jobKey: "job-1", applyStatus: null },
  stages: [],
  artifacts: [],
};

describe("useMarkAppliedMutation", () => {
  it("optimistically updates apply status on the detail cache", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useMarkAppliedMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);
    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
      await Promise.resolve();
    });
    const cache = queryClient.getQueryData<{ job: { applyStatus: string | null } }>(
      jobsKeys.detail(LOCAL_TENANT, "job-1"),
    );
    expect(cache?.job.applyStatus).toBe("applied");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic apply status when the mark-applied request fails", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/mark-applied", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useMarkAppliedMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(initialDetail);
  });
});
