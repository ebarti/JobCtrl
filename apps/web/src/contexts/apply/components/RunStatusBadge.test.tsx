import { WORKFLOW_RUN_STATUSES } from "@jobctrl/contracts";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunStatusBadge } from "./RunStatusBadge.js";

describe("<RunStatusBadge>", () => {
  for (const status of WORKFLOW_RUN_STATUSES) {
    it(`renders the ${status} workflow-run status with a non-default tone`, () => {
      render(<RunStatusBadge status={status} />);
      const badge = screen.getByText(statusLabel(status));
      expect(badge).toHaveAttribute("data-slot", "status-badge");
      expect(badge.getAttribute("data-status-tone")).toMatch(
        /^(ok|info|warn|danger|muted)$/,
      );
    });
  }

  it.each([
    ["starting", "clock"],
    ["in_progress", "clock"],
    ["canceled", "ban"],
    ["terminated", "ban"],
  ] as const)("uses the domain-specific %s icon", (status, iconName) => {
    render(<RunStatusBadge status={status} />);

    expect(
      screen.getByText(statusLabel(status)).querySelector("svg"),
    ).toHaveClass(`tabler-icon-${iconName}`);
  });
});

function statusLabel(status: (typeof WORKFLOW_RUN_STATUSES)[number]): string {
  if (status === "in_progress") return "in progress";
  if (status === "dry_run_complete") return "dry-run complete";
  if (status === "login_issue") return "login issue";
  if (status === "timed_out") return "timed out";
  return status;
}
