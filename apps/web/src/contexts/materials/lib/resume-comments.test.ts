import { describe, expect, it } from "vitest";

import { sampleApplyReviewQueue } from "../../../test/fixtures/projections.js";
import type { ResumeCommentThread } from "../../operations/types.js";
import {
  placeResumeCommentThreads,
  seedThreadKey,
  seedThreadsFromPins,
} from "./resume-comments.js";
import { resumePlateLinesFromHtml } from "./resume-document.js";
import { emptyRiskSignals, pinsFromResumeLines } from "./resume-provenance.js";

function thread(
  id: string,
  overrides: Partial<ResumeCommentThread> = {},
): ResumeCommentThread {
  return {
    threadId: id,
    draftId: "draft:1",
    jobKey: sampleApplyReviewQueue.items[0]!.jobKey,
    baseArtifactId: "artifact:1",
    semanticId: null,
    lineAnchor: null,
    sourcePinId: null,
    riskLabel: null,
    commentBody: "Recorded comment",
    state: "open",
    anchorResolved: true,
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:00:00.000Z",
    replies: [],
    ...overrides,
  };
}

describe("resume comment transformations", () => {
  const lines = resumePlateLinesFromHtml(
    '<main class="resume-page"><p data-resume-line-number="1" data-resume-layout-target="claim:1">Repeated</p><p data-resume-line-number="2" data-resume-layout-target="claim:2">Repeated</p></main>',
    [],
  );
  const pins = pinsFromResumeLines(lines, null, []);

  it("uses recorded line, pin, then semantic anchors, preserving unresolved and unmatched threads", () => {
    const byNumber = thread("number", {
      lineAnchor: {
        lineNumber: 2,
        semanticId: "claim:1",
        pageNumber: 1,
        textHash: null,
      },
      sourcePinId: "claim:1",
    });
    const byPin = thread("pin", {
      sourcePinId: "claim:1",
      semanticId: "claim:2",
    });
    const bySemantic = thread("semantic", { semanticId: "claim:2" });
    const unresolved = thread("unresolved", {
      semanticId: "claim:1",
      anchorResolved: false,
    });
    const foreign = thread("foreign", {
      semanticId: "foreign",
      commentBody: "Repeated",
    });
    const placed = placeResumeCommentThreads(lines, pins, [
      byNumber,
      byPin,
      bySemantic,
      unresolved,
      foreign,
    ]);
    expect(placed.commentThreadsByLineIndex.get(0)).toEqual([byPin]);
    expect(placed.commentThreadsByLineIndex.get(1)).toEqual([
      byNumber,
      bySemantic,
    ]);
    expect(placed.unmatchedThreads).toEqual([unresolved, foreign]);
  });

  it("retains unmapped warnings in deterministic bounded seeds with distinct long identifiers", () => {
    const longId = "id:" + "x".repeat(300);
    const pin = {
      ...pins[0]!,
      id: longId,
      sourceId: longId,
      rationale: "Reason ".repeat(900),
    };
    const seeds = seedThreadsFromPins(longId, [pin], emptyRiskSignals());
    expect(seeds).toHaveLength(1);
    const seed = seeds[0]!;
    expect(seed.riskLabel).toBe("no recorded source");
    expect(seed.baseArtifactId).toHaveLength(240);
    expect(seed.sourcePinId).toHaveLength(240);
    expect(seed.semanticId).toHaveLength(240);
    expect(seed.commentBody.length).toBeLessThanOrEqual(4000);
    expect(seed.commentBody).toMatch(/\[truncated\]$/);
    expect(seedThreadsFromPins(longId, [pin], emptyRiskSignals())).toEqual(
      seeds,
    );
    const other = seedThreadsFromPins(
      longId,
      [{ ...pin, id: longId + "y" }],
      emptyRiskSignals(),
    )[0]!;
    expect(seedThreadKey(other)).not.toBe(seedThreadKey(seed));
  });

  it("skips document structure while preserving missing-source warnings in seeds", () => {
    const pins = pinsFromResumeLines(
      [
        { kind: "section", text: "Experience" },
        { kind: "body", lineNumber: 2, text: "Unmapped claim" },
      ],
      null,
      [],
    );
    // A structural pin has no source or rationale to seed; missing provenance
    // must still create an inspectable warning even without a rationale.
    const withoutRationale = pins.map((pin) => ({ ...pin, rationale: null }));
    const seeds = seedThreadsFromPins(
      "artifact:1",
      withoutRationale,
      emptyRiskSignals(),
    );
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      commentBody: "no recorded source",
      riskLabel: "no recorded source",
      lineAnchor: { lineNumber: 2 },
      semanticId: null,
      sourcePinId: "resume-line:2",
    });
    expect(seedThreadsFromPins("artifact:1", [], emptyRiskSignals())).toEqual(
      [],
    );
  });
});
