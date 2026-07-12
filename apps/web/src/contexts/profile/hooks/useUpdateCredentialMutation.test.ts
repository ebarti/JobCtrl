import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { profileKeys } from "../queryKeys.js";
import { useUpdateCredentialMutation } from "./useUpdateCredentialMutation.js";

const initialCredentials = {
  ok: true as const,
  store: {
    kind: "macos_keychain" as const,
    available: true,
    unavailableReason: null,
    requiresWorkerRestart: true as const,
  },
  credentials: [
    { key: "OPENAI_API_KEY" as const, label: "OpenAI", configured: false, storage: "keychain" as const },
    { key: "GEMINI_API_KEY" as const, label: "Gemini", configured: false, storage: "keychain" as const },
  ],
};

describe("useUpdateCredentialMutation", () => {
  it("calls patch-credentials and returns the credentials list", async () => {
    const { result } = renderHookWithProviders(() => useUpdateCredentialMutation());
    await act(async () => {
      result.current.mutate({ key: "OPENAI_API_KEY", value: "sk-secret" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.credentials.length).toBeGreaterThan(0);
  });

  it("rolls back the optimistic configured flag when the PATCH fails", async () => {
    server.use(
      http.patch("*/v1/credentials", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useUpdateCredentialMutation());
    queryClient.setQueryData(profileKeys.credentials(LOCAL_TENANT), initialCredentials);

    await act(async () => {
      result.current.mutate({ key: "OPENAI_API_KEY", value: "sk-bad" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(profileKeys.credentials(LOCAL_TENANT)) as {
      credentials: ReadonlyArray<{ key: string; configured: boolean }>;
    };
    expect(restored.credentials.find((c) => c.key === "OPENAI_API_KEY")?.configured).toBe(false);
  });
});
