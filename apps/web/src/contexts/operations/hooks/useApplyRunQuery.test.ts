import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useApplyRunQuery } from "./useApplyRunQuery.js";

describe("useApplyRunQuery", () => {
  it("returns the matching apply run from the dashboard summary", async () => {
    const { result } = renderHookWithProviders(() => useApplyRunQuery("run-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.runId).toBe("run-1");
  });

  it("returns null when no run matches", async () => {
    const { result } = renderHookWithProviders(() => useApplyRunQuery("nope"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
