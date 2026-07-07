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
import { useApproveDraftMutation } from "./useApproveDraftMutation.js";

function drafts(queryClient: QueryClient) {
  const data = queryClient.getQueryData(
    outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
  ) as OutreachThreadResponse | undefined;
  return data?.thread?.drafts ?? [];
}

describe("useApproveDraftMutation", () => {
  it("optimistically approves the candidate and supersedes the prior approved draft (INV-5)", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useApproveDraftMutation("thread-1", "contact-1"),
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
      "approved",
    );
    expect(drafts(queryClient).find((draft) => draft.draftId === "draft-2")?.status).toBe(
      "superseded",
    );
  });

  it("rolls back the optimistic approve when the POST fails (prior approved draft preserved)", async () => {
    server.use(
      http.post("*/v1/outreach/threads/:threadId/drafts/:draftId/approve", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useApproveDraftMutation("thread-1", "contact-1"),
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
    expect(drafts(queryClient).find((draft) => draft.draftId === "draft-2")?.status).toBe(
      "approved",
    );
  });
});
