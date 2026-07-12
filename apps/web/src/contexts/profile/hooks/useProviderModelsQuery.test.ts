import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sampleProviderModelsResponse } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useProviderModelsQuery } from "./useProviderModelsQuery.js";

describe("useProviderModelsQuery", () => {
  it("returns the sanitized provider catalog through the API port", async () => {
    const providerModels = vi.fn(async () => sampleProviderModelsResponse);
    const { result } = renderHookWithProviders(() => useProviderModelsQuery(), {
      ports: buildTestPorts({ api: { providerModels } }),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(sampleProviderModelsResponse);
    expect(providerModels).toHaveBeenCalledTimes(1);
  });

  it("surfaces catalog errors to the owning panel", async () => {
    const providerModels = vi.fn().mockRejectedValue(new Error("catalog unavailable"));
    const { result } = renderHookWithProviders(() => useProviderModelsQuery(), {
      ports: buildTestPorts({ api: { providerModels } }),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("catalog unavailable");
  });
});
