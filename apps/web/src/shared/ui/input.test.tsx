import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Input } from "./input.js";
import { Textarea } from "./textarea.js";

describe("shared form focus contract", () => {
  it("keeps a visible focus ring available for inputs", () => {
    render(<Input aria-label="Example input" />);

    expect(screen.getByLabelText("Example input")).toHaveClass(
      "focus-visible:border-foreground",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
    );
  });

  it("keeps a visible focus ring available for textareas", () => {
    render(<Textarea aria-label="Example textarea" />);

    expect(screen.getByLabelText("Example textarea")).toHaveClass(
      "focus-visible:border-foreground",
      "focus-visible:ring-2",
      "focus-visible:ring-ring",
    );
  });
});
