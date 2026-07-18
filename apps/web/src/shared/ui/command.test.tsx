import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { Command, CommandGroup, CommandInput, CommandItem, CommandList } from "./command.js";

describe("Command", () => {
  beforeAll(() => {
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
  });

  it("keeps cmdk keyboard selection state available for Enter activation", async () => {
    const user = userEvent.setup();
    const onOpenPreview = vi.fn();
    const onCopyLink = vi.fn();

    render(
      <Command label="Command palette">
        <CommandInput placeholder="Search commands..." />
        <CommandList>
          <CommandGroup heading="Actions">
            <CommandItem value="open-preview" onSelect={onOpenPreview}>
              Open preview
            </CommandItem>
            <CommandItem value="copy-link" onSelect={onCopyLink}>
              Copy link
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>,
    );

    expect(
      screen.getByRole("combobox", { name: "Command palette" }),
    ).toHaveAttribute("data-typography", "control");
    expect(screen.getByText("Open preview")).toHaveAttribute(
      "data-typography",
      "control",
    );

    await user.click(screen.getByRole("combobox", { name: "Command palette" }));
    await waitFor(() => {
      expect(screen.getByRole("option", { name: "Open preview" })).toHaveAttribute(
        "aria-selected",
        "true",
      );
    });

    await user.keyboard("{ArrowDown}{Enter}");

    expect(onOpenPreview).not.toHaveBeenCalled();
    expect(onCopyLink).toHaveBeenCalledWith("copy-link");
    expect(screen.getByRole("option", { name: "Copy link" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });
});
