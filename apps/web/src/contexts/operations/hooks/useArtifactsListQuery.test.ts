import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { createTestQueryClient } from "../../../test/render.js";
import { prefetchArtifactsList } from "../readQueries.js";
import { artifactsKeys } from "../artifactsKeys.js";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { JobCtrlApiClient } from "@jobctrl/api-client";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useArtifactsListQuery } from "./useArtifactsListQuery.js";

describe("useArtifactsListQuery", () => {
  it("returns the mocked artifacts page", async () => {
    const api = new JobCtrlApiClient();
    const { result } = renderHookWithProviders(
      () => useArtifactsListQuery({}),
      {
        ports: buildTestPorts({
          api: { artifacts: (query) => api.artifacts(query) },
        }),
      },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.artifactId).toBe("resume-text-draft");
  });

  it("propagates 500 errors", async () => {
    const api = new JobCtrlApiClient();
    server.use(
      http.get(
        "*/v1/artifacts",
        () => new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(
      () => useArtifactsListQuery({}),
      {
        ports: buildTestPorts({
          api: { artifacts: (query) => api.artifacts(query) },
        }),
      },
    );
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});

it("shares the loader page while retaining disabled and 60-second observer freshness", async () => {
  const ports = buildTestPorts();
  const queryClient = createTestQueryClient();
  await prefetchArtifactsList(
    { ports, queryClient, tenantId: LOCAL_TENANT },
    {},
  );
  const accepted = queryClient.getQueryData(
    artifactsKeys.list(LOCAL_TENANT, {}),
  );
  const { result, rerender } = renderHookWithProviders(
    ({ enabled }) => useArtifactsListQuery({}, { enabled }),
    { ports, queryClient, initialProps: { enabled: false } },
  );
  expect(result.current.data).toEqual(accepted);
  expect(result.current.fetchStatus).toBe("idle");
  rerender({ enabled: true });
  await waitFor(() => expect(result.current.isSuccess).toBe(true));
  expect(result.current.isStale).toBe(false);
  expect(result.current.data).toEqual(accepted);
});
