import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useImportJobMutation } from "./useImportJobMutation.js";

describe("useImportJobMutation", () => {
  it("rejects with NotImplementedError until the backend lands", async () => {
    const { result } = renderHookWithProviders(() => useImportJobMutation());
    await act(async () => {
      result.current.mutate({ url: "https://example.com" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toMatch(/useImportJobMutation/);
  });
});
