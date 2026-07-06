import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useRunResearchMutation } from "./useRunResearchMutation.js";

describe("useRunResearchMutation", () => {
  it("starts a run and returns the server-minted task id", async () => {
    const { result } = renderHookWithProviders(() => useRunResearchMutation());
    await act(async () => {
      result.current.mutate({
        employer: "Acme",
        sources: [{ category: "public_web_page", url: "https://acme.example/team", label: "" }],
      });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.taskId).toBe("task-new");
    expect(result.current.data?.status).toBe("queued");
  });
});
