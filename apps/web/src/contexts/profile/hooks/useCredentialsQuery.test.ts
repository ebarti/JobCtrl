import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useCredentialsQuery } from "./useCredentialsQuery.js";

describe("useCredentialsQuery", () => {
  it("returns the mocked credentials list", async () => {
    const { result } = renderHookWithProviders(() => useCredentialsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.credentials.map((c) => c.key)).toContain("OPENAI_API_KEY");
  });
});
