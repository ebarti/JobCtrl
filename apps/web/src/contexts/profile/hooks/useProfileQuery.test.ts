import { waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { act } from "react";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { createTestQueryClient } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { prefetchProfile } from "../readQueries.js";
import { profileKeys } from "../queryKeys.js";

import { renderHookWithProviders } from "../../../test/render.js";
import { useProfileQuery } from "./useProfileQuery.js";

describe("useProfileQuery", () => {
  it("reuses the loader cache, retains accepted data on failure and recovers", async () => {
    const ports = buildTestPorts();
    const queryClient = createTestQueryClient();
    queryClient.setDefaultOptions({
      queries: { retry: false, staleTime: 60_000, gcTime: Infinity },
    });
    const read = vi.spyOn(ports.api, "profile");
    await prefetchProfile({ ports, queryClient, tenantId: LOCAL_TENANT });
    const key = profileKeys.profile(LOCAL_TENANT);
    const accepted = queryClient.getQueryData(key);
    expect(accepted).toBeDefined();
    const { result } = renderHookWithProviders(() => useProfileQuery(), {
      ports,
      queryClient,
    });
    expect(result.current.data).toEqual(accepted);
    // Observe status before settlement so Query's tracked-property subscription
    // delivers a failed refresh even when accepted data is unchanged.
    expect(result.current.isError).toBe(false);
    expect(read).toHaveBeenCalledTimes(1);
    read.mockRejectedValueOnce(new Error("synthetic refresh failure"));
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.data).toEqual(accepted);
    expect(queryClient.getQueryData(key)).toEqual(accepted);
    await act(async () => {
      await result.current.refetch();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(read).toHaveBeenCalledTimes(3);
  });

  it("returns the mocked profile", async () => {
    const { result } = renderHookWithProviders(() => useProfileQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const profile = result.current.data?.profile as {
      personal: { full_name: string };
    };
    expect(profile.personal.full_name).toBe("Jordan Candidate");
  });
});
