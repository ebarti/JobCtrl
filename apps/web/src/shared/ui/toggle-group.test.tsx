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
    const active = screen.getByRole("radio", { name: "Active" });
    const deleted = screen.getByRole("radio", { name: "Deleted" });

    expect(active).toHaveAttribute("aria-checked", "true");
    expect(deleted).toHaveAttribute("aria-checked", "false");
    beforeViews.focus();

    rerender(controlledJobViews("deleted"));

    expect(active).toHaveAttribute("aria-checked", "false");
    expect(deleted).toHaveAttribute("aria-checked", "true");

    await user.tab();

    expect(deleted).toHaveFocus();
    expect(active).toHaveAttribute("tabindex", "-1");
    expect(deleted).toHaveAttribute("tabindex", "0");
  });
});
