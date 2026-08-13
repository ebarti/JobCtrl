import { STAGES } from "@jobctrl/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StageBadge } from "./StageBadge.js";

describe("<StageBadge>", () => {
  it("renders a neutral stage category when given a `stage`", () => {
    render(<StageBadge stage="apply" />);

    expect(screen.getByText("Apply")).toHaveAttribute(
      "data-variant",
      "category",
    );
    expect(screen.getByLabelText("Stage: Apply")).toBeInTheDocument();
  });

  for (const stage of STAGES) {
    it(`keeps category semantics neutral for stage="${stage}"`, () => {
      render(<StageBadge stage={stage} />);

      expect(
        screen.getByLabelText(
          `Stage: ${stage.charAt(0).toUpperCase()}${stage.slice(1)}`,
        ),
      ).toHaveAttribute("data-variant", "category");
    });
  }

  it("renders a tag with state text when given a `state`", () => {
    render(<StageBadge state="failed" />);
    expect(screen.getByText("failed")).toHaveAttribute(
      "data-status-tone",
      "danger",
    );
  });

  it("renders the persisted exhausted marker as a public failed state", () => {
    render(<StageBadge state="exhausted" />);

    expect(screen.queryByText("exhausted")).not.toBeInTheDocument();
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
