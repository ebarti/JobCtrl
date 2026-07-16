import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { ToggleGroup, ToggleGroupItem } from "./toggle-group.js";

function controlledJobViews(value: "active" | "deleted") {
  return (
    <>
      <button type="button">Before views</button>
      <ToggleGroup aria-label="Job views" type="single" value={value}>
        <ToggleGroupItem value="active">Active</ToggleGroupItem>
        <ToggleGroupItem value="deleted">Deleted</ToggleGroupItem>
      </ToggleGroup>
    </>
  );
}

describe("ToggleGroup", () => {
  it("enters a mounted controlled group at its newly selected value", async () => {
    const user = userEvent.setup();
    const { rerender } = render(controlledJobViews("active"));
    const beforeViews = screen.getByRole("button", { name: "Before views" });
    const active = screen.getByRole("button", { name: "Active" });
    const deleted = screen.getByRole("button", { name: "Deleted" });

    expect(active).toHaveAttribute("aria-pressed", "true");
    expect(deleted).toHaveAttribute("aria-pressed", "false");
    beforeViews.focus();

    rerender(controlledJobViews("deleted"));

    const updatedActive = screen.getByRole("button", { name: "Active" });
    const updatedDeleted = screen.getByRole("button", { name: "Deleted" });
    expect(updatedActive).toHaveAttribute("aria-pressed", "false");
    expect(updatedDeleted).toHaveAttribute("aria-pressed", "true");

    await user.tab();

    expect(updatedDeleted).toHaveFocus();
    expect(updatedActive).toHaveAttribute("tabindex", "-1");
    expect(updatedDeleted).toHaveAttribute("tabindex", "0");
  });
});
