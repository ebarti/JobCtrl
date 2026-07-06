import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { useReviseDraftMutation } from "./useReviseDraftMutation.js";

describe("useReviseDraftMutation", () => {
  it("revises the draft from edited text and returns the re-gated thread", async () => {
    const { result } = renderHookWithProviders(() =>
      useReviseDraftMutation("thread-1", "contact-1"),
    );
    await act(async () => {
      result.current.mutate({ editedBodyText: "Hi Dana, an edited intro message." });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.thread?.threadId).toBe("thread-1");
  });

  it("surfaces an error when the revision fails", async () => {
    server.use(
      http.post("*/v1/outreach/threads/:threadId/drafts", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result } = renderHookWithProviders(() =>
      useReviseDraftMutation("thread-1", "contact-1"),
    );
    await act(async () => {
      result.current.mutate({ editedBodyText: "Hi Dana, an edited intro message." });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
