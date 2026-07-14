import { APPLY_RUN_STATUSES } from "@jobctrl/domain-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ApplyRunBadge } from "./ApplyRunBadge.js";

describe("<ApplyRunBadge>", () => {
  for (const status of APPLY_RUN_STATUSES) {
    it(`renders the ${status} status with a non-default tone`, () => {
      const { container } = render(<ApplyRunBadge result={status} />);
      const span = container.querySelector("span");
      expect(span?.className).toMatch(/editorial-status (ok|info|warn|danger|muted)/);
      expect(screen.getByText(status)).toBeInTheDocument();
    });
  }
});
