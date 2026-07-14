import { STAGES } from "@jobctrl/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StageBadge } from "./StageBadge.js";

describe("<StageBadge>", () => {
  it("renders a plain stage label when given a `stage`", () => {
    const { container } = render(<StageBadge stage="apply" />);
    const span = container.querySelector("span");
    expect(span?.className).toMatch(/stage-label/);
    expect(screen.getByText("apply")).toBeInTheDocument();
  });

  for (const stage of STAGES) {
    it(`assigns a non-default tone to stage="${stage}"`, () => {
      const { container } = render(<StageBadge stage={stage} />);
      const span = container.querySelector("span");
      expect(span?.className).toMatch(/stage-label/);
      expect(span?.className.split(" ").length).toBeGreaterThan(1);
    });
  }

  it("renders a dot-led status label when given a `state`", () => {
    const { container } = render(<StageBadge state="failed" />);
    expect(screen.getByText("failed")).toBeInTheDocument();
    expect(container.querySelector(".editorial-status .status-dot")).toBeInTheDocument();
  });
});
