import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useApplyRunsListQuery } from "./useApplyRunsListQuery.js";

describe("useApplyRunsListQuery", () => {
  it("derives the apply-runs list from the dashboard summary", async () => {
    const { result } = renderHookWithProviders(() => useApplyRunsListQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.length).toBeGreaterThan(0);
    expect(result.current.data?.[0]?.runId).toBe("run-1");
  });
});
