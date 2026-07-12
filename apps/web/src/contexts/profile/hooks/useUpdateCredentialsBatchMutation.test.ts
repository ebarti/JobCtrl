import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { act, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { sampleCredentialsResponse } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { buildGoogleCredentialBatch } from "../lib/provider-credential-plans.js";
import { profileKeys } from "../queryKeys.js";
import { useUpdateCredentialsBatchMutation } from "./useUpdateCredentialsBatchMutation.js";

describe("useUpdateCredentialsBatchMutation", () => {
  const batch = buildGoogleCredentialBatch({
    mode: "vertex",
    apiKey: "",
    projectId: "project-id",
    location: "us-central1",
    googleApplicationCredentials: "",
  });

  it("sends one provider mode plan and returns configured indicators only", async () => {
    const updateCredentialsBatch = vi.fn(async () => sampleCredentialsResponse);
    const { result } = renderHookWithProviders(() => useUpdateCredentialsBatchMutation(), {
      ports: buildTestPorts({ api: { updateCredentialsBatch } }),
    });

    await act(async () => {
      await result.current.mutateAsync(batch);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(updateCredentialsBatch).toHaveBeenCalledWith(batch);
    expect(result.current.data).toEqual(sampleCredentialsResponse);
  });

  it("leaves cached configuration untouched when a non-optimistic batch fails", async () => {
    const updateCredentialsBatch = vi.fn().mockRejectedValue(new Error("Keychain unavailable"));
    const { result, queryClient } = renderHookWithProviders(
      () => useUpdateCredentialsBatchMutation(),
      { ports: buildTestPorts({ api: { updateCredentialsBatch } }) },
    );
    queryClient.setQueryData(profileKeys.credentials(LOCAL_TENANT), sampleCredentialsResponse);

    await act(async () => {
      result.current.mutate(batch);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(queryClient.getQueryData(profileKeys.credentials(LOCAL_TENANT))).toEqual(
      sampleCredentialsResponse,
    );
  });
});
