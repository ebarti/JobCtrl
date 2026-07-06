import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useDueFollowUpsQuery } from "./useDueFollowUpsQuery.js";

describe("useDueFollowUpsQuery", () => {
  it("returns the mocked due follow-ups from the read model", async () => {
    const { result } = renderHookWithProviders(() => useDueFollowUpsQuery());
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.[0]?.threadId).toBe("thread-1");
    expect(result.current.data?.[0]?.isDue).toBe(true);
  });

  it("reports an error when the due-follow-ups request fails", async () => {
    server.use(
      http.get("*/v1/outreach/follow-ups/due", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() => useDueFollowUpsQuery());
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
