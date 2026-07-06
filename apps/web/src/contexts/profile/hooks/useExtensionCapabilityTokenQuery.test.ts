import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleExtensionCapabilityTokenResponse } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useExtensionCapabilityTokenQuery } from "./useExtensionCapabilityTokenQuery.js";

describe("useExtensionCapabilityTokenQuery", () => {
  it("returns the browser extension pairing token", async () => {
    const { result } = renderHookWithProviders(() => useExtensionCapabilityTokenQuery());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(sampleExtensionCapabilityTokenResponse);
  });
});
