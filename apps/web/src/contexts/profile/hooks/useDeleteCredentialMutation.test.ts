import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { profileKeys } from "../queryKeys.js";
import { useDeleteCredentialMutation } from "./useDeleteCredentialMutation.js";

const initialCredentials = {
  ok: true as const,
  store: {
    kind: "macos_keychain" as const,
    available: true,
    unavailableReason: null,
    requiresWorkerRestart: true as const,
  },
  credentials: [
    { key: "OPENAI_API_KEY" as const, label: "OpenAI", configured: true, storage: "keychain" as const, effectiveSource: "keychain" as const, editable: true },
    { key: "GEMINI_API_KEY" as const, label: "Gemini", configured: false, storage: "keychain" as const, effectiveSource: "absent" as const, editable: true },
  ],
};

describe("useDeleteCredentialMutation", () => {
  it("calls delete-credentials and returns the credentials list", async () => {
    const { result } = renderHookWithProviders(() => useDeleteCredentialMutation());
    await act(async () => {
      result.current.mutate("OPENAI_API_KEY");
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.credentials).toBeDefined();
  });

  it("rolls back the optimistic unset of `configured` when DELETE fails", async () => {
    server.use(
      http.delete("*/v1/credentials/:key", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useDeleteCredentialMutation());
    queryClient.setQueryData(profileKeys.credentials(LOCAL_TENANT), initialCredentials);

    await act(async () => {
      result.current.mutate("OPENAI_API_KEY");
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(profileKeys.credentials(LOCAL_TENANT)) as {
      credentials: ReadonlyArray<{ key: string; configured: boolean }>;
    };
    expect(restored.credentials.find((c) => c.key === "OPENAI_API_KEY")?.configured).toBe(true);
  });
});
