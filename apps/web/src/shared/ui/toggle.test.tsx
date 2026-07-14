import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Toggle } from "./toggle.js";

function ControlledToggle() {
  const [pressed, setPressed] = useState(false);

  return (
    <Toggle
      aria-label="Controlled toggle"
      pressed={pressed}
      onPressedChange={(nextPressed) => setPressed(nextPressed)}
    />
  );
}

describe("Toggle", () => {
  it("updates Base UI pressed state in uncontrolled mode", async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();

    render(
      <Toggle
        aria-label="Uncontrolled toggle"
        onPressedChange={onPressedChange}
      />,
    );

    const toggle = screen.getByRole("button", {
      name: "Uncontrolled toggle",
    });
    expect(toggle).not.toHaveAttribute("data-pressed");
    expect(toggle).toHaveAttribute("aria-pressed", "false");

    await user.click(toggle);

    expect(toggle).toHaveAttribute("data-pressed");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(onPressedChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("keeps controlled pressed state observable", async () => {
    const user = userEvent.setup();
    render(<ControlledToggle />);

    const toggle = screen.getByRole("button", { name: "Controlled toggle" });
    await user.click(toggle);

    expect(toggle).toHaveAttribute("data-pressed");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
  });

  it("exposes disabled state and ignores interaction", async () => {
    const user = userEvent.setup();
    const onPressedChange = vi.fn();
    render(
      <Toggle
        aria-label="Disabled toggle"
        disabled
        onPressedChange={onPressedChange}
      />,
    );

    const toggle = screen.getByRole("button", { name: "Disabled toggle" });
    await user.click(toggle);

    expect(toggle).toBeDisabled();
    expect(toggle).toHaveAttribute("data-disabled");
    expect(toggle).not.toHaveAttribute("data-pressed");
    expect(onPressedChange).not.toHaveBeenCalled();
  });
});
