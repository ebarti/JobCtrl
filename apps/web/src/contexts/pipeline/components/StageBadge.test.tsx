import { STAGES } from "@jobctrl/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StageBadge } from "./StageBadge.js";

describe("<StageBadge>", () => {
  it("renders a stage pill when given a `stage`", () => {
    const { container } = render(<StageBadge stage="apply" />);
    const span = container.querySelector("span");
    expect(span?.className).toMatch(/stage-pill/);
    expect(screen.getByText("apply")).toBeInTheDocument();
  });

  for (const stage of STAGES) {
    it(`assigns a non-default tone to stage="${stage}"`, () => {
      const { container } = render(<StageBadge stage={stage} />);
      const span = container.querySelector("span");
      expect(span?.className).toMatch(/stage-pill/);
      expect(span?.className.split(" ").length).toBeGreaterThan(1);
    });
  }

  it("renders a tag with state text when given a `state`", () => {
    render(<StageBadge state="failed" />);
    expect(screen.getByText("failed")).toHaveAttribute(
      "data-status-tone",
      "danger",
    );
  });

  it.each([
    ["pending", "clock"],
    ["queued", "clock"],
    ["running", "clock"],
    ["blocked", "ban"],
    ["canceled", "ban"],
  ] as const)(
    "uses the domain-specific icon for state=%s",
    (state, iconName) => {
      render(<StageBadge state={state} />);

      expect(screen.getByText(state).querySelector("svg")).toHaveClass(
        `tabler-icon-${iconName}`,
      );
    },
  );
});
