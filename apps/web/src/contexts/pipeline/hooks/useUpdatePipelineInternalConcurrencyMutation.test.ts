import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { waitFor } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { sampleSettingsResponse } from "../../../test/fixtures/projections.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { settingsKeys } from "../../operations/settingsKeys.js";
import { useUpdatePipelineInternalConcurrencyMutation } from "./useUpdatePipelineInternalConcurrencyMutation.js";

describe("useUpdatePipelineInternalConcurrencyMutation", () => {
  it("optimistically patches the canonical settings cache", async () => {
    let releaseResponse: (() => void) | undefined;
    const responseGate = new Promise<void>((resolve) => {
      releaseResponse = resolve;
    });
    server.use(
      http.patch("*/v1/settings", async () => {
        await responseGate;
        return HttpResponse.json({
          ...sampleSettingsResponse,
          settings: {
            ...sampleSettingsResponse.settings,
            pipelineInternalConcurrency: 7,
          },
        });
      }),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useUpdatePipelineInternalConcurrencyMutation(),
    );
    const key = settingsKeys.settings(LOCAL_TENANT);
    queryClient.setQueryData(key, sampleSettingsResponse);

    act(() => result.current.mutate(7));
    await waitFor(() =>
      expect(
        (queryClient.getQueryData(key) as typeof sampleSettingsResponse).settings
          .pipelineInternalConcurrency,
      ).toBe(7),
    );
    releaseResponse?.();
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.settings.pipelineInternalConcurrency).toBe(7);
  });

  it("rolls back the optimistic patch when saving fails", async () => {
    server.use(
      http.patch("*/v1/settings", () => new HttpResponse(null, { status: 500 })),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useUpdatePipelineInternalConcurrencyMutation(),
    );
    const key = settingsKeys.settings(LOCAL_TENANT);
    queryClient.setQueryData(key, sampleSettingsResponse);

    act(() => result.current.mutate(9));
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(queryClient.getQueryData(key)).toEqual(sampleSettingsResponse);
  });
});
