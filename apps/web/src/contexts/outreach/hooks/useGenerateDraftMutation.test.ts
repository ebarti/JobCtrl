import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useGenerateDraftMutation } from "./useGenerateDraftMutation.js";

describe("useGenerateDraftMutation", () => {
  it("generates a draft and returns the full gated thread", async () => {
    const { result } = renderHookWithProviders(() => useGenerateDraftMutation("contact-1"));
    await act(async () => {
      result.current.mutate({});
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.thread?.threadId).toBe("thread-1");
    expect(result.current.data?.thread?.hasApprovedDraft).toBe(true);
  });

  it("surfaces an error and leaves the thread cache untouched when generation fails", async () => {
    server.use(
      http.post("*/v1/contacts/:contactId/outreach/drafts", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useGenerateDraftMutation("contact-1"),
    );
    await act(async () => {
      result.current.mutate({});
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(
      queryClient.getQueryData(outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null)),
    ).toBeUndefined();
  });
});
