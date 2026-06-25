import { screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  sampleProfileResponse,
  sampleSettingsResponse,
} from "../../../test/fixtures/projections.js";
import { renderWithProviders } from "../../../test/render.js";
import { buildTestPorts } from "../../../test/testPorts.js";
import { ProfileEditor } from "./ProfileEditor.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<ProfileEditor>", () => {
  it("renders the Profile baseline resume through the Plate editor pane", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          `
            <main class="resume-page">
              <section class="resume-section">
                <h1 data-resume-layout-target="profile-name">QA Candidate</h1>
                <p>Platform engineering leader.</p>
              </section>
            </main>
          `,
          { headers: { "content-type": "text/html" } },
        ),
      ),
    );

    renderWithProviders(<ProfileEditor />, {
      ports: buildTestPorts({
        api: {
          profile: async () => sampleProfileResponse,
          profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
          settings: async () => sampleSettingsResponse,
        },
      }),
      withRouter: true,
    });

    expect(await screen.findByRole("heading", { name: "Profile" })).toBeInTheDocument();
    expect(await screen.findByText("Baseline resume editor")).toBeInTheDocument();
    expect(await screen.findByText("Plate HTML/CSS editor")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(screen.queryByText("Baseline resume preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open PDF/i })).not.toBeInTheDocument();
  });

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
    expect(screen.queryByText("Baseline resume editor")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Resize profile and resume editor panes")).not.toBeInTheDocument();
  });
});
