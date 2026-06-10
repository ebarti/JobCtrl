import { describe, expect, it } from "vitest";

import { descriptionBlocks } from "./job-description-blocks.js";

describe("descriptionBlocks", () => {
  it("preserves explicit blank-line-separated paragraphs as separate blocks", () => {
    expect(descriptionBlocks("First paragraph.\n\nSecond paragraph.\n\nThird paragraph.")).toEqual([
      "First paragraph.",
      "Second paragraph.",
      "Third paragraph.",
    ]);
  });

  it("splits one long paragraph at sentence boundaries after the threshold", () => {
    const firstSentence = `${"A".repeat(300)}.`;
    const secondSentence = `${"B".repeat(250)}.`;
    const thirdSentence = `${"C".repeat(120)}.`;

    expect(descriptionBlocks(`${firstSentence} ${secondSentence} ${thirdSentence}`)).toEqual([
      firstSentence,
      `${secondSentence} ${thirdSentence}`,
    ]);
  });

  it("returns an empty block list for empty or whitespace-only text", () => {
    expect(descriptionBlocks("")).toEqual([]);
    expect(descriptionBlocks(" \n\n\t ")).toEqual([]);
  });
});
