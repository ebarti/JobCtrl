import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { Label } from "./label.js";

describe("<Label>", () => {
  it("uses a native label to associate its text with the control", () => {
    render(
      <>
        <Label htmlFor="label-test-input">Minimum fit score</Label>
        <input id="label-test-input" />
      </>,
    );

    const label = screen.getByText("Minimum fit score");

    expect(label.tagName).toBe("LABEL");
    expect(label).toHaveClass("text-sm", "font-medium", "leading-none");
    expect(screen.getByLabelText("Minimum fit score")).toHaveAttribute(
      "id",
      "label-test-input",
    );
  });
});
