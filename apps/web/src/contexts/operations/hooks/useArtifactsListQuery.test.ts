import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useArtifactsListQuery } from "./useArtifactsListQuery.js";

describe("useArtifactsListQuery", () => {
  it("returns the mocked artifacts page", async () => {
    const { result } = renderHookWithProviders(() => useArtifactsListQuery({}));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.artifactId).toBe("artifact-1");
  });

  it("propagates 500 errors", async () => {
    server.use(
      http.get("*/v1/artifacts", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useArtifactsListQuery({}));
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
