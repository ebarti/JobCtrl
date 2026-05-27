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
    expect(container.firstChild).toMatchInlineSnapshot(`
      <span
        aria-label="approved: Approved means this generated material passed validation and is the accepted version for this job."
        class="tag ok"
        title="Approved means this generated material passed validation and is the accepted version for this job."
      >
        approved
      </span>
    `);
  });

  it("describes suppressed artifacts as historical audit material", () => {
    render(<ArtifactStatusBadge status="suppressed" />);

    expect(screen.getByLabelText(/historical audit material/i)).toBeInTheDocument();
  });
});
