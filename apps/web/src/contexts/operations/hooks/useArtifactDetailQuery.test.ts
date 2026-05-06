import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useArtifactDetailQuery } from "./useArtifactDetailQuery.js";

describe("useArtifactDetailQuery", () => {
  it("returns the mocked artifact detail", async () => {
    const { result } = renderHookWithProviders(() => useArtifactDetailQuery("artifact-9"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.artifact.artifactId).toBe("artifact-9");
  });
});
