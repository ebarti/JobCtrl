import { LOCAL_TENANT } from "@jobctl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { jobsKeys } from "../../operations/jobsKeys.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useGenerateMaterialsMutation } from "./useGenerateMaterialsMutation.js";

const initialDetail = {
  ok: true,
  job: { jobKey: "job-1" },
  stages: [
    { stage: "tailor", state: "succeeded" },
    { stage: "cover", state: "succeeded" },
  ],
  artifacts: [],
};

const detailWithAcceptedArtifact = {
  ok: true,
  job: { jobKey: "job-1" },
  stages: [{ stage: "tailor", state: "succeeded" }],
  artifacts: [{ artifactId: "resume-accepted", type: "tailored_resume_pdf", status: "active" }],
};

describe("useGenerateMaterialsMutation", () => {
  it("optimistically marks the tailor stage as running, settles on success", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useGenerateMaterialsMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
      await Promise.resolve();
    });
    const optimistic = queryClient.getQueryData<{
      stages: Array<{ stage: string; state: string }>;
    }>(jobsKeys.detail(LOCAL_TENANT, "job-1"));
    expect(optimistic?.stages.find((s) => s.stage === "tailor")?.state).toBe("running");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic tailor state when the request fails (e.g. worker offline)", async () => {
    server.use(
      http.post(
        "*/v1/jobs/:jobKey/actions/generate-materials",
        () => new HttpResponse(JSON.stringify({ ok: false }), { status: 503 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useGenerateMaterialsMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), initialDetail);

    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"));
    expect(restored).toEqual(initialDetail);
  });

  it("preserves the last accepted artifact during the optimistic queued patch (INSPECT-06)", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useGenerateMaterialsMutation());
    queryClient.setQueryData(jobsKeys.detail(LOCAL_TENANT, "job-1"), detailWithAcceptedArtifact);

    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
      await Promise.resolve();
    });
    // The optimistic patch only marks the stage running; it must not hide or
    // remove the last accepted artifact — that is superseded only when the
    // worker approves a replacement.
    const optimistic = queryClient.getQueryData<typeof detailWithAcceptedArtifact>(
      jobsKeys.detail(LOCAL_TENANT, "job-1"),
    );
    expect(optimistic?.artifacts).toEqual(detailWithAcceptedArtifact.artifacts);
    expect(optimistic?.stages.find((s) => s.stage === "tailor")?.state).toBe("running");
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });
});
