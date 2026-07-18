import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { RunResearchButton } from "./RunResearchButton.js";

describe("<RunResearchButton>", () => {
  it("fails closed in the public demo before fetching source URLs or contact data", () => {
    const runContactResearch = vi.fn();
    const ports = buildTestPorts({ api: { runContactResearch } });
    ports.featureFlags = new DemoFeatureFlagAdapter();

    const view = renderWithProviders(<RunResearchButton jobId="job-1" />, { ports });

    const url = screen.getByRole("textbox", { name: "Public source URL (optional)" });
    const submit = screen.getByRole("button", { name: "Run research" });
    expect(url).toBeDisabled();
    expect(submit).toBeDisabled();
    expect(submit).toHaveAccessibleDescription(
      /Contact research is available in the local app.*does not fetch source URLs or process contact information/i,
    );
    fireEvent.submit(view.container.querySelector("form")!);
    expect(runContactResearch).not.toHaveBeenCalled();
    expect(screen.getByRole("link", { name: "Install JobCtrl" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/getting-started",
    );
  });
});
