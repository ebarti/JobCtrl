import { LOCAL_TENANT } from "@jobctl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useCancelApplyMutation } from "./useCancelApplyMutation.js";

describe("useCancelApplyMutation", () => {
  it("calls the cancel endpoint with optional runId", async () => {
    const { result } = renderHookWithProviders(() => useCancelApplyMutation());
    await act(async () => {
      result.current.mutate({ jobId: "job-1", runId: "run-1" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.action).toBe("cancel");
  });

  it("reports error and leaves cache untouched on cancel failure", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/cancel", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const initialDetail = { ok: true, job: { jobKey: "job-1" }, stages: [], artifacts: [] };
    const { result, queryClient } = renderHookWithProviders(() => useCancelApplyMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1", runId: "run-1" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(initialDetail);
  });
});
