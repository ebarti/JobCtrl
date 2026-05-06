import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useGenerateMaterialsMutation } from "./useGenerateMaterialsMutation.js";

describe("useGenerateMaterialsMutation", () => {
  it("rejects with NotImplementedError until the backend endpoint stabilizes", async () => {
    const { result } = renderHookWithProviders(() => useGenerateMaterialsMutation());
    await act(async () => {
      result.current.mutate({ jobId: "job-1" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/useGenerateMaterialsMutation/);
  });
});
