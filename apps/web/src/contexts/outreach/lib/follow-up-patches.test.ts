import type { OutreachThreadResponse } from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

import {
  makeOutreachFollowUp,
  makeOutreachThreadResponse,
} from "../../../test/fixtures/outreach.js";
import {
  currentFollowUpOf,
  markThreadSentInThread,
  setThreadFollowUpInThread,
} from "./follow-up-patches.js";

function threadOf(value: unknown) {
  return (value as OutreachThreadResponse).thread;
}

describe("markThreadSentInThread", () => {
  it("appends a send log and flips the thread to sent (INV-1)", () => {
    const next = markThreadSentInThread(makeOutreachThreadResponse(), {
      draftId: "draft-2",
      channel: "email",
      sentAt: "2026-07-07",
    });
    const thread = threadOf(next);
    expect(thread?.sendLogs).toHaveLength(1);
    expect(thread?.sendLogs[0]?.channel).toBe("email");
    expect(thread?.sendLogs[0]?.draftId).toBe("draft-2");
    expect(thread?.isSent).toBe(true);
  });

  it("ignores non-thread cache values", () => {
    expect(
      markThreadSentInThread(undefined, { draftId: "d", channel: "email", sentAt: "2026-07-07" }),
    ).toBeUndefined();
    expect(
      markThreadSentInThread(makeOutreachThreadResponse(null), {
        draftId: "d",
        channel: "email",
        sentAt: "2026-07-07",
      }),
    ).toEqual(makeOutreachThreadResponse(null));
  });
});

describe("setThreadFollowUpInThread", () => {
  it("sets the thread follow-up schedule", () => {
    const followUp = makeOutreachFollowUp({ state: "scheduled", dueAt: "2026-07-20" });
    const next = setThreadFollowUpInThread(makeOutreachThreadResponse(), followUp);
    expect(threadOf(next)?.followUp).toEqual(followUp);
  });

  it("clears the follow-up when passed null", () => {
    const scheduled = makeOutreachThreadResponse();
    scheduled.thread!.followUp = makeOutreachFollowUp();
    expect(threadOf(setThreadFollowUpInThread(scheduled, null))?.followUp).toBeNull();
  });

  it("ignores non-thread cache values", () => {
    expect(setThreadFollowUpInThread(undefined, null)).toBeUndefined();
  });
});

describe("currentFollowUpOf", () => {
  it("reads the follow-up from a cached thread response", () => {
    const followUp = makeOutreachFollowUp({ state: "scheduled" });
    const response = makeOutreachThreadResponse();
    response.thread!.followUp = followUp;
    expect(currentFollowUpOf(response)).toEqual(followUp);
  });

  it("returns null for a missing or non-thread value", () => {
    expect(currentFollowUpOf(makeOutreachThreadResponse(null))).toBeNull();
    expect(currentFollowUpOf(undefined)).toBeNull();
  });
});
