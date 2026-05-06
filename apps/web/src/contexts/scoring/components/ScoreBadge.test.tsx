import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScoreBadge } from "./ScoreBadge.js";

describe("<ScoreBadge>", () => {
  it("renders a dash when score is null", () => {
    const { container } = render(<ScoreBadge score={null} />);
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(container.querySelector("span")?.className).toMatch(/fit/);
  });

  it("renders the score value with a tier class", () => {
    const { container } = render(<ScoreBadge score={9} />);
    expect(screen.getByText("9")).toBeInTheDocument();
    const className = container.querySelector("span")?.className ?? "";
    expect(className.split(" ").length).toBeGreaterThan(1);
  });

  it("snapshots score=8", () => {
    const { container } = render(<ScoreBadge score={8} />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <span
        class="fit good"
      >
        8
      </span>
    `);
  });
});
