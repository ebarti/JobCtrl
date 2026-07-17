import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHead } from "./page-head.js";

describe("<PageHead>", () => {
  it("renders the title as a level-1 heading", () => {
    const { container } = render(<PageHead title="Workflow runs" />);

    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Workflow runs",
    });
    expect(heading).toHaveClass("sr-only");
    expect(
      screen.getByRole("navigation", { name: "breadcrumb" }),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Workflow runs", { selector: "[aria-current='page']" }),
    ).not.toHaveAttribute("role", "link");
    expect(
      container.querySelector("header[data-slot='page-head']"),
    ).toBeInTheDocument();
  });

  it("renders the section and current page as a compact breadcrumb", () => {
    render(
      <PageHead
        eyebrow="Activity"
        title="Debug"
        subtitle="42 activity events"
      />,
    );

    const breadcrumb = screen.getByRole("navigation", { name: "breadcrumb" });
    expect(breadcrumb).toHaveTextContent("Activity");
    expect(breadcrumb).toHaveTextContent("Debug");
    expect(
      breadcrumb.querySelector("[data-slot='breadcrumb-separator']"),
    ).toBeInTheDocument();
    expect(screen.getByText("42 activity events")).toBeInTheDocument();
  });

  it("renders the actions slot", () => {
    render(
      <PageHead
        title="Jobs"
        actions={<button type="button">New search</button>}
      />,
    );

    expect(
      screen.getByRole("button", { name: "New search" }),
    ).toBeInTheDocument();
  });

  it("omits the eyebrow, subtitle, and actions slots when not provided", () => {
    const { container } = render(<PageHead title="Pipelines" />);

    expect(
      container.querySelector("[data-slot='page-head-eyebrow']"),
    ).toBeNull();
    expect(
      container.querySelector("[data-slot='breadcrumb-separator']"),
    ).toBeNull();
    expect(container.querySelector(".page-head-subtitle")).toBeNull();
    expect(container.querySelector(".page-head-actions")).toBeNull();
  });
});
