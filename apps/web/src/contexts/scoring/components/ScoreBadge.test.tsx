import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ScoreBadge } from "./ScoreBadge.js";

describe("<ScoreBadge>", () => {
  it("renders a dash when score is null", () => {
    const { container } = render(<ScoreBadge score={null} />);
    expect(screen.getByText("-")).toBeInTheDocument();
    expect(container.querySelector("span")?.className).toMatch(/fit/);
    expect(container.querySelector("span")).toHaveAttribute("data-score-tone", "unknown");
  });

  it("renders the score value with a tier class", () => {
    const { container } = render(<ScoreBadge score={9} />);
    expect(screen.getByText("9")).toBeInTheDocument();
    const className = container.querySelector("span")?.className ?? "";
    expect(className.split(" ").length).toBeGreaterThan(1);
  });

  it("snapshots score=8", () => {
    const { container } = render(<ScoreBadge score={8} />);
    const badge = container.querySelector("span");

    expect(badge?.className).toBe("fit good");
    expect(badge).toHaveAttribute("data-score-tone", "positive");
    expect(badge).toHaveTextContent("8");
  });

  it("keeps score=7 in the positive mid-fit tier", () => {
    const { container } = render(<ScoreBadge score={7} />);
    const badge = container.querySelector("span");

    expect(badge?.className).toBe("fit mid");
    expect(badge).toHaveAttribute("data-score-tone", "positive");
    expect(badge).toHaveTextContent("7");
  });

  it("maps 10, 5, and 0 to semantic text tones without status-card styles", () => {
    const { container, rerender } = render(<ScoreBadge score={10} />);
    const badge = () => container.querySelector("span");

    expect(badge()).toHaveAttribute("data-score-tone", "positive");
    expect(badge()).toHaveAttribute("aria-label", "Fit score 10 out of 10");
    expect(badge()).not.toHaveAttribute("style");

    rerender(<ScoreBadge score={5} />);
    expect(badge()).toHaveAttribute("data-score-tone", "neutral");
    expect(badge()).not.toHaveAttribute("style");

    rerender(<ScoreBadge score={0} />);
    expect(badge()).toHaveAttribute("data-score-tone", "negative");
    expect(badge()).not.toHaveAttribute("style");
  });
});
