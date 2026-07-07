import { LOCAL_TENANT } from "@jobctl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useRetryStageMutation } from "./useRetryStageMutation.js";

const initialDetail = {
  ok: true,
  job: { jobKey: "job-1" },
  stages: [{ stage: "tailor", state: "failed" }],
  artifacts: [],
};

describe("useRetryStageMutation", () => {
  it("optimistically marks the stage as running, settles on success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1", stage: "tailor" });
      await Promise.resolve();
    });
    const optimistic = queryClient.getQueryData<{
      stages: Array<{ stage: string; state: string }>;
    }>(jobsKeys.detail(LOCAL_TENANT, "job-1"));
    expect(optimistic?.stages.find((s) => s.stage === "tailor")?.state).toBe("running");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic stage state when the request fails", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/retry-stage", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useRetryStageMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1", stage: "tailor" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"));
    expect(restored).toEqual(initialDetail);
  });
});
