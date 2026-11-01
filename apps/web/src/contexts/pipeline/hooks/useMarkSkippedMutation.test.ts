import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useMarkSkippedMutation } from "./useMarkSkippedMutation.js";
import { patchListApplyStatus } from "../lib/jobDetailPatches.js";

const initialDetail = {
  ok: true,
  job: { jobKey: "job-1", applyStatus: null },
  stages: [],
  artifacts: [],
};

describe("useMarkSkippedMutation", () => {
  it("optimistically updates apply status to skipped", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useMarkSkippedMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);
    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
      await Promise.resolve();
    });
    const cache = queryClient.getQueryData<{ job: { applyStatus: string | null } }>(
      jobsKeys.detail(LOCAL_TENANT, "job-1"),
    );
    expect(cache?.job.applyStatus).toBe("skipped");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic apply status when the request fails", async () => {
    server.use(
      http.post("*/v1/jobs/:jobKey/actions/mark-skipped", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useMarkSkippedMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(initialDetail);
  });
});

it.each(["running", "needs_verification"])("keeps %s work and verification evidence visible during local Skip", async (state) => {
  const { result, queryClient } = renderHookWithProviders(() => useMarkSkippedMutation());
  const detail = { ...initialDetail, job: { jobKey: "job-1", applyStatus: "in_progress" },
    activeApplyRun: { runId: "original" }, stages: [{ stage: "apply", state }],
    applyAudit: { hardBlockers: [{ code: "submission_intent_recorded" }] } };
  queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), detail);
  await act(async () => { result.current.mutate({ jobId: "job-1" }); });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(detail);
});

it("retains unresolved outcome evidence after the active run has ended", async () => {
  const { result, queryClient } = renderHookWithProviders(() => useMarkSkippedMutation());
  const detail = { ...initialDetail, job: { jobKey: "job-1", applyStatus: "failed" }, activeApplyRun: null,
    stages: [{ stage: "apply", state: "skipped" }], applyAudit: { hardBlockers: [{ code: "submission_outcome_uncertain" }] } };
  queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), detail);
  await act(async () => { result.current.mutate({ jobId: "job-1" }); });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(detail);
});

it.each(["queued", "succeeded"])("retains the %s disposition during an optimistic Skip", async (state) => {
  const { result, queryClient } = renderHookWithProviders(() => useMarkSkippedMutation());
  const detail = { ...initialDetail, job: { jobKey: "job-1", applyStatus: state === "succeeded" ? "applied" : null },
    stages: [{ stage: "apply", state }] };
  queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), detail);
  await act(async () => { result.current.mutate({ jobId: "job-1" }); });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"))).toEqual(detail);
  const page = { items: [{ jobKey: "job-1", applyStatus: detail.job.applyStatus, currentState: state }] };
  expect(patchListApplyStatus(page, "job-1", "skipped")).toEqual(page);
});
