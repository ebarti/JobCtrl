import { LOCAL_TENANT } from "@jobhunter/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { compensationKeys } from "../compensationKeys.js";
import { useCompensationSourcePolicyQuery } from "./useCompensationSourcePolicyQuery.js";

describe("useCompensationSourcePolicyQuery", () => {
  it("returns compensation source policies through an Operations-owned query key", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useCompensationSourcePolicyQuery(),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.sources.map((source) => source.sourceId)).toEqual([
      "manual_reported_compensation",
      "levels_fyi",
      "glassdoor",
    ]);
    expect(queryClient.getQueryData(compensationKeys.sources(LOCAL_TENANT))).toBe(result.current.data);
  });

  it("propagates API errors", async () => {
    server.use(
      http.get("*/v1/compensation/sources", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 503 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useCompensationSourcePolicyQuery());

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
