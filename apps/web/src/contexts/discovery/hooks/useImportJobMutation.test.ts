import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { server } from "../../../test/msw/server.js";
import { discoveryKeys } from "../queryKeys.js";
import { useImportJobMutation } from "./useImportJobMutation.js";

describe("useImportJobMutation", () => {
  it("imports a job URL through the worker-backed API", async () => {
    server.use(
      http.post("*/v1/jobs/import-url", () =>
        HttpResponse.json({
          ok: true,
          status: "imported",
          jobKey: "7bf7e789-8a2f-45e4-8c41-00e71525d05c",
          importedAt: "2026-08-13T15:00:00Z",
          alreadyExisted: false,
        }),
      ),
    );
    const { result } = renderHookWithProviders(() => useImportJobMutation());
    await act(async () => {
      result.current.mutate({ url: "https://jobs.example.com/roles/42" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.status).toBe("imported");
  });

  it("invalidates Manual Capture when the page needs user-provided content", async () => {
    server.use(
      http.post("*/v1/jobs/import-url", () =>
        HttpResponse.json({
          ok: true,
          status: "manual_capture_required",
          itemId: "manual:abc",
          reason: "login_required",
        }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useImportJobMutation());
    queryClient.setQueryData(discoveryKeys.manualCapture(LOCAL_TENANT), {
      ok: true,
      items: [],
    });
    await act(async () => {
      result.current.mutate({ url: "https://jobs.example.com/protected/42" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(
      queryClient.getQueryState(discoveryKeys.manualCapture(LOCAL_TENANT))?.isInvalidated,
    ).toBe(true);
  });
});
