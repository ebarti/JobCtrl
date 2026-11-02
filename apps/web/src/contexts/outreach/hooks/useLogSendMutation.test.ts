import type { LogOutreachSendResponse, OutreachThreadResponse } from "@jobctrl/contracts";
import { LOCAL_TENANT } from "@jobctrl/domain-types";
import { useQuery, type QueryClient } from "@tanstack/react-query";
import { http, HttpResponse } from "msw";
import { waitFor } from "@testing-library/react";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

import { makeOutreachThreadResponse, makeOutreachThreadDetail, makeOutreachDraft, makeOutreachSendLog, makeOutreachFollowUp } from "../../../test/fixtures/outreach.js";
import { server } from "../../../test/msw/server.js";
import { createTestQueryClient, renderHookWithProviders } from "../../../test/render.js";
import { outreachKeys } from "../queryKeys.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { useLogSendMutation } from "./useLogSendMutation.js";
import { useScheduleFollowUpMutation } from "./useScheduleFollowUpMutation.js";

function thread(queryClient: QueryClient) {
  const data = queryClient.getQueryData(
    outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null),
  ) as OutreachThreadResponse | undefined;
  return data?.thread;
}

const sendVariables = { requestId: "11720000-0000-4000-8000-000000000001", draftId: "draft-2", channel: "email", sentAt: "2026-07-07" } as const;

