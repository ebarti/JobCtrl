import { IconBan } from "@tabler/icons-react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "./status-badge.js";

describe("<StatusBadge>", () => {
  it.each([
    ["ok", "circle-check"],
    ["info", "info-circle"],
    ["warn", "alert-triangle"],
    ["danger", "circle-x"],
  ] as const)("renders the semantic %s icon without changing the label", (tone, iconName) => {
    render(<StatusBadge tone={tone}>Status label</StatusBadge>);

    const badge = screen.getByText("Status label");
    expect(badge).toHaveAttribute("data-status-tone", tone);
    expect(badge.querySelector("svg")).toHaveClass(`tabler-icon-${iconName}`);
    expect(badge.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    expect(badge.querySelector("svg")).toHaveAttribute("data-icon", "inline-start");
  });

  it("keeps muted metadata visually restrained", () => {
    render(<StatusBadge tone="muted">Not recorded</StatusBadge>);

    expect(screen.getByText("Not recorded").querySelector("svg")).toBeNull();
  });

  it("accepts a domain-specific icon component", () => {
    render(
      <StatusBadge icon={IconBan} tone="warn">
        Submission blocked
      </StatusBadge>,
    );

    expect(screen.getByText("Submission blocked").querySelector("svg")).toHaveClass(
      "tabler-icon-ban",
    );
  });
});
