import { fireEvent, render, screen } from "@testing-library/react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { describe, expect, it, vi } from "vitest";

import { StatCard } from "./stat-card.js";

describe("<StatCard>", () => {
  it("renders label, value, and delta", () => {
    render(
      <StatCard label="Applications sent" value="128" delta="+12 this week" />,
    );

    expect(screen.getByText("Applications sent")).toBeInTheDocument();
    expect(screen.getByText("128")).toBeInTheDocument();
    expect(screen.getByText("+12 this week")).toBeInTheDocument();
  });

  it("renders the tag slot", () => {
    render(
      <StatCard
        label="Response rate"
        value="34%"
        tag={<span>on track</span>}
      />,
    );

    expect(screen.getByText("on track")).toBeInTheDocument();
  });

  it("applies the delta tone class", () => {
    const { rerender } = render(
      <StatCard label="X" value="1" delta="up" deltaTone="up" />,
    );
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

  it("renders the delta muted when no delta tone is set", () => {
    render(<StatCard label="Ready" value="4" delta="ready queue" />);

    expect(screen.getByText("ready queue")).toHaveClass(
      "text-muted-foreground",
    );
  });

  it("applies the value tone class", () => {
    render(<StatCard label="Failures" value="3" valueTone="down" />);

    expect(screen.getByText("3")).toHaveClass("text-destructive");
  });

  it("composes the stat layout into the rendered element", () => {
    const onCardClick = vi.fn();
    const onLinkClick = vi.fn((event: ReactMouseEvent<HTMLAnchorElement>) => {
      event.preventDefault();
    });
    render(
      <StatCard
        className="stat-card-target"
        label="Jobs"
        value="42"
        delta="+2 today"
        onClick={onCardClick}
        render={
          <a className="stat-card-link" href="/jobs" onClick={onLinkClick} />
        }
      />,
    );

    const link = screen.getByRole("link", { name: /^Jobs/i });
    expect(link).toHaveAttribute("href", "/jobs");
    expect(link).toHaveTextContent("42");
    expect(link).toHaveTextContent("+2 today");
    expect(link).toHaveClass(
      "rounded-lg",
      "stat-card-target",
      "stat-card-link",
    );

    fireEvent.click(link);
    expect(onLinkClick).toHaveBeenCalledOnce();
    expect(onCardClick).toHaveBeenCalledOnce();
  });
});
