import { axe } from "jest-axe";
import { useDirection } from "@base-ui/react/direction-provider";
import { render, screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "./select.js";

function DirectionProbe() {
  return <output data-testid="direction-probe">{useDirection()}</output>;
}

function DensitySelect({
  defaultOpen,
  defaultValue,
  dir,
  disabled,
  onValueChange,
  value,
}: {
  defaultOpen?: boolean;
  defaultValue?: string;
  dir?: "ltr" | "rtl";
  disabled?: boolean;
  onValueChange?: (value: string) => void;
  value?: string;
}) {
  return (
    <Select
      defaultOpen={defaultOpen}
      defaultValue={defaultValue}
      dir={dir}
      disabled={disabled}
      onValueChange={onValueChange}
      value={value}
    >
      <SelectTrigger aria-label="View density">
        <SelectValue placeholder="Pick a view" />
      </SelectTrigger>
      <SelectContent data-testid="density-popup">
        <SelectGroup>
          <SelectLabel>View density options</SelectLabel>
          <SelectItem value="compact">Compact</SelectItem>
          <SelectItem value="regular">Regular</SelectItem>
          <SelectItem value="comfortable">Comfortable</SelectItem>
          <SelectItem disabled value="locked">
            Locked option
          </SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

describe("<Select>", () => {
  it("infers item labels so formatted text survives in the trigger", () => {
    render(<DensitySelect defaultValue="comfortable" />);

    const trigger = screen.getByRole("combobox", { name: "View density" });
    expect(trigger).toHaveTextContent("Comfortable");
    expect(trigger).not.toHaveTextContent("comfortable");
  });

  it("changes an uncontrolled string value and preserves the callback shape", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <DensitySelect defaultValue="compact" onValueChange={onValueChange} />,
    );

    const trigger = screen.getByRole("combobox", { name: "View density" });
    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Regular" }));

    expect(onValueChange).toHaveBeenCalledWith("regular");
    expect(onValueChange.mock.calls[0]).toHaveLength(1);
    expect(trigger).toHaveTextContent("Regular");
  });

  it("reports a controlled change without replacing the supplied value", async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    const { rerender } = render(
      <DensitySelect value="compact" onValueChange={onValueChange} />,
    );
    const trigger = screen.getByRole("combobox", { name: "View density" });

    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Regular" }));

    expect(onValueChange).toHaveBeenCalledWith("regular");
    expect(trigger).toHaveTextContent("Compact");

    rerender(<DensitySelect value="regular" onValueChange={onValueChange} />);
    expect(trigger).toHaveTextContent("Regular");
  });

  it("preserves placeholder, disabled option, and disabled root states", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<DensitySelect defaultOpen />);
    const trigger = screen.getByRole("combobox", { name: "View density" });
    expect(trigger).toHaveTextContent("Pick a view");

    expect(
      screen.getByRole("option", { name: "Locked option" }),
    ).toHaveAttribute("aria-disabled", "true");
    await user.keyboard("{Escape}");

    rerender(<DensitySelect key="disabled" defaultValue="regular" disabled />);
    const disabledTrigger = screen.getByRole("combobox", {
      name: "View density",
    });
    expect(disabledTrigger).toBeDisabled();
    expect(disabledTrigger).toHaveAttribute("data-disabled");
    expect(disabledTrigger).toHaveTextContent("Regular");
  });

  it("maps group labels and Radix popper positioning to Base UI parts", () => {
    render(
      <Select defaultOpen defaultValue="compact">
        <SelectTrigger aria-label="Positioned density">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          align="end"
          position="popper"
          side="top"
          sideOffset={8}
          data-testid="select-popup"
        >
          <SelectGroup>
            <SelectLabel>Density choices</SelectLabel>
            <SelectItem value="compact">Compact</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    const popup = screen.getByTestId("select-popup");
    expect(popup).toHaveAttribute("data-align-trigger", "false");
    expect(popup).toHaveAttribute("data-align", "end");
    expect(popup.parentElement).toHaveStyle({ position: "fixed" });
    expect(
      screen.getByRole("group", { name: "Density choices" }),
    ).toBeInTheDocument();
  });

  it("provides the supplied direction and forwards logical positioning", () => {
    render(
      <Select dir="rtl" defaultOpen defaultValue="regular">
        <DirectionProbe />
        <SelectTrigger aria-label="Right-to-left density">
          <SelectValue />
        </SelectTrigger>
        <SelectContent
          avoidCollisions={false}
          position="popper"
          side="inline-start"
          data-testid="rtl-popup"
        >
          <SelectGroup>
            <SelectItem value="regular">Regular</SelectItem>
          </SelectGroup>
        </SelectContent>
      </Select>,
    );

    expect(screen.getByTestId("direction-probe")).toHaveTextContent("rtl");
    expect(screen.getByTestId("rtl-popup")).toHaveAttribute(
      "data-side",
      "inline-start",
    );
  });

  it("has no critical or serious axe violations while open", async () => {
    const view = render(<DensitySelect defaultOpen defaultValue="regular" />);

    const popup = await screen.findByTestId("density-popup");
    const listbox = await screen.findByRole("listbox");
    const portal = view.baseElement.querySelector("[data-base-ui-portal]");
    expect(portal).toContainElement(popup);
    expect(popup).toContainElement(listbox);

    const results = await axe(view.baseElement);
    expect(
      results.violations.filter(
        ({ impact }) => impact === "critical" || impact === "serious",
      ),
    ).toEqual([]);
  });
});
