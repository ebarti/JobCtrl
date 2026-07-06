import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useResearchTaskQuery } from "./useResearchTaskQuery.js";

describe("useResearchTaskQuery", () => {
  it("loads a research task with its candidates + source attempts", async () => {
    const { result } = renderHookWithProviders(() => useResearchTaskQuery("task-1"));
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const task = result.current.data?.task;
    expect(task?.taskId).toBe("task-1");
    expect(task?.candidates).toHaveLength(1);
    expect(task?.candidates[0]?.provenance.sourceKind).toBe("public_web_page");
    expect(task?.sourceAttempts.length).toBeGreaterThan(0);
  });

  it("stays idle when no taskId is provided", () => {
    const { result } = renderHookWithProviders(() => useResearchTaskQuery(""));
    expect(result.current.fetchStatus).toBe("idle");
  });
});
