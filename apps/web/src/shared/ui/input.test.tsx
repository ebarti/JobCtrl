import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "./input.js";
import { Textarea } from "./textarea.js";

describe("shared form focus contract", () => {
  it("keeps the global focus-visible outline available for inputs", () => {
    render(<Input aria-label="Example input" />);

    expect(screen.getByLabelText("Example input")).not.toHaveClass(
      "focus-visible:outline-none",
    );
  });

  it("keeps the global focus-visible outline available for textareas", () => {
    render(<Textarea aria-label="Example textarea" />);

    expect(screen.getByLabelText("Example textarea")).not.toHaveClass(
      "focus-visible:outline-none",
    );
  });
});
