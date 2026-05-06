import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useCorrectScoreMutation } from "./useCorrectScoreMutation.js";

describe("useCorrectScoreMutation", () => {
  it("rejects with NotImplementedError until the backend lands", async () => {
    const { result } = renderHookWithProviders(() => useCorrectScoreMutation());
    await act(async () => {
      result.current.mutate({ jobId: "job-1", correctedScore: 9, reason: "manual" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/useCorrectScoreMutation/);
  });
});
