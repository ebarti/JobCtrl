import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useSettingsQuery } from "./useSettingsQuery.js";

describe("useSettingsQuery", () => {
  it("returns the mocked settings", async () => {
    const { result } = renderHookWithProviders(() => useSettingsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.settings.targetRole).toBe("Platform Engineering");
  });
});
