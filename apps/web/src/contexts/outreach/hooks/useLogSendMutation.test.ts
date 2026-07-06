import type { OutreachThreadResponse } from "@jobhunter/contracts";
import { LOCAL_TENANT } from "@jobhunter/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it } from "vitest";

import { makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { useLogSendMutation } from "./useLogSendMutation.js";

function thread(queryClient: QueryClient) {
  const data = queryClient.getQueryData(
    outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
  ) as OutreachThreadResponse | undefined;
  return data?.thread;
}

const sendVariables = { draftId: "draft-2", channel: "email", sentAt: "2026-07-07" };

describe("useLogSendMutation", () => {
  it("optimistically records the send and flips the thread to sent (INV-1)", async () => {
    const { result, queryClient } = renderHookWithProviders(() =>
      useLogSendMutation("thread-1", "contact-1"),
    );
    queryClient.setQueryData(
      outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
      makeOutreachThreadResponse(),
    );
    await act(async () => {
      result.current.mutate(sendVariables);
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(thread(queryClient)?.sendLogs).toHaveLength(1);
    expect(thread(queryClient)?.sendLogs[0]?.channel).toBe("email");
    expect(thread(queryClient)?.isSent).toBe(true);
  });

  it("rolls back the optimistic send record when the POST fails", async () => {
    server.use(
      http.post("*/v1/outreach/threads/:threadId/send-logs", () =>
        new HttpResponse(JSON.stringify({ ok: false }), { status: 500 }),
      ),
    );
    const { result, queryClient } = renderHookWithProviders(() =>
      useLogSendMutation("thread-1", "contact-1"),
    );
    queryClient.setQueryData(
      outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
      makeOutreachThreadResponse(),
    );
    await act(async () => {
      result.current.mutate(sendVariables);
    });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(thread(queryClient)?.sendLogs).toHaveLength(0);
    expect(thread(queryClient)?.isSent).toBe(false);
  });
});
