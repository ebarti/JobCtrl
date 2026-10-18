import { fireEvent, screen } from "@testing-library/react";
import type { Value } from "platejs";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import {
  resumePlateLinesFromHtml,
  resumePlateValueFromHtml,
} from "../lib/resume-document.js";
import {
  emptyRiskSignals,
  pinsFromResumeLines,
} from "../lib/resume-provenance.js";
import { ResumePlateDocument } from "./ResumePlateDocument.js";

describe("resume Plate presentation", () => {
  it("renders identity, missing-source warnings, link safety and block formatting without a session", () => {
    const html =
      '<main class="resume-page"><p data-resume-line-number="1" data-resume-layout-target="claim:1"><a href="https://example.test">Visible claim</a></p></main>';
    const lines = resumePlateLinesFromHtml(html, []);
    const value = resumePlateValueFromHtml(html);
    const block = value[0]!.children[0]!;
    if (!("children" in block)) throw new Error("Expected imported block");
    block.textAlign = "right";
    block.fontSize = 1.2;
    const onSelectLine = vi.fn();
    const onFormattingApiChange = vi.fn();
    const { container, unmount } = renderWithProviders(
      <ResumePlateDocument
        commentThreadsByLineIndex={new Map()}
        documentKey="direct:1"
        initialValue={value as Value}
        layoutBoxes={[]}
        lines={lines}
        onClearLineSelection={vi.fn()}
        onValueChange={vi.fn()}
        onFormattingApiChange={onFormattingApiChange}
        onSelectLine={onSelectLine}
        pins={pinsFromResumeLines(lines, null, [])}
        replyPending={false}
        risk={emptyRiskSignals()}
        selectedLine={null}
        title="Synthetic resume"
      />,
    );
    expect(
      screen.getByRole("textbox", { name: "Synthetic resume editor" }),
    ).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Visible claim" });
    expect(link).toHaveAttribute("href", "https://example.test");
    expect(link).toHaveAttribute("rel", "noreferrer");
    expect(link).toHaveAttribute("target", "_blank");
    const line = container.querySelector(
      '[data-resume-layout-target="claim:1"]',
    )!;
    expect(line).toHaveStyle({ textAlign: "right", fontSize: "1.2em" });
    expect(screen.getByRole("note")).toHaveTextContent("no recorded source");
    expect(screen.getByRole("note")).toHaveAttribute(
      "contenteditable",
      "false",
    );
    fireEvent.click(line);
    expect(onSelectLine).toHaveBeenCalledWith(
      expect.objectContaining({ lineKey: "resume:1", lineNumber: 1 }),
    );
    expect(onFormattingApiChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        setLink: expect.any(Function),
        toggleBold: expect.any(Function),
      }),
    );
    unmount();
    expect(onFormattingApiChange).toHaveBeenLastCalledWith(null);
  });

  it("keeps audit selection on editor chrome and clears it on outside pointer and Escape", () => {
    const html = '<p data-resume-line-number="1">Line</p>';
    const clear = vi.fn();
    renderWithProviders(
      <div>
        <button data-resume-editor-chrome="true" type="button">
          Toolbar
        </button>
        <button type="button">Outside</button>
        <ResumePlateDocument
          commentThreadsByLineIndex={new Map()}
          documentKey="direct:2"
          initialValue={resumePlateValueFromHtml(html)}
          layoutBoxes={[]}
          lines={resumePlateLinesFromHtml(html, [])}
          onClearLineSelection={clear}
          onValueChange={vi.fn()}
          onSelectLine={vi.fn()}
          pins={[]}
          replyPending={false}
          risk={emptyRiskSignals()}
          title="Synthetic resume"
          selectedLine={{
            lineKey: "resume:1",
            lineNumber: 1,
            pageLineIndex: 1,
            pageNumber: 1,
            text: "Line",
            resumeLineText: "Line",
          }}
        />
      </div>,
    );
    fireEvent.pointerDown(screen.getByRole("button", { name: "Toolbar" }));
    expect(clear).not.toHaveBeenCalled();
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(clear).toHaveBeenCalledOnce();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(clear).toHaveBeenCalledTimes(2);
  });
});
