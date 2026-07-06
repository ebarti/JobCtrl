import { describe, expect, it } from "vitest";

import { makeOutreachDraft } from "../../../test/fixtures/outreach.js";
import {
  formatApprovedDraftForClipboard,
  outreachDraftKindLabel,
  outreachDraftStatusLabel,
} from "./draft-copy.js";

describe("formatApprovedDraftForClipboard", () => {
  it("returns the trimmed body while preserving internal line breaks", () => {
    const draft = makeOutreachDraft({
      status: "approved",
      bodyText: "  Hi Dana,\n\nHere is the intro.\n\nBest,\nJordan  ",
    });
    expect(formatApprovedDraftForClipboard(draft)).toBe(
      "Hi Dana,\n\nHere is the intro.\n\nBest,\nJordan",
    );
  });
});

describe("draft labels", () => {
  it("labels every draft status", () => {
    expect(outreachDraftStatusLabel("candidate")).toBe("Under review");
    expect(outreachDraftStatusLabel("approved")).toBe("Approved");
    expect(outreachDraftStatusLabel("rejected")).toBe("Rejected");
    expect(outreachDraftStatusLabel("superseded")).toBe("Superseded");
  });

  it("labels every draft kind", () => {
    expect(outreachDraftKindLabel("intro_request")).toBe("Intro request");
    expect(outreachDraftKindLabel("follow_up")).toBe("Follow-up");
  });
});
