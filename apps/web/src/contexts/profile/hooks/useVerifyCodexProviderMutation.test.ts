import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useVerifyCodexProviderMutation } from "./useVerifyCodexProviderMutation.js";

describe("useVerifyCodexProviderMutation", () => {
  it("returns the sanitized Codex verification result", async () => {
    const response = {
      ok: true as const,
      verification: {
        provider: "codex" as const,
        ok: true,
        status: "connected" as const,
        message: "Codex CLI authentication is ready.",
      },
    };
    const verifyCodexProvider = vi.fn(async () => response);
    const { result } = renderHookWithProviders(() => useVerifyCodexProviderMutation(), {
      ports: buildTestPorts({ api: { verifyCodexProvider } }),
    });

    await act(async () => {
      result.current.mutate();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(response);
  });

  it("surfaces verification transport failures", async () => {
    const verifyCodexProvider = vi.fn().mockRejectedValue(new Error("verification unavailable"));
    const { result } = renderHookWithProviders(() => useVerifyCodexProviderMutation(), {
      ports: buildTestPorts({ api: { verifyCodexProvider } }),
    });

    await act(async () => {
      result.current.mutate();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error?.message).toBe("verification unavailable");
  });
});
