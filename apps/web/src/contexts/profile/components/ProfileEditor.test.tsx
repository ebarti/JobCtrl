import { screen } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
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

    expect(await screen.findByRole("heading", { name: "Resume data" })).toBeInTheDocument();
    expect(await screen.findByText("Baseline resume editor")).toBeInTheDocument();
    expect(await screen.findByText("Plate HTML/CSS editor")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Bold" })).toBeInTheDocument();
    expect(document.querySelector("main.resume-page")).toBeNull();
    expect(document.querySelector("div.resume-page")).toBeInTheDocument();
    expect(screen.queryByText("Baseline resume preview")).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /open PDF/i })).not.toBeInTheDocument();
  });

  it("renders preferences without the PDF preview pane", async () => {
    const user = userEvent.setup();
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

    renderWithProviders(<ProfileEditor section="preferences" />, {
      ports: buildTestPorts({
        api: {
          profile: async () => sampleProfileResponse,
          settings: async () => sampleSettingsResponse,
        },
      }),
    });

    expect(
      await screen.findByRole("heading", { name: "Configuration & templates" }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("heading", { level: 3, name: "Application configuration" }),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText("Location filter")).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Target search" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: "Quality gates" }));
    expect(screen.getByRole("group", { name: "Revision policy" })).toBeInTheDocument();
    expect(screen.getByLabelText("Minimum fit score")).toHaveValue(8);
    expect(screen.getByLabelText("Must-have coverage (%)")).toHaveValue(85);
    expect(screen.getByLabelText("Revision attempts")).toHaveValue(1);
    expect(screen.queryByText("Baseline resume editor")).not.toBeInTheDocument();
    expect(await screen.findByText("Resume template preview")).toBeInTheDocument();
    const templatePreview = document.querySelector<HTMLElement>(".resume-template-plate-editor");
    expect(templatePreview).toBeTruthy();
    await user.click(screen.getByLabelText("Density"));
    await user.click(await screen.findByRole("option", { name: "Spacious" }));
    expect(templatePreview?.style.getPropertyValue("--resume-template-line-height")).toBe("1.48");
    expect(templatePreview?.style.getPropertyValue("--resume-template-section-gap")).toBe("7.2mm");
    expect(templatePreview?.style.getPropertyValue("--resume-template-entry-gap")).toBe("5.8mm");
    expect(templatePreview?.style.getPropertyValue("--resume-template-list-gap")).toBe("2.4mm");
    await user.click(screen.getByLabelText("Bullets"));
    await user.click(await screen.findByRole("option", { name: "Loose" }));
    expect(templatePreview?.style.getPropertyValue("--resume-template-bullet-gap")).toBe("2.4mm");
    const fontSelects = screen.getAllByLabelText("Font");
    expect(fontSelects).toHaveLength(2);
    await user.click(fontSelects[0]!);
    expect(await screen.findByRole("option", { name: "Garamond" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await user.click(fontSelects[1]!);
    expect(await screen.findByRole("option", { name: "Garamond" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Resume" })).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.getByLabelText("Size")).toHaveAttribute("type", "number");
    expect(screen.queryByLabelText("Resize profile and resume editor panes")).not.toBeInTheDocument();
  });
});
