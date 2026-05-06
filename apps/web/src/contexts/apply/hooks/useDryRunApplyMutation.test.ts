import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useDryRunApplyMutation } from "./useDryRunApplyMutation.js";

describe("useDryRunApplyMutation", () => {
  it("calls the apply endpoint with dryRun=true", async () => {
    const { result } = renderHookWithProviders(() => useDryRunApplyMutation());
    await act(async () => {
      result.current.mutate({ jobId: "job-2" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.jobKey).toBe("job-2");
  });

  it("reports error and leaves cache untouched on dry-run failure", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/apply", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const initialDetail = { ok: true, job: { jobKey: "job-2" }, stages: [], artifacts: [] };
    const { result, queryClient } = renderHookWithProviders(() => useDryRunApplyMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-2"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-2" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-2"))).toEqual(initialDetail);
  });
});
