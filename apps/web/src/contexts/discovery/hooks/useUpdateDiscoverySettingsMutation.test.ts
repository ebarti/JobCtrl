import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { act } from "react";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { sampleDiscoverySettingsResponse } from "../../../test/fixtures/projections.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { discoveryKeys } from "../queryKeys.js";
import { useUpdateDiscoverySettingsMutation } from "./useUpdateDiscoverySettingsMutation.js";

describe("useUpdateDiscoverySettingsMutation", () => {
  it("rolls back settings and effective metadata when the write fails", async () => {
    server.use(http.patch("*/v1/discovery/settings", () =>
      new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
    ));
    const baseline = deepFreeze(structuredClone(sampleDiscoverySettingsResponse));
    const metadataBefore = structuredClone(baseline.effectiveSettings.maxParallelFamilies);
    const { result, queryClient } = renderHookWithProviders(
      () => useUpdateDiscoverySettingsMutation(),
    );
    queryClient.setQueryData(discoveryKeys.settings(LOCAL_TENANT), baseline);
    expect(baseline.effectiveSettings.maxParallelFamilies).toEqual(metadataBefore);

    await act(async () => {
      result.current.mutate({ maxParallelFamilies: 3 });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));

    expect(queryClient.getQueryData(discoveryKeys.settings(LOCAL_TENANT))).toEqual(
      baseline,
    );
    expect(baseline.effectiveSettings.maxParallelFamilies).toEqual(metadataBefore);
    expect(
      (queryClient.getQueryData(discoveryKeys.settings(LOCAL_TENANT)) as typeof baseline)
        .effectiveSettings.maxParallelFamilies,
    ).toEqual(metadataBefore);
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}
