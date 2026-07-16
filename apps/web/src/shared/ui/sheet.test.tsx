import { render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { axe } from "jest-axe";
import { describe, expect, it } from "vitest";

import { Button } from "./button.js";
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from "./sheet.js";

describe("Sheet", () => {
  it("opens the selected side with accessible labeling and restores trigger focus", async () => {
    const user = userEvent.setup();
    const view = render(
      <Sheet>
        <SheetTrigger asChild>
          <Button>Open filters</Button>
        </SheetTrigger>
        <SheetContent side="left">
          <SheetTitle>Filter jobs</SheetTitle>
          <SheetDescription>
            Choose filters for the synthetic jobs view.
          </SheetDescription>
          <SheetClose asChild>
            <Button variant="ghost">Done</Button>
          </SheetClose>
        </SheetContent>
      </Sheet>,
    );
    const trigger = screen.getByRole("button", { name: "Open filters" });

    await user.click(trigger);

    const sheet = await screen.findByRole("dialog", { name: "Filter jobs" });
    expect(sheet).toHaveAttribute("data-side", "left");
    expect(sheet).toHaveClass(
      "left-0",
      "border-r",
      "data-starting-style:-translate-x-full",
      "data-ending-style:-translate-x-full",
    );
    expect(view.container).not.toContainElement(sheet);
    expect(await axe(document.body)).toHaveNoViolations();

    await user.click(screen.getByRole("button", { name: "Done" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toHaveFocus();
  });
});
