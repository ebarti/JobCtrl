import { act, fireEvent, screen } from "@testing-library/react";
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

  it("preserves native and Slate-owned selections through immediate editor rerenders", async () => {
    const html = '<main class="resume-page"><p>First pasted paragraph</p></main>';
    const value = resumePlateValueFromHtml(html);
    const renderDocument = () => (
      <ResumePlateDocument
        commentThreadsByLineIndex={new Map()}
        documentKey="pointer-selection"
        initialValue={value}
        layoutBoxes={[]}
        lines={resumePlateLinesFromHtml(html, [])}
        onClearLineSelection={vi.fn()}
        onValueChange={vi.fn()}
        onSelectLine={vi.fn()}
        pins={[]}
        replyPending={false}
        risk={emptyRiskSignals()}
        selectedLine={null}
        title="Synthetic resume"
      />
    );
    const { rerender } = renderWithProviders(renderDocument());
    const editor = screen.getByRole("textbox", { name: "Synthetic resume editor" });
    const leaf = editor.querySelector('[data-slate-string]')!;
    Object.defineProperty(editor, "isContentEditable", { value: true });
    Object.defineProperty(leaf, "isContentEditable", { value: true });
    const selection = window.getSelection()!;
    await act(async () => {
      editor.focus();
      selection.setBaseAndExtent(leaf.firstChild!, 5, leaf.firstChild!, 2);
      fireEvent.pointerUp(leaf, { button: 0 });
    });
    rerender(renderDocument());
    expect(selection.anchorNode).toBe(leaf.firstChild);
    expect(selection.anchorOffset).toBe(5);
    expect(selection.focusNode).toBe(leaf.firstChild);
    expect(selection.focusOffset).toBe(2);

    // A Slate-handled arrow key can update its model before the DOM catches
    // up. An older DOM range must not replace that newer model selection.
    await act(async () => {
      selection.setBaseAndExtent(leaf.firstChild!, 5, leaf.firstChild!, 5);
      fireEvent.pointerUp(leaf, { button: 0 });
    });
    const arrowDown = new KeyboardEvent("keydown", {
      key: "ArrowRight", keyCode: 39, which: 39, bubbles: true, cancelable: true,
    });
    await act(async () => { fireEvent(editor, arrowDown); });
    expect(arrowDown.defaultPrevented).toBe(true);
    await act(async () => {
      selection.setBaseAndExtent(leaf.firstChild!, 2, leaf.firstChild!, 2);
      fireEvent.keyUp(editor, { key: "ArrowRight", keyCode: 39, which: 39 });
    });
    rerender(renderDocument());
    expect(selection.anchorNode).toBe(leaf.firstChild);
    expect(selection.anchorOffset).toBe(6);

    // Composition may end between a keydown and its keyup. The earlier
    // composing event must not grant authority to an out-of-date DOM range.
    await act(async () => {
      selection.setBaseAndExtent(leaf.firstChild!, 1, leaf.firstChild!, 1);
      fireEvent.keyDown(editor, { key: "Home", isComposing: true });
      fireEvent.keyUp(editor, { key: "Home", isComposing: false });
    });
    rerender(renderDocument());
    expect(selection.anchorNode).toBe(leaf.firstChild);
    expect(selection.anchorOffset).toBe(6);
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
