import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { UserFacingStageBadge, userFacingStage } from "./UserFacingStageBadge.js";

describe("<UserFacingStageBadge>", () => {
  it("keeps apply visible as apply", () => {
    render(<UserFacingStageBadge stage="apply" />);

    expect(screen.getByText("apply")).toBeInTheDocument();
    expect(screen.getByLabelText("apply")).toBeInTheDocument();
  });

  it("presents internal preparation stages as Discover with diagnostic labeling", () => {
    render(<UserFacingStageBadge stage="tailor" />);

    expect(screen.getByText("discover")).toBeInTheDocument();
    expect(screen.getByLabelText("discover; internal tailor substatus")).toBeInTheDocument();
    expect(userFacingStage("score")).toBe("discover");
  });
});
