import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Checkbox } from "./checkbox.js";

function ControlledCheckbox() {
  const [checked, setChecked] = useState(false);

  return (
    <Checkbox
      aria-label="Controlled checkbox"
      checked={checked}
      onCheckedChange={(nextChecked) => setChecked(nextChecked)}
    />
  );
}

describe("Checkbox", () => {
  it("updates unchecked Base UI state in uncontrolled mode", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    render(
      <Checkbox
        aria-label="Uncontrolled checkbox"
        onCheckedChange={onCheckedChange}
      />,
    );

    const checkbox = screen.getByRole("checkbox", {
      name: "Uncontrolled checkbox",
    });
    expect(checkbox).toHaveClass("size-6");
    expect(checkbox).toHaveClass(
      "before:size-4",
      "border-transparent",
      "bg-transparent",
    );
    expect(checkbox).toHaveAttribute("data-unchecked");

    await user.click(checkbox);

    expect(checkbox).toHaveAttribute("data-checked");
    expect(checkbox).toHaveAttribute("aria-checked", "true");
    expect(checkbox.querySelector("svg")).toHaveClass("size-3");
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("keeps controlled and disabled checkbox states observable", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    const { rerender } = render(<ControlledCheckbox />);
    const controlled = screen.getByRole("checkbox", {
      name: "Controlled checkbox",
    });
    await user.click(controlled);
    expect(controlled).toHaveAttribute("data-checked");

    rerender(
      <Checkbox
        aria-label="Disabled checkbox"
        disabled
        onCheckedChange={onCheckedChange}
      />,
    );
    const disabled = screen.getByRole("checkbox", {
      name: "Disabled checkbox",
    });
    await user.click(disabled);

    expect(disabled).toHaveAttribute("data-disabled");
    expect(disabled).toHaveAttribute("data-unchecked");
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it("renders indeterminate state through Base UI", () => {
    render(<Checkbox aria-label="Indeterminate checkbox" indeterminate />);

    const checkbox = screen.getByRole("checkbox", {
      name: "Indeterminate checkbox",
    });
    expect(checkbox).toHaveAttribute("aria-checked", "mixed");
    expect(checkbox).toHaveAttribute("data-indeterminate");
    expect(checkbox.querySelector("svg")).not.toBeNull();
  });
});
