import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatCard } from "./stat-card.js";

describe("<StatCard>", () => {
  it("renders label, value, and delta", () => {
    render(<StatCard label="Applications sent" value="128" delta="+12 this week" />);

    expect(screen.getByText("Applications sent")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("+12 this week")).toBeInTheDocument();
  });

  it("renders the tag slot", () => {
    render(<StatCard label="Response rate" value="34%" tag={<span>on track</span>} />);

    expect(screen.getByText("on track")).toBeInTheDocument();
  });

  it("applies the delta tone class", () => {
    const { rerender } = render(<StatCard label="X" value="1" delta="up" deltaTone="up" />);
    expect(screen.getByText("up")).toHaveClass("text-success");

    rerender(<StatCard label="X" value="1" delta="warn" deltaTone="warn" />);
    expect(screen.getByText("warn")).toHaveClass("text-warning");

    rerender(<StatCard label="X" value="1" delta="down" deltaTone="down" />);
    expect(screen.getByText("down")).toHaveClass("text-destructive");
  });

  it("omits the delta line when no delta is provided", () => {
    const { container } = render(<StatCard label="Jobs" value="1,204" />);

    expect(screen.queryByText(/vs/)).not.toBeInTheDocument();
    expect(container.querySelector(".text-success")).toBeNull();
  });
});
