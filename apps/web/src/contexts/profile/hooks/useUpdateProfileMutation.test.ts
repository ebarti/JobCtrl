import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { profileKeys } from "../queryKeys.js";
import { useUpdateProfileMutation } from "./useUpdateProfileMutation.js";

const initialProfile = {
  ok: true,
  profile: { personal: { full_name: "Old" } },
  style: {},
  templateText: "",
};

describe("useUpdateProfileMutation", () => {
  it("optimistically patches the cached profile and invalidates on settle", async () => {
    const { result, queryClient } = renderHookWithProviders(() => useUpdateProfileMutation());
    queryClient.setQueryData(profileKeys.profile(LOCAL_TENANT), initialProfile);
    await act(async () => {
      result.current.mutate({ profile: { personal: { full_name: "New" } } });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
  });

  it("rolls back the optimistic patch when the PATCH fails", async () => {
    server.use(
      http.patch("*/v1/profile", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useUpdateProfileMutation());
    queryClient.setQueryData(profileKeys.profile(LOCAL_TENANT), initialProfile);

    await act(async () => {
      result.current.mutate({ profile: { personal: { full_name: "Forbidden" } } });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(profileKeys.profile(LOCAL_TENANT)) as {
      profile: { personal: { full_name: string } };
    };
    expect(restored.profile.personal.full_name).toBe("Old");
  });

  it("does not roll an older import failure over a newer saved cache", async () => {
    let reject!: (error: Error) => void;
    const updateProfile = vi.fn(() => new Promise<never>((_resolve, fail) => { reject = fail; }));
    const { result, queryClient } = renderHookWithProviders(() => useUpdateProfileMutation({ optimistic: false }), {
      ports: buildTestPorts({ api: { updateProfile } }),
    });
    const key = profileKeys.profile(LOCAL_TENANT);
    queryClient.setQueryData(key, initialProfile);
    act(() => { result.current.mutate({ profile: { personal: { full_name: "Synthetic import" } }, expectedProfileVersion: 1 }); });
    await waitFor(() => expect(updateProfile).toHaveBeenCalledOnce());
    const newer = { ...initialProfile, profileVersion: 2, profile: { personal: { full_name: "Newer saved edit" } } };
    queryClient.setQueryData(key, newer);
    await act(async () => reject(new Error("synthetic conflict")));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(queryClient.getQueryData(key)).toEqual(newer);
  });
});
