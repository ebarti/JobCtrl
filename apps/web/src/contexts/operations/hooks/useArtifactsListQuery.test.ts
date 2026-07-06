import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { FetchApiClientAdapter } from "../../../shared/adapters/local/FetchApiClientAdapter.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useArtifactsListQuery } from "./useArtifactsListQuery.js";

describe("useArtifactsListQuery", () => {
  it("returns the mocked artifacts page", async () => {
    const api = new FetchApiClientAdapter();
    const { result } = renderHookWithProviders(() => useArtifactsListQuery({}), {
      ports: buildTestPorts({ api: { artifacts: (query) => api.artifacts(query) } }),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.artifactId).toBe("resume-text-draft");
  });

  it("propagates 500 errors", async () => {
    const api = new FetchApiClientAdapter();
    server.use(
      http.get("*/v1/artifacts", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useArtifactsListQuery({}), {
      ports: buildTestPorts({ api: { artifacts: (query) => api.artifacts(query) } }),
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
