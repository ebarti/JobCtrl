import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useApplyJobMutation } from "./useApplyJobMutation.js";

describe("useApplyJobMutation", () => {
  it("returns the action-run response on success", async () => {
    const { result } = renderHookWithProviders(() => useApplyJobMutation());
    await act(async () => {
      result.current.mutate({ jobId: "job-1", body: { dryRun: false } });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.action).toBe("apply");
    expect(result.current.data?.jobKey).toBe("job-1");
  });

  it("reports error and leaves cache untouched when the apply POST fails", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/apply", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const initialDetail = { ok: true, job: { jobKey: "job-1" }, stages: [], artifacts: [] };
    const { result, queryClient } = renderHookWithProviders(() => useApplyJobMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1", body: { dryRun: false } });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(initialDetail);
  });
});
