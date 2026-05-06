import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useHealthQuery } from "./useHealthQuery.js";

describe("useHealthQuery", () => {
  it("returns the mocked health response", async () => {
    const { result } = renderHookWithProviders(() => useHealthQuery(), {
      withEventStream: true,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.ok).toBe(true);
    expect(result.current.data?.dbExists).toBe(true);
  });
});
