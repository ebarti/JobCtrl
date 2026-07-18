import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UserFacingStageBadge, userFacingStage } from "./UserFacingStageBadge.js";

describe("<UserFacingStageBadge>", () => {
  it("keeps apply visible as apply", () => {
    render(<UserFacingStageBadge stage="apply" />);

    expect(screen.getByText("Apply")).toHaveAttribute(
      "data-variant",
      "category",
    );
    expect(screen.getByLabelText("apply")).toBeInTheDocument();
  });

  it("presents internal preparation stages as the single product Discover stage", () => {
    render(<UserFacingStageBadge stage="tailor" />);

    expect(screen.getByText("Discover")).toHaveAttribute(
      "data-variant",
      "category",
    );
    expect(screen.getByLabelText("discover")).toBeInTheDocument();
    expect(screen.queryByLabelText(/substatus/i)).not.toBeInTheDocument();
    expect(userFacingStage("score")).toBe("discover");
  });
});
