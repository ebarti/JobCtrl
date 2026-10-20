import type { Value } from "platejs";
import { describe, expect, it } from "vitest";

import {
  normalizeResumeHrefInput,
  resumeTextFromPlateValue,
} from "./resume-document.js";
import { linkSelectedResumeLine } from "./resume-formatting.js";

describe("resume formatting transforms", () => {
  it("normalizes admitted URL inputs and rejects executable or unsupported schemes", () => {
    expect(normalizeResumeHrefInput(" example.test/path ")).toBe(
      "https://example.test/path",
    );
    expect(normalizeResumeHrefInput("qa@example.test")).toBe(
      "mailto:qa@example.test",
    );
    expect(normalizeResumeHrefInput("tel:+12025550100")).toBe(
      "tel:+12025550100",
    );
    for (const input of [
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "file:///tmp/local",
      "",
      "two words",
    ]) {
      expect(normalizeResumeHrefInput(input)).toBeNull();
    }
  });

  it("replaces and removes a selected line's links while preserving marks, identities and other lines", () => {
    const value: Value = [1, 2].map((lineNumber) => ({
      type: "resume_block",
      tagName: "p",
      lineNumber,
      semanticId: `claim:${lineNumber}`,
      children: [
        {
          type: "resume_inline",
          tagName: "a",
          href: "https://old.test",
          children: [{ text: `Line ${lineNumber}`, bold: true }],
        },
      ],
    }));
    const before = structuredClone(value);
    const selected = {
      lineKey: "resume:2",
      lineNumber: 2,
      pageNumber: 1,
      pageLineIndex: 2,
      resumeLineText: "Line 2",
      text: "Line 2",
    };
    const linked = linkSelectedResumeLine(value, selected, "https://new.test")!;
    expect(value).toEqual(before);
    expect(linked[0]).toEqual(value[0]);
    expect(linked[1]).toMatchObject({
      semanticId: "claim:2",
      children: [
        {
          tagName: "a",
          href: "https://new.test",
          children: [{ text: "Line 2", bold: true }],
        },
      ],
    });
    const unlinked = linkSelectedResumeLine(linked, selected, null)!;
    expect(unlinked[1]?.children).toEqual([{ text: "Line 2", bold: true }]);
    expect(resumeTextFromPlateValue(unlinked)).toBe(
      resumeTextFromPlateValue(value),
    );
    expect(
      linkSelectedResumeLine(
        value,
        { ...selected, lineNumber: 99 },
        "https://new.test",
      ),
    ).toBeNull();
    expect(linkSelectedResumeLine(value, null, "https://new.test")).toBeNull();
  });
});
