import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { renderHookWithProviders } from "../../../test/render.js";
import { useActivityListQuery } from "./useActivityListQuery.js";

describe("useActivityListQuery", () => {
  it("returns the debug activity page from the API", async () => {
    const { result } = renderHookWithProviders(() =>
      useActivityListQuery({ page: 1, pageSize: 50 }),
    );

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.items[0]?.message).toBe("Job scored 8/10");
    expect(result.current.data?.pagination.pageSize).toBe(50);
  });
});
