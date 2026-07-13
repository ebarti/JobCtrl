import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sampleProviderStatusResponse } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useProviderStatusQuery } from "./useProviderStatusQuery.js";

describe("useProviderStatusQuery", () => {
  it("returns sanitized provider readiness", async () => {
    const { result } = renderHookWithProviders(() => useProviderStatusQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleProviderStatusResponse);
  });

  it("surfaces status errors to the owning panel", async () => {
    const providerStatus = vi.fn().mockRejectedValue(new Error("status unavailable"));
    const { result } = renderHookWithProviders(() => useProviderStatusQuery(), {
      ports: buildTestPorts({ api: { providerStatus } }),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("status unavailable");
  });
});
