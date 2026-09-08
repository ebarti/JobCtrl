import type {
  ResumeCommentThread,
  ResumeReviewDraft,
  TailoringFeedbackSignal,
} from "@jobctrl/contracts";
import { describe, expect, it } from "vitest";

import {
  reconcileResumeReviewDraft,
  reconcileResumeReviewReply,
} from "./reconcileResumeReviewDraft.js";

const time = "2026-09-06T10:00:00.000Z";
const thread: ResumeCommentThread = {
  threadId: "thread-1",
  draftId: "draft-1",
  jobKey: "job-1",
  baseArtifactId: null,
  semanticId: null,
  lineAnchor: null,
  sourcePinId: null,
  riskLabel: "claim risk",
  commentBody: "Check evidence",
  state: "open",
  anchorResolved: true,
  createdAt: time,
  updatedAt: time,
  replies: [],
};
const draft: ResumeReviewDraft = {
  draftId: "draft-1",
  jobKey: "job-1",
  baseGeneration: 1,
  baseResumeTextArtifactId: "accepted-1",
  baseResumePdfArtifactId: null,
  rendererFormat: "html_css",
  state: "active",
  currentRevisionId: "revision-1",
  latestRevisionNumber: 1,
  createdAt: time,
  updatedAt: time,
  latestRevision: {
    revisionId: "revision-1",
    draftId: "draft-1",
    jobKey: "job-1",
    revisionNumber: 1,
    editedText: "Saved evidence",
    plateDocument: [
      { type: "p", children: [{ text: "Saved evidence", bold: true }] },
    ],
    editDeltas: [],
    createdAt: time,
  },
  commentThreads: [thread],
  feedbackSignals: [],
};
const signal: TailoringFeedbackSignal = {
  signalId: "signal-1",
  jobKey: "job-1",
  draftId: "draft-1",
  draftRevisionId: "revision-1",
  sourceKind: "comment_reply",
  sourceId: "reply-1",
  kind: "factual_correction",
  status: "candidate",
  summary: "Corrected",
  section: null,
  semanticId: null,
  createdAt: time,
  reviewedAt: null,
};

describe("saved resume draft reconciliation", () => {
  it("keeps the highest revision and its rendered state through reversed full responses", () => {
    const rendered = {
      ...draft,
      latestRevisionNumber: 2,
      state: "rendered" as const,
    };
    for (const older of [
      draft,
      { ...draft, latestRevisionNumber: 0, latestRevision: null },
      {
        ...rendered,
        state: "active" as const,
        updatedAt: "2026-09-25T10:00:00.000Z",
      },
    ]) {
      const result = reconcileResumeReviewDraft(rendered, older);
      expect(result.latestRevisionNumber).toBe(2);
      expect(result.state).toBe("rendered");
      expect(result.latestRevision).toBe(rendered.latestRevision);
    }
    expect(
      reconcileResumeReviewDraft(rendered, {
        ...draft,
        latestRevisionNumber: 3,
      }).latestRevisionNumber,
    ).toBe(3);
  });

  it("orders distinct drafts by base generation then server creation time, never revision or opaque id", () => {
    const old = { ...draft, latestRevisionNumber: 9 };
    const replacement = { ...draft, draftId: "aaa-new", baseGeneration: 2 };
    expect(reconcileResumeReviewDraft(old, replacement).draftId).toBe(
      "aaa-new",
    );
    expect(reconcileResumeReviewDraft(replacement, old).draftId).toBe(
      "aaa-new",
    );
    const sameGeneration = {
      ...draft,
      draftId: "aaa-later",
      createdAt: "2026-09-06T11:00:00.000Z",
    };
    expect(reconcileResumeReviewDraft(old, sameGeneration).draftId).toBe(
      "aaa-later",
    );
    expect(reconcileResumeReviewDraft(sameGeneration, old).draftId).toBe(
      "aaa-later",
    );
    expect(
      reconcileResumeReviewDraft(draft, { ...draft, draftId: "zzz-tied" })
        .draftId,
    ).toBe("draft-1");
  });

  it("preserves independent replies, thread state and feedback after a stale full snapshot", () => {
    const reply = {
      replyId: "reply-1",
      threadId: thread.threadId,
      draftRevisionId: null,
      author: "user",
      decision: "clarified" as const,
      body: "Corrected",
      createdAt: "2026-09-06T10:01:00.000Z",
    };
    const replied = reconcileResumeReviewReply(draft, {
      ok: true,
      reply,
      feedbackSignal: signal,
      thread: {
        ...thread,
        state: "user_replied",
        updatedAt: reply.createdAt,
        replies: [reply],
      },
    });
    const stale = reconcileResumeReviewDraft(replied, draft);
    expect(stale.commentThreads[0]?.replies).toEqual([reply]);
    expect(stale.commentThreads[0]?.state).toBe("user_replied");
    expect(stale.feedbackSignals).toEqual([signal]);
    const reviewedSignal = {
      ...signal,
      status: "accepted" as const,
      reviewedAt: "2026-09-06T11:00:00.000Z",
    };
    const reviewed = reconcileResumeReviewDraft(stale, {
      ...draft,
      feedbackSignals: [reviewedSignal],
    });
    expect(
      reconcileResumeReviewDraft(reviewed, replied).feedbackSignals,
    ).toEqual([reviewedSignal]);
    const second = {
      ...reply,
      replyId: "reply-2",
      createdAt: "2026-09-06T10:02:00.000Z",
    };
    const independent = reconcileResumeReviewDraft(stale, {
      ...draft,
      commentThreads: [
        {
          ...thread,
          updatedAt: second.createdAt,
          state: "user_replied",
          replies: [second],
        },
      ],
    });
    expect(
      independent.commentThreads[0]?.replies.map((item) => item.replyId),
    ).toEqual(["reply-1", "reply-2"]);
  });

  it("retains a late old-draft reply as job feedback without reviving its thread", () => {
    const replacement = {
      ...draft,
      draftId: "draft-2",
      baseGeneration: 2,
      commentThreads: [],
    };
    const reply = {
      replyId: "reply-1",
      threadId: thread.threadId,
      draftRevisionId: null,
      author: "user",
      decision: "clarified" as const,
      body: "Correction",
      createdAt: time,
    };
    const result = reconcileResumeReviewReply(replacement, {
      ok: true,
      reply,
      feedbackSignal: signal,
      thread: { ...thread, state: "user_replied", replies: [reply] },
    });
    expect(result.draftId).toBe("draft-2");
    expect(result.commentThreads).toEqual([]);
    expect(result.feedbackSignals).toEqual([signal]);
  });

  it("never mixes thread identities across replacement drafts or jobs", () => {
    const replacement = {
      ...draft,
      draftId: "draft-2",
      baseGeneration: 2,
      commentThreads: [],
    };
    expect(
      reconcileResumeReviewDraft(draft, replacement).commentThreads,
    ).toEqual([]);
    expect(
      reconcileResumeReviewDraft(replacement, draft).commentThreads,
    ).toEqual([]);
    expect(
      reconcileResumeReviewDraft(draft, {
        ...draft,
        jobKey: "other",
        commentThreads: [],
      }).commentThreads,
    ).toEqual([]);
  });
});
