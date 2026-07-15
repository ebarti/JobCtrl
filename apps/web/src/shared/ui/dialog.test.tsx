import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import { Button } from "./button.js";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "./dialog.js";

describe("Dialog", () => {
  it("preserves composed controls, accessible labeling, dismissal, and focus return", async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const view = render(
      <Dialog onOpenChange={onOpenChange}>
        <DialogTrigger asChild>
          <Button>Review changes</Button>
        </DialogTrigger>
        <DialogContent>
          <DialogTitle>Review changes?</DialogTitle>
          <DialogDescription>
            Confirm whether the synthetic changes should be accepted.
          </DialogDescription>
          <DialogClose asChild>
            <Button variant="ghost">Cancel</Button>
          </DialogClose>
        </DialogContent>
      </Dialog>,
    );
    const trigger = screen.getByRole("button", { name: "Review changes" });

    await user.click(trigger);

    const dialog = await screen.findByRole("dialog", {
      name: "Review changes?",
    });
    expect(dialog).toHaveAccessibleDescription(
      "Confirm whether the synthetic changes should be accepted.",
    );
    expect(view.container).not.toContainElement(dialog);
    expect(onOpenChange).toHaveBeenCalledWith(
      true,
      expect.objectContaining({ reason: "trigger-press" }),
    );
    expect(await axe(document.body)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    expect(onOpenChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ reason: "close-press" }),
    );

    await user.click(trigger);
    await screen.findByRole("dialog", { name: "Review changes?" });
    await user.keyboard("{Escape}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
    expect(onOpenChange).toHaveBeenLastCalledWith(
      false,
      expect.objectContaining({ reason: "escape-key" }),
    );
  });
});
