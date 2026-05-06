import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useOpenArtifactMutation } from "./useOpenArtifactMutation.js";

describe("useOpenArtifactMutation", () => {
  it("invokes the open endpoint and returns the artifact path", async () => {
    const { result } = renderHookWithProviders(() => useOpenArtifactMutation());
    await act(async () => {
      result.current.mutate({ artifactId: "artifact-9" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.opened).toBe(true);
    expect(result.current.data?.path).toMatch(/artifact-9/);
  });

  it("reports error when the open endpoint fails", async () => {
    server.use(
      http.post("*/v1/artifacts/:artifactId/open", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 404 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useOpenArtifactMutation());
    await act(async () => {
      result.current.mutate({ artifactId: "missing" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
