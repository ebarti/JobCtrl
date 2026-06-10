import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { STATUS_DOT_STATES } from "./status-tokens.js";
import { StatusDot } from "./status-dot.js";

describe("<StatusDot>", () => {
  it.each(STATUS_DOT_STATES)("renders the closed %s state class", (state) => {
    const { container } = render(<StatusDot state={state} />);
    const dot = container.querySelector("span");

    expect(dot?.className).toBe(`status-dot ${state}`);
    expect(dot).toHaveAttribute("aria-hidden", "true");
  });
});

