import type {
  OutreachFollowUp,
  OutreachSendLogDto,
  OutreachThreadDetail,
  OutreachThreadResponse,
} from "@jobctrl/contracts";

function isThreadResponse(value: unknown): value is OutreachThreadResponse {
  return typeof value === "object" && value !== null && "thread" in value;
}

export interface SendLogPatchInput {
  requestId?: string;
  draftId: string;
  channel: string;
  sentAt: string;
  loggedAt?: string;
}

/**
 * Optimistically record a user-attested send in the cached by-contact thread: a
 * new send log is appended and the thread flips to `isSent` (INV-1 — a thread
 * reaches a sent state ONLY through a user-attested record, never a transmission).
 * The synthetic id is a placeholder; mutation settlement reconciles the
 * authoritative log or removes that placeholder on failure.
 * The by-contact cache may have changed threads while cancellation was pending;
 * only the thread named by the mutation can receive this fact.
 */
export function markThreadSentInThread(current: unknown, log: SendLogPatchInput, expectedThreadId: string): unknown {
  if (!isThreadResponse(current) || !current.thread || current.thread.threadId !== expectedThreadId) {
    return current;
  }
  const thread: OutreachThreadDetail = current.thread;
  const sendLog: OutreachSendLogDto = {
    sendLogId: log.requestId ? `optimistic-send:${log.requestId}` : `optimistic-send:${log.draftId}:${log.sentAt}`,
    threadId: thread.threadId,
    draftId: log.draftId,
    channel: log.channel,
    sentAt: log.sentAt,
    loggedAt: log.loggedAt ?? log.sentAt,
  };
  return {
    ...current,
    thread: { ...thread, sendLogs: [...thread.sendLogs.filter((entry) => entry.sendLogId !== sendLog.sendLogId), sendLog], isSent: true },
  };
}

/**
 * Optimistically set (or clear) the thread's follow-up schedule in the cached
 * by-contact thread. Follow-ups are surfaced-only reminders — a plan, never an
 * action, never a send. Rolls back on failure via the optimistic-mutation helper.
 */
export function setThreadFollowUpInThread(
  current: unknown,
  followUp: OutreachFollowUp | null,
): unknown {
  if (!isThreadResponse(current) || !current.thread) {
    return current;
  }
  return { ...current, thread: { ...current.thread, followUp } };
}

/** Read the thread's current follow-up from a cached by-contact thread response. */
export function currentFollowUpOf(current: unknown): OutreachFollowUp | null {
  if (!isThreadResponse(current) || !current.thread) {
    return null;
  }
  return current.thread.followUp;
}
