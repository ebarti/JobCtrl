import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useActivityEventQuery } from "./useActivityEventQuery.js";

describe("useActivityEventQuery", () => {
  it("returns the matching activity entry", async () => {
    const { result } = renderHookWithProviders(() => useActivityEventQuery("evt-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.eventId).toBe("evt-1");
  });

  it("returns null when no event matches", async () => {
    const { result } = renderHookWithProviders(() => useActivityEventQuery("missing"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toBeNull();
  });
});
