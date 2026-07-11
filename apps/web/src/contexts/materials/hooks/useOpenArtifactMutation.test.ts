import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { buildTestPorts, FakeOpenInOsPort } from "../../../test/testPorts.js";
import { useOpenArtifactMutation } from "./useOpenArtifactMutation.js";

describe("useOpenArtifactMutation", () => {
  it("invokes the open endpoint and returns the artifact path", async () => {
    const openInOs = new FakeOpenInOsPort();
    const { result } = renderHookWithProviders(() => useOpenArtifactMutation(), {
      ports: buildTestPorts({ openInOs }),
    });
    await act(async () => {
      result.current.mutate({ artifactId: "artifact-9" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.opened).toBe(true);
    expect(result.current.data?.path).toMatch(/artifact-9/);
    expect(openInOs.open).toHaveBeenCalledWith("artifact-9");
  });

  it("reports error when the open endpoint fails", async () => {
    const error = new Error("preview blocked");
    const openInOs = { open: vi.fn(async () => Promise.reject(error)) };
    const { result } = renderHookWithProviders(() => useOpenArtifactMutation(), {
      ports: buildTestPorts({ openInOs }),
    });
    await act(async () => {
      result.current.mutate({ artifactId: "missing" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
