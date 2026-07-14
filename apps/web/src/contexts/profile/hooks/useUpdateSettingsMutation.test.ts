import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { profileKeys } from "../queryKeys.js";
import { useUpdateSettingsMutation } from "./useUpdateSettingsMutation.js";

describe("useUpdateSettingsMutation", () => {
  it("returns the mocked settings response after submit", async () => {
    const { result } = renderHookWithProviders(() => useUpdateSettingsMutation());
    await act(async () => {
      result.current.mutate({ dailyBudgetUsd: 30 });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.settings.dailyBudgetUsd).toBe(25);
  });

  it("rolls back the optimistic settings when the PATCH fails", async () => {
    server.use(
      http.patch("*/v1/settings", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() => useUpdateSettingsMutation());
    queryClient.setQueryData(profileKeys.settings(LOCAL_TENANT), sampleSettingsResponse);

    await act(async () => {
      result.current.mutate({ dailyBudgetUsd: 999 });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    const restored = queryClient.getQueryData(profileKeys.settings(LOCAL_TENANT)) as {
      settings: { dailyBudgetUsd: number };
    };
    expect(restored.settings.dailyBudgetUsd).toBe(25);
  });
});
