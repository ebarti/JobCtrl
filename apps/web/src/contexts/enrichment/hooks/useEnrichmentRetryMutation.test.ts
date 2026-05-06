import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useEnrichmentRetryMutation } from "./useEnrichmentRetryMutation.js";

describe("useEnrichmentRetryMutation", () => {
  it("rejects with NotImplementedError until the backend endpoint lands", async () => {
    const { result } = renderHookWithProviders(() => useEnrichmentRetryMutation());
    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/useEnrichmentRetryMutation/);
  });
});
