import { APPLY_RUN_STATUSES } from "@jobctrl/domain-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApplyRunBadge } from "./ApplyRunBadge.js";

describe("<ApplyRunBadge>", () => {
  for (const status of APPLY_RUN_STATUSES) {
    it(`renders the ${status} status with a non-default tone`, () => {
      render(<ApplyRunBadge result={status} />);
      const badge = screen.getByText(status);
      expect(badge).toHaveAttribute("data-slot", "status-badge");
      expect(badge.getAttribute("data-status-tone")).toMatch(
        /^(ok|info|warn|danger|muted)$/,
      );
    });
  }

  it.each(["starting", "in_progress"] as const)(
    "uses a clock icon for %s",
    (status) => {
      render(<ApplyRunBadge result={status} />);

      expect(screen.getByText(status).querySelector("svg")).toHaveClass(
        "tabler-icon-clock",
      );
    },
  );
});
