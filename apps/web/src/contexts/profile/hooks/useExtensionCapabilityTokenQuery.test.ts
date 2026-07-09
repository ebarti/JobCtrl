import { act, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { sampleExtensionCapabilityTokenResponse } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { createQueryClient } from "../../../shared/lib/queryClient.js";
import { useToastStore } from "../../../shared/stores/toasts.js";
import { useExtensionCapabilityTokenQuery } from "./useExtensionCapabilityTokenQuery.js";

describe("useExtensionCapabilityTokenQuery", () => {
  afterEach(() => {
    useToastStore.getState().clear();
  });

  it("returns the browser extension pairing token", async () => {
    const { result } = renderHookWithProviders(() => useExtensionCapabilityTokenQuery());

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual(sampleExtensionCapabilityTokenResponse);
  });

  it("keeps repeated inline-owned failures out of the global toast queue", async () => {
    const extensionCapabilityToken = vi.fn().mockRejectedValue(
      new Error("JobCtrl API request failed: 403 Forbidden"),
    );
    const queryClient = createQueryClient();
    queryClient.setDefaultOptions({ queries: { retry: false } });
    const { result } = renderHookWithProviders(() => useExtensionCapabilityTokenQuery(), {
      ports: buildTestPorts({ api: { extensionCapabilityToken } }),
      queryClient,
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    await act(async () => {
      await result.current.refetch();
      await result.current.refetch();
    });

    expect(extensionCapabilityToken).toHaveBeenCalledTimes(3);
    expect(useToastStore.getState().toasts).toEqual([]);
  });
});
