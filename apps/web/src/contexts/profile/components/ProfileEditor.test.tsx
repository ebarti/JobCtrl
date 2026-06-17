import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  sampleProfileResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ProfileEditor } from "./ProfileEditor.js";

describe("<ProfileEditor>", () => {
  it("renders preferences without the PDF preview pane", async () => {
    renderWithProviders(<ProfileEditor section="preferences" />, {
      ports: buildTestPorts({
        api: {
          profile: async () => sampleProfileResponse,
          settings: async () => sampleSettingsResponse,
        },
      }),
    });

    expect(await screen.findByRole("heading", { name: "Preferences" })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Application configurations" })).toBeInTheDocument();
    expect(screen.getByLabelText("Location filter")).toHaveValue("Remote");
    expect(screen.queryByRole("heading", { name: "Target search" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Minimum fit score")).not.toBeInTheDocument();
    expect(screen.queryByText("Resume preview")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resize profile and PDF preview panes")).not.toBeInTheDocument();
  });
});