describe("useLogSendMutation", () => {
  for (const startFirst of ["followUp", "send"] as const) {
    for (const settleFirst of ["followUp", "send"] as const) {
      for (const sendOutcome of ["success", "failure"] as const) {
        it(`preserves send and follow-up ownership when ${startFirst} starts first, ${settleFirst} settles first, and send is ${sendOutcome}`, async () => {
          let rejectFollowUp!: (error: Error) => void;
          let resolveSend!: (value: LogOutreachSendResponse) => void;
          let rejectSend!: (error: Error) => void;
          const scheduleOutreachFollowUp = vi.fn(() => new Promise<OutreachThreadResponse>((_resolve, reject) => {
            rejectFollowUp = reject;
          }));
          const logOutreachSend = vi.fn(() => new Promise<LogOutreachSendResponse>((resolve, reject) => {
            resolveSend = resolve;
            rejectSend = reject;
          }));
          const acceptedLog = makeOutreachSendLog({ sendLogId: "accepted-synthetic" });
          const queryClient = createTestQueryClient();
          const key = outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null);
          const baseline = makeOutreachThreadResponse();
          queryClient.setQueryData(key, baseline);
          let reads = 0;
          const { result } = renderHookWithProviders(() => ({
            followUp: useScheduleFollowUpMutation("thread-1", "contact-1"),
            send: useLogSendMutation("thread-1", "contact-1"),
            query: useQuery<OutreachThreadResponse>({ queryKey: key, queryFn: async () => {
              reads += 1;
              if (reads === 1) return new Promise<OutreachThreadResponse>(() => {});
              throw new Error("Synthetic reconciliation failure");
            } }),
          }), { queryClient, ports: buildTestPorts({ api: { scheduleOutreachFollowUp, logOutreachSend } }) });

          const start = async (operation: typeof startFirst) => {
            if (operation === "followUp") {
              act(() => result.current.followUp.mutate({ dueAt: "2030-01-01", basis: "manual" }));
              await waitFor(() => expect(scheduleOutreachFollowUp).toHaveBeenCalledTimes(1));
            } else {
              act(() => result.current.send.mutate(sendVariables));
              await waitFor(() => expect(logOutreachSend).toHaveBeenCalledTimes(1));
            }
          };
          await start(startFirst);
          // The second mutation must cancel an actual in-flight reconciliation
          // without surrendering an unchanged optimistic publication.
          void queryClient.refetchQueries({ queryKey: key, exact: true });
          await waitFor(() => expect(reads).toBe(1));
          await start(startFirst === "followUp" ? "send" : "followUp");
          expect(thread(queryClient)?.followUp?.dueAt).toBe("2030-01-01");
          expect(thread(queryClient)?.sendLogs[0]?.sendLogId).toBe(`optimistic-send:${sendVariables.requestId}`);

          const settle = async (operation: typeof settleFirst) => {
            if (operation === "followUp") {
              act(() => rejectFollowUp(new Error("Synthetic follow-up failure")));
              await waitFor(() => expect(result.current.followUp.isError).toBe(true));
            } else {
              act(() => {
                if (sendOutcome === "success") resolveSend({ ok: true, sendLog: acceptedLog });
                else rejectSend(new Error("Synthetic send-log failure"));
              });
              await waitFor(() => expect(result.current.send.status).toBe(sendOutcome === "success" ? "success" : "error"));
            }
          };
          await settle(settleFirst);
          expect(thread(queryClient)?.followUp?.dueAt ?? null).toBe(settleFirst === "followUp" ? null : "2030-01-01");
          expect(thread(queryClient)?.sendLogs.map((log) => log.sendLogId)).toEqual(
            settleFirst === "followUp" ? [`optimistic-send:${sendVariables.requestId}`]
              : sendOutcome === "success" ? [acceptedLog.sendLogId] : [],
          );
          await settle(settleFirst === "followUp" ? "send" : "followUp");
          await waitFor(() => expect(result.current.query.isRefetchError).toBe(true));
          expect(reads).toBeGreaterThan(1);
          expect(thread(queryClient)?.followUp).toEqual(baseline.thread?.followUp);
          expect(thread(queryClient)?.sendLogs).toEqual(sendOutcome === "success" ? [acceptedLog] : []);
          expect(thread(queryClient)?.isSent).toBe(sendOutcome === "success");
        });
      }
    }
  }

  it("keeps a newer follow-up while the earlier send's read is deferred and the final refresh fails", async () => {
    let resolveSend!: (value: LogOutreachSendResponse) => void;
    let resolveFollowUp!: (value: OutreachThreadResponse) => void;
    const logOutreachSend = vi.fn(() => new Promise<LogOutreachSendResponse>((resolve) => { resolveSend = resolve; }));
    const scheduleOutreachFollowUp = vi.fn(() => new Promise<OutreachThreadResponse>((resolve) => { resolveFollowUp = resolve; }));
    const acceptedLog = makeOutreachSendLog({ sendLogId: "accepted-synthetic" });
    const canonical = makeOutreachThreadResponse(makeOutreachThreadDetail({ sendLogs: [acceptedLog] }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null);
    queryClient.setQueryData(key, makeOutreachThreadResponse());
    let reads = 0;
    let failReads = false;
    const { result } = renderHookWithProviders(() => ({
      send: useLogSendMutation("thread-1", "contact-1"),
      followUp: useScheduleFollowUpMutation("thread-1", "contact-1"),
      query: useQuery<OutreachThreadResponse>({ queryKey: key, queryFn: async () => {
        reads += 1;
        if (failReads) throw new Error("Synthetic reconciliation failure");
        return canonical;
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { logOutreachSend, scheduleOutreachFollowUp } }) });
    act(() => result.current.send.mutate(sendVariables));
    await waitFor(() => expect(logOutreachSend).toHaveBeenCalledTimes(1));
    act(() => result.current.followUp.mutate({ dueAt: "2030-01-01", basis: "manual" }));
    await waitFor(() => expect(scheduleOutreachFollowUp).toHaveBeenCalledTimes(1));
    act(() => resolveSend({ ok: true, sendLog: acceptedLog }));
    await waitFor(() => expect(result.current.send.isSuccess).toBe(true));
    expect(reads).toBe(0);
    expect(thread(queryClient)?.sendLogs).toEqual([acceptedLog]);
    expect(thread(queryClient)?.followUp?.dueAt).toBe("2030-01-01");
    failReads = true;
    act(() => resolveFollowUp(makeOutreachThreadResponse(makeOutreachThreadDetail({
      sendLogs: [acceptedLog], followUp: makeOutreachFollowUp({ dueAt: "2030-01-01", basis: "manual" }),
    }))));
    await waitFor(() => expect(result.current.followUp.isSuccess).toBe(true));
    await waitFor(() => expect(result.current.query.isRefetchError).toBe(true));
    expect(reads).toBeGreaterThan(0);
    expect(thread(queryClient)?.sendLogs).toEqual([acceptedLog]);
    expect(thread(queryClient)?.followUp?.dueAt).toBe("2030-01-01");
  });

  it("keeps a newer canonical thread when both older writes and reconciliation fail", async () => {
    let rejectFollowUp!: (error: Error) => void;
    let rejectSend!: (error: Error) => void;
    const scheduleOutreachFollowUp = vi.fn(() => new Promise<OutreachThreadResponse>((_resolve, reject) => { rejectFollowUp = reject; }));
    const logOutreachSend = vi.fn(() => new Promise<LogOutreachSendResponse>((_resolve, reject) => { rejectSend = reject; }));
    const queryClient = createTestQueryClient();
    const key = outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null);
    queryClient.setQueryData(key, makeOutreachThreadResponse());
    const { result } = renderHookWithProviders(() => ({
      followUp: useScheduleFollowUpMutation("thread-1", "contact-1"),
      send: useLogSendMutation("thread-1", "contact-1"),
      query: useQuery<OutreachThreadResponse>({ queryKey: key, queryFn: async () => {
        throw new Error("Synthetic reconciliation failure");
      } }),
    }), { queryClient, ports: buildTestPorts({ api: { scheduleOutreachFollowUp, logOutreachSend } }) });
    act(() => result.current.followUp.mutate({ dueAt: "2030-01-01" }));
    await waitFor(() => expect(scheduleOutreachFollowUp).toHaveBeenCalledTimes(1));
    act(() => result.current.send.mutate(sendVariables));
    await waitFor(() => expect(logOutreachSend).toHaveBeenCalledTimes(1));
    const canonical = makeOutreachThreadResponse(makeOutreachThreadDetail({
      followUp: makeOutreachFollowUp({ dueAt: "2032-01-01" }),
      sendLogs: [makeOutreachSendLog({ sendLogId: "newer-canonical" })],
    }));
    act(() => queryClient.setQueryData(key, canonical));
    act(() => rejectFollowUp(new Error("Synthetic follow-up failure")));
    await waitFor(() => expect(result.current.followUp.isError).toBe(true));
    act(() => rejectSend(new Error("Synthetic send-log failure")));
    await waitFor(() => expect(result.current.send.isError).toBe(true));
    await waitFor(() => expect(result.current.query.isRefetchError).toBe(true));
    expect(queryClient.getQueryData(key)).toEqual(canonical);
  });

  it.each(["success", "failure"] as const)("preserves a replacement thread during deferred cancellation and after the original send's %s", async (outcome) => {
    let finishCancellation!: () => void;
    const cancellation = new Promise<void>((resolve) => { finishCancellation = resolve; });
    let accept!: (value: LogOutreachSendResponse) => void;
    let reject!: (error: Error) => void;
    const request = new Promise<LogOutreachSendResponse>((resolve, fail) => { accept = resolve; reject = fail; });
    const logOutreachSend = vi.fn(() => request);
    const { result, queryClient } = renderHookWithProviders(() => useLogSendMutation("thread-1", "contact-1"), {
      ports: buildTestPorts({ api: { logOutreachSend } }),
    });
    const key = outreachKeys.threadForContact(LOCAL_TENANT, "contact-1", null);
    queryClient.setQueryData(key, makeOutreachThreadResponse());
    const cancel = vi.spyOn(queryClient, "cancelQueries").mockImplementationOnce(() => cancellation);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    await act(async () => { result.current.mutate(sendVariables); });
    await waitFor(() => expect(cancel).toHaveBeenCalledWith({ queryKey: key, exact: true }));
    expect(logOutreachSend).not.toHaveBeenCalled();

    queryClient.setQueryData(key, makeOutreachThreadResponse(makeOutreachThreadDetail({
      threadId: "thread-replacement",
      drafts: [makeOutreachDraft({ threadId: "thread-replacement", draftId: "replacement-draft" })],
      followUp: makeOutreachFollowUp({ dueAt: "2030-01-01" }),
      updatedAt: "2030-01-01",
    })));
    const replacement = queryClient.getQueryData(key);
    await act(async () => { finishCancellation(); });
    await waitFor(() => expect(logOutreachSend).toHaveBeenCalledWith("thread-1", sendVariables));
    const whileRequestPending = queryClient.getQueryData(key);
    await act(async () => {
      if (outcome === "success") accept({ ok: true, sendLog: makeOutreachSendLog() });
      else reject(new Error("Synthetic uncertain send-log response"));
    });
    await waitFor(() => expect(result.current.status).toBe(outcome === "success" ? "success" : "error"));

    expect(whileRequestPending).toBe(replacement);
    expect(queryClient.getQueryData(key)).toBe(replacement);
    expect(thread(queryClient)?.sendLogs).toEqual([]);
    expect(thread(queryClient)?.isSent).toBe(false);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: key });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: outreachKeys.thread(LOCAL_TENANT, "thread-1") });
  });

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
