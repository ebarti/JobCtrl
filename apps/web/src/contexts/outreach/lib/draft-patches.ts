import type {
  OutreachDraftDto,
  OutreachDraftStatus,
  OutreachThreadDetail,
  OutreachThreadResponse,
} from "@jobctrl/contracts";

function isThreadResponse(value: unknown): value is OutreachThreadResponse {
  return typeof value === "object" && value !== null && "thread" in value;
}

function latestStatusOf(drafts: readonly OutreachDraftDto[]): OutreachDraftStatus | null {
  if (drafts.length === 0) {
    return null;
  }
  return drafts.reduce((latest, draft) =>
    draft.generation >= latest.generation ? draft : latest,
  ).status;
}

/**
 * Optimistically approve a candidate draft in the cached by-contact thread: the
 * target candidate flips to `approved`, and the previously-approved draft is
 * superseded (INV-5 — exactly one approved draft; the prior one is retained as
 * history, never destroyed). The server response and SSE reconcile authority; a
 * failed approve rolls this back via the optimistic-mutation helper.
 */
export function approveDraftInThread(current: unknown, draftId: string): unknown {
  if (!isThreadResponse(current) || !current.thread) {
    return current;
  }
  const thread: OutreachThreadDetail = current.thread;
  const target = thread.drafts.find((draft) => draft.draftId === draftId);
  if (!target || target.status !== "candidate") {
    return current;
  }
  const drafts = thread.drafts.map((draft) => {
    if (draft.draftId === draftId) {
      return { ...draft, status: "approved" as const };
    }
    if (draft.status === "approved") {
      return { ...draft, status: "superseded" as const };
    }
    return draft;
  });
  return {
    ...current,
    thread: {
      ...thread,
      drafts,
      hasApprovedDraft: true,
      approvedDraftId: draftId,
      latestStatus: latestStatusOf(drafts),
    },
  };
}

/**
 * Optimistically reject a candidate draft in the cached by-contact thread: the
 * target candidate flips to `rejected` and any approved draft is LEFT UNTOUCHED
 * (INV-5 — rejecting a re-draft never removes the last approved message). Rolls
 * back on failure via the optimistic-mutation helper.
 */
export function rejectDraftInThread(current: unknown, draftId: string): unknown {
  if (!isThreadResponse(current) || !current.thread) {
    return current;
  }
  const thread: OutreachThreadDetail = current.thread;
  const target = thread.drafts.find((draft) => draft.draftId === draftId);
  if (!target || target.status !== "candidate") {
    return current;
  }
  const drafts = thread.drafts.map((draft) =>
    draft.draftId === draftId ? { ...draft, status: "rejected" as const } : draft,
  );
  return {
    ...current,
    thread: { ...thread, drafts, latestStatus: latestStatusOf(drafts) },
  };
}
