import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Separator } from "./separator.js";

describe("<Separator>", () => {
  it("renders a semantic horizontal separator with the existing rule styling", () => {
    render(<Separator />);

    const separator = screen.getByRole("separator");

    expect(separator).toHaveAttribute("data-orientation", "horizontal");
    expect(separator).toHaveClass("shrink-0", "bg-border", "h-[1px]", "w-full");
  });

  it("preserves the vertical orientation and rule styling", () => {
    render(<Separator orientation="vertical" />);

    const separator = screen.getByRole("separator");

    expect(separator).toHaveAttribute("data-orientation", "vertical");
    expect(separator).toHaveClass("h-full", "w-[1px]");
  });
});
