import { fireEvent, screen } from "@testing-library/react";
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
    expect(screen.getByRole("button", { name: "Profile data" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("navigation", { name: "Profile sections" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Resume editor" }));
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
    expect(screen.getByRole("navigation", { name: "Preferences sections" })).toBeInTheDocument();
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
    expect(templatePreview?.querySelector(".resume-template-controls")).toBeTruthy();
    expect(templatePreview?.querySelector(".resume-template-actions")).toBeTruthy();
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

  it("preserves a Profile draft while switching workspace views", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<main class="resume-page"><p>Resume</p></main>', {
        headers: { "content-type": "text/html" },
      })),
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

    const fullName = await screen.findByLabelText("Full name");
    await user.clear(fullName);
    await user.type(fullName, "Updated Candidate");
    await user.click(screen.getByRole("button", { name: "Resume editor" }));
    await user.click(screen.getByRole("button", { name: "Profile data" }));

    expect(screen.getByLabelText("Full name")).toHaveValue("Updated Candidate");
    expect(screen.getByRole("button", { name: "Save changes" })).toBeInTheDocument();
  });

  it("preserves the persisted resizable split workspace", async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<main class="resume-page"><p>Resume</p></main>', {
        headers: { "content-type": "text/html" },
      })),
    );
    const ports = buildTestPorts({
      api: {
        profile: async () => sampleProfileResponse,
        profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
        settings: async () => sampleSettingsResponse,
      },
    });
    ports.storage.set("profile-preview-split-width", 70);
    const saveWidth = vi.spyOn(ports.storage, "set");
    const view = renderWithProviders(<ProfileEditor />, { ports, withRouter: true });

    await screen.findByRole("heading", { name: "Resume data" });
    await user.click(screen.getByRole("button", { name: "Split view" }));
    expect(screen.getByLabelText("Full name")).toBeVisible();
    expect(await screen.findByRole("button", { name: "Bold" })).toBeVisible();
    const resizer = screen.getByRole("button", { name: "Resize profile and resume editor panes" });
    const workspace = view.container.querySelector<HTMLElement>(".profile-workspace-content");
    expect(workspace?.style.getPropertyValue("--profile-editor-width")).toBe("70%");

    fireEvent.keyDown(resizer, { key: "ArrowLeft" });

    expect(saveWidth).toHaveBeenLastCalledWith("profile-preview-split-width", 66);
    expect(workspace?.style.getPropertyValue("--profile-editor-width")).toBe("66%");
  });

  it("bounds a Profile load failure with a retry action", async () => {
    const user = userEvent.setup();
    const profile = vi.fn()
      .mockRejectedValueOnce(new Error("Saved profile could not be read."))
      .mockResolvedValue(sampleProfileResponse);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('<main class="resume-page"><p>Resume</p></main>', {
        headers: { "content-type": "text/html" },
      })),
    );
    renderWithProviders(<ProfileEditor />, {
      ports: buildTestPorts({
        api: {
          profile,
          profilePreviewHtmlUrl: () => "/v1/profile/preview.html?v=0",
          settings: async () => sampleSettingsResponse,
        },
      }),
      withRouter: true,
    });

    expect(await screen.findByText("Profile unavailable")).toBeInTheDocument();
    expect(screen.getByText("Saved profile could not be read.")).toBeInTheDocument();
    expect(screen.queryByText("Loading profile")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Retry" }));
    expect(await screen.findByLabelText("Full name")).toBeInTheDocument();
  });
});
