import type { OutreachThreadResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import type { QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { makeOutreachThreadResponse, makeOutreachSendLog, makeOutreachFollowUp } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useLogSendMutation } from "./useLogSendMutation.js";

function thread(queryClient: QueryClient) {
  const data = queryClient.getQueryData(
    outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
  ) as OutreachThreadResponse | undefined;
  return data?.thread;
}

const sendVariables = { requestId: "11720000-0000-4000-8000-000000000001", draftId: "draft-2", channel: "email", sentAt: "2026-07-07" } as const;

describe("useLogSendMutation", () => {
  it("reconciles an original result without duplicates or overwriting a later reminder/review", async () => {
    let resolve!: (value: import("@jobctrl/contracts").LogOutreachSendResponse) => void;
    const pending = new Promise<import("@jobctrl/contracts").LogOutreachSendResponse>((done) => { resolve = done; });
    const sendLog = makeOutreachSendLog({ sendLogId: "accepted-original" });
    let resolveRetry!: (value: import("@jobctrl/contracts").LogOutreachSendResponse) => void;
    const retry = new Promise<import("@jobctrl/contracts").LogOutreachSendResponse>((done) => { resolveRetry = done; });
    const logOutreachSend = vi.fn(() => pending).mockImplementationOnce(() => pending).mockImplementationOnce(() => retry);
    const { result, queryClient } = renderHookWithProviders(() => useLogSendMutation("thread-1", "contact-1"), {
      ports: buildTestPorts({ api: { logOutreachSend } }),
    });
    const key = outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null);
    queryClient.setQueryData(key, makeOutreachThreadResponse());
    await act(async () => { result.current.mutate(sendVariables); });
    await waitFor(() => expect(thread(queryClient)?.sendLogs).toHaveLength(1));
    const later = makeOutreachThreadResponse();
    later.thread!.followUp = makeOutreachFollowUp({ dueAt: "2030-01-01" });
    later.thread!.updatedAt = "2030-01-01";
    later.thread!.sendLogs = [sendLog];
    queryClient.setQueryData(key, later);
    await act(async () => { resolve({ ok: true, sendLog }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(thread(queryClient)?.sendLogs).toEqual([sendLog]);
    expect(thread(queryClient)?.followUp?.dueAt).toBe("2030-01-01");
    expect(thread(queryClient)?.updatedAt).toBe("2030-01-01");
    await act(async () => { result.current.mutate(sendVariables); });
    await waitFor(() => expect(logOutreachSend).toHaveBeenCalledTimes(2));
    expect(thread(queryClient)?.sendLogs).toEqual([sendLog]);
    await act(async () => { resolveRetry({ ok: true, sendLog }); });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(thread(queryClient)?.sendLogs).toEqual([sendLog]);
    expect(thread(queryClient)?.followUp?.dueAt).toBe("2030-01-01");
  });

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
