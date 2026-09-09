import type {
  ResumeCommentReplyResponse,
  ResumeCommentThread,
  ResumeReviewDraft,
  TailoringFeedbackSignal,
} from "@jobctrl/contracts";

function timestamp(value: string | null): number {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function stateRank(draft: ResumeReviewDraft): number {
  return draft.state === "promoted" ? 3 : draft.state === "rendered" ? 2 : 1;
}

function mergeThread(
  current: ResumeCommentThread,
  incoming: ResumeCommentThread,
  newerRevision: boolean,
): ResumeCommentThread {
  const incomingIsNewer =
    timestamp(incoming.updatedAt) > timestamp(current.updatedAt) ||
    (timestamp(incoming.updatedAt) === timestamp(current.updatedAt) &&
      (newerRevision ||
        incoming.replies.some(
          (reply) =>
            !current.replies.some((saved) => saved.replyId === reply.replyId),
        )));
  const selected = incomingIsNewer ? incoming : current;
  const replies = new Map(
    current.replies.map((reply) => [reply.replyId, reply]),
  );
  for (const reply of incoming.replies) replies.set(reply.replyId, reply);
  return {
    ...selected,
    replies: [...replies.values()].sort(
      (left, right) => timestamp(left.createdAt) - timestamp(right.createdAt),
    ),
  };
}

function mergeSignals(
  current: readonly TailoringFeedbackSignal[],
  incoming: readonly TailoringFeedbackSignal[],
): TailoringFeedbackSignal[] {
  const signals = new Map(current.map((signal) => [signal.signalId, signal]));
  for (const signal of incoming) {
    const previous = signals.get(signal.signalId);
    if (
      !previous ||
      timestamp(signal.reviewedAt ?? signal.createdAt) >
        timestamp(previous.reviewedAt ?? previous.createdAt) ||
      (signal.reviewedAt !== null && previous.reviewedAt === null)
    ) {
      signals.set(signal.signalId, signal);
    }
  }
  return [...signals.values()];
}

/** Document revisions and comment activity advance independently. */
export function reconcileResumeReviewDraft(
  current: ResumeReviewDraft | undefined,
  incoming: ResumeReviewDraft,
): ResumeReviewDraft {
  if (!current || current.jobKey !== incoming.jobKey) return incoming;
  const feedbackSignals = mergeSignals(
    current.feedbackSignals,
    incoming.feedbackSignals,
  );
  if (current.draftId !== incoming.draftId) {
    // Revision counters restart for each draft. Draft creation time is server
    // metadata; opaque IDs themselves never establish chronological order.
    const difference =
      incoming.baseGeneration - current.baseGeneration ||
      timestamp(incoming.createdAt) - timestamp(current.createdAt);
    return { ...(difference > 0 ? incoming : current), feedbackSignals };
  }
  const difference =
    incoming.latestRevisionNumber - current.latestRevisionNumber ||
    stateRank(incoming) - stateRank(current) ||
    timestamp(incoming.updatedAt) - timestamp(current.updatedAt);
  const selected = difference > 0 ? incoming : current;
  const threads = new Map(
    current.commentThreads.map((thread) => [thread.threadId, thread]),
  );
  for (const thread of incoming.commentThreads) {
    const previous = threads.get(thread.threadId);
    threads.set(
      thread.threadId,
      previous ? mergeThread(previous, thread, difference > 0) : thread,
    );
  }
  return {
    ...selected,
    commentThreads: [...threads.values()],
    feedbackSignals,
  };
}

export function reconcileResumeReviewReply(
  current: ResumeReviewDraft,
  response: ResumeCommentReplyResponse,
): ResumeReviewDraft {
  if (response.thread.jobKey !== current.jobKey) return current;
  // Feedback is job-scoped even when its originating draft was replaced while
  // the reply request was in flight. Only threads belong to one draft.
  if (response.thread.draftId !== current.draftId) {
    return {
      ...current,
      feedbackSignals: mergeSignals(current.feedbackSignals, [
        response.feedbackSignal,
      ]),
    };
  }
  return reconcileResumeReviewDraft(current, {
    ...current,
    commentThreads: [response.thread],
    feedbackSignals: [response.feedbackSignal],
  });
}
