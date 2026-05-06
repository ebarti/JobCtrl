import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useProfileQuery } from "./useProfileQuery.js";

describe("useProfileQuery", () => {
  it("returns the mocked profile", async () => {
    const { result } = renderHookWithProviders(() => useProfileQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const profile = result.current.data?.profile as { personal: { full_name: string } };
    expect(profile.personal.full_name).toBe("Jordan Candidate");
  });
});
