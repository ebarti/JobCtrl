import type { ActionRunResponse } from "@jobctrl/contracts";
import { screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DemoFeatureFlagAdapter } from "../../../demo/ports.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { GenerateMaterialsButton } from "./GenerateMaterialsButton.js";

const originalConfirm = globalThis.window?.confirm;

function queued(jobKey: string): ActionRunResponse {
  return {
    ok: true,
    runId: "run-generate",
    actionId: "action-generate",
    action: "run_stage",
    status: "queued",
    jobKey,
    command: { action: "run_stage", jobKey },
  };
}

afterEach(() => {
  if (typeof originalConfirm === "function") {
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: originalConfirm });
  }
});

describe("<GenerateMaterialsButton>", () => {
  it("is enabled and exposes the job id (INSPECT-01)", () => {
    const { container } = renderWithProviders(<GenerateMaterialsButton jobId="job-42" />);
    const button = container.querySelector("button");
    expect(button).not.toBeDisabled();
    expect(button?.getAttribute("data-job-id")).toBe("job-42");
  });

  it("dispatches per-job material generation after confirmation", async () => {
    const user = userEvent.setup();
    const generateMaterials = vi.fn(async () => queued("job-1"));
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => true });

    renderWithProviders(<GenerateMaterialsButton jobId="job-1" />, {
      ports: buildTestPorts({ api: { generateMaterials } }),
    });

    await user.click(screen.getByRole("button", { name: "generate materials" }));

    await waitFor(() =>
      expect(generateMaterials).toHaveBeenCalledWith("job-1", {
        stages: ["tailor", "cover"],
        dryRun: false,
        limit: 1,
      }),
    );
  });

  it("does not dispatch when the confirmation is declined", async () => {
    const user = userEvent.setup();
    const generateMaterials = vi.fn(async () => queued("job-1"));
    Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: () => false });

    renderWithProviders(<GenerateMaterialsButton jobId="job-1" />, {
      ports: buildTestPorts({ api: { generateMaterials } }),
    });

    await user.click(screen.getByRole("button", { name: "generate materials" }));

    expect(generateMaterials).not.toHaveBeenCalled();
  });

  it("respects the disabled prop", () => {
    renderWithProviders(<GenerateMaterialsButton jobId="job-1" disabled />);
    expect(screen.getByRole("button", { name: "generate materials" })).toBeDisabled();
  });

  it("blocks unavailable demo generation before confirmation or dispatch", async () => {
    const generateMaterials = vi.fn(async () => queued("job-1"));
    const confirm = vi.fn(() => true);
    Object.defineProperty(window, "confirm", {
      configurable: true,
      writable: true,
      value: confirm,
    });
    const ports = buildTestPorts({ api: { generateMaterials } });
    ports.featureFlags = new DemoFeatureFlagAdapter();

    renderWithProviders(<GenerateMaterialsButton jobId="job-1" />, { ports });

    const button = screen.getByRole("button", { name: "generate materials" });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription(
      /Material generation is available in the local app.*bundled materials remain available/i,
    );
    expect(screen.getByRole("link", { name: "Install JobCtrl" })).toHaveAttribute(
      "href",
      "https://jobctrl.dev/user/getting-started",
    );
    expect(confirm).not.toHaveBeenCalled();
    expect(generateMaterials).not.toHaveBeenCalled();
  });
});
