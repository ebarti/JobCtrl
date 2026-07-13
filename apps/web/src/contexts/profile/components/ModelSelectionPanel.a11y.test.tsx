import { screen } from "@testing-library/react";
import { axe } from "jest-axe";
import { describe, expect, it, vi } from "vitest";

import {
  sampleProviderModelsResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ModelSelectionPanel } from "./ModelSelectionPanel.js";

describe("<ModelSelectionPanel> a11y", () => {
  it("has no axe violations with ready and unready providers", async () => {
    const view = renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          providerModels: vi.fn(async () => sampleProviderModelsResponse),
        },
      }),
    });

    await screen.findByText("Google is not configured.");
    expect(await axe(view.container)).toHaveNoViolations();
  });

  it("has no axe violations when the catalog request fails", async () => {
    const view = renderWithProviders(<ModelSelectionPanel />, {
      withRouter: true,
      ports: buildTestPorts({
        api: {
          settings: vi.fn(async () => sampleSettingsResponse),
          providerModels: vi.fn().mockRejectedValue(new Error("catalog unavailable")),
        },
      }),
    });

    await screen.findByRole("button", { name: "retry catalog" });
    expect(await axe(view.container)).toHaveNoViolations();
  });
});
