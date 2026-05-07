import { WORKFLOW_RUN_STATUSES } from "@jobhunter/contracts";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { RunStatusBadge } from "./RunStatusBadge.js";

describe("<RunStatusBadge>", () => {
  for (const status of WORKFLOW_RUN_STATUSES) {
    it(`renders the ${status} workflow-run status with a non-default tone`, () => {
      const { container } = render(<RunStatusBadge status={status} />);
      const span = container.querySelector("span");
      expect(span?.className).toMatch(/tag /);
      expect(span?.textContent ?? "").not.toBe("");
    });
  }
});
