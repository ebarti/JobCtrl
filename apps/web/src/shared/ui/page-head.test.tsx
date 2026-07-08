import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PageHead } from "./page-head.js";

describe("<PageHead>", () => {
  it("renders the title as a level-1 heading", () => {
    render(<PageHead title="Workflow runs" />);

    expect(screen.getByRole("heading", { level: 1, name: "Workflow runs" })).toBeInTheDocument();
  });

  it("renders the eyebrow and subtitle when provided", () => {
    render(<PageHead eyebrow="Activity" title="Debug" subtitle="42 activity events" />);

    expect(screen.getByText("Activity")).toBeInTheDocument();
    expect(screen.getByText("42 activity events")).toBeInTheDocument();
  });

  it("renders the actions slot", () => {
    render(<PageHead title="Jobs" actions={<button type="button">New search</button>} />);

    expect(screen.getByRole("button", { name: "New search" })).toBeInTheDocument();
  });

  it("omits the eyebrow, subtitle, and actions slots when not provided", () => {
    const { container } = render(<PageHead title="Pipelines" />);

    expect(container.querySelector(".eyebrow")).toBeNull();
    expect(container.querySelector(".page-head-subtitle")).toBeNull();
    expect(container.querySelector(".page-head-actions")).toBeNull();
  });
});
