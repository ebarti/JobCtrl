import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Switch } from "./switch.js";

function ControlledSwitch() {
  const [checked, setChecked] = useState(false);

  return (
    <Switch
      aria-label="Controlled switch"
      checked={checked}
      onCheckedChange={(nextChecked) => setChecked(nextChecked)}
    />
  );
}

describe("Switch", () => {
  it("updates unchecked Base UI state in uncontrolled mode", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    render(
      <Switch
        aria-label="Uncontrolled switch"
        onCheckedChange={onCheckedChange}
      />,
    );

    const switchControl = screen.getByRole("switch", {
      name: "Uncontrolled switch",
    });
    expect(switchControl).toHaveAttribute("data-unchecked");

    await user.click(switchControl);

    expect(switchControl).toHaveAttribute("data-checked");
    expect(switchControl).toHaveAttribute("aria-checked", "true");
    expect(onCheckedChange).toHaveBeenCalledWith(true, expect.anything());
  });

  it("keeps controlled and disabled switch states observable", async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();

    const { rerender } = render(<ControlledSwitch />);
    const controlled = screen.getByRole("switch", {
      name: "Controlled switch",
    });
    await user.click(controlled);
    expect(controlled).toHaveAttribute("data-checked");

    rerender(
      <Switch
        aria-label="Disabled switch"
        disabled
        onCheckedChange={onCheckedChange}
      />,
    );
    const disabled = screen.getByRole("switch", { name: "Disabled switch" });
    await user.click(disabled);

    expect(disabled).toHaveAttribute("data-disabled");
    expect(disabled).toHaveAttribute("data-unchecked");
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
