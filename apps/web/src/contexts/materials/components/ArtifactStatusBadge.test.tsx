import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArtifactStatusBadge } from "./ArtifactStatusBadge.js";

describe("<ArtifactStatusBadge>", () => {
  it.each(["approved", "draft", "rejected", "queued"])(
    "renders %s status text",
    (status) => {
      render(<ArtifactStatusBadge status={status} />);
      const badge = screen.getByText(status);
      expect(badge).toHaveAttribute("data-slot", "status-badge");
      expect(badge).toHaveAttribute("title");
    },
  );

  it("snapshots approved", () => {
    render(<ArtifactStatusBadge status="approved" />);
    const badge = screen.getByText("approved");

    expect(badge).toHaveAttribute("data-status-tone", "ok");
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

    expect(
      screen.getByLabelText(/historical audit material/i),
    ).toBeInTheDocument();
  });

  it("renders rejected artifacts with destructive status tone", () => {
    render(<ArtifactStatusBadge status="rejected" />);

    expect(screen.getByText("rejected")).toHaveAttribute(
      "data-status-tone",
      "danger",
    );
  });

  it.each(["pending", "queued"])(
    "uses a clock icon for %s artifacts",
    (status) => {
      render(<ArtifactStatusBadge status={status} />);

      expect(screen.getByText(status).querySelector("svg")).toHaveClass(
        "tabler-icon-clock",
      );
    },
  );
});
