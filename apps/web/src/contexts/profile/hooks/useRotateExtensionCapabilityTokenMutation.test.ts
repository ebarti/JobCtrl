import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { sampleExtensionCapabilityTokenResponse } from "../../../test/fixtures/projections.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { profileKeys } from "../queryKeys.js";
import { useRotateExtensionCapabilityTokenMutation } from "./useRotateExtensionCapabilityTokenMutation.js";

describe("useRotateExtensionCapabilityTokenMutation", () => {
  it("stores the rotated token in the pairing-token query", async () => {
    const rotated = {
      ...sampleExtensionCapabilityTokenResponse,
      token: "jh_ext_rotated_token_123456789012345678901234567",
      created: true,
    };
    const { result, queryClient } = renderHookWithProviders(
      () => useRotateExtensionCapabilityTokenMutation(),
      {
        ports: buildTestPorts({
          api: {
            rotateExtensionCapabilityToken: vi.fn(async () => rotated),
          },
        }),
      },
    );

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(queryClient.getQueryData(profileKeys.extensionPairing(LOCAL_TENANT))).toEqual(rotated);
  });

  it("keeps the current token cached when rotation fails", async () => {
    const { result, queryClient } = renderHookWithProviders(
      () => useRotateExtensionCapabilityTokenMutation(),
      {
        ports: buildTestPorts({
          api: {
            rotateExtensionCapabilityToken: vi.fn(async () => {
              throw new Error("rotate failed");
            }),
          },
        }),
      },
    );
    queryClient.setQueryData(
      profileKeys.extensionPairing(LOCAL_TENANT),
      sampleExtensionCapabilityTokenResponse,
    );

    await act(async () => {
      result.current.mutate();
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(profileKeys.extensionPairing(LOCAL_TENANT))).toEqual(
      sampleExtensionCapabilityTokenResponse,
    );
  });
});
