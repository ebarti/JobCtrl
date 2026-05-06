import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useCancelStageMutation } from "./useCancelStageMutation.js";

const initialDetail = {
  ok: true,
  job: { jobKey: "job-1" },
  stages: [{ stage: "apply", state: "running" }],
  artifacts: [],
};

describe("useCancelStageMutation", () => {
  it("optimistically marks the canceled stage as stale", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useCancelStageMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);
    await act(async () => {
      result.current.mutate({ jobId: "job-1", stage: "apply" });
      await Promise.resolve();
    });
    const optimistic = queryClient.getQueryData<{
      stages: Array<{ stage: string; state: string }>;
    }>(jobsKeys.detail(LOCAL_TENANT, "job-1"));
    expect(optimistic?.stages.find((s) => s.stage === "apply")?.state).toBe("stale");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic stage state when the cancel POST fails", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/cancel", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useCancelStageMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1", stage: "apply" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(initialDetail);
  });
});
