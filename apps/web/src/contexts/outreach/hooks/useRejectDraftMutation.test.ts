import type { OutreachThreadResponse } from "@jobctl/contracts";
import { LOCAL_TENANT } from "@jobctl/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useRejectDraftMutation } from "./useRejectDraftMutation.js";

function drafts(queryClient: QueryClient) {
  const data = queryClient.getQueryData(
    outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
  ) as OutreachThreadResponse | undefined;
  return data?.thread?.drafts ?? [];
}

describe("useRejectDraftMutation", () => {
  it("optimistically rejects the candidate and leaves the approved draft untouched (INV-5)", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useRejectDraftMutation("thread-1", "contact-1"),
    );
    queryClient.setQueryData(
      outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
      makeOutreachThreadResponse(),
    );
    await act(async () => {
      result.current.mutate({ draftId: "draft-3" });
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(drafts(queryClient).find((draft) => draft.draftId === "draft-3")?.status).toBe(
      "rejected",
    );
    expect(drafts(queryClient).find((draft) => draft.draftId === "draft-2")?.status).toBe(
      "approved",
    );
  });

  it("rolls back the optimistic reject when the POST fails", async () => {
    server.use(
      http.post("*/v1/outreach/threads/:threadId/drafts/:draftId/reject", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useRejectDraftMutation("thread-1", "contact-1"),
    );
    queryClient.setQueryData(
      outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
      makeOutreachThreadResponse(),
    );
    await act(async () => {
      result.current.mutate({ draftId: "draft-3" });
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(drafts(queryClient).find((draft) => draft.draftId === "draft-3")?.status).toBe(
      "candidate",
    );
  });
});
