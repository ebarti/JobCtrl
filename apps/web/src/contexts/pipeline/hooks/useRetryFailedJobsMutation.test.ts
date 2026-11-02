import { act, waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it } from "vitest";

import { useToastStore } from "../../../shared/stores/toasts.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useRetryFailedJobsMutation } from "./useRetryFailedJobsMutation.js";

describe("useRetryFailedJobsMutation", () => {
  afterEach(() => act(() => useToastStore.getState().clear()));

  it("shows the replacement guidance returned by a bulk retry", async () => {
    server.use(http.post("*/v1/jobs/bulk-retry-failed", () => HttpResponse.json({
      ok: true, count: 1, jobKeys: ["job-1"], status: "reset", runAfter: false,
      stageCounts: { tailor: 1 }, actions: [], retailorRequiredJobKeys: ["job-1"],
      message: "Approved materials remain available. Use explicit re-tailor to create a replacement.",
    })));
    const { result } = renderHookWithProviders(() => useRetryFailedJobsMutation());
    await act(async () => {
      await result.current.mutateAsync({
        allMatching: false, jobKeys: ["job-1"], runAfter: false, workers: 1,
        minScore: 7, validationMode: "normal", dryRun: false, llmModel: "synthetic",
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(useToastStore.getState().toasts).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining("explicit re-tailor") }),
    ]));
  });
});
