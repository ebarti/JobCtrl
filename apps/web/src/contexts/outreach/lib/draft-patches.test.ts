import type { OutreachThreadResponse } from "@jobhunter/contracts";
import { describe, expect, it } from "vitest";

import { makeOutreachThreadResponse } from "../../../test/fixtures/outreach.js";
import { approveDraftInThread, rejectDraftInThread } from "./draft-patches.js";

function draftsOf(value: unknown) {
  return (value as OutreachThreadResponse).thread?.drafts ?? [];
}

describe("approveDraftInThread", () => {
  it("approves the target candidate and supersedes the prior approved draft (INV-5)", () => {
    const next = approveDraftInThread(makeOutreachThreadResponse(), "draft-3");
    const drafts = draftsOf(next);
    expect(drafts.find((draft) => draft.draftId === "draft-3")?.status).toBe("approved");
    expect(drafts.find((draft) => draft.draftId === "draft-2")?.status).toBe("superseded");
    expect(drafts.find((draft) => draft.draftId === "draft-1")?.status).toBe("superseded");
    const thread = (next as OutreachThreadResponse).thread;
    expect(thread?.hasApprovedDraft).toBe(true);
    expect(thread?.approvedDraftId).toBe("draft-3");
    expect(thread?.latestStatus).toBe("approved");
  });

  it("returns the input unchanged when the target is not a candidate", () => {
    const current = makeOutreachThreadResponse();
    expect(approveDraftInThread(current, "draft-2")).toBe(current);
  });

  it("ignores non-thread cache values", () => {
    expect(approveDraftInThread(undefined, "draft-3")).toBeUndefined();
    expect(approveDraftInThread(makeOutreachThreadResponse(null), "draft-3")).toEqual(
      makeOutreachThreadResponse(null),
    );
  });
});

describe("rejectDraftInThread", () => {
  it("rejects the target candidate and leaves the approved draft untouched (INV-5)", () => {
    const next = rejectDraftInThread(makeOutreachThreadResponse(), "draft-3");
    const drafts = draftsOf(next);
    expect(drafts.find((draft) => draft.draftId === "draft-3")?.status).toBe("rejected");
    expect(drafts.find((draft) => draft.draftId === "draft-2")?.status).toBe("approved");
    const thread = (next as OutreachThreadResponse).thread;
    expect(thread?.hasApprovedDraft).toBe(true);
    expect(thread?.approvedDraftId).toBe("draft-2");
  });

  it("returns the input unchanged when the target is not a candidate", () => {
    const current = makeOutreachThreadResponse();
    expect(rejectDraftInThread(current, "draft-1")).toBe(current);
  });
});
