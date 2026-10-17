import type { Value } from "platejs";
import { describe, expect, it } from "vitest";

import {
  normalizeResumePlateValue,
  isPlateValue,
  resumePlateLinesFromHtml,
  resumePlateValueFromHtml,
  resumePlateValueSignature,
  resumeSemanticTextChangesFromPlateValues,
  resumeTextFromPlateValue,
  safeResumeHref,
  selectionFromPlateLine,
} from "./resume-document.js";

describe("resume document transforms", () => {
  it("imports supported structure and identity while dropping active HTML and unsafe attributes", () => {
    const value = resumePlateValueFromHtml(`<main class="resume-page">
      <script>scriptPayload()</script><iframe>framePayload</iframe><style>stylePayload</style>
      <p data-resume-line-number="7" data-resume-layout-target="claim:7"
        data-resume-profile-field="personal:email" onclick="eventPayload()">
        Contact <strong>team</strong> <a href="javascript:linkPayload()">unsafe</a>
        <a href="https://example.test">safe</a>
      </p></main>`);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toMatch(
      /scriptPayload|framePayload|stylePayload|eventPayload|linkPayload|onclick/,
    );
    expect(value[0]?.children[0]).toMatchObject({
      type: "resume_block",
      tagName: "p",
      lineNumber: 7,
      semanticId: "claim:7",
      profileField: "personal:email",
    });
    expect(serialized).toContain('"tagName":"strong"');
    expect(serialized).toContain('"href":"https://example.test"');
    expect(resumeTextFromPlateValue(value)).toBe("Contact team unsafe safe");
  });

  it("normalizes grid children without losing marks, links or formatting in the save signature", () => {
    const value: Value = [
      {
        type: "resume_inline",
        tagName: "span",
        className: "resume-entry-row",
        children: [
          { text: " " },
          {
            type: "resume_inline",
            tagName: "span",
            className: "resume-entry-title",
            fontSize: 1.2,
            children: [
              { text: "Title", bold: true, italic: true, underline: true },
            ],
          },
        ],
      },
    ];
    const normalized = normalizeResumePlateValue(value);
    expect(normalized[0]).toMatchObject({
      type: "resume_block",
      tagName: "div",
      children: [
        {
          type: "resume_block",
          tagName: "div",
          fontSize: 1.2,
          children: [
            { text: "Title", bold: true, italic: true, underline: true },
          ],
        },
      ],
    });
    expect(normalizeResumePlateValue(normalized)).toEqual(normalized);
    const styled = structuredClone(normalized);
    styled[0]!.textAlign = "right";
    expect(resumeTextFromPlateValue(styled)).toBe(
      resumeTextFromPlateValue(normalized),
    );
    expect(resumePlateValueSignature(styled)).not.toBe(
      resumePlateValueSignature(normalized),
    );
    expect(resumePlateValueSignature(null)).toBe("");
    expect(normalizeResumePlateValue([])[0]?.children).toEqual([{ text: "" }]);
  });

  it("projects canonical profile sources and records deletions independently of composite headings", () => {
    const baseline: Value = [
      {
        type: "resume_block",
        semanticId: "heading",
        children: [
          {
            type: "resume_inline",
            profileField: "experience:role:title",
            profileSource: "Engineer’s Lead",
            children: [{ text: "Engineer's Lead" }],
          },
          {
            type: "resume_inline",
            profileField: "experience:role:company",
            children: [{ text: "Fixture" }],
          },
        ],
      },
    ];
    const current = structuredClone(baseline);
    current[0]!.children = [
      {
        type: "resume_inline",
        profileField: "experience:role:title",
        children: [{ text: "Lead" }],
      },
    ];
    expect(
      resumeSemanticTextChangesFromPlateValues(baseline, baseline),
    ).toEqual([]);
    expect(resumeSemanticTextChangesFromPlateValues(baseline, current)).toEqual(
      [
        {
          semanticId: "experience:role:title",
          baselineTexts: ["Engineer’s Lead"],
          plateTexts: ["Lead"],
        },
        {
          semanticId: "experience:role:company",
          baselineTexts: ["Fixture"],
          plateTexts: [],
        },
      ],
    );
  });

  it("round-trips a formatted saved document without introducing a semantic edit", () => {
    const baseline = resumePlateValueFromHtml(
      '<p data-resume-line-number="1" data-resume-profile-field="personal:email" data-resume-profile-source="qa@example.test"><a href="mailto:qa@example.test">qa@example.test</a></p>',
    );
    const formatted = structuredClone(baseline);
    formatted[0]!.fontFamily = "serif";
    formatted[0]!.fontSize = 1.25;
    formatted[0]!.textAlign = "right";
    const link = formatted[0]!.children[0]!;
    if (!("children" in link)) throw new Error("Expected imported link");
    link.children = [{ text: "qa@example.test", bold: true }];

    const saved: unknown = JSON.parse(resumePlateValueSignature(formatted));
    if (!isPlateValue(saved)) throw new Error("Expected valid saved document");
    const restored = normalizeResumePlateValue(saved);
    expect(restored).toEqual(formatted);
    expect(resumePlateValueSignature(restored)).not.toBe(
      resumePlateValueSignature(baseline),
    );
    expect(resumeTextFromPlateValue(restored)).toBe("qa@example.test");
    expect(resumeSemanticTextChangesFromPlateValues(baseline, restored)).toEqual(
      [],
    );
  });

  it("retains line and semantic identity through HTML selection without guessing from text", () => {
    const lines = resumePlateLinesFromHtml(
      '<main class="resume-page" data-resume-page="2"><p data-resume-line-number="9" data-resume-layout-target="claim:9">Repeated text</p><p data-resume-line-number="10">Repeated text</p></main>',
      [],
    );
    expect(lines).toHaveLength(2);
    expect(selectionFromPlateLine(lines[0]!, 0, [])).toMatchObject({
      lineKey: "resume:9",
      lineNumber: 9,
      pageNumber: 2,
    });
    expect(lines[1]?.semanticId).toBeNull();
    expect(safeResumeHref("data:text/html,unsafe")).toBeUndefined();
    expect(safeResumeHref(" mailto:qa@example.test ")).toBe(
      "mailto:qa@example.test",
    );
  });
});
