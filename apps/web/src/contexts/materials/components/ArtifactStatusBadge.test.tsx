import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ArtifactStatusBadge } from "./ArtifactStatusBadge.js";

describe("<ArtifactStatusBadge>", () => {
  it.each(["approved", "draft", "rejected", "queued"])("renders %s status text", (status) => {
    const { container } = render(<ArtifactStatusBadge status={status} />);
    expect(screen.getByText(status)).toBeInTheDocument();
    expect(container.querySelector("span")?.className).toMatch(/tag /);
  });

  it("snapshots approved", () => {
    const { container } = render(<ArtifactStatusBadge status="approved" />);
    expect(container.firstChild).toMatchInlineSnapshot(`
      <span
        class="tag ok"
      >
        approved
      </span>
    `);
  });
});
