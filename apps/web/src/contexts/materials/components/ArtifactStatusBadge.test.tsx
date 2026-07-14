import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArtifactStatusBadge } from "./ArtifactStatusBadge.js";

describe("<ArtifactStatusBadge>", () => {
  it.each(["approved", "draft", "rejected", "queued"])("renders %s status text", (status) => {
    const { container } = render(<ArtifactStatusBadge status={status} />);
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(container.querySelector("span")?.className).toMatch(/tag /);
    expect(container.querySelector("span")?.getAttribute("title")).toBeTruthy();
  });

  it("snapshots approved", () => {
    const { container } = render(<ArtifactStatusBadge status="approved" />);
    const badge = container.querySelector("span");

    expect(badge?.className).toBe("tag editorial-status ok");
    expect(badge).toHaveAttribute(
      "aria-label",
      "approved: Approved means this generated material passed validation and is the accepted version for this job.",
    );
    expect(badge).toHaveAttribute(
      "title",
      "Approved means this generated material passed validation and is the accepted version for this job.",
    );
  });

  it("describes suppressed artifacts as historical audit material", () => {
    render(<ArtifactStatusBadge status="suppressed" />);

    expect(screen.getByLabelText(/historical audit material/i)).toBeInTheDocument();
  });

  it("renders rejected artifacts with destructive status tone", () => {
    const { container } = render(<ArtifactStatusBadge status="rejected" />);

    expect(container.querySelector("span")?.className).toBe("tag editorial-status danger");
  });
});
