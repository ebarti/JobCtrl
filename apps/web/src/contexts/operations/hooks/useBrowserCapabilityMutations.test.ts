import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { browserCapabilityKeys } from "../browserCapabilityKeys.js";
import { useDisableBrowserCapabilityMutation } from "./useBrowserCapabilityMutations.js";

const initial = {
  ok: true as const,
  detectedBrowsers: [
    {
      id: "google-chrome" as const,
      label: "Google Chrome",
      defaultProfileAvailable: true,
    },
  ],
  capabilities: [
    {
      id: "core-browser" as const,
      status: "ready" as const,
      detail: "Ready.",
      mutable: false,
      enabled: true,
      profileCopyReady: false,
    },
    {
      id: "auto-apply-browser" as const,
      status: "ready" as const,
      detail: "Ready.",
      mutable: true,
      enabled: true,
      profileCopyReady: false,
    },
    {
      id: "authenticated-linkedin-browser" as const,
      status: "disabled" as const,
      detail: "Disabled.",
      mutable: true,
      enabled: false,
      profileCopyReady: false,
    },
  ],
};

describe("browser capability mutations", () => {
  it("rolls back hot-disable optimistic state on failure", async () => {
    const disableBrowserCapability = vi
      .fn()
      .mockRejectedValue(new Error("failed"));
    const { result, queryClient } = renderHookWithProviders(
      () => useDisableBrowserCapabilityMutation(),
      {
        ports: buildTestPorts({ api: { disableBrowserCapability } }),
      },
    );
    queryClient.setQueryData(
      browserCapabilityKeys.capabilities(LOCAL_TENANT),
      initial,
    );

    await act(async () => result.current.mutate("auto-apply-browser"));

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData(
        browserCapabilityKeys.capabilities(LOCAL_TENANT),
      ),
    ).toEqual(initial);
  });
});
