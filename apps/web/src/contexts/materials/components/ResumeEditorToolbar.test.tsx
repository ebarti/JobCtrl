import { fireEvent, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { renderWithProviders } from "../../../test/render.js";
import { ResumeEditorToolbarControls } from "./ResumeEditorToolbar.js";

function callbacks() {
  return {
    onAlign: vi.fn(),
    onClearLink: vi.fn(),
    onFontFamily: vi.fn(),
    onFontSize: vi.fn(),
    onSetLink: vi.fn(),
    onToggleBold: vi.fn(),
    onToggleItalic: vi.fn(),
    onToggleUnderline: vi.fn(),
  };
}

describe("resume toolbar presentation", () => {
  it("preserves editor selection on commands and validates size bounds", async () => {
    const actions = callbacks();
    renderWithProviders(
      <ResumeEditorToolbarControls disabled={false} {...actions} />,
    );
    const bold = screen.getByRole("button", { name: "Bold" });
    expect(fireEvent.mouseDown(bold)).toBe(false);
    fireEvent.click(bold);
    fireEvent.click(screen.getByRole("button", { name: "Italic" }));
    fireEvent.click(screen.getByRole("button", { name: "Underline" }));
    fireEvent.click(screen.getByRole("button", { name: "Align right" }));
    expect(actions.onToggleBold).toHaveBeenCalledOnce();
    expect(actions.onToggleItalic).toHaveBeenCalledOnce();
    expect(actions.onToggleUnderline).toHaveBeenCalledOnce();
    expect(actions.onAlign).toHaveBeenCalledWith("right");
    const size = screen.getByRole("spinbutton", { name: "Size" });
    fireEvent.change(size, { target: { value: "125" } });
    expect(actions.onFontSize).toHaveBeenLastCalledWith(1.25);
    fireEvent.change(size, { target: { value: "151" } });
    expect(actions.onFontSize).toHaveBeenCalledTimes(1);
    fireEvent.blur(size);
    expect(actions.onFontSize).toHaveBeenLastCalledWith(1);
    expect(size).toHaveValue(100);
  });

  it("validates link input, applies a normalized URL, and restores focus after Escape", async () => {
    const user = userEvent.setup();
    const actions = callbacks();
    renderWithProviders(
      <ResumeEditorToolbarControls disabled={false} {...actions} />,
    );
    const trigger = screen.getByRole("button", { name: "Insert link" });
    await user.click(trigger);
    const input = screen.getByRole("textbox", { name: "Link URL" });
    await waitFor(() => expect(input).toHaveFocus());
    await user.type(input, "javascript:alert(1)");
    await user.click(screen.getByRole("button", { name: "Apply link" }));
    expect(screen.getByRole("status")).toHaveTextContent(
      "Use http, https, mailto, tel",
    );
    expect(actions.onSetLink).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, "example.test");
    await user.click(screen.getByRole("button", { name: "Apply link" }));
    expect(actions.onSetLink).toHaveBeenCalledWith("https://example.test");
    await waitFor(() => expect(trigger).toHaveFocus());
    await user.click(trigger);
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "Link URL" })).toHaveFocus(),
    );
    await user.keyboard("{Escape}");
    await waitFor(() => expect(trigger).toHaveFocus());
    expect(
      screen.queryByRole("dialog", { name: "Insert link" }),
    ).not.toBeInTheDocument();
  });

  it("opens the shortcut only for its editor and disables commands when unavailable", () => {
    const actions = callbacks();
    const { rerender } = renderWithProviders(
      <div className="resume-plate-editor">
        <button type="button">Editor focus</button>
        <ResumeEditorToolbarControls disabled={false} {...actions} />
      </div>,
    );
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    screen.getByRole("button", { name: "Editor focus" }).focus();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      screen.getByRole("dialog", { name: "Insert link" }),
    ).toBeInTheDocument();
    rerender(<ResumeEditorToolbarControls disabled={true} {...actions} />);
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
    expect(screen.getByRole("spinbutton", { name: "Size" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(actions.onToggleBold).not.toHaveBeenCalled();
  });
});
